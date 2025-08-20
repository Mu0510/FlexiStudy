const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const os = require('os');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

// --- 安全モード設定 ---
const userHome = process.env.HOME || process.env.USERPROFILE;
if (!userHome) {
  console.error('Error: Could not determine home directory.');
  process.exit(1);
}
const allowedBaseDir = path.normalize(path.resolve(userHome, 'GeminiCLI'));
if (!fs.existsSync(allowedBaseDir)) {
  console.error(`Error: The safe directory ${allowedBaseDir} does not exist.`);
  process.exit(1);
}
console.log(`Safe Mode is active. Allowed directory: ${allowedBaseDir}`);

/**
 * 指定されたパスが許可されたディレクトリ内にあるか、堅牢な方法で検証します。
 * @param {string} userPath ユーザーが指定したパス
 * @returns {boolean} 安全なパスであればtrue、そうでなければfalse
 */
function isPathSafe(userPath) {
  // ユーザーパスが提供されていない、または空の場合は安全と見なす（例: `cd` のみ）
  if (!userPath) {
    return true;
  }
  const resolvedPath = path.normalize(path.resolve(allowedBaseDir, userPath));
  const relativePath = path.relative(allowedBaseDir, resolvedPath);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}
// --- ここまで ---

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const port = process.env.PORT || 3000;

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

  wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');
    ws.isSafeMode = true; // デフォルトで安全モードを有効に
    let commandInputBuffer = ''; // ★ 接続ごとにコマンド入力バッファを初期化

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: allowedBaseDir, // 初期ディレクトリを ~/GeminiCLI に設定
      env: process.env,
    });

    // ptyからの出力をクライアントに送信
    ptyProcess.onData((data) => {
      ws.send(data);
    });

    // クライアントからのメッセージを処理
    ws.on('message', (message) => {
      const messageStr = message.toString();

      // --- 1. JSON形式の制御メッセージか判定 ---
      try {
        const data = JSON.parse(messageStr);
        if (data.type === 'setSafeMode') {
          ws.isSafeMode = !!data.enabled;
          commandInputBuffer = ''; // モード切替時にバッファをリセット
          console.log(`Safe Mode for a client set to: ${ws.isSafeMode}`);
          ws.send(`\r\n\x1b[32mSafe Mode is now ${ws.isSafeMode ? 'ON' : 'OFF'}.\x1b[0m\r\n`);
        }
        return; // JSONメッセージはここで処理終了
      } catch (e) {
        // JSONでなければ生のターミナル入力として処理を続ける
      }

      // --- 2. 安全モードが有効な場合の処理 ---
      if (ws.isSafeMode) {
        // Enterキー（改行）が押された場合、バッファのコマンドを検証
        if (messageStr === '\r') {
          const commandToVerify = commandInputBuffer.trim();
          commandInputBuffer = ''; // 検証前にバッファをクリア

          if (commandToVerify) {
            const commandParts = commandToVerify.split(/\s+/);
            const mainCommand = commandParts[0];

            // --- 検証ロジック開始 ---
            // `rm` のチェック
            if (/\brm\b/.test(commandToVerify)) {
              ws.send('\r\n\x1b[33m[Safe Mode] The \'rm\' command is disabled. Please use \'trash\' instead.\x1b[0m\r\n');
              ptyProcess.write('\x03'); // Ctrl+Cで入力をキャンセル
              return;
            }

            // `study_log.db` のチェック
            if (commandToVerify.includes('study_log.db') && !commandToVerify.startsWith('python3 manage_log.py')) {
              ws.send('\r\n\x1b[31m[Safe Mode] Direct access to \'study_log.db\' is not allowed.\x1b[0m\r\n');
              ptyProcess.write('\x03'); // Ctrl+Cで入力をキャンセル
              return;
            }

            // `cd` のチェック
            if (mainCommand === 'cd') {
              const targetPath = commandParts[1];
              if (!isPathSafe(targetPath)) {
                ws.send(`\r\n\x1b[31m[Safe Mode] Access to path "${targetPath || ''}" is denied.\x1b[0m\r\n`);
                ptyProcess.write('\x03'); // Ctrl+Cで入力をキャンセル
                return;
              }
            }
            // --- 検証ロジック終了 ---
          }
        } else if (messageStr.charCodeAt(0) === 127) {
          // Backspaceが押された場合、バッファから一文字削除
          commandInputBuffer = commandInputBuffer.slice(0, -1);
        } else if (messageStr.charCodeAt(0) >= 32 || messageStr === '\t') {
          // 表示可能な文字とタブのみバッファに追加
          commandInputBuffer += messageStr;
        }
      }

      // --- 3. ptyプロセスにメッセージを書き込み ---
      // 安全モードでブロックされなかったすべての入力（安全モードOFF時を含む）をptyに渡す
      ptyProcess.write(messageStr);
    });

    ptyProcess.on('exit', ({ exitCode, signal }) => {
      console.log(`PTY process exited with code ${exitCode}, signal ${signal}`);
      ws.close();
    });

    ws.on('close', () => {
      console.log('Client disconnected from WebSocket');
      ptyProcess.kill();
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
  });

  httpServer.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${port}`);
  });
});