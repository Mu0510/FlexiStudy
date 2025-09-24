#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_SERVER_MODULE = './server';

function resolveServerModuleOverride() {
  const args = Array.isArray(process.argv) ? process.argv.slice(2) : [];
  let override = process.env.SERVER_MODULE;
  for (const arg of args) {
    if (typeof arg === 'string' && arg.startsWith('--server-module=')) {
      override = arg.slice('--server-module='.length);
    }
  }
  return override;
}

function resolveServerModulePath(raw) {
  if (!raw) {
    return path.resolve(__dirname, DEFAULT_SERVER_MODULE);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return path.resolve(__dirname, DEFAULT_SERVER_MODULE);
  }
  if (trimmed.startsWith('.')) {
    return path.resolve(__dirname, trimmed);
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(__dirname, trimmed);
}

const serverModulePath = resolveServerModulePath(resolveServerModuleOverride());
const serverModuleDir = path.dirname(serverModulePath);
console.log(`[Wrapper] Loading server module from ${serverModulePath}`);

function normalizeServerControl(raw, seen = new Set()) {
  if (!raw) {
    throw new Error('Server module did not export a control object');
  }
  if (typeof raw === 'function') {
    return raw;
  }
  if (typeof raw !== 'object') {
    throw new Error('Server module export is not an object');
  }
  if (seen.has(raw)) {
    throw new Error('Server module export resolution cycle detected');
  }
  seen.add(raw);

  const keys = ['restartServer', 'requestServerRestart', 'onServerReady', 'startGemini'];
  const hasExpectedKey = keys.some((key) => typeof raw[key] === 'function');
  if (hasExpectedKey) {
    return raw;
  }
  if (raw.default && typeof raw.default === 'object') {
    return normalizeServerControl(raw.default, seen);
  }
  return raw;
}

let currentServerControl = null;
let onServerReady = () => () => {};
let restartServer = async () => {};
let shutdownServer = async () => {};
let ensureServerListening = async () => {};
let startGemini = () => {};
let isGeminiRunning = () => false;
let getWebSocketServer = () => null;
let registerRestartHandler = () => {};
let notifyClientsOfReload = () => {};

let removeServerReadyListener = null;

function assignServerControl(control) {
  currentServerControl = normalizeServerControl(control);

  onServerReady = typeof currentServerControl.onServerReady === 'function'
    ? currentServerControl.onServerReady.bind(currentServerControl)
    : () => () => {};

  restartServer = typeof currentServerControl.restartServer === 'function'
    ? currentServerControl.restartServer.bind(currentServerControl)
    : async () => {};

  shutdownServer = typeof currentServerControl.shutdownServer === 'function'
    ? currentServerControl.shutdownServer.bind(currentServerControl)
    : async () => {};

  ensureServerListening = typeof currentServerControl.ensureServerListening === 'function'
    ? currentServerControl.ensureServerListening.bind(currentServerControl)
    : async () => {};

  startGemini = typeof currentServerControl.startGemini === 'function'
    ? currentServerControl.startGemini.bind(currentServerControl)
    : () => {};

  isGeminiRunning = typeof currentServerControl.isGeminiRunning === 'function'
    ? currentServerControl.isGeminiRunning.bind(currentServerControl)
    : () => false;

  getWebSocketServer = typeof currentServerControl.getWebSocketServer === 'function'
    ? currentServerControl.getWebSocketServer.bind(currentServerControl)
    : () => null;

  registerRestartHandler = typeof currentServerControl.registerRestartHandler === 'function'
    ? currentServerControl.registerRestartHandler.bind(currentServerControl)
    : () => {};

  notifyClientsOfReload = typeof currentServerControl.notifyClientsOfReload === 'function'
    ? currentServerControl.notifyClientsOfReload.bind(currentServerControl)
    : () => {};
}

function detachServerControlListeners() {
  if (removeServerReadyListener) {
    try { removeServerReadyListener(); } catch {}
    removeServerReadyListener = null;
  }
  try {
    registerRestartHandler(null);
  } catch {}
}

function attachServerControlListeners() {
  try {
    registerRestartHandler((reason) => scheduleRestart(reason));
  } catch (err) {
    console.warn('[Wrapper] Failed to register restart handler:', err?.message || err);
  }
  try {
    removeServerReadyListener = onServerReady((context) => handleServerReady(context));
  } catch (err) {
    removeServerReadyListener = null;
    console.warn('[Wrapper] Failed to attach onServerReady listener:', err?.message || err);
  }
}

assignServerControl(require(serverModulePath));
attachServerControlListeners();

const rescueServerModulePath = path.resolve(__dirname, 'rescue-chat-app', 'rescue-server');
let rescueControl = null;
if (path.resolve(serverModulePath) !== path.resolve(rescueServerModulePath)) {
  try {
    console.log(`[Wrapper] Loading rescue chat server module from ${rescueServerModulePath}`);
    rescueControl = require(rescueServerModulePath);
  } catch (err) {
    console.warn('[Wrapper] Failed to load rescue chat server module:', err?.message || err);
  }
}

const rescueOnReady = typeof rescueControl?.onServerReady === 'function'
  ? rescueControl.onServerReady.bind(rescueControl)
  : null;
const rescueRestartServer = typeof rescueControl?.restartServer === 'function'
  ? rescueControl.restartServer.bind(rescueControl)
  : null;
const rescueShutdownServer = typeof rescueControl?.shutdownServer === 'function'
  ? rescueControl.shutdownServer.bind(rescueControl)
  : null;
const rescueEnsureServerListening = typeof rescueControl?.ensureServerListening === 'function'
  ? rescueControl.ensureServerListening.bind(rescueControl)
  : null;
const rescueSetBackendOrigin = typeof rescueControl?.setBackendOrigin === 'function'
  ? rescueControl.setBackendOrigin.bind(rescueControl)
  : null;

const runtimeDir = path.join(__dirname, 'mnt', 'runtime');
const pidFilePath = path.join(runtimeDir, 'server-wrapper.pid');

function writePidFile() {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(pidFilePath, String(process.pid));
  } catch (err) {
    console.warn('[Wrapper] Failed to write PID file:', err?.message || err);
  }
}

