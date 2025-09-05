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
    args: ['-E', '-u', 'geminicli', 'npx', '@google/gemini-cli@0.3.2', ...GEMINI_FLAGS],
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

// JSON-RPC の「応答」を送る（permission など双方向RPCで必要）
function acpRespond(id, result) {
  if (!geminiProcess || !geminiProcess.stdin || geminiProcess.stdin.destroyed) return;
  const resp = { jsonrpc: '2.0', id, result };
  try {
    geminiProcess.stdin.write(JSON.stringify(resp) + '\n');
    console.log('[ACP < RESP]', JSON.stringify(resp));
  } catch (e) {
    console.error('[ACP] Failed to send response:', e);
  }
}

function mapToolStatus(status) {
  if (!status) return undefined;
  const s = String(status).toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'done' || s === 'finished' || s === 'success' || s === 'succeeded') return 'finished';
  if (s === 'in_progress' || s === 'running' || s === 'pending' || s === 'started') return 'running';
  if (s === 'error' || s === 'failed' || s === 'failure') return 'error';
  return undefined;
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

// 履歴内のツールカードを探して更新（なければ undefined）
function findLastToolHistoryIndex(toolCallId) {
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i];
    if (!rec) continue;
    // 正規化済み（role: 'tool'）だけを対象
    if ((rec.role === 'tool' || rec.type === 'tool') && (rec.id === toolCallId || rec.toolCallId === toolCallId)) {
      return i;
    }
  }
  return -1;
}

function pushNormalizedToolHistory({ toolCallId, icon, label, command, status, content }) {
  const nowTs = Date.now();
  const msg = {
    id: toolCallId,
    ts: nowTs,
    role: 'tool',
    type: 'tool',
    toolCallId,
    icon: icon || 'tool',
    label: label || 'Tool',
    command: command || '',
    status: status || 'running',
    content: content || '',
  };
  history.push(msg);
  return msg;
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
      case 'session/request_permission': {
        // ツールカード描画前に、進行中の本文を確定（ターンは閉じない）
        finalizeAssistantPartial(wss);
        // ツール実行の許可要求の段階で、ツールカードを作成・履歴へ永続化しておく（tool_call が来ないケースがあるため）
        const tc = msg.params?.toolCall;
        if (tc && tc.toolCallId) {
          const icon = tc.kind || 'tool';
          const rawLabel = tc.title || String(tc.kind || 'tool');
          const command = (rawLabel || '').split(' (')[0];
          // 履歴に存在しなければ追加
          const existsIdx = findLastToolHistoryIndex(tc.toolCallId);
          if (existsIdx === -1) {
            pushNormalizedToolHistory({
              toolCallId: tc.toolCallId,
              icon,
              label: rawLabel,
              command,
              status: mapToolStatus(tc.status || 'pending'),
              content: '',
            });
          }
          // 思考クリア（許可要求の段階で見た目上ツール開始扱いにしたい）
          broadcast(wss, { jsonrpc: '2.0', method: 'clearActiveThought' });

          // リアルタイム表示用に pushToolCall をブロードキャスト
          const pushMsg = {
            jsonrpc: '2.0',
            method: 'pushToolCall',
            params: {
              toolCallId: tc.toolCallId,
              icon,
              label: rawLabel,
              locations: tc.locations || [],
            }
          };
          broadcast(wss, pushMsg);
        }

        // 許可応答（既存ロジック）
        const opts = msg.params?.options || [];
        const allowOnce = opts.find(o => o.kind === 'allow_once') || opts.find(o => o.optionId === 'proceed_once') || opts[0];
        const optionId = allowOnce?.optionId || 'proceed_once';
        acpRespond(msg.id, {
          sessionId: acpSessionId,
          outcome: { outcome: 'selected', optionId }
        });
        break;
      }
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

    // 2. addMessage で全クライアントに確定したメッセージを通知
    broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: assistantMessage } });
  }

  // 3. messageCompleted でストリームの終了を通知する
  if (currentAssistantMessage.id) {
    broadcast(wss, { jsonrpc: '2.0', method: 'messageCompleted', params: { messageId: currentAssistantMessage.id, stopReason: stopReason || 'end_turn' } });
  }
  
  // 4. 現在のメッセージをリセットする
  currentAssistantMessage = { id: null, text: '', thought: '' };
}

