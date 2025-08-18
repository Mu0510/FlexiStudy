const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const express = require('express');
const WebSocket = require('ws');
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

  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('WebSocket connected');
    const terminals = new Map(); // この接続で開かれているターミナルを管理

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
              ws.send(JSON.stringify({ type: 'OUTPUT', tabId, data: output }));
            });
            
            ptyProcess.on('exit', ({ exitCode, signal }) => {
                ws.send(JSON.stringify({ type: 'CLOSE', tabId, data: `Terminal exited with code ${exitCode}`}));
                terminals.delete(tabId);
            });

            terminals.set(tabId, ptyProcess);
            break;
          }

          case 'INPUT': {
            const ptyProcess = terminals.get(tabId);
            if (ptyProcess) {
              ptyProcess.write(data);
            } else {
              console.warn(`Terminal for tabId ${tabId} not found.`);
            }
            break;
          }
          
          case 'RESIZE': {
            const ptyProcess = terminals.get(tabId);
            if (ptyProcess) {
                ptyProcess.resize(data.cols, data.rows);
            }
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

          default:
            console.warn(`Unknown message type: ${type}`);
        }
      } catch (error) {
        console.error('Failed to handle WebSocket message:', error);
        // 生の文字列データも一応処理する（後方互換性のため）
        // この部分は最終的に削除しても良い
        terminals.forEach(ptyProcess => ptyProcess.write(rawMessage));
      }
    });

    ws.on('close', () => {
      console.log('WebSocket disconnected');
      // 接続が切れたら、関連するすべてのptyプロセスを終了
      terminals.forEach((ptyProcess, tabId) => {
        ptyProcess.kill();
        console.log(`Cleaned up terminal for tabId: ${tabId}`);
      });
      terminals.clear();
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      terminals.forEach(ptyProcess => ptyProcess.kill());
      terminals.clear();
    });
  });

  server.all('*', (req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  httpServer.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${port}`);
  });
});
