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
//       fonts, CSS, images, and each /_blob/<id> asset as assets/<id><ext>, which the boards are
//       pointed at) from <src> into <design dir>/<EPIC or KEY>/ of the current checkout, or into the
//       folder that already holds the same artifact, then writes source.json and README. A
//       support.js the snapshot lacks is copied from its dc-runtime.js, which the artifact serves
//       in its place
//   node desk-design.mjs import <file> --url <u> --key <K> [--boards <a,b>] [--key ...] [--epic <E>]
//       takes a design's self-contained HTML export as a single-page snapshot under
//       <state>/designs/<EPIC or KEY>/ (or the folder already holding the artifact): source.json
//       records from: export, the file's name and sha256, and its modified time as the version. Exit 4,
//       recording nothing, when the page loads a file from anything but a data: or blob: URL
//   node desk-design.mjs propose <snapshot dir>
//       commits the snapshot into <design dir>/ on docs/design-<EPIC or KEY>, a branch off the batch's
//       base in its own worktree, for the PR that puts it in the repo; nothing when the base already
//       holds that version
//   node desk-design.mjs status <saved dir | artifact URL> --version <v>
//       exit 0 when the saved copy is that version, 3 when the artifact has moved on
//   node desk-design.mjs check  <KEY | ticket file> [--key <K>]
//       exit 1 when the ticket's Design section links a Claude Design artifact with no copy saved on
//       the batch's base (origin/<base> where fetched), whatever the working tree holds
//   node desk-design.mjs snapshots <KEY | ticket file> [--key <K>]
//       one `<url>\t<snapshot folder, or ->` line per Claude Design artifact the Design section links,
//       found by URL in this state's designs/ and, in a named batch, the repo state's
//   node desk-design.mjs render <saved dir>
//       renders every board at config §5 Breakpoints (default 390 768 1024 1280 1440) and at its own
//       width into <dir>/screens/<board>@<width>.png, and lists them in the README; exit 4 (nothing
//       written) when a board fails to load a file or renders blank, 6 when Playwright is missing
// `--boards` binds to the `--key` before it; a key with none uses every board. Usage errors exit 2.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { isEpic } from './desk-q-eta.mjs';

const safeId = (s) => E.SAFE_ID.test(String(s ?? '')) && !String(s).includes('..');
const fail = (msg, code = 2) => { const e = new Error(msg); e.code = code; throw e; };

// ---- the canvas ------------------------------------------------------------------------------

// The boards canvas.json names, as [{name, width, file}], in order. Its exact shape is the design
// tool's, so any object carrying a numeric `width` and a name-like field counts as a board, as does
// one sized by `w` that names its file. An object keyed by an HTML file name is that file's board,
// named by it when it has no title.
export function parseBoards(canvas) {
  const out = []; const seen = new Set();
  const walk = (v, key) => {
    if (Array.isArray(v)) { v.forEach((x) => walk(x)); return; }
    if (!v || typeof v !== 'object') return;
    const keyFile = typeof key === 'string' && /\.html?$/i.test(key) ? key : null;
    const name = v.title ?? v.name ?? v.label ?? v.id ?? keyFile?.replace(/(?:\.dc)?\.html?$/i, '');
    const width = typeof v.width === 'number' ? v.width : v.w;
    const file = [v.file, v.src, v.path, v.html].find((f) => typeof f === 'string') ?? keyFile;
    // A `w` alone is any canvas item's size (a note, a group); only one with a file is a board.
    if (typeof width === 'number' && typeof name === 'string' && name && (typeof v.width === 'number' || file)) {
      const id = `${name}\0${width}\0${file}`;
      if (!seen.has(id)) { seen.add(id); out.push({ name, width, file }); }
    }
    Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  walk(canvas);
  return out;
}

// Every reference a board or stylesheet makes: src/href attributes, CSS url() and @import. A
// template binding (`{{janeSrc}}`) is filled in at runtime, so it names no file.
export function references(text) {
  const refs = [];
  const add = (r) => { if (r && !refs.includes(r)) refs.push(r); };
  for (const m of text.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2]);
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2]);
  return refs.map((r) => r.trim()).filter((r) => r && !r.includes('{{'));
}