function removePidFile() {
  try {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
  } catch (err) {
    console.warn('[Wrapper] Failed to remove PID file:', err?.message || err);
  }
}

writePidFile();

let hasStartedGemini = false;
let restartInFlight = null;

function ensureGemini(wss) {
  if (isGeminiRunning()) {
    if (!hasStartedGemini) {
      console.log('[Wrapper] Gemini process already running, reusing existing instance.');
      hasStartedGemini = true;
    }
    return;
  }
  try {
    console.log('[Wrapper] Starting Gemini process from wrapper...');
    startGemini(wss);
    hasStartedGemini = true;
  } catch (err) {
    console.error('[Wrapper] Failed to start Gemini process:', err?.message || err);
  }
}

function handleServerReady({ scheme, hostname: mainHostname, port: mainPort, wss }) {
  ensureGemini(wss);
  if (rescueSetBackendOrigin && mainHostname) {
    const numericPort = Number(mainPort);
    if (Number.isFinite(numericPort) && numericPort > 0) {
      const origin = `${scheme || 'http'}://${mainHostname}:${numericPort}`;
      try {
        rescueSetBackendOrigin(origin);
      } catch (err) {
        console.warn('[Wrapper] Failed to propagate backend origin to rescue server:', err?.message || err);
      }
    }
  }
  if (rescueEnsureServerListening) {
    rescueEnsureServerListening().catch((err) => {
      console.error('[Wrapper] Failed to start rescue chat server:', err?.message || err);
    });
  }
}

if (rescueOnReady) {
  rescueOnReady(({ scheme, hostname: rescueHost, port: rescuePort }) => {
    try {
      console.log(`[Wrapper] Rescue chat server ready on ${scheme}://${rescueHost}:${rescuePort}`);
    } catch {}
  });
}

