const { createServer: createHttpServer } = require('http');
const { createServer: createHttpsServer } = require('https');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Suppress noisy Workbox multi-run warnings in dev only
if (process.env.NODE_ENV !== 'production') {
  const _warn = console.warn.bind(console);
  console.warn = (...args) => {
    try {
      const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (/has been called multiple times, perhaps due to running webpack in --watch mode/i.test(msg)) {
        return; // drop only this specific Workbox warning
      }
    } catch {}
    _warn(...args);
  };
}

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = 3000;

// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// --- Start of Gemini Process Logic (from old server.js) ---
// Gemini CLI 起動設定
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BIN = process.env.GEMINI_BIN || 'gemini'; // グローバルCLIを既定
// CLI本体にも '-y' を付与して自動確認を許可
const GEMINI_FLAGS = ['-m', GEMINI_MODEL, '-y', '--experimental-acp'];
const PROJECT_ROOT = path.join(__dirname, '..');

function getGeminiSpawnSpec() {
  // グローバル gemini コマンドを使用（必要なら GEMINI_BIN で差し替え）
  return {
    cmd: 'sudo',
    args: ['-E', '-u', 'geminicli', GEMINI_BIN, ...GEMINI_FLAGS],
  };
}

let geminiProcess = null;
const history = [];
let ongoingText = '';
let isRestartingGemini = false; // 新しいフラグ
let currentAssistantId = null; // ★ 返信ごとに一意なIDを保持する変数
// --- ACP 0.2.2 state
let acpSessionId = null; // 現在のセッションID
let acpReqCounter = 1;   // AgentへのリクエストID採番
const acpPending = new Map(); // id -> method 名
const pendingPrompts = [];    // セッション準備前に受けた送信をキュー
let isFlushingQueue = false;
let acpMode = 'unknown'; // 'v1' | 'legacy' | 'unknown'

function acpSend(method, params) {
  const id = acpReqCounter++;
  acpPending.set(id, method);
  const req = { jsonrpc: '2.0', id, method, params };
  geminiProcess?.stdin.write(JSON.stringify(req) + '\n');
  return id;
}

function mapToolStatus(status) {
  switch (status) {
    case 'pending':
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'finished';
    case 'failed':
      return 'error';
    default:
      return 'running';
  }
}

function broadcast(wss, json){
  const str = JSON.stringify(json);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(str);
    }
  }
}

function broadcastExcept(wss, sender, json) {
  const str = JSON.stringify(json);
  for (const ws of wss.clients) {
    if (ws !== sender && ws.readyState === 1) { // WebSocket.OPEN
      ws.send(str);
    }
  }
}

