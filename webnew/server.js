const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');

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
  geminiProcess.stdout.on('data', data => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { msg = { stdout: line }; }
      console.log('[Gemini CLI Output] ' + JSON.stringify(msg));

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
              broadcast(wss, msg);
          }
          if (c?.thought) {
              broadcast(wss, { jsonrpc: '2.0', method: 'streamAssistantThoughtChunk', params: { thought: c.thought } });
          }
          continue;
      }

      const methodsToExclude = ['initialize', 'requestToolCallConfirmation', 'updateToolCall'];
      if ((msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted' || (msg.result !== undefined && msg.result !== null)) && !methodsToExclude.includes(msg.method)) {
          if (ongoingText.length > 0) {
              const rec = { id:String(Date.now()), ts:Date.now(),
                           role:'assistant', text:ongoingText.trimEnd() };
              broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });
          }
          // The original msg might also contain useful info, but for now, we prioritize the 'rec' message.
          // If 'msg' itself is a complete message, it should be handled by 'addMessage' or 'streamAssistantMessageChunk' logic.
          // For now, we'll keep broadcasting the original msg as well, but it might be redundant or need further refinement.
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
  if (geminiProcess) {
    console.log('Killing existing Gemini process for restart...');
    const oldPid = geminiProcess.pid;
    geminiProcess.on('close', function(code, signal) {
      if (this.pid === oldPid) {
        console.log(`Old Gemini process (PID: ${oldPid}) exited. Starting new one.`);
        _startNewGeminiProcess(wss);
      }
    });
    geminiProcess.kill();
    geminiProcess = null;
  } else {
    _startNewGeminiProcess(wss);
  }
}
// --- End of Gemini Process Logic ---


app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const wss = new WebSocketServer({ port: 3001 });

  server.on('upgrade', (request, socket, head) => {
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

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});