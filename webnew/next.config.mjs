/** @type {import('next').NextConfig} */
import withPWA from 'next-pwa';

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async redirects() {
    return [
      {
        source: '/dashboard',
        destination: '/',
        permanent: true,
      },
    ];
  },
  // If you’re accessing the dev server from another origin (IP/domain),
  // add it to ALLOWED_DEV_ORIGINS env (comma-separated) and we’ll parse it here.
  ...(process.env.ALLOWED_DEV_ORIGINS
    ? { allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) }
    : {}),
};

// Example runtime strategies (used by our custom SW, not by InjectManifest options)
const runtimeCaching = [
  {
    // Images
    urlPattern: ({ request }) => request.destination === 'image',
    handler: 'CacheFirst',
    options: {
      cacheName: 'images',
      expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // Fonts
    urlPattern: ({ request }) => request.destination === 'font',
    handler: 'CacheFirst',
    options: {
      cacheName: 'fonts',
      expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 365 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // Next static assets
    urlPattern: ({ url }) => url.pathname.startsWith('/_next/static/'),
    handler: 'StaleWhileRevalidate',
    options: { cacheName: 'next-static' },
  },
  {
    // Do not cache HTML navigations
    urlPattern: ({ request }) => request.destination === 'document',
    handler: 'NetworkOnly',
  },
  {
    // Do not cache API calls
    urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
    handler: 'NetworkOnly',
  },
];

const withPwa = withPWA({
  dest: 'public',
  register: true,
  skipWaiting: true,
  clientsClaim: true,
  cleanupOutdatedCaches: true,
  // Disable next-pwa in dev to avoid InjectManifest issues; use sw-dev.js instead
  disable: process.env.NODE_ENV !== 'production',
  swSrc: 'sw.js', // Use our custom Service Worker (InjectManifest)
  buildExcludes: [/middleware-manifest\.json$/i, /\.map$/i],
});

export default withPwa(nextConfig);
