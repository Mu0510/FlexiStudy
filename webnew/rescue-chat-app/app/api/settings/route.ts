import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'mnt');
const FILE = path.join(DIR, 'settings.json');

function ensureStore() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '{}', 'utf-8');
}

function readStore(): Record<string, any> {
  ensureStore();
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    return JSON.parse(raw || '{}') as Record<string, any>;
  } catch {
    return {};
  }
}

function writeStore(obj: Record<string, any>) {
  ensureStore();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, FILE);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const keysStr = searchParams.get('keys');
    const keys = keysStr ? keysStr.split(',').map(s => s.trim()).filter(Boolean) : null;
    const store = readStore();
    const out: Record<string, any> = {};
    if (keys) {
      const getByPath = (obj: any, path: string) => {
        return path.split('.').reduce((acc, p) => (acc && typeof acc === 'object') ? acc[p] : undefined, obj);
      };
      for (const k of keys) {
        const v = getByPath(store, k);
        if (v !== undefined) out[k] = v;
      }
    } else {
      Object.assign(out, store);
    }
    return NextResponse.json({ settings: out });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const key = body?.key as string | undefined;
    const value = body?.value;
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });
    const store = readStore();
    // support dot-path (e.g., tools.yolo)
    if (key.includes('.')) {
      const parts = key.split('.');
      let obj: any = store;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof obj[p] !== 'object' || obj[p] === null) obj[p] = {};
        obj = obj[p];
      }
      obj[parts[parts.length - 1]] = value;
    } else {
      store[key] = value;
    }
    writeStore(store);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}
