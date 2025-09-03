// webnew/server.js (変更後のコード)

const { createServer: createHttpsServer } = require('https');
const { createServer: createHttpServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline'); // 1. 依存モジュールの追加

if (process.env.NODE_ENV !== 'production') {
  const env = require('dotenv');
  env.config({ path: path.join(__dirname, '..', '.env') });
}

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = 443;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// --- Gemini Process Logic ---
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_FLAGS = ['-m', GEMINI_MODEL, '-y', '--experimental-acp'];
const PROJECT_ROOT = path.join(__dirname, '..');

// 2. プロセス起動処理の更新
function getGeminiSpawnSpec() {
  return {
    cmd: 'sudo',
    args: ['-E', '-u', 'geminicli', 'npx', '@google/gemini-cli@0.2.2', ...GEMINI_FLAGS],
  };
}

let geminiProcess = null;
const history = [];
let isRestartingGemini = false;

// --- ACP v0.2.2 State & Functions (移植・統合) ---
let acpSessionId = null;
let acpReqCounter = 1;
const acpPending = new Map();
const pendingPrompts = [];
let isSessionReady = false;
let currentAssistantMessage = { id: null, text: '', thought: '' };

function acpSend(method, params) {
  if (!geminiProcess || !geminiProcess.stdin || geminiProcess.stdin.destroyed) {
    return Promise.reject(new Error('Gemini process not running'));
  }
  const id = acpReqCounter++;
  const req = { jsonrpc: '2.0', id, method, params };
  
  return new Promise((resolve, reject) => {
    acpPending.set(id, { method, resolve, reject });
    try {
      geminiProcess.stdin.write(JSON.stringify(req) + '\n');
      console.log('[ACP >]', JSON.stringify(req));
    } catch (e) {
      acpPending.delete(id);
      reject(e);
    }
  });
}

function mapToolStatus(status) {
  switch (status) {
    case 'pending': return 'running';
    case 'success': return 'finished';
    case 'failure': return 'error';
    default: return status;
  }
}

function broadcast(wss, json) {
  const str = JSON.stringify(json);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      ws.send(str);
    }
  }
}

function broadcastExcept(wss, sender, json) {
  const str = JSON.stringify(json);
  for (const ws of wss.clients) {
    if (ws !== sender && ws.readyState === 1) {
      ws.send(str);
    }
  }
}

function _startNewGeminiProcess(wss) {
  console.log(`[Gemini Process] Starting new Gemini process...`);
  const spec = getGeminiSpawnSpec();
  geminiProcess = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: PROJECT_ROOT, env: process.env });

  acpSessionId = null;
  acpReqCounter = 1;
  acpPending.clear();
  isSessionReady = false;

  geminiProcess.on('error', (err) => console.error('[Gemini SPAWN ERROR]', err));
  console.log(`[Gemini Process] New Gemini process started with PID: ${geminiProcess.pid}`);

  // 3. 標準出力の処理方法の変更
  const rl = readline.createInterface({ input: geminiProcess.stdout });
  rl.on('line', (line) => {
    handleCliMessage(line, wss);
  });

  geminiProcess.stderr.on('data', data => console.error('[Gemini ERROR] ' + data.toString()));

  geminiProcess.on('close', (code, signal) => {
    console.log(`[Gemini Process] Gemini process exited with code ${code} and signal ${signal}.`);
    if (geminiProcess && geminiProcess.pid === geminiProcess.pid) {
      history.length = 0;
      broadcast(wss, { jsonrpc: '2.0', method: 'historyCleared', params: { reason: 'gemini-exit' } });
      geminiProcess = null;
      isSessionReady = false;
      acpSessionId = null;
      setTimeout(() => {
        console.log('[Gemini Process] Restarting after unexpected exit...');
        startGemini(wss);
      }, 1500);
    }
  });

  initializeAndStartSession();
}

async function initializeAndStartSession() {
    try {
        await acpSend('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
        const sessionResult = await acpSend('session/new', { cwd: PROJECT_ROOT, mcpServers: [] });
        if (sessionResult?.sessionId) {
            acpSessionId = sessionResult.sessionId;
            isSessionReady = true;
            console.log(`[ACP] New session established: ${acpSessionId}`);
            flushPromptQueue();
        } else {
            console.error('[ACP] Failed to create new session, result:', sessionResult);
        }
    } catch (error) {
        console.error('[ACP] Error during initialization or session creation:', error);
    }
}

// 4. ACP通信関数 (handleCliMessage, handleSessionUpdate) の導入
function handleCliMessage(jsonString, wss) {
  console.log('[Gemini CLI <]', jsonString);
  let msg;
  try {
    msg = JSON.parse(jsonString);
  } catch (e) {
    console.error('Error parsing JSON from CLI:', e, jsonString);
    return;
  }

  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = acpPending.get(msg.id);
    if (pending) {
      acpPending.delete(msg.id);
      if (msg.error) {
        pending.reject(msg.error);
      } else {
        pending.resolve(msg.result);
        if (pending.method === 'session/prompt') {
          flushAssistantMessage(wss, msg.result?.stopReason);
        }
      }
    }
    return;
  }

  if (typeof msg.method === 'string') {
    switch (msg.method) {
      case 'session/update':
        handleSessionUpdate(msg.params.update, wss);
        break;
      case 'session/request_permission':
        const opts = msg.params?.options || [];
        const allow = opts.find(o => o.kind === 'allow_once') || opts[0];
        acpSend('session/provide_permission', {
            sessionId: acpSessionId,
            outcome: { outcome: 'selected', optionId: allow?.optionId || 'allow_once' }
        }).catch(e => console.error('[ACP] Error providing permission:', e));
        break;
    }
    return;
  }
}