// An image in the artifact's asset store, `/_blob/<id>`, wherever a board names it: an attribute,
// CSS, or a string in its script. Saved as assets/<id><ext> beside canvas.json.
const BLOB_ID = '[0-9a-f]{32}';
const BLOB = new RegExp(`(?:https?://[^/\\s"'\`]+)?/_blob/(${BLOB_ID})\\b`, 'gi');
const isAssetId = (s) => new RegExp(`^${BLOB_ID}$`).test(s);
export const blobIds = (text) => [...new Set([...text.matchAll(BLOB)].map((m) => m[1].toLowerCase()))];

// The extension an asset file is saved under: its own, else what its first bytes say it is.
function assetExt(path) {
  if (extname(path)) return extname(path).toLowerCase();
  const b = readFileSync(path).subarray(0, 512);
  if (b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG') return '.png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.subarray(0, 4).toString() === 'GIF8') return '.gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (/<svg\b/i.test(b.toString('utf8'))) return '.svg';
  return '';
}

const isRemote = (r) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(r);
const isInline = (r) => /^(?:data|blob|about|javascript|mailto|tel):/i.test(r) || r.startsWith('#');
const TEXT = new Set(['.html', '.htm', '.css']);
// The DC runtime a board loads as ./support.js: the artifact serves it at runtime rather than
// publishing it, so a snapshot carries it under the type's own name.
const RUNTIME = 'dc-runtime.js';

function walkFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? walkFiles(p, base) : d.isFile() ? [relative(base, p)] : [];
  });
}

