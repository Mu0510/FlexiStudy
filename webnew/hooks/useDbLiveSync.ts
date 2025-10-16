"use client"

import { useEffect, useRef } from 'react'

type Options = {
  intervalMs?: number
}

export function useDbLiveSync(onChange: () => void, opts: Options = {}) {
  const { intervalMs = 5000 } = opts
  const lastVersionRef = useRef<number>(0)
  const timerRef = useRef<any>(null)
  const lastEmitRef = useRef<number>(0)

  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      try {
        const res = await fetch('/api/db/version', { cache: 'no-store' })
        const json = await res.json()
        const v = Number(json?.version || 0)
        if (!cancelled && v > (lastVersionRef.current || 0)) {
          lastVersionRef.current = v
          const now = Date.now()
          if (now - (lastEmitRef.current || 0) > 700) {
            lastEmitRef.current = now
            onChange()
          }
        }
      } catch {}
      if (!cancelled) timerRef.current = setTimeout(tick, intervalMs)
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key === 'db.version.bump') {
        const now = Date.now()
        if (now - (lastEmitRef.current || 0) > 700) {
          lastEmitRef.current = now
          onChange()
        }
      }
    }
    window.addEventListener('storage', onStorage)
    tick()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('storage', onStorage)
    }
  }, [onChange, intervalMs])
}