const HARD_RELOAD_REASONS = new Set(['hard-reload', 'server-module-change', 'wrapper-hard-reload', 'sighup']);
let hardReloadPendingReason = null;
const restartCompletionListeners = [];

function flushRestartCompletionListeners() {
  if (!restartCompletionListeners.length) {
    return;
  }
  const listeners = restartCompletionListeners.splice(0, restartCompletionListeners.length);
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.warn('[Wrapper] Restart completion listener failed:', err?.message || err);
    }
  }
}

function isHardReloadReason(reason) {
  if (!reason) return false;
  const trimmed = String(reason).trim().toLowerCase();
  return HARD_RELOAD_REASONS.has(trimmed);
}

function scheduleRestart(reason) {
  const pendingHard = hardReloadPendingReason;
  let hardReloadReason = pendingHard || (isHardReloadReason(reason) ? (reason || 'hard-reload') : null);

  if (restartInFlight) {
    if (hardReloadReason) {
      hardReloadPendingReason = hardReloadReason;
      restartCompletionListeners.push(() => {
        const pending = hardReloadPendingReason;
        if (pending) {
          hardReloadPendingReason = null;
          scheduleRestart(pending);
        }
      });
    }
    console.log(`[Wrapper] Restart already in progress; ignoring ${reason || 'request'}.`);
    return restartInFlight;
  }

  if (hardReloadReason) {
    hardReloadPendingReason = null;
  }

  const restartReason = reason || hardReloadReason || 'manual';
  const isHard = Boolean(hardReloadReason);
  console.log(`[Wrapper] ${isHard ? 'Hard reloading' : 'Restarting'} HTTP server (${restartReason}).`);
  try {
    notifyClientsOfReload(restartReason);
  } catch (err) {
    console.warn('[Wrapper] Failed to notify clients of reload:', err?.message || err);
  }
  restartInFlight = (async () => {
    let mainError = null;
    try {
      if (isHard) {
        await reloadServerModule(hardReloadReason || restartReason);
      } else {
        await restartServer();
      }
    } catch (err) {
      mainError = err;
      console.error(`[Wrapper] HTTP server ${isHard ? 'hard reload' : 'restart'} failed:`, err?.message || err);
    }
    if (rescueRestartServer) {
      try {
        await rescueRestartServer();
      } catch (err) {
        console.error('[Wrapper] Rescue chat server restart failed:', err?.message || err);
      }
    }
    if (mainError) throw mainError;
  })()
    .catch((err) => {
      if (!err) return;
      console.error('[Wrapper] Restart encountered an error:', err?.message || err);
    })
    .finally(() => {
      restartInFlight = null;
      const wss = getWebSocketServer();
      if (wss) ensureGemini(wss);
      flushRestartCompletionListeners();
    });
  return restartInFlight;
}

function requestHardReload(reason) {
  const effectiveReason = reason || 'hard-reload';
  if (!hardReloadPendingReason) {
    hardReloadPendingReason = effectiveReason;
  }
  if (restartInFlight) {
    restartCompletionListeners.push(() => {
      const pending = hardReloadPendingReason;
      if (pending) {
        hardReloadPendingReason = null;
        scheduleRestart(pending);
      }
    });
    return;
  }
  const pending = hardReloadPendingReason || effectiveReason;
  hardReloadPendingReason = null;
  scheduleRestart(pending);
}

