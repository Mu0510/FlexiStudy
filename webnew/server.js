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
// Map toolCallId -> { requestId, options, cmdKey }
const permissionWaiters = new Map();

// ---- Permission helpers: robust command key derivation ----
function splitCommandLine(cmd) {
  // naive but handles simple quotes/escapes
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      cur += ch; continue;
    }
    if (ch === '\'' || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function deriveCommandKeyFromTokens(tokens) {
  if (!tokens || tokens.length === 0) return '';
  const skip = new Set(['sudo','env']);
  let i = 0;
  // Skip sudo/env and leading VAR=VALUE assignments and env flags
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (t === 'sudo') { i++; while (i < tokens.length && /^-/.test(tokens[i])) i++; continue; }
    if (t === 'env') { i++; while (i < tokens.length && (/^-/.test(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++; continue; }
    break;
  }
  const head = tokens[i] || '';
  if (!head) return '';
  if (head === 'npm' && tokens[i+1] === 'run' && tokens[i+2]) return `npm:run:${tokens[i+2]}`;
  if (head === 'npx' && tokens[i+1]) return `npx:${tokens[i+1]}`;
  if ((head === 'pnpm' || head === 'yarn') && tokens[i+1]) return `${head}:${tokens[i+1]}`;
  if (head === 'python' || head === 'python3' || head === 'node') return `${head}`;
  return `shell:${head}`;
}

function deriveCommandKey(tc) {
  try {
    const title = String(tc?.title || '');
    const kind = String(tc?.kind || '');
    const locPath = (tc?.locations && tc.locations[0] && tc.locations[0].path) ? String(tc.locations[0].path) : '';
    // Prefer explicit command string from locations when present
    let titleCmd = null;
    const mt = title.match(/^(?:Shell|Terminal)[:\s]+(.+)$/i);
    if (mt && mt[1]) titleCmd = mt[1]; else if (/shell|terminal/i.test(title)) titleCmd = title;
    const cmdStr = locPath || titleCmd || '';
    if (/terminal|shell/i.test(kind) || cmdStr) {
      let tokens = splitCommandLine(cmdStr.trim());
      // keep only the first command segment before control operators
      const opIdx = tokens.findIndex(t => t === '&&' || t === '||' || t === ';' || t === '|');
      if (opIdx !== -1) tokens = tokens.slice(0, opIdx);
      // unwrap bash/sh -c/-lc "..."
      if (tokens[0] && /^(bash|sh|zsh)$/.test(tokens[0]) && tokens[1] && /^-?l?c$/.test(tokens[1]) && tokens[2]) {
        const inner = tokens.slice(2).join(' ');
        let innerTokens = splitCommandLine(inner.replace(/^['"]|['"]$/g, ''));
        const innerOp = innerTokens.findIndex(t => t === '&&' || t === '||' || t === ';' || t === '|');
        if (innerOp !== -1) innerTokens = innerTokens.slice(0, innerOp);
        const key = deriveCommandKeyFromTokens(innerTokens);
        if (key) return key;
      }
      const key = deriveCommandKeyFromTokens(tokens);
      if (key) return key;
    }
    // Fallback: use first word of title
    const m = title.trim().split(/\s+/)[0] || 'tool';
    return m.toLowerCase();
  } catch {
    return '';
  }
}

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

// As a safety, directly provide permission via method too (some agents expect explicit RPC)
function acpProvideSelected(optionId) {
  try {
    if (!optionId) return;
    acpSend('session/provide_permission', { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId } })
      .catch(e => console.warn('[ACP] provide_permission failed:', e?.message || e));
  } catch {}
}

// JSON-RPC エラーレスポンスを送る
function acpRespondError(id, code, message, details) {
  if (!geminiProcess || !geminiProcess.stdin || geminiProcess.stdin.destroyed) return;
  const resp = { jsonrpc: '2.0', id, error: { code, message, data: details ? { details } : undefined } };
  try {
    geminiProcess.stdin.write(JSON.stringify(resp) + '\n');
    console.log('[ACP < RESP]', JSON.stringify(resp));
  } catch (e) {
    console.error('[ACP] Failed to send error response:', e);
  }
}

function safeResolveProjectPath(p) {
  try {
    const abs = path.resolve(p);
    const root = path.resolve(PROJECT_ROOT);
    if (!abs.startsWith(root)) {
      return null;
    }
    return abs;
  } catch {
    return null;
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
              status: 'pending',
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
              status: 'pending',
              cmdKey: deriveCommandKey(tc),
            }
          };
          broadcast(wss, pushMsg);
        }

        // 設定とポリシーを確認
        const settingsPath = path.join(__dirname, 'mnt', 'settings.json');
        let yolo = true; let allowAlways = []; let denyAlways = [];
        try {
          const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
          const json = JSON.parse(raw || '{}');
          yolo = Boolean(json?.tools?.yolo ?? true);
          allowAlways = Array.isArray(json?.tools?.allowAlways) ? json.tools.allowAlways : [];
          denyAlways = Array.isArray(json?.tools?.denyAlways) ? json.tools.denyAlways : [];
        } catch {}

        const cmdKey = deriveCommandKey(tc);
        const opts = msg.params?.options || [];
        const allowOnce = opts.find(o => o.kind === 'allow_once') || opts.find(o => o.optionId === 'proceed_once') || opts[0];
        const denyOpt = opts.find(o => o.kind === 'deny') || opts.find(o => o.optionId === 'cancel');

        function respondAllowed() {
          const optionId = allowOnce?.optionId || 'proceed_once';
          acpRespond(msg.id, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId } });
          acpProvideSelected(optionId);
        }
        function respondDenied() {
          if (denyOpt?.optionId) {
            acpRespond(msg.id, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
            acpProvideSelected(denyOpt.optionId);
            return;
          }
          acpRespond(msg.id, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
        }

        if (denyAlways.includes(cmdKey)) {
          respondDenied();
          if (tc?.toolCallId) {
            const idx = findLastToolHistoryIndex(tc.toolCallId);
            if (idx !== -1) { history[idx].status = 'error'; history[idx].updatedTs = Date.now(); }
            broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: tc.toolCallId, status: 'error' } });
          }
          break;
        }
        if (allowAlways.includes(cmdKey)) {
          respondAllowed();
          if (tc?.toolCallId) {
            const idx = findLastToolHistoryIndex(tc.toolCallId);
            if (idx !== -1) { history[idx].status = 'running'; history[idx].updatedTs = Date.now(); }
            broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: tc.toolCallId, status: 'running' } });
          }
          break;
        }
        if (yolo) {
          respondAllowed();
          if (tc?.toolCallId) {
            const idx = findLastToolHistoryIndex(tc.toolCallId);
            if (idx !== -1) { history[idx].status = 'running'; history[idx].updatedTs = Date.now(); }
            broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: tc.toolCallId, status: 'running' } });
          }
          break;
        }

        // 待機: クライアントからconfirmToolCallを待つ
        permissionWaiters.set(tc.toolCallId, { requestId: msg.id, options: { allowOnce, denyOpt }, cmdKey });
        // 何もしない（ユーザの応答を待つ）
        break;
      }
      case 'confirmToolCall': {
        const { toolCallId, result, mode } = msg.params || {};
        const waiter = permissionWaiters.get(toolCallId);
        if (!waiter) return; // nothing to do
        permissionWaiters.delete(toolCallId);
        const { requestId, options, cmdKey } = waiter;
        const allowOnce = options?.allowOnce;
        const denyOpt = options?.denyOpt;

        if (mode === 'allow_always' || mode === 'deny_always') {
          try {
            const settingsPath = path.join(__dirname, 'mnt', 'settings.json');
            const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
            const json = JSON.parse(raw || '{}');
            json.tools = json.tools || { yolo: true, allowAlways: [], denyAlways: [] };
            if (mode === 'allow_always') {
              if (!json.tools.allowAlways.includes(cmdKey)) json.tools.allowAlways.push(cmdKey);
              // allow this time as well
              const optionId = allowOnce?.optionId || 'proceed_once';
              acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId } });
              acpProvideSelected(optionId);
              broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'running' } });
            } else {
              if (!json.tools.denyAlways.includes(cmdKey)) json.tools.denyAlways.push(cmdKey);
              if (denyOpt?.optionId) acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
              else acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
              if (denyOpt?.optionId) acpProvideSelected(denyOpt.optionId);
              broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'error' } });
            }
            const tmp = settingsPath + '.tmp';
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
            fs.renameSync(tmp, settingsPath);
          } catch (e) {
            console.warn('[Settings] Failed to persist tool policy:', e?.message || e);
          }
          break;
        }

        if (result) {
          const optionId = allowOnce?.optionId || 'proceed_once';
          acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId } });
          broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'running' } });
        } else {
          if (denyOpt?.optionId) acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
          else acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
          broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'error' } });
        }
        break;
      }
      case 'fs/read_text_file': {
        const { path: reqPath, line, limit } = msg.params || {};
        const abs = safeResolveProjectPath(reqPath);
        if (!abs) {
          return acpRespondError(msg.id, -32602, 'Invalid path', 'Path outside project root');
        }
        try {
          const raw = fs.readFileSync(abs, 'utf8');
          let content = raw;
          if (typeof line === 'number' || typeof limit === 'number') {
            const lines = raw.split(/\r?\n/);
            const start = Math.max(0, (typeof line === 'number' ? line - 1 : 0));
            const count = typeof limit === 'number' && limit != null ? Math.max(0, limit) : lines.length - start;
            content = lines.slice(start, start + count).join('\n');
          }
          acpRespond(msg.id, { content });
        } catch (e) {
          acpRespondError(msg.id, -32000, 'File read error', e?.message || String(e));
        }
        break;
      }
      case 'fs/write_text_file': {
        const { path: reqPath, content } = msg.params || {};
        const abs = safeResolveProjectPath(reqPath);
        if (!abs) {
          return acpRespondError(msg.id, -32602, 'Invalid path', 'Path outside project root');
        }
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, String(content ?? ''), 'utf8');
          acpRespond(msg.id, null);
        } catch (e) {
          acpRespondError(msg.id, -32000, 'File write error', e?.message || String(e));
        }
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
    const trimmed = currentAssistantMessage.text.trim();
    const last = history.length > 0 ? history[history.length - 1] : null;
    const isExactDup = last && last.id === currentAssistantMessage.id && last.role === 'assistant' && last.text === trimmed;
    if (!isExactDup) {
      const assistantMessage = {
        id: currentAssistantMessage.id,
        ts: Date.now(),
        role: 'assistant',
        text: trimmed,
      };
      // 1. 履歴に保存する
      history.push(assistantMessage);
      // 2. addMessage で全クライアントに確定したメッセージを通知
      broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: assistantMessage } });
    }
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
    const trimmed = currentAssistantMessage.text.trim();
    const last = history.length > 0 ? history[history.length - 1] : null;
    const isExactDup = last && last.id === currentAssistantMessage.id && last.role === 'assistant' && last.text === trimmed;
    if (!isExactDup) {
      const assistantMessage = {
        id: currentAssistantMessage.id,
        ts: Date.now(),
        role: 'assistant',
        text: trimmed,
      };
      history.push(assistantMessage);
      broadcast(wss, { jsonrpc: '2.0', method: 'addMessage', params: { message: assistantMessage } });
    }
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
          const eff = (rec) => Math.max(Number(rec?.ts ?? 0), Number(rec?.updatedTs ?? 0));
          chunk = chunk.filter(rec => eff(rec) > after).slice(0, limit);
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
        // Mark last pending/running tool as error
        try {
          for (let i = history.length - 1; i >= 0; i--) {
            const rec = history[i];
            if (!rec) continue;
            if ((rec.role === 'tool' || rec.type === 'tool') && (rec.status === 'running' || rec.status === 'pending' || !rec.status)) {
              rec.status = 'error';
              rec.updatedTs = Date.now();
              broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: rec.id, status: 'error' } });
              break;
            }
          }
        } catch {}
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null })); } catch {}
        return;
      }

      if (msg.method === 'confirmToolCall') {
        try {
          const { toolCallId, result, mode } = msg.params || {};
          const waiter = permissionWaiters.get(toolCallId);
          if (!waiter) {
            try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: false, reason: 'not_found' } })); } catch {}
            return;
          }
          permissionWaiters.delete(toolCallId);
          const { requestId, options, cmdKey } = waiter;
          const allowOnce = options?.allowOnce;
          const denyOpt = options?.denyOpt;

          if (mode === 'allow_always' || mode === 'deny_always') {
            try {
              const settingsPath = path.join(__dirname, 'mnt', 'settings.json');
              const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
              const json = JSON.parse(raw || '{}');
              if (!json.tools || typeof json.tools !== 'object') json.tools = { yolo: true, allowAlways: [], denyAlways: [] };
              if (!Array.isArray(json.tools.allowAlways)) json.tools.allowAlways = [];
              if (!Array.isArray(json.tools.denyAlways)) json.tools.denyAlways = [];
              if (mode === 'allow_always') {
                if (!json.tools.allowAlways.includes(cmdKey)) json.tools.allowAlways.push(cmdKey);
                const optionId = allowOnce?.optionId || 'proceed_once';
                acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId } });
                acpProvideSelected(optionId);
                broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'running' } });
              } else {
                if (!json.tools.denyAlways.includes(cmdKey)) json.tools.denyAlways.push(cmdKey);
                if (denyOpt?.optionId) acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
                else acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
                if (denyOpt?.optionId) acpProvideSelected(denyOpt.optionId);
                broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'error' } });
              }
              const tmp = settingsPath + '.tmp';
              fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
              fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
              fs.renameSync(tmp, settingsPath);
            } catch (e) {
              console.warn('[Settings] Failed to persist tool policy:', e?.message || e);
            }
            try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })); } catch {}
            return;
          }

          if (result) {
            const optionId = allowOnce?.optionId || 'proceed_once';
            acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId } });
            acpProvideSelected(optionId);
            broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'running' } });
          } else {
            if (denyOpt?.optionId) acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
            else acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
            if (denyOpt?.optionId) acpProvideSelected(denyOpt.optionId);
            broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'error' } });
          }
          try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })); } catch {}
          return;
        } catch (e) {
          try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: e?.message || String(e) } })); } catch {}
          return;
        }
      }
    });
    ws.on('close', () => console.log('Client disconnected'));
  });

  httpsServer.listen(port, hostname, () => {
    console.log(`> Ready on https://${hostname}:${port}`);
    startGemini(wss);
    // Watch DB file changes and broadcast to clients
    try {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(__dirname, '..', 'study_log.db');
      let dbNotifyTimer = null;
      const scheduleDbNotify = () => {
        if (dbNotifyTimer) return; // debounce: 一度だけまとめて通知
        dbNotifyTimer = setTimeout(() => {
          dbNotifyTimer = null;
          try { broadcast(wss, { jsonrpc: '2.0', method: 'databaseUpdated', params: { ts: Date.now() } }); } catch {}
        }, 250);
      };
      let lastEventId = 0;
      async function fetchAndBroadcastEvents() {
        try {
          const { spawn } = require('child_process');
          const pythonPath = require('path').join(__dirname, '..', 'manage_log.py');
          const payload = { action: 'data.events_since', params: { since: lastEventId, limit: 100 } };
          const proc = spawn('python3', [pythonPath, '--api-mode', 'execute', JSON.stringify(payload)]);
          let out = '';
          proc.stdout.on('data', (c) => out += String(c));
          proc.on('close', () => {
            try {
              const json = JSON.parse(out || '{}');
              const events = Array.isArray(json.events) ? json.events : [];
              for (const ev of events) {
                const payload = { table: ev.table_name, op: ev.op, rowId: ev.row_id, data: ev.snapshot ? JSON.parse(ev.snapshot) : null };
                let method;
                if (ev.table_name === 'study_logs') {
                  method = (ev.op === 'insert' ? 'logCreated' : ev.op === 'update' ? 'logUpdated' : 'logDeleted');
                } else if (ev.table_name === 'goals') {
                  method = (ev.op === 'insert' ? 'goalAdded' : ev.op === 'update' ? 'goalUpdated' : 'goalDeleted');
                } else if (ev.table_name === 'daily_summaries') {
                  method = (ev.op === 'insert' ? 'summaryAdded' : ev.op === 'update' ? 'summaryUpdated' : 'summaryDeleted');
                } else {
                  // Fallback: just broadcast databaseUpdated to force quiet refresh
                  method = 'databaseUpdated';
                }
                broadcast(wss, { jsonrpc: '2.0', method, params: payload });
              }
              if (typeof json.last === 'number') lastEventId = json.last;
            } catch (e) { /* ignore */ }
          });
        } catch {}
      }
      if (fs.existsSync(dbPath)) {
        fs.watchFile(dbPath, { interval: 400 }, (curr, prev) => {
          if (curr && prev && curr.mtimeMs !== prev.mtimeMs) {
            scheduleDbNotify();
            fetchAndBroadcastEvents();
          }
        });
        console.log('[DB Watch] Watching', dbPath);
      } else {
        console.warn('[DB Watch] DB file not found:', dbPath);
      }
    } catch (e) {
      console.warn('[DB Watch] Failed to watch DB:', e?.message || e);
    }
  });

  httpServer.listen(80, hostname, () => {
    console.log(`> HTTP redirect server running on http://${hostname}:80, redirecting to https`);
  });
});
