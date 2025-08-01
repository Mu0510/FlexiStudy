const { createServer: createHttpServer } = require('http');
const { createServer: createHttpsServer } = require('https');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = 3000;

// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// --- Start of Gemini Process Logic (from old server.js) ---
const GEMINI_ARGS = [
  '-m', 'gemini-2.5-flash',
  '-y',
  '--experimental-acp'
];

let geminiProcess = null;
const history = [];
let ongoingText = '';
let isRestartingGemini = false; // 新しいフラグ

function broadcast(wss, json){
  const str = JSON.stringify(json);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(str);
    }
  }
}

function _startNewGeminiProcess(wss) { // Pass wss to broadcast
  console.log(`Attempting to start Gemini process with command: sudo -u geminicli gemini ${GEMINI_ARGS.join(' ')}`);
  geminiProcess = spawn('sudo', ['-u', 'geminicli', 'gemini', ...GEMINI_ARGS], { stdio: ['pipe', 'pipe', 'pipe'], cwd: path.join(__dirname, '..') });

  const init = {
    jsonrpc: '2.0',
    id:      1,
    method:  'initialize',
    params:  { protocolVersion: '0.0.9' }
  };
  geminiProcess.stdin.write(JSON.stringify(init) + '\n');

  geminiProcess.on('error', (err) => {
    console.error('[Gemini SPAWN ERROR]', err);
  });

  console.log(`Gemini process started with PID: ${geminiProcess.pid}`);

  let buf = '';
  let braceLevel = 0;
  let inString = false;
  let jsonStart = -1;

  geminiProcess.stdout.on('data', data => {
    buf += data.toString();
    let cursor = 0;

    while (cursor < buf.length) {
      const char = buf[cursor];

      if (jsonStart === -1) {
        if (char === '{') {
          jsonStart = cursor;
          braceLevel = 1;
        }
      } else {
        if (inString) {
          if (char === '\\') {
            cursor++; // Skip escaped character
          } else if (char === '"') {
            inString = false;
          }
        } else {
          if (char === '"') {
            inString = true;
          } else if (char === '{') {
            braceLevel++;
          } else if (char === '}') {
            braceLevel--;
            if (braceLevel === 0) {
              const jsonString = buf.substring(jsonStart, cursor + 1);
              jsonStart = -1;
              buf = buf.substring(cursor + 1);
              cursor = -1; // Reset cursor to loop from the start of the new buffer

              try {
                const msg = JSON.parse(jsonString);
                console.log('[Gemini CLI Output] ' + jsonString);

                // --- Start of existing message processing logic ---
                if (msg.method !== 'streamAssistantMessageChunk' && ongoingText.length > 0) {
                    const rec = { id:String(Date.now()), ts:Date.now(),
                                 role:'assistant', text:ongoingText.trimEnd() };
                    history.push(rec);
                    console.log('[History] Saved assistant message (before other message): ' + JSON.stringify(rec));
                    ongoingText = '';
                }

                if (msg.method === 'streamAssistantMessageChunk') {
                    const { chunk: c } = msg.params || {};
                    if (c?.text) {
                        ongoingText += c.text;
                    }
                    // streamAssistantMessageChunk はそのままブロードキャスト
                    broadcast(wss, msg);
                    continue;
                }

                const methodsToExclude = ['initialize', 'requestToolCallConfirmation', 'updateToolCall'];
                if ((msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted' || (msg.result !== undefined && msg.result !== null)) && !methodsToExclude.includes(msg.method)) {
                    if (ongoingText.length > 0) {
                        const rec = { id:String(Date.now()), ts:Date.now(),
                                     role:'assistant', text:ongoingText.trimEnd() };
                        broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });
                    }
                    broadcast(wss, msg);
                    continue;
                }

                if (msg.role && msg.text) {
                    history.push({ ...msg, id: (msg.id !== undefined && msg.id !== null) ? String(msg.id) : String(Date.now()) });
                }
                if (msg.method === 'updateToolCall') {
                  broadcast(wss, msg);
                  geminiProcess.stdin.write(JSON.stringify({
                    jsonrpc: '2.0',
                    id:      msg.id,
                    result:  null
                  }) + '\n');
                  history.push({ ...msg, ts: Date.now(), type:'tool' });
                  return;
                }
                else if (msg.method === 'pushToolCall') {
                    history.push({
                        ...msg,
                        ts: msg.ts || Date.now(),
                        type: 'tool'
                    });
                }
                else if (msg.method === 'requestToolCallConfirmation') {
                    history.push({
                        ...msg,
                        ts: msg.ts || Date.now(),
                        type: 'tool'
                    });
                }

                broadcast(wss, msg);
                // --- End of existing message processing logic ---

              } catch (e) {
                console.error('Error parsing JSON object:', e, jsonString);
              }
            }
          }
        }
      }
      cursor++;
    }
  });

  geminiProcess.stderr.on('data', data => {
    console.error('[Gemini ERROR] ' + data.toString());
  });

  geminiProcess.on('close', (code, signal) => {
    console.log(`Gemini exited with code ${code} and signal ${signal}`);
    if (geminiProcess && geminiProcess.pid === this.pid) {
        history.length = 0;
        broadcast(wss, { jsonrpc:'2.0', method:'historyCleared', params:{ reason: 'gemini-exit' } });
        geminiProcess = null;
    }
  });
}

