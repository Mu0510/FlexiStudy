const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const express = require('express');
const pty = require('node-pty');
const os = require('os');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const port = 3001;
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

app.prepare().then(() => {
  const server = express();
  const httpServer = createServer(server);
  // express-wsの初期化
  const expressWs = require('express-ws')(server, httpServer);

  // WebSocketのエンドポイントを.ws()で設定
  server.ws('/ws', (ws, req) => {
    console.log('WebSocket connected');
    const terminals = new Map();

    ws.on('message', (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage);
        const { type, tabId, data } = message;

        if (!tabId) {
          console.error('Message without tabId received:', message);
          return;
        }

        switch (type) {
          case 'CREATE': {
            if (terminals.has(tabId)) {
              console.warn(`Terminal for tabId ${tabId} already exists.`);
              return;
            }
            console.log(`Creating terminal for tabId: ${tabId}`);
            const ptyProcess = pty.spawn(shell, [], {
              name: 'xterm-color',
              cols: data.cols || 80,
              rows: data.rows || 30,
              cwd: process.env.HOME,
              env: process.env,
            });

            ptyProcess.on('data', (output) => {
              if (ws.readyState === 1) { // OPEN
                ws.send(JSON.stringify({ type: 'OUTPUT', tabId, data: output }));
              }
            });
            
            ptyProcess.on('exit', ({ exitCode, signal }) => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'CLOSE', tabId, data: `Terminal exited with code ${exitCode}`}));
              }
              terminals.delete(tabId);
            });

            terminals.set(tabId, ptyProcess);
            break;
          }

          case 'INPUT': {
            const ptyProcess = terminals.get(tabId);
            if (ptyProcess) ptyProcess.write(data);
            break;
          }
          
          case 'RESIZE': {
            const ptyProcess = terminals.get(tabId);
            if (ptyProcess) ptyProcess.resize(data.cols, data.rows);
            break;
          }

          case 'CLOSE': {
            const ptyProcess = terminals.get(tabId);
            if (ptyProcess) {
              ptyProcess.kill();
              terminals.delete(tabId);
              console.log(`Closed terminal for tabId: ${tabId}`);
            }
            break;
          }
        }
      } catch (error) {
        console.error('Failed to handle WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      console.log('WebSocket disconnected');
      terminals.forEach((ptyProcess, tabId) => {
        ptyProcess.kill();
        console.log(`Cleaned up terminal for tabId: ${tabId}`);
      });
      terminals.clear();
    });
  });

  // Next.jsのリクエストを処理
  server.all('*', (req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  httpServer.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${port}`);
  });
});