// What to copy out of a snapshot: canvas.json, every HTML file beside it, and every local file
// those reference, followed through CSS. A single-page artifact has no canvas.json (`canvas` is
// null): its pages are the HTML files beside the shallowest one. A reference that leaves <src> or names a file the
// snapshot lacks is `missing`; one to another host is `remote` (it needs the network to render).
// `blobs` maps each asset id the boards use to its saved path, and `copyFrom` maps a saved path to
// the snapshot file it comes from where the two differ: an asset, or support.js from dc-runtime.js.
export function collect(src) {
  const all = walkFiles(src);
  const shallowest = (name) => all.filter(name).sort((a, b) => a.split(sep).length - b.split(sep).length || a.length - b.length)[0];
  const canvasRel = shallowest((f) => basename(f) === 'canvas.json') ?? null;
  const page = canvasRel ? null : shallowest((f) => /\.html?$/i.test(f));
  if (!canvasRel && !page) fail(`no canvas.json or page under ${src}: read the artifact's project/canvas.json, or its page, first`);
  const home = dirname(canvasRel ?? page);
  const files = new Set(canvasRel ? [canvasRel] : []);
  const queue = all.filter((f) => /\.html?$/i.test(f) && (home === '.' || f.startsWith(home + sep)));
  const missing = []; const remote = [];
  const blobs = {}; const copyFrom = {}; const noAsset = new Set();
  // An asset file is named by its id, with or without an extension, anywhere in the snapshot.
  const assetAt = new Map();
  for (const f of all) {
    const id = basename(f).replace(/\.[^.]*$/, '').toLowerCase();
    if (isAssetId(id) &&(!assetAt.has(id) || f.length < assetAt.get(id).length)) assetAt.set(id, f);
  }
  const runtime = all.filter((f) => basename(f) === RUNTIME).sort((a, b) => a.length - b.length)[0];
  queue.forEach((f) => files.add(f));
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    const text = readFileSync(join(src, from), 'utf8');
    for (const id of blobIds(text)) {
      if (blobs[id]) continue;
      const at = assetAt.get(id);
      if (!at) {
        if (!noAsset.has(id)) { noAsset.add(id); missing.push(`asset ${id} (from ${from} as /_blob/${id}: read it from the artifact by its id)`); }
        continue;
      }
      const rel = join(home, 'assets', `${id}${assetExt(join(src, at))}`);
      blobs[id] = rel; files.add(rel);
      if (rel !== at) copyFrom[rel] = at;
    }
    for (const ref of references(text)) {
      if (isInline(ref) || blobIds(ref).length) continue;
      if (isRemote(ref)) { if (!remote.includes(ref)) remote.push(ref); continue; }
      let path = ref.replace(/[?#].*$/, '');
      try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
      if (!path) continue;
      const rel = normalize(path.startsWith('/') ? path.slice(1) : join(dirname(from), path));
      if (rel.startsWith('..') || isAbsolute(rel)) { missing.push(`${ref} (from ${from}: outside the snapshot)`); continue; }
      if (!existsSync(join(src, rel)) || !statSync(join(src, rel)).isFile()) {
        if (basename(rel) === 'support.js' && runtime) { files.add(rel); copyFrom[rel] = runtime; continue; }
        missing.push(`${rel} (from ${from})`); continue;
      }
      if (files.has(rel)) continue;
      files.add(rel);
      if (TEXT.has(extname(rel).toLowerCase())) queue.push(rel);
    }
  }
  return { canvas: canvasRel, home, files: [...files].sort(), missing, remote, blobs, copyFrom };
}

// A board's text with each /_blob/<id> pointing at the asset's saved path, relative to the board.
export function localiseBlobs(text, file, blobs) {
  return text.replace(BLOB, (m, id) => {
    const to = blobs[id.toLowerCase()];
    return to ? relative(dirname(file), to).split(sep).join('/') : m;
  });
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
  // An HTML export's file name and hash describe its version too.
  const from = next.from ? next : prev?.from && String(prev.version) === String(next.version) ? prev : null;
  return {
    url: next.url, version: String(next.version), fetched_at: next.fetched_at,
    ...(from ? { from: from.from, file: from.file, sha256: from.sha256 } : {}),
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
    ...(source.from === 'export'
      ? [`Saved by \`desk-design\` from ${source.file}, an HTML export of <${source.url}> (sha256 ${source.sha256}),`,
        `version ${source.version}, imported ${source.fetched_at}.`]
      : [`Saved by \`desk-design\` from <${source.url}>, version ${source.version}, fetched ${source.fetched_at}.`]),
    'Open any board\'s HTML from this folder: it renders offline with the files saved beside it.',
    source.from === 'export'
      ? 'Do not edit these files by hand. For a newer export, run `desk-design import` on it, then'
      : 'Do not edit these files by hand. When the artifact has a newer version, re-save it with',
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

  const { canvas, files, missing, remote, blobs, copyFrom } = collect(src);
  if (missing.length) fail(`not saved: the snapshot lacks files the boards reference; read them from the artifact too:\n${missing.map((m) => `missing: ${m}`).join('\n')}`, 4);
  const boards = canvas ? parseBoards(readJson(join(src, canvas)) ?? {}) : [];

  // A re-save replaces the old version's files, so none outlive it: its screens included.
  const stale = String(prev?.screens?.version) !== String(version) ? (prev?.screens?.images ?? []).map((s) => s.file) : [];
  for (const f of [...(prev?.files ?? []), ...stale]) {
    const p = normalize(join(dest, f));
    if (!files.includes(f) && p.startsWith(dest + sep) && existsSync(p)) rmSync(p);
  }
  for (const f of files) {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    const from = join(src, copyFrom[f] ?? f);
    if (TEXT.has(extname(f).toLowerCase())) {
      const text = readFileSync(from, 'utf8');
      const local = localiseBlobs(text, f, blobs);
      if (local !== text) { writeFileSync(join(dest, f), local); continue; }
    }
    copyFileSync(from, join(dest, f));
  }
  const fromExport = meta?.from && String(meta.version) === String(version) ? { from: meta.from, file: meta.file, sha256: meta.sha256 } : {};
  const source = writeRecord(dest, {
    url, version, fetched_at: fetchedAt ?? meta?.fetched_at ?? now, dir: name, tickets: all, boards, files, ...fromExport,
  });
  return { path: destRel, source, files, remote, reused: !!existing, previous: prev?.version ?? null };
}

// ---- import (a design's HTML export) -----------------------------------------------------------

// Every URL a page loads: a src or poster, each srcset candidate, a stylesheet, icon, preload or
// manifest <link>'s href, an SVG <image> or <use>'s href, an <object>'s data, CSS url() and @import,
// and a script's import of a quoted URL, in the order the page names them. An <a>'s href, or a
// canonical <link>, is a link rather than a load. A template binding names no file, unless it sits
// in a URL to another host. Attributes are read only in tags, and a script's body only for its
// imports: an inline runtime's `img.src = u` is code, not a load. The page is read once, left to
// right, so a `<!--` in a script, a stylesheet or an attribute's value never hides what follows it.
const PART = /<!--[\s\S]*?(?:-->|$)|(<script\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)(?:<\/script\s*>|$)|<style\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?(?:<\/style\s*>|$)|<[a-z](?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const TAG = /<([a-z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
const IMPORT = /(?<![\w$.'"`-])import\s*(?:\(\s*|[\w$*{}\s,]+?\sfrom\s*|(?=["']))(["'])([^"'\n]+)\1/g;
const SVG_HREF = new Set(['image', 'use', 'feimage']);
// A srcset's URLs: each candidate's URL is its run of non-space characters, so a data: URL's comma
// stays in it; a trailing comma ends the candidate, else its descriptors run to the next comma.
function candidates(set) {
  const out = [];
  let rest = set;
  while ((rest = rest.replace(/^[\s,]+/, ''))) {
    const word = /^\S+/.exec(rest)[0];
    const url = word.replace(/,+$/, '');
    out.push(url);
    rest = rest.slice(word.length);
    if (url === word) rest = rest.replace(/^[^,]*/, '');
  }
  return out;
}
export function loads(text) {
  const found = [];
  const add = (at, r) => { const v = String(r ?? '').trim(); if (v && (!v.includes('{{') || isRemote(v))) found.push({ at, v }); };
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const scripts = [];
  const markup = text.replace(PART, (m, open, body, at) => {
    if (m.startsWith('<!--')) return blank(m);
    if (open === undefined) return m;
    scripts.push({ open, body, at: at + open.length });
    return open + blank(body) + m.slice(open.length + body.length);
  });
  for (const t of markup.matchAll(TAG)) {
    const tag = t[1].toLowerCase();
    const attrs = new Map([...t[2].matchAll(ATTR)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']));
    const at = t.index;
    for (const a of ['src', 'poster']) if (attrs.has(a)) add(at, attrs.get(a));
    for (const a of ['srcset', 'imagesrcset']) if (attrs.has(a)) for (const u of candidates(attrs.get(a))) add(at, u);
    if (tag === 'link' && /\b(?:stylesheet|icon|preload|modulepreload|manifest)\b/i.test(attrs.get('rel') ?? '')) add(at, attrs.get('href'));
    if (SVG_HREF.has(tag)) add(at, attrs.get('href') ?? attrs.get('xlink:href'));
    if (tag === 'object') add(at, attrs.get('data'));
  }
  for (const s of scripts) {
    const type = /\stype\s*=\s*["']?([^"'\s>]*)/i.exec(s.open)?.[1].toLowerCase() ?? '';
    if (type && type !== 'module' && !/javascript|ecmascript/.test(type)) continue;
    for (const m of s.body.matchAll(IMPORT)) add(s.at + m.index, m[2]);
  }
  for (const m of markup.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) add(m.index, m[1] ?? m[2] ?? m[3]);
  for (const m of markup.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) add(m.index, m[1] ?? m[2]);
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.v))];
}

const SELF_CONTAINED = /^(?:data|blob|about|javascript):/i;

// Takes an exported design (one self-contained HTML page) as a single-page snapshot under
// <state>/designs/, in the folder already holding the artifact or <EPIC or first key>. Its version is
// the file's modified time, kept while the content is unchanged and told apart by hash when a
// different file has the same time. A page that loads anything but a data: or blob: URL is refused
// before anything is written.
export function importExport(file, { state, url, tickets, epic, now = new Date().toISOString() }) {
  if (!existsSync(file) || !statSync(file).isFile()) fail(`no export file at ${file}`);
  if (!url) fail('import needs --url: the artifact the export was downloaded from');
  if (!tickets.length) fail('import needs at least one --key');
  const bytes = readFileSync(file);
  const external = loads(bytes.toString('utf8')).find((r) => !SELF_CONTAINED.test(r) && !r.startsWith('#'));
  if (external) fail(`not imported: ${basename(file)} is not a self-contained page: it loads ${external}. Export the design again as one HTML file, or snapshot the artifact`, 4);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const held = snapshotOf(state, url);
  const name = held ? basename(held) : (epic ?? tickets[0].key);
  if (!safeId(name)) fail(`not a folder name for a design: ${name}`);
  const dest = held ?? join(state, 'designs', name);
  const prev = readJson(join(dest, 'source.json'));
  if (prev?.url && canonicalUrl(prev.url) !== canonicalUrl(url)) fail(`${dest} already holds ${prev.url}: pass --epic to import this design elsewhere`);
  const mtime = statSync(file).mtime.toISOString();
  const version = prev?.sha256 === sha256 ? String(prev.version)
    : prev && String(prev.version).split('+')[0] === mtime ? `${mtime}+${sha256.slice(0, 12)}` : mtime;
  // The export is the whole design: whatever an earlier snapshot held beside it goes.
  if (existsSync(dest)) for (const f of readdirSync(dest)) if (f !== 'source.json') rmSync(join(dest, f), { recursive: true, force: true });
  mkdirSync(join(dest, 'project'), { recursive: true });
  writeFileSync(join(dest, 'project', 'index.html'), bytes);
  const source = writeRecord(dest, {
    url, version, fetched_at: now, dir: prev?.dir ?? name, tickets, from: 'export', file: basename(file), sha256, boards: [], files: ['project/index.html'],
  });
  return { path: dest, source, previous: prev?.version ?? null };
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
  const shots = boards.flatMap((b, i) => [...new Set([...bps, b.width])].filter(Number.isFinite).sort((x, y) => x - y)
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
  const { canvas, home, files } = collect(dir);
  // A single-page artifact's pages render at every breakpoint, with no width of their own.
  const boards = canvas ? parseBoards(readJson(join(dir, canvas)) ?? {})
    : files.filter((f) => /\.html?$/i.test(f) && dirname(f) === home).map((f) => ({ name: basename(f).replace(/\.html?$/i, ''), width: null, file: basename(f) }));
  if (!boards.length) fail(`${canvas} names no boards: nothing to render`);
  const plan = renderPlan(boards, bps);
  const names = screenNames(boards);
  const pages = new Map(boards.map((b, i) => {
    const rel = b.file && normalize(join(home, b.file));
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

// The snapshot folder under <state>/designs/ that holds this artifact, or null. /desk-admit snapshots
// an artifact when it admits the ticket, and autopilot before triage; the worker saves it on its
// branch. A named batch's state (<repo state>/batches/<name>) also reads the repo's own, where
// /desk-admit saves.
export function snapshotOf(state, url) {
  const repoState = state.replace(new RegExp(`[/\\\\]${E.BATCHES_DIR}[/\\\\][^/\\\\]+[/\\\\]?$`), '');
  for (const base of [...new Set([state, repoState])].map((s) => join(s, 'designs'))) {
    if (!existsSync(base)) continue;
    const d = readdirSync(base).find((x) => canonicalUrl(readJson(join(base, x, 'source.json'))?.url) === canonicalUrl(url));
    if (d) return join(base, d);
  }
  return null;
}

// Every saved canvas under <dir> as committed at <ref>: [{path, url, version}].
export function savedAt(root, dir, ref) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  return git('ls-tree', '-r', '--name-only', ref, '--', `${dir}/`).split('\n')
    .filter((f) => f.slice(dir.length + 1).split('/').length === 2 && f.endsWith('/source.json'))
    .map((f) => { let s = null; try { s = JSON.parse(git('show', `${ref}:${f}`)); } catch { /* unreadable */ } return { path: `${dirname(f)}/`, url: s?.url, version: s?.version }; })
    .filter((c) => c.url);
}

// The base a batch's workers branch from, as origin has it where fetched: origin/<base>, else <base>.
export function baseRef(root) {
  const base = E.batchBase() ?? E.defaultBranch();
  try { execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `origin/${base}`], { stdio: 'ignore' }); return `origin/${base}`; } catch { return base; }
}

// ---- propose (the snapshot into the repo, at admission) ------------------------------------------

// Commits a snapshot into <dir>/ on docs/design-<name>, a branch off <ref> (the batch's base) in its
// own worktree under <worktrees>, so the session that took the snapshot opens the PR that puts the
// design's source in the repo before any worker builds from it. A branch already on origin is
// carried on from there. Nothing is done when <ref> already holds the snapshot's version.
export function propose(src, { root, dir, ref, worktrees }) {
  const meta = readJson(join(src, 'source.json'));
  if (!meta?.url) fail(`no snapshot at ${src}: record it first (desk-design write or import)`);
  let onBase = null;
  try { onBase = savedAt(root, dir, ref).find((c) => canonicalUrl(c.url) === canonicalUrl(meta.url)) ?? null; } catch { /* nothing on a base that does not resolve */ }
  if (onBase && String(onBase.version) === String(meta.version)) return { state: 'saved', path: onBase.path, ref };
  const name = onBase ? basename(onBase.path.replace(/\/$/, '')) : (meta.dir ?? meta.tickets?.[0]?.key);
  if (!safeId(name)) fail(`not a folder name for a canvas: ${name}`);
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const branch = `docs/design-${name}`;
  let pushed = false;
  try { pushed = !!git(root, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`); } catch { /* no origin */ }
  if (pushed) { try { git(root, 'fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); } catch { pushed = false; } }
  const wt = join(worktrees, `design-${name}`);
  if (!existsSync(wt)) git(root, 'worktree', 'add', '-q', '-B', branch, wt, pushed ? `origin/${branch}` : ref);
  else if (git(wt, 'rev-parse', '--abbrev-ref', 'HEAD') !== branch) fail(`${wt} is not on ${branch}: remove that worktree or check ${branch} out there`);
  const r = save(src, { root: wt, dir, tickets: [], epic: name });
  git(wt, 'add', '-A', '--', r.path);
  try { git(wt, 'diff', '--cached', '--quiet'); return { state: 'unchanged', branch, worktree: wt, path: r.path, ref, pushed }; } catch { /* staged changes */ }
  git(wt, 'commit', '-q', '-m', `docs(design): save the ${name} design canvas, version ${r.source.version}`);
  return { state: 'committed', branch, worktree: wt, path: r.path, ref, pushed, sha: git(wt, 'rev-parse', 'HEAD'), remote: r.remote };
}

// What a lane D worker can build from: {ref, canvases: [{url, saved, snapshot}], figma}. A canvas is
// readable when it is saved under <dir> on <ref> (the batch's base) or snapshotted under <state>;
// with no <dir> (the repo saves none) only a snapshot is.
export function designFact(text, { root, dir, ref, state }) {
  const section = designSection(String(text ?? '').replace(/\\([-_*+^~?#{}[\]|!])/g, '$1'));
  const saved = dir ? savedAt(root, dir, ref) : [];
  return {
    ref,
    canvases: claudeDesignLinks(section).map((url) => ({
      url,
      saved: saved.find((c) => canonicalUrl(c.url) === canonicalUrl(url))?.path ?? null,
      snapshot: snapshotOf(state, url),
    })),
    figma: /https?:\/\/(?:[a-z0-9-]+\.)*figma\.com\//i.test(section ?? ''),
  };
}

// Findings for one ticket: {severity: 'blocking'|'advisory', message}. `issue` is desk-jira's
// --json issue, or {key, text} for a ticket file. A canvas is saved when it is committed under <dir>
// on <ref> (the batch's base), whatever the working tree holds. It belongs under the ticket's epic
// when it has one, else under the ticket itself. One with a snapshot under <state> is advisory: the
// worker saves it from there.
export function checkTicket(issue, { root, dir, ref = baseRef(root), state }) {
  const key = issue.key;
  // A Jira description is wiki markup, where desk-jira's markdown conversion escapes `-` and `_` in
  // a code span ({{…/p/1a2b\-3c4d}}); unescaped, the link and the repo path read as written.
  const text = String(issue.text ?? issue.fields?.description ?? '').replace(/\\([-_*+^~?#{}[\]|!])/g, '$1');
  const parent = issue.fields?.parent;
  const epic = parent && isEpic(parent.fields?.issuetype) ? parent.key : null;
  const section = designSection(text);
  const findings = [];
  const links = claudeDesignLinks(section);
  let onBase = [];
  // A base that does not resolve has nothing saved on it; the finding names the ref it read.
  if (links.length) { try { onBase = savedAt(root, dir, ref); } catch { /* no such ref */ } }
  for (const url of links) {
    const saved = onBase.find((c) => canonicalUrl(c.url) === canonicalUrl(url));
    if (!saved) {
      const message = `design: ${key}'s Design section links the Claude Design artifact ${url}, but no copy is saved under ${dir}/ on ${ref}: save it to ${join(dir, epic ?? key)}/ (desk-design save)`;
      const snap = state ? snapshotOf(state, url) : null;
      findings.push(snap ? { severity: 'advisory', message: `${message}; it is snapshotted at ${snap}, so the worker saves it from there` } : { severity: 'blocking', message });
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
    } else if (cmd === 'import') {
      if (!target) fail('usage: desk-design import <file> --url <u> --key <K> [--key ...] [--epic <E>]');
      const r = importExport(resolve(target), { state: E.stateDir(), url: opt(rest, '--url'), tickets: ticketsFromArgs(rest), epic: opt(rest, '--epic') });
      const was = r.previous && String(r.previous) !== String(r.source.version) ? `, replacing version ${r.previous}` : '';
      console.log(`imported: ${r.path} (version ${r.source.version}${was}; sha256 ${r.source.sha256}; tickets ${r.source.tickets.map((t) => t.key).join(' ')})`);
    } else if (cmd === 'propose') {
      if (!target) fail('usage: desk-design propose <snapshot dir>');
      const root = toplevel(); const ref = baseRef(root);
      const r = propose(resolve(target), { root, dir: designDir(), ref, worktrees: E.worktreesDir() });
      const base = ref.replace(/^origin\//, '');
      if (r.state === 'saved') console.log(`saved: ${r.path} on ${ref} already holds this version: no PR needed`);
      else if (r.state === 'unchanged') console.log(`unchanged: ${r.branch} in ${r.worktree} already holds this version (base ${base})`);
      else {
        console.log(`committed: ${r.path} on ${r.branch} in ${r.worktree} (${r.sha.slice(0, 7)}, base ${base}${r.pushed ? ', updating the branch already on origin' : ''})`);
        for (const u of r.remote) console.log(`remote: ${u} (loads from the network, so it will not render offline)`);
      }
    } else if (cmd === 'status') {
      const version = opt(rest, '--version');
      if (!target || !version) fail('usage: desk-design status <saved dir | artifact URL> --version <v>');
      const s = /^https?:\/\//i.test(target) ? status(target, version, { root: toplevel(), dir: designDir() }) : status(target, version);
      if (s.state === 'unsaved') { console.log(`unsaved: no saved copy of ${target}`); process.exit(4); }
      if (s.state === 'current') console.log(`current: the saved copy is version ${s.saved}`);
      else { console.log(`newer: saved version ${s.saved}, the artifact is at ${version}; re-save it with desk-design save`); process.exit(3); }
    } else if (cmd === 'check') {
      if (!target) fail('usage: desk-design check <KEY | ticket file> [--key <K>]');
      const findings = checkTicket(loadIssue(target, opt(rest, '--key')), { root: toplevel(), dir: designDir(), state: E.stateDir() });
      for (const f of findings) console.log(`${f.severity}: ${f.message}`);
      if (!findings.length) console.log('ok: no unsaved Claude Design canvas');
      process.exit(findings.some((f) => f.severity === 'blocking') ? 1 : 0);
    } else if (cmd === 'snapshots') {
      if (!target) fail('usage: desk-design snapshots <KEY | ticket file> [--key <K>]');
      const issue = loadIssue(target, opt(rest, '--key'));
      for (const s of designFact(issue.text ?? issue.fields?.description, { state: E.stateDir() }).canvases) console.log(`${s.url}\t${s.snapshot ?? '-'}`);
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
      fail('usage: desk-design.mjs write|save|import|propose|status|check|snapshots|render ... (see the top of the file)');
    }
  } catch (e) {
    console.error(`desk-design: ${e.message}`);
    process.exit(typeof e.code === 'number' ? e.code : 2);
  }
}
