const { createServer } = require('http')
const http = require('http')
const https = require('https')
const next = require('next')
const { parse } = require('url')
const path = require('path')

const RESCUE_DEFAULT_PORT = Number.parseInt(process.env.RESCUE_APP_PORT || process.env.PORT || '', 10) || 3001

function normalizePath(value) {
  if (!value) return ''
  let pathValue = String(value).trim()
  if (!pathValue) return ''
  const hashIdx = pathValue.indexOf('#')
  if (hashIdx !== -1) {
    pathValue = pathValue.slice(0, hashIdx)
  }
  const queryIdx = pathValue.indexOf('?')
  if (queryIdx !== -1) {
    pathValue = pathValue.slice(0, queryIdx)
  }
  if (!pathValue.startsWith('/')) {
    pathValue = `/${pathValue}`
  }
  pathValue = pathValue.replace(/\/{2,}/g, '/')
  while (pathValue.length > 1 && pathValue.endsWith('/')) {
    pathValue = pathValue.slice(0, -1)
  }
  return pathValue.toLowerCase()
}

const LOCAL_API_PREFIXES = (() => {
  const raw = process.env.RESCUE_LOCAL_API_PREFIXES || process.env.RESCUE_LOCAL_API_ROUTES || ''
  const fromEnv = raw
    .split(',')
    .map((entry) => normalizePath(entry))
    .filter(Boolean)
  const defaults = ['/api/settings']
  const normalizedDefaults = defaults.map((entry) => normalizePath(entry)).filter(Boolean)
  const merged = [...new Set([...fromEnv, ...normalizedDefaults])]
  return merged
})()
console.log('[Rescue] Local API prefixes:', LOCAL_API_PREFIXES)

process.env.RESCUE_APP_ACTIVE = 'true'
process.env.RESCUE_SERVER = 'true'

let backendOrigin = process.env.RESCUE_BACKEND_ORIGIN || process.env.RESCUE_PROXY_ORIGIN || null
if (!backendOrigin) {
  const fallbackPort = Number.parseInt(process.env.DEFAULT_PORT || '3000', 10)
  const normalizedPort = Number.isFinite(fallbackPort) && fallbackPort > 0 ? fallbackPort : 3000
  backendOrigin = `http://127.0.0.1:${normalizedPort}`
  process.env.RESCUE_BACKEND_ORIGIN = backendOrigin
}

let nextApp = null
let requestHandler = null
let serverInstance = null
let listenPromise = null
let currentHostname = null
let currentPort = null

const readyListeners = []

function setBackendOrigin(origin) {
  if (typeof origin !== 'string' || origin.trim() === '') {
    return
  }
  backendOrigin = origin
  process.env.RESCUE_BACKEND_ORIGIN = origin
}

function onServerReady(cb) {
  if (typeof cb !== 'function') return
  readyListeners.push(cb)
  if (serverInstance?.listening) {
    const addressInfo = serverInstance.address()
    const hostname = currentHostname || (typeof addressInfo === 'object' && addressInfo ? addressInfo.address : 'localhost')
    const port = currentPort || (typeof addressInfo === 'object' && addressInfo ? addressInfo.port : RESCUE_DEFAULT_PORT)
    try {
      cb({ scheme: 'http', hostname, port, server: serverInstance })
    } catch (err) {
      console.warn('[Rescue] onServerReady callback failed:', err?.message || err)
    }
  }
}

async function prepareNextApp() {
  if (nextApp && requestHandler) {
    return
  }
  const dev = process.env.NODE_ENV !== 'production'
  const hostname = process.env.RESCUE_APP_HOST || process.env.RESCUE_HOST || process.env.HOST || '0.0.0.0'
  const requestedPort = Number.parseInt(process.env.PORT || process.env.RESCUE_APP_PORT || '', 10)
  const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : RESCUE_DEFAULT_PORT
  nextApp = next({ dev, hostname, port, dir: path.join(__dirname) })
  requestHandler = nextApp.getRequestHandler()
  await nextApp.prepare()
}

function isLocalApiPath(pathname) {
  const normalized = normalizePath(pathname)
  if (!normalized) return false
  for (const prefix of LOCAL_API_PREFIXES) {
    if (!prefix) continue
    if (prefix.endsWith('/*')) {
      const base = normalizePath(prefix.slice(0, -2))
      if (!base) continue
      if (normalized === base || normalized.startsWith(`${base}/`)) return true
      continue
    }
    if (normalized === prefix) return true
    if (normalized.startsWith(`${prefix}/`)) return true
  }
  return false
}

function shouldProxyToBackend(pathname) {
  const normalized = normalizePath(pathname)
  if (!normalized) return false
  if (isLocalApiPath(normalized)) return false
  if (normalized === '/api') return true
  return normalized.startsWith('/api/')
}

