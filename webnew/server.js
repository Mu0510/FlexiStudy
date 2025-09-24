// webnew/server.js

const { createServer: createHttpsServer } = require('https');
const { createServer: createHttpServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline'); // 1. 依存モジュールの追加

if (process.env.NODE_ENV !== 'production') {
  const env = require('dotenv');
  const envMode = process.env.NODE_ENV || 'development';
  const envRoot = path.join(__dirname, '..');
  const envFiles = [
    path.join(envRoot, '.env'),
    path.join(envRoot, `.env.${envMode}`),
    path.join(envRoot, '.env.local'),
    path.join(envRoot, `.env.${envMode}.local`),
    path.join(__dirname, '.env'),
    path.join(__dirname, `.env.${envMode}`),
    path.join(__dirname, '.env.local'),
    path.join(__dirname, `.env.${envMode}.local`),
  ];
  const loadedEnvFiles = [];
  for (const filePath of envFiles) {
    if (!filePath) continue;
    if (!fs.existsSync(filePath)) continue;
    env.config({ path: filePath, override: true });
    loadedEnvFiles.push(filePath);
  }
  if (loadedEnvFiles.length) {
    console.log('[Server] Loaded environment variables from:', loadedEnvFiles.join(', '));
  }
}

const BackgroundGemini = require('./background-gemini');

const dev = process.env.NODE_ENV !== 'production';
const devHttpsOptIn = process.env.ENABLE_DEV_HTTPS === 'true' || process.env.DEV_USE_HTTPS === 'true';
const hostname = process.env.HOST || '0.0.0.0';
const parsedPort = Number(process.env.PORT);
const envPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : null;
const parsedDefaultPort = Number(process.env.DEFAULT_PORT);
const defaultPort = Number.isFinite(parsedDefaultPort) && parsedDefaultPort > 0
  ? parsedDefaultPort
  : (dev ? 3000 : 443);
const portCandidates = buildPortCandidates(envPort, defaultPort);

const httpsOptions = loadHttpsOptions();
const useHttps = Boolean(httpsOptions);

if (!useHttps && envPort !== 443) {
  const securePortIdx = portCandidates.indexOf(443);
  if (securePortIdx !== -1) {
    portCandidates.splice(securePortIdx, 1);
    console.log('[Server] HTTPS not enabled; skipping default secure port 443.');
  }
}

const resolveInitialPort = () => portCandidates.find((candidate) => Number.isFinite(candidate) && candidate > 0);

let port = resolveInitialPort();
if (!Number.isFinite(port) || port <= 0) {
  port = useHttps ? 443 : 3000;
}
let lastSuccessfulPort = Number.isFinite(port) && port > 0 ? port : (useHttps ? 443 : 3000);
const resolvedNextDir = (() => {
  const override = process.env.NEXT_APP_DIR;
  if (!override) {
    return __dirname;
  }
  try {
    const candidate = path.resolve(__dirname, override);
    console.log(`[Server] Using overridden Next.js dir: ${candidate}`);
    return candidate;
  } catch (err) {
    console.warn('[Server] Failed to resolve NEXT_APP_DIR override, falling back to default:', err?.message || err);
    return __dirname;
  }
})();

const app = next({ dev, hostname, port, dir: resolvedNextDir });
const handle = app.getRequestHandler();

// --- Gemini Process Logic ---
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_CLI_VERSION = process.env.GEMINI_CLI_VERSION || '0.5.5';
const GEMINI_CLI_PACKAGE = process.env.GEMINI_CLI_PACKAGE || `@google/gemini-cli@${GEMINI_CLI_VERSION}`;
const GEMINI_NPX_BIN = (process.env.GEMINI_CLI_BIN || 'npx').trim() || 'npx';
const GEMINI_RUN_AS_USER = process.env.GEMINI_RUN_AS_USER || 'geminicli';
const GEMINI_CLI_EXEC_OVERRIDE = (process.env.GEMINI_CLI_EXECUTABLE || process.env.GEMINI_CLI_PATH || '').trim();
const GEMINI_CLI_DISABLE_AUTO_OFFLINE = process.env.GEMINI_CLI_DISABLE_AUTO_OFFLINE === 'true';
let geminiCliPreferOffline = process.env.GEMINI_CLI_PREFER_OFFLINE === 'true';
const PROJECT_ROOT = path.join(__dirname, '..');
let PROJECT_ROOT_REAL = PROJECT_ROOT;
try {
  PROJECT_ROOT_REAL = fs.realpathSync(PROJECT_ROOT);
} catch {}
const CONTEXT_MANAGER_PATH = path.join(__dirname, '..', 'manage_context.py');
const CONFIG_DIR = path.join(__dirname, 'notify', 'config');
const CONFIG_SCHEDULE_DIR = path.join(CONFIG_DIR, 'schedule');
const CONFIG_PROMPTS_DIR = path.join(CONFIG_DIR, 'prompts');
const CONFIG_POLICY_DIR = path.join(CONFIG_DIR, 'policy');
const NOTIFY_TRIGGERS_PATH = path.join(CONFIG_SCHEDULE_DIR, 'triggers.json');
const NOTIFY_POLICY_PATH = path.join(CONFIG_POLICY_DIR, 'rules.json');
const NOTIFY_SYSTEM_PROMPT_PATH = path.join(CONFIG_PROMPTS_DIR, 'notify.system.txt');

[CONFIG_DIR, CONFIG_SCHEDULE_DIR, CONFIG_PROMPTS_DIR, CONFIG_POLICY_DIR].forEach((dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
});
const MNT_DIR = path.join(__dirname, 'mnt');
const SETTINGS_PATH = path.join(MNT_DIR, 'settings.json');

let targetUserIdCache = { user: null, ids: null };

const backgroundGemini = new BackgroundGemini({ projectRoot: PROJECT_ROOT, model: GEMINI_MODEL });
let backgroundDisposed = false;
function disposeBackgroundGemini() {
  if (backgroundDisposed) return;
  backgroundDisposed = true;
  try { backgroundGemini.dispose(); } catch {}
}

function resolveTargetUserIds(username) {
  if (!username) return null;
  if (targetUserIdCache.user === username && targetUserIdCache.ids) {
    return targetUserIdCache.ids;
  }
  try {
    const uidResult = spawnSync('id', ['-u', username], { encoding: 'utf8' });
    if (uidResult?.status !== 0) return null;
    const uid = Number.parseInt((uidResult.stdout || '').trim(), 10);
    if (!Number.isInteger(uid)) return null;
    let gid;
    const gidResult = spawnSync('id', ['-g', username], { encoding: 'utf8' });
    if (gidResult?.status === 0) {
      const parsed = Number.parseInt((gidResult.stdout || '').trim(), 10);
      if (Number.isInteger(parsed)) gid = parsed;
    }
    const ids = { uid, gid };
    targetUserIdCache = { user: username, ids };
    return ids;
  } catch (e) {
    console.warn('[Permissions] Failed to resolve uid/gid for', username, e?.message || e);
    return null;
  }
}

function buildRunAsUserSpec(command, args, options = {}) {
  const targetUser = GEMINI_RUN_AS_USER;
  const spawnOptions = { ...options };
  let resolvedIds = null;
  const ensureIds = () => {
    if (resolvedIds !== null) return resolvedIds;
    resolvedIds = resolveTargetUserIds(targetUser);
    return resolvedIds;
  };

  if (shouldUseSudo(targetUser)) {
    const ids = ensureIds();
    if (ids) {
      return {
        command: 'sudo',
        args: ['-E', '-u', targetUser, command, ...args],
        options: spawnOptions,
      };
    }
    console.warn(`[Server] target user "${targetUser}" unavailable; running without sudo.`);
  }
  if (typeof process.getuid === 'function') {
    try {
      if (process.getuid() === 0 && targetUser) {
        const ids = ensureIds();
        if (ids && Number.isInteger(ids.uid)) {
          spawnOptions.uid = ids.uid;
          if (Number.isInteger(ids.gid)) spawnOptions.gid = ids.gid;
        }
      }
    } catch {}
  }
  return { command, args, options: spawnOptions };
}

function spawnSyncAsTargetUser(command, args, options = {}) {
  const spec = buildRunAsUserSpec(command, args, options);
  return spawnSync(spec.command, spec.args, spec.options);
}

function spawnAsTargetUser(command, args, options = {}) {
  const spec = buildRunAsUserSpec(command, args, options);
  return spawn(spec.command, spec.args, spec.options);
}

function buildPortCandidates(requestedPort, fallbackPort) {
  const candidates = [];
  const addCandidate = (value) => {
    if (!Number.isFinite(value) || value <= 0) return;
    if (candidates.includes(value)) return;
    candidates.push(value);
  };
  addCandidate(requestedPort);
  const fallbackIsCustom = Number.isFinite(fallbackPort) && fallbackPort > 0 && fallbackPort !== 3000;
  if (!fallbackIsCustom) {
    addCandidate(443);
  }
  addCandidate(fallbackPort);
  if (fallbackIsCustom) {
    addCandidate(443);
  }
  addCandidate(3000);
  addCandidate(8443);
  addCandidate(8080);
  return candidates;
}

function buildPortAttemptList() {
  const attempts = [];
  const seen = new Set();
  const add = (value) => {
    if (!Number.isFinite(value)) return;
    if (value < 0) return;
    const key = value === 0 ? '0' : String(value);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(value);
  };
  if (Number.isFinite(lastSuccessfulPort) && lastSuccessfulPort > 0) {
    add(lastSuccessfulPort);
  }
  for (const candidate of portCandidates) {
    add(candidate);
  }
  add(0);
  return attempts;
}

// --- Live config + schedulers state ---
let TRIGGERS = null; // latest parsed triggers.json
let aiPollTimerHandle = null; // setTimeout handle for AI polling
let aiPollResumeTimerHandle = null; // resume handle used when quiet hours suppress polling
let aiPollDefaultIntervalMs = 60 * 60 * 1000;
let aiPollMaxIntervalMs = 8 * 60 * 60 * 1000;
let aiPollNextDueTs = 0;
let cronTimer = null; // setInterval handle for cron ticking
let cronCompiled = []; // compiled cron expressions
const cronLastFired = new Map();
let notifyGraceMs = 3 * 60 * 1000; // default: 3 minutes after last visible turn
let notifyCooldownAnchorTs = 0;
let notifyCooldownUntil = 0;
let notifyCooldownTimer = null;
let pendingNotifyRun = null;
let lastHiddenDecisionEndTs = 0;

const contextEventProcessingQueue = [];
let contextEventProcessingActive = false;
const MAX_CONTEXT_EVENT_RETRIES = 3;
const CONTEXT_EVENT_RETRY_DELAY_MS = 2000;

const AI_POLL_FALLBACK_INTERVAL_MS = 30 * 60 * 1000;
const REMINDER_POLL_INTERVAL_MS = 60 * 1000;
const DAILY_SUMMARY_DEFAULT_TIME = '23:00';

let contextStateCache = {
  activeModeId: 'default',
  manualOverrideModeId: null,
  pending: [],
  updatedAt: 0,
};

let reminderTimerHandle = null;

const reminderProcessingQueue = [];
const reminderProcessingSet = new Set();
let reminderProcessingActive = false;

let dailySummaryTimerHandle = null;
let dailySummaryConfigRaw = undefined;
let dailySummaryNormalizedConfig = null;

function buildContextModeSnapshot(force = false) {
  const state = refreshContextStateCache(force) || {};
  const snapshot = {
    active_mode_id: state.activeModeId || null,
    manual_override_mode_id: state.manualOverrideModeId || null,
    pending: Array.isArray(state.pending) ? state.pending : [],
  };
  const activeModeId = snapshot.active_mode_id;
  if (activeModeId) {
    try {
      const modeRes = runContextManagerSync({ action: 'context.mode_get', params: { mode_id: activeModeId } });
      if (modeRes && modeRes.mode) snapshot.active_mode = modeRes.mode;
    } catch (e) {
      console.warn('[Context] failed to load active mode detail:', e?.message || e);
    }
  }
  return snapshot;
}


const PENDING_SOURCE_MERGE_LIMIT = 4;

function shouldDeferNotify() {
  if (hiddenDecisionActive) return 'hidden_active';
  if (isAIPromptActive) return 'chat_active';
  if (currentAssistantMessage?.id && !suppressNextAssistantBroadcast) return 'assistant_streaming';
  if (notifyCooldownUntil && Date.now() < notifyCooldownUntil) return 'cooldown';
  return null;
}

function scheduleDeferredNotifyCheck() {
  if (!pendingNotifyRun) return;
  const now = Date.now();
  const target = notifyCooldownUntil && notifyCooldownUntil > now ? notifyCooldownUntil : now + 50;
  if (notifyCooldownTimer) clearTimeout(notifyCooldownTimer);
  notifyCooldownTimer = setTimeout(() => {
    notifyCooldownTimer = null;
    maybeRunDeferredNotify();
  }, Math.max(0, target - now));
}

function extendNotifyCooldownFrom(ts) {
  if (!Number.isFinite(ts)) ts = Date.now();
  notifyCooldownAnchorTs = ts;
  notifyCooldownUntil = notifyGraceMs > 0 ? ts + notifyGraceMs : ts;
  if (pendingNotifyRun) scheduleDeferredNotifyCheck();
}

function resetNotifyCooldownWithNewGrace() {
  if (!notifyCooldownAnchorTs) return;
  notifyCooldownUntil = notifyGraceMs > 0 ? notifyCooldownAnchorTs + notifyGraceMs : notifyCooldownAnchorTs;
  if (pendingNotifyRun) scheduleDeferredNotifyCheck();
}

const NOTIFY_SETTINGS_CACHE_MS = 5000;
let notifySettingsCache = { ts: 0, data: {} };
let cachedContextContractEnabled = true;

function readNotifySettings(force = false) {
  const now = Date.now();
  if (!force && now - notifySettingsCache.ts < NOTIFY_SETTINGS_CACHE_MS) {
    return notifySettingsCache.data;
  }
  try {
    const raw = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, 'utf8') : '{}';
    const json = JSON.parse(raw || '{}');
    notifySettingsCache = { ts: now, data: json };
    return json;
  } catch (e) {
    notifySettingsCache = { ts: now, data: {} };
    return {};
  }
}

function refreshNotifyDerivedSettings(force = false) {
  const settings = readNotifySettings(force) || {};
  const maxHoursRaw = settings?.notify?.polling?.max_interval_hours;
  const maxHours = Number(maxHoursRaw);
  if (Number.isFinite(maxHours) && maxHours > 0) {
    const clampHours = Math.min(Math.max(maxHours, 0.25), 24); // between 15 minutes and 24h
    aiPollMaxIntervalMs = clampHours * 60 * 60 * 1000;
  } else {
    aiPollMaxIntervalMs = 8 * 60 * 60 * 1000;
  }
  const enabled = settings?.notify?.ai_contracts?.context_events?.enabled;
  cachedContextContractEnabled = enabled !== false;
}

