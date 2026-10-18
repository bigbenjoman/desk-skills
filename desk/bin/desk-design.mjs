#!/usr/bin/env node
// Saves a Claude Design canvas into the repo, so it renders offline and every worktree, autopilot
// worker and design agent reads the same files, whichever account made the artifact. The Artifact
// tool reads the published files (desk-design never talks to claude.ai); this copies them into
// config §2 "Design canvases directory" (default docs/design/) and records where they came from.
//   node desk-design.mjs write  <dir> --url <u> --version <v> --key <K> [--boards <a,b>] [--key ...]
//                               [--epic <E>] [--fetched-at <iso>]
//       writes source.json and README.md into <dir> (a snapshot, or a saved canvas)
//   node desk-design.mjs save   <src> --key <K> [--epic <E>] [--url <u> --version <v>] [--boards <a,b>]
//       copies canvas.json, every board's HTML and the local files they reference (support.js,
//       fonts, CSS, images) from <src> into <design dir>/<EPIC or KEY>/ of the current checkout,
//       or into the folder that already holds the same artifact, then writes source.json and README
//   node desk-design.mjs status <saved dir | artifact URL> --version <v>
//       exit 0 when the saved copy is that version, 3 when the artifact has moved on
//   node desk-design.mjs check  <KEY | ticket file> [--key <K>]
//       exit 1 when the ticket's Design section links a Claude Design artifact with no saved copy
//   node desk-design.mjs render <saved dir>
//       renders every board at config §5 Breakpoints (default 390 768 1024 1280 1440) and at its own
//       width into <dir>/screens/<board>@<width>.png, and lists them in the README; exit 4 (nothing
//       written) when a board fails to load a file or renders blank, 6 when Playwright is missing
// `--boards` binds to the `--key` before it; a key with none uses every board. Usage errors exit 2.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';

const safeId = (s) => E.SAFE_ID.test(String(s ?? '')) && !String(s).includes('..');
const fail = (msg, code = 2) => { const e = new Error(msg); e.code = code; throw e; };

// ---- the canvas ------------------------------------------------------------------------------

// The boards canvas.json names, as [{name, width, file}], in order. Its exact shape is the design
// tool's, so any object carrying a numeric width and a name-like field counts as a board.
export function parseBoards(canvas) {
  const out = []; const seen = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const name = v.title ?? v.name ?? v.label ?? v.id;
    if (typeof v.width === 'number' && typeof name === 'string' && name) {
      const file = [v.file, v.src, v.path, v.html].find((f) => typeof f === 'string') ?? null;
      const id = `${name}\0${v.width}\0${file}`;
      if (!seen.has(id)) { seen.add(id); out.push({ name, width: v.width, file }); }
    }
    Object.values(v).forEach(walk);
  };
  walk(canvas);
  return out;
}

// Every reference a board or stylesheet makes: src/href attributes, CSS url() and @import.
export function references(text) {
  const refs = [];
  const add = (r) => { if (r && !refs.includes(r)) refs.push(r); };
  for (const m of text.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2]);
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2]);
  return refs.map((r) => r.trim()).filter(Boolean);
}

const isRemote = (r) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(r);
const isInline = (r) => /^(?:data|blob|about|javascript|mailto|tel):/i.test(r) || r.startsWith('#');
const TEXT = new Set(['.html', '.htm', '.css']);

function walkFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? walkFiles(p, base) : d.isFile() ? [relative(base, p)] : [];
  });
}

