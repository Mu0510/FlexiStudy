const { createServer } = require('http')
const http = require('http')
const https = require('https')
const next = require('next')
const { parse } = require('url')
const path = require('path')
const net = require('net')

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

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return null
}

function isLoopbackAddress(hostname) {
  if (!hostname) return false
  const normalized = String(hostname).trim().toLowerCase()
  if (!normalized) return false
  if (normalized === 'localhost') return true
  const withoutBrackets = normalized.replace(/^\[|\]$/g, '')
  if (withoutBrackets === '::1') return true
  if (normalized === '127.0.0.1') return true
  if (normalized === '0.0.0.0') return true
  return false
}

function isPrivateIpv4(hostname) {
  if (!hostname) return false
  const ipType = net.isIP(hostname)
  if (ipType !== 4) return false
  const segments = hostname.split('.').map((part) => Number.parseInt(part, 10))
  if (segments.length !== 4 || segments.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b] = segments
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isPrivateHostname(hostname) {
  if (!hostname) return false
  const normalized = String(hostname).trim().toLowerCase()
  if (!normalized) return false
  if (isLoopbackAddress(normalized)) return true
  if (normalized.endsWith('.local')) return true
  if (normalized.startsWith('localhost')) return true
  const withoutBrackets = normalized.replace(/^\[|\]$/g, '')
  if (net.isIP(withoutBrackets) === 6) {
    if (withoutBrackets === '::1') return true
    if (withoutBrackets.startsWith('fd') || withoutBrackets.startsWith('fc')) return true
  }
  if (isPrivateIpv4(withoutBrackets)) return true
  return false
}

let loggedSelfSignedWarning = false

function shouldAllowSelfSignedCertificates(hostname) {
  const allowEnv =
    parseBoolean(process.env.RESCUE_ALLOW_SELF_SIGNED) ??
    parseBoolean(process.env.RESCUE_ALLOW_INSECURE_SSL) ??
    parseBoolean(process.env.ALLOW_SELF_SIGNED_CERTS)
  if (allowEnv === true) {
    if (!loggedSelfSignedWarning) {
      loggedSelfSignedWarning = true
      console.warn('[Rescue] Allowing self-signed TLS certificates for backend origin (explicit override).')
    }
    return true
  }
  if (allowEnv === false) {
    return false
  }

  const strictEnv =
    parseBoolean(process.env.RESCUE_STRICT_SSL) ??
    parseBoolean(process.env.RESCUE_ENFORCE_TRUSTED_CERTS)
  if (strictEnv === true) {
    return false
  }

  if (parseBoolean(process.env.RESCUE_ALLOW_SELF_SIGNED_AUTO_DISABLED) === true) {
    return false
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    if (!loggedSelfSignedWarning) {
      loggedSelfSignedWarning = true
      console.warn('[Rescue] Allowing self-signed TLS certificates due to NODE_TLS_REJECT_UNAUTHORIZED=0.')
    }
    return true
  }

  const devMode = process.env.NODE_ENV !== 'production'
  if (!devMode) {
    return false
  }

  if (isPrivateHostname(hostname)) {
    if (!loggedSelfSignedWarning) {
      loggedSelfSignedWarning = true
      console.warn('[Rescue] Allowing self-signed TLS certificates for local backend origin.')
    }
    return true
  }

  return false
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

function resolveProxyConfig(target) {
  const protocol = String(target?.protocol || '').toLowerCase()
  let requestProtocol = protocol
  if (protocol === 'ws:') {
    requestProtocol = 'http:'
  } else if (protocol === 'wss:') {
    requestProtocol = 'https:'
  }
  const isSecure = requestProtocol === 'https:'
  const proxyModule = isSecure ? https : http
  const port = target?.port || (isSecure ? 443 : 80)
  let rejectUnauthorized
  if (isSecure) {
    rejectUnauthorized = shouldAllowSelfSignedCertificates(target?.hostname)
      ? false
      : undefined
  }
  return {
    proxyModule,
    requestProtocol,
    port,
    rejectUnauthorized,
  }
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

  const { proxyModule, requestProtocol, port: requestPort, rejectUnauthorized } = resolveProxyConfig(target)

  const headers = { ...req.headers }
  headers.host = target.host
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')
  headers['x-forwarded-port'] = String(req.socket.localPort || currentPort || '')

  const proxyReq = proxyModule.request(
    {
      protocol: requestProtocol,
      hostname: target.hostname,
      port: requestPort,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
      rejectUnauthorized,
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

function appendForwardedFor(headers, address) {
  if (!address) return
  const value = Array.isArray(address) ? address.filter(Boolean).join(', ') : String(address || '').trim()
  if (!value) return
  const existing = headers['x-forwarded-for']
  if (!existing) {
    headers['x-forwarded-for'] = value
    return
  }
  if (Array.isArray(existing)) {
    headers['x-forwarded-for'] = existing.concat(value).filter(Boolean).join(', ')
    return
  }
  const existingValue = String(existing || '').trim()
  headers['x-forwarded-for'] = existingValue ? `${existingValue}, ${value}` : value
}

function writeProxyResponse(socket, proxyRes) {
  if (!socket || socket.destroyed) return
  const statusCode = proxyRes.statusCode || 101
  const statusMessage = proxyRes.statusMessage || http.STATUS_CODES[statusCode] || ''
  const httpVersion = proxyRes.httpVersion ? `HTTP/${proxyRes.httpVersion}` : 'HTTP/1.1'
  const headerLines = []
  const rawHeaders = proxyRes.rawHeaders
  if (Array.isArray(rawHeaders) && rawHeaders.length > 0) {
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i]
      const value = rawHeaders[i + 1]
      if (!name || typeof value === 'undefined') continue
      headerLines.push(`${name}: ${value}`)
    }
  } else {
    const headers = proxyRes.headers || {}
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'undefined') continue
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'undefined') continue
          headerLines.push(`${name}: ${entry}`)
        }
      } else {
        headerLines.push(`${name}: ${value}`)
      }
    }
  }
  try {
    socket.write(`${httpVersion} ${statusCode} ${statusMessage}\r\n${headerLines.join('\r\n')}\r\n\r\n`)
  } catch (err) {
    console.error('[Rescue] Failed to write proxy response:', err?.message || err)
    try { socket.destroy() } catch {}
  }
}

