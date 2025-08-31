"use client";

import { useEffect } from "react";

export function DevSWRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw-dev.js', { scope: '/' });
        // Proactively remove any older next-pwa registrations (e.g., /sw.js)
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) {
            const url = r?.active?.scriptURL || r?.installing?.scriptURL || r?.waiting?.scriptURL || '';
            if (url && url.endsWith('/sw.js') && url !== reg.active?.scriptURL) {
              await r.unregister();
            }
          }
        } catch {}
        // Log basic lifecycle for visibility in dev
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // No hard reload; SW calls skipWaiting + clients.claim()
          });
        });
        await navigator.serviceWorker.ready;
        // Ready
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[DevSW] register failed', e);
      }
    };

    register();
  }, []);

  return null;
}