// What to copy out of a snapshot: canvas.json, every HTML file beside it, and every local file
// those reference, followed through CSS. A reference that leaves <src> or names a file the
// snapshot lacks is `missing`; one to another host is `remote` (it needs the network to render).
export function collect(src) {
  const all = walkFiles(src);
  const canvasRel = all.filter((f) => basename(f) === 'canvas.json').sort((a, b) => a.length - b.length)[0];
  if (!canvasRel) fail(`no canvas.json under ${src}: read the artifact's project/canvas.json first`);
  const home = dirname(canvasRel);
  const files = new Set([canvasRel]);
  const queue = all.filter((f) => /\.html?$/i.test(f) && (home === '.' || f.startsWith(home + sep)));
  const missing = []; const remote = [];
  queue.forEach((f) => files.add(f));
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    for (const ref of references(readFileSync(join(src, from), 'utf8'))) {
      if (isInline(ref)) continue;
      if (isRemote(ref)) { if (!remote.includes(ref)) remote.push(ref); continue; }
      let path = ref.replace(/[?#].*$/, '');
      try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
      if (!path) continue;
      const rel = normalize(path.startsWith('/') ? path.slice(1) : join(dirname(from), path));
      if (rel.startsWith('..') || isAbsolute(rel)) { missing.push(`${ref} (from ${from}: outside the snapshot)`); continue; }
      if (!existsSync(join(src, rel)) || !statSync(join(src, rel)).isFile()) { missing.push(`${rel} (from ${from})`); continue; }
      if (files.has(rel)) continue;
      files.add(rel);
      if (TEXT.has(extname(rel).toLowerCase())) queue.push(rel);
    }
  }
  return { canvas: canvasRel, files: [...files].sort(), missing, remote };
}

// ---- source.json and the README --------------------------------------------------------------

// The URL with its fragment, query and trailing slash dropped and the host lower-cased: two links
// to one artifact compare equal.
export function canonicalUrl(u) {
  try {
    const x = new URL(String(u).trim());
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
  } catch { return String(u ?? '').trim().replace(/[#?].*$/, '').replace(/\/+$/, ''); }
}

// [{key, boards}] from argv: each --boards applies to the --key before it.
function ticketsFromArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key') {
      const key = args[++i];
      if (!safeId(key)) fail(`--key needs a ticket key, got ${key ?? 'nothing'}`);
      out.push({ key, boards: [] });
    } else if (args[i] === '--boards') {
      const t = out.at(-1);
      if (!t) fail('--boards must follow the --key it belongs to');
      t.boards = (args[++i] ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    }
  }
  return out;
}

function opt(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) fail(`${name} needs a value`);
  return v;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// Merge one write into an existing source.json: one canvas per folder, so a different URL is
// refused; the tickets already using it are kept, and a ticket written again takes its new boards.
export function mergeSource(prev, next) {
  if (prev?.url && canonicalUrl(prev.url) !== canonicalUrl(next.url)) {
    fail(`this folder already holds ${prev.url}, not ${next.url}: one canvas per folder`);
  }
  const tickets = [...(prev?.tickets ?? [])];
  for (const t of next.tickets) {
    const i = tickets.findIndex((p) => p.key === t.key);
    if (i < 0) tickets.push(t); else tickets[i] = t;
  }
  tickets.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  // Screens describe one version: a write at another version drops them (save removes the images).
  const screens = next.screens ?? (prev?.screens && String(prev.screens.version) === String(next.version) ? prev.screens : undefined);
  return {
    url: next.url, version: String(next.version), fetched_at: next.fetched_at,
    dir: next.dir ?? prev?.dir ?? null, tickets,
    boards: next.boards ?? prev?.boards ?? [], files: next.files ?? prev?.files ?? [], screens,
  };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function readme(source) {
  const boards = source.boards ?? [];
  const label = (b) => `${b.name} (${b.width}px)`;
  const forTicket = (t) => {
    if (!t.boards?.length) return boards.length ? boards.map(label).join(', ') : 'all';
    return t.boards.map((n) => { const b = boards.find((x) => x.name === n); return b ? label(b) : n; }).join(', ');
  };
  return [
    `# Design canvas${source.dir ? ` ${source.dir}` : ''}`,
    '',
    `Saved by \`desk-design\` from <${source.url}>, version ${source.version}, fetched ${source.fetched_at}.`,
    'Open any board\'s HTML from this folder: it renders offline with the files saved beside it.',
    'Do not edit these files by hand. When the artifact has a newer version, re-save it with',
    '`desk-design save`, which replaces them.',
    '',
    '| Ticket | Boards |',
    '|---|---|',
    ...(source.tickets ?? []).map((t) => `| ${cell(t.key)} | ${cell(forTicket(t))} |`),
    '',
    '## Boards',
    '',
    ...(boards.length
      ? ['| Board | Width | File |', '|---|---|---|', ...boards.map((b) => `| ${cell(b.name)} | ${b.width}px | ${b.file ? cell(b.file) : '-'} |`)]
      : ['canvas.json names no boards.']),
    '',
    ...screensSection(source.screens),
  ].join('\n');
}

// What `render` drew: each width labelled drawn (a board was drawn at it) or interpolated (none
// was, so every image at it is a board laid out at a width nobody designed), then each image.
function screensSection(screens) {
  if (!screens?.images?.length) return [];
  const widths = screens.widths.map((w) => w.width);
  const img = (s) => `[${s.drawn ? 'drawn' : 'image'}](${s.file})`;
  return [
    '## Screens',
    '',
    `Rendered by \`desk-design render\` from version ${screens.version} on ${screens.rendered_at}, at the`,
    `Breakpoints (${screens.breakpoints.length ? screens.breakpoints.map((w) => `${w}px`).join(', ') : 'none'}) and each board's own width.`,
    '',
    '| Width | Label | Boards drawn at it |',
    '|---|---|---|',
    ...screens.widths.map((w) => `| ${w.width}px | ${w.label}${w.breakpoint ? '' : ' (not a breakpoint)'} | ${w.boards.length ? cell(w.boards.join(', ')) : '-'} |`),
    '',
    `| Board | ${widths.map((w) => `${w}px`).join(' | ')} |`,
    `|---|${widths.map(() => '---').join('|')}|`,
    ...[...new Set(screens.images.map((s) => s.screen))].map((screen) => `| ${cell(screens.images.find((x) => x.screen === screen).board)} | ${widths.map((w) => {
      const s = screens.images.find((x) => x.screen === screen && x.width === w);
      return s ? img(s) : '-';
    }).join(' | ')} |`),
    '',
  ];
}

// Write source.json and README.md into dir. Returns the merged source.
export function writeRecord(dir, next) {
  const prev = readJson(join(dir, 'source.json'));
  const source = mergeSource(prev, next);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
  writeFileSync(join(dir, 'README.md'), readme(source));
  return source;
}

// ---- where canvases live ---------------------------------------------------------------------

export function designDir() {
  let v = process.env.DESK_DESIGN_DIR;
  if (!v) { try { v = E.configValue('design-dir'); } catch { v = null; } }
  v = String(v || 'docs/design/').trim();
  if (E.isNone(v)) fail('config §2 "Design canvases directory" is none: this repo does not save design canvases');
  const rel = normalize(v).replace(/\/+$/, '');
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel === '.') {
    fail(`config §2 "Design canvases directory" must be a folder inside the repo, not ${v}`);
  }
  return rel;
}

const toplevel = () => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return fail('not inside a git checkout: run it from the worktree the canvas is committed in'); }
};

