"use client"
import { useEffect, useMemo, useRef, useState } from 'react'

type LogEntry = { ts: number; level: 'log'|'warn'|'error'; args: any[] }

function shouldEnable(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const p = new URLSearchParams(window.location.search)
    if (p.get('debug') === '1') return true
    const v = localStorage.getItem('app.debug.console')
    return v === '1'
  } catch { return false }
}

export default function DebugConsole() {
  // Important for hydration: start disabled on server and enable after mount
  const [enabled, setEnabled] = useState(false)
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const orig = useRef<{log: any; warn: any; error: any} | null>(null)

  useEffect(() => {
    // evaluate only on client after mount to avoid SSR/CSR mismatch
    setEnabled(shouldEnable())
  }, [])

  useEffect(() => {
    if (!enabled) return
    if (!orig.current) orig.current = { log: console.log, warn: console.warn, error: console.error }
    const push = (level: LogEntry['level'], args: any[]) => {
      setLogs(prev => {
        const next = [...prev, { ts: Date.now(), level, args }]
        return next.slice(-200)
      })
    }
    console.log = (...args: any[]) => { push('log', args); orig.current!.log(...args) }
    console.warn = (...args: any[]) => { push('warn', args); orig.current!.warn(...args) }
    console.error = (...args: any[]) => { push('error', args); orig.current!.error(...args) }
    return () => {
      if (orig.current) { console.log = orig.current.log; console.warn = orig.current.warn; console.error = orig.current.error }
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const timer = setTimeout(() => setOpen(true), 0)
    return () => clearTimeout(timer)
  }, [enabled])

  if (!enabled) return null
  return (
    <div style={{ position: 'fixed', right: 8, bottom: 8, zIndex: 99999 }}>
      {!open && (
        <button onClick={() => setOpen(true)} style={{ padding: 6, borderRadius: 8, background: 'rgba(0,0,0,0.6)', color: 'white', fontSize: 12 }}>Logs</button>
      )}
      {open && (
        <div style={{ width: '92vw', maxWidth: 600, height: '40vh', background: 'rgba(20,20,20,0.9)', color: '#ddd', borderRadius: 12, padding: 8, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 12 }}>In‑App Logs</strong>
            <button onClick={() => setOpen(false)} style={{ marginLeft: 'auto', background: 'transparent', color: '#ccc' }}>×</button>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.3 }}>
            {logs.map((l, i) => (
              <div key={i}>
                <span style={{ color: l.level === 'error' ? '#ff6b6b' : l.level === 'warn' ? '#ffd166' : '#9be7ff' }}>[{new Date(l.ts).toLocaleTimeString()} {l.level}]</span>
                <span> </span>
                <span>{l.args.map(a => {
                  try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) }
                }).join(' ')}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
