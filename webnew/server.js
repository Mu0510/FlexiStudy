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
const hostname = process.env.HOST || '0.0.0.0';
// Allow overriding ports via env to avoid EADDRINUSE conflicts
const port = Number(process.env.PORT) || 3000;
const redirectPort = Number(process.env.REDIRECT_PORT) || 8000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// --- Gemini Process Logic ---
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_FLAGS = ['-m', GEMINI_MODEL, '-y', '--experimental-acp'];
const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(__dirname, 'notify', 'config');
const MNT_DIR = path.join(__dirname, 'mnt');

// --- Live config + schedulers state ---
let TRIGGERS = null; // latest parsed triggers.json
let aiPollTimer = null; // setInterval handle for AI polling
let aiPollIntents = ['study_reminder'];
let aiPollIntervalMs = 60 * 60 * 1000;
let cronTimer = null; // setInterval handle for cron ticking
let cronCompiled = []; // compiled cron expressions
const cronLastFired = new Map();
let notifyGraceMs = 3 * 60 * 1000; // default: 3 minutes after last visible turn

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function compileCronExpr(expr) {
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
  try {
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
  } catch { return null; }
}

function cronDomOk(domExpr, day) { if (!domExpr || domExpr === '*') return true; const set = compileCronExpr(`* * ${domExpr} * *`).dom; return set.has(day); }
function cronMonOk(monExpr, mon) { if (!monExpr || monExpr === '*') return true; const set = compileCronExpr(`* * * ${monExpr} *`).mon; return set === monExpr ? true : set.has(mon); }
function cronDowOk(dowExpr, dow) { if (!dowExpr || dowExpr === '*') return true; const set = compileCronExpr(`* * * * ${dowExpr}`).dow; return set === dowExpr ? true : set.has(dow); }

