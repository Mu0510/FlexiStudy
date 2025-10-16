import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

type LicenseInfo = {
  name: string;
  version?: string;
  license?: string | string[] | { type?: string };
  licenseText?: string;
};

function findLicenseText(pkgDir: string): string | undefined {
  const candidates = [
    'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'License', 'license',
    'COPYING', 'COPYING.md', 'COPYING.txt'
  ];
  for (const fname of candidates) {
    const p = path.join(pkgDir, fname);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        return raw.length > 20000 ? raw.slice(0, 20000) + '\n... (truncated)\n' : raw;
      } catch {}
    }
  }
}

export async function GET() {
  try {
    const root = process.cwd();
    const webDir = root; // running from webnew
    const pkgJsonPath = path.join(webDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const deps: Record<string, string> = {
      ...(pkg.dependencies || {}),
    };

    const nodeModules = path.join(webDir, 'node_modules');
    const list: LicenseInfo[] = [];

    for (const name of Object.keys(deps).sort()) {
      try {
        const pkgDir = path.join(nodeModules, name);
        const metaPath = path.join(pkgDir, 'package.json');
        if (!fs.existsSync(metaPath)) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const license = meta.license || meta.licenses;
        const licenseText = findLicenseText(pkgDir);
        list.push({ name, version: meta.version, license, licenseText });
      } catch {}
    }

    return NextResponse.json({ items: list });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}

