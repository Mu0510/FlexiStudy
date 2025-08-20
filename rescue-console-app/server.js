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

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: allowedBaseDir, // 初期ディレクトリを ~/GeminiCLI に設定
      env: process.env,
    });

    // --- コマンドインターセプター ---
    function handleTerminalCommand(command) {
      const trimmedCommand = command.trim();
      if (trimmedCommand.startsWith('rm ')) {
        const message = `\r\n\x1b[33mWarning: The 'rm' command is disabled for safety.\r\nPlease use the 'trash' command instead to move files to the trash bin.\x1b[0m\r\n`;
        ws.send(message);
        return;
      }

      if (command.includes('study_log.db') && !command.includes('manage_log.py')) {
        const message = `\r\n\x1b[31mError: Direct access to 'study_log.db' is not allowed.\r\nPlease use 'python3 manage_log.py' to interact with the database.\x1b[0m\r\n`;
        ws.send(message);
        return;
      }

      // TODO: ここに他の検証ロジックを実装
      ptyProcess.write(command);
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