// ツール開始等でターンは閉じずに、現時点の本文のみ確定（addMessage）する
function finalizeAssistantPartial(wss) {
  if (currentAssistantMessage.id && currentAssistantMessage.text) {
    const assistantMessage = {
      id: currentAssistantMessage.id,
      ts: Date.now(),
      role: 'assistant',
      text: currentAssistantMessage.text.trim(),
    };
    history.push(assistantMessage);
    broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: assistantMessage } });
  }
  // 次のストリームは新しいIDで始まるようにリセット
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
        method: 'streamAssistantMessageChunk',
        params: {
          messageId: currentAssistantMessage.id,
          chunk: { thought: thoughtChunk }
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

    case 'tool_call': {
      // ツールカード描画前に、進行中の本文を確定（ターンは閉じない）
      finalizeAssistantPartial(wss);
      const toolCallId = upd.toolCallId || `tool-${nowTs}`;
      const icon = upd.kind || 'tool';
      const rawLabel = upd.title || String(upd.kind || 'tool');
      const command = (rawLabel || '').split(' (')[0];

      // 履歴に正規化メッセージとして保存（初期状態は running）
      pushNormalizedToolHistory({
        toolCallId,
        icon,
        label: rawLabel,
        command,
        status: 'running',
        content: '',
      });

      // 思考(assistant_thought)を即クリアさせる
      broadcast(wss, { jsonrpc: '2.0', method: 'clearActiveThought' });

      // リアルタイム描画用の push イベントも送る
      const toolMsg = {
        jsonrpc: '2.0',
        method: 'pushToolCall',
        params: {
          toolCallId,
          icon,
          label: rawLabel,
          locations: upd.locations || [],
        }
      };
      broadcast(wss, toolMsg);
      break;
    }

    case 'tool_call_update': {
      const mappedStatus = mapToolStatus(upd.status);
      let content;
      if (Array.isArray(upd.content) && upd.content.length > 0) {
        const c = upd.content[0];
        if (c.type === 'content' && c.content?.type === 'text') {
          content = { type: 'markdown', markdown: c.content.text };
        } else if (c.type === 'diff') {
          content = { type: 'diff', oldText: c.oldText || '', newText: c.newText || '' };
        }
      }
      const idx = findLastToolHistoryIndex(upd.toolCallId);
      if (idx !== -1) {
        const rec = history[idx];
        if (content?.type === 'markdown') {
            rec.content = content.markdown;
        } else if (content?.type === 'diff') {
            rec.content = JSON.stringify(content);
        }
        rec.status = mappedStatus;
        // 並び順を安定させるため、作成時刻(ts)は更新しない
        rec.updatedTs = Date.now();
      }
      broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: upd.toolCallId, status: mappedStatus, content } });
      break;
    }
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
        // 未確定テキストを「同一ID」で確定してから返す（ここが修正点）
        if (currentAssistantMessage.id && currentAssistantMessage.text) {
          const id = currentAssistantMessage.id;
          const rec = {
            id,
            ts: Date.now(),
            role: 'assistant',
            text: currentAssistantMessage.text.trimEnd(),
          };
          // 既に同一IDの最終メッセージが履歴にあるか確認して重複を避ける
          const exists = history.some(h => h.id === id);
          if (!exists) {
            history.push(rec);
          }
          // active テキストはここでは消さない（最終 addMessage と競合しないよう ID のみ合わせる）
        }

        const { limit = 50, before, after } = msg.params || {};

        let chunk = history;

        if (typeof after === 'number') {
          chunk = chunk.filter(rec => (rec.ts ?? 0) > after).slice(0, limit);
        } else if (typeof before === 'number') {
          const older = chunk.filter(rec => (rec.ts ?? 0) < before);
          chunk = older.slice(Math.max(0, older.length - limit));
        } else {
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

      if (msg.method === 'cancelSendMessage') {
        try {
          await acpSend('session/interrupt', { sessionId: acpSessionId });
        } catch (e) {
          console.log('[ACP] session/interrupt not available or failed:', e?.message || e);
        }
        flushAssistantMessage(wss, 'canceled');
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null })); } catch {}
        return;
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