async function reloadServerModule(reason) {
  const previousControl = currentServerControl;
  const previousEnsure = ensureServerListening;
  const previousShutdown = shutdownServer;
  const previousRestart = restartServer;

  console.log(`[Wrapper] Reloading server module (${reason || 'hard-reload'}).`);

  detachServerControlListeners();

  try {
    if (typeof previousShutdown === 'function') {
      await previousShutdown();
    } else if (typeof previousRestart === 'function') {
      await previousRestart();
    }
  } catch (err) {
    console.warn('[Wrapper] Failed to stop HTTP server before reload:', err?.message || err);
  }

  purgeServerModuleCache();

  let nextControlRaw;
  try {
    nextControlRaw = require(serverModulePath);
  } catch (err) {
    console.error('[Wrapper] Failed to load server module during hard reload:', err?.message || err);
    assignServerControl(previousControl);
    attachServerControlListeners();
    if (typeof previousEnsure === 'function') {
      try { await previousEnsure(); } catch (restoreErr) {
        console.error('[Wrapper] Failed to restore previous server after reload failure:', restoreErr?.message || restoreErr);
      }
    }
    throw err;
  }

  assignServerControl(nextControlRaw);
  attachServerControlListeners();

  try {
    if (typeof ensureServerListening === 'function') {
      await ensureServerListening();
    }
  } catch (err) {
    console.error('[Wrapper] ensureServerListening failed after loading new server module:', err?.message || err);
    const newShutdown = shutdownServer;
    detachServerControlListeners();
    if (typeof newShutdown === 'function' && newShutdown !== previousShutdown) {
      try { await newShutdown(); } catch (shutdownErr) {
        console.warn('[Wrapper] Failed to shut down new server after reload failure:', shutdownErr?.message || shutdownErr);
      }
    }
    assignServerControl(previousControl);
    attachServerControlListeners();
    if (typeof previousEnsure === 'function') {
      try { await previousEnsure(); } catch (restoreErr) {
        console.error('[Wrapper] Failed to restore previous server after reload failure:', restoreErr?.message || restoreErr);
      }
    }
    throw err;
  }
}

function purgeServerModuleCache() {
  try {
    const resolved = require.resolve(serverModulePath);
    const visited = new Set();
    (function purge(id) {
      if (!id || visited.has(id)) return;
      visited.add(id);
      const cached = require.cache[id];
      if (!cached) return;
      for (const child of cached.children) {
        if (child && typeof child.id === 'string' && child.id.startsWith(serverModuleDir)) {
          purge(child.id);
        }
      }
      delete require.cache[id];
    })(resolved);
  } catch (err) {
    console.warn('[Wrapper] Failed to purge server module cache:', err?.message || err);
  }
}

const watchedFiles = [];

function setupServerModuleWatcher() {
  const target = serverModulePath;
  try {
    fs.accessSync(target, fs.constants.F_OK);
  } catch (err) {
    console.warn('[Wrapper] Unable to watch server module for changes:', err?.message || err);
    return;
  }
  const relative = path.relative(process.cwd(), target) || target;
  let coolingDown = false;
  fs.watchFile(target, { interval: 500 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) {
      return;
    }
    if (coolingDown) {
      return;
    }
    coolingDown = true;
    console.log(`[Wrapper] Detected change in ${relative}; scheduling hard reload.`);
    requestHardReload('server-module-change');
    setTimeout(() => {
      coolingDown = false;
    }, 250);
  });
  watchedFiles.push(target);
}

function disposeFileWatchers() {
  while (watchedFiles.length) {
    const target = watchedFiles.pop();
    try {
      fs.unwatchFile(target);
    } catch {}
  }
}

setupServerModuleWatcher();

async function gracefulShutdown(signal) {
  console.log(`[Wrapper] Received ${signal}, shutting down gracefully...`);
  try {
    if (restartInFlight) {
      await restartInFlight.catch(() => {});
    }
    await shutdownServer();
    if (rescueShutdownServer) {
      await rescueShutdownServer().catch((err) => {
        console.warn('[Wrapper] Failed to shut down rescue chat server:', err?.message || err);
      });
    }
  } catch (err) {
    console.error('[Wrapper] Shutdown encountered an error:', err?.message || err);
  } finally {
    disposeFileWatchers();
    detachServerControlListeners();
    removePidFile();
    process.exit(0);
  }
}

process.on('SIGHUP', () => scheduleRestart('SIGHUP'));
process.on('SIGUSR2', () => scheduleRestart('SIGUSR2'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('exit', () => {
  disposeFileWatchers();
  detachServerControlListeners();
  removePidFile();
});

process.on('uncaughtException', (err) => {
  console.error('[Wrapper] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Wrapper] Unhandled rejection:', reason);
});
