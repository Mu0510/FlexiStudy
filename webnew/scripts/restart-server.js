#!/usr/bin/env node

const http = require('http');
const https = require('https');
const { URL } = require('url');

function fail(message, exitCode = 1) {
  console.error(`[server:restart] ${message}`);
  process.exit(exitCode);
}

const defaultUrl = process.env.NODE_ENV === 'production'
  ? 'https://localhost/api/server/restart'
  : 'https://localhost:443/api/server/restart';
const target = process.env.SERVER_RESTART_URL || defaultUrl;

let parsedUrl;
try {
  parsedUrl = new URL(target);
} catch (err) {
  fail(`Invalid SERVER_RESTART_URL "${target}": ${err?.message || err}`);
}

const useHttps = parsedUrl.protocol === 'https:';
const transport = useHttps ? https : http;

if (useHttps && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  // Allow connecting to the local self-signed development certificate.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const timeoutMs = Number.parseInt(process.env.SERVER_RESTART_TIMEOUT_MS || '5000', 10);

const payload = JSON.stringify({
  reason: 'cli-signal',
  requestedAt: Date.now(),
});

const options = {
  hostname: parsedUrl.hostname,
  port: parsedUrl.port || (useHttps ? 443 : 80),
  path: `${parsedUrl.pathname || ''}${parsedUrl.search || ''}` || '/api/server/restart',
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'accept': 'application/json',
  },
  timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
};

const req = transport.request(options, (res) => {
  const { statusCode = 0 } = res;
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    let parsed;
    if (body) {
      try { parsed = JSON.parse(body); } catch {}
    }

    if (statusCode >= 200 && statusCode < 300) {
      const statusText = parsed?.status ? ` (${parsed.status})` : '';
      console.log(`[server:restart] Restart request accepted${statusText}.`);
      if (parsed?.scheduledAt) {
        console.log(`[server:restart] Scheduled at ${new Date(parsed.scheduledAt).toISOString()}.`);
      }
      process.exit(0);
      return;
    }

    const detail = parsed?.error || parsed?.message || body || 'unknown error';
    fail(`Server responded with HTTP ${statusCode}: ${detail}`);
  });
});

req.on('timeout', () => {
  req.destroy(new Error(`Request timed out after ${options.timeout}ms`));
});

req.on('error', (err) => {
  fail(`Failed to request restart: ${err?.message || err}`);
});

req.write(payload);
req.end();