function _startNewGeminiProcess(wss) { // Pass wss to broadcast
  console.log(`[Gemini Process] Attempting to start new Gemini process... (Called from: ${new Error().stack.split('\n')[2].trim()})`);
  const spec = getGeminiSpawnSpec();
  console.log(`[Gemini Process] Spawning: ${spec.cmd} ${spec.args.join(' ')}`);
  geminiProcess = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: path.join(__dirname, '..'), env: process.env });

  // Reset ACP state on fresh start
  acpSessionId = null;
  acpReqCounter = 1;
  acpPending.clear();
  pendingPrompts.length = 0;
  acpMode = 'unknown';

  const init = {
    jsonrpc: '2.0',
    id:      acpReqCounter,
    method:  'initialize',
    params:  {
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      protocolVersion: 1,
    }
  };
  acpPending.set(acpReqCounter, 'initialize');
  acpReqCounter++;
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
                // --- ACP 0.2.2 and legacy handling ---
                // 1) Handle responses to our ACP requests
                if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
                  const meth = acpPending.get(msg.id);
                    if (meth) {
                      acpPending.delete(msg.id);
                    if (meth === 'initialize' && msg.result) {
                      console.log('[ACP] initialize result:', JSON.stringify(msg.result));
                      const pv = msg.result?.protocolVersion;
                      const isV1 = pv === 1 || pv === '1' || pv === '1.0.0';
                      if (isV1) {
                        acpMode = 'v1';
                        // 先にnewSessionを試す
                        console.log('[ACP] Attempting to start a new session directly...');
                        const newSessParams = { cwd: PROJECT_ROOT, mcpServers: [] };
                        acpSend('session/new', newSessParams);
                      } else {
                        // Legacy experimental ACP (0.0.x)
                        acpMode = 'legacy';
                        console.log('[ACP] Detected legacy protocol, using legacy message flow.');
                        flushPromptQueueLegacy();
                      }
                      return; // ハンドリング終了
                    } else if (meth === 'authenticate') {
                      // 認証後、新しいセッションを作成
                      console.log('[ACP] Authentication successful. Creating new session...');
                      const newSessParams = { cwd: PROJECT_ROOT, mcpServers: [] };
                      acpSend('session/new', newSessParams);
                      return;
                    } else if (meth === 'session/new') {
                      if (msg.result?.sessionId) {
                        // セッション成功
                        acpSessionId = msg.result.sessionId;
                        console.log(`[ACP] New session established: ${acpSessionId}`);
                        flushPromptQueue();
                      } else if (msg.error && msg.error.code === -32000) {
                        // 認証が必要
                        console.log('[ACP] New session failed with auth error. Starting authentication...');
                        // initializeのレスポンスをどこかに保存しておく必要があるが、
                        // 現状のコードではレスポンスが揮発してしまうため、決め打ちで認証方法を呼び出す。
                        // Gemini CLIの `initialize` は通常 `oauth-personal` を返す。
                        const authMethodId = 'oauth-personal'; 
                        console.log(`[ACP] authenticating via method: ${authMethodId}`);
                        acpSend('authenticate', { methodId: authMethodId });
                      } else {
                        // その他のセッションエラー
                        console.error('[ACP] Failed to create new session:', msg.error);
                      }
                      return;
                    } else if (meth === 'session/prompt') {
                      // Treat prompt response as completion signal
                      if (ongoingText.length > 0) {
                        const rec = { id: currentAssistantId || String(Date.now()), ts: Date.now(), role: 'assistant', text: ongoingText.trimEnd() };
                        broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });
                        ongoingText = '';
                        currentAssistantId = null;
                      }
                      broadcast(wss, { jsonrpc: '2.0', method: 'messageCompleted', params: { stopReason: msg.result?.stopReason || 'end_turn' } });
                    }
                    return; // handled
                  }
                }

                // 2) Handle requests coming from Agent (client methods)
                if (msg.id !== undefined && typeof msg.method === 'string') {
                  if (msg.method === 'session/request_permission') {
                    // Auto-allow: prefer allow_once, fallback to first option
                    try {
                      const opts = msg.params?.options || [];
                      const allow = opts.find(o => o.kind === 'allow_once') || opts[0];
                      const result = { outcome: { outcome: 'selected', optionId: allow?.optionId || 'allow_once' } };
                      geminiProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
                    } catch (e) {
                      geminiProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } }) + '\n');
                    }
                    return;
                  } else if (msg.method === 'fs/read_text_file') {
                    (async () => {
                      try {
                        const rel = msg.params?.path || '';
                        const abs = path.resolve(PROJECT_ROOT, rel);
                        if (!abs.startsWith(PROJECT_ROOT)) throw new Error('Path outside project');
                        const content = fs.readFileSync(abs, 'utf-8');
                        geminiProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content } }) + '\n');
                      } catch (e) {
                        geminiProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Read failed' } }) + '\n');
                      }
                    })();
                    return;
                  } else if (msg.method === 'fs/write_text_file') {
                    (async () => {
                      try {
                        const rel = msg.params?.path || '';
                        const abs = path.resolve(PROJECT_ROOT, rel);
                        if (!abs.startsWith(PROJECT_ROOT)) throw new Error('Path outside project');
                        fs.mkdirSync(path.dirname(abs), { recursive: true });
                        fs.writeFileSync(abs, msg.params?.content ?? '', 'utf-8');
                        geminiProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
                      } catch (e) {
                        geminiProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Write failed' } }) + '\n');
                      }
                    })();
                    return;
                  }
                }

                // 3) Handle ACP session/update notifications and map to UI events
                if (msg.method === 'session/update' && msg.params?.update) {
                  const upd = msg.params.update;
                  const nowTs = Date.now();
                  const ensureAssistantId = () => {
                    if (!currentAssistantId) currentAssistantId = `assistant-${nowTs}`;
                    return currentAssistantId;
                  };

                  const emitChunk = (chunk) => {
                    const mid = ensureAssistantId();
                    broadcast(wss, { jsonrpc: '2.0', method: 'streamAssistantMessageChunk', params: { messageId: mid, chunk } });
                  };

                  const contentBlockToText = (cb) => {
                    if (!cb) return '';
                    if (cb.type === 'text' && typeof cb.text === 'string') return cb.text;
                    return '';
                  };

                  if (upd.sessionUpdate === 'agent_thought_chunk') {
                    emitChunk({ thought: contentBlockToText(upd.content) });
                  } else if (upd.sessionUpdate === 'agent_message_chunk') {
                    const t = contentBlockToText(upd.content);
                    if (t) {
                      ongoingText += t;
                      emitChunk({ text: t });
                    }
                  } else if (upd.sessionUpdate === 'tool_call') {
                    const toolId = upd.toolCallId || `tool-${nowTs}`;
                    const params = {
                      toolCallId: toolId,
                      icon: upd.kind || 'tool',
                      label: upd.title || String(upd.kind || 'tool'),
                      locations: upd.locations || [],
                      confirmation: undefined,
                    };
                    const toolMsg = { jsonrpc: '2.0', method: 'pushToolCall', id: msg.id, ts: nowTs, params };
                    history.push({ ...toolMsg, ts: nowTs, type: 'tool' });
                    broadcast(wss, toolMsg);
                  } else if (upd.sessionUpdate === 'tool_call_update') {
                    const toolId = upd.toolCallId;
                    let content = undefined;
                    if (Array.isArray(upd.content) && upd.content.length > 0) {
                      const c = upd.content[0];
                      if (c.type === 'content' && c.content?.type === 'text') {
                        content = { type: 'markdown', markdown: c.content.text };
                      } else if (c.type === 'diff') {
                        content = { type: 'diff', oldText: c.oldText || '', newText: c.newText || '' };
                      }
                    }
                    const updateMsg = { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: toolId, status: mapToolStatus(upd.status), content } };
                    broadcast(wss, updateMsg);
                  } else if (upd.sessionUpdate === 'plan') {
                    console.log('[ACP] plan update entries:', upd.entries?.length || 0);
                  }
                  return; // handled
                }

                // 4) Legacy passthrough: old experimental-acp messages
                if (msg.method !== 'streamAssistantMessageChunk' && ongoingText.length > 0) {
                    const rec = { id: currentAssistantId || String(Date.now()), ts:Date.now(), role:'assistant', text:ongoingText.trimEnd() };
                    history.push(rec);
                    console.log('[History] Saved assistant message (before other message): ' + JSON.stringify(rec));
                    ongoingText = '';
                    currentAssistantId = null;
                }

                if (msg.method === 'streamAssistantMessageChunk') {
                    const { chunk: c } = msg.params || {};
                    if (c?.text) {
                        ongoingText += c.text;
                    }
                    if (currentAssistantId) {
                      msg.params.messageId = currentAssistantId;
                    }
                    broadcast(wss, msg);
                    continue;
                }

                const methodsToExclude = ['initialize', 'requestToolCallConfirmation', 'updateToolCall'];
                if ((msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted' || (msg.result !== undefined && msg.result !== null)) && !methodsToExclude.includes(msg.method)) {
                    if (ongoingText.length > 0) {
                        const rec = { id: currentAssistantId || String(Date.now()), ts:Date.now(), role:'assistant', text:ongoingText.trimEnd() };
                        broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });
                        ongoingText = '';
                        currentAssistantId = null;
                    }
                    broadcast(wss, msg);
                    continue;
                }

                if (msg.role && msg.text) {
                    history.push({ ...msg, id: (msg.id !== undefined && msg.id !== null) ? String(msg.id) : String(Date.now()) });
                }
                if (msg.method === 'updateToolCall') {
                  broadcast(wss, msg);
                  geminiProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
                  history.push({ ...msg, ts: Date.now(), type:'tool' });
                  return;
                }
                else if (msg.method === 'pushToolCall') {
                    msg.ts = Date.now();
                    history.push({ ...msg, type: 'tool' });
                }
                else if (msg.method === 'requestToolCallConfirmation') {
                    msg.ts = Date.now();
                    history.push({ ...msg, type: 'tool' });

                    const command = msg.params?.confirmation?.command;
                    if (command && command.includes('manage_log.py')) {
                        console.log(`[Server] Detected database command: "${command}". Broadcasting databaseUpdated message.`);
                        setTimeout(() => {
                            broadcast(wss, { jsonrpc: '2.0', method: 'databaseUpdated', params: {} });
                        }, 200);
                    }
                }

                broadcast(wss, msg);
                // --- End of handling ---

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

  const child = geminiProcess;
  child.on('close', (code, signal) => {
    console.log(`[Gemini Process] Gemini process (PID: ${child.pid}) exited with code ${code} and signal ${signal}. (Called from: ${new Error().stack.split('\n')[2].trim()})`);
    if (geminiProcess && geminiProcess.pid === child.pid) {
        history.length = 0;
        broadcast(wss, { jsonrpc:'2.0', method:'historyCleared', params:{ reason: 'gemini-exit' } });
        geminiProcess = null;
        acpSessionId = null;
        // 自動再起動（短い待機後）
        setTimeout(() => {
          console.log('[Gemini Process] Restarting after unexpected exit...');
          startGemini(wss);
        }, 1500);
    }
  });
}

