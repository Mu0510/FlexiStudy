const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const os = require('os');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const port = 3001;
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

app.prepare().then(() => {
  const server = createServer((req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error handling request:', err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url);

    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    console.log('WebSocket connected');
    const terminals = new Map();

    ws.on('message', (rawMessage) => {
        try {
            const message = JSON.parse(rawMessage.toString());
            const { type, tabId, data } = message;

            if (!tabId) return;

            switch (type) {
                case 'CREATE':
                    const ptyProcess = pty.spawn(shell, [], {
                        name: 'xterm-color',
                        cols: data.cols || 80,
                        rows: data.rows || 30,
                        cwd: process.env.HOME,
                        env: process.env,
                    });
                    ptyProcess.on('data', (output) => {
                        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'OUTPUT', tabId, data: output }));
                    });
                    ptyProcess.on('exit', ({ exitCode }) => {
                        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CLOSE', tabId }));
                        terminals.delete(tabId);
                    });
                    terminals.set(tabId, ptyProcess);
                    break;
                case 'INPUT':
                    terminals.get(tabId)?.write(data);
                    break;
                case 'RESIZE':
                    terminals.get(tabId)?.resize(data.cols, data.rows);
                    break;
                case 'CLOSE':
                    terminals.get(tabId)?.kill();
                    terminals.delete(tabId);
                    break;
            }
        } catch (e) {
            console.error("Error parsing message:", e);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket disconnected');
        terminals.forEach(p => p.kill());
        terminals.clear();
    });
  });

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${port}`);
  });
});