// Every saved canvas under <root>/<design dir>: [{path (repo-relative), source}].
export function savedCanvases(root, dir) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => ({ path: `${join(dir, d.name)}/`, source: readJson(join(base, d.name, 'source.json')) }))
    .filter((c) => c.source?.url);
}

export const findSaved = (root, dir, url) => savedCanvases(root, dir).find((c) => canonicalUrl(c.source.url) === canonicalUrl(url)) ?? null;

// ---- save ------------------------------------------------------------------------------------

export function save(src, { root, dir, tickets, epic, url, version, fetchedAt, now = new Date().toISOString() }) {
  if (!existsSync(src) || !statSync(src).isDirectory()) fail(`no snapshot folder at ${src}`);
  const meta = readJson(join(src, 'source.json'));
  url ??= meta?.url; version ??= meta?.version;
  if (!url || version === undefined || version === null || version === '') {
    fail('need the artifact URL and version: pass --url and --version, or save from a snapshot whose source.json has them');
  }
  // A batch snapshot lists every ticket sharing the canvas, so parallel workers write identical files.
  const all = [...(meta?.tickets ?? [])];
  for (const t of tickets) { const i = all.findIndex((p) => p.key === t.key); if (i < 0) all.push(t); else if (t.boards.length) all[i] = t; }
  const existing = findSaved(root, dir, url);
  const name = existing ? basename(existing.path.replace(/\/$/, '')) : (epic ?? meta?.dir ?? tickets[0].key);
  if (!safeId(name)) fail(`not a folder name for a canvas: ${name}`);
  const destRel = `${join(dir, name)}/`;
  const dest = join(root, dir, name);
  const prev = readJson(join(dest, 'source.json'));
  if (prev?.url && canonicalUrl(prev.url) !== canonicalUrl(url)) fail(`${destRel} already holds ${prev.url}: pass --epic to save this canvas elsewhere`);

  const { canvas, files, missing, remote } = collect(src);
  if (missing.length) fail(`not saved: the snapshot lacks files the boards reference; read them from the artifact too:\n${missing.map((m) => `missing: ${m}`).join('\n')}`, 4);
  const boards = parseBoards(readJson(join(src, canvas)) ?? {});

  // A re-save replaces the old version's files, so none outlive it: its screens included.
  const stale = String(prev?.screens?.version) !== String(version) ? (prev?.screens?.images ?? []).map((s) => s.file) : [];
  for (const f of [...(prev?.files ?? []), ...stale]) {
    const p = normalize(join(dest, f));
    if (!files.includes(f) && p.startsWith(dest + sep) && existsSync(p)) rmSync(p);
  }
  for (const f of files) {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    copyFileSync(join(src, f), join(dest, f));
  }
  const source = writeRecord(dest, {
    url, version, fetched_at: fetchedAt ?? meta?.fetched_at ?? now, dir: name, tickets: all, boards, files,
  });
  return { path: destRel, source, files, remote, reused: !!existing, previous: prev?.version ?? null };
}

