// Lightweight dev Service Worker (no precache, watch-friendly)
// - Avoids Workbox InjectManifest in dev to prevent noisy warnings
// - Provides basic runtime caching for images/fonts only
// - Do NOT cache Next.js dev assets to avoid UI glitches during HMR

const STATIC_CACHE = 'dev-static-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Clean up old caches if version changes
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== STATIC_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function cacheFirst(request) {
  return caches.open(STATIC_CACHE).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return cached;
    const resp = await fetch(request);
    // Only cache successful, basic/opaque-allowed responses
    if (resp && (resp.status === 200 || resp.type === 'opaque')) {
      cache.put(request, resp.clone());
    }
    return resp;
  });
}

function staleWhileRevalidate(request) {
  return caches.open(STATIC_CACHE).then(async (cache) => {
    const cached = await cache.match(request);
    const networkPromise = fetch(request).then((resp) => {
      if (resp && resp.status === 200) {
        cache.put(request, resp.clone());
      }
      return resp;
    }).catch(() => cached);
    return cached || networkPromise;
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Don’t try to handle non-GET
  if (request.method !== 'GET') return;

  // Images and fonts: cache-first
  if (request.destination === 'image' || request.destination === 'font') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else: pass-through (network)
  // Keep SSR and dev static fresh; no offline fallback in dev
});

// --- Push Notifications for dev ---
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event?.data ? event.data.json() : {}; } catch {}
  const title = data.title || '通知';
  const options = {
    body: data.body || '',
    icon: '/FlexiStudy_icon.svg',
    badge: '/FlexiStudy_icon.svg',
    tag: data.tag || 'general',
    data: { url: data.action_url || '/', notificationId: data.id || null },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event?.notification?.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const scope = self.registration.scope || '/';
      const existing = list.find((c) => (c.url || '').includes(scope));
      if (existing) {
        try { existing.focus(); } catch {}
        try { return existing.navigate(url); } catch {}
        return existing;
      }
      return clients.openWindow(url);
    })
  );
});
