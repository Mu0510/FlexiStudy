const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const os = require('os');
const pty = require('node-pty');

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
      cwd: process.env.HOME,
      env: process.env,
    });

    ws.on('message', (message) => {
      ptyProcess.write(message.toString());
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