function loadAndApplyTriggers(wss, opts={}) {
  try {
    const triggersPath = path.join(CONFIG_DIR, 'triggers.json');
    const nextTriggers = readJsonSafe(triggersPath, {});
    TRIGGERS = nextTriggers;
    // Grace window after last visible assistant turn
    const graceMin = Number(nextTriggers?.ai_poll?.grace_after_last_turn_minutes || nextTriggers?.grace_after_last_turn_minutes || 0) || 3;
    notifyGraceMs = Math.max(0, graceMin) * 60 * 1000;
    // --- AI poll scheduler ---
    const pollMins = Number(nextTriggers?.ai_poll?.interval_minutes || 0) || 60;
    // Intent types are deprecated; always evaluate one unified 'auto' decision
    aiPollIntents = [];
    const intervalMs = pollMins * 60 * 1000;
    if (aiPollTimer) { clearInterval(aiPollTimer); aiPollTimer = null; }
    aiPollIntervalMs = intervalMs;
    aiPollTimer = setInterval(async () => {
      try {
        // Skip while a visible turn is active
        if (currentAssistantMessage?.id && !suppressNextAssistantBroadcast) return;
        // Enforce grace window after last visible assistant end-of-turn
        if (lastVisibleTurnEndTs && (Date.now() - lastVisibleTurnEndTs) < notifyGraceMs) return;
        const userId = 'local';
        const payload = await runHiddenDecision({ intent: 'auto', context: { userId }, userId });
        if (payload?.decision === 'send' && payload?.notification) {
          persistNotificationLog({ userId, payload });
          try { broadcast(wss, { jsonrpc: '2.0', method: 'notify', params: { notification: payload.notification } }); } catch {}
          await sendPushToUser(userId, payload.notification);
        }
      } catch (e) { console.warn('[Scheduler] notify tick failed:', e?.message || e); }
    }, intervalMs);
    console.log(`[Scheduler] AI poll every ${pollMins} min (mode: auto)`);

    // --- Cron scheduler ---
    if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
    let exprs = nextTriggers?.cron;
    if (!exprs) exprs = [];
    if (typeof exprs === 'string') exprs = [exprs];
    if (!Array.isArray(exprs)) exprs = [];
    cronCompiled = exprs.map(compileCronExpr).filter(Boolean);
    cronLastFired.clear();
    if (cronCompiled.length > 0) {
      cronTimer = setInterval(async () => {
        const now = new Date();
        const key = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
        for (const c of cronCompiled) {
          try {
            if (currentAssistantMessage?.id && !suppressNextAssistantBroadcast) break;
            if (lastVisibleTurnEndTs && (Date.now() - lastVisibleTurnEndTs) < notifyGraceMs) break;
            if (!c.minutes.has(now.getMinutes())) continue;
            if (!c.hours.has(now.getHours())) continue;
            // Day filters
            const domOk = (c.dom === '*' ? true : compileCronExpr(`* * ${c.dom} * *`).dom.has(now.getDate()));
            const monOk = (c.mon === '*' ? true : compileCronExpr(`* * * ${c.mon} *`).mon.has(now.getMonth()+1));
            const dowOk = (c.dow === '*' ? true : compileCronExpr(`* * * * ${c.dow}`).dow.has(now.getDay()));
            if (!(domOk && monOk && dowOk)) continue;
            const last = cronLastFired.get(c.raw);
            if (last === key) continue;
            cronLastFired.set(c.raw, key);
            const userId = 'local';
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
    } else {
      console.log('[Scheduler] Cron disabled');
    }
  } catch (e) {
    console.warn('[Scheduler] load/apply triggers failed:', e?.message || e);
  }
}

// 2. プロセス起動処理の更新
function getGeminiSpawnSpec() {
  // Read model from settings if present; fallback to env/default
  let model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  try {
    const settingsPath = path.join(__dirname, 'mnt', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const json = JSON.parse(raw || '{}');
      const cm = json?.chat?.model;
      if (cm === 'gemini-2.5-pro' || cm === 'gemini-2.5-flash') {
        model = cm;
      }
    }
  } catch {}
  const flags = ['-m', model, '-y', '--experimental-acp'];
  return {
    cmd: 'npx',
    args: ['@google/gemini-cli@0.3.2', ...flags],
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
// Track last visible assistant end-of-turn to delay background notify
let lastVisibleTurnEndTs = 0;

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
  if (head === 'python' || head === 'python3' || head === 'node') {
    // Specialize python invocations running manage_log.py
    if (head === 'python' || head === 'python3') {
      const basename = (p) => {
        try { return String(p).split(/\\\\|\//).pop(); } catch { return String(p); }
      };
      let j = i + 1;
      // Walk flags to find first non-flag arg (script path)
      while (j < tokens.length) {
        const t = tokens[j];
        if (!t) break;
        if (/^-/.test(t)) {
          // module or command mode → treat as generic python
          if (t === '-m' || t === '-c' || t === '--' ) break;
          j++; continue;
        }
        const b = basename(t);
        if (b === 'manage_log.py') return `${head}:manage_log`;
        break;
      }
    }
    return `${head}`;
  }
  return `shell:${head}`;
}

function deriveCommandKey(tc) {
  try {
    const title = String(tc?.title || '');
    const kind = String(tc?.kind || '');
    const locPath = (tc?.locations && tc.locations[0] && tc.locations[0].path) ? String(tc.locations[0].path) : '';
    const hay = `${title} ${locPath}`.toLowerCase();
    // Fast-path: detect python/manage_log from raw strings even when tokenization fails
    if (/python3\s+[^\n]*manage_log\.py/.test(hay) || /manage_log\.py[^\n]*python3/.test(hay)) {
      return 'python3:manage_log';
    }
    if (/\bpython\s+[^\n]*manage_log\.py/.test(hay)) {
      return 'python:manage_log';
    }
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

function pushNormalizedToolHistory({ toolCallId, icon, label, command, status, content, cmdKey }) {
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
    cmdKey: cmdKey || undefined,
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
      try { if (wssGlobal) broadcast(wssGlobal, { jsonrpc: '2.0', method: 'geminiReady', params: { ts: Date.now(), sessionId: acpSessionId } }); } catch {}
      flushPromptQueue();
    } else {
      console.error('[ACP] Failed to create new session, result:', sessionResult);
    }
  } catch (error) {
    console.error('[ACP] Error during initialization or session creation:', error);
  }
}

// Try to recreate a fresh ACP session without restarting the process
async function recreateSessionQuiet() {
  try {
    if (!geminiProcess || !acpSessionId) return false;
    const prev = acpSessionId;
    const res = await acpSend('session/new', { cwd: PROJECT_ROOT, mcpServers: [] });
    if (res?.sessionId) {
      acpSessionId = res.sessionId;
      isSessionReady = true;
      console.log(`[ACP] Recreated session: ${acpSessionId} (prev ${prev})`);
      try { if (wssGlobal) broadcast(wssGlobal, { jsonrpc: '2.0', method: 'geminiReady', params: { ts: Date.now(), sessionId: acpSessionId } }); } catch {}
      return true;
    }
  } catch (e) {
    console.warn('[ACP] recreateSession failed:', e?.message || e);
  }
  return false;
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
        // Some agents send the end state only via RPC result (no session/update end_of_turn).
        // Always flush on session/prompt result. For hidden prompts, broadcasts are suppressed.
        if (pending.method === 'session/prompt') {
          ensureAssistantMessage(wss, Date.now());
          flushAssistantMessage(wss, msg.result?.stopReason);
          if (!suppressNextAssistantBroadcast) {
            try { lastVisibleTurnEndTs = Date.now(); } catch {}
          }
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
          const isPython = (cmdKey === 'python' || cmdKey === 'python3' || cmdKey === 'python:manage_log' || cmdKey === 'python3:manage_log' || cmdKey === 'shell:python3');
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
              cmdKey: deriveCommandKey(tc),
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

          // Provide a best-effort preview before approval if available in the request
          try {
            const pv = (msg.params && (msg.params.preview || msg.params.proposed || msg.params.content)) || (tc && (tc.preview || tc.proposed || tc.content));
            const arr = Array.isArray(pv) ? pv : (pv ? [pv] : []);
            let previewContent = null;
            if (arr.length > 0) {
              const c = arr[0];
              if (c?.type === 'diff') {
                previewContent = { type: 'diff', oldText: c.oldText || '', newText: c.newText || '' };
              } else if (c?.type === 'content' && c?.content?.type === 'text') {
                previewContent = { type: 'markdown', markdown: c.content.text };
              }
            }
            if (previewContent) {
              const idx = findLastToolHistoryIndex(tc.toolCallId);
              if (idx !== -1) { history[idx].content = (previewContent.type === 'diff') ? JSON.stringify(previewContent) : previewContent.markdown; history[idx].updatedTs = Date.now(); }
              broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: tc.toolCallId, status: 'pending', content: previewContent } });
            }
          } catch {}
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
  if (currentAssistantMessage.id && !(suppressNextAssistantBroadcast || hiddenDecisionActive)) {
    broadcast(wss, { jsonrpc: '2.0', method: 'messageCompleted', params: { messageId: currentAssistantMessage.id, stopReason: stopReason || 'end_turn' } });
  }
  
  // 4. 現在のメッセージをリセットする
  currentAssistantMessage = { id: null, text: '', thought: '' };
}

// ツール開始等でターンは閉じずに、現時点の本文のみ確定（addMessage）する
function finalizeAssistantPartial(wss) {
  if (suppressNextAssistantBroadcast || hiddenDecisionActive) {
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
      if (!(suppressNextAssistantBroadcast || hiddenDecisionActive)) {
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
      if (!(suppressNextAssistantBroadcast || hiddenDecisionActive)) {
        broadcast(wss, {
          jsonrpc: '2.0',
          method: 'streamAssistantMessageChunk',
          params: { messageId: currentAssistantMessage.id, chunk: { text: textChunk } }
        });
      }
      break;

    case 'end_of_turn':
      // Ensure there is an assistant message id even if no text chunks were streamed
      ensureAssistantMessage(wss, nowTs);
      flushAssistantMessage(wss, upd.stopReason);
      // If this was a visible assistant turn, record its end time for notify grace
      if (!suppressNextAssistantBroadcast) {
        lastVisibleTurnEndTs = nowTs;
      }
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
        cmdKey: deriveCommandKey({ title: rawLabel, kind: upd.kind, locations: upd.locations || [] }),
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
          cmdKey: deriveCommandKey({ title: rawLabel, kind: upd.kind, locations: upd.locations || [] }),
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
    const oldPid = geminiProcess.pid;
    geminiProcess.once('close', () => {
      geminiProcess = null;
      isRestartingGemini = false;
      _startNewGeminiProcess(wss);
    });
    // Prefer direct kill on the child; fall back to process group
    try {
      geminiProcess.kill('SIGTERM');
    } catch (err) {
      try { process.kill(-oldPid, 'SIGTERM'); } catch (e) {
        console.error(`[Gemini Process] Failed to SIGTERM pid ${oldPid}: ${e.message}`);
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
      // Fallback: if still no 'close' fired, hard spawn a new process
      if (geminiProcess && !geminiProcess.killed) {
        try { console.warn('[Gemini Process] close not received; forcing new process spawn'); } catch {}
        try { _startNewGeminiProcess(wss); } catch {}
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
  // Respect force mode (testing) before applying early guards
  const forceCtx = Boolean(context && (context.force || context.force_send));
  // Early guard: skip notify while a study session is actively running (excluding BREAK)
  if (!forceCtx) {
    try {
      const payload = JSON.stringify({ action: 'session.active', params: {} });
      const cp = require('child_process').spawnSync('python3', ['manage_log.py', '--api-mode', 'execute', payload], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      if (cp && cp.status === 0) {
        try {
          const info = JSON.parse(cp.stdout || '{}');
          if (info && info.active === true) {
            return { decision: 'skip', reason: 'active_session', notification: null };
          }
        } catch {}
      }
    } catch {}
  }
  // Load configs
  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  const policy = readJson(path.join(CONFIG_DIR, 'policy.json'), {});
  // Intents/types are deprecated; keep triggers and policy
  const triggers = readJson(path.join(CONFIG_DIR, 'triggers.json'), {});
  // Load system prompt (optional)
  let systemFile = '';
  try { systemFile = fs.readFileSync(path.join(CONFIG_DIR, 'prompt.system.txt'), 'utf8'); } catch {}
  const nowIso = new Date().toISOString();
  let baseSystem = systemFile && systemFile.trim().length > 0 ? systemFile : [
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
  const forceMode = Boolean(context && (context.force || context.force_send));
  if (forceMode) {
    baseSystem += '\n\n[強制モード指示]\n' +
      '今はテスト目的です。context.force=true の場合は、ポリシーや頻度ガードに関わらず、必ず decision を "send" とし、intent_id と notification を生成してください。' +
      ' title/body は適切に短く（title<=40, body<=120）、ユーザーに有益な内容を日本語で具体的に書きます。' +
      ' action_url はインテントの cta_url または "/" を用い、tag/category は意図に沿う値を設定します。' +
      ' 出力は純粋なJSONのみです。';
  }

  // Load last notifications for guard/evidence (exclude test-sends)
  const notifLogPath = path.join(MNT_DIR, 'notifications.json');
  let lastNotifications = [];
  try {
    const raw = fs.existsSync(notifLogPath) ? fs.readFileSync(notifLogPath, 'utf8') : '[]';
    const arr = JSON.parse(raw || '[]');
    lastNotifications = (Array.isArray(arr) ? arr : [])
      .filter(n => n && n.userId === userId && !n.test)
      .slice(-20);
  } catch {}

  const user = { now: nowIso, policy, triggers, lastNotifications, context: context || {} };

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
    // Safety timeout: still prefer end_of_turn, but resolve after 45s if it never arrives
    setTimeout(async () => {
      try {
        // Send an interrupt (same意図 as front-end cancel) and flush as canceled
        try { await acpSend('session/cancel', { sessionId: acpSessionId }); } catch {}
        try { if (wssGlobal) flushAssistantMessage(wssGlobal, 'canceled'); } catch {}
      } finally {
        try { resolve({ text: '' }); } catch {}
      }
    }, 45000);
  }).finally(() => {
    hiddenDecisionActive = false;
    try { if (wssGlobal) broadcast(wssGlobal, { jsonrpc: '2.0', method: 'notifyBusy', params: { active: false } }); } catch {}
  });

  function parseDecisionText(raw) {
    try {
      if (!raw) return null;
      let s = String(raw).trim();

      // 1) Explicit code fence block first (```json ... ``` or ``` ... ```)
      const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fence && fence[1]) {
        const inner = fence[1].trim();
        try { return JSON.parse(inner); } catch {}
      }

      // 2) No fence: try direct JSON
      try { return JSON.parse(s); } catch {}

      // 3) Try from first '{' to last '}' (common for minor prefix/suffix noise)
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const sub = s.slice(start, end + 1);
        try { return JSON.parse(sub); } catch {}
      }

      // 4) Generic regex fallback (least strict)
      const m = s.match(/{[\s\S]*}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      return null;
    } catch { return null; }
  }
  let data = parseDecisionText(result && result.text);
  let payload = data && typeof data === 'object' ? data : { decision: 'skip', reason: 'invalid_json' };
  if (payload.reason === 'invalid_json') {
    try {
      console.warn('[Notify] invalid_json: raw assistant text length=', String(result && result.text ? result.text.length : 0));
    } catch {}
  }

  const force = Boolean((user && user.context && user.context.force) || (user && user.force_send));

  // Final server-side guardrails (quiet hours, caps, dedupe)
  try {
    if (force) throw new Error('skip_guardrails');
    const qh = String(policy.quiet_hours || '').trim();
    const [h1, h2] = qh.split('-');
    const hourNow = new Date(nowIso).getHours();
    let isQuiet = false;
    const toHour = (s) => { const n = Number(String(s || '').trim()); return isFinite(n) ? Math.min(23, Math.max(0, n)) : null; };
    const q1 = toHour(h1), q2 = toHour(h2);
    if (q1 !== null && q2 !== null) { if (q1 <= q2) isQuiet = (hourNow >= q1 && hourNow < q2); else isQuiet = (hourNow >= q1 || hourNow < q2); }

    const tag = payload?.notification?.tag || 'general';
    const cta = payload?.notification?.action_url || '/';
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
      if (isQuiet) payload = { decision: 'skip', reason: 'quiet_hours' };
      else if (caps && countToday >= caps) payload = { decision: 'skip', reason: 'daily_cap' };
      else if (sameTagRecent) payload = { decision: 'skip', reason: 'dedupe_window' };
    }
  } catch {}
  if (force) {
    try {
      const tag = payload?.notification?.tag || 'test';
      const cta = payload?.notification?.action_url || '/';
      const cat = payload?.notification?.category || 'engagement';
      const notif = payload?.notification || { title: 'テスト通知', body: 'これはテスト用に強制生成された通知です。', action_url: cta, tag, category: cat };
      return { decision: 'send', reason: (payload?.reason || 'force_send'), notification: notif };
    } catch {
      return { decision: 'send', reason: 'force_send', notification: { title: 'テスト通知', body: 'これはテスト用に強制生成された通知です。', action_url: '/', tag: 'test', category: 'engagement' } };
    }
  }

  return payload;
}


function persistNotificationLog({ userId, payload, test }) {
  try {
    fs.mkdirSync(MNT_DIR, { recursive: true });
    const p = path.join(MNT_DIR, 'notifications.json');
    const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '[]';
    const arr = Array.isArray(JSON.parse(raw || '[]')) ? JSON.parse(raw || '[]') : [];
    const tag = payload?.notification?.tag || 'general';
    arr.push({ userId, tag, sentAt: Date.now(), payload, test: Boolean(test) });
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
      if (req.method === 'POST' && pathname === '/api/chat/restart') {
        try {
          history.length = 0;
          broadcast(wss, { jsonrpc: '2.0', method: 'historyCleared', params: { reason: 'model-change' } });
          try { broadcast(wss, { jsonrpc: '2.0', method: 'geminiRestarting', params: { ts: Date.now() } }); } catch {}
          const prevSession = acpSessionId;
          startGemini(wss);
          setTimeout(async () => {
            if (acpSessionId === prevSession) {
              await recreateSessionQuiet();
            }
          }, 2000);
          res.statusCode = 200; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 500; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      }
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
            const { userId = 'local', notification, test } = JSON.parse(body || '{}');
            if (!notification || typeof notification !== 'object') throw new Error('invalid notification');
            persistNotificationLog({ userId, payload: { decision: 'send', notification }, test });
            try { broadcast(wss, { jsonrpc: '2.0', method: 'notify', params: { notification } }); } catch {}
            await sendPushToUser(userId, notification);
            res.statusCode = 200; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      // Admin: get today's count and cap for a user
      if (req.method === 'GET' && pathname === '/api/notify/admin/today-count') {
        try {
          const userId = (query && (query.userId || query.user_id)) || 'local';
          const p = path.join(MNT_DIR, 'notifications.json');
          const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '[]';
          const arr = Array.isArray(JSON.parse(raw || '[]')) ? JSON.parse(raw || '[]') : [];
          const today = new Date().toDateString();
          let count = 0;
          for (const n of arr) {
            if (!n || n.userId !== userId || n.test) continue;
            const ts = Number(n.sentAt || 0);
            if (!ts) continue;
            const d = new Date(ts);
            if (d.toDateString() === today) count++;
          }
          // load cap from policy
          let cap = null;
          try {
            const policy = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'policy.json'), 'utf8')) || {};
            cap = Number(policy.caps_per_day || 0) || 0;
          } catch {}
          res.statusCode = 200; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: true, userId, count, cap }));
        } catch (e) {
          res.statusCode = 500; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      }

      // Admin: reset today's notification count for a user (mark test=true)
      if (req.method === 'POST' && pathname === '/api/notify/admin/reset-today-count') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const { userId = 'local' } = JSON.parse(body || '{}');
            const p = path.join(MNT_DIR, 'notifications.json');
            const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '[]';
            const arr = Array.isArray(JSON.parse(raw || '[]')) ? JSON.parse(raw || '[]') : [];
            const today = new Date().toDateString();
            let changed = false;
            for (const n of arr) {
              if (!n || n.userId !== userId) continue;
              const ts = Number(n.sentAt || 0);
              if (!ts) continue;
              const d = new Date(ts);
              if (d.toDateString() === today && !n.test) { n.test = true; changed = true; }
            }
            if (changed) fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
            res.statusCode = 200; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true, changed }));
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
    const hostHeader = String(req.headers.host || '');
    // Extract hostname only (strip any :port)
    const hostOnly = hostHeader.split(':')[0] || 'localhost';
    const httpsUrl = `https://${hostOnly}:${port}${req.url}`;
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
        console.log('[Server] Received clearHistory. Restarting Gemini process.');
        history.length = 0;
        broadcast(wss, { jsonrpc: '2.0', method: 'historyCleared', params: { reason: 'command' } });
        try { broadcast(wss, { jsonrpc: '2.0', method: 'geminiRestarting', params: { ts: Date.now() } }); } catch {}
        const prevSession = acpSessionId;
        startGemini(wss);
        // Fallback: if restart doesn't produce a new session quickly, recreate session
        setTimeout(async () => {
          if (acpSessionId === prevSession) {
            const ok = await recreateSessionQuiet();
            if (!ok) {
              try { console.warn('[ACP] Fallback recreateSession failed'); } catch {}
            }
          }
        }, 2000);
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
          await acpSend('session/cancel', { sessionId: acpSessionId });
        } catch (e) {
          console.log('[ACP] session/cancel not available or failed:', e?.message || e);
        }
        // Ensure any in-flight thought bubble on clients is cleared immediately
        try { broadcast(wss, { jsonrpc: '2.0', method: 'clearActiveThought' }); } catch {}
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

  httpServer.listen(redirectPort, hostname, () => {
    console.log(`> HTTP redirect server running on http://${hostname}:${redirectPort}, redirecting to https`);
  });

  // Initialize and watch notification triggers for hot-reload
  loadAndApplyTriggers(wss);
  try {
    const triggersPath = path.join(CONFIG_DIR, 'triggers.json');
    const dir = CONFIG_DIR;
    let debounceTimer = null;
    const kick = (why) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[Scheduler] Reloading triggers due to: ${why}`);
        loadAndApplyTriggers(wss);
      }, 200);
    };
    // Watch directory for changes and replacements
    fs.watch(dir, { persistent: true }, (eventType, filename) => {
      if (!filename) return;
      if (String(filename) === 'triggers.json') {
        kick(eventType || 'change');
      }
    });
    // Also watch the file directly for editors that do in-place writes
    try { fs.watch(triggersPath, { persistent: true }, () => kick('change')); } catch {}
    console.log('[Scheduler] Watching triggers.json for changes');
  } catch (e) {
    console.warn('[Scheduler] Failed to watch triggers.json:', e?.message || e);
  }
});
