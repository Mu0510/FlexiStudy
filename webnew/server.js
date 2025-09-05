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
const CONFIG_DIR = path.join(__dirname, 'notify', 'config');
const MNT_DIR = path.join(__dirname, 'mnt');

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
// Hidden-prompt support: suppress broadcast/history for the next assistant turn
let suppressNextAssistantBroadcast = false;
// Waiters that resolve with the next assistant final text (used by hidden prompts)
const assistantTurnWaiters = [];
// Whether a hidden notification decision turn is running (blocks user sends)
let hiddenDecisionActive = false;
// Global reference to WebSocket server for out-of-scope broadcasts
let wssGlobal = null;
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
        const tc = msg.params?.toolCall;
        // Hidden decision mode: silently allow only safe, deny others; never broadcast
        if (suppressNextAssistantBroadcast && tc) {
          // Derive a safe allowlist: python/python3 calling manage_log.py only
          const cmdKey = deriveCommandKey(tc);
          const rawLabel = tc.title || String(tc.kind || 'tool');
          const locPath = (tc.locations && tc.locations[0] && tc.locations[0].path) ? String(tc.locations[0].path) : '';
          const raw = (locPath || rawLabel || '').toLowerCase();
          const isPython = (cmdKey === 'python' || cmdKey === 'shell:python3' || cmdKey === 'python3');
          const allowed = isPython && raw.includes('manage_log.py');
          const opts = msg.params?.options || [];
          const allowOnce = opts.find(o => o.kind === 'allow_once') || opts.find(o => o.optionId === 'proceed_once') || opts[0];
          const denyOpt = opts.find(o => o.kind === 'deny') || opts.find(o => o.optionId === 'cancel');
          if (allowed) {
            const optionId = allowOnce?.optionId || 'proceed_once';
            acpRespond(msg.id, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId } });
            acpProvideSelected(optionId);
          } else {
            if (denyOpt?.optionId) acpRespond(msg.id, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
            else acpRespond(msg.id, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
            if (denyOpt?.optionId) acpProvideSelected(denyOpt.optionId);
          }
          break;
        }

        // ツールカード描画前に、進行中の本文を確定（ターンは閉じない）
        finalizeAssistantPartial(wss);
        // ツール実行の許可要求の段階で、ツールカードを作成・履歴へ永続化しておく（tool_call が来ないケースがあるため）
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
    // hidden-prompt モードでは履歴保存・ブロードキャストを抑制し、待機者にのみ返す
    if (suppressNextAssistantBroadcast) {
      try {
        while (assistantTurnWaiters.length) {
          const resolve = assistantTurnWaiters.shift();
          try { resolve({ text: trimmed, stopReason: stopReason || 'end_turn' }); } catch {}
        }
      } finally {
        suppressNextAssistantBroadcast = false;
      }
    } else {
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
  }

  // 3. messageCompleted でストリームの終了を通知する
  if (currentAssistantMessage.id && !suppressNextAssistantBroadcast) {
    broadcast(wss, { jsonrpc: '2.0', method: 'messageCompleted', params: { messageId: currentAssistantMessage.id, stopReason: stopReason || 'end_turn' } });
  }
  
  // 4. 現在のメッセージをリセットする
  currentAssistantMessage = { id: null, text: '', thought: '' };
}

