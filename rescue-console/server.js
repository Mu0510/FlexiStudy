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

const port = 3001; // メインアプリと被らないポート番号
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

app.prepare().then(() => {
  const server = express();
  const httpServer = createServer(server);

  // WebSocketサーバーのセットアップ
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('WebSocket connected');

    // ptyプロセスの起動
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: process.env.HOME,
      env: process.env
    });

    // ptyからの出力をWebSocketクライアントに送信
    ptyProcess.on('data', function (data) {
      ws.send(data);
    });

    // WebSocketクライアントからの入力をptyに書き込み
    ws.on('message', function (message) {
      ptyProcess.write(message);
    });

    ws.on('close', () => {
      console.log('WebSocket disconnected');
      ptyProcess.kill();
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        ptyProcess.kill();
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