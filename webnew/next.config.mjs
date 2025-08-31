/** @type {import('next').NextConfig} */
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
  // If you’re accessing the dev server from another origin (IP/domain),
  // add it to ALLOWED_DEV_ORIGINS env (comma-separated) and we’ll parse it here.
  ...(process.env.ALLOWED_DEV_ORIGINS
    ? { allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) }
    : {}),
};

// We rely on a lightweight dev Service Worker (public/sw-dev.js) during development,
// registered manually in app/layout via DevSWRegister. No next-pwa in dev.
// If you later decide to ship a prod SW, we can reintroduce next-pwa.
export default nextConfig;
