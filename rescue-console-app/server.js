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

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: allowedBaseDir, // 初期ディレクトリを ~/GeminiCLI に設定
      env: process.env,
    });

    // --- コマンドインターセプター ---
    function handleTerminalCommand(message) {
      try {
        const data = JSON.parse(message);
        
        if (data.type === 'setSafeMode') {
          ws.isSafeMode = !!data.enabled;
          console.log(`Safe Mode for a client set to: ${ws.isSafeMode}`);
          ws.send(`\r\n\x1b[32mSafe Mode is now ${ws.isSafeMode ? 'ON' : 'OFF'}.\x1b[0m\r\n`);
          return;
        }

        // ターミナル入力（ペイロード）を処理
        const command = data.payload || '';
        const trimmedCommand = command.trim();

        if (ws.isSafeMode) {
          // --- 安全モード時の検証 ---
          if (trimmedCommand.startsWith('rm ')) {
            const msg = `\r\n\x1b[33mWarning: The 'rm' command is disabled in Safe Mode.\r\nPlease use the 'trash' command instead.\x1b[0m\r\n`;
            ws.send(msg);
            return;
          }

          if (command.includes('study_log.db') && !command.includes('manage_log.py')) {
            const msg = `\r\n\x1b[31mError: Direct access to 'study_log.db' is not allowed in Safe Mode.\r\nPlease use 'python3 manage_log.py'.\x1b[0m\r\n`;
            ws.send(msg);
            return;
          }

          const pathRegex = /([~\/.]|\.\.)[\w\/.-]+/g;
          const potentialPaths = command.match(pathRegex) || [];
          for (const p of potentialPaths) {
            if (!isPathSafe(p)) {
              const msg = `\r\n\x1b[31mError: Safe Mode is enabled. Access to path "${p}" is denied.\x1b[0m\r\n`;
              ws.send(msg);
              return;
            }
          }
        }
        
        ptyProcess.write(command);

      } catch (e) {
        // JSONではないプレーンな文字列メッセージも処理（後方互換性のため）
        ptyProcess.write(message);
      }
    }

    ws.on('message', (message) => {
      handleTerminalCommand(message.toString());
    });

    ptyProcess.onData((data) => {
      ws.send(data);
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