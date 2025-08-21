const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const os = require('os');
const pty = require('node-pty');
const path = require('path');

const projectBaseDir = path.resolve(__dirname, '..');
console.log(`Project base directory: ${projectBaseDir}`);

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

    let ptyProcess = null;

    const createPtyProcess = (isSafeMode) => {
      if (ptyProcess) {
        // 古いptyプロセスをkillする前に、そのon('exit')がws.close()を呼ばないようにする
        ptyProcess.removeAllListeners('exit');
        ptyProcess.kill();
      }

      const cleanEnv = {
        PATH: process.env.PATH,
        LANG: process.env.LANG || 'ja_JP.UTF-8',
        COLORTERM: 'truecolor',
        TERM: 'xterm-color'
      };

      const options = {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
      };

      if (isSafeMode) {
        options.cwd = '/home/safe';
        options.env = { ...cleanEnv, HOME: '/home/safe', USER: 'safe', LOGNAME: 'safe' };
        options.uid = 1002;
        options.gid = 1002;
      } else {
        options.cwd = '/home/geminicli';
        options.env = { ...cleanEnv, HOME: '/home/geminicli', USER: 'geminicli', LOGNAME: 'geminicli' };
        options.uid = 1001;
        options.gid = 1001;
      }

      try {
        ptyProcess = pty.spawn(shell, [], options);
        console.log(`[DEBUG] PTY process spawned successfully for user: ${options.env.USER}`);
      } catch (e) {
        console.error("[DEBUG] Failed to spawn PTY:", e);
        ws.send(`\r\n\x1b[31mError: Failed to start shell for user ${options.env.USER}.\x1b[0m`);
        if (!ws.isClosed) {
          ws.close();
        }
        return;
      }
      
      ptyProcess.write(`cd ${projectBaseDir}\r`);

      ptyProcess.onData((data) => {
        ws.send(data);
        if (isSafeMode && data.includes('許可がありません')) {
           const prohibitedCmd = data.match(/bash:.*\/(rm|mv|dd|chmod|chown)/);
           if(prohibitedCmd && prohibitedCmd[1]){
              const cmd = prohibitedCmd[1];
              const advice = `\r\n\x1b[33m[安全モード] '${cmd}' コマンドはOSにより無効化されています。ファイルの削除には 'trash' を使用してください。このコマンドの実行が必須な場合は、安全モードを無効にしてください。\x1b[0m\r\n`;
              ws.send(advice);
           }
        }
      });
      
      ptyProcess.on('exit', ({ exitCode, signal }) => {
        console.log(`[DEBUG] PTY process for ${options.env.USER} exited with code ${exitCode}, signal ${signal}`);
        if (!ws.isClosed) {
          ws.close();
        }
      });
    };

    ws.on('message', (message) => {
      const messageStr = message.toString();

      try {
        const data = JSON.parse(messageStr);
        if (typeof data === 'object' && data !== null && data.type) {
          if (data.type === 'setSafeMode') {
            console.log(`[DEBUG] Received setSafeMode: ${data.enabled}. Creating PTY process.`);
            createPtyProcess(data.enabled);
          }
          return;
        }
      } catch (e) {
        // Not a JSON control message
      }

      if (ptyProcess) {
        ptyProcess.write(messageStr);
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected from WebSocket');
      ws.isClosed = true;
      if (ptyProcess) {
        ptyProcess.kill();
      }
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
