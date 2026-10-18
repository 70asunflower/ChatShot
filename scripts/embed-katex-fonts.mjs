// Embeds KaTeX woff2 fonts into lib/katex.min.css as data: URIs.
//
// Why: screenshots render inside an SVG foreignObject where external
// @font-face requests fail (and are stripped by ChatShot's onclone hook),
// so math renders with fallback fonts and wrong spacing. Self-contained
// data-URI fonts survive serialization and render correctly.
//
// Re-run after upgrading lib/katex.min.css. Usage:
//   node scripts/embed-katex-fonts.mjs
import { readFile, writeFile } from 'node:fs/promises';

const CSS_PATH = new URL('../lib/katex.min.css', import.meta.url);
// Version range is fine on jsDelivr; the KaTeX font set is stable across 0.16.x.
const FONT_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16/dist/fonts/';

const css = await readFile(CSS_PATH, 'utf8');
const names = [...new Set([...css.matchAll(/fonts\/([\w-]+)\.woff2/g)].map(m => m[1]))];
if (names.length === 0) {
  console.error('No woff2 references found in katex.min.css — nothing to do.');
  process.exit(1);
}
if (css.includes('data:font/woff2')) {
  console.error('katex.min.css already embeds fonts — re-extract the pristine CSS first.');
  process.exit(1);
}

const b64 = {};
let total = 0;
for (const name of names) {
  const resp = await fetch(FONT_BASE + name + '.woff2');
  if (!resp.ok) {
    console.error('Fetch failed:', name, resp.status);
    process.exit(1);
  }
  b64[name] = Buffer.from(await resp.arrayBuffer()).toString('base64');
  total += Math.round(b64[name].length * 3 / 4);
  console.log(name.padEnd(30), Math.round(b64[name].length * 3 / 4 / 1024) + 'KB');
}

const out = css.replace(
  /url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\(fonts\/[\w-]+\.woff\) format\("woff"\))?(?:,url\(fonts\/[\w-]+\.ttf\) format\("truetype"\))?/g,
  (m, name) => `url(data:font/woff2;base64,${b64[name]}) format("woff2")`
);

const leftover = [...out.matchAll(/url\(fonts\//g)].length;
if (leftover > 0) {
  console.error('Warning: ' + leftover + ' font URL(s) were not rewritten.');
  process.exit(1);
}

await writeFile(CSS_PATH, out);
console.log('---');
console.log('Embedded', names.length, 'fonts (' + Math.round(total / 1024) + 'KB raw) into', CSS_PATH.pathname);
console.log('New CSS size:', Math.round(Buffer.byteLength(out) / 1024) + 'KB');
