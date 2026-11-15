#!/usr/bin/env node
// Stitches each board's captures into one labelled image per theme, so a saved-canvas PR uploads one
// image per board and theme rather than one per capture. Each image has one row per width, with the
// canvas, before and after captures side by side and the width and theme written on it. The grid is
// an HTML page shot with desk's own Playwright (find-playwright.mjs).
//   node stitch-boards.mjs <captures dir> [--out <dir>] [--max-mb <n>]
//       reads <role>-<screen>-<width>[-<theme>].png from <captures dir>: role canvas, before or after
//       (built, as desk-design compare names it, is read as after), theme light or dark (none is
//       light), screen optional (none is "page"). Writes <out>/<screen>-<theme>.png (default <out>:
//       <captures dir>/stitched). An image that would be --max-mb (default 10) or more is split by
//       width into <screen>-<theme>-<first width>-<last width>.png, each under it, and a single
//       width still over it into <screen>-<theme>-<width>-<role>.png, one per capture. A missing
//       capture reads "no capture". The same captures give byte-identical images.
//       Exit 2 on a usage error, no captures, or two after captures for one cell; 5 when a single
//       capture is over the limit on its own (written anyway, and named); 6 when Playwright is missing
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROLES = ['canvas', 'before', 'after'];
const COLUMN = { canvas: 'Canvas', before: 'Before', after: 'After' };
export const MAX_BYTES = 10 * 1000 * 1000;
const CAPTURE = /^(canvas|before|after|built)-(?:(.+?)-)?(\d+)(?:-(light|dark))?\.png$/;

const fail = (message, code = 2) => { throw Object.assign(new Error(message), { code }); };

// A capture's file name as {role, screen, width, theme}, or null when it is not one.
export function parseCapture(name) {
  const m = CAPTURE.exec(name);
  if (!m) return null;
  return { role: m[1] === 'built' ? 'after' : m[1], screen: m[2] ?? 'page', width: Number(m[3]), theme: m[4] ?? 'light' };
}