function proxyWebSocketRequest(req, socket, head) {
  if (!backendOrigin) {
    try { socket.destroy() } catch {}
    return
  }

  let target
  try {
    target = new URL(req.url || '/ws', backendOrigin)
  } catch (err) {
    console.error('[Rescue] Failed to resolve backend WebSocket origin:', err?.message || err)
    try { socket.destroy() } catch {}
    return
  }

  const { proxyModule, requestProtocol, port: requestPort, rejectUnauthorized } = resolveProxyConfig(target)
  const headers = { ...req.headers }
  headers.host = target.host
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')
  headers['x-forwarded-port'] = String(req.socket.localPort || currentPort || '')
  appendForwardedFor(headers, req.socket.remoteAddress || '')

  delete headers['content-length']
  delete headers['transfer-encoding']

  const proxyReq = proxyModule.request({
    protocol: requestProtocol,
    hostname: target.hostname,
    port: requestPort,
    path: `${target.pathname}${target.search}`,
    method: req.method,
    headers,
    agent: false,
    rejectUnauthorized,
  })

  proxyReq.on('error', (err) => {
    console.error('[Rescue] WebSocket proxy request failed:', err?.message || err)
    try { socket.destroy() } catch {}
  })

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    writeProxyResponse(socket, proxyRes)

    const cleanup = () => {
      try { socket.destroy() } catch {}
      try { proxySocket.destroy() } catch {}
    }

    proxySocket.on('error', (err) => {
      console.error('[Rescue] WebSocket upstream socket error:', err?.message || err)
      cleanup()
    })

    socket.on('error', (err) => {
      console.error('[Rescue] WebSocket client socket error:', err?.message || err)
      cleanup()
    })

    try {
      socket.setTimeout(0)
      socket.setNoDelay(true)
      socket.setKeepAlive(true)
    } catch {}

    try {
      proxySocket.setTimeout(0)
      proxySocket.setNoDelay(true)
      proxySocket.setKeepAlive(true)
    } catch {}

    if (head && head.length) {
      try { proxySocket.write(head) } catch {}
    }
    if (proxyHead && proxyHead.length) {
      try { socket.write(proxyHead) } catch {}
    }

    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })

  proxyReq.on('response', (proxyRes) => {
    writeProxyResponse(socket, proxyRes)
    proxyRes.on('error', (err) => {
      console.error('[Rescue] WebSocket proxy response error:', err?.message || err)
      try { socket.destroy() } catch {}
    })
    proxyRes.pipe(socket)
  })

  proxyReq.end()
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
      server.on('upgrade', (req, socket, head) => {
        const pathname = normalizePath(parse(req.url || '', true).pathname || '')
        if (pathname === '/ws') {
          proxyWebSocketRequest(req, socket, head)
          return
        }
        try { socket.destroy() } catch {}
      })

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
