// server.js
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running');
});

const wss = new WebSocket.Server({ server });

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

wss.on('connection', (ws) => {
  console.log('Client connected');

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env
  });

  // xterm.js -> pty
  ws.on('message', (message) => {
    
    ptyProcess.write(message);
  });

  // pty -> xterm.js
  ptyProcess.on('data', (data) => {
    
    ws.send(data);
  });

  ptyProcess.on('exit', (code, signal) => {
    console.log(`pty process exited with code ${code}, signal ${signal}`);
    ws.close();
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    ptyProcess.kill();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});
