#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
const __dirname = path.dirname(new URL(import.meta.url).pathname);

async function main() {
  let webpush;
  try { webpush = (await import('web-push')).default || (await import('web-push')); } catch (e) {
    console.error('[gen-vapid] Please install web-push: npm i -D web-push');
    process.exit(1);
  }
  const keys = webpush.generateVAPIDKeys();
  const out = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:notify@flexistudy.app' };
  const outDir = path.resolve(__dirname, '..', 'mnt');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'vapid.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('[gen-vapid] Wrote', outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });

