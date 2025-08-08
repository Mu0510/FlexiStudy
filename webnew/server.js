const { createServer: createHttpServer } = require('http');
const { createServer: createHttpsServer } = require('https');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
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
let currentAssistantId = null; // ★ 返信ごとに一意なIDを保持する変数

function broadcast(wss, json){
  const str = JSON.stringify(json);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(str);
    }
  }
}

function _startNewGeminiProcess(wss) { // Pass wss to broadcast
  console.log(`[Gemini Process] Attempting to start new Gemini process... (Called from: ${new Error().stack.split('\n')[2].trim()})`);
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

  console.log(`[Gemini Process] New Gemini process started with PID: ${geminiProcess.pid}`);

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
          }
          else if (char === '}') {
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
                    // ★ 修正点: currentAssistantId を使用
                    const rec = { id: currentAssistantId || String(Date.now()), ts:Date.now(),
                                 role:'assistant', text:ongoingText.trimEnd() };
                    history.push(rec);
                    console.log('[History] Saved assistant message (before other message): ' + JSON.stringify(rec));
                    ongoingText = '';
                    currentAssistantId = null; // ★ リセット
                }

                if (msg.method === 'streamAssistantMessageChunk') {
                    const { chunk: c } = msg.params || {};
                    if (c?.text) {
                        ongoingText += c.text;
                    }
                    // ★ 修正点: currentAssistantId をメッセージに付与
                    if (currentAssistantId) {
                      msg.params.messageId = currentAssistantId;
                    }
                    broadcast(wss, msg);
                    continue;
                }

                const methodsToExclude = ['initialize', 'requestToolCallConfirmation', 'updateToolCall'];
                if ((msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted' || (msg.result !== undefined && msg.result !== null)) && !methodsToExclude.includes(msg.method)) {
                    if (ongoingText.length > 0) {
                        // ★ 修正点: currentAssistantId を使用
                        const rec = { id: currentAssistantId || String(Date.now()), ts:Date.now(),
                                     role:'assistant', text:ongoingText.trimEnd() };
                        broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });
                        ongoingText = '';
                        currentAssistantId = null; // ★ リセット
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

                    // データベース更新コマンドか確認し、クライアントに通知
                    const command = msg.params?.confirmation?.command;
                    if (command && command.includes('manage_log.py')) {
                        console.log(`[Server] Detected database command: "${command}". Broadcasting databaseUpdated message.`);
                        setTimeout(() => {
                            broadcast(wss, { jsonrpc: '2.0', method: 'databaseUpdated', params: {} });
                        }, 200);
                    }
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
    console.log(`[Gemini Process] Gemini process (PID: ${this.pid}) exited with code ${code} and signal ${signal}. (Called from: ${new Error().stack.split('\n')[2].trim()})`);
    if (geminiProcess && geminiProcess.pid === this.pid) {
        history.length = 0;
        broadcast(wss, { jsonrpc:'2.0', method:'historyCleared', params:{ reason: 'gemini-exit' } });
        geminiProcess = null;
    }
  });
}

function startGemini(wss) {
  if (isRestartingGemini) {
    console.log('[Gemini Process] Gemini process is already restarting. Skipping new request.');
    return;
  }

  if (geminiProcess) {
    console.log(`[Gemini Process] Killing existing Gemini process (PID: ${geminiProcess.pid}) for restart...`);
    isRestartingGemini = true; // 再起動中フラグを立てる
    
    // 'close'イベントリスナーを一度だけ設定
    geminiProcess.once('close', (code, signal) => {
      console.log(`[Gemini Process] Old Gemini process (PID: ${geminiProcess.pid}) close event received. Code: ${code}, Signal: ${signal}. Starting new one.`);
      geminiProcess = null; // 参照を完全にクリア
      _startNewGeminiProcess(wss);
      isRestartingGemini = false; // 再起動完了
    });

    // プロセスを終了させる
    try {
      console.log(`[Gemini Process] Attempting to kill process with PID: ${geminiProcess.pid}`);
      process.kill(-geminiProcess.pid, 'SIGTERM'); // プロセスグループ全体にSIGTERMを送る
    } catch (err) {
      console.error(`[Gemini Process ERROR] Failed to kill process with PID: ${geminiProcess.pid}. Error: ${err.message}`);
      // エラーが発生した場合でも、新しいプロセスを開始する試みは続ける
      geminiProcess = null; // エラーが発生した場合は参照をクリアして、新しいプロセスを開始できるようにする
      _startNewGeminiProcess(wss);
      isRestartingGemini = false;
      return; // エラー処理後、ここで終了
    }

    // タイムアウトを設定して、強制終了
    setTimeout(() => {
      if (geminiProcess && !geminiProcess.killed) {
        console.warn(`[Gemini Process] Gemini process (PID: ${geminiProcess.pid}) did not exit gracefully. Forcing SIGKILL.`);
        try {
          process.kill(geminiProcess.pid, 'SIGKILL'); // SIGKILLはプロセスグループではなく個別のプロセスに送る
        } catch (err) {
          console.error(`[Gemini Process ERROR] Failed to SIGKILL process with PID: ${geminiProcess.pid}. Error: ${err.message}`);
        }
      }
    }, 3000); // 3秒待っても終了しない場合

  } else {
    console.log('[Gemini Process] No existing Gemini process. Starting a new one.');
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
            const { text, files, goal, session, messageId } = msg.params?.chunks?.[0] || {};
            const inputText = text || '';

            if (ongoingText.length > 0) {
                const rec = { id: String(Date.now()), ts: Date.now(), role: 'assistant', text: ongoingText.trimEnd() };
                history.push(rec);
                ongoingText = '';
            }

            // ★ 修正点: アシスタントの返信IDをここで生成
            currentAssistantId = `assistant-${Date.now()}`;

            // Save the original message with files, goal, and session to history for the UI
            const rec = { id: messageId || String(Date.now()), ts: Date.now(), role: 'user', text: inputText, files: files || [], goal: goal || null, session: session || null };
            history.push(rec);
            
            // Broadcast the new user message to all clients
            console.log('[Server] Broadcasting addMessage:', JSON.stringify({ jsonrpc: '2.0', method: 'addMessage', params: { message: rec } }, null, 2));
            broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });

            // Create the message for the AI
            let systemMessages = [];
            if (files && files.length > 0) {
                const fileNames = files.map(file => `- ${file.name} (${file.path})`).join('\n');
                systemMessages.push(`[System]ユーザーは以下のファイルをアップロードしました：\n${fileNames}`);
            }
            if (goal) {
                systemMessages.push(`[System]ユーザーは以下の目標を開始しました：\n- ID: ${goal.id}\n- 教科: ${goal.subject}\n- タスク: ${goal.task}${goal.details ? `\n- 詳細: ${goal.details}` : ''}`);
            }
            if (session) {
                const { session: sessionData, logEntry } = session;
                systemMessages.push(`[System]ユーザーは以下の学習セッションを共有しました：\n- セッションID: ${sessionData.session_id}\n- 教科: ${sessionData.subject}\n- イベントタイプ: ${logEntry.type}\n- 学習内容: ${logEntry.content || "休憩"}\n- 時間: ${logEntry.start_time} - ${logEntry.end_time} (${logEntry.duration_minutes}分)${logEntry.memo ? `\n- メモ: ${logEntry.memo}` : ''}${logEntry.impression ? `\n- 感想: ${logEntry.impression}` : ''}`);
            }

            let messageForAI = inputText;
            if (systemMessages.length > 0) {
                messageForAI = `${systemMessages.join('\n\n')}\n\n${inputText}`;
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
