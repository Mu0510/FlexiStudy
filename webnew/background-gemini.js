const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const GEMINI_CLI_VERSION = process.env.GEMINI_CLI_VERSION || '0.8.2';
const GEMINI_CLI_PACKAGE = process.env.GEMINI_CLI_PACKAGE || `@google/gemini-cli@${GEMINI_CLI_VERSION}`;
const GEMINI_NPX_BIN = (process.env.GEMINI_CLI_BIN || 'npx').trim() || 'npx';
const GEMINI_RUN_AS_USER = process.env.GEMINI_RUN_AS_USER || 'geminicli';
const GEMINI_CLI_EXEC_OVERRIDE = (process.env.GEMINI_CLI_EXECUTABLE || process.env.GEMINI_CLI_PATH || '').trim();
const GEMINI_CLI_DISABLE_AUTO_OFFLINE = process.env.GEMINI_CLI_DISABLE_AUTO_OFFLINE === 'true';
let backgroundGeminiPreferOffline = process.env.GEMINI_CLI_PREFER_OFFLINE === 'true';
const ACP_LOG_MAX_LENGTH = Number(process.env.BACKGROUND_GEMINI_ACP_LOG_LIMIT || 4000);
const PROJECT_ROOT_DEFAULT = path.join(__dirname, '..');

function logAcp(direction, payload) {
  try {
    if (!payload) {
      console.log(`[BackgroundGemini ACP ${direction}] <empty>`);
      return;
    }
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!raw) {
      console.log(`[BackgroundGemini ACP ${direction}] <empty>`);
      return;
    }
    const limit = Number.isFinite(ACP_LOG_MAX_LENGTH) && ACP_LOG_MAX_LENGTH > 0 ? ACP_LOG_MAX_LENGTH : 4000;
    const text = raw.length > limit
      ? `${raw.slice(0, limit)}… [truncated ${raw.length - limit} chars]`
      : raw;
    console.log(`[BackgroundGemini ACP ${direction}] ${text}`);
  } catch (err) {
    console.warn('[BackgroundGemini] failed to log ACP payload:', err?.message || err);
  }
}

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

function getModelFromSettings(settingsPath, fallback) {
  try {
    if (!settingsPath) return fallback;
    if (!fs.existsSync(settingsPath)) return fallback;
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const json = JSON.parse(raw || '{}');
    const cm = json?.chat?.model;
    if (cm === 'gemini-2.5-pro' || cm === 'gemini-2.5-flash') {
      return cm;
    }
  } catch {}
  return fallback;
}