function flushPromptQueue() {
  if (!acpSessionId || isFlushingQueue || pendingPrompts.length === 0 || !geminiProcess) return;
  isFlushingQueue = true;
  try {
    while (pendingPrompts.length > 0 && acpSessionId && geminiProcess) {
      const text = pendingPrompts.shift();
      const promptParams = { sessionId: acpSessionId, prompt: [{ type: 'text', text }] };
      acpSend('session/prompt', promptParams);
    }
  } finally {
    isFlushingQueue = false;
  }
}

function flushPromptQueueLegacy() {
  if (isFlushingQueue || pendingPrompts.length === 0 || !geminiProcess) return;
  isFlushingQueue = true;
  try {
    while (pendingPrompts.length > 0 && geminiProcess) {
      const text = pendingPrompts.shift();
      const localId = Date.now();
      const req = {
        jsonrpc: '2.0',
        id: localId,
        method: 'sendUserMessage',
        params: { chunks: [{ text }] },
      };
      geminiProcess.stdin.write(JSON.stringify(req) + '\n');
    }
  } finally {
    isFlushingQueue = false;
  }
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
      // Allow all origins in dev to load assets across origins
      if (dev) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, X-Requested-With');
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
      }
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
    if (dev) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
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

        // --- Heartbeat ping/pong ---
        if ((msg && (msg.type === 'ping' || msg.method === 'ping')) || text.trim().toLowerCase() === 'ping') {
            try {
                ws.send(JSON.stringify({ type: 'pong' }));
            } catch {}
            return;
        }

        // --- clearHistory メソッドの処理を追加 ---
        if (msg.method === 'clearHistory') {
            console.log('[Server] Received clearHistory command.');
            history.length = 0;
            broadcast(wss, { jsonrpc: '2.0', method: 'historyCleared', params: { reason: 'command' } });
            
            // Geminiプロセスを再起動する代わりに、新しいセッションを開始する
            if (geminiProcess && acpMode === 'v1') {
              console.log('[ACP] Clearing history by starting a new session.');
              const newSessParams = { cwd: PROJECT_ROOT, mcpServers: [] };
              acpSend('session/new', newSessParams);
            } else if (geminiProcess) {
              // v1以外のモードやセッションがない場合は、従来通り再起動
              console.warn('[Server] ACPv1 session not active. Restarting Gemini process to clear history.');
              startGemini(wss);
            }

            return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
        }

        if (msg.method === 'fetchHistory') {
            // 直近の未確定テキストを確定化（次回の取得で落ちないように）
            if (ongoingText.length > 0) {
                const rec = { id: String(Date.now()), ts: Date.now(), role: 'assistant', text: ongoingText.trimEnd() };
                history.push(rec);
                ongoingText = '';
            }
            const { limit = 20, before, after } = msg.params || {};
            let chunk;
            if (after) {
                // 差分: 指定tsより新しいものを返す
                chunk = history.filter(rec => (rec.ts ?? 0) > after).slice(-(limit || 100));
            } else if (before) {
                // 過去: 指定tsより古いものから末尾limit件
                chunk = history.filter(rec => (rec.ts ?? 0) < before).slice(-limit);
            } else {
                // 末尾limit件
                chunk = history.slice(-limit);
            }
            chunk.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
            return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { messages: chunk } }));
        }

        if (msg.method === 'sendUserMessage') {
            const { text, files, goal, session, messageId, features } = msg.params?.chunks?.[0] || {};
            const inputText = text || '';

            if (ongoingText.length > 0) {
                const rec = { id: String(Date.now()), ts: Date.now(), role: 'assistant', text: ongoingText.trimEnd() };
                history.push(rec);
                ongoingText = '';
            }

            // ★ 修正点: アシスタントの返信IDをここで生成
            currentAssistantId = `assistant-${Date.now()}`;

            // Do NOT parse user text for [System] directives (avoid prompt injection).
            // Treat all user text as visible content.
            let systemMessages = [];
            const userVisibleText = inputText;

            // Save the original message with files, goal, and session to history for the UI
            const rec = { id: messageId || String(Date.now()), ts: Date.now(), role: 'user', text: userVisibleText, files: files || [], goal: goal || null, session: session || null };
            history.push(rec);
            
            // Broadcast the new user message to other clients
            console.log('[Server] Broadcasting addMessage to other clients:', JSON.stringify({ jsonrpc: '2.0', method: 'addMessage', params: { message: rec } }, null, 2));
            broadcastExcept(wss, ws, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });

            // Create the message for the AI (augment with implicit system messages)
            if (features?.webSearch) {
                systemMessages.push(`[System]ユーザーはウェブ検索機能を使うことを希望しています。`);
            }
            if (files && files.length > 0) {
                const fileNames = files.map(file => `- ${file.name} (${file.path})`).join('\n');
                systemMessages.push(`[System]ユーザーは以下のファイルをアップロードしました：\n${fileNames}`);
            }
            if (goal) {
                systemMessages.push(`[System]ユーザーは以下の目標を開始しました：\n- ID: ${goal.id}\n- 教科: ${goal.subject}\n- タスク: ${goal.task}${goal.details ? `\n- 詳細: ${goal.details}` : ''}`);
            }
            if (session) {
                systemMessages.push(`[System]ユーザーは以下の学習記録を共有しました：\n- ログID: ${session.id}\n- イベントタイプ: ${session.type}\n- 学習内容: ${session.content || "休憩"}\n- 時間: ${session.start_time} - ${session.end_time} (${session.duration_minutes}分)${session.memo ? `\n- メモ: ${session.memo}` : ''}${session.impression ? `\n- 感想: ${session.impression}` : ''}`);
            }

            let messageForAI = userVisibleText || inputText;
            if (systemMessages.length > 0) {
                messageForAI = `${systemMessages.join('\n\n')}\n\n${userVisibleText}`;
            }

            // Send the message to the Gemini Agent via ACP session/prompt
            if (geminiProcess && acpSessionId) {
                const promptParams = {
                  sessionId: acpSessionId,
                  prompt: [ { type: 'text', text: messageForAI } ],
                };
                acpSend('session/prompt', promptParams);
            } else if (geminiProcess && acpMode === 'unknown') {
                console.warn('[ACP] No protocol determined yet; queueing prompt');
                pendingPrompts.push(messageForAI);
            } else if (geminiProcess && acpMode === 'legacy') {
                // Directly forward as legacy sendUserMessage
                const aiMsg = {
                    ...msg,
                    params: {
                        ...msg.params,
                        chunks: [{ text: messageForAI }]
                    }
                };
                geminiProcess.stdin.write(JSON.stringify(aiMsg) + '\n');
            } else if (geminiProcess && acpMode === 'v1' && !acpSessionId) {
                console.warn('[ACP] v1 mode but no active session yet; queueing prompt');
                pendingPrompts.push(messageForAI);
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