function startGemini(wss) {
  if (isRestartingGemini) {
    console.log('Gemini process is already restarting. Skipping new request.');
    return;
  }

  if (geminiProcess) {
    console.log('Killing existing Gemini process for restart...');
    isRestartingGemini = true; // 再起動中フラグを立てる
    const oldPid = geminiProcess.pid;
    const oldProcess = geminiProcess; // 参照を保持
    geminiProcess = null; // 古い参照をクリア

    oldProcess.on('close', function(code, signal) {
      if (this.pid === oldPid) {
        console.log(`Old Gemini process (PID: ${oldPid}) exited. Starting new one.`);
        _startNewGeminiProcess(wss);
        isRestartingGemini = false; // 再起動完了
      }
    });
    oldProcess.kill();
  } else {
    _startNewGeminiProcess(wss);
  }
}
// --- End of Gemini Process Logic ---


const httpsOptions = {
  key: fs.readFileSync(path.resolve(__dirname, 'certs/key.pem')),
  cert: fs.readFileSync(path.resolve(__dirname, 'certs/cert.pem')),
};

app.prepare().then(() => {
  const httpsServer = createHttpsServer(httpsOptions, async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const httpServer = createHttpServer((req, res) => {
    const host = req.headers.host;
    const httpsUrl = `https://${host}${req.url}`;
    res.writeHead(301, { Location: httpsUrl });
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpsServer.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url, true);
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', ws => {
    console.log('Client connected');

    ws.on('message', async data => {
        const text = data.toString();
        if (!text.trim()) return;

        let msg;
        try {
            msg = JSON.parse(text);
        } catch (e) {
            console.error('Failed to parse incoming WebSocket message as JSON:', e);
            if (geminiProcess) geminiProcess.stdin.write(text + '\n');
            return;
        }

        // --- clearHistory メソッドの処理を追加 ---
        if (msg.method === 'clearHistory') {
            console.log('[Server] Received clearHistory command.');
            history.length = 0;
            broadcast(wss, { jsonrpc: '2.0', method: 'historyCleared', params: { reason: 'command' } });
            startGemini(wss); // Geminiプロセスを再起動
            return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
        }

        if (msg.method === 'fetchHistory') {
            if (ongoingText.length > 0) {
                const rec = { id: String(Date.now()), ts: Date.now(), role: 'assistant', text: ongoingText.trimEnd() };
                history.push(rec);
                ongoingText = '';
            }
            const { limit = 20, before } = msg.params || {};
            let chunk = before ? history.filter(rec => rec.ts < before).slice(-limit) : history.slice(-limit);
            chunk.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
            return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { messages: chunk } }));
        }

        if (msg.method === 'sendUserMessage') {
            const { text, files } = msg.params?.chunks?.[0] || {};
            const inputText = text || '';

            if (ongoingText.length > 0) {
                const rec = { id: String(Date.now()), ts: Date.now(), role: 'assistant', text: ongoingText.trimEnd() };
                history.push(rec);
                ongoingText = '';
            }

            if (inputText.trim() === '/clear') {
                history.length = 0;
                broadcast(wss, { jsonrpc: '2.0', method: 'historyCleared', params: { reason: 'command' } });
                startGemini(wss);
                return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
            }

            // Save the original message with files to history for the UI
            const rec = { id: String(Date.now()), ts: Date.now(), role: 'user', text: inputText, files: files || [] };
            history.push(rec);

            // Create the message for the AI
            let messageForAI = inputText;
            if (files && files.length > 0) {
                const fileNames = files.map(file => `- ${file.name} (${file.path})`).join('\n');
                const systemMessage = `[System]ユーザーは以下のファイルをアップロードしました：\n${fileNames}`;
                messageForAI = `${systemMessage}\n\n${inputText}`;
            }

            // Send the potentially modified message to the Gemini process
            if (geminiProcess) {
                const aiMsg = {
                    ...msg,
                    params: {
                        ...msg.params,
                        chunks: [{ text: messageForAI }]
                    }
                };
                geminiProcess.stdin.write(JSON.stringify(aiMsg) + '\n');
            }
            return; // Exit after handling sendUserMessage
        }

        // For other messages, pass them directly to Gemini
        if (geminiProcess) {
            geminiProcess.stdin.write(JSON.stringify(msg) + '\n');
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
  });

  // Start Gemini process with the wss instance
  startGemini(wss);

  httpsServer.listen(443, (err) => {
    if (err) throw err;
    console.log(`> Ready on https://${hostname}:443`);
  });

  httpServer.listen(80, (err) => {
    if (err) throw err;
    console.log(`> HTTP redirect server running on http://${hostname}:80`);
  });
});