function isContextContractEnabled() {
  return cachedContextContractEnabled;
}

function getBaseAiPollIntervalMs() {
  if (!isContextContractEnabled()) {
    return AI_POLL_FALLBACK_INTERVAL_MS;
  }
  return aiPollDefaultIntervalMs;
}

function refreshContextStateCache(force = false) {
  const now = Date.now();
  if (!force && now - (contextStateCache.updatedAt || 0) < 3000) {
    return contextStateCache;
  }
  try {
    const res = runContextManagerSync({ action: 'context.state_get' });
    if (res && res.state) {
      contextStateCache = {
        activeModeId: res.state.active_mode_id || 'default',
        manualOverrideModeId: res.state.manual_override_mode_id || null,
        pending: Array.isArray(res.pending) ? res.pending : [],
        updatedAt: now,
      };
    }
  } catch (e) {
    console.warn('[Context] failed to refresh state cache:', e?.message || e);
  }
  return contextStateCache;
}

function getActiveContextModeId() {
  return refreshContextStateCache().activeModeId || 'default';
}

function setPendingNotifyRun(request) {
  if (!request) return;
  const now = Date.now();
  const payload = {
    source: request.source || 'scheduler',
    intent: request.intent || 'auto',
    context: request.context || {},
    userId: request.userId || 'local',
    requestedAt: request.requestedAt || now,
  };

  if (!pendingNotifyRun) {
    pendingNotifyRun = payload;
    return;
  }

  // Merge sources/context while keeping the earliest request time.
  pendingNotifyRun.requestedAt = Math.min(pendingNotifyRun.requestedAt || now, payload.requestedAt);
  if (pendingNotifyRun.userId !== payload.userId) pendingNotifyRun.userId = payload.userId;
  pendingNotifyRun.context = { ...(pendingNotifyRun.context || {}), ...(payload.context || {}) };
  if (!pendingNotifyRun.source || typeof pendingNotifyRun.source === 'string') {
    if (pendingNotifyRun.source && payload.source && pendingNotifyRun.source !== payload.source) {
      pendingNotifyRun.source = [pendingNotifyRun.source, payload.source];
    } else if (!pendingNotifyRun.source) {
      pendingNotifyRun.source = payload.source;
    }
  } else if (Array.isArray(pendingNotifyRun.source)) {
    if (payload.source && !pendingNotifyRun.source.includes(payload.source)) {
      pendingNotifyRun.source.push(payload.source);
      if (pendingNotifyRun.source.length > PENDING_SOURCE_MERGE_LIMIT) {
        pendingNotifyRun.source = pendingNotifyRun.source.slice(-PENDING_SOURCE_MERGE_LIMIT);
      }
    }
  }
}

async function processNotifyDecision(request) {
  const intent = request?.intent || 'auto';
  const context = request?.context || {};
  const userId = request?.userId || 'local';
  const payload = await runHiddenDecision({ intent, context, userId });
  const finishedAt = Date.now();
  lastHiddenDecisionEndTs = finishedAt;
  extendNotifyCooldownFrom(finishedAt);

  if (payload && typeof payload === 'object') {
    try {
      persistNotificationLog({
        userId,
        payload,
        decision: payload.decision,
        reason: payload.reason,
        source: request?.source,
        modeId: getActiveContextModeId(),
        context,
        triggeredAt: new Date(finishedAt).toISOString(),
        test: request?.test,
      });
    } catch (e) {
      console.warn('[Notify] Failed to log notification decision:', e?.message || e);
    }
  }

  if (payload?.decision === 'send' && payload?.notification) {
    try { if (wssGlobal) broadcast(wssGlobal, { jsonrpc: '2.0', method: 'notify', params: { notification: payload.notification } }); } catch {}
    try { await sendPushToUser(userId, payload.notification); } catch (err) {
      console.warn('[Scheduler] push delivery failed:', err?.message || err);
    }
  }
  return payload;
}

async function executeNotifyOrDefer(request) {
  const reason = shouldDeferNotify();
  if (reason) {
    setPendingNotifyRun({ ...request, requestedAt: Date.now() });
    if (reason === 'cooldown') scheduleDeferredNotifyCheck();
    return { deferred: true, reason };
  }
  const payload = await processNotifyDecision(request);
  return { deferred: false, payload };
}

function maybeRunDeferredNotify() {
  if (!pendingNotifyRun) return;
  const reason = shouldDeferNotify();
  if (reason) {
    if (reason === 'cooldown') scheduleDeferredNotifyCheck();
    return;
  }
  const request = pendingNotifyRun;
  pendingNotifyRun = null;
  processNotifyDecision(request).catch((e) => {
    console.warn('[Scheduler] Deferred notify failed:', e?.message || e);
  });
}