// ---- status (AC: a newer version) --------------------------------------------------------------

export function status(target, version, { root, dir } = {}) {
  let source;
  if (/^https?:\/\//i.test(target)) source = findSaved(root, dir, target)?.source;
  else source = readJson(join(target, 'source.json'));
  if (!source) return { state: 'unsaved' };
  return { state: String(source.version) === String(version) ? 'current' : 'newer', saved: String(source.version), source };
}

// ---- render (every board at every breakpoint) --------------------------------------------------

export const DEFAULT_BREAKPOINTS = [390, 768, 1024, 1280, 1440];

const asWidth = (v) => {
  const n = Number(String(v).trim().replace(/px$/i, ''));
  return Number.isInteger(n) && n > 0 ? n : fail(`config §5 "Breakpoints" holds ${v}, not a width in pixels`);
};

// Config §5 Breakpoints as ascending widths: the default when unset, none for `none`.
export function breakpoints() {
  let v;
  try { v = E.configValues('breakpoints'); } catch (e) { if (e instanceof E.DeskConfigError) throw e; v = null; }
  if (!v) return DEFAULT_BREAKPOINTS;
  if (E.isNone(v)) return [];
  return [...new Set(v.map(asWidth))].sort((a, b) => a - b);
}

// A board's name as a file name: lower-case words joined by `-`, numbered on a clash with any name
// already given, so two boards never share a file.
export function screenNames(boards) {
  const used = new Set();
  return boards.map((b) => {
    const base = String(b.name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'board';
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return name;
  });
}

// What to render: each board at every breakpoint and at its own width, and each width labelled
// drawn when a board was drawn at it, interpolated when none was.
export function renderPlan(boards, bps) {
  const names = screenNames(boards);
  const shots = boards.flatMap((b, i) => [...new Set([...bps, b.width])].sort((x, y) => x - y)
    .map((width) => ({ board: b.name, screen: names[i], width, file: `screens/${names[i]}@${width}.png`, drawn: b.width === width })));
  const widths = [...new Set(shots.map((s) => s.width))].sort((x, y) => x - y).map((width) => {
    const drawnBy = boards.filter((b) => b.width === width).map((b) => b.name);
    return { width, label: drawnBy.length ? 'drawn' : 'interpolated', breakpoint: bps.includes(width), boards: drawnBy };
  });
  return { shots, widths };
}

const TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

// The saved folder over HTTP on a loopback port, so module scripts and fonts load as they would
// from the artifact (file:// refuses both); a file outside it, or missing, is a 404.
function serve(dir) {
  const server = createServer((req, res) => {
    let rel;
    try { rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1)); } catch { rel = '..'; }
    const p = join(dir, rel);
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}/` })));
}

// Renders every board from disk, all or nothing: a board that fails to load a file, or paints
// nothing, fails the render naming the board and the file, and no image is written.
// `chromium` is Playwright's.
export async function render(dir, { chromium, bps = breakpoints(), now = new Date().toISOString(), height = 900 }) {
  const source = readJson(join(dir, 'source.json'));
  if (!source?.url) fail(`no saved canvas at ${dir}: render a folder desk-design save wrote`);
  const { canvas } = collect(dir);
  const boards = parseBoards(readJson(join(dir, canvas)) ?? {});
  if (!boards.length) fail(`${canvas} names no boards: nothing to render`);
  const plan = renderPlan(boards, bps);
  const names = screenNames(boards);
  const pages = new Map(boards.map((b, i) => {
    const rel = b.file && normalize(join(dirname(canvas), b.file));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail(`board "${b.name}" names no file inside ${dir}`);
    if (!existsSync(join(dir, rel))) fail(`not rendered: board "${b.name}" is ${rel}, which is not in ${dir}`, 4);
    return [names[i], rel];
  }));
  const { server, origin } = await serve(dir);
  const browser = await chromium.launch();
  const images = [];
  try {
    for (const shot of plan.shots) {
      const rel = pages.get(shot.screen);
      const page = await browser.newPage({ viewport: { width: shot.width, height } });
      const bad = [];
      const name = (u) => (u.startsWith(origin) ? decodeURIComponent(u.slice(origin.length).replace(/[?#].*$/, '')) : u);
      page.on('requestfailed', (r) => bad.push(`${name(r.url())} (${r.failure()?.errorText ?? 'failed'})`));
      page.on('response', (r) => { if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) bad.push(`${name(r.url())} (HTTP ${r.status()})`); });
      await page.goto(origin + rel.split(sep).map(encodeURIComponent).join('/'), { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready.then(() => true));
      if (bad.length) fail(`not rendered: board "${shot.board}" (${rel}) at ${shot.width}px could not load ${[...new Set(bad)].join(', ')}`, 4);
      const painted = await page.evaluate(() => !!document.body && (document.body.innerText.trim() !== ''
        || [...document.body.querySelectorAll('*')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })));
      if (!painted) fail(`not rendered: board "${shot.board}" (${rel}) at ${shot.width}px painted nothing`, 4);
      images.push({ ...shot, png: await page.screenshot({ fullPage: true }) });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  // Every board rendered: replace the previous screens.
  const keep = new Set(images.map((s) => s.file));
  for (const s of source.screens?.images ?? []) {
    const p = normalize(join(dir, s.file));
    if (!keep.has(s.file) && p.startsWith(join(dir, 'screens') + sep) && existsSync(p)) rmSync(p);
  }
  mkdirSync(join(dir, 'screens'), { recursive: true });
  for (const s of images) writeFileSync(join(dir, s.file), s.png);
  const screens = {
    version: String(source.version), rendered_at: now, breakpoints: bps, widths: plan.widths,
    images: images.map(({ png, ...s }) => s),
  };
  return writeRecord(dir, { ...source, screens });
}

// ---- check (the lint finding) -----------------------------------------------------------------

// The text split at its `h2. Name` (Jira wiki) or `## Name` headings: [{name, lines: [{n, text}]}],
// what comes before the first heading under '', emphasis dropped from names. Text with any `hN.`
// heading is wiki markup, where `# item` is a numbered list item (desk-jira writes markdown's
// `1. item` that way), so only `hN.` heads it.
export function sections(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const head = lines.some((l) => /^\s*h[1-6]\.\s+/i.test(l)) ? /^\s*h[1-6]\.\s+(.*)$/i : /^\s*#{1,6}\s+(.*?)\s*$/;
  const out = [{ name: '', lines: [] }];
  lines.forEach((l, i) => {
    const m = head.exec(l);
    if (m) out.push({ name: m[1].replace(/[*_]/g, '').trim(), lines: [] });
    else out.at(-1).lines.push({ n: i + 1, text: l });
  });
  return out;
}

// The ticket's Design section, up to the next heading. Null when there is none.
export function designSection(text) {
  const s = sections(text).find((x) => /^design\b/i.test(x.name));
  return s ? s.lines.map((l) => l.text).join('\n') : null;
}

export function claudeDesignLinks(section) {
  const out = [];
  for (const m of String(section ?? '').matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*claude\.ai\/[^\s|\])>"'}]+/gi)) {
    const u = m[0].replace(/[.,;:!]+$/, '');
    if (!out.some((x) => canonicalUrl(x) === canonicalUrl(u))) out.push(u);
  }
  return out;
}

// Findings for one ticket: {severity: 'blocking'|'advisory', message}. `issue` is desk-jira's
// --json issue, or {key, text} for a ticket file. The canvas belongs under the ticket's epic when it
// has one, else under the ticket itself.
export function checkTicket(issue, { root, dir }) {
  const key = issue.key;
  // A Jira description is wiki markup, where desk-jira's markdown conversion escapes `-` and `_` in
  // a code span ({{…/p/1a2b\-3c4d}}); unescaped, the link and the repo path read as written.
  const text = String(issue.text ?? issue.fields?.description ?? '').replace(/\\([-_*+^~?#{}[\]|!])/g, '$1');
  const parent = issue.fields?.parent;
  const epic = parent && (parent.fields?.issuetype?.hierarchyLevel === 1 || /epic/i.test(parent.fields?.issuetype?.name ?? '')) ? parent.key : null;
  const section = designSection(text);
  const findings = [];
  for (const url of claudeDesignLinks(section)) {
    const saved = findSaved(root, dir, url);
    if (!saved) {
      findings.push({ severity: 'blocking', message: `design: ${key}'s Design section links the Claude Design artifact ${url}, but no copy is saved under ${dir}/: save it to ${join(dir, epic ?? key)}/ (desk-design save)` });
    } else if (!section.includes(saved.path.replace(/\/$/, ''))) {
      findings.push({ severity: 'advisory', message: `design: ${key}'s Design section links ${url} but not its saved copy ${saved.path}: add the repo path beside the link` });
    }
  }
  return findings;
}

function loadIssue(arg, keyOpt) {
  if (existsSync(arg) && statSync(arg).isFile()) {
    const raw = readFileSync(arg, 'utf8');
    let j = null; try { j = JSON.parse(raw); } catch { /* a ticket file */ }
    if (j?.fields) return j;
    return { key: keyOpt ?? basename(arg).replace(/\.[^.]*$/, ''), text: raw };
  }
  if (!safeId(arg)) fail(`not a ticket key or file: ${arg}`);
  // A work id, issue-<n> or slug has no tracker: its text is the ticket file the session wrote.
  const kind = E.ticketKind(arg);
  if (kind.ok && kind.kind !== 'tracker') {
    const file = join(E.stateDir(), 'tickets', `${arg}.md`);
    if (!existsSync(file)) fail(`${arg} is not a tracker key and has no ticket file at ${file}: write it first`);
    return { key: arg, text: readFileSync(file, 'utf8') };
  }
  let out;
  try { out = execFileSync('desk-jira', ['get', arg, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { fail(`desk-jira get ${arg} failed: ${String(e.stderr ?? e.message).trim()}`, 2); }
  return JSON.parse(out);
}

// ---- the command line ------------------------------------------------------------------------

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const [cmd, target, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'write') {
      if (!target) fail('usage: desk-design write <dir> --url <u> --version <v> --key <K> [--boards <a,b>]');
      const tickets = ticketsFromArgs(rest);
      const url = opt(rest, '--url'); const version = opt(rest, '--version');
      if (!url || !version || !tickets.length) fail('write needs --url, --version and at least one --key');
      const prev = readJson(join(target, 'source.json'));
      const s = writeRecord(target, {
        url, version, fetched_at: opt(rest, '--fetched-at') ?? new Date().toISOString(),
        dir: opt(rest, '--epic') ?? prev?.dir ?? tickets[0].key, tickets,
        boards: (() => { try { const c = collect(target).canvas; return parseBoards(readJson(join(target, c)) ?? {}); } catch { return prev?.boards ?? []; } })(),
      });
      console.log(`wrote: ${join(target, 'source.json')} (version ${s.version}; tickets ${s.tickets.map((t) => t.key).join(' ')})`);
    } else if (cmd === 'save') {
      if (!target) fail('usage: desk-design save <src> --key <K> [--epic <E>] [--url <u> --version <v>]');
      const tickets = ticketsFromArgs(rest);
      if (!tickets.length) fail('save needs --key');
      const root = toplevel(); const dir = designDir();
      const r = save(resolve(target), {
        root, dir, tickets, epic: opt(rest, '--epic'), url: opt(rest, '--url'), version: opt(rest, '--version'),
        fetchedAt: opt(rest, '--fetched-at'),
      });
      const was = r.previous && String(r.previous) !== String(r.source.version) ? `, replacing version ${r.previous}` : '';
      console.log(`saved: ${r.path} (${r.files.length} files, version ${r.source.version}${was}${r.reused ? ', the folder already holding this artifact' : ''})`);
      for (const u of r.remote) console.log(`remote: ${u} (loads from the network, so it will not render offline)`);
      console.log(`design: ${r.source.url} · ${r.path}`);
    } else if (cmd === 'status') {
      const version = opt(rest, '--version');
      if (!target || !version) fail('usage: desk-design status <saved dir | artifact URL> --version <v>');
      const s = /^https?:\/\//i.test(target) ? status(target, version, { root: toplevel(), dir: designDir() }) : status(target, version);
      if (s.state === 'unsaved') { console.log(`unsaved: no saved copy of ${target}`); process.exit(4); }
      if (s.state === 'current') console.log(`current: the saved copy is version ${s.saved}`);
      else { console.log(`newer: saved version ${s.saved}, the artifact is at ${version}; re-save it with desk-design save`); process.exit(3); }
    } else if (cmd === 'check') {
      if (!target) fail('usage: desk-design check <KEY | ticket file> [--key <K>]');
      const findings = checkTicket(loadIssue(target, opt(rest, '--key')), { root: toplevel(), dir: designDir() });
      for (const f of findings) console.log(`${f.severity}: ${f.message}`);
      if (!findings.length) console.log('ok: no unsaved Claude Design canvas');
      process.exit(findings.some((f) => f.severity === 'blocking') ? 1 : 0);
    } else if (cmd === 'render') {
      if (!target) fail('usage: desk-design render <saved dir>');
      const { findPlaywright, importPlaywright } = await import('./find-playwright.mjs');
      const found = findPlaywright();
      if (!found.entry) {
        fail(`playwright not found (tried: ${found.tried.join(', ')}): re-run desk-skills' ./install.sh, which installs desk's own`, 6);
      }
      const { chromium } = await importPlaywright(found);
      const s = await render(resolve(target), { chromium });
      console.log(`rendered: ${join(target, 'screens')}/ (${s.screens.images.length} images, version ${s.version})`);
      for (const w of s.screens.widths) {
        console.log(`  ${w.width}px ${w.label}${w.breakpoint ? '' : ' (not a breakpoint)'}${w.boards.length ? `: ${w.boards.join(', ')}` : ''}`);
      }
    } else {
      fail('usage: desk-design.mjs write|save|status|check|render ... (see the top of the file)');
    }
  } catch (e) {
    console.error(`desk-design: ${e.message}`);
    process.exit(typeof e.code === 'number' ? e.code : 2);
  }
}