function proxyHttpRequest(req, res) {
  if (!backendOrigin) {
    res.statusCode = 502
    res.end('Rescue backend origin is not available')
    return
  }
  let target
  try {
    target = new URL(req.url || '/', backendOrigin)
  } catch (err) {
    res.statusCode = 502
    res.end('Failed to resolve backend origin')
    return
  }

  const isHttps = target.protocol === 'https:'
  const proxyModule = isHttps ? https : http

  const headers = { ...req.headers }
  headers.host = target.host
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http'
  headers['x-forwarded-port'] = String(req.socket.localPort || currentPort || '')

  const proxyReq = proxyModule.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )

  proxyReq.on('error', (err) => {
    console.error('[Rescue] Proxy request failed:', err?.message || err)
    if (!res.headersSent) {
      res.statusCode = 502
    }
    try { res.end('Failed to reach main server') } catch {}
  })

  req.pipe(proxyReq)
}

function createRequestListener() {
  return (req, res) => {
    const rawUrl = req.url || ''
    const parsedUrl = parse(rawUrl, true)
    const pathname = parsedUrl.pathname || rawUrl
    const normalizedPathname = normalizePath(pathname)
    if (isLocalApiPath(normalizedPathname)) {
      requestHandler(req, res, parsedUrl)
      return
    }
    if (shouldProxyToBackend(normalizedPathname)) {
      proxyHttpRequest(req, res)
      return
    }
    requestHandler(req, res, parsedUrl)
  }
}

function notifyReady() {
  const addressInfo = serverInstance?.address()
  const hostname = currentHostname || (typeof addressInfo === 'object' && addressInfo ? addressInfo.address : 'localhost')
  const port = currentPort || (typeof addressInfo === 'object' && addressInfo ? addressInfo.port : RESCUE_DEFAULT_PORT)
  for (const cb of readyListeners) {
    try {
      cb({ scheme: 'http', hostname, port, server: serverInstance })
    } catch (err) {
      console.warn('[Rescue] onServerReady callback failed:', err?.message || err)
    }
  }
}

async function startHttpServer() {
  await prepareNextApp()

  const hostname = process.env.RESCUE_APP_HOST || process.env.RESCUE_HOST || process.env.HOST || '0.0.0.0'
  const requestedPort = Number.parseInt(process.env.PORT || process.env.RESCUE_APP_PORT || '', 10)
  const preferredPort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : RESCUE_DEFAULT_PORT
  const portCandidates = [preferredPort]
  if (!portCandidates.includes(preferredPort + 1)) {
    portCandidates.push(preferredPort + 1)
  }
  if (!portCandidates.includes(0)) {
    portCandidates.push(0)
  }

  let lastError = null
  for (const candidate of portCandidates) {
    const server = createServer(createRequestListener())
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve(null)
        }
        server.once('error', onError)
        server.listen(candidate, hostname, onListening)
      })

      serverInstance = server
      currentHostname = hostname
      const addressInfo = server.address()
      currentPort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : candidate
      server.on('error', (err) => {
        console.error('[Rescue] Server error:', err?.message || err)
      })
      notifyReady()
      return
    } catch (err) {
      lastError = err
      try { server.close() } catch {}
      if (err?.code === 'EADDRINUSE') {
        console.warn(`[Rescue] Port ${candidate} in use, trying next candidate.`)
        continue
      }
      throw err
    }
  }

  if (lastError) {
    throw lastError
  }
}

async function ensureServerListening() {
  if (serverInstance?.listening) {
    return
  }
  if (listenPromise) {
    return listenPromise
  }
  listenPromise = (async () => {
    try {
      await startHttpServer()
    } finally {
      listenPromise = null
    }
  })()
  return listenPromise
}

async function shutdownServer() {
  if (listenPromise) {
    await listenPromise.catch(() => {})
  }
  if (serverInstance) {
    const toClose = serverInstance
    serverInstance = null
    await new Promise((resolve, reject) => {
      toClose.close((err) => {
        if (err) reject(err)
        else resolve(null)
      })
    }).catch((err) => {
      console.warn('[Rescue] Failed to close server cleanly:', err?.message || err)
    })
  }
  if (nextApp) {
    try {
      await nextApp.close()
    } catch (err) {
      console.warn('[Rescue] Failed to close Next app:', err?.message || err)
    }
    nextApp = null
    requestHandler = null
  }
}

async function restartServer() {
  await shutdownServer()
  await ensureServerListening()
}

module.exports = {
  onServerReady,
  ensureServerListening,
  restartServer,
  shutdownServer,
  setBackendOrigin,
}