// ツール開始等でターンは閉じずに、現時点の本文のみ確定（addMessage）する
function finalizeAssistantPartial(wss) {
  if (suppressNextAssistantBroadcast) {
    // Do not publish partials for hidden prompts
    currentAssistantMessage = { id: null, text: '', thought: '' };
    return;
  }
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
      if (!suppressNextAssistantBroadcast) {
        broadcast(wss, {
          jsonrpc: '2.0',
          method: 'streamAssistantMessageChunk',
          params: {
            messageId: currentAssistantMessage.id,
            chunk: { thought: thoughtChunk }
          }
        });
      }
      break;

    case 'agent_message_chunk':
      ensureAssistantMessage(wss, nowTs);
      const textChunk = upd.content?.type === 'text' ? upd.content.text : '';
      currentAssistantMessage.text += textChunk;
      if (!suppressNextAssistantBroadcast) {
        broadcast(wss, {
          jsonrpc: '2.0',
          method: 'streamAssistantMessageChunk',
          params: { messageId: currentAssistantMessage.id, chunk: { text: textChunk } }
        });
      }
      break;

    case 'end_of_turn':
      flushAssistantMessage(wss, upd.stopReason);
      break;

    case 'tool_call': {
      if (suppressNextAssistantBroadcast) {
        // Hidden prompt: suppress tool visuals and partial finalize
        return;
      }
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
      if (suppressNextAssistantBroadcast) {
        return;
      }
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

// --- Notify helpers (shared) ---
async function runHiddenDecision({ intent, context, userId }) {
  // Load configs
  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  const policy = readJson(path.join(CONFIG_DIR, 'policy.json'), {});
  const intents = readJson(path.join(CONFIG_DIR, 'intents.json'), {});
  const triggers = readJson(path.join(CONFIG_DIR, 'triggers.json'), {});
  // Load system prompt (optional)
  let systemFile = '';
  try { systemFile = fs.readFileSync(path.join(CONFIG_DIR, 'prompt.system.txt'), 'utf8'); } catch {}
  const nowIso = new Date().toISOString();
  const baseSystem = systemFile && systemFile.trim().length > 0 ? systemFile : [
    'あなたは学習支援アプリの通知プランナー兼意思決定エージェントです。',
    '目的: 現在の状況と設定に基づいて、1件の通知を「送る/送らない」を判断し、必要なら文面を組み立てます。',
    '厳守事項:',
    '- 出力はJSONのみ。プレーンテキストや前置きは一切禁止。',
    '- title<=40文字, body<=120文字, 日本語、落ち着いた励ましトーン。',
    '- 個人名や機微な得点などは含めない。',
    '- 静音時間/頻度/重複を避ける判断が必要であればreasonに根拠を書く。',
    '出力スキーマ:',
    '{"decision":"send|skip","reason":"string","intent_id":"string|null","notification":{"title":"...","body":"...","action_url":"/path","tag":"...","category":"..."}|null,"evidence":{"now":"ISO","intent":"string","context":{}}}'
  ].join('\n');

  // Load last notifications for guard/evidence
  const notifLogPath = path.join(MNT_DIR, 'notifications.json');
  let lastNotifications = [];
  try {
    const raw = fs.existsSync(notifLogPath) ? fs.readFileSync(notifLogPath, 'utf8') : '[]';
    const arr = JSON.parse(raw || '[]');
    lastNotifications = (Array.isArray(arr) ? arr : []).filter(n => n && n.userId === userId).slice(-20);
  } catch {}

  const user = { now: nowIso, intent: intent || 'auto', policy, intents, triggers, lastNotifications, context: context || {} };

  // Enqueue hidden prompt and await the assistant's final text
  const promptText = `${baseSystem}\n\n[入力]\n${JSON.stringify(user)}`;
  const result = await new Promise((resolve, reject) => {
    hiddenDecisionActive = true;
    suppressNextAssistantBroadcast = true;
    try { if (wssGlobal) broadcast(wssGlobal, { jsonrpc: '2.0', method: 'notifyBusy', params: { active: true } }); } catch {}
    assistantTurnWaiters.push(resolve);
    try {
      if (isSessionReady && acpSessionId) {
        acpSend('session/prompt', { sessionId: acpSessionId, prompt: [{ type: 'text', text: promptText }] })
          .catch(e => reject(e));
      } else {
        pendingPrompts.push({ text: promptText, messageId: `hidden-${Date.now()}` });
        // Fallback: wait a short time then reject if no session
        setTimeout(() => reject(new Error('ACP session not ready')), 1500);
      }
    } catch (e) { reject(e); }
    // Safety timeout
    setTimeout(() => { try { resolve({ text: '' }); } catch {} }, 8000);
  }).finally(() => {
    hiddenDecisionActive = false;
    try { if (wssGlobal) broadcast(wssGlobal, { jsonrpc: '2.0', method: 'notifyBusy', params: { active: false } }); } catch {}
  });

  function parseDecisionText(raw) {
    try {
      if (!raw) return null;
      let s = String(raw).trim();
      // strip code fences if present
      s = s.replace(/^\s*```json\s*/i, '').replace(/^\s*```\s*/i, '');
      s = s.replace(/\s*```\s*$/, '');
      try { return JSON.parse(s); } catch {}
      // try largest brace substring
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const sub = s.slice(start, end + 1);
        try { return JSON.parse(sub); } catch {}
      }
      // generic fallback with regex
      const m = s.match(/{[\s\S]*}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      return null;
    } catch { return null; }
  }
  let data = parseDecisionText(result && result.text);
  let payload = data && typeof data === 'object' ? data : { decision: 'skip', reason: 'invalid_json' };

  // Final server-side guardrails (quiet hours, caps, dedupe)
  try {
    const qh = String(policy.quiet_hours || '').trim();
    const [h1, h2] = qh.split('-');
    const hourNow = new Date(nowIso).getHours();
    let isQuiet = false;
    const toHour = (s) => { const n = Number(String(s || '').trim()); return isFinite(n) ? Math.min(23, Math.max(0, n)) : null; };
    const q1 = toHour(h1), q2 = toHour(h2);
    if (q1 !== null && q2 !== null) { if (q1 <= q2) isQuiet = (hourNow >= q1 && hourNow < q2); else isQuiet = (hourNow >= q1 || hourNow < q2); }

    const intentsMap = intents || {};
    const chosen = payload?.intent_id && intentsMap[payload.intent_id] ? intentsMap[payload.intent_id] : null;
    const tag = payload?.notification?.tag || (chosen?.tag) || 'general';
    const cta = payload?.notification?.action_url || (chosen?.cta_url) || '/';
    if (payload?.notification) { payload.notification.tag = tag; payload.notification.action_url = cta; }

    const dedupeMin = Number(policy?.dedupe_window_minutes || 0);
    const caps = Number(policy?.caps_per_day || 0);
    const nowMs = Date.now();
    let sameTagRecent = false; let countToday = 0;
    const todayStr = new Date().toDateString();
    for (const n of lastNotifications) {
      const ts = Number(n.sentAt || 0);
      if (dedupeMin && tag && n.tag === tag && (nowMs - ts) < dedupeMin * 60 * 1000) sameTagRecent = true;
      if (ts) { const d = new Date(ts); if (d.toDateString() === todayStr) countToday++; }
    }
    if (payload.decision === 'send') {
      if (chosen?.guardrails?.avoid_quiet_hours && isQuiet) payload = { decision: 'skip', reason: 'quiet_hours' };
      else if (caps && countToday >= caps) payload = { decision: 'skip', reason: 'daily_cap' };
      else if (sameTagRecent) payload = { decision: 'skip', reason: 'dedupe_window' };
    }
  } catch {}
  return payload;
}

function persistNotificationLog({ userId, payload }) {
  try {
    fs.mkdirSync(MNT_DIR, { recursive: true });
    const p = path.join(MNT_DIR, 'notifications.json');
    const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '[]';
    const arr = Array.isArray(JSON.parse(raw || '[]')) ? JSON.parse(raw || '[]') : [];
    const tag = payload?.notification?.tag || 'general';
    arr.push({ userId, tag, sentAt: Date.now(), payload });
    fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) { console.warn('[Notify] Failed to persist notification log:', e?.message || e); }
}

// Optional web-push support (graceful fallback)
let webpush = null; try { webpush = require('web-push'); } catch {}
function loadVapid() {
  try {
    const envPub = process.env.VAPID_PUBLIC_KEY;
    const envPriv = process.env.VAPID_PRIVATE_KEY;
    const envSub = process.env.VAPID_SUBJECT || 'mailto:notify@flexistudy.app';
    if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv, subject: envSub };
    const p = path.join(MNT_DIR, 'vapid.json');
    if (fs.existsSync(p)) {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (json.publicKey && json.privateKey) return { publicKey: json.publicKey, privateKey: json.privateKey, subject: json.subject || envSub };
    }
  } catch {}
  return null;
}

async function sendPushToUser(userId, notification) {
  try {
    if (!webpush) { return false; }
    const vapid = loadVapid();
    if (!vapid) { return false; }
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    const subsPath = path.join(MNT_DIR, 'push_subscriptions.json');
    const raw = fs.existsSync(subsPath) ? fs.readFileSync(subsPath, 'utf8') : '{}';
    const json = JSON.parse(raw || '{}');
    const list = Array.isArray(json[userId]) ? json[userId] : [];
    if (list.length === 0) return false;
    let anySent = false; const kept = [];
    for (const sub of list) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(notification));
        anySent = true; kept.push(sub);
      } catch (e) {
        const status = e?.statusCode;
        if (!(status === 404 || status === 410)) kept.push(sub);
      }
    }
    try { json[userId] = kept; fs.writeFileSync(subsPath, JSON.stringify(json, null, 2), 'utf8'); } catch {}
    return anySent;
  } catch {
    return false;
  }
}

app.prepare().then(() => {
  const httpsServer = createHttpsServer(httpsOptions, async (req, res) => {
    try {
      const { pathname, query } = parse(req.url, true);
      // Minimal built-in API endpoints (bypass Next routing) -----------------
      if (req.method === 'POST' && pathname === '/api/notify/decide') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const json = body ? JSON.parse(body) : {};
            const { intent, context } = json || {};
            const userId = (context && (context.userId || context.user_id)) || 'local';
            // Avoid running hidden prompt while another visible turn is streaming
            const hasActiveVisible = !!(currentAssistantMessage?.id && !suppressNextAssistantBroadcast);
            if (hasActiveVisible) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              return res.end(JSON.stringify({ ok: false, error: 'busy' }));
            }
            const payload = await runHiddenDecision({ intent, context, userId });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, payload }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/push/vapidPublicKey') {
        const vapid = loadVapid();
        res.statusCode = 200; res.setHeader('Content-Type','application/json');
        return res.end(JSON.stringify({ key: vapid?.publicKey || null }));
      }

      // Store push subscription (minimal)
      if (req.method === 'POST' && pathname === '/api/push/subscribe') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const { userId = 'local', subscription } = JSON.parse(body || '{}');
            if (!subscription || typeof subscription !== 'object') throw new Error('invalid subscription');
            fs.mkdirSync(MNT_DIR, { recursive: true });
            const p = path.join(MNT_DIR, 'push_subscriptions.json');
            const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '{}';
            const json = JSON.parse(raw || '{}');
            if (!json[userId]) json[userId] = [];
            const ep = String(subscription.endpoint || '');
            json[userId] = [ ...json[userId].filter((s) => String(s.endpoint||'') !== ep), subscription ];
            fs.writeFileSync(p, JSON.stringify(json, null, 2), 'utf8');
            res.statusCode = 200; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/push/unsubscribe') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const { userId = 'local', endpoint } = JSON.parse(body || '{}');
            if (!endpoint) throw new Error('missing endpoint');
            fs.mkdirSync(MNT_DIR, { recursive: true });
            const p = path.join(MNT_DIR, 'push_subscriptions.json');
            const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '{}';
            const json = JSON.parse(raw || '{}');
            if (!json[userId]) json[userId] = [];
            json[userId] = json[userId].filter((s) => String(s.endpoint||'') !== String(endpoint));
            fs.writeFileSync(p, JSON.stringify(json, null, 2), 'utf8');
            res.statusCode = 200; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      // Send notification immediately (WS broadcast + log)
      if (req.method === 'POST' && pathname === '/api/notify/send') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const { userId = 'local', notification } = JSON.parse(body || '{}');
            if (!notification || typeof notification !== 'object') throw new Error('invalid notification');
            persistNotificationLog({ userId, payload: { decision: 'send', notification } });
            try { broadcast(wss, { jsonrpc: '2.0', method: 'notify', params: { notification } }); } catch {}
            await sendPushToUser(userId, notification);
            res.statusCode = 200; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      // Fallback to Next handler
      await handle(req, res, { pathname, query });
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
  // expose globally for hidden decision broadcasts
  wssGlobal = wss;

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
        // Block user messages while hidden decision is running
        if (hiddenDecisionActive) {
          try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'notify_busy' } })); } catch {}
          return;
        }
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
                try {
                  const hidx = findLastToolHistoryIndex(toolCallId);
                  if (hidx !== -1) { history[hidx].status = 'running'; history[hidx].updatedTs = Date.now(); }
                } catch {}
                broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'running' } });
              } else {
                if (!json.tools.denyAlways.includes(cmdKey)) json.tools.denyAlways.push(cmdKey);
                if (denyOpt?.optionId) acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
                else acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
                if (denyOpt?.optionId) acpProvideSelected(denyOpt.optionId);
                try {
                  const hidx = findLastToolHistoryIndex(toolCallId);
                  if (hidx !== -1) { history[hidx].status = 'error'; history[hidx].updatedTs = Date.now(); }
                } catch {}
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
            try {
              const hidx = findLastToolHistoryIndex(toolCallId);
              if (hidx !== -1) { history[hidx].status = 'running'; history[hidx].updatedTs = Date.now(); }
            } catch {}
            broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'running' } });
          } else {
            if (denyOpt?.optionId) acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
            else acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
            if (denyOpt?.optionId) acpProvideSelected(denyOpt.optionId);
            try {
              const hidx = findLastToolHistoryIndex(toolCallId);
              if (hidx !== -1) { history[hidx].status = 'error'; history[hidx].updatedTs = Date.now(); }
            } catch {}
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

  // --- Simple scheduler: poll intents and send at most one per tick ---
  try {
    const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
    const triggers = readJson(path.join(CONFIG_DIR, 'triggers.json'), {});
    const pollMins = Number(triggers?.ai_poll?.interval_minutes || 0) || 60;
    const intents = Array.isArray(triggers?.ai_poll?.intents) ? triggers.ai_poll.intents : ['study_reminder'];
    const userId = 'local';
    setInterval(async () => {
      try {
        // Skip if a visible assistant turn is active
        if (currentAssistantMessage?.id && !suppressNextAssistantBroadcast) return;
        for (const intent of intents) {
          const payload = await runHiddenDecision({ intent, context: { userId }, userId });
          if (payload?.decision === 'send' && payload?.notification) {
            persistNotificationLog({ userId, payload });
            try { broadcast(wss, { jsonrpc: '2.0', method: 'notify', params: { notification: payload.notification } }); } catch {}
            await sendPushToUser(userId, payload.notification);
            break; // at most one per tick
          }
        }
      } catch (e) {
        console.warn('[Scheduler] notify tick failed:', e?.message || e);
      }
    }, pollMins * 60 * 1000);
    console.log(`[Scheduler] AI poll every ${pollMins} min, intents: ${intents.join(', ')}`);
  } catch (e) {
    console.warn('[Scheduler] init failed:', e?.message || e);
  }

  // --- Cron scheduler (minimal * or lists or steps) ---
  try {
    const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
    const triggers = readJson(path.join(CONFIG_DIR, 'triggers.json'), {});
    let exprs = triggers?.cron;
    if (!exprs) exprs = [];
    if (typeof exprs === 'string') exprs = [exprs];
    if (!Array.isArray(exprs)) exprs = [];
    const userId = 'local';

    function parsePart(part, min, max) {
      const set = new Set();
      const addRange = (a,b,step=1) => { for (let v=a; v<=b; v+=step) set.add(v); };
      const tokens = String(part || '*').split(',');
      for (const t of tokens) {
        const s = t.trim();
        if (s === '*') { addRange(min, max, 1); continue; }
        const stepM = s.match(/^\*\/(\d+)$/); if (stepM) { const st = Math.max(1, Math.min(max, Number(stepM[1]))); addRange(min, max, st); continue; }
        const rangeM = s.match(/^(\d+)-(\d+)(?:\/(\d+))?$/); if (rangeM) { const a = Math.max(min, Math.min(max, Number(rangeM[1]))); const b = Math.max(min, Math.min(max, Number(rangeM[2]))); const st = Math.max(1, Number(rangeM[3]||1)); addRange(Math.min(a,b), Math.max(a,b), st); continue; }
        const n = Number(s); if (Number.isFinite(n)) { const v = Math.max(min, Math.min(max, n)); set.add(v); continue; }
      }
      return set;
    }

    function compileCron(expr) {
      const parts = String(expr || '* * * * *').trim().split(/\s+/);
      if (parts.length !== 5) return null;
      const [m, h, dom, mon, dow] = parts;
      return {
        minutes: parsePart(m, 0, 59),
        hours: parsePart(h, 0, 23),
        dom: String(dom||'*'),
        mon: String(mon||'*'),
        dow: String(dow||'*'),
        raw: expr,
      };
    }

    const compiled = exprs.map(compileCron).filter(Boolean);
    const lastFired = new Map();

    function domOk(domExpr, day) { if (!domExpr || domExpr === '*') return true; const set = parsePart(domExpr, 1, 31); return set.has(day); }
    function monOk(monExpr, mon) { if (!monExpr || monExpr === '*') return true; const set = parsePart(monExpr, 1, 12); return set.has(mon); }
    function dowOk(dowExpr, dow) { if (!dowExpr || dowExpr === '*') return true; const set = parsePart(dowExpr, 0, 6); return set.has(dow); }

    if (compiled.length > 0) {
      setInterval(async () => {
        const now = new Date();
        const key = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
        for (const c of compiled) {
          try {
            // Skip if a visible assistant turn is active
            if (currentAssistantMessage?.id && !suppressNextAssistantBroadcast) break;
            if (!c.minutes.has(now.getMinutes())) continue;
            if (!c.hours.has(now.getHours())) continue;
            if (!domOk(c.dom, now.getDate())) continue;
            if (!monOk(c.mon, now.getMonth()+1)) continue;
            if (!dowOk(c.dow, now.getDay())) continue;
            const last = lastFired.get(c.raw);
            if (last === key) continue; // already fired this minute
            lastFired.set(c.raw, key);
            const payload = await runHiddenDecision({ intent: 'auto', context: { userId }, userId });
            if (payload?.decision === 'send' && payload?.notification) {
              persistNotificationLog({ userId, payload });
              try { broadcast(wss, { jsonrpc: '2.0', method: 'notify', params: { notification: payload.notification } }); } catch {}
              await sendPushToUser(userId, payload.notification);
            }
          } catch (e) { console.warn('[Cron] error:', e?.message || e); }
        }
      }, 15 * 1000);
      console.log(`[Scheduler] Cron enabled for: ${exprs.join(' | ')}`);
    }
  } catch (e) {
    console.warn('[Cron] init failed:', e?.message || e);
  }
});