function ensureAssistantMessage(wss, ts) {
    if (!currentAssistantMessage.id) {
        currentAssistantMessage.id = `assistant-${ts}`;
    }
}

function flushAssistantMessage(wss, stopReason) {
    // テキストがある場合のみ処理
    if (currentAssistantMessage.id && currentAssistantMessage.text) {
        const assistantMessage = {
            id: currentAssistantMessage.id,
            ts: Date.now(),
            role: 'assistant',
            text: currentAssistantMessage.text.trim(),
        };
        // 1. 履歴に保存する
        history.push(assistantMessage);

        // 2. ★★★[最重要] addMessage で全クライアントに確定したメッセージを通知する★★★
        broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: assistantMessage } });
    }

    // 3. messageCompleted でストリームの終了を通知する
    if (currentAssistantMessage.id) {
        broadcast(wss, { jsonrpc: '2.0', method: 'messageCompleted', params: { messageId: currentAssistantMessage.id, stopReason: stopReason || 'end_turn' } });
    }
    
    // 4. 現在のメッセージをリセットする
    currentAssistantMessage = { id: null, text: '', thought: '' };
}

function handleSessionUpdate(upd, wss) {
  const nowTs = Date.now();
  switch (upd.sessionUpdate) {
    case 'agent_thought_chunk':
      ensureAssistantMessage(wss, nowTs);
      const thoughtChunk = upd.content?.type === 'text' ? upd.content.text : '';
      currentAssistantMessage.thought += thoughtChunk;
      broadcast(wss, {
        jsonrpc: '2.0',
        method: 'streamAssistantMessageChunk', // ← 正しいメソッド名に変更
        params: {
          messageId: currentAssistantMessage.id,
          chunk: { thought: thoughtChunk } // ← 正しいパラメータ構造に変更
        }
      });
      break;

    case 'agent_message_chunk':
      ensureAssistantMessage(wss, nowTs);
      const textChunk = upd.content?.type === 'text' ? upd.content.text : '';
      currentAssistantMessage.text += textChunk;
      broadcast(wss, {
        jsonrpc: '2.0',
        method: 'streamAssistantMessageChunk',
        params: { messageId: currentAssistantMessage.id, chunk: { text: textChunk } }
      });
      break;

    case 'end_of_turn':
      flushAssistantMessage(wss, upd.stopReason);
      break;

    case 'tool_call':
      const toolCallId = upd.toolCallId || `tool-${nowTs}`;
      const toolMsg = {
        jsonrpc: '2.0',
        method: 'pushToolCall',
        params: {
          toolCallId: toolCallId,
          icon: upd.kind || 'tool',
          label: upd.title || String(upd.kind || 'tool'),
          locations: upd.locations || [],
        }
      };
      history.push({ ...toolMsg, ts: nowTs, type: 'tool' });
      broadcast(wss, toolMsg);
      break;

    case 'tool_call_update':
      let content = undefined;
      if (Array.isArray(upd.content) && upd.content.length > 0) {
        const c = upd.content[0];
        if (c.type === 'content' && c.content?.type === 'text') {
          content = { type: 'markdown', markdown: c.content.text };
        } else if (c.type === 'diff') {
          content = { type: 'diff', oldText: c.oldText || '', newText: c.newText || '' };
        }
      }
      const updateMsg = {
        jsonrpc: '2.0',
        method: 'updateToolCall',
        params: { toolCallId: upd.toolCallId, status: mapToolStatus(upd.status), content }
      };
      broadcast(wss, updateMsg);
      break;
  }
}

function flushPromptQueue() {
  if (!isSessionReady || pendingPrompts.length === 0) return;
  while (pendingPrompts.length > 0) {
    const { text, messageId } = pendingPrompts.shift();
    acpSend('session/prompt', { sessionId: acpSessionId, prompt: [{ type: 'text', text }] })
      .catch(e => console.error('[ACP] Error sending queued prompt:', e));
  }
}