// A PNG's pixel size, read from its IHDR chunk.
export function pngSize(buf, name = 'image') {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') fail(`${name} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The captures in <dir>, grouped per board and theme: [{screen, theme, rows: [{width, cells}]}],
// boards and themes in name order and rows by width, so a run's output never depends on readdir's
// order. `cells` maps a role to its file; `skipped` lists the PNGs that name no capture.
export function collectCaptures(dir) {
  const groups = new Map();
  const skipped = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.png')) continue;
    const c = parseCapture(name);
    if (!c) { skipped.push(name); continue; }
    const key = `${c.screen}\t${c.theme}`;
    if (!groups.has(key)) groups.set(key, { screen: c.screen, theme: c.theme, rows: new Map() });
    const rows = groups.get(key).rows;
    if (!rows.has(c.width)) rows.set(c.width, { width: c.width, cells: {} });
    const cells = rows.get(c.width).cells;
    if (cells[c.role]) fail(`two ${c.role} captures for ${c.screen} at ${c.width}px ${c.theme}: ${cells[c.role]} and ${name}; keep one`);
    cells[c.role] = name;
  }
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const out = [...groups.values()]
    .sort((a, b) => byName(a.screen, b.screen) || byName(a.theme, b.theme))
    .map((g) => ({
      ...g,
      rows: [...g.rows.values()].sort((a, b) => a.width - b.width)
        .map((r) => ({ width: r.width, cells: Object.fromEntries(ROLES.filter((role) => r.cells[role]).map((role) => [role, r.cells[role]])) })),
    }));
  return { groups: out, skipped };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The page for one board and theme. `rows` carry each cell's {src, width, height}, or null for a
// missing capture, which is drawn at the row's largest capture's size so the row keeps its shape.
// `roles` are the columns drawn: all three, or fewer for a width split by capture.
export function sheetHtml(screen, theme, rows, roles = ROLES) {
  const body = rows.map((r) => {
    const present = roles.map((role) => r.cells[role]).filter(Boolean);
    const w = Math.max(...present.map((c) => c.width), r.width);
    const h = Math.max(...present.map((c) => c.height), 240);
    const cells = roles.map((role) => {
      const c = r.cells[role];
      const shown = c ? `<img src="${esc(c.src)}" width="${c.width}" height="${c.height}">`
        : `<div class="none" style="width:${w}px;height:${h}px">no capture</div>`;
      return `<div class="cell"><div class="col">${COLUMN[role]}</div>${shown}</div>`;
    }).join('');
    return `<div class="row"><div class="label">${r.width}px<br>${esc(theme)}</div>${cells}</div>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: #fff; color: #111; font: 16px/1.3 Helvetica, Arial, sans-serif; }
.sheet { display: inline-block; padding: 24px 32px; }
h1 { font-size: 32px; margin: 0 0 8px; }
.row { display: flex; gap: 32px; align-items: flex-start; padding: 24px 0; border-top: 3px solid #ccc; }
.label { flex: none; width: 160px; font-size: 28px; font-weight: 700; }
.cell { flex: none; }
.col { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
.cell img { display: block; outline: 1px solid #bbb; }
.none { display: flex; align-items: center; justify-content: center; box-sizing: border-box; border: 3px dashed #888; background: #f2f2f2; color: #444; font-size: 28px; }
</style></head><body><div class="sheet"><h1>${esc(screen)} · ${esc(theme)}</h1>
${body}
</div></body></html>`;
}

const ORIGIN = 'http://stitch.invalid/';

// One PNG of these rows, the page and its captures served from memory so nothing is fetched.
async function shoot(browser, group, rows, files, roles = ROLES) {
  const served = new Map();
  const shown = rows.map((r) => ({
    width: r.width,
    cells: Object.fromEntries(roles.filter((role) => r.cells[role]).map((role) => {
      const f = files.get(r.cells[role]);
      const src = `${ORIGIN}i/${served.size}.png`;
      served.set(src, f.buf);
      return [role, { src, width: f.width, height: f.height }];
    })),
  }));
  served.set(ORIGIN, Buffer.from(sheetHtml(group.screen, group.theme, shown, roles)));
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const body = served.get(route.request().url());
      return body ? route.fulfill({ status: 200, body, contentType: route.request().url() === ORIGIN ? 'text/html' : 'image/png' }) : route.abort();
    });
    await page.goto(ORIGIN, { waitUntil: 'load' });
    const width = await page.evaluate(() => Math.ceil(document.querySelector('.sheet').getBoundingClientRect().width));
    await page.setViewportSize({ width, height: 600 });
    return await page.screenshot({ fullPage: true, animations: 'disabled' });
  } finally {
    await context.close();
  }
}

const noCaptures = (dir) => `no captures in ${dir}: want <canvas|before|after|built>-<screen>-<width>[-<light|dark>].png`;

