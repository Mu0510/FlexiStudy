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
console.log(`[Wrapper] Loading server module from ${serverModulePath}`);

const serverControl = require(serverModulePath);

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

const {
  onServerReady,
  restartServer,
  shutdownServer,
  startGemini,
  isGeminiRunning,
  getWebSocketServer,
  registerRestartHandler,
  notifyClientsOfReload,
} = serverControl;

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

onServerReady(({ scheme, hostname: mainHostname, port: mainPort, wss }) => {
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
});

if (rescueOnReady) {
  rescueOnReady(({ scheme, hostname: rescueHost, port: rescuePort }) => {
    try {
      console.log(`[Wrapper] Rescue chat server ready on ${scheme}://${rescueHost}:${rescuePort}`);
    } catch {}
  });
}

function scheduleRestart(reason) {
  if (restartInFlight) {
    console.log(`[Wrapper] Restart already in progress; ignoring ${reason || 'request'}.`);
    return restartInFlight;
  }
  const restartReason = reason || 'manual';
  console.log(`[Wrapper] Restarting HTTP server (${restartReason}).`);
  try {
    notifyClientsOfReload(restartReason);
  } catch (err) {
    console.warn('[Wrapper] Failed to notify clients of reload:', err?.message || err);
  }
  restartInFlight = (async () => {
    let mainError = null;
    try {
      await restartServer();
    } catch (err) {
      mainError = err;
      console.error('[Wrapper] HTTP server restart failed:', err?.message || err);
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
    });
  return restartInFlight;
}

registerRestartHandler((reason) => scheduleRestart(reason));

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
    removePidFile();
    process.exit(0);
  }
}

process.on('SIGHUP', () => scheduleRestart('SIGHUP'));
process.on('SIGUSR2', () => scheduleRestart('SIGUSR2'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('exit', () => {
  removePidFile();
});

process.on('uncaughtException', (err) => {
  console.error('[Wrapper] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Wrapper] Unhandled rejection:', reason);
});
