// Lightweight dev Service Worker (no precache, watch-friendly)
// - Avoids Workbox InjectManifest in dev to prevent noisy warnings
// - Provides basic runtime caching for images/fonts and Next static assets

const STATIC_CACHE = 'dev-static-v1';

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

  // Next.js static assets: stale-while-revalidate
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Navigations and everything else: pass-through (network-first)
  // Keeping SSR fresh in dev, no offline fallback here
});

