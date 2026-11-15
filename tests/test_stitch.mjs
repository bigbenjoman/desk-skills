// suite: stitch-boards (one labelled image per board and theme, under the upload limit)
// stitch-boards.mjs on fixture captures: names read as role, screen, width and theme; one image per
// board and theme with a row per width; a missing capture drawn as "no capture"; an image over the
// limit split by width; the same captures giving the same bytes. The browser checks use desk's own
// Playwright and are skipped where it is not installed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { parseCapture, pngSize, collectCaptures, sheetHtml, stitch } from '../desk/bin/stitch-boards.mjs';
import { findPlaywright, importPlaywright } from '../desk/bin/find-playwright.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'stitch-boards.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-stitch-'));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// A PNG of one colour with a stripe pattern, written without a dependency.
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(width, height, [r, g, b], noise = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = width * 7 + height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = y * (width * 3 + 1) + 1 + x * 3;
    // Noise makes the PNG large, so the split has something to split.
    const v = noise ? (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24 : (y % 40 < 20 ? 0 : 40);
    raw[o] = (r + v) & 255; raw[o + 1] = (g + v) & 255; raw[o + 2] = (b + v) & 255;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const WIDTHS = [390, 768, 1024, 1440];
const COLOUR = { canvas: [200, 60, 60], before: [60, 160, 60], after: [60, 60, 200], built: [60, 60, 200] };
// A board's captures at every width in both themes, as compare (canvas-, built-) and desk-pr
// (before-, after-) name them, with no before at 768 in dark.
function board(dir, { screen = 'order-summary', noise = false, missing = [] } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const theme of ['light', 'dark']) for (const w of WIDTHS) for (const role of ['canvas', 'before', theme === 'light' ? 'built' : 'after']) {
    if (missing.includes(`${role}-${w}-${theme}`)) continue;
    // Light captures carry no theme suffix: an unsuffixed capture is light.
    const name = `${role}-${screen}-${w}${theme === 'dark' ? '-dark' : ''}.png`;
    writeFileSync(join(dir, name), png(w, 120 + w / 10, COLOUR[role], noise));
  }
  return dir;
}

// ---- names --------------------------------------------------------------------------------------
const pc = (n) => JSON.stringify(parseCapture(n));
t('name: canvas, a dashed screen, width, theme', pc('canvas-order-summary-390-dark.png'), '{"role":"canvas","screen":"order-summary","width":390,"theme":"dark"}');
t('name: no theme is light', pc('before-order-summary-768.png'), '{"role":"before","screen":"order-summary","width":768,"theme":"light"}');
t('name: built reads as after', parseCapture('built-hero-1440.png').role, 'after');
t('name: a screen ending in a number keeps it', parseCapture('canvas-step-2-390.png').screen, 'step-2');
t('name: desk-pr\'s before-<width>.png is the page', pc('after-375.png'), '{"role":"after","screen":"page","width":375,"theme":"light"}');
t('name: a capture with no width is not one', parseCapture('before-desktop.png'), null);
t('name: another role is not one', parseCapture('screen-hero-390.png'), null);

const sz = pngSize(png(17, 9, [0, 0, 0]));
t('pngSize: read from IHDR', `${sz.width}x${sz.height}`, '17x9');
t('pngSize: not a PNG fails', (() => { try { pngSize(Buffer.from('GIF89a........................')); return 'no error'; } catch (e) { return `${e.code}:${e.message}`; } })(), '2:image is not a PNG');

// ---- grouping -----------------------------------------------------------------------------------
const g1 = board(join(T, 'g1'), { missing: ['before-768-dark'] });
writeFileSync(join(g1, 'notes.txt'), 'x');
writeFileSync(join(g1, 'hero-desktop.png'), png(4, 4, [0, 0, 0]));
const { groups, skipped } = collectCaptures(g1);
t('group: one per board and theme, in name order', groups.map((g) => `${g.screen}/${g.theme}`).join(' '), 'order-summary/dark order-summary/light');
t('group: a row per width, in order', groups[1].rows.map((r) => r.width).join(' '), '390 768 1024 1440');
t('group: the three captures in a row', JSON.stringify(groups[1].rows[0].cells), '{"canvas":"canvas-order-summary-390.png","before":"before-order-summary-390.png","after":"built-order-summary-390.png"}');
t('group: a missing before leaves its cell empty', Object.keys(groups[0].rows[1].cells).join(' '), 'canvas after');
t('group: a PNG that names no capture is skipped, other files ignored', skipped.join(' '), 'hero-desktop.png');

const dup = board(join(T, 'dup'));
writeFileSync(join(dup, 'after-order-summary-390.png'), png(390, 100, [0, 0, 0]));
t('group: an after and a built for one cell fail', (() => { try { collectCaptures(dup); return 'no error'; } catch (e) { return `${e.code}:${e.message.includes('two after captures for order-summary at 390px light')}`; } })(), '2:true');

// ---- the page -----------------------------------------------------------------------------------
const html = sheetHtml('order-summary', 'dark', [
  { width: 390, cells: { canvas: { src: 'c', width: 390, height: 300 }, after: { src: 'a', width: 780, height: 500 } } },
]);
t('page: the board and theme are written on it', html.includes('<h1>order-summary · dark</h1>'), true);
t('page: the row names its width and theme', html.includes('<div class="label">390px<br>dark</div>'), true);
t('page: the missing cell reads "no capture", at the row\'s largest capture', html.includes('<div class="col">Before</div><div class="none" style="width:780px;height:500px">no capture</div>'), true);
t('page: canvas, before and after in that order', /Canvas[\s\S]*Before[\s\S]*After/.test(html), true);
t('page: names are escaped', sheetHtml('a<b', 'light', []).includes('<h1>a&lt;b · light</h1>'), true);

// ---- the command line, without a browser ---------------------------------------------------------
const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });
t('cli: no folder is a usage error', cli().status, 2);
mkdirSync(join(T, 'empty'));
const none = cli(join(T, 'empty'));
t('cli: a folder with no captures exits 2, naming the pattern', `${none.status}:${none.stderr.includes('<canvas|before|after|built>-<screen>-<width>')}`, '2:true');
t('cli: a bad --max-mb exits 2', cli(g1, '--max-mb', '0').status, 2);