function formatLocalIso(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (num, len = 2) => String(num).padStart(len, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const millis = pad(d.getMilliseconds(), 3);
  const tzOffsetMinutes = -d.getTimezoneOffset();
  const sign = tzOffsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(tzOffsetMinutes);
  const offsetHours = pad(Math.floor(abs / 60));
  const offsetMinutes = pad(abs % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetMinutes}`;
}

function formatDbTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (num) => String(num).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (num) => String(num).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function cancelAiPollTimer() {
  if (aiPollTimerHandle) {
    clearTimeout(aiPollTimerHandle);
    aiPollTimerHandle = null;
  }
  aiPollNextDueTs = 0;
}

function cancelAiPollResumeTimer() {
  if (aiPollResumeTimerHandle) {
    clearTimeout(aiPollResumeTimerHandle);
    aiPollResumeTimerHandle = null;
  }
}

function scheduleAiPoll(requestedDelayMs) {
  refreshNotifyDerivedSettings();
  const base = getBaseAiPollIntervalMs();
  const desired = Number.isFinite(Number(requestedDelayMs)) && Number(requestedDelayMs) > 0
    ? Number(requestedDelayMs)
    : base;
  const minMs = 30 * 1000; // don't poll too aggressively
  const clampMs = Math.min(Math.max(desired, minMs), aiPollMaxIntervalMs);
  cancelAiPollTimer();
  aiPollNextDueTs = Date.now() + clampMs;
  aiPollTimerHandle = setTimeout(() => {
    runAiPollTick().catch((e) => console.warn('[Scheduler] AI poll tick failed:', e?.message || e));
  }, clampMs);
  const minutes = clampMs / 60000;
  console.log(`[Scheduler] Next AI poll in ${minutes.toFixed(minutes < 1 ? 2 : 1)} min`);
}

function computeQuietResumeDelayMs(now, startHour, endHour) {
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return null;
  if (startHour === endHour) return null; // interpreted as disabled or 24h, skip auto-resume
  const currentHour = now.getHours();
  const baseDate = new Date(now.getTime());
  const setTargetHour = (date, hour) => {
    const target = new Date(date.getTime());
    target.setHours(hour, 0, 0, 0);
    return target;
  };

  const diffMs = (targetDate) => {
    const delta = targetDate.getTime() - now.getTime();
    return delta > 0 ? delta : null;
  };

  if (startHour <= endHour) {
    if (currentHour >= startHour && currentHour < endHour) {
      const todayEnd = setTargetHour(baseDate, endHour);
      let delta = diffMs(todayEnd);
      if (delta === null) {
        const nextDayEnd = setTargetHour(new Date(baseDate.getTime() + 24 * 60 * 60 * 1000), endHour);
        delta = diffMs(nextDayEnd);
      }
      return delta;
    }
    return null;
  }

  // Quiet hours wrap past midnight (e.g., 23-06)
  if (currentHour >= startHour) {
    const nextDayEnd = setTargetHour(new Date(baseDate.getTime() + 24 * 60 * 60 * 1000), endHour);
    return diffMs(nextDayEnd);
  }
  if (currentHour < endHour) {
    const todayEnd = setTargetHour(baseDate, endHour);
    let delta = diffMs(todayEnd);
    if (delta === null) {
      const nextDayEnd = setTargetHour(new Date(baseDate.getTime() + 24 * 60 * 60 * 1000), endHour);
      delta = diffMs(nextDayEnd);
    }
    return delta;
  }
  return null;
}

function scheduleAiPollAfterQuiet(baseIntervalMs, startHour, endHour) {
  const now = new Date();
  const resumeDelay = computeQuietResumeDelayMs(now, startHour, endHour);
  if (!Number.isFinite(resumeDelay) || resumeDelay <= 0) return;
  cancelAiPollResumeTimer();
  const minResumeMs = 5 * 1000;
  const delay = Math.max(resumeDelay, minResumeMs);
  aiPollResumeTimerHandle = setTimeout(() => {
    aiPollResumeTimerHandle = null;
    console.log('[Scheduler] Quiet hours ended, resuming AI poll scheduler.');
    scheduleAiPoll(baseIntervalMs);
  }, delay);
  const minutes = delay / 60000;
  console.log(`[Scheduler] AI poll resume scheduled in ${minutes.toFixed(minutes < 1 ? 2 : 1)} min`);
}

function cancelDailySummaryTimer() {
  if (dailySummaryTimerHandle) {
    clearTimeout(dailySummaryTimerHandle);
    dailySummaryTimerHandle = null;
  }
}

function parseDailySummaryTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const hmMatch = trimmed.match(/^(\d{1,2})(?::?(\d{2}))?$/);
    if (hmMatch) {
      const hour = Number(hmMatch[1]);
      const minute = hmMatch[2] !== undefined ? Number(hmMatch[2]) : 0;
      if (Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60) {
        return { hour, minute };
      }
    }
    if (/^\d{3,4}$/.test(trimmed)) {
      const padded = trimmed.padStart(4, '0');
      const hour = Number(padded.slice(0, -2));
      const minute = Number(padded.slice(-2));
      if (Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60) {
        return { hour, minute };
      }
    }
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const hour = Math.floor(value);
    const minute = Math.round((value - hour) * 60);
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return { hour, minute };
    }
    return null;
  }
  if (typeof value === 'object') {
    const hour = Number(value.hour ?? value.h ?? value.hours);
    const minuteRaw = value.minute ?? value.min ?? value.minutes ?? value.m ?? 0;
    const minute = Number(minuteRaw);
    if (Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60) {
      return { hour, minute };
    }
  }
  return null;
}

function normalizeDailySummaryConfig(config) {
  let source = config;
  if (source === undefined || source === null) source = {};
  if (Array.isArray(source)) {
    source = source.length ? source[0] : {};
  }
  if (typeof source === 'string' || typeof source === 'number') {
    source = { time: source };
  }
  if (!source || typeof source !== 'object') return null;
  if (source.enabled === false) return null;

  let candidate = source.time ?? source.at ?? source.when ?? null;
  if (!candidate && Array.isArray(source.times) && source.times.length) {
    candidate = source.times[0];
  }
  if (!candidate && (source.hour !== undefined || source.hours !== undefined)) {
    candidate = {
      hour: source.hour ?? source.hours,
      minute: source.minute ?? source.min ?? source.minutes ?? source.m ?? 0,
    };
  }
  const parsed = parseDailySummaryTime(candidate) || parseDailySummaryTime(DAILY_SUMMARY_DEFAULT_TIME);
  if (!parsed) return null;
  const pad = (num) => String(num).padStart(2, '0');
  return {
    hour: parsed.hour,
    minute: parsed.minute,
    label: `${pad(parsed.hour)}:${pad(parsed.minute)}`,
  };
}

function computeNextDailySummaryRunDate(hour, minute, base = new Date()) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const now = base instanceof Date ? base : new Date(base);
  const target = new Date(now.getTime());
  target.setSeconds(0, 0);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function scheduleDailySummaryAutomation(config) {
  if (config !== undefined) {
    dailySummaryConfigRaw = config;
  } else if (dailySummaryConfigRaw === undefined) {
    dailySummaryConfigRaw = null;
  }
  cancelDailySummaryTimer();
  const normalized = normalizeDailySummaryConfig(dailySummaryConfigRaw);
  if (!normalized) {
    if (dailySummaryNormalizedConfig) {
      console.log('[Scheduler] Daily summary automation disabled');
    }
    dailySummaryNormalizedConfig = null;
    return;
  }
  dailySummaryNormalizedConfig = normalized;
  const nextRun = computeNextDailySummaryRunDate(normalized.hour, normalized.minute);
  if (!nextRun) {
    console.warn('[Scheduler] Unable to compute next daily summary run time; disabling automation.');
    dailySummaryNormalizedConfig = null;
    return;
  }
  const delayMs = Math.max(0, nextRun.getTime() - Date.now());
  dailySummaryTimerHandle = setTimeout(() => {
    dailySummaryTimerHandle = null;
    runDailySummaryAutomation({ reason: 'scheduled' })
      .catch((e) => console.warn('[DailySummary] automation error:', e?.message || e))
      .finally(() => {
        scheduleDailySummaryAutomation();
      });
  }, delayMs);
  if (dailySummaryTimerHandle && typeof dailySummaryTimerHandle.unref === 'function') {
    dailySummaryTimerHandle.unref();
  }
  console.log(`[Scheduler] Daily summary check scheduled for ${formatLocalIso(nextRun)} (${normalized.label})`);
}

async function runDailySummaryAutomation({ reason = 'manual', targetDate = null } = {}) {
  const now = new Date();
  const runIso = now.toISOString();
  const runLocalIso = formatLocalIso(now);
  let timezone = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    timezone = null;
  }
  const dateStr = targetDate || formatLocalDate(now);

  const callManageLog = (action, params = {}) => {
    try {
      const payload = JSON.stringify({ action, params });
      const cp = spawnSyncAsTargetUser('python3', ['manage_log.py', '--api-mode', 'execute', payload], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
      });
      if (cp.error) throw cp.error;
      if (cp.status !== 0) {
        const errText = (cp.stderr || cp.stdout || '').trim();
        throw new Error(errText || `exit ${cp.status}`);
      }
      const stdout = (cp.stdout || '').trim();
      if (!stdout) return {};
      return JSON.parse(stdout);
    } catch (err) {
      console.warn(`[DailySummary] manage_log action ${action} failed:`, err?.message || err);
      return null;
    }
  };

  const logData = callManageLog('log.get', { date: dateStr });
  if (!logData) {
    console.warn(`[DailySummary] Failed to load study log for ${dateStr}; skipping.`);
    return;
  }
  const allEntries = Array.isArray(logData.all_entries) ? logData.all_entries : [];
  const hasStudyEntries = allEntries.some((entry) => {
    if (!entry || !entry.event_type) return false;
    const type = String(entry.event_type).toUpperCase();
    return type === 'START' || type === 'RESUME';
  });
  if (!hasStudyEntries) {
    console.log(`[DailySummary] Skipping ${dateStr} summary automation (no study entries).`);
    return;
  }

  const dailySummary = logData.daily_summary || {};
  const existingSummary = typeof dailySummary.summary === 'string' ? dailySummary.summary : null;
  const summaryMeta = {
    total_duration: Number(dailySummary.total_duration || logData.total_day_study_minutes || 0) || 0,
    subjects: Array.isArray(dailySummary.subjects)
      ? dailySummary.subjects
      : Array.isArray(logData.subjects_studied)
        ? logData.subjects_studied
        : [],
    goals: Array.isArray(dailySummary.goals) ? dailySummary.goals : [],
  };
  const sessions = Array.isArray(logData.sessions) ? logData.sessions : [];
  const sessionsMissingSummary = sessions
    .filter((session) => {
      if (!session) return false;
      const text = typeof session.summary === 'string' ? session.summary : '';
      return text.trim().length === 0;
    })
    .map((session) => {
      const sessionId = Number(session.session_id);
      if (!Number.isFinite(sessionId)) return null;
      const normalizedDetails = Array.isArray(session.details)
        ? session.details.map((detail) => {
            if (!detail || typeof detail !== 'object') return null;
            const cloned = {
              id: detail.id,
              event_type: detail.event_type,
              content: detail.content,
              start_time: detail.start_time,
              end_time: detail.end_time,
              duration_minutes: detail.duration_minutes,
            };
            if (detail.memo !== undefined) cloned.memo = detail.memo;
            if (detail.impression !== undefined) cloned.impression = detail.impression;
            return cloned;
          }).filter(Boolean)
        : [];
      return {
        session_id: sessionId,
        subject: session.subject,
        summary: session.summary,
        total_study_minutes: session.total_study_minutes,
        session_start_time: session.session_start_time,
        session_end_time: session.session_end_time,
        details: normalizedDetails,
      };
    })
    .filter(Boolean);

  const logCache = new Map();
  logCache.set(dateStr, logData);
  const referenceSummaries = [];
  const searchRes = callManageLog('data.search', { type: 'summary', order: 'newest', limit: 10 });
  if (searchRes && Array.isArray(searchRes.items)) {
    for (const item of searchRes.items) {
      if (!item) continue;
      const refDate = item.date || item.id;
      if (!refDate || refDate === dateStr) continue;
      if (referenceSummaries.some((entry) => entry.date === refDate)) continue;
      let refLog = logCache.get(refDate);
      if (!refLog) {
        refLog = callManageLog('log.get', { date: refDate });
        if (refLog) logCache.set(refDate, refLog);
      }
      const refSummary = refLog?.daily_summary?.summary;
      if (!refSummary) continue;
      referenceSummaries.push({
        date: refDate,
        summary: refSummary,
        total_duration: Number(refLog?.daily_summary?.total_duration || refLog?.total_day_study_minutes || 0) || 0,
        subjects: Array.isArray(refLog?.daily_summary?.subjects)
          ? refLog.daily_summary.subjects
          : Array.isArray(refLog?.subjects_studied)
            ? refLog.subjects_studied
            : [],
      });
      if (referenceSummaries.length >= 5) break;
    }
  }

  const referenceSessionSummaries = [];
  const sessionSearchRes = callManageLog('data.search', { type: 'entry', order: 'newest', limit: 40 });
  if (sessionSearchRes && Array.isArray(sessionSearchRes.items)) {
    for (const item of sessionSearchRes.items) {
      if (!item || item.kind !== 'entry') continue;
      if (referenceSessionSummaries.length >= 5) break;
      const sessionId = Number(item.id);
      if (!Number.isFinite(sessionId)) continue;
      const entryDate = item.date;
      if (!entryDate) continue;
      if (referenceSessionSummaries.some((entry) => entry.session_id === sessionId)) continue;
      let refLog = logCache.get(entryDate);
      if (!refLog) {
        refLog = callManageLog('log.get', { date: entryDate });
        if (refLog) logCache.set(entryDate, refLog);
      }
      const refSessions = Array.isArray(refLog?.sessions) ? refLog.sessions : [];
      const matchedSession = refSessions.find((session) => Number(session?.session_id) === sessionId);
      if (!matchedSession) continue;
      const summaryText = typeof matchedSession.summary === 'string' ? matchedSession.summary.trim() : '';
      if (!summaryText) continue;
      referenceSessionSummaries.push({
        date: entryDate,
        session_id: sessionId,
        subject: matchedSession.subject,
        total_study_minutes: matchedSession.total_study_minutes,
        summary: matchedSession.summary,
        session_start_time: matchedSession.session_start_time,
        session_end_time: matchedSession.session_end_time,
      });
    }
  }

  const payload = {
    kind: 'daily_summary_check',
    reason,
    run_at: runIso,
    run_local: runLocalIso,
    timezone,
    target_date: dateStr,
    existing_summary: existingSummary,
    summary_meta: summaryMeta,
    study_log: {
      total_minutes: Number.isFinite(Number(logData.total_day_study_minutes))
        ? Number(logData.total_day_study_minutes)
        : null,
      subjects: Array.isArray(logData.subjects_studied)
        ? logData.subjects_studied
        : summaryMeta.subjects,
      sessions,
      entries: allEntries,
      sessions_missing_summary: sessionsMissingSummary,
    },
    goals: summaryMeta.goals,
    reference_summaries: referenceSummaries,
    reference_session_summaries: referenceSessionSummaries,
    context_state: buildContextModeSnapshot(),
  };

  const instructions = [
    '[System] 日次サマリーの自動確認ジョブです。あなたはNext.jsサーバー内で動作するバックグラウンドサブプロセスであり、ユーザーからは見えません。',
    '提供されたJSONをもとに対象日の学習記録を確認し、必要に応じて日次サマリーを作成または更新してください。',
    '---',
    JSON.stringify(payload, null, 2),
    '---',
    '出力要件:',
    '- 応答は実行可能なコマンドのみを含めてください。余計な前置きや説明文は不要です。',
    '- study_log.entries に学習イベント（START/RESUME）が存在しない、あるいは有効な学習時間が確認できない場合は何も返さず終了してください。',
    '- 既存サマリーが適切で更新不要なら何も返さないでください。',
    '- 日次サマリーやセッションサマリーを更新する場合は manage_log.py のアクションを直接呼び出す形で返してください。例: summary.daily_update {"date":"YYYY-MM-DD","text":"..."}',
    '- manage_log.pyを直接実行しても構いません。',
    '- 複数の更新が必要な場合は各コマンドを個別の行として列挙してください。JSON形式で {"action": ..., "params": ...} の配列を返しても構いません。',
    '- study_log.sessions_missing_summary に掲載されている各セッションについて、必要に応じて summary.session_update {"session_id":number,"text":"..."} を返し、reference_session_summaries を手がかりに短いインジケーター形式の要約を記録してください。',
    '- 日次サマリーとセッションサマリーが両方必要な場合は同じ応答内でまとめて返してください。',
    '- 文体や構成・分量は reference_summaries および reference_session_summaries を参考にし、対象日の学習内容・目標を反映してください。',
  ];

  enqueueContextEventPrompt(instructions.join('\n'), {
    reason: 'daily_summary',
    timeoutMs: 60000,
    detail: { targetDate: dateStr, referenceCount: referenceSummaries.length },
  });
  console.log(`[DailySummary] Enqueued background check for ${dateStr} (reason=${reason})`);
}

function deriveNextPollDelay(payload) {
  if (!payload || typeof payload !== 'object' || !isContextContractEnabled()) return null;
  const control = payload.control || payload.controls || payload.next_poll || null;
  if (!control || typeof control !== 'object') return null;
  const num = (val) => (val === null || val === undefined ? null : Number(val));
  let seconds = null;
  seconds = num(control.next_poll_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = num(control.next_ping_after_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const mins = num(control.next_poll_minutes ?? control.next_ping_after_minutes);
    if (Number.isFinite(mins) && mins > 0) seconds = mins * 60;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const iso = control.max_idle_until || control.next_poll_after;
    if (iso && typeof iso === 'string') {
      const target = Date.parse(iso);
      if (Number.isFinite(target)) {
        const diffMs = target - Date.now();
        if (diffMs > 0) seconds = diffMs / 1000;
      }
    }
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds * 1000;
  const minMs = 30 * 1000;
  return Math.min(Math.max(ms, minMs), aiPollMaxIntervalMs);
}

async function runAiPollTick() {
  cancelAiPollTimer();
  refreshNotifyDerivedSettings();
  const baseDelay = getBaseAiPollIntervalMs();
  let nextDelay = baseDelay;
  try {
    const userId = 'local';
    const result = await executeNotifyOrDefer({ source: 'ai_poll', intent: 'auto', context: { userId }, userId });
    if (result?.deferred) {
      nextDelay = baseDelay;
    } else if (result?.payload) {
      const derived = deriveNextPollDelay(result.payload);
      if (derived) nextDelay = derived;
    }
  } catch (e) {
    console.warn('[Scheduler] AI poll execution error:', e?.message || e);
    nextDelay = Math.min(baseDelay, 5 * 60 * 1000);
  }
  scheduleAiPoll(nextDelay);
}

function runContextManagerSync(payload) {
  try {
    const args = ['--api-mode', 'execute', JSON.stringify(payload)];
    const cp = spawnSyncAsTargetUser('python3', [CONTEXT_MANAGER_PATH, ...args], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    if (cp.error) throw cp.error;
    if (cp.status !== 0) {
      const errText = cp.stderr || cp.stdout || `exit ${cp.status}`;
      throw new Error(errText.trim());
    }
    const text = (cp.stdout || '').trim();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    console.warn('[Context] sync manager call failed:', e?.message || e);
    return null;
  }
}

function runContextManager(payload) {
  return new Promise((resolve, reject) => {
    try {
      const args = ['--api-mode', 'execute', JSON.stringify(payload)];
      const child = spawnAsTargetUser('python3', [CONTEXT_MANAGER_PATH, ...args], { cwd: PROJECT_ROOT });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(stdout ? JSON.parse(stdout) : {});
          } catch (parseErr) {
            reject(parseErr);
          }
        } else {
          const error = new Error((stderr || stdout || `exit ${code}`).trim());
          reject(error);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

function enqueueContextEventPrompt(text, { reason = 'context_event', timeoutMs = 45000, eventType = null, detail = null } = {}) {
  if (!text) return;
  contextEventProcessingQueue.push({ text, reason, timeoutMs, eventType, detail, retryCount: 0 });
  maybeProcessContextEventQueue();
}

function maybeProcessContextEventQueue() {
  if (!contextEventProcessingQueue.length) return;
  if (contextEventProcessingActive) return;
  if (hiddenDecisionActive) return;
  if (isAssistantStreaming()) return;
  if (isAIPromptActive) return;

  const next = contextEventProcessingQueue.shift();
  if (!next) return;
  contextEventProcessingActive = true;
  runContextEventJob(next)
    .catch((err) => {
      console.warn('[Context] background context job failed:', err?.message || err);
    })
    .finally(() => {
      contextEventProcessingActive = false;
      if (contextEventProcessingQueue.length) {
        maybeProcessContextEventQueue();
      }
    });
}

function scheduleContextEventRetry(job, errorMessage = null) {
  if (!job || job.retryCount === null || job.retryCount === undefined) return false;
  if (job.retryCount >= MAX_CONTEXT_EVENT_RETRIES) return false;
  const nextAttempt = job.retryCount + 1;
  const delayMs = Math.min(CONTEXT_EVENT_RETRY_DELAY_MS * nextAttempt, 15000);
  const cloned = { ...job, retryCount: nextAttempt };
  setTimeout(() => {
    contextEventProcessingQueue.unshift(cloned);
    maybeProcessContextEventQueue();
  }, delayMs);
  const base = `[Context] background context job retry scheduled (${nextAttempt}/${MAX_CONTEXT_EVENT_RETRIES})`;
  if (errorMessage) {
    console.warn(`${base}: ${errorMessage}`);
  } else {
    console.warn(base);
  }
  return true;
}

const CONTEXT_EVENT_ALLOWED_ACTIONS = new Set([
  'context.state_get',
  'context.state_set',
  'context.mode_get',
  'context.mode_list',
  'context.pending_list',
  'context.pending_update',
  'context.pending_create',
  'context.events_recent',
  'ai.reminder_create',
  'ai.reminder_update',
  'context.events_append',
  'summary.daily_update',
  'summary.session_update',
]);

const CONTEXT_EVENT_ACTION_ALIASES = new Map([
  ['contextstateget', 'context.state_get'],
  ['context.state.get', 'context.state_get'],
  ['contextstateset', 'context.state_set'],
  ['context.state.set', 'context.state_set'],
  ['contextactivate', 'context.state_set'],
  ['activatecontext', 'context.state_set'],
  ['contextmodeget', 'context.mode_get'],
  ['context.mode.get', 'context.mode_get'],
  ['contextmodelist', 'context.mode_list'],
  ['context.mode.list', 'context.mode_list'],
  ['contextpendingupdate', 'context.pending_update'],
  ['context.pending.update', 'context.pending_update'],
  ['contextpendingresolve', 'context.pending_update'],
  ['context.pending.resolve', 'context.pending_update'],
  ['contextpendingconfirm', 'context.pending_update'],
  ['context.pending.confirm', 'context.pending_update'],
  ['contextpendingcancel', 'context.pending_update'],
  ['context.pending.cancel', 'context.pending_update'],
  ['contextpendingcreate', 'context.pending_create'],
  ['context.pending.create', 'context.pending_create'],
  ['contextpendinglist', 'context.pending_list'],
  ['context.pending.list', 'context.pending_list'],
  ['airemindercreate', 'ai.reminder_create'],
  ['ai.reminder.create', 'ai.reminder_create'],
  ['remindercreate', 'ai.reminder_create'],
  ['aireminderupdate', 'ai.reminder_update'],
  ['ai.reminder.update', 'ai.reminder_update'],
  ['airemindercancel', 'ai.reminder_update'],
  ['ai.reminder.cancel', 'ai.reminder_update'],
  ['remindercancel', 'ai.reminder_update'],
  ['contexteventsappend', 'context.events_append'],
  ['context.events.append', 'context.events_append'],
  ['contexteventsrecent', 'context.events_recent'],
  ['context.events.recent', 'context.events_recent'],
]);

const MANAGE_LOG_ALLOWED_ACTIONS = new Set([
  'summary.daily_update',
  'summary.session_update',
  'log.get',
  'log.get_entry',
  'session.active',
  'data.dashboard',
  'data.unique_subjects',
  'data.study_time_by_subject',
  'data.weekly_study_time',
  'data.this_week_study_time',
  'data.events_since',
  'data.tags',
  'data.search',
]);

const COMMAND_PREFIX_SKIP_CHARS = new Set([':', '=', '(', ')', '-', '>', '[', ']', ',', ';']);

function runManageLogAction(action, params = {}) {
  const payload = JSON.stringify({ action, params });
  const cp = spawnSyncAsTargetUser('python3', ['manage_log.py', '--api-mode', 'execute', payload], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  if (cp.error) throw cp.error;
  if (cp.status !== 0) {
    const errText = (cp.stderr || cp.stdout || '').trim();
    throw new Error(errText || `exit ${cp.status}`);
  }
  const stdout = (cp.stdout || '').trim();
  if (!stdout) return {};
  return JSON.parse(stdout);
}

function findJsonObjectStart(text, startIndex) {
  if (!text || startIndex >= text.length) return -1;
  let idx = startIndex;
  while (idx < text.length) {
    const ch = text[idx];
    if (ch === '{') return idx;
    if (/\s/.test(ch) || COMMAND_PREFIX_SKIP_CHARS.has(ch)) {
      idx += 1;
      continue;
    }
    break;
  }
  return -1;
}

function extractBalancedJsonBlock(text, jsonStart) {
  if (!text || jsonStart < 0 || jsonStart >= text.length || text[jsonStart] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = jsonStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(jsonStart, i + 1);
      }
    }
  }
  return null;
}

function extractManageLogCommandActions(text) {
  if (!text) return [];
  const trimmed = String(text);
  const actions = [];
  const allowedActionSet = MANAGE_LOG_ALLOWED_ACTIONS || new Set();
  const allowedActions = Array.from(allowedActionSet);

  const pushAction = (action, params) => {
    if (!allowedActionSet.has(action)) return;
    const safeParams = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
    actions.push({ action, params: safeParams });
  };

  for (const action of allowedActions) {
    let searchIndex = 0;
    while (searchIndex < trimmed.length) {
      const found = trimmed.indexOf(action, searchIndex);
      if (found === -1) break;

      let consumed = false;
      let jsonStart = findJsonObjectStart(trimmed, found + action.length);
      if (jsonStart !== -1) {
        const jsonBlock = extractBalancedJsonBlock(trimmed, jsonStart);
        if (jsonBlock) {
          try {
            const params = JSON.parse(jsonBlock);
            pushAction(action, params);
            consumed = true;
            searchIndex = jsonStart + jsonBlock.length;
            continue;
          } catch (err) {
            console.warn(`[Context] Failed to parse ${action} command payload:`, err?.message || err);
          }
        }
      }

      if (!consumed) {
        const backStart = trimmed.lastIndexOf('{', found);
        if (backStart !== -1) {
          const jsonBlock = extractBalancedJsonBlock(trimmed, backStart);
          if (jsonBlock) {
            try {
              const parsed = JSON.parse(jsonBlock);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const nestedAction = parsed.action || parsed.type || null;
                if (nestedAction === action) {
                  const params = (parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params))
                    ? parsed.params
                    : {};
                  pushAction(action, params);
                  consumed = true;
                  searchIndex = backStart + jsonBlock.length;
                  continue;
                }
              }
            } catch (err) {
              console.warn('[Context] Failed to parse manage_log payload:', err?.message || err);
            }
          }
        }
      }

      if (!consumed) {
        searchIndex = found + action.length;
      }
    }
  }

  if (!actions.length) {
    let idx = 0;
    while (idx < trimmed.length) {
      const braceIdx = trimmed.indexOf('{', idx);
      if (braceIdx === -1) break;
      const jsonBlock = extractBalancedJsonBlock(trimmed, braceIdx);
      if (!jsonBlock) break;
      try {
        const parsed = JSON.parse(jsonBlock);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const nestedAction = parsed.action || parsed.type || null;
          if (typeof nestedAction === 'string' && allowedActionSet.has(nestedAction)) {
            const params = (parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params))
              ? parsed.params
              : {};
            pushAction(nestedAction, params);
          }
        }
      } catch {}
      idx = braceIdx + Math.max(jsonBlock.length, 1);
    }
  }

  return actions;
}
function parseContextEventResponseText(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const tryParse = (input) => {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  };

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== null) return parsed;
  }

  const direct = tryParse(text);
  if (direct !== null) return direct;

  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const parsed = tryParse(text.slice(objStart, objEnd + 1));
    if (parsed !== null) return parsed;
  }

  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    const parsed = tryParse(text.slice(arrStart, arrEnd + 1));
    if (parsed !== null) return parsed;
  }

  const commandActions = extractManageLogCommandActions(text);
  if (commandActions.length) return commandActions;

  return null;
}

function normalizeContextEventAction(rawAction) {
  if (!rawAction) return null;
  const lower = String(rawAction).trim().toLowerCase();
  if (!lower) return null;
  const aliasKey = lower.replace(/[^a-z0-9]+/g, '');
  const alias = CONTEXT_EVENT_ACTION_ALIASES.get(aliasKey);
  const candidate = alias || lower.replace(/\s+/g, '').replace(/:+/g, '.').replace(/-+/g, '_').replace(/__+/g, '_').replace(/\.\.+/g, '.');
  if (!CONTEXT_EVENT_ALLOWED_ACTIONS.has(candidate)) return null;
  return candidate;
}

function extractContextEventActionParams(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const preferKeys = ['params', 'arguments', 'args', 'payload', 'data'];
  for (const key of preferKeys) {
    const value = entry[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value };
    }
  }
  const omit = new Set(['action', 'type', 'name', 'command', 'operation', 'op', 'call', 'do', 'intent', 'notes', 'note', 'comment', 'description', 'summary', ...preferKeys]);
  const params = {};
  for (const [key, value] of Object.entries(entry)) {
    if (omit.has(key)) continue;
    if (value === undefined) continue;
    params[key] = value;
  }
  return params;
}

function normalizeContextEventActionEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const action = normalizeContextEventAction(entry);
    if (!action) return null;
    return { action, params: {} };
  }
  if (typeof entry !== 'object') return null;
  let rawAction = entry.action || entry.type || entry.command || entry.operation || entry.op || entry.name || entry.call || entry.do;
  if (rawAction && typeof rawAction === 'object') {
    rawAction = rawAction.action || rawAction.type || rawAction.name;
  }
  const action = normalizeContextEventAction(rawAction);
  if (!action) return null;
  const params = extractContextEventActionParams(entry);
  if (action === 'context.pending_update' && !params.id && entry.id) params.id = entry.id;
  return { action, params };
}

function collectContextEventActions(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return [];
  const actions = [];
  const keys = ['actions', 'commands', 'operations', 'steps', 'tasks', 'queue'];
  for (const key of keys) {
    if (Array.isArray(payload[key])) actions.push(...payload[key]);
  }
  if (!actions.length && (payload.action || payload.command || payload.operation)) actions.push(payload);
  return actions;
}

function applyContextEventControlFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  const envelope = {};
  if (payload.control && typeof payload.control === 'object') envelope.control = payload.control;
  if (payload.controls && typeof payload.controls === 'object') envelope.controls = payload.controls;
  if (payload.next_poll && typeof payload.next_poll === 'object') envelope.next_poll = payload.next_poll;
  if (!Object.keys(envelope).length) return;
  const derived = deriveNextPollDelay(envelope);
  if (Number.isFinite(derived) && derived > 0) {
    scheduleAiPoll(derived);
  }
}

async function handleContextEventPromptResult(rawText) {
  if (!rawText) return null;
  const payload = parseContextEventResponseText(rawText);
  if (payload === null) {
    console.warn('[Context] background prompt produced no structured response; skipping.');
    return null;
  }
  const actions = collectContextEventActions(payload);
  for (const entry of actions) {
    const normalized = normalizeContextEventActionEntry(entry);
    if (!normalized) continue;
    const { action, params } = normalized;
    if (!CONTEXT_EVENT_ALLOWED_ACTIONS.has(action)) {
      console.warn(`[Context] background action not permitted: ${action}`);
      continue;
    }
    const safeParams = (params && typeof params === 'object' && !Array.isArray(params)) ? { ...params } : {};
    try {
      if (MANAGE_LOG_ALLOWED_ACTIONS.has(action)) {
        runManageLogAction(action, safeParams);
      } else {
        await runContextManager({ action, params: safeParams });
      }
    } catch (err) {
      const message = err?.message || err;
      console.warn(`[Context] background action failed (${action}):`, message);
    }
  }
  if (!Array.isArray(payload)) {
    applyContextEventControlFromPayload(payload);
  }
  return payload;
}

async function runContextEventJob(job) {
  if (!job || !job.text) return;
  if (backgroundDisposed) {
    console.warn('[Context] background worker not available; skipping context event prompt.');
    return;
  }

  const eventType = job.eventType || null;
  const reason = job.reason || eventType || 'context_event';
  const timeoutMs = Math.max(5000, Number(job.timeoutMs) || 45000);

  const suppressBusy = (
    reason === 'context_pending' ||
    reason === 'context_active' ||
    reason === 'daily_summary' ||
    reason === 'reminder_due' ||
    eventType === 'reminder_due'
  );
  beginHiddenDecision(reason, { suppressBusy });
  try {
    const promptResult = await backgroundGemini.promptText(job.text, { timeoutMs });
    if (promptResult && typeof promptResult.text === 'string') {
      try {
        await handleContextEventPromptResult(promptResult.text);
      } catch (err) {
        console.warn('[Context] failed to handle background context response:', err?.message || err);
      }
    }
  } catch (err) {
    const message = err?.message || err;
    const retryScheduled = scheduleContextEventRetry(job, message);
    if (!retryScheduled) {
      console.warn('[Context] background prompt failed:', message);
    }
  } finally {
    try { maybeRunDeferredNotify(); } catch {}
    try { maybeProcessReminderQueue(); } catch {}
    try {
      refreshContextStateCache(true);
    } catch (e) {
      console.warn('[Context] failed to refresh context state after event:', e?.message || e);
    }
    endHiddenDecision();
  }
}

function logContextEvent(eventType, { modeId = null, payload = null, source = null } = {}) {
  try {
    runContextManagerSync({
      action: 'context.events_append',
      params: {
        event_type: eventType,
        mode_id: modeId,
        payload,
        source,
      },
    });
  } catch (e) {
    console.warn('[Context] failed to record event:', e?.message || e);
  }
}

function dispatchContextEvent(eventType, detail) {
  const occurredAt = new Date().toISOString();
  const payload = {
    event_type: eventType,
    occurred_at: occurredAt,
    detail,
  };
  const modeId = detail?.mode_id || detail?.modeId || getActiveContextModeId();
  logContextEvent(eventType, { modeId, payload, source: detail?.source || 'system' });
  if (!isContextContractEnabled()) return;
  const promptLines = [
    '[System] コンテキスト切り替えイベントです。あなたはNext.jsサーバー内で動作するバックグラウンドサブプロセスであり、ユーザーからは一切見えません。もし何かユーザーに伝える必要が生じた場合は、通知を作成して送信するのが唯一の経路です。ユーザーはあなたに直接話しかけることはできませんが、システムから提供されるGeminiのメインプロセスとユーザーとの会話を参照できます。',
    '---',
    JSON.stringify(payload, null, 2),
    '---',
    '必要に応じて内部状態や今後の判断に反映してください。',
  ];
  const promptText = promptLines.join('\n');
  const reason = eventType === 'context_pending'
    ? 'context_pending'
    : eventType === 'context_active'
      ? 'context_active'
      : eventType === 'reminder_due'
        ? 'reminder_due'
        : 'context_event';
  enqueueContextEventPrompt(promptText, { reason, timeoutMs: 45000, eventType, detail });
}

async function checkDueReminders() {
  try {
    const before = formatDbTimestamp(new Date());
    const res = await runContextManager({ action: 'ai.reminder_due', params: { user_id: 'local', before, limit: 20 } });
    const reminders = Array.isArray(res?.reminders) ? res.reminders : [];
    if (!reminders.length) return;
    for (const reminder of reminders) {
      await enqueueReminderForProcessing(reminder);
    }
    maybeProcessReminderQueue();
  } catch (e) {
    console.warn('[Reminder] polling failed:', e?.message || e);
  }
}

function mergeNotifyToolMeta(meta, patch = {}, { incrementAttempt = false } = {}) {
  const base = (meta && typeof meta === 'object') ? { ...meta } : {};
  const notifyMeta = { ...(base.notify_tool || {}) };
  if (incrementAttempt) {
    const prev = Number(notifyMeta.attempts || 0);
    notifyMeta.attempts = Number.isFinite(prev) ? prev + 1 : 1;
  }
  Object.assign(notifyMeta, patch);
  base.notify_tool = notifyMeta;
  return base;
}

async function enqueueReminderForProcessing(reminder) {
  if (!reminder || !reminder.id) return;
  if (reminderProcessingSet.has(reminder.id)) return;

  const fireAtRaw = reminder.fire_at || reminder.fireAt;
  if (fireAtRaw) {
    const fireAtMs = Date.parse(fireAtRaw);
    if (Number.isFinite(fireAtMs) && fireAtMs > Date.now() + 1000) {
      // Not due yet; skip queuing and let the regular poll pick it up later
      return;
    }
  }

  reminderProcessingSet.add(reminder.id);
  const nowIso = new Date().toISOString();
  const mergedMeta = mergeNotifyToolMeta(reminder.meta, { status: 'queued', queued_at: nowIso }, { incrementAttempt: true });
  const queueItem = { ...reminder, meta: mergedMeta };
  dispatchContextEvent('reminder_due', { reminder: queueItem, source: 'reminder' });
  reminderProcessingQueue.push(queueItem);
  try {
    await runContextManager({
      action: 'ai.reminder_update',
      params: {
        id: reminder.id,
        status: 'queued',
        meta: mergedMeta,
      },
    });
  } catch (e) {
    console.warn('[Reminder] failed to mark queued:', e?.message || e);
  }
}

function isAssistantStreaming() {
  if (!currentAssistantMessage) return false;
  if (!currentAssistantMessage.id) return false;
  if (suppressNextAssistantBroadcast) return false;
  return Boolean(currentAssistantMessage.text || currentAssistantMessage.thought);
}

function maybeProcessReminderQueue() {
  if (reminderProcessingActive) return;
  if (hiddenDecisionActive) return;
  if (isAIPromptActive) return;
  if (isAssistantStreaming()) return;
  const next = reminderProcessingQueue.shift();
  if (!next) return;
  reminderProcessingActive = true;
  runReminderAutomation(next)
    .catch((e) => {
      console.warn('[Reminder] automation failed:', e?.message || e);
    })
    .finally(() => {
      reminderProcessingActive = false;
      if (next?.id) reminderProcessingSet.delete(next.id);
      maybeProcessReminderQueue();
    });
}

async function runReminderAutomation(reminder) {
  const reminderId = reminder?.id;
  const now = new Date();
  const nowIso = now.toISOString();
  const nowLocalIso = formatLocalIso(now);
  let tzName = null;
  try {
    tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    tzName = null;
  }

  const promptPayload = {
    now: nowIso,
    now_local: nowLocalIso,
    timezone: tzName,
    reminder,
    context_state: buildContextModeSnapshot(),
  };

  const promptText = [
    '[System] 設定されたリマインダーが届きました。あなたはNext.jsサーバー内で動作するバックグラウンドサブプロセスであり、ユーザーからは見えません。もし何かユーザーに伝える必要が生じた場合は、通知を作成して送信するのが唯一の経路です。ユーザーはあなたに直接話しかけることはできませんが、システムから提供されるGeminiのメインプロセスとユーザーとの会話を参照できます。',
    '---',
    JSON.stringify(promptPayload, null, 2),
    '---',
  ].join('\n');

  const timeoutMs = 40000;
  try {
    await backgroundGemini.promptText(promptText, { timeoutMs });
  } catch (err) {
    console.warn('[Reminder] background prompt failed:', err?.message || err);
  } finally {
    maybeRunDeferredNotify();
    maybeProcessReminderQueue();
    maybeProcessContextEventQueue();
    try {
      if (reminderId) await finalizeReminderAfterProcessing(reminderId);
    } catch {}
  }
}

async function finalizeReminderAfterProcessing(reminderId) {
  if (!reminderId) return;
  try {
    const res = await runContextManager({ action: 'ai.reminder_get', params: { id: reminderId } });
    const current = res?.reminder;
    if (!current) return;
    const nowIso = new Date().toISOString();
    const mergedMeta = mergeNotifyToolMeta(current.meta, { status: 'dispatched', auto_closed: true, auto_closed_at: nowIso });
    await runContextManager({
      action: 'ai.reminder_update',
      params: {
        id: reminderId,
        status: 'dispatched',
        meta: mergedMeta,
      },
    });
  } catch (e) {
    console.warn('[Reminder] finalize failed:', e?.message || e);
  }
}

function startReminderWatcher() {
  if (reminderTimerHandle) clearInterval(reminderTimerHandle);
  reminderTimerHandle = setInterval(() => {
    checkDueReminders().catch((e) => console.warn('[Reminder] interval error:', e?.message || e));
  }, REMINDER_POLL_INTERVAL_MS);
  setTimeout(() => {
    checkDueReminders().catch((e) => console.warn('[Reminder] initial run error:', e?.message || e));
  }, 5000);
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
    const triggersPath = NOTIFY_TRIGGERS_PATH;
    const nextTriggers = readJsonSafe(triggersPath, {});
    TRIGGERS = nextTriggers;
    // Grace window after last visible assistant turn
    const graceMin = Number(nextTriggers?.ai_poll?.grace_after_last_turn_minutes || nextTriggers?.grace_after_last_turn_minutes || 0) || 3;
    notifyGraceMs = Math.max(0, graceMin) * 60 * 1000;
    resetNotifyCooldownWithNewGrace();
    // --- AI poll scheduler ---
    // Read policy rules to get quiet hours
    const policyPath = NOTIFY_POLICY_PATH;
    const policy = readJsonSafe(policyPath, {});
    const qh = String(policy.quiet_hours || '').trim();
    const [h1, h2] = qh.split('-');
    const toHour = (s) => { const n = Number(String(s || '').trim()); return isFinite(n) ? Math.min(23, Math.max(0, n)) : null; };
    const q1 = toHour(h1), q2 = toHour(h2);
    const now = new Date();
    const hourNow = now.getHours();
    let isQuietNow = false;
    if (q1 !== null && q2 !== null) { if (q1 <= q2) isQuietNow = (hourNow >= q1 && hourNow < q2); else isQuietNow = (hourNow >= q1 || hourNow < q2); }

    // --- AI poll scheduler ---
    const pollMins = Number(nextTriggers?.ai_poll?.interval_minutes || 0) || 60;
    const intervalMs = pollMins * 60 * 1000;
    cancelAiPollTimer();
    cancelAiPollResumeTimer();
    aiPollDefaultIntervalMs = intervalMs;
    refreshNotifyDerivedSettings();

    if (isQuietNow) {
      console.log('[Scheduler] AI poll suppressed during quiet hours.');
      scheduleAiPollAfterQuiet(intervalMs, q1, q2);
    } else {
      console.log(`[Scheduler] AI poll base interval ${pollMins} min (contract ${isContextContractEnabled() ? 'enabled' : 'disabled'})`);
      scheduleAiPoll(intervalMs);
    }

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
            const result = await executeNotifyOrDefer({ source: 'cron', intent: 'auto', context: { userId }, userId });
            if (result?.deferred) break;
          } catch (e) { console.warn('[Cron] error:', e?.message || e); }
        }
      }, 15 * 1000);
      console.log(`[Scheduler] Cron enabled for: ${exprs.join(' | ')}`);
    } else {
      console.log('[Scheduler] Cron disabled');
    }

    scheduleDailySummaryAutomation(nextTriggers?.daily_summary);
  } catch (e) {
    console.warn('[Scheduler] load/apply triggers failed:', e?.message || e);
  }
}

// 2. プロセス起動処理の更新
function shouldUseSudo(targetUser) {
  const flag = process.env.GEMINI_USE_SUDO;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  if (typeof process.getuid === 'function') {
    try {
      const uid = process.getuid();
      if (uid === 0 && targetUser && targetUser !== process.env.USER) return true;
    } catch {}
  }
  return false;
}

const GEMINI_PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpm', 'pnpmx', 'npm', 'yarn', 'corepack']);
const GEMINI_AUTO_BINARY_CANDIDATES = ['gemini', 'google-gemini', 'google-gemini-cli'];

function resolveExecutablePath(raw) {
  try {
    if (!raw) return null;
    const value = String(raw).trim();
    if (!value) return null;
    if (value.includes(path.sep) || value.includes('/')) {
      const abs = path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
      if (fs.existsSync(abs)) return abs;
      return null;
    }
    const which = spawnSync('which', [value], { encoding: 'utf8' });
    if (which && which.status === 0) {
      const located = (which.stdout || '').trim();
      if (located) return located;
    }
  } catch {}
  return null;
}

function resolveExplicitGeminiExecutable() {
  const override = GEMINI_CLI_EXEC_OVERRIDE;
  if (!override) return null;
  const resolved = resolveExecutablePath(override);
  if (resolved) return resolved;
  try {
    const abs = path.resolve(PROJECT_ROOT, override);
    if (fs.existsSync(abs)) return abs;
  } catch {}
  return override;
}

function detectGlobalGeminiBinary() {
  for (const name of GEMINI_AUTO_BINARY_CANDIDATES) {
    const resolved = resolveExecutablePath(name);
    if (resolved) return resolved;
  }
  return null;
}

function buildGeminiSpawnEnv(baseEnv, { preferOffline }) {
  const env = { ...baseEnv };
  env.NPM_CONFIG_YES = 'true';
  env.npm_config_yes = 'true';
  if (preferOffline) {
    env.NPM_CONFIG_PREFER_OFFLINE = 'true';
    env.npm_config_prefer_offline = 'true';
    env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
    env.npm_config_update_notifier = 'false';
    env.NPM_CONFIG_FUND = 'false';
    env.npm_config_fund = 'false';
    env.NPM_CONFIG_AUDIT = 'false';
    env.npm_config_audit = 'false';
  }
  const cacheDir = process.env.GEMINI_NPM_CACHE_DIR;
  if (cacheDir) {
    env.NPM_CONFIG_CACHE = cacheDir;
    env.npm_config_cache = cacheDir;
  }
  return env;
}

function resolveGeminiLaunch(flags) {
  const explicit = resolveExplicitGeminiExecutable();
  if (explicit) {
    return { command: explicit, args: flags, preferOffline: false, runner: 'direct', source: 'override' };
  }

  let bin = GEMINI_NPX_BIN;
  if (!bin) bin = 'npx';
  const normalizedBin = String(bin).trim() || 'npx';

  if (!GEMINI_PACKAGE_RUNNERS.has(normalizedBin)) {
    const resolved = resolveExecutablePath(normalizedBin);
    if (resolved) {
      return { command: resolved, args: flags, preferOffline: false, runner: 'direct', source: 'bin-direct' };
    }
    if (normalizedBin !== 'npx') {
      try { console.warn(`[Gemini Process] GEMINI_CLI_BIN=${normalizedBin} not found. Falling back to npx.`); } catch {}
    }
    bin = 'npx';
  }

  if (bin === 'npx') {
    const auto = detectGlobalGeminiBinary();
    if (auto) {
      try { console.log(`[Gemini Process] Using detected Gemini CLI binary at ${auto}`); } catch {}
      return { command: auto, args: flags, preferOffline: false, runner: 'direct', source: 'auto' };
    }
  }

  return {
    command: bin,
    args: [GEMINI_CLI_PACKAGE, ...flags],
    preferOffline: geminiCliPreferOffline && bin === 'npx',
    runner: 'runner',
    source: 'runner',
  };
}

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
  const launch = resolveGeminiLaunch(flags);
  const env = buildGeminiSpawnEnv(process.env, { preferOffline: launch.preferOffline });
  if (launch.runner === 'runner' && launch.preferOffline) {
    try { console.log('[Gemini Process] Launching via npx with prefer-offline cache mode'); } catch {}
  }
  const spec = buildRunAsUserSpec(launch.command, launch.args, { env });
  return {
    cmd: spec.command,
    args: spec.args,
    options: spec.options || {},
  };
}

let geminiProcess = null;
let isAIPromptActive = false;
const history = [];
let isRestartingGemini = false;

function isGeminiRunning() {
  return Boolean(geminiProcess && !geminiProcess.killed && geminiProcess.stdin && !geminiProcess.stdin.destroyed);
}

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
let hiddenDecisionDepth = 0;
const hiddenDecisionStack = [];
// Global reference to WebSocket server for out-of-scope broadcasts
let wssGlobal = null;
// Track HTTP/S server + listeners so that wrapper can manage lifecycle
let httpsServerInstance = null;
let redirectServerInstance = null;
const serverReadyListeners = new Set();
let serverReadyContext = null;
let serverRestartInProgress = false;
let postListenInitialized = false;
let dbWatchInitialized = false;
let schedulerWatchInitialized = false;
let listenPromise = null;
let restartServerAssigned = null;
let shutdownServerAssigned = null;
let ensureServerListeningAssigned = null;
let restartRequestHandler = null;
let lastReloadBroadcastTs = 0;
let lastReloadBroadcastReason = null;
// Allow a short grace period for reload notifications to reach clients before closing sockets.
const RELOAD_NOTIFICATION_DELAY_MS = 150;
const RELOAD_NOTIFICATION_WINDOW_MS = 1000;

let restartServerImpl = async (...args) => {
  await appPreparePromise;
  if (!restartServerAssigned) throw new Error('Server not initialized');
  return restartServerAssigned(...args);
};

let shutdownServerImpl = async (...args) => {
  await appPreparePromise;
  if (!shutdownServerAssigned) throw new Error('Server not initialized');
  return shutdownServerAssigned(...args);
};

let ensureServerListeningImpl = async (...args) => {
  await appPreparePromise;
  if (!ensureServerListeningAssigned) throw new Error('Server not initialized');
  return ensureServerListeningAssigned(...args);
};

function registerRestartHandler(fn) {
  if (typeof fn === 'function') {
    restartRequestHandler = fn;
  } else {
    restartRequestHandler = null;
  }
}

function notifyClientsOfReload(reason = 'restart') {
  if (!wssGlobal) return;
  const now = Date.now();
  if (lastReloadBroadcastReason === reason && now - lastReloadBroadcastTs < 500) {
    return;
  }
  lastReloadBroadcastReason = reason;
  lastReloadBroadcastTs = now;
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: 'serverReload',
    params: { reason, ts: now },
  });
  for (const ws of wssGlobal.clients) {
    if (!ws || typeof ws.readyState !== 'number') continue;
    const readyState = ws.readyState;
    if (readyState === 1 || (typeof ws.OPEN === 'number' && readyState === ws.OPEN)) {
      try { ws.send(payload); } catch {}
    }
  }
}

async function requestServerRestart(reason = 'manual') {
  if (typeof restartRequestHandler === 'function') {
    return restartRequestHandler(reason);
  }
  notifyClientsOfReload(reason);
  return restartServerImpl();
}

// Map toolCallId -> { requestId, options, cmdKey }
const permissionWaiters = new Map();
// Track last visible assistant end-of-turn to delay background notify
let lastVisibleTurnEndTs = 0;

function beginHiddenDecision(reason = null, { suppressBusy = false } = {}) {
  hiddenDecisionDepth++;
  hiddenDecisionStack.push({ reason, suppressBusy: Boolean(suppressBusy) });
  hiddenDecisionActive = true;
  if (!suppressBusy) {
    setNotifyBusy(true, reason);
  }
}

function endHiddenDecision() {
  if (hiddenDecisionDepth <= 0) {
    hiddenDecisionDepth = 0;
    hiddenDecisionStack.length = 0;
    hiddenDecisionActive = false;
    setNotifyBusy(false);
    maybeRunDeferredNotify();
    maybeProcessReminderQueue();
    maybeProcessContextEventQueue();
    return;
  }

  hiddenDecisionDepth--;
  hiddenDecisionStack.pop();

  if (hiddenDecisionDepth === 0) {
    hiddenDecisionActive = false;
    setNotifyBusy(false);
    maybeRunDeferredNotify();
    maybeProcessReminderQueue();
    maybeProcessContextEventQueue();
  } else {
    let nextReason = null;
    let hasVisibleEntry = false;
    for (let i = hiddenDecisionStack.length - 1; i >= 0; i--) {
      const entry = hiddenDecisionStack[i];
      if (!entry || entry.suppressBusy) continue;
      hasVisibleEntry = true;
      nextReason = entry.reason ?? null;
      break;
    }
    if (hasVisibleEntry) {
      setNotifyBusy(true, nextReason);
    } else {
      setNotifyBusy(false);
    }
  }
}

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
        if (b === 'manage_context.py') return `${head}:manage_context`;
        if (b === 'notify_tool.py') return `${head}:notify_tool`;
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

const AUTO_TOOL_ALLOW_KEYWORDS = ['manage_log', 'manage_context', 'notify_tool'];

function toolCallTargetsInternalScript(tc) {
  try {
    const segments = [];
    const push = (value) => {
      if (value === null || value === undefined) return;
      if (typeof value === 'string') {
        if (value) segments.push(value);
        return;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        segments.push(String(value));
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) push(entry);
        return;
      }
      if (typeof value === 'object') {
        for (const key of Object.keys(value)) {
          if (key === 'content' || key === 'preview' || key === 'proposed') continue;
          try {
            push(value[key]);
          } catch {}
        }
      }
    };

    push(tc?.title);
    push(tc?.kind);
    push(tc?.command);
    push(tc?.name);
    push(tc?.input);
    push(tc?.arguments);
    push(tc?.args);

    if (Array.isArray(tc?.locations)) {
      for (const loc of tc.locations) {
        if (!loc) continue;
        push(loc.path);
        push(loc.title);
        push(loc.description);
      }
    }

    const hay = segments.join(' ').toLowerCase();
    if (!hay) return false;
    return AUTO_TOOL_ALLOW_KEYWORDS.some((needle) => hay.includes(needle));
  } catch {
    return false;
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
    if (!p) return null;
    const root = PROJECT_ROOT_REAL;
    const abs = path.resolve(root, p);
    const relative = path.relative(root, abs);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return abs;
    }
    return null;
  } catch {
    return null;
  }
}

function mapToolStatus(status) {
  if (!status) return undefined;
  const s = String(status).toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'done' || s === 'finished' || s === 'success' || s === 'succeeded') return 'finished';
  if (s === 'pending') return 'pending';
  if (s === 'in_progress' || s === 'running' || s === 'started') return 'running';
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

function notifyServerReady(context) {
  serverReadyContext = context;
  for (const listener of serverReadyListeners) {
    try {
      listener(context);
    } catch (err) {
      console.error('[Server] onServerReady listener failed:', err?.message || err);
    }
  }
}

function onServerReady(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  serverReadyListeners.add(listener);
  if (serverReadyContext) {
    try {
      listener(serverReadyContext);
    } catch (err) {
      console.error('[Server] onServerReady listener failed:', err?.message || err);
    }
  }
  return () => {
    serverReadyListeners.delete(listener);
  };
}

function setNotifyBusy(active, reason = null) {
  if (!wssGlobal) return;
  const params = { active: Boolean(active) };
  if (active && reason) params.reason = reason;
  if (!active) params.reason = null;
  try { broadcast(wssGlobal, { jsonrpc: '2.0', method: 'notifyBusy', params }); } catch {}
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

function setToolHistoryStatus(toolCallId, status) {
  const idx = findLastToolHistoryIndex(toolCallId);
  if (idx === -1) {
    return false;
  }
  const entry = history[idx];
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  entry.status = status;
  entry.updatedTs = Date.now();
  return true;
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
    text: typeof content === 'string' ? content : '',
  };
  history.push(msg);
  return msg;
}

function _startNewGeminiProcess(wss) {
  console.log(`[Gemini Process] Starting new Gemini process...`);
  const spec = getGeminiSpawnSpec();
  const spawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: PROJECT_ROOT,
    ...(spec.options || {}),
  };
  if (!spawnOptions.env) {
    spawnOptions.env = process.env;
  }
  geminiProcess = spawn(spec.cmd, spec.args, spawnOptions);

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

  let pendingNpmLogPath = null;
  geminiProcess.stderr.on('data', data => {
    const text = data.toString();
    console.error('[Gemini ERROR] ' + text);
    if (!pendingNpmLogPath) {
      const match = text.match(/A complete log of this run can be found in:\s*(.*)/i);
      if (match && match[1]) {
        pendingNpmLogPath = match[1].trim();
      }
    }
  });

  geminiProcess.on('close', (code, signal) => {
    console.log(`[Gemini Process] Gemini process exited with code ${code} and signal ${signal}.`);
    if (code && code !== 0 && pendingNpmLogPath) {
      try {
        const logText = fs.readFileSync(pendingNpmLogPath, 'utf8');
        const lines = logText.split(/\r?\n/).filter(Boolean);
        const tail = lines.slice(-40).join('\n');
        if (tail) {
          console.error('[Gemini Process] npm failure details:\n' + tail);
        }
      } catch (err) {
        console.error(`[Gemini Process] Failed to read npm log ${pendingNpmLogPath}: ${err?.message || err}`);
      }
    }
    pendingNpmLogPath = null;
    if (geminiProcess) {
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
      if (!geminiCliPreferOffline && !GEMINI_CLI_DISABLE_AUTO_OFFLINE) {
        geminiCliPreferOffline = true;
        try { console.log('[Gemini Process] Cached CLI detected; future restarts will prefer offline npm cache.'); } catch {}
      }
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
          const endTs = Date.now();
          const wasHidden = suppressNextAssistantBroadcast || hiddenDecisionActive;
          ensureAssistantMessage(wss, endTs);
          flushAssistantMessage(wss, msg.result?.stopReason);
          if (!wasHidden) {
            try {
              lastVisibleTurnEndTs = endTs;
              extendNotifyCooldownFrom(endTs);
            } catch {}
            maybeRunDeferredNotify();
          }
          maybeProcessReminderQueue();
          maybeProcessContextEventQueue();
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
        if ((suppressNextAssistantBroadcast || hiddenDecisionActive) && tc) {
          // Derive a safe allowlist: python/python3 targeting manage_* or notify_tool helper scripts
          const cmdKey = deriveCommandKey(tc);
          const rawLabel = tc.title || String(tc.kind || 'tool');
          const isPython = (
            cmdKey === 'python' || cmdKey === 'python3' ||
            cmdKey === 'python:manage_log' || cmdKey === 'python3:manage_log' ||
            cmdKey === 'python:manage_context' || cmdKey === 'python3:manage_context' ||
            cmdKey === 'python:notify_tool' || cmdKey === 'python3:notify_tool' ||
            cmdKey === 'shell:python3'
          );
          const allowed = isPython && toolCallTargetsInternalScript(tc);
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
            const coerceDiff = (entry) => {
              if (!entry || typeof entry !== 'object') return null;
              if (entry.type === 'diff') return entry;
              if (entry.oldText !== undefined || entry.newText !== undefined) return entry;
              if (entry.content) {
                const nested = coerceDiff(entry.content);
                if (nested) return nested;
              }
              if (Array.isArray(entry.parts)) {
                for (const part of entry.parts) {
                  const nested = coerceDiff(part);
                  if (nested) return nested;
                }
              }
              return null;
            };
            const coerceText = (entry) => {
              if (!entry) return null;
              if (typeof entry === 'string') return entry;
              if (typeof entry !== 'object') return null;
              if (entry.type === 'markdown' && typeof entry.markdown === 'string') return entry.markdown;
              if (entry.type === 'text' && typeof entry.text === 'string') return entry.text;
              if (entry.type === 'content' && entry.content) return coerceText(entry.content);
              if (typeof entry.text === 'string') return entry.text;
              if (Array.isArray(entry.parts)) {
                for (const part of entry.parts) {
                  const nested = coerceText(part);
                  if (nested) return nested;
                }
              }
              return null;
            };
            let previewContent = null;
            let fallbackText = null;
            for (const rawEntry of arr) {
              let entry = rawEntry;
              if (typeof entry === 'string') {
                const trimmed = entry.trim();
                if (!trimmed) continue;
                try {
                  const parsed = JSON.parse(trimmed);
                  if (parsed && typeof parsed === 'object') {
                    entry = parsed;
                  } else {
                    if (!fallbackText) fallbackText = trimmed;
                    continue;
                  }
                } catch {
                  if (!fallbackText) fallbackText = trimmed;
                  continue;
                }
              }
              const diff = coerceDiff(entry);
              if (diff) {
                previewContent = { type: 'diff', oldText: String(diff.oldText ?? ''), newText: String(diff.newText ?? '') };
                break;
              }
              const text = coerceText(entry);
              if (text && !fallbackText) fallbackText = String(text);
            }
            if (!previewContent && typeof fallbackText === 'string') {
              previewContent = { type: 'markdown', markdown: fallbackText };
            }
            if (previewContent) {
              const idx = findLastToolHistoryIndex(tc.toolCallId);
              if (idx !== -1) {
                history[idx].content = (previewContent.type === 'diff') ? JSON.stringify(previewContent) : previewContent.markdown;
                history[idx].updatedTs = Date.now();
              }
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
            setToolHistoryStatus(tc.toolCallId, 'error');
            broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: tc.toolCallId, status: 'error' } });
          }
          break;
        }
        if (allowAlways.includes(cmdKey)) {
          respondAllowed();
          if (tc?.toolCallId) {
            setToolHistoryStatus(tc.toolCallId, 'running');
            broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId: tc.toolCallId, status: 'running' } });
          }
          break;
        }
        if (yolo) {
          respondAllowed();
          if (tc?.toolCallId) {
            setToolHistoryStatus(tc.toolCallId, 'running');
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
              if (toolCallId) setToolHistoryStatus(toolCallId, 'running');
              broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'running' } });
            } else {
              if (!json.tools.denyAlways.includes(cmdKey)) json.tools.denyAlways.push(cmdKey);
              if (denyOpt?.optionId) acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
              else acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
              if (denyOpt?.optionId) acpProvideSelected(denyOpt.optionId);
              if (toolCallId) setToolHistoryStatus(toolCallId, 'error');
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
          if (toolCallId) setToolHistoryStatus(toolCallId, 'running');
          broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params: { toolCallId, status: 'running' } });
        } else {
          if (denyOpt?.optionId) acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
          else acpRespond(requestId, { sessionId: acpSessionId, outcome: { outcome: 'rejected' } });
          if (toolCallId) setToolHistoryStatus(toolCallId, 'error');
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
  const rawText = currentAssistantMessage.text || '';
  const trimmed = rawText.trim();
  const wasHiddenTurn = suppressNextAssistantBroadcast || hiddenDecisionActive;

  // hidden-prompt モードでは本文の有無に関わらず待機者へ通知し、Busy を解除する
  if (suppressNextAssistantBroadcast) {
    try {
      while (assistantTurnWaiters.length) {
        const resolve = assistantTurnWaiters.shift();
        try { resolve({ text: trimmed, stopReason: stopReason || 'end_turn' }); } catch {}
      }
    } finally {
      suppressNextAssistantBroadcast = false;
    }
  }

  // 可視ストリームのみ通常の確定処理を行う
  if (currentAssistantMessage.id && trimmed && !wasHiddenTurn) {
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

  // 3. messageCompleted でストリームの終了を通知する
  if (currentAssistantMessage.id && !wasHiddenTurn) {
    broadcast(wss, { jsonrpc: '2.0', method: 'messageCompleted', params: { messageId: currentAssistantMessage.id, stopReason: stopReason || 'end_turn' } });
  }
  
  // 4. 現在のメッセージをリセットする
  currentAssistantMessage = { id: null, text: '', thought: '' };
  const reason = stopReason || 'end_turn';
  if (reason === 'end_turn' || reason === 'message_end' || reason === 'canceled') {
    isAIPromptActive = false;
    // ADDED: Broadcast AI inactive status
    broadcast(wss, { jsonrpc: '2.0', method: 'aiStatus', params: { active: false } });
    maybeProcessReminderQueue();
  }
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

function extractNewStreamSegment(previous, incoming) {
  if (!incoming) return '';
  if (!previous) return incoming;
  if (incoming === previous) return '';
  if (incoming.length <= previous.length && previous.includes(incoming)) {
    return '';
  }
  if (incoming.startsWith(previous)) {
    return incoming.slice(previous.length);
  }
  if (previous.endsWith(incoming)) {
    return '';
  }
  const maxOverlap = Math.min(previous.length, Math.max(0, incoming.length - 1));
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === incoming.slice(0, overlap)) {
      return incoming.slice(overlap);
    }
  }
  return incoming;
}

function handleSessionUpdate(upd, wss) {
  const nowTs = Date.now();
  switch (upd.sessionUpdate) {
    case 'agent_thought_chunk':
      ensureAssistantMessage(wss, nowTs);
      const rawThoughtChunk = upd.content?.type === 'text' ? upd.content.text : '';
      const thoughtChunk = extractNewStreamSegment(currentAssistantMessage.thought, rawThoughtChunk);
      if (thoughtChunk) {
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
      }
      break;

    case 'agent_message_chunk':
      ensureAssistantMessage(wss, nowTs);
      const rawTextChunk = upd.content?.type === 'text' ? upd.content.text : '';
      const textChunk = extractNewStreamSegment(currentAssistantMessage.text, rawTextChunk);
      if (textChunk) {
        currentAssistantMessage.text += textChunk;
        if (!(suppressNextAssistantBroadcast || hiddenDecisionActive)) {
          broadcast(wss, {
            jsonrpc: '2.0',
            method: 'streamAssistantMessageChunk',
            params: { messageId: currentAssistantMessage.id, chunk: { text: textChunk } }
          });
        }
      }
      break;

    case 'end_of_turn':
      // Ensure there is an assistant message id even if no text chunks were streamed
      ensureAssistantMessage(wss, nowTs);
      flushAssistantMessage(wss, upd.stopReason);
      // If this was a visible assistant turn, record its end time for notify grace
      if (!suppressNextAssistantBroadcast) {
        lastVisibleTurnEndTs = nowTs;
        extendNotifyCooldownFrom(nowTs);
      }
      maybeRunDeferredNotify();
      maybeProcessReminderQueue();
      maybeProcessContextEventQueue();
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
      let idx = findLastToolHistoryIndex(upd.toolCallId);
      let rec = idx !== -1 ? history[idx] : null;
      let headerPatched = false;
      let createdNewRecord = false;
      const updateTitle = typeof upd.title === 'string' ? upd.title : undefined;
      const updateKind = typeof upd.kind === 'string' ? upd.kind : undefined;
      const updateLocations = Array.isArray(upd.locations) ? upd.locations : [];

      if (!rec) {
        const label = (updateTitle && updateTitle.trim()) || String(updateKind || 'tool');
        const normalizedLabel = label || 'Tool';
        const icon = (updateKind && updateKind.trim()) || 'tool';
        const command = (normalizedLabel || '').split(' (')[0];
        rec = pushNormalizedToolHistory({
          toolCallId: upd.toolCallId,
          icon,
          label: normalizedLabel,
          command,
          status: mappedStatus || 'running',
          content: '',
          cmdKey: deriveCommandKey({ title: updateTitle || normalizedLabel, kind: updateKind, locations: updateLocations })
        });
        idx = history.length - 1;
        headerPatched = true;
        createdNewRecord = true;
      }

      if (rec) {
        if (updateTitle && updateTitle.trim() && rec.label !== updateTitle) {
          rec.label = updateTitle;
          rec.command = updateTitle.split(' (')[0];
          headerPatched = true;
        }
        if (updateKind && updateKind.trim() && rec.icon !== updateKind) {
          rec.icon = updateKind;
          headerPatched = true;
        }
        if (Array.isArray(updateLocations) && updateLocations.length && !rec.cmdKey) {
          try {
            rec.cmdKey = deriveCommandKey({ title: rec.label, kind: rec.icon, locations: updateLocations });
          } catch {}
        }
        if (content?.type === 'markdown') {
          rec.content = content.markdown;
          rec.text = content.markdown;
        } else if (content?.type === 'diff') {
          rec.content = JSON.stringify(content);
          rec.text = rec.content;
        } else if (typeof upd.content === 'string') {
          const plain = String(upd.content);
          rec.content = plain;
          rec.text = plain;
        }
        if (mappedStatus) rec.status = mappedStatus;
        // 並び順を安定させるため、作成時刻(ts)は更新しない
        rec.updatedTs = Date.now();
      }

      if (createdNewRecord && rec) {
        let cmdKey = rec.cmdKey;
        if (!cmdKey) {
          try { cmdKey = deriveCommandKey({ title: rec.label, kind: rec.icon, locations: upd.locations || [] }); } catch {}
        }
        const toolParams = {
          toolCallId: rec.toolCallId || rec.id,
          icon: rec.icon,
          label: rec.label,
          locations: upd.locations || [],
          status: rec.status || mappedStatus || 'running',
        };
        if (cmdKey) toolParams.cmdKey = cmdKey;
        try { broadcast(wss, { jsonrpc: '2.0', method: 'pushToolCall', params: toolParams }); } catch {}
      }

      const params = {
        toolCallId: upd.toolCallId,
        status: (rec && rec.status) || mappedStatus,
        content,
      };
      if (rec && headerPatched) {
        params.icon = rec.icon;
        params.label = rec.label;
        params.command = rec.command;
        if (rec.cmdKey) params.cmdKey = rec.cmdKey;
      }
      broadcast(wss, { jsonrpc: '2.0', method: 'updateToolCall', params });
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
    const oldProcess = geminiProcess;
    const oldPid = oldProcess.pid;
    let restartTriggered = false;
    const triggerRestart = () => {
      if (restartTriggered) return;
      restartTriggered = true;
      if (geminiProcess === oldProcess) {
        geminiProcess = null;
      }
      isRestartingGemini = false;
      _startNewGeminiProcess(wss);
    };
    oldProcess.once('close', () => {
      triggerRestart();
    });
    // Prefer direct kill on the child; fall back to process group
    try {
      oldProcess.kill('SIGTERM');
    } catch (err) {
      try { process.kill(-oldPid, 'SIGTERM'); } catch (e) {
        console.error(`[Gemini Process] Failed to SIGTERM pid ${oldPid}: ${e.message}`);
      }
    }
    setTimeout(() => {
      if (restartTriggered) return;
      const stillRunning = (oldProcess.exitCode === null && oldProcess.signalCode === null);
      if (stillRunning && !oldProcess.killed) {
        try {
          oldProcess.kill('SIGKILL');
        } catch (err) {
          console.error(`[Gemini Process] Failed to SIGKILL process ${oldPid}: ${err.message}`);
        }
      }
      // Fallback: if still no 'close' fired, hard spawn a new process
      const closedOrKilled = oldProcess.killed || oldProcess.exitCode !== null || oldProcess.signalCode !== null;
      if (!closedOrKilled) {
        try { console.warn('[Gemini Process] close not received; forcing new process spawn'); } catch {}
      }
      triggerRestart();
    }, 3000);
  } else {
    _startNewGeminiProcess(wss);
  }
}

// --- Server Setup ---
function loadHttpsOptions() {
  if (dev && !devHttpsOptIn) {
    console.log('[Server] HTTPS disabled for local development. Set ENABLE_DEV_HTTPS=true to opt in.');
    return null;
  }
  const keyPath = process.env.HTTPS_KEY_PATH || path.resolve(__dirname, 'certs/key.pem');
  const certPath = process.env.HTTPS_CERT_PATH || path.resolve(__dirname, 'certs/cert.pem');
  try {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  } catch {
    return null;
  }
}

function initializeDbWatchers(wss) {
  if (dbWatchInitialized) return;
  dbWatchInitialized = true;
  try {
    const dbPath = path.join(__dirname, '..', 'study_log.db');
    let dbNotifyTimer = null;
    const scheduleDbNotify = () => {
      if (dbNotifyTimer) return;
      dbNotifyTimer = setTimeout(() => {
        dbNotifyTimer = null;
        try { broadcast(wss, { jsonrpc: '2.0', method: 'databaseUpdated', params: { ts: Date.now() } }); } catch {}
      }, 250);
    };
    let lastEventId = 0;
    async function fetchAndBroadcastEvents() {
      try {
        const pythonPath = path.join(__dirname, '..', 'manage_log.py');
        const payload = { action: 'data.events_since', params: { since: lastEventId, limit: 100 } };
        const proc = spawnAsTargetUser('python3', [pythonPath, '--api-mode', 'execute', JSON.stringify(payload)], { cwd: PROJECT_ROOT });
        let out = '';
        proc.stdout.on('data', (c) => { out += String(c); });
        proc.on('close', () => {
          try {
            const json = JSON.parse(out || '{}');
            const events = Array.isArray(json.events) ? json.events : [];
            for (const ev of events) {
              const payload = {
                table: ev.table_name,
                op: ev.op,
                rowId: ev.row_id,
                data: ev.snapshot ? JSON.parse(ev.snapshot) : null,
              };
              let method;
              if (ev.table_name === 'study_logs') {
                method = (ev.op === 'insert' ? 'logCreated' : ev.op === 'update' ? 'logUpdated' : 'logDeleted');
              } else if (ev.table_name === 'goals') {
                method = (ev.op === 'insert' ? 'goalAdded' : ev.op === 'update' ? 'goalUpdated' : 'goalDeleted');
              } else if (ev.table_name === 'daily_summaries') {
                method = (ev.op === 'insert' ? 'summaryAdded' : ev.op === 'update' ? 'summaryUpdated' : 'summaryDeleted');
              } else {
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
}

function initializeSchedulerWatchers(wss) {
  loadAndApplyTriggers(wss);
  if (schedulerWatchInitialized) return;
  schedulerWatchInitialized = true;
  try {
    const triggersPath = NOTIFY_TRIGGERS_PATH;
    const dir = CONFIG_SCHEDULE_DIR;
    let debounceTimer = null;
    const kick = (why) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[Scheduler] Reloading triggers due to: ${why}`);
        loadAndApplyTriggers(wss);
      }, 200);
    };
    fs.watch(dir, { persistent: true }, (eventType, filename) => {
      if (!filename) return;
      if (String(filename) === 'triggers.json') {
        kick(eventType || 'change');
      }
    });
    try { fs.watch(triggersPath, { persistent: true }, () => kick('change')); } catch {}
    console.log('[Scheduler] Watching schedule/triggers.json for changes');
  } catch (e) {
    console.warn('[Scheduler] Failed to watch schedule/triggers.json:', e?.message || e);
  }
}