function resolveTargetUserIds(targetUser) {
  if (!targetUser) return null;
  try {
    const uidResult = spawnSync('id', ['-u', targetUser], { encoding: 'utf8' });
    if (uidResult?.status !== 0) return null;
    const uid = Number.parseInt((uidResult.stdout || '').trim(), 10);
    if (!Number.isInteger(uid)) return null;
    let gid;
    const gidResult = spawnSync('id', ['-g', targetUser], { encoding: 'utf8' });
    if (gidResult?.status === 0) {
      const parsed = Number.parseInt((gidResult.stdout || '').trim(), 10);
      if (Number.isInteger(parsed)) gid = parsed;
    }
    return { uid, gid };
  } catch (err) {
    console.warn('[BackgroundGemini] failed to resolve target user ids:', err?.message || err);
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
    console.warn(`[BackgroundGemini] target user "${targetUser}" unavailable; running without sudo.`);
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

const GEMINI_PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpm', 'pnpmx', 'npm', 'yarn', 'corepack']);
const GEMINI_AUTO_BINARY_CANDIDATES = ['gemini', 'google-gemini', 'google-gemini-cli'];

function resolveExecutablePath(raw) {
  try {
    if (!raw) return null;
    const value = String(raw).trim();
    if (!value) return null;
    if (value.includes(path.sep) || value.includes('/')) {
      const abs = path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT_DEFAULT, value);
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
    const abs = path.resolve(PROJECT_ROOT_DEFAULT, override);
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
    return { command: explicit, args: flags, runner: 'direct', preferOffline: false };
  }

  let bin = GEMINI_NPX_BIN;
  if (!bin) bin = 'npx';
  const normalizedBin = String(bin).trim() || 'npx';

  if (!GEMINI_PACKAGE_RUNNERS.has(normalizedBin)) {
    const resolved = resolveExecutablePath(normalizedBin);
    if (resolved) {
      return { command: resolved, args: flags, runner: 'direct', preferOffline: false };
    }
    if (normalizedBin !== 'npx') {
      try { console.warn(`[BackgroundGemini] GEMINI_CLI_BIN=${normalizedBin} not found. Falling back to npx.`); } catch {}
    }
    bin = 'npx';
  }

  if (bin === 'npx') {
    const auto = detectGlobalGeminiBinary();
    if (auto) {
      try { console.log(`[BackgroundGemini] Using detected Gemini CLI binary at ${auto}`); } catch {}
      return { command: auto, args: flags, runner: 'direct', preferOffline: false };
    }
  }

  return {
    command: bin,
    args: [GEMINI_CLI_PACKAGE, ...flags],
    runner: 'runner',
    preferOffline: backgroundGeminiPreferOffline && bin === 'npx',
  };
}

function buildSpawnSpec({ modelOverride, projectRoot }) {
  const model = getModelFromSettings(path.join(projectRoot, 'webnew', 'mnt', 'settings.json'), modelOverride || DEFAULT_MODEL);
  const flags = ['-m', model, '-y', '--experimental-acp'];
  const launch = resolveGeminiLaunch(flags);
  const env = buildGeminiSpawnEnv(process.env, { preferOffline: launch.preferOffline });
  if (launch.runner === 'runner' && launch.preferOffline) {
    try { console.log('[BackgroundGemini] Launching via npx with prefer-offline cache mode'); } catch {}
  }
  const spec = buildRunAsUserSpec(launch.command, launch.args, { env });
  return {
    command: spec.command,
    args: spec.args,
    options: spec.options || {},
  };
}

function splitCommandLine(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && i + 1 < cmd.length) {
        cur += cmd[++i];
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function deriveCommandKeyFromTokens(tokens) {
  if (!tokens || tokens.length === 0) return '';
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (t === 'sudo') {
      i++;
      while (i < tokens.length && /^-/.test(tokens[i])) i++;
      continue;
    }
    if (t === 'env') {
      i++;
      while (i < tokens.length && (/^-/.test(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
      continue;
    }
    break;
  }
  const head = tokens[i] || '';
  if (!head) return '';
  if (head === 'npm' && tokens[i + 1] === 'run' && tokens[i + 2]) return `npm:run:${tokens[i + 2]}`;
  if (head === 'npx' && tokens[i + 1]) return `npx:${tokens[i + 1]}`;
  if ((head === 'pnpm' || head === 'yarn') && tokens[i + 1]) return `${head}:${tokens[i + 1]}`;
  if (head === 'python' || head === 'python3' || head === 'node') {
    if (head === 'python' || head === 'python3') {
      const basename = (p) => {
        try {
          return String(p).split(/\\\\|\//).pop();
        } catch {
          return String(p);
        }
      };
      let j = i + 1;
      while (j < tokens.length) {
        const t = tokens[j];
        if (!t) break;
        if (/^-/.test(t)) {
          if (t === '-m' || t === '-c' || t === '--') break;
          j++;
          continue;
        }
        const b = basename(t);
        if (b === 'manage_log.py') return `${head}:manage_log`;
        if (b === 'manage_context.py') return `${head}:manage_context`;
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
    if (/python3\s+[^\n]*manage_log\.py/.test(hay) || /manage_log\.py[^\n]*python3/.test(hay)) {
      return 'python3:manage_log';
    }
    if (/\bpython\s+[^\n]*manage_log\.py/.test(hay)) {
      return 'python:manage_log';
    }
    let titleCmd = null;
    const mt = title.match(/^(?:Shell|Terminal)[:\s]+(.+)$/i);
    if (mt && mt[1]) titleCmd = mt[1];
    else if (/shell|terminal/i.test(title)) titleCmd = title;
    const cmdStr = locPath || titleCmd || '';
    if (/terminal|shell/i.test(kind) || cmdStr) {
      let tokens = splitCommandLine(cmdStr.trim());
      const opIdx = tokens.findIndex((t) => t === '&&' || t === '||' || t === ';' || t === '|');
      if (opIdx !== -1) tokens = tokens.slice(0, opIdx);
      if (tokens[0] && /^(bash|sh|zsh)$/.test(tokens[0]) && tokens[1] && /^-?l?c$/.test(tokens[1]) && tokens[2]) {
        const inner = tokens.slice(2).join(' ');
        let innerTokens = splitCommandLine(inner.replace(/^['"]|['"]$/g, ''));
        const innerOp = innerTokens.findIndex((t) => t === '&&' || t === '||' || t === ';' || t === '|');
        if (innerOp !== -1) innerTokens = innerTokens.slice(0, innerOp);
        const key = deriveCommandKeyFromTokens(innerTokens);
        if (key) return key;
      }
      const key = deriveCommandKeyFromTokens(tokens);
      if (key) return key;
    }
    const m = title.trim().split(/\s+/)[0] || 'tool';
    return m.toLowerCase();
  } catch {
    return '';
  }
}

class BackgroundGemini extends EventEmitter {
  constructor({ projectRoot, model } = {}) {
    super();
    this.projectRoot = projectRoot || path.join(__dirname, '..');
    this.model = model || DEFAULT_MODEL;
    this.child = null;
    this.rl = null;
    this.acpPending = new Map();
    this.reqId = 1;
    this.sessionId = null;
    this.readyPromise = null;
    this.ready = false;
    this.queue = [];
    this.running = false;
    this.currentPrompt = null;
    this.lastError = null;
    this.disposed = false;
    this.sessionReadyWaiter = null;
    this.initialPromptSessionId = null;
    this.initialPromptHash = null;
    this.initialPromptPromise = null;
    this.start();
  }

  start() {
    if (this.child || this.disposed) {
      return;
    }
    const spec = buildSpawnSpec({ modelOverride: this.model, projectRoot: this.projectRoot });
    const spawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.projectRoot,
      ...(spec.options || {}),
    };
    if (!spawnOptions.env) {
      spawnOptions.env = process.env;
    }
    this.child = spawn(spec.command, spec.args, spawnOptions);
    try {
      const pid = this.child?.pid;
      if (pid) {
        this.emit('process_start', { pid });
      }
    } catch {}
    this.child.on('error', (err) => {
      this.lastError = err;
      console.error('[BackgroundGemini] spawn error:', err?.message || err);
    });
    let pendingNpmLogPath = null;
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      console.error('[BackgroundGemini STDERR]', text);
      if (!pendingNpmLogPath) {
        const match = text.match(/A complete log of this run can be found in:\s*(.*)/i);
        if (match && match[1]) {
          pendingNpmLogPath = match[1].trim();
        }
      }
    });
    this.child.on('close', (code, signal) => {
      console.warn('[BackgroundGemini] process exited', code, signal);
      if (code && code !== 0 && pendingNpmLogPath) {
        try {
          const logText = fs.readFileSync(pendingNpmLogPath, 'utf8');
          const lines = logText.split(/\r?\n/).filter(Boolean);
          const tail = lines.slice(-40).join('\n');
          if (tail) {
            console.error('[BackgroundGemini] npm failure details:\n' + tail);
          }
        } catch (err) {
          console.error(`[BackgroundGemini] Failed to read npm log ${pendingNpmLogPath}: ${err?.message || err}`);
        }
      }
      pendingNpmLogPath = null;
      this.sessionId = null;
      this.readyPromise = null;
      this.ready = false;
      this.child = null;
      this.initialPromptSessionId = null;
      this.initialPromptHash = null;
      this.initialPromptPromise = null;
      try { this.emit('process_exit', { code, signal }); } catch {}
      if (this.rl) {
        try { this.rl.close(); } catch {}
        this.rl = null;
      }
      const pending = Array.from(this.acpPending.values());
      this.acpPending.clear();
      for (const waiter of pending) {
        try { waiter.reject(new Error('background gemini process exited')); } catch {}
      }
      if (this.currentPrompt && this.currentPrompt.reject) {
        try { this.currentPrompt.reject(new Error('background gemini process exited')); } catch {}
      }
      this.currentPrompt = null;
      this.running = false;
      if (!this.disposed) {
        setTimeout(() => this.start(), 1000);
      }
    });
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    this.readyPromise = this.initialize()
      .then((value) => {
        this.ready = true;
        this.lastError = null;
        if (!backgroundGeminiPreferOffline && !GEMINI_CLI_DISABLE_AUTO_OFFLINE) {
          backgroundGeminiPreferOffline = true;
          try { console.log('[BackgroundGemini] Cached CLI detected; future spawns will prefer offline npm cache.'); } catch {}
        }
        return value;
      })
      .catch((err) => {
        this.ready = false;
        this.lastError = err;
        this.readyPromise = null;
        // Propagate the rejection to callers but prevent unhandled rejection warnings.
        return Promise.reject(err);
      });
    if (this.readyPromise) {
      this.readyPromise.catch(() => {});
    }
  }

  async initialize() {
    let attempts = 0;
    while (attempts < 3) {
      attempts += 1;
      try {
        await this.acpSend('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
        const res = await this.acpSend('session/new', { cwd: this.projectRoot, mcpServers: [] });
        if (res?.sessionId) {
          this.sessionId = res.sessionId;
          this.initialPromptSessionId = null;
          this.initialPromptHash = null;
          this.initialPromptPromise = null;
          try { this.emit('session_ready', { sessionId: this.sessionId }); } catch {}
          return true;
        }
      } catch (err) {
        this.lastError = err;
        console.warn('[BackgroundGemini] initialize attempt failed:', err?.message || err);
      }
    }
    throw this.lastError || new Error('background gemini failed to initialize');
  }

  waitUntilReady() {
    return (this.readyPromise || this.initialize()).then(() => {
      if (!this.sessionId) {
        throw new Error('background session not ready');
      }
      return this.sessionId;
    });
  }

  waitForSessionReady() {
    if (this.ready && this.sessionId) {
      return Promise.resolve({ sessionId: this.sessionId });
    }
    if (this.sessionReadyWaiter) {
      return this.sessionReadyWaiter.promise;
    }
    let resolveFn;
    let rejectFn;
    const cleanup = () => {
      if (this.sessionReadyWaiter) {
        this.off('session_ready', onReady);
        this.off('process_exit', onExit);
        this.sessionReadyWaiter = null;
      }
    };
    const onReady = (info) => {
      cleanup();
      resolveFn(info);
    };
    const onExit = () => {
      cleanup();
      rejectFn(new Error('background session exited before ready'));
    };
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.once('session_ready', onReady);
    this.once('process_exit', onExit);
    this.sessionReadyWaiter = { promise, resolve: resolveFn, reject: rejectFn };
    return promise;
  }

  async ensureInitialPrompt(promptText, { metadata = null } = {}) {
    const text = typeof promptText === 'string' ? promptText.trim() : '';
    if (!text) return false;
    const sessionId = await this.waitUntilReady();
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    if (this.initialPromptSessionId === sessionId && this.initialPromptHash === hash && !this.initialPromptPromise) {
      return false;
    }
    if (this.initialPromptSessionId === sessionId && this.initialPromptHash === hash && this.initialPromptPromise) {
      try {
        await this.initialPromptPromise;
        return false;
      } catch {}
    }
    const payload = {
      sessionId,
      prompt: [{ type: 'text', text }],
    };
    if (metadata && typeof metadata === 'object') {
      payload.metadata = metadata;
    }
    this.initialPromptSessionId = sessionId;
    this.initialPromptHash = hash;
    const sendPromise = this.acpSend('session/prompt', payload)
      .then(() => true)
      .finally(() => {
        if (this.initialPromptPromise === sendPromise) {
          this.initialPromptPromise = null;
        }
      });
    this.initialPromptPromise = sendPromise;
    try {
      return await sendPromise;
    } catch (err) {
      if (this.initialPromptSessionId === sessionId && this.initialPromptHash === hash) {
        this.initialPromptSessionId = null;
        this.initialPromptHash = null;
      }
      throw err;
    }
  }

  handleLine(line) {
    logAcp('<-', line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.warn('[BackgroundGemini] failed to parse line:', line);
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.acpPending.get(msg.id);
      if (!pending) return;
      this.acpPending.delete(msg.id);
      if (msg.error) {
        pending.reject(msg.error);
      } else {
        pending.resolve(msg.result);
        if (pending.method === 'session/prompt' && this.currentPrompt) {
          if (!this.currentPrompt.resolved) {
            this.currentPrompt.resolve({ text: this.currentPrompt.text || '', stopReason: msg.result?.stopReason || 'end_turn' });
            this.currentPrompt.resolved = true;
            this.currentPrompt = null;
            this.running = false;
            this.drain();
          }
        }
      }
      return;
    }
    if (typeof msg.method === 'string') {
      switch (msg.method) {
        case 'session/update':
          this.handleSessionUpdate(msg.params?.update);
          break;
        case 'session/request_permission':
          this.handlePermissionRequest(msg);
          break;
        case 'session/request_tool_result':
          this.respond(msg.id, { outcome: { outcome: 'rejected' } });
          break;
        default:
          break;
      }
    }
  }

  handleSessionUpdate(update) {
    if (!update) return;
    const now = Date.now();
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (this.currentPrompt) {
          const raw = update.content?.type === 'text' ? update.content.text : '';
          if (raw && raw !== this.currentPrompt.text) {
            if (raw.startsWith(this.currentPrompt.text || '')) {
              this.currentPrompt.text = raw;
            } else {
              this.currentPrompt.text = (this.currentPrompt.text || '') + raw;
            }
          }
        }
        break;
      case 'end_of_turn':
        if (this.currentPrompt && !this.currentPrompt.resolved) {
          this.currentPrompt.resolve({ text: this.currentPrompt.text || '', stopReason: update.stopReason || 'end_turn' });
          this.currentPrompt.resolved = true;
          this.currentPrompt = null;
          this.running = false;
          this.drain();
        }
        break;
      case 'response.completed':
        if (this.currentPrompt && !this.currentPrompt.resolved) {
          this.currentPrompt.resolve({ text: this.currentPrompt.text || '', stopReason: update.stopReason || 'end_turn' });
          this.currentPrompt.resolved = true;
          this.currentPrompt = null;
          this.running = false;
          this.drain();
        }
        break;
      default:
        break;
    }
  }

  handlePermissionRequest(msg) {
    const tc = msg.params?.toolCall;
    const opts = msg.params?.options || [];
    const allowOnce = opts.find((o) => o.kind === 'allow_once') || opts.find((o) => o.optionId === 'proceed_once') || opts[0];
    const denyOpt = opts.find((o) => o.kind === 'deny') || opts.find((o) => o.optionId === 'cancel');
    if (!tc) {
      if (denyOpt?.optionId) {
        this.respond(msg.id, { outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
      } else {
        this.respond(msg.id, { outcome: { outcome: 'rejected' } });
      }
      return;
    }
    const cmdKey = deriveCommandKey(tc);
    const rawLabel = tc.title || String(tc.kind || 'tool');
    const locPath = (tc.locations && tc.locations[0] && tc.locations[0].path) ? String(tc.locations[0].path) : '';
    const hay = `${rawLabel} ${locPath}`.toLowerCase();
    const isPython = (
      cmdKey === 'python' || cmdKey === 'python3' ||
      cmdKey === 'python:manage_log' || cmdKey === 'python3:manage_log' ||
      cmdKey === 'python:manage_context' || cmdKey === 'python3:manage_context' ||
      cmdKey === 'shell:python3'
    );
    const allowed = isPython && (hay.includes('manage_log.py') || hay.includes('manage_context.py') || hay.includes('notify_tool.py'));
    if (allowed) {
      const optionId = allowOnce?.optionId || 'proceed_once';
      this.respond(msg.id, { outcome: { outcome: 'selected', optionId } });
    } else if (denyOpt?.optionId) {
      this.respond(msg.id, { outcome: { outcome: 'selected', optionId: denyOpt.optionId } });
    } else {
      this.respond(msg.id, { outcome: { outcome: 'rejected' } });
    }
  }

  respond(id, result) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return;
    const payload = { jsonrpc: '2.0', id, result };
    try {
      const raw = JSON.stringify(payload);
      logAcp('->', raw);
      this.child.stdin.write(raw + '\n');
    } catch (err) {
      console.warn('[BackgroundGemini] failed to respond:', err?.message || err);
    }
  }

  acpSend(method, params) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error('background gemini not running'));
    }
    const id = this.reqId++;
    const req = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.acpPending.set(id, { method, resolve, reject });
      try {
        const raw = JSON.stringify(req);
        logAcp('->', raw);
        this.child.stdin.write(raw + '\n');
      } catch (err) {
        this.acpPending.delete(id);
        reject(err);
      }
    });
  }

  async promptText(promptText, { timeoutMs = 45000, hidden = false } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ promptText, timeoutMs, hidden, resolve, reject });
      this.drain();
    });
  }

  isReady() {
    return Boolean(this.ready && this.sessionId && !this.disposed);
  }

  async executePrompt(promptText, timeoutMs, hidden) {
    await (this.readyPromise || this.initialize());
    if (!this.sessionId) throw new Error('background session not ready');
    if (this.currentPrompt && !this.currentPrompt.resolved) {
      throw new Error('prompt already running');
    }
    const record = {
      text: '',
      resolved: false,
      resolve: null,
      reject: null,
    };
    const resultPromise = new Promise((resolve, reject) => {
      record.resolve = resolve;
      record.reject = reject;
    });
    this.currentPrompt = record;
    const timer = setTimeout(() => {
      if (this.currentPrompt && !this.currentPrompt.resolved) {
        this.currentPrompt.reject(new Error('background prompt timeout'));
        this.currentPrompt.resolved = true;
        this.currentPrompt = null;
        this.running = false;
        this.drain();
      }
    }, timeoutMs);
    resultPromise.finally(() => clearTimeout(timer)).catch(() => {});
    try {
      await this.acpSend('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: promptText }],
        hidden: Boolean(hidden),
      });
    } catch (err) {
      if (this.currentPrompt && !this.currentPrompt.resolved) {
        this.currentPrompt.reject(err);
        this.currentPrompt.resolved = true;
        this.currentPrompt = null;
        this.running = false;
        this.drain();
      }
    }
    return resultPromise;
  }

  drain() {
    if (this.running) return;
    if (!this.queue.length) return;
    const next = this.queue.shift();
    this.running = true;
    this.executePrompt(next.promptText, next.timeoutMs, next.hidden)
      .then((value) => {
        try {
          next.resolve(value);
        } catch {}
      })
      .catch((err) => {
        try {
          next.reject(err);
        } catch {}
      });
  }

  dispose() {
    this.disposed = true;
    this.ready = false;
    this.readyPromise = null;
    this.queue.splice(0).forEach((job) => {
      try { job.reject(new Error('background gemini disposed')); } catch {}
    });
    if (this.currentPrompt && !this.currentPrompt.resolved) {
      try { this.currentPrompt.reject(new Error('background gemini disposed')); } catch {}
    }
    this.currentPrompt = null;
    if (this.sessionReadyWaiter) {
      try { this.sessionReadyWaiter.reject(new Error('background gemini disposed')); } catch {}
      this.sessionReadyWaiter = null;
    }
    this.initialPromptSessionId = null;
    this.initialPromptHash = null;
    this.initialPromptPromise = null;
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    this.acpPending.clear();
    this.running = false;
    try { this.emit('disposed'); } catch {}
  }
}

module.exports = BackgroundGemini;