// ---- in a real browser ---------------------------------------------------------------------------
const pw = findPlaywright();
if (!pw.entry) {
  console.log(`SKIP stitch in a browser: no desk Playwright (tried ${pw.tried.join(', ')})`);
} else {
  const { chromium } = await importPlaywright(pw);

  // AC1 and AC3: two images, one per theme, every width a row, the missing before drawn as such.
  const out1 = join(T, 'out1');
  const r1 = await stitch(g1, { chromium, out: out1 });
  t('AC1: one image per theme', readdirSync(out1).sort().join(' '), 'order-summary-dark.png order-summary-light.png');
  t('AC1: every width in each', r1.images.map((i) => i.widths.join(',')).join(' '), '390,768,1024,1440 390,768,1024,1440');
  const dark = pngSize(readFileSync(join(out1, 'order-summary-dark.png')));
  t('AC1: the three captures side by side (wider than three 1440 captures)', dark.width > 3 * 1440, true);
  t('AC1: a row per width (taller than the four rows\' captures)', dark.height > WIDTHS.reduce((s, w) => s + 120 + w / 10, 0), true);
  t('AC3: the missing before is named, the rest drawn', r1.images.map((i) => i.missing.join(',') || '-').join(' '), 'before at 768px -');
  t('AC1: each under 10 MB', r1.images.every((i) => i.bytes < 10 * 1000 * 1000 && !i.over), true);

  // AC4: the same captures, the same bytes.
  const before = readdirSync(out1).sort().map((f) => sha(join(out1, f))).join(' ');
  await stitch(g1, { chromium, out: out1 });
  t('AC4: a second run leaves each sha256 unchanged', readdirSync(out1).sort().map((f) => sha(join(out1, f))).join(' '), before);

  // AC2: over the limit, split by width into parts each under it.
  const big = board(join(T, 'big'), { screen: 'hero', noise: true });
  const whole = (await stitch(big, { chromium, out: join(T, 'whole') })).images.find((i) => i.theme === 'light').bytes;
  const out2 = join(T, 'out2');
  const r2 = await stitch(big, { chromium, out: out2, maxBytes: whole });
  const light = r2.images.filter((i) => i.theme === 'light');
  t('AC2: an image at the limit is split', light.length > 1, true);
  t('AC2: each part under the limit', light.every((i) => i.bytes < whole && !i.over), true);
  t('AC2: the parts hold every width once, in order', light.flatMap((i) => i.widths).join(' '), '390 768 1024 1440');
  t('AC2: a part is named by its widths', light.map((i) => i.file).join(' '), light.map((i) => `hero-light-${i.widths.length === 1 ? i.widths[0] : `${i.widths[0]}-${i.widths.at(-1)}`}.png`).join(' '));
  t('AC2: what is on disk is what was reported', readdirSync(out2).filter((f) => f.startsWith('hero-light')).sort().join(' '), light.map((i) => i.file).sort().join(' '));

  // A later run under a higher limit replaces the parts with one image.
  await stitch(big, { chromium, out: out2 });
  t('rerun: the parts give way to the whole image', readdirSync(out2).sort().join(' '), 'hero-dark.png hero-light.png');

  // One width over the limit on its own is written and flagged; the command exits 5.
  const one = join(T, 'one');
  mkdirSync(one);
  writeFileSync(join(one, 'canvas-wide-1440.png'), png(1440, 900, [10, 10, 10], true));
  const r3 = cli(one, '--out', join(T, 'out3'), '--max-mb', '0.001');
  t('cli: one width over the limit exits 5, naming it', `${r3.status}:${/^over: .*wide-light\.png .*over the limit with one width/m.test(r3.stdout)}`, '5:true');
  const r4 = cli(g1, '--out', join(T, 'out4'));
  t('cli: writes and names each image, and the missing capture', `${r4.status}:${(r4.stdout.match(/^wrote: /gm) ?? []).length}:${r4.stdout.includes('  no capture: before at 768px')}:${r4.stdout.includes('skipped: hero-desktop.png')}`, '0:2:true:true');
}

console.log(fails ? `${fails} failed` : 'all stitch-boards checks passed');
process.exit(fails ? 1 : 0);