function initializePostListenFeatures(wss) {
  initializeDbWatchers(wss);
  initializeSchedulerWatchers(wss);
  postListenInitialized = true;
}

// --- Notify helpers (shared) ---
async function runHiddenDecision({ intent, context, userId }) {
  // Respect force mode (testing) before applying early guards
  const forceCtx = Boolean(context && (context.force || context.force_send));
  // Early guard: skip notify while a study session is actively running (excluding BREAK)
  if (!forceCtx) {
    try {
      const payload = JSON.stringify({ action: 'session.active', params: {} });
      const cp = spawnSyncAsTargetUser('python3', ['manage_log.py', '--api-mode', 'execute', payload], { cwd: PROJECT_ROOT, encoding: 'utf8' });
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
  const policy = readJson(NOTIFY_POLICY_PATH, {});
  // Intents/types are deprecated; keep triggers and policy
  const triggers = readJson(NOTIFY_TRIGGERS_PATH, {});
  // Load system prompt (optional)
  let systemFile = '';
  try { systemFile = fs.readFileSync(NOTIFY_SYSTEM_PROMPT_PATH, 'utf8'); } catch {}
  const now = new Date();
  const nowIso = now.toISOString();
  const nowLocalIso = formatLocalIso(now);
  let tzName = null;
  try {
    tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    tzName = null;
  }
  const tzOffsetMinutes = -now.getTimezoneOffset();
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

  let lastNotifications = [];
  try {
    const res = runContextManagerSync({ action: 'notify.log_list', params: { user_id: userId, limit: 40 } }) || {};
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    lastNotifications = entries
      .filter((entry) => entry && entry.decision === 'send' && !entry.test && entry.payload && entry.payload.notification)
      .map((entry) => {
        const createdAt = entry.created_at || null;
        let sentAt = Date.now();
        if (createdAt) {
          const iso = createdAt.replace(' ', 'T');
          const ms = Date.parse(iso);
          if (Number.isFinite(ms)) sentAt = ms;
        }
        const tag = entry.payload.notification.tag || 'general';
        return {
          userId,
          tag,
          sentAt,
          entry,
        };
      })
      .slice(0, 40);
  } catch (e) {
    console.warn('[Notify] Failed to load recent notification history:', e?.message || e);
  }

  const user = {
    now: nowIso,
    now_local: nowLocalIso,
    timezone: tzName,
    timezone_offset_minutes: tzOffsetMinutes,
    policy,
    triggers,
    lastNotifications,
    context: context || {},
    context_state: buildContextModeSnapshot(),
  };

  // Enqueue hidden prompt and await the assistant's final text
  const promptText = `${baseSystem}\n\n[入力]\n${JSON.stringify(user)}`;
  let promptResult;
  try {
    promptResult = await backgroundGemini.promptText(promptText, { timeoutMs: 45000 });
  } catch (err) {
    console.warn('[Notify] background prompt failed:', err?.message || err);
    maybeRunDeferredNotify();
    maybeProcessReminderQueue();
    maybeProcessContextEventQueue();
    return { decision: 'skip', reason: 'background_error', notification: null };
  }
  maybeRunDeferredNotify();
  maybeProcessReminderQueue();
  maybeProcessContextEventQueue();

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
  const rawResultText = promptResult && typeof promptResult.text === 'string' ? promptResult.text : '';
  let data = parseDecisionText(rawResultText);
  let payload = data && typeof data === 'object' ? data : { decision: 'skip', reason: 'invalid_json' };
  if (payload.reason === 'invalid_json') {
    try {
      const rawLen = rawResultText ? rawResultText.length : 0;
      console.warn('[Notify] invalid_json: raw assistant text length=', String(rawLen));
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
      if (ts) {
        const d = new Date(ts);
        if (d.toDateString() === todayStr) countToday++;
      }
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


function persistNotificationLog({
  userId,
  payload,
  decision,
  reason,
  source,
  modeId,
  context,
  triggeredAt,
  test,
  manualSend,
  resendOf,
}) {
  try {
    const body = {
      action: 'notify.log_append',
      params: {
        user_id: userId || 'local',
        payload: payload || {},
        decision: decision ?? (payload ? payload.decision : null),
        reason: reason ?? (payload ? payload.reason : null),
        source,
        mode_id: modeId || null,
        context: context || null,
        triggered_at: triggeredAt || null,
        test: Boolean(test),
        manual_send: Boolean(manualSend),
        resend_of: resendOf || null,
      },
    };
    const res = runContextManagerSync(body);
    return res && res.entry ? res.entry : null;
  } catch (e) {
    console.warn('[Notify] Failed to persist notification log:', e?.message || e);
    return null;
  }
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

const parsedRedirectPort = Number(process.env.REDIRECT_PORT);
const configuredRedirectPort = Number.isFinite(parsedRedirectPort) && parsedRedirectPort > 0
  ? parsedRedirectPort
  : null;

const appPreparePromise = app.prepare();

appPreparePromise.then(() => {
  refreshNotifyDerivedSettings(true);
  refreshContextStateCache(true);
  startReminderWatcher();
  const requestListener = async (req, res) => {
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
            const ctx = (context && typeof context === 'object') ? context : {};
            const userId = (ctx.userId || ctx.user_id || json.userId || json.user_id || 'local');
            // Avoid running hidden prompt while another visible turn is streaming
            const hasActiveVisible = !!(currentAssistantMessage?.id && !suppressNextAssistantBroadcast);
            if (hasActiveVisible) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              return res.end(JSON.stringify({ ok: false, error: 'busy' }));
            }
            const payload = await runHiddenDecision({ intent, context: ctx, userId });
            extendNotifyCooldownFrom(Date.now());
            maybeRunDeferredNotify();
            const shouldLogDecision = json?.log !== false;
            if (shouldLogDecision && payload && typeof payload === 'object') {
              try {
                const modeId = ctx.mode_id || ctx.modeId || getActiveContextModeId();
                const triggeredAt = typeof json?.triggered_at === 'string' ? json.triggered_at : (typeof json?.triggeredAt === 'string' ? json.triggeredAt : new Date().toISOString());
                persistNotificationLog({
                  userId,
                  payload,
                  decision: payload.decision,
                  reason: payload.reason,
                  source: json?.source || 'api_decide',
                  modeId,
                  context: ctx,
                  triggeredAt,
                  test: Boolean(json?.test || ctx.test || ctx.force || ctx.force_send),
                });
              } catch (logErr) {
                console.warn('[Notify] Failed to persist decision (api/notify/decide):', logErr?.message || logErr);
              }
            }
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

      if (req.method === 'GET' && pathname === '/api/context/state') {
        try {
          const data = runContextManagerSync({ action: 'context.state_get' }) || {};
          refreshContextStateCache(true);
          res.statusCode = 200; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: true, ...data }));
        } catch (e) {
          res.statusCode = 500; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      }

      if (req.method === 'GET' && pathname === '/api/context/modes') {
        try {
          const data = runContextManagerSync({ action: 'context.mode_list' }) || {};
          res.statusCode = 200; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: true, ...data }));
        } catch (e) {
          res.statusCode = 500; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      }

      if (req.method === 'POST' && pathname === '/api/context/signals') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const json = body ? JSON.parse(body) : {};
            const modeId = json.modeId || json.mode_id;
            if (!modeId) throw new Error('modeId required');
            const event = String(json.event || 'enter').toLowerCase();
            const source = json.source || 'automation';
            const meta = json.payload || json.meta || null;
            const nowStr = formatDbTimestamp(new Date());

            if (event === 'exit') {
              const list = runContextManagerSync({ action: 'context.pending_list', params: { mode_id: modeId, status: 'open', limit: 20 } }) || {};
              const pendingList = Array.isArray(list?.pending) ? list.pending : [];
              const resolved = [];
              for (const item of pendingList) {
                try {
                  runContextManagerSync({ action: 'context.pending_update', params: { id: item.id, status: 'cancelled', resolved_at: nowStr, resolution: 'exit_signal' } });
                  resolved.push(item.id);
                } catch (e) {
                  console.warn('[Context] failed to cancel pending', item?.id, e?.message || e);
                }
              }
              dispatchContextEvent('context_exit_signal', { mode_id: modeId, resolved_ids: resolved, source, payload: meta });
              res.statusCode = 200; res.setHeader('Content-Type','application/json');
              return res.end(JSON.stringify({ ok: true, resolved }));
            }

            const pendingRes = runContextManagerSync({
              action: 'context.pending_create',
              params: {
                mode_id: modeId,
                source,
                payload: { event, data: meta },
                entered_at: nowStr,
                status: 'open',
              },
            }) || {};
            refreshContextStateCache(true);
            if (pendingRes?.pending) {
              dispatchContextEvent('context_pending', { mode_id: modeId, pending: pendingRes.pending, source });
            }
            res.statusCode = 200; res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({ ok: true, pending: pendingRes?.pending || null }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/context/activate') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const json = body ? JSON.parse(body) : {};
            const modeId = json.modeId || json.mode_id;
            if (!modeId) throw new Error('modeId required');
            const manual = json.manual === true;
            const source = json.source || 'system';
            const reason = json.reason || null;
            const pendingId = json.pendingId || json.pending_id || null;
            const stateRes = runContextManagerSync({ action: 'context.state_set', params: { mode_id: modeId, manual_override: manual } }) || {};
            if (pendingId) {
              try {
                runContextManagerSync({
                  action: 'context.pending_update',
                  params: {
                    id: pendingId,
                    status: 'confirmed',
                    resolved_at: formatDbTimestamp(new Date()),
                    resolution: json.resolution || 'activated',
                  },
                });
              } catch (e) {
                console.warn('[Context] failed to resolve pending', pendingId, e?.message || e);
              }
            }
            refreshContextStateCache(true);
            dispatchContextEvent('context_active', { mode_id: modeId, manual, pending_id: pendingId, reason, source });
            res.statusCode = 200; res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({ ok: true, ...stateRes }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/notify/logs') {
        try {
          const limit = Number(query?.limit) || 10;
          const offset = Number(query?.offset) || 0;
          const search = query?.search || null;
          const decision = query?.decision || null;
          const modeId = query?.modeId || query?.mode_id || null;
          const source = query?.source || null;
          const userId = query?.userId || query?.user_id || 'local';
          const data = runContextManagerSync({
            action: 'notify.log_list',
            params: { user_id: userId, limit, offset, search, decision, mode_id: modeId, source },
          }) || {};
          res.statusCode = 200; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: true, ...data }));
        } catch (e) {
          res.statusCode = 500; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      }

      if (req.method === 'POST' && pathname === '/api/notify/logs/resend') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const json = body ? JSON.parse(body) : {};
            const entryId = json.id || json.entryId;
            const userId = json.userId || json.user_id || 'local';
            if (!entryId) throw new Error('id required');
            const entryRes = runContextManagerSync({ action: 'notify.log_get', params: { id: entryId } }) || {};
            const entry = entryRes?.entry;
            const notification = entry?.payload?.notification;
            if (!entry || !notification) throw new Error('notification payload missing');
            const resendPayload = {
              decision: 'send',
              reason: 'manual_resend',
              notification,
              evidence: entry.payload?.evidence || {},
            };
            persistNotificationLog({
              userId,
              payload: resendPayload,
              decision: 'send',
              reason: 'manual_resend',
              source: 'manual_resend',
              modeId: entry.mode_id || getActiveContextModeId(),
              context: entry.context || null,
              triggeredAt: new Date().toISOString(),
              manualSend: true,
              resendOf: entryId,
            });
            try { broadcast(wss, { jsonrpc: '2.0', method: 'notify', params: { notification } }); } catch {}
            await sendPushToUser(userId, notification);
            res.statusCode = 200; res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/notify/reminders') {
        try {
          const status = query?.status || null;
          const limit = Number(query?.limit) || 100;
          const offset = Number(query?.offset) || 0;
          const userId = query?.userId || query?.user_id || 'local';
          const data = runContextManagerSync({
            action: 'ai.reminder_list',
            params: { user_id: userId, status, limit, offset },
          }) || {};
          res.statusCode = 200; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: true, ...data }));
        } catch (e) {
          res.statusCode = 500; res.setHeader('Content-Type','application/json');
          return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      }

      if (req.method === 'POST' && pathname === '/api/notify/reminders/cancel') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const json = body ? JSON.parse(body) : {};
            const id = json.id;
            if (!id) throw new Error('id required');
            runContextManagerSync({ action: 'ai.reminder_update', params: { id, status: 'cancelled', meta: { cancelled_at: new Date().toISOString() } } });
            res.statusCode = 200; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
          }
        });
        return;
      }

      // Send notification via notify tool (custom origin, context)
      if (req.method === 'POST' && pathname === '/api/notify/tool/send') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const json = body ? JSON.parse(body) : {};
            const userId = (json && (json.userId || json.user_id)) || 'local';
            const origin = typeof json.origin === 'string' && json.origin.trim().length > 0
              ? json.origin.trim()
              : 'ai_autonomous';
            const notification = json.notification;
            if (!notification || typeof notification !== 'object') throw new Error('invalid notification');
            const contextMeta = (json.context && typeof json.context === 'object') ? json.context : {};
            const nowIso = new Date().toISOString();
            const payload = {
              decision: 'send',
              reason: origin,
              notification,
              context: contextMeta,
            };
            const entry = persistNotificationLog({
              userId,
              payload,
              decision: 'send',
              reason: origin,
              source: origin,
              modeId: contextMeta.mode_id || contextMeta.modeId || getActiveContextModeId(),
              context: { ...contextMeta, origin, tool: true },
              triggeredAt: contextMeta.triggered_at || nowIso,
              test: Boolean(json.test),
              manualSend: false,
            });
            try { broadcast(wss, { jsonrpc: '2.0', method: 'notify', params: { notification } }); } catch {}
            const delivered = await sendPushToUser(userId, notification);
            extendNotifyCooldownFrom(Date.now());
            maybeRunDeferredNotify();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, origin, delivered, log_entry_id: entry?.id || null }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
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
            const payload = { decision: 'send', reason: 'manual_send', notification };
            persistNotificationLog({
              userId,
              payload,
              decision: 'send',
              reason: 'manual_send',
              source: 'manual_send',
              modeId: getActiveContextModeId(),
              context: { manual: true },
              triggeredAt: new Date().toISOString(),
              test,
              manualSend: true,
            });
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
          let count = 0;
          try {
            const stats = runContextManagerSync({ action: 'notify.log_today_stats', params: { user_id: userId } });
            if (stats && typeof stats.count === 'number') count = stats.count;
          } catch (e) {
            console.warn('[Notify] failed to load today stats:', e?.message || e);
          }
          // load cap from policy
          let cap = null;
          try {
            const policy = JSON.parse(fs.readFileSync(NOTIFY_POLICY_PATH, 'utf8')) || {};
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
            let changed = 0;
            try {
              const result = runContextManagerSync({ action: 'notify.log_mark_test', params: { user_id: userId } });
              changed = Number(result?.changed || 0);
            } catch (e) {
              console.warn('[Notify] failed to mark logs as test:', e?.message || e);
            }
            res.statusCode = 200; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true, changed: Boolean(changed) }));
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
  };

  const httpsServer = useHttps
    ? createHttpsServer(httpsOptions, requestListener)
    : createHttpServer(requestListener);
  httpsServerInstance = httpsServer;

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
    // 接続時に現在のAI処理状態を送信
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'aiStatus', params: { active: isAIPromptActive } }));
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

      if (msg.method === 'requestAiStatus') {
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { active: isAIPromptActive } })); } catch {}
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
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null })); } catch {}
        return;
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
        maybeRunDeferredNotify();
        const { text: userText, files, goal, session, messageId, features } = msg.params?.chunks?.[0] || {};
        const rec = { id: messageId || String(Date.now()), ts: Date.now(), role: 'user', text: userText, files: files || [], goal: goal || null, session: session || null };
        history.push(rec);
        broadcastExcept(wss, ws, { jsonrpc: '2.0', method: 'addMessage', params: { message: rec } });

        let systemMessages = [];
        if (features?.webSearch) systemMessages.push(`[System]ユーザーはウェブ検索機能を使うことを希望しています。`);
        if (files && files.length > 0) systemMessages.push(`[System]ユーザーは以下のファイルをアップロードしました：\n${files.map(f => `- ${f.name} (${f.path})`).join('\n')}`);
        if (goal) systemMessages.push(`[System]ユーザーは以下の目標を添付しました：\n- ID: ${goal.id}\n- タスク: ${goal.task}`);
        if (session) systemMessages.push(`[System]ユーザーは以下の学習記録を共有しました：\n- ログID: ${session.id}\n- 内容: ${session.content || 'N/A'}`);
        
        const fullPrompt = (systemMessages.length > 0 ? systemMessages.join('\n') + '\n\n' : '') + userText;

        if (isSessionReady && acpSessionId) {
          isAIPromptActive = true;
          // ADDED: Broadcast AI active status
          broadcast(wss, { jsonrpc: '2.0', method: 'aiStatus', params: { active: true } });
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
        maybeRunDeferredNotify();
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

  let redirectPort = resolveRedirectPortForCurrent(port);

  function resolveRedirectPortForCurrent(targetPort) {
    if (!useHttps) return 0;
    if (configuredRedirectPort) return configuredRedirectPort;
    return targetPort === 443 ? 80 : 0;
  }

  function updateRedirectServer(targetPort) {
    const desiredRedirectPort = resolveRedirectPortForCurrent(targetPort);
    if (redirectPort === desiredRedirectPort) {
      if (!desiredRedirectPort) {
        if (redirectServerInstance) {
          try { redirectServerInstance.close(); } catch {}
          redirectServerInstance = null;
        }
        return;
      }
      if (redirectServerInstance) {
        return;
      }
    }

    const startRedirect = () => {
      redirectPort = desiredRedirectPort;
      if (!redirectPort) {
        redirectServerInstance = null;
        return;
      }
      const redirectServer = createHttpServer((req, res) => {
        const hostHeader = req.headers.host || '';
        const [reqHost] = hostHeader.split(':');
        const targetHost = reqHost || hostname;
        const targetPortSegment = targetPort === 443 ? '' : `:${targetPort}`;
        const httpsUrl = `https://${targetHost}${targetPortSegment}${req.url}`;
        res.writeHead(301, { Location: httpsUrl });
        res.end();
      });

      redirectServerInstance = redirectServer;

      redirectServer.on('error', (err) => {
        if (err?.code === 'EADDRINUSE') {
          console.warn(`[Server] Redirect port ${redirectPort} is in use; disabling HTTP->HTTPS redirect.`);
        } else {
          console.warn(`[Server] Redirect server error (${redirectPort}):`, err?.message || err);
        }
        try { redirectServer.close(); } catch {}
        redirectServerInstance = null;
        redirectPort = 0;
      });

      redirectServer.listen(redirectPort, hostname, () => {
        console.log(`> HTTP redirect server running on http://${hostname}:${redirectPort}, redirecting to https`);
      });
    };

    if (redirectServerInstance) {
      const previous = redirectServerInstance;
      redirectServerInstance = null;
      try {
        previous.close(() => {
          startRedirect();
        });
        return;
      } catch {
        startRedirect();
        return;
      }
    }

    startRedirect();
  }

  async function listenMainServer() {
    if (httpsServer.listening) {
      return;
    }
    if (listenPromise) {
      return listenPromise;
    }

    const attemptPorts = buildPortAttemptList();

    listenPromise = (async () => {
      for (let idx = 0; idx < attemptPorts.length; idx += 1) {
        const targetPort = attemptPorts[idx];
        port = targetPort;
        try {
          await new Promise((resolve, reject) => {
            const onError = (err) => {
              httpsServer.removeListener('error', onError);
              reject(err);
            };
            httpsServer.once('error', onError);
            httpsServer.listen(targetPort, hostname, () => {
              httpsServer.removeListener('error', onError);
              const addressInfo = httpsServer.address();
              if (addressInfo && typeof addressInfo.port === 'number') {
                port = addressInfo.port;
              }
              if (!Number.isFinite(port) || port <= 0) {
                port = targetPort;
              }
              if (Number.isFinite(port) && port > 0) {
                lastSuccessfulPort = port;
              }
              const scheme = useHttps ? 'https' : 'http';
              console.log(`> Ready on ${scheme}://${hostname}:${port}`);
              initializePostListenFeatures(wss);
              notifyServerReady({ scheme, hostname, port, server: httpsServer, wss });
              try { updateRedirectServer(port); } catch (e) {
                console.warn('[Server] Failed to update redirect server:', e?.message || e);
              }
              resolve();
            });
          });
          return;
        } catch (err) {
          const code = err?.code;
          if ((code === 'EADDRINUSE' || code === 'EACCES') && idx < attemptPorts.length - 1) {
            const nextPort = attemptPorts[idx + 1];
            const nextLabel = nextPort === 0 ? 'an ephemeral port' : nextPort;
            const reason = code === 'EADDRINUSE'
              ? 'is in use'
              : 'requires elevated privileges';
            console.warn(`[Server] Port ${targetPort} ${reason}; retrying on ${nextLabel}.`);
            continue;
          }
          throw err;
        }
      }
      throw new Error('No available ports');
    })()
      .finally(() => {
        listenPromise = null;
      });

    return listenPromise;
  }

  listenMainServer().catch((err) => {
    console.error('[Server] Failed to start HTTP server:', err?.message || err);
    process.exitCode = 1;
  });

  function closeAllWebSocketClients(code = 1012, reason = 'server restart') {
    if (!wssGlobal) return;
    for (const ws of wssGlobal.clients) {
      try { ws.close(code, reason); } catch {}
    }
  }

  async function closeHttpServer() {
    if (!httpsServerInstance) {
      listenPromise = null;
      return;
    }
    if (!httpsServerInstance.listening) {
      listenPromise = null;
      return;
    }
    await new Promise((resolve, reject) => {
      httpsServerInstance.close((err) => {
        listenPromise = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function restartServer() {
    if (serverRestartInProgress) {
      return listenPromise || Promise.resolve();
    }
    serverRestartInProgress = true;
    try {
      if (lastReloadBroadcastTs) {
        const elapsed = Date.now() - lastReloadBroadcastTs;
        if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= RELOAD_NOTIFICATION_WINDOW_MS) {
          const remaining = RELOAD_NOTIFICATION_DELAY_MS - elapsed;
          if (remaining > 10) {
            await new Promise((resolve) => setTimeout(resolve, remaining));
          }
        }
      }
      closeAllWebSocketClients(1012, 'server restart');
      await closeHttpServer();
      serverReadyContext = null;
      await listenMainServer();
    } finally {
      serverRestartInProgress = false;
    }
  }

  async function shutdownServer() {
    closeAllWebSocketClients(1001, 'server shutdown');
    await closeHttpServer().catch((err) => {
      console.warn('[Server] Failed to close HTTP server:', err?.message || err);
    });
    if (redirectServerInstance && typeof redirectServerInstance.close === 'function') {
      await new Promise((resolve, reject) => {
        redirectServerInstance.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }).catch((err) => {
        console.warn('[Server] Failed to close redirect server:', err?.message || err);
      });
    }
    redirectServerInstance = null;
    redirectPort = resolveRedirectPortForCurrent(port);
  }

  restartServerAssigned = restartServer;
  shutdownServerAssigned = shutdownServer;
  ensureServerListeningAssigned = () => listenMainServer();
  restartServerImpl = restartServerAssigned;
  shutdownServerImpl = shutdownServerAssigned;
  ensureServerListeningImpl = ensureServerListeningAssigned;
});

const serverControl = {
  onServerReady,
  restartServer: (...args) => restartServerImpl(...args),
  shutdownServer: (...args) => shutdownServerImpl(...args),
  ensureServerListening: (...args) => ensureServerListeningImpl(...args),
  startGemini,
  isGeminiRunning,
  getHttpServer: () => httpsServerInstance,
  getWebSocketServer: () => wssGlobal,
  requestServerRestart,
  registerRestartHandler,
  notifyClientsOfReload,
};

module.exports = serverControl;

try {
  if (typeof globalThis === 'object' && globalThis) {
    globalThis.__flexiServerControl = serverControl;
  }
} catch {}

process.on('exit', () => disposeBackgroundGemini());
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    disposeBackgroundGemini();
    setTimeout(() => process.exit(0), 10);
  });
});