function startGemini(wss) {
  if (isRestartingGemini) return;
  if (geminiProcess) {
    isRestartingGemini = true;
    geminiProcess.once('close', () => {
      geminiProcess = null;
      isRestartingGemini = false;
      _startNewGeminiProcess(wss);
    });
    try {
      process.kill(-geminiProcess.pid, 'SIGTERM');
    } catch (err) {
       try {
         geminiProcess.kill('SIGTERM');
       } catch (e) {
         console.error(`[Gemini Process] Failed to kill process ${geminiProcess.pid}: ${e.message}`);
       }
    }
    setTimeout(() => {
      if (geminiProcess && !geminiProcess.killed) {
        try {
          geminiProcess.kill('SIGKILL');
        } catch (err) {
          console.error(`[Gemini Process] Failed to SIGKILL process ${geminiProcess.pid}: ${err.message}`);
        }
      }
    }, 3000);
  } else {
    _startNewGeminiProcess(wss);
  }
}

// --- Server Setup ---
const httpsOptions = {
  key: fs.readFileSync(path.resolve(__dirname, 'certs/key.pem')),
  cert: fs.readFileSync(path.resolve(__dirname, 'certs/cert.pem')),
};

app.prepare().then(() => {
  const httpsServer = createHttpsServer(httpsOptions, async (req, res) => {
    try {
      await handle(req, res, parse(req.url, true));
    } catch (err) {
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const httpServer = createHttpServer((req, res) => {
    const host = req.headers.host;
    const hostWithoutPort = host.replace(':3000', '');
    const httpsUrl = `https://${hostWithoutPort}${req.url}`;
    res.writeHead(301, { Location: httpsUrl });
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpsServer.on('upgrade', (request, socket, head) => {
    if (parse(request.url, true).pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', async data => {
      const text = data.toString();
      if (!text.trim()) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (e) {
        return;
      }

      if (msg.method === 'ping') {
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong' })); } catch {}
        return;
      }

      if (msg.method === 'clearHistory') {
        history.length = 0;
        broadcast(wss, { jsonrpc: '2.0', method: 'historyCleared', params: { reason: 'command' } });
        startGemini(wss);
        return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
      }

      if (msg.method === 'fetchHistory') {
        const { limit = 50, before, after } = msg.params || {};

        let chunk = history;

        if (typeof after === 'number') {
          // after より新しいもの
          chunk = chunk.filter(rec => (rec.ts ?? 0) > after).slice(0, limit);
        } else if (typeof before === 'number') {
          // before より古いものの末尾 limit 件
          const older = chunk.filter(rec => (rec.ts ?? 0) < before);
          chunk = older.slice(Math.max(0, older.length - limit));
        } else {
          // カーソルなしは末尾 limit 件
          chunk = chunk.slice(Math.max(0, history.length - limit));
        }

        // 昇順で返す
        chunk = [...chunk].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

        return ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { messages: chunk }
        }));
      }

      // 5. WebSocketメッセージハンドラの更新
      if (msg.method === 'sendUserMessage') {
        flushAssistantMessage(wss, 'interrupted');
        const { text: userText, files, goal, session, messageId, features } = msg.params?.chunks?.[0] || {};
        const rec = { id: messageId || String(Date.now()), ts: Date.now(), role: 'user', text: userText, files: files || [], goal: goal || null, session: session || null };
        history.push(rec);
        broadcastExcept(wss, ws, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });

        let systemMessages = [];
        if (features?.webSearch) systemMessages.push(`[System]ユーザーはウェブ検索機能を使うことを希望しています。`);
        if (files && files.length > 0) systemMessages.push(`[System]ユーザーは以下のファイルをアップロードしました：\n${files.map(f => `- ${f.name} (${f.path})`).join('\n')}`);
        if (goal) systemMessages.push(`[System]ユーザーは以下の目標を開始しました：\n- ID: ${goal.id}\n- タスク: ${goal.task}`);
        if (session) systemMessages.push(`[System]ユーザーは以下の学習記録を共有しました：\n- ログID: ${session.id}\n- 内容: ${session.content || 'N/A'}`);
        
        const fullPrompt = (systemMessages.length > 0 ? systemMessages.join('\n') + '\n\n' : '') + userText;

        if (isSessionReady && acpSessionId) {
            acpSend('session/prompt', { sessionId: acpSessionId, prompt: [{ type: 'text', text: fullPrompt }] })
              .catch(e => console.error('[ACP] Error sending prompt:', e));
        } else {
            pendingPrompts.push({ text: fullPrompt, messageId });
        }
        
        return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
      }
    });
    ws.on('close', () => console.log('Client disconnected'));
  });

  httpsServer.listen(port, hostname, () => {
    console.log(`> Ready on https://${hostname}:${port}`);
    startGemini(wss);
  });

  httpServer.listen(80, hostname, () => {
    console.log(`> HTTP redirect server running on http://${hostname}:80, redirecting to https`);
  });
});