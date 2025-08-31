/*
  Custom Service Worker for next-pwa (InjectManifest mode)
  - Minimal, safe defaults for a dynamic Next.js app
  - Keeps precache small and leverages runtime caching for static assets
*/

/* eslint-disable no-undef */
import {precacheAndRoute, cleanupOutdatedCaches} from 'workbox-precaching';
import {clientsClaim} from 'workbox-core';
import {registerRoute} from 'workbox-routing';
import {CacheFirst} from 'workbox-strategies';
import {ExpirationPlugin} from 'workbox-expiration';
import {CacheableResponsePlugin} from 'workbox-cacheable-response';

// Take control of uncontrolled clients once activated
clientsClaim();

// Allow client to trigger skipWaiting via message
self.addEventListener('message', (event) => {
  if (event?.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Injected by Workbox at build-time with hashed Next assets
// eslint-disable-next-line no-underscore-dangle
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Cache static images and fonts with a bounded CacheFirst strategy
registerRoute(
  ({request}) => ['image', 'font'].includes(request.destination),
  new CacheFirst({
    cacheName: 'static-assets',
    plugins: [
      new CacheableResponsePlugin({statuses: [0, 200]}),
      new ExpirationPlugin({maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30}),
    ],
  })
);

// Note: We intentionally do NOT cache HTML navigations or APIs here
// to avoid stale SSR content in a highly dynamic app. Add routes as needed.