// Each board and theme as one image under maxBytes, else split in half by width until each part
// is, so the same captures always split the same way. A single width still over the limit is split
// into one image per capture, its "no capture" cells drawn with the first; a single capture over
// the limit is kept, with `over` set.
export async function stitch(dir, { chromium, out = join(dir, 'stitched'), maxBytes = MAX_BYTES }) {
  const { groups, skipped } = collectCaptures(dir);
  if (!groups.length) fail(noCaptures(dir));
  const files = new Map();
  for (const g of groups) for (const r of g.rows) for (const name of Object.values(r.cells)) {
    const buf = readFileSync(join(dir, name));
    files.set(name, { buf, ...pngSize(buf, name) });
  }
  const images = [];
  const browser = await chromium.launch();
  try {
    for (const g of groups) {
      const fit = async (rows) => {
        const png = await shoot(browser, g, rows, files);
        if (png.length < maxBytes) return [{ rows, roles: ROLES, png, over: false }];
        if (rows.length > 1) {
          const mid = Math.ceil(rows.length / 2);
          return [...await fit(rows.slice(0, mid)), ...await fit(rows.slice(mid))];
        }
        const present = ROLES.filter((role) => rows[0].cells[role]);
        if (present.length < 2) return [{ rows, roles: ROLES, png, over: true }];
        const parts = [];
        for (const [n, role] of present.entries()) {
          const roles = ROLES.filter((r) => r === role || (n === 0 && !rows[0].cells[r]));
          const one = await shoot(browser, g, rows, files, roles);
          parts.push({ rows, roles, role, png: one, over: one.length >= maxBytes });
        }
        return parts;
      };
      const parts = await fit(g.rows);
      for (const p of parts) {
        const ws = p.rows.map((r) => r.width);
        const span = parts.length === 1 ? '' : ws.length === 1 ? `-${ws[0]}` : `-${ws[0]}-${ws.at(-1)}`;
        images.push({
          screen: g.screen, theme: g.theme, file: `${g.screen}-${g.theme}${span}${p.role ? `-${p.role}` : ''}.png`,
          widths: ws, ...(p.role ? { role: p.role } : {}), png: p.png, bytes: p.png.length, over: p.over,
          missing: p.rows.flatMap((r) => p.roles.filter((role) => !r.cells[role]).map((role) => `${role} at ${r.width}px`)),
        });
      }
    }
  } finally {
    await browser.close();
  }
  // Every image drawn: replace what an earlier run wrote for these boards, split or whole.
  mkdirSync(out, { recursive: true });
  const mine = new Set(groups.map((g) => `${g.screen}-${g.theme}`));
  for (const name of readdirSync(out)) {
    const m = /^(.+-(?:light|dark))(?:-\d+){0,2}(?:-(?:canvas|before|after))?\.png$/.exec(name);
    if (m && mine.has(m[1])) rmSync(join(out, name));
  }
  for (const i of images) writeFileSync(join(out, i.file), i.png);
  return { out, images: images.map(({ png, ...i }) => i), skipped };
}

// ---- the command line ------------------------------------------------------------------------

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

const opt = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

if (isMain) {
  const [target, ...rest] = process.argv.slice(2);
  try {
    if (!target || target.startsWith('-')) fail('usage: stitch-boards.mjs <captures dir> [--out <dir>] [--max-mb <n>]');
    if (!existsSync(target)) fail(`no such folder: ${target}`);
    const mb = opt(rest, '--max-mb');
    if (mb !== undefined && !(Number(mb) > 0)) fail(`--max-mb wants a positive number, not ${mb}`);
    if (!collectCaptures(resolve(target)).groups.length) fail(noCaptures(resolve(target)));
    const { findPlaywright, importPlaywright } = await import('./find-playwright.mjs');
    const found = findPlaywright();
    if (!found.entry) fail(`playwright not found (tried: ${found.tried.join(', ')}): re-run desk-skills' ./install.sh, which installs desk's own`, 6);
    const { chromium } = await importPlaywright(found);
    const out = opt(rest, '--out');
    const r = await stitch(resolve(target), { chromium, ...(out ? { out: resolve(out) } : {}), ...(mb ? { maxBytes: Number(mb) * 1000 * 1000 } : {}) });
    for (const i of r.images) {
      const size = `${(i.bytes / 1e6).toFixed(1)} MB`;
      console.log(`${i.over ? 'over' : 'wrote'}: ${join(r.out, i.file)} (${i.screen}, ${i.theme}, ${i.widths.join(' ')}px${i.role ? ` ${i.role}` : ''}, ${size}${i.over ? ', over the limit with one capture: the capture itself is too large to upload' : ''})`);
      for (const m of i.missing) console.log(`  no capture: ${m}`);
    }
    for (const s of r.skipped) console.log(`skipped: ${s} (not <role>-<screen>-<width>[-<theme>].png)`);
    if (r.images.some((i) => i.over)) process.exit(5);
  } catch (e) {
    console.error(`stitch-boards: ${e.message}`);
    process.exit(typeof e.code === 'number' ? e.code : 2);
  }
}
