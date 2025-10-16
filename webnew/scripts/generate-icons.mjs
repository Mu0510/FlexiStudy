// Generate PWA icons (PNG) and favicon.ico from SVG
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const root = process.cwd();
// Prefer v2 if present, fallback to v1
const CANDIDATES = ['FlexiStudy_icon_v2.svg', 'FlexiStudy_icon.svg'];
let SRC = null;
for (const c of CANDIDATES) {
  const p = path.join(root, c);
  try { fs.accessSync(p, fs.constants.F_OK); SRC = p; break; } catch {}
}
if (!SRC) SRC = path.join(root, 'FlexiStudy_icon.svg');
const publicDir = path.join(root, 'public');
const iconsDir = path.join(publicDir, 'icons');

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function exists(p) {
  try { await fs.promises.access(p, fs.constants.F_OK); return true; } catch { return false; }
}

function sanitizeSvg(svgText) {
  // Remove duplicate xmlns attributes on the <svg> tag which can break some parsers
  const start = svgText.indexOf('<svg');
  const end = svgText.indexOf('>', start);
  if (start !== -1 && end !== -1) {
    const openTag = svgText.slice(start, end + 1);
    const rest = svgText.slice(end + 1);
    // Keep only the first xmlns="..." attribute
    let seenDefaultXmlns = false;
    const cleaned = openTag.replace(/\s+xmlns(=[\"\'][^\"\']+[\"\'])/g, (m, g1) => {
      if (m.startsWith(' xmlns="')) {
        if (seenDefaultXmlns) return '';
        seenDefaultXmlns = true;
        return m;
      }
      return m; // keep xmlns:prefix attributes
    });
    return cleaned + rest;
  }
  return svgText;
}

async function loadSvgBuffer() {
  const raw = await fs.promises.readFile(SRC, 'utf8');
  const sanitized = sanitizeSvg(raw);
  return Buffer.from(sanitized, 'utf8');
}

async function genPng(size, outPath) {
  const svgBuf = await loadSvgBuffer();
  const buf = await sharp(svgBuf).resize(size, size, { fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer();
  await fs.promises.writeFile(outPath, buf);
  return buf;
}

// Minimal ICO writer supporting multiple PNG entries (Vista+)
function writeIco(pngBuffers, sizes, outPath) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4); // count

  const dirEntrySize = 16;
  const dirTable = Buffer.alloc(dirEntrySize * count);
  let offset = 6 + dirEntrySize * count; // start of first image data

  const imageData = [];
  for (let i = 0; i < count; i++) {
    const png = pngBuffers[i];
    const size = sizes[i];
    const entry = Buffer.alloc(dirEntrySize);
    entry[0] = size === 256 ? 0 : size; // width
    entry[1] = size === 256 ? 0 : size; // height
    entry[2] = 0; // colors in palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8); // size
    entry.writeUInt32LE(offset, 12); // offset
    entry.copy(dirTable, i * dirEntrySize);
    imageData.push(png);
    offset += png.length;
  }

  const out = Buffer.concat([header, dirTable, ...imageData]);
  fs.writeFileSync(outPath, out);
}

async function main() {
  if (!(await exists(SRC))) {
    console.error(`Source SVG not found: ${SRC}`);
    process.exit(1);
  }
  await ensureDir(iconsDir);
  // Keep a copy of the chosen SVG in public for modern favicon usage
  try {
    const publicSvg = path.join(publicDir, 'FlexiStudy_icon.svg');
    await fs.promises.copyFile(SRC, publicSvg);
  } catch {}

  // PWA icons
  const sizes = [192, 512, 1024];
  for (const s of sizes) {
    const out = path.join(iconsDir, `icon-${s}.png`);
    await genPng(s, out);
    console.log(`Generated ${path.relative(root, out)}`);
  }

  // Apple touch icon (180x180)
  const apple = path.join(publicDir, 'apple-touch-icon.png');
  await genPng(180, apple);
  console.log(`Generated ${path.relative(root, apple)}`);

  // Favicon ICO (16, 32, 48)
  const favSizes = [16, 32, 48];
  const favPngs = [];
  const svgBuf = await loadSvgBuffer();
  for (const s of favSizes) {
    favPngs.push(await sharp(svgBuf).resize(s, s, { fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer());
  }
  const icoPath = path.join(publicDir, 'favicon.ico');
  writeIco(favPngs, favSizes, icoPath);
  console.log(`Generated ${path.relative(root, icoPath)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
