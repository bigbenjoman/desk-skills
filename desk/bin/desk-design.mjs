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
//       in its place. A Slides deck (deck.json and slides/<id>.html) is saved the same way, with an
//       index.html beside it that shows every slide in order offline. source.json records the
//       kind: canvas, deck or page
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
//       exit 1 when the ticket's Design section links a Claude Design artifact, or the rest of it
//       (Out of scope aside) a claude.ai artifact, with no copy saved on the batch's base
//       (origin/<base> where fetched), whatever the working tree holds, and no snapshot
//   node desk-design.mjs copies <KEY | ticket file> [--key <K>]
//       one `<url>\t<copy, or ->` line per claude.ai artifact the ticket links: the folder saved in
//       this checkout or on the base, else its snapshot; what a worker reads instead of the link.
//       Exit 1 when any has no copy
//   node desk-design.mjs snapshots <KEY | ticket file> [--key <K>]
//       one `<url>\t<snapshot folder, or ->` line per Claude Design artifact the Design section links,
//       found by URL in this state's designs/ and, in a named batch, the repo state's
//   node desk-design.mjs render <saved dir>
//       renders every board at config §5 Breakpoints (default 390 768 1024 1280 1440) and at its own
//       width into <dir>/screens/<board>@<width>.png, and lists them in the README; exit 4 (nothing
//       written) when a board fails to load a file, asks claude.ai for one, or renders blank, 6 when
//       Playwright is missing
//   node desk-design.mjs compare <saved dir> --storybook <built folder> --out <dir> [--boards <a,b>]
//       shoots each board beside the story whose id or title matches its name, at config §5
//       Breakpoints (as render) and the board's own width, into <out> as canvas-<board>-<w>.png and
//       built-<board>-<w>.png; a board with no story is listed as not compared. Exit 3 when there
//       is no Storybook index there, 4 (nothing written) when a board or story fails, 6 as render
//   node desk-design.mjs estimate <saved dir> [--key <K>]
//       the uploads the ticket's PR needs once boards are stitched (its boards × config §5 Themes,
//       one when unset) and the time at the upload pace; a `flag:` line when that is over an hour
// `--boards` binds to the `--key` before it; a key with none uses every board. compare's
// `--boards` names the boards to shoot, every board without it. A board is named by its title, which
// may hold commas, or its file name; a name matching no board exits 2. Usage errors exit 2.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { isEpic } from './desk-q-eta.mjs';
import { parseCapture } from './stitch-boards.mjs';

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
  // A font a board's @font-face loads from the asset store.
  const font = { wOF2: '.woff2', wOFF: '.woff', OTTO: '.otf', true: '.ttf', '\0\x01\0\0': '.ttf' }[b.subarray(0, 4).toString('latin1')];
  if (font) return font;
  if (/<svg\b/i.test(b.toString('utf8'))) return '.svg';
  return '';
}

const isRemote = (r) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(r);
const isInline = (r) => /^(?:data|blob|about|javascript|mailto|tel):/i.test(r) || r.startsWith('#');
const TEXT = new Set(['.html', '.htm', '.css']);

// Every URL a script names that is a script, stylesheet or font it loads. A script names other URLs
// that load nothing (an XML namespace, an error page), so only those paths count.
export function scriptLoads(text) {
  const out = [];
  for (const [u] of text.matchAll(/https?:\/\/[^\s"'`\\()<>]+/gi)) {
    let path;
    try { path = new URL(u).pathname; } catch { continue; }
    if (/\.(?:m?js|css|woff2?|ttf|otf)$/i.test(path) && !out.includes(u)) out.push(u);
  }
  return out;
}

// The hosts a list of remote URLs loads from, in order, each once.
export const remoteHosts = (urls) => [...new Set(urls.map((u) => {
  try { return new URL(u.startsWith('//') ? `https:${u}` : u).host.toLowerCase(); } catch { return null; }
}).filter(Boolean))];

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
// those reference, followed through CSS. A Slides deck has deck.json in its place (`deck`), and
// each slide deck.json orders is slides/<id>.html beside it. A single-page artifact has neither
// (`canvas` and `deck` null): its pages are the HTML files beside the shallowest one. `kind` says
// which of the three it is. A reference that leaves <src> or names a file the
// snapshot lacks is `missing`; one to another host, or a file a saved script loads from one, is
// `remote` (it needs the network to render).
// `blobs` maps each asset id the boards use to its saved path, and `copyFrom` maps a saved path to
// the snapshot file it comes from where the two differ: an asset, or support.js from dc-runtime.js.
export function collect(src) {
  const all = walkFiles(src);
  const shallowest = (name) => all.filter(name).sort((a, b) => a.split(sep).length - b.split(sep).length || a.length - b.length)[0];
  const kind = kindOfFiles(all);
  if (!kind) fail(`no canvas.json, deck.json or page under ${src}: read the artifact's project/canvas.json, project/deck.json, or its page, first`);
  const canvasRel = kind === 'canvas' ? shallowest((f) => basename(f) === 'canvas.json') : null;
  const deckRel = kind === 'deck' ? shallowest((f) => basename(f) === 'deck.json') : null;
  const page = kind === 'page' ? shallowest((f) => /\.html?$/i.test(f)) : null;
  const home = dirname(canvasRel ?? deckRel ?? page);
  const files = new Set([canvasRel, deckRel].filter(Boolean));
  const queue = all.filter((f) => /\.html?$/i.test(f) && (home === '.' || f.startsWith(home + sep)));
  const missing = []; const remote = [];
  const deck = deckRel ? readJson(join(src, deckRel)) : null;
  const slides = deckSlides(deck);
  for (const id of slides) {
    const rel = join(home, 'slides', `${id}.html`);
    if (!safeId(id) || !queue.includes(rel)) missing.push(`slide ${id} (deck.json orders it: read ${rel} from the artifact)`);
  }
  // The deck's font faces load from the network.
  for (const f of Object.values(deck?.faces ?? {})) if (typeof f?.href === 'string' && f.href && !remote.includes(f.href)) remote.push(f.href);
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
  // A script loads files too: the runtime saved as support.js fetches React, ReactDOM and Babel from a CDN.
  for (const f of files) {
    if (extname(f).toLowerCase() !== '.js') continue;
    for (const u of scriptLoads(readFileSync(join(src, copyFrom[f] ?? f), 'utf8'))) if (!remote.includes(u)) remote.push(u);
  }
  return { canvas: canvasRel, deck: deckRel, kind, slides, home, files: [...files].sort(), missing, remote, blobs, copyFrom };
}

// ---- a Slides deck ---------------------------------------------------------------------------

// The slide ids deck.json lists, in order.
export const deckSlides = (deck) => (Array.isArray(deck?.order) ? deck.order.filter((id) => typeof id === 'string' && id) : []);

// Slides are drawn at a fixed 1920×1080.
const SLIDE_W = 1920; const SLIDE_H = 1080;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// An <img data-crop="<scale> <x> <y>"> shows its focal point through object-position, which the
// Slides runtime sets from data-crop; written into its style here where the style lacks one.
export function applyCrops(html) {
  return html.replace(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, (tag) => {
    const crop = /\sdata-crop\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const at = /^\s*[\d.]+\s+(-?[\d.]+%)\s+(-?[\d.]+%)\s*$/.exec(crop?.[1] ?? crop?.[2] ?? '');
    if (!at) return tag;
    const pos = `object-position:${at[1]} ${at[2]};`;
    const style = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!style) return tag.replace(/\s*\/?>$/, (end) => ` style="${pos}"${end}`);
    const css = style[2] ?? style[3];
    if (/(^|;)\s*object-position\s*:/i.test(css)) return tag;
    const q = style[2] !== undefined ? '"' : "'";
    return tag.slice(0, style.index) + `${style[1]}${q}${pos}${css}${q}` + tag.slice(style.index + style[0].length);
  });
}

// The deck's offline viewer: every slide in deck.json order inlined into a 1920×1080 frame, scaled
// to the window, its images at their saved paths and its speaker notes (<aside>) hidden. Inlined
// rather than loaded, so it opens from file://. `slides` is [{id, html}] with blobs already pointed
// at paths relative to the viewer.
export function deckViewer(deck, slides) {
  const fonts = Object.values(deck?.faces ?? {}).map((f) => f?.href).filter((h) => typeof h === 'string' && h);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(deck?.title ?? 'Slides deck')} (offline copy)</title>`,
    ...fonts.map((h) => `<link rel="stylesheet" href="${esc(h)}">`),
    '<style>',
    '*{margin:0;box-sizing:border-box}',
    'body{background:#2b2724;padding:24px 0}',
    `.frame{width:${SLIDE_W}px;height:${SLIDE_H}px;margin:0 auto 24px;position:relative;overflow:hidden}`,
    `.frame>section{position:relative;width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden}`,
    'section aside{display:none}',
    '</style></head><body>',
    ...slides.map((s) => `<div class="frame" data-slide="${esc(s.id)}">${applyCrops(s.html).trim()}</div>`),
    '<script>',
    `function fit(){var k=Math.min(window.innerWidth-32,${SLIDE_W})/${SLIDE_W};document.querySelectorAll('.frame').forEach(function(f){f.style.zoom=k})}`,
    "addEventListener('resize',fit);fit();",
    '</script>',
    '</body></html>',
    '',
  ].join('\n');
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

// [{key, boards, boardsArg}] from argv: each --boards applies to the --key before it. Its value
// stays whole until withBoards reads it against the canvas, since a board's title may hold commas.
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
      t.boardsArg = args[++i] ?? '';
    }
  }
  return out;
}

// The board titles one --boards value names. A board is named by its title or its file name
// (`Main.dc.html`), and a title may hold commas, so the longest run of comma-separated pieces that
// names a board is taken before a comma splits it. A name matching no board is refused (exit 2),
// listing the boards; with no boards to match (a single page, a deck, an export) it splits on commas.
export function resolveBoards(value, boards, where = 'canvas.json') {
  const pieces = String(value ?? '').split(',');
  if (!boards.length) return pieces.map((b) => b.trim()).filter(Boolean);
  const find = (n) => boards.find((b) => b.name === n) ?? boards.find((b) => b.file && (b.file === n || basename(b.file) === n));
  const out = []; const unknown = [];
  for (let i = 0; i < pieces.length;) {
    let j = pieces.length; let b = null;
    for (; j > i && !(b = find(pieces.slice(i, j).join(',').trim())); j--);
    if (b) { if (!out.includes(b.name)) out.push(b.name); i = j; continue; }
    if (pieces[i].trim()) unknown.push(pieces[i].trim());
    i++;
  }
  if (unknown.length) {
    fail(`${where} has no board named ${unknown.map((n) => `"${n}"`).join(', ')}; its boards are:\n${boards.map((b) => `board: ${b.name}${b.file ? ` (${b.file})` : ''}`).join('\n')}`);
  }
  return out;
}

// Each ticket's --boards value read against the canvas's boards, so only titles are recorded.
const withBoards = (tickets, boards, where) => tickets.map(({ boardsArg, ...t }) => (boardsArg === undefined ? t : { ...t, boards: resolveBoards(boardsArg, boards, where) }));

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
  // What the artifact is (canvas, deck or page), which check reads to decide whether a link blocks.
  const kind = next.kind ?? prev?.kind;
  const slides = next.slides ?? prev?.slides;
  // The boards' folder beside the README, and what the saved files load from other hosts: the
  // README's paths and its offline claim. A write that does not know `remote` keeps it at the same version only.
  const home = next.home ?? prev?.home;
  const remote = next.remote ?? (String(prev?.version) === String(next.version) ? prev?.remote : undefined);
  return {
    url: next.url, version: String(next.version), fetched_at: next.fetched_at,
    ...(from ? { from: from.from, file: from.file, sha256: from.sha256 } : {}),
    ...(kind ? { kind } : {}),
    dir: next.dir ?? prev?.dir ?? null, tickets,
    boards: next.boards ?? prev?.boards ?? [], ...(kind === 'deck' && slides ? { slides } : {}),
    files: next.files ?? prev?.files ?? [], ...(home ? { home } : {}), ...(remote ? { remote } : {}), screens,
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
  const deck = source.kind === 'deck';
  // A board's file is relative to its canvas.json, which sits in `home` (project/) beside the README.
  const home = source.home && source.home !== '.' ? source.home.replace(/\/+$/, '') : null;
  const at = (f) => (home ? `${home}/${f}` : f);
  // A record saved before `remote` was kept says nothing about the network rather than guess.
  const hosts = Array.isArray(source.remote) ? remoteHosts(source.remote) : null;
  const network = hosts === null ? '.'
    : hosts.length ? `. The boards need the network: they load files from ${hosts.map((h) => `\`${h}\``).join(', ')}.`
      : ': it renders offline with the files saved beside it.';
  return [
    `# ${deck ? 'Slides deck' : 'Design canvas'}${source.dir ? ` ${source.dir}` : ''}`,
    '',
    ...(source.from === 'export'
      ? [`Saved by \`desk-design\` from ${source.file}, an HTML export of <${source.url}> (sha256 ${source.sha256}),`,
        `version ${source.version}, imported ${source.fetched_at}.`]
      : [`Saved by \`desk-design\` from <${source.url}>, version ${source.version}, fetched ${source.fetched_at}.`]),
    deck
      ? 'Open index.html from this folder: every slide in order at 1920×1080, offline, with its speaker notes hidden.'
      : `Open any board's HTML from ${home ? `\`${home}/\`` : 'this folder'}${network}`,
    source.from === 'export'
      ? 'Do not edit these files by hand. For a newer export, run `desk-design import` on it, then'
      : 'Do not edit these files by hand. When the artifact has a newer version, re-save it with',
    '`desk-design save`, which replaces them.',
    '',
    '| Ticket | Boards |',
    '|---|---|',
    ...(source.tickets ?? []).map((t) => `| ${cell(t.key)} | ${cell(forTicket(t))} |`),
    '',
    ...(deck
      ? ['## Slides', '', ...(source.slides?.length ? source.slides.map((id, i) => `${i + 1}. ${id}`) : ['deck.json orders no slides.'])]
      : ['## Boards', '', ...(boards.length
        ? ['| Board | Width | File |', '|---|---|---|', ...boards.map((b) => `| ${cell(b.name)} | ${b.width}px | ${b.file ? cell(at(b.file)) : '-'} |`)]
        : ['canvas.json names no boards.'])]),
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
  const existing = findSaved(root, dir, url);
  const name = existing ? basename(existing.path.replace(/\/$/, '')) : (epic ?? meta?.dir ?? tickets[0].key);
  if (!safeId(name)) fail(`not a folder name for a canvas: ${name}`);
  const destRel = `${join(dir, name)}/`;
  const dest = join(root, dir, name);
  const prev = readJson(join(dest, 'source.json'));
  if (prev?.url && canonicalUrl(prev.url) !== canonicalUrl(url)) fail(`${destRel} already holds ${prev.url}: pass --epic to save this canvas elsewhere`);

  const { canvas, deck, kind, slides, home, files, missing, remote, blobs, copyFrom } = collect(src);
  if (missing.length) fail(`not saved: the snapshot lacks files the boards reference; read them from the artifact too:\n${missing.map((m) => `missing: ${m}`).join('\n')}`, 4);
  const boards = canvas ? parseBoards(readJson(join(src, canvas)) ?? {}) : [];
  // A batch snapshot lists every ticket sharing the canvas, so parallel workers write identical files.
  const all = [...(meta?.tickets ?? [])];
  for (const t of withBoards(tickets, boards, canvas)) { const i = all.findIndex((p) => p.key === t.key); if (i < 0) all.push(t); else if (t.boards.length) all[i] = t; }
  // A deck is read through the viewer save writes beside its project folder.
  const viewer = deck ? 'index.html' : null;
  const saved = viewer ? [...new Set([...files, viewer])].sort() : files;

  // A re-save replaces the old version's files, so none outlive it: its screens included.
  const stale = String(prev?.screens?.version) !== String(version) ? (prev?.screens?.images ?? []).map((s) => s.file) : [];
  for (const f of [...(prev?.files ?? []), ...stale]) {
    const p = normalize(join(dest, f));
    if (!saved.includes(f) && p.startsWith(dest + sep) && existsSync(p)) rmSync(p);
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
  if (viewer) {
    const html = slides.map((id) => ({ id, html: localiseBlobs(readFileSync(join(src, home, 'slides', `${id}.html`), 'utf8'), viewer, blobs) }));
    writeFileSync(join(dest, viewer), deckViewer(readJson(join(src, deck)), html));
  }
  const fromExport = meta?.from && String(meta.version) === String(version) ? { from: meta.from, file: meta.file, sha256: meta.sha256 } : {};
  const source = writeRecord(dest, {
    url, version, fetched_at: fetchedAt ?? meta?.fetched_at ?? now, dir: name, kind, tickets: all, boards, files: saved,
    home: home.split(sep).join('/'), remote, ...(deck ? { slides } : {}), ...fromExport,
  });
  return { path: destRel, source, files: saved, remote, reused: !!existing, previous: prev?.version ?? null };
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
// A static import or a re-export names its URL after `from`, which a minifier runs up against the
// clause (`import{a}from"u"`, `export*from"u"`); a side-effect import and import() name it straight away.
const IMPORT = /(?<![\w$.'"`-])(?:import\s*(?:\(\s*|(?=["']))|(?:import|export)\s*[\w$*{}\s,]*?(?<=[\s}*])from\s*)(["'])([^"'\n]+)\1/g;
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
    url, version, fetched_at: now, dir: prev?.dir ?? name, kind: 'page', tickets, from: 'export', file: basename(file), sha256, boards: [], files: ['project/index.html'],
    home: 'project', remote: [],
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

// The design tool's own host (claude.ai, or the host the artifact URL names), which serves a board's
// runtime, fonts and assets only to a signed-in browser. A saved board that still asks it for a file
// does not render offline.
export function callsHome(url, artifactUrl) {
  const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
  const h = host(url);
  if (!h) return false;
  const own = artifactUrl ? host(artifactUrl) : null;
  return /(^|\.)claude\.ai$/.test(h) || (!!own && h === own);
}

// A request for a template binding the runtime has not filled in yet (`<img src="{{logo}}">` outside
// a <template>): the browser fetches the literal before the runtime sets the real file, so its 404
// names no file, as `references` already treats it when saving.
export function unbound(url) {
  let u = String(url ?? '');
  try { u = decodeURIComponent(u); } catch { /* keep it as written */ }
  return u.includes('{{');
}

// One page at a width, loaded and settled with its fonts ready. A request to the design tool's host
// is refused before it leaves the machine. `bad` lists every file that failed to load, named
// relative to `origin` where it is served from there.
async function openAt(browser, url, width, { height, origin, artifact }) {
  const page = await browser.newPage({ viewport: { width, height } });
  const bad = [];
  const name = (u) => (origin && u.startsWith(origin) ? decodeURIComponent(u.slice(origin.length).replace(/[?#].*$/, '')) : u);
  await page.route((u) => callsHome(u.href, artifact), (r) => {
    bad.push(`${r.request().url()} (a request to the design tool's host, which a saved canvas must not make)`);
    return r.abort();
  });
  page.on('requestfailed', (r) => { if (!callsHome(r.url(), artifact) && !unbound(r.url())) bad.push(`${name(r.url())} (${r.failure()?.errorText ?? 'failed'})`); });
  page.on('response', (r) => { if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url()) && !unbound(r.url())) bad.push(`${name(r.url())} (HTTP ${r.status()})`); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  return { page, bad };
}

// A board's file, relative to the saved folder: exit 2 when it names none inside the folder, 4
// (`verb` opening the message) when the file is not there.
function boardFile(dir, home, b, verb) {
  const rel = b.file && normalize(join(home, b.file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail(`board "${b.name}" names no file inside ${dir}`);
  if (!existsSync(join(dir, rel))) fail(`${verb}: board "${b.name}" is ${rel}, which is not in ${dir}`, 4);
  return rel;
}

const servedAt = (origin, rel) => origin + rel.split(sep).map(encodeURIComponent).join('/');

// Renders every board from disk, all or nothing: a board that fails to load a file, or paints
// nothing, fails the render naming the board and the file, and no image is written.
// `chromium` is Playwright's.
export async function render(dir, { chromium, bps = breakpoints(), now = new Date().toISOString(), height = 900 }) {
  const source = readJson(join(dir, 'source.json'));
  if (!source?.url) fail(`no saved canvas at ${dir}: render a folder desk-design save wrote`);
  const { canvas, deck, home, files, remote } = collect(dir);
  if (deck) fail(`${dir} is a Slides deck, drawn at a fixed 1920×1080: open its index.html rather than rendering it`);
  // A single-page artifact's pages render at every breakpoint, with no width of their own.
  const boards = canvas ? parseBoards(readJson(join(dir, canvas)) ?? {})
    : files.filter((f) => /\.html?$/i.test(f) && dirname(f) === home).map((f) => ({ name: basename(f).replace(/\.html?$/i, ''), width: null, file: basename(f) }));
  if (!boards.length) fail(`${canvas} names no boards: nothing to render`);
  const plan = renderPlan(boards, bps);
  const names = screenNames(boards);
  const pages = new Map(boards.map((b, i) => [names[i], boardFile(dir, home, b, 'not rendered')]));
  const { server, origin } = await serve(dir);
  const browser = await chromium.launch();
  const images = [];
  try {
    for (const shot of plan.shots) {
      const rel = pages.get(shot.screen);
      const { page, bad } = await openAt(browser, servedAt(origin, rel), shot.width, { height, origin, artifact: source.url });
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
  // Read off the saved files, so a canvas saved before source.json kept them gets a true README.
  return writeRecord(dir, { ...source, home: home.split(sep).join('/'), remote, screens });
}

// ---- compare (each board beside its Storybook story) ---------------------------------------------

// The stories a Storybook index lists, index.json (Storybook 7 on) or stories.json (6), as
// [{id, title, name}], with docs pages left out.
export function storyEntries(index) {
  return Object.values(index?.entries ?? index?.stories ?? {})
    .filter((e) => e && typeof e.id === 'string' && (e.type ?? 'story') === 'story')
    .map((e) => ({ id: e.id, title: String(e.title ?? e.kind ?? ''), name: String(e.name ?? e.story ?? '') }));
}

const squash = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

// Each board's story: the one whose id, or title and name, reads as the board's name once case,
// spaces and punctuation are dropped, else a story whose title does (its last segment counts, so
// `Checkout/OrderSummary` is the board `Order summary`), taking the one named Default where there is
// one, else the first. [{board, story | null, by: 'story' | 'title' | null}]
export function matchStories(boards, stories) {
  const last = (t) => t.split('/').at(-1);
  return boards.map((board) => {
    const k = squash(board.name);
    if (!k) return { board, story: null, by: null };
    const exact = stories.find((s) => squash(s.id) === k || squash(`${s.title} ${s.name}`) === k || squash(`${last(s.title)} ${s.name}`) === k);
    if (exact) return { board, story: exact, by: 'story' };
    const titled = stories.filter((s) => squash(s.title) === k || squash(last(s.title)) === k);
    const story = titled.find((s) => /^(default|primary)$/.test(squash(s.name))) ?? titled[0] ?? null;
    return { board, story, by: story ? 'title' : null };
  });
}

// The built Storybook to shoot stories from, served here.
async function storybookAt(target) {
  const index = ['index.json', 'stories.json'].map((f) => join(target, f)).find((p) => existsSync(p));
  if (!index) fail(`no built Storybook at ${target}: it holds no index.json or stories.json; run §4 Storybook first`, 3);
  const { server, origin } = await serve(target);
  return { origin, index: readJson(index), close: () => server.close() };
}

// Shoots each board beside its matching story at each width (and the board's own), into <out> as
// canvas-<board>-<width>.png and built-<board>-<width>.png, the names desk-pr's canvas table uses. A
// board no story matches is listed, not shot. A board that fails to load a file, or a story that
// shows Storybook's error screen, fails the run and writes nothing. Requests a story makes that fail
// are returned as notes: a story may load what its mocks do not serve.
export async function compare(dir, { chromium, storybook, out, widths = breakpoints(), boards = [], height = 900 }) {
  const source = readJson(join(dir, 'source.json'));
  if (!source?.url) fail(`no saved canvas at ${dir}: compare a folder desk-design save wrote`);
  const { canvas, home } = collect(dir);
  if (!canvas) fail(`${dir} is a single page with no boards: compare it with the build by hand`);
  const all = parseBoards(readJson(join(dir, canvas)) ?? {});
  const names = screenNames(all);
  // `boards` is the --boards value, or a list of board names: each read as resolveBoards reads it.
  const only = [...new Set([boards].flat().flatMap((n) => resolveBoards(n, all, canvas)))];
  const chosen = all.map((b, i) => ({ ...b, screen: names[i] })).filter((b) => !only.length || only.includes(b.name));
  if (!chosen.length) fail(`${canvas} names no boards: nothing to compare`);
  const sb = await storybookAt(storybook);
  const matches = matchStories(chosen, storyEntries(sb.index));
  let served = null; let browser = null;
  const pairs = [];
  try {
    served = await serve(dir);
    browser = await chromium.launch();
    for (const { board: b, story, by } of matches) {
      if (!story) continue;
      const rel = boardFile(dir, home, b, 'not compared');
      const shots = [];
      for (const width of [...new Set([...widths, b.width])].filter(Number.isFinite).sort((x, y) => x - y)) {
        const c = await openAt(browser, servedAt(served.origin, rel), width, { height, origin: served.origin, artifact: source.url });
        if (c.bad.length) fail(`not compared: board "${b.name}" (${rel}) at ${width}px could not load ${[...new Set(c.bad)].join(', ')}`, 4);
        const canvasPng = await c.page.screenshot({ fullPage: true });
        await c.page.close();
        const s = await openAt(browser, `${sb.origin}iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`, width, { height, origin: sb.origin, artifact: source.url });
        if (await s.page.evaluate(() => /\bsb-show-(errordisplay|nopreview)\b/.test(document.body?.className ?? ''))) {
          fail(`not compared: story ${story.id} (for board "${b.name}") shows Storybook's error screen at ${width}px`, 4);
        }
        const root = s.page.locator('#storybook-root, #root').first();
        const builtPng = (await root.count()) && (await root.boundingBox())?.height ? await root.screenshot() : await s.page.screenshot({ fullPage: true });
        await s.page.close();
        shots.push({ width, drawn: b.width === width, canvas: `canvas-${b.screen}-${width}.png`, built: `built-${b.screen}-${width}.png`, pngs: [canvasPng, builtPng], notes: [...new Set(s.bad)] });
      }
      pairs.push({ board: b.name, story, by, shots });
    }
  } finally {
    await browser?.close();
    served?.server.close();
    sb.close();
  }
  mkdirSync(out, { recursive: true });
  for (const p of pairs) for (const s of p.shots) { writeFileSync(join(out, s.canvas), s.pngs[0]); writeFileSync(join(out, s.built), s.pngs[1]); }
  return {
    pairs: pairs.map((p) => ({ ...p, shots: p.shots.map(({ pngs, ...s }) => s) })),
    unmatched: matches.filter((m) => !m.story).map((m) => m.board.name),
  };
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

// A Figma URL: what designFact reports as `figma`, and what ticket lint takes as a design link.
export const FIGMA_URL = /https?:\/\/(?:[a-z0-9-]+\.)*figma\.com\//i;

export function claudeDesignLinks(section) {
  const out = [];
  for (const m of String(section ?? '').matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*claude\.ai\/[^\s|\])>"'}]+/gi)) {
    const u = m[0].replace(/[.,;:!]+$/, '');
    if (!out.some((x) => canonicalUrl(x) === canonicalUrl(u))) out.push(u);
  }
  return out;
}

// A claude.ai link that names an artifact (a Claude Design project, or a published page such as a spec
// or notes), not a chat or settings page, which holds nothing to save.
const ARTIFACT_PATH = /^\/(?:design|artifacts?|public\/artifacts)\//i;

// The claude.ai artifacts a ticket links outside its Design section (a spec in its description, notes in
// a comment). A worker cannot read one, so each needs a copy in the repo as a design does. What Out of
// scope links is not the ticket's to read, and a link the Design section also names is a design.
export function linkedArtifacts(text) {
  const design = claudeDesignLinks(designSection(text)).map(canonicalUrl);
  const out = [];
  for (const s of sections(text).filter((x) => !/^(?:design|out of scope)\b/i.test(x.name))) {
    for (const u of claudeDesignLinks(s.lines.map((l) => l.text).join('\n'))) {
      let path = '';
      try { path = new URL(u).pathname; } catch { /* not a URL */ }
      if (ARTIFACT_PATH.test(path) && !design.includes(canonicalUrl(u)) && !out.some((x) => canonicalUrl(x) === canonicalUrl(u))) out.push(u);
    }
  }
  return out;
}

// The snapshot folder under <state>/designs/ that holds this artifact, or null. /desk-admit snapshots
// an artifact when it admits the ticket, and autopilot before triage; the worker saves it on its
// branch. A named batch's state (<repo state>/batches/<name>) also reads the repo's own, where
// /desk-admit saves.
export function snapshotOf(state, url) {
  for (const base of [...new Set([state, E.repoStateOf(state)])].map((s) => join(s, 'designs'))) {
    if (!existsSync(base)) continue;
    const d = readdirSync(base).find((x) => canonicalUrl(readJson(join(base, x, 'source.json'))?.url) === canonicalUrl(url));
    if (d) return join(base, d);
  }
  return null;
}

// What a design's files say it is: a canvas (canvas.json), a deck (deck.json), else a page (HTML
// only), else null.
export function kindOfFiles(paths) {
  const names = paths.map((p) => basename(p));
  if (names.includes('canvas.json')) return 'canvas';
  if (names.includes('deck.json')) return 'deck';
  return names.some((n) => /\.html?$/i.test(n)) ? 'page' : null;
}

// A snapshot or saved folder's kind: as its source.json records it, else from its files.
export function kindAt(dir) {
  const k = readJson(join(dir, 'source.json'))?.kind;
  if (k) return k;
  try { return kindOfFiles(walkFiles(dir)); } catch { return null; }
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

// Whether the Design section says ticket <key> uses no board from the artifact at <url>: "no board for
// this ticket", "no board on this canvas for <key>", "this ticket uses no board". The phrase names the
// whole ticket, so "no board for the empty state" or "for this ticket's empty state" beside a named
// board is not one. With several links it must sit on a line whose only link is <url>: a note on a line
// linking two artifacts could be about either, so it clears neither, and a note about one artifact
// never clears another.
export function usesNoBoard(section, url, key) {
  const ticket = `(?:(?:this|the)\\s+ticket|${key ? key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') : '(?!)'})`;
  const qualifier = `(?:exists?|yet|(?:on|in|from)\\s+(?:this|the|that|its\\s+epic['’]s)\\s+(?:canvas|artifact|design))`;
  const re = new RegExp(`\\bno\\s+boards?\\s+(?:${qualifier}\\s+)*(?:for|in|specific\\s+to)\\s+${ticket}(?![\\w-]|['’]s\\b)|\\b${ticket}\\s+(?:uses|has|needs)\\s+no\\s+boards?\\b`, 'i');
  const text = String(section ?? '');
  const only = (l) => { const k = claudeDesignLinks(l); return k.length === 1 && canonicalUrl(k[0]) === canonicalUrl(url); };
  // Each kept line is tested alone: joined, a phrase could run across a line left out between them.
  return claudeDesignLinks(text).length > 1 ? text.split('\n').filter(only).some((l) => re.test(l)) : re.test(text);
}

// What a lane D worker can build from: {ref, canvases: [{url, saved, snapshot}], artifacts, figma}. A
// canvas is readable when it is saved under <dir> on <ref> (the batch's base) or snapshotted under
// <state>; with no <dir> (the repo saves none) only a snapshot is. An artifact ticket <key> uses no
// board from (usesNoBoard) is left out: nothing in it needs reading. `artifacts` is the same for each
// claude.ai artifact the ticket links outside its Design section (linkedArtifacts).
export function designFact(text, { root, dir, ref, state, key }) {
  const plain = String(text ?? '').replace(/\\([-_*+^~?#{}[\]|!])/g, '$1');
  const section = designSection(plain);
  const saved = dir ? savedAt(root, dir, ref) : [];
  const readable = (url) => ({ url, saved: saved.find((c) => canonicalUrl(c.url) === canonicalUrl(url))?.path ?? null, snapshot: snapshotOf(state, url) });
  return {
    ref,
    canvases: claudeDesignLinks(section).filter((url) => !usesNoBoard(section, url, key)).map(readable),
    artifacts: linkedArtifacts(plain).map(readable),
    figma: FIGMA_URL.test(section ?? ''),
  };
}

// Where a worker reads each claude.ai artifact the ticket links, its Design section's and the rest:
// [{url, copy}], `copy` the folder committed in this checkout or on <ref>, else its snapshot under
// <state>, else null (no copy: nothing a worker can read).
export function copiesOf(text, { root, dir, ref, state }) {
  const plain = String(text ?? '').replace(/\\([-_*+^~?#{}[\]|!])/g, '$1');
  let onRef = [];
  try { onRef = dir ? savedAt(root, dir, ref) : []; } catch { /* a ref that does not resolve holds none */ }
  return [...claudeDesignLinks(designSection(plain)), ...linkedArtifacts(plain)].map((url) => ({
    url,
    copy: (dir ? findSaved(root, dir, url)?.path : null) ?? onRef.find((c) => canonicalUrl(c.url) === canonicalUrl(url))?.path ?? (state ? snapshotOf(state, url) : null),
  }));
}

// Findings for one ticket: {severity: 'blocking'|'advisory', message}. `issue` is desk-jira's
// --json issue, or {key, text} for a ticket file. A canvas is saved when it is committed under <dir>
// on <ref> (the batch's base), whatever the working tree holds. It belongs under the ticket's epic
// when it has one, else under the ticket itself. One with a snapshot under <state> is advisory: the
// worker saves it from there. A deck is saved and checked as a canvas is; a snapshot that is
// neither (a single page) says so, and is advisory too. With neither a saved copy nor a snapshot
// the link's kind is unknown, so it blocks, unless the section says the ticket uses no board from it
// (usesNoBoard): then nothing needs saving, and it is advisory.
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
  const others = linkedArtifacts(text);
  let onBase = [];
  // A base that does not resolve has nothing saved on it; the finding names the ref it read.
  if (links.length || others.length) { try { onBase = savedAt(root, dir, ref); } catch { /* no such ref */ } }
  for (const url of links) {
    const saved = onBase.find((c) => canonicalUrl(c.url) === canonicalUrl(url));
    if (!saved) {
      const message = `design: ${key}'s Design section links the Claude Design artifact ${url}, but no copy is saved under ${dir}/ on ${ref}: save it to ${join(dir, epic ?? key)}/ (desk-design save)`;
      const snap = state ? snapshotOf(state, url) : null;
      const page = snap && kindAt(snap) === 'page';
      findings.push(!snap && usesNoBoard(section, url, key) ? { severity: 'advisory', message: `design: ${key}'s Design section links the Claude Design artifact ${url} but says the ticket uses no board from it, so nothing needs saving` }
        : !snap ? { severity: 'blocking', message }
        : page ? { severity: 'advisory', message: `${message}; it is snapshotted at ${snap}, a single page rather than a canvas or deck, so it does not block: the worker may save it from there` }
          : { severity: 'advisory', message: `${message}; it is snapshotted at ${snap}, so the worker saves it from there` });
    } else if (!section.includes(saved.path.replace(/\/$/, ''))) {
      findings.push({ severity: 'advisory', message: `design: ${key}'s Design section links ${url} but not its saved copy ${saved.path}: add the repo path beside the link` });
    }
  }
  // A spec or notes page linked elsewhere is saved as a page; with neither a copy nor a snapshot, a
  // session that can answer the platform's prompt to read it must read it before any worker starts.
  for (const url of others) {
    if (onBase.some((c) => canonicalUrl(c.url) === canonicalUrl(url))) continue;
    const message = `design: ${key} links the claude.ai artifact ${url} outside its Design section, but no copy is saved under ${dir}/ on ${ref}: read it once in an interactive session and save it to ${join(dir, epic ?? key)}/ (desk-design write, then save or propose)`;
    const snap = state ? snapshotOf(state, url) : null;
    findings.push(snap ? { severity: 'advisory', message: `${message}; it is snapshotted at ${snap}, so the worker saves it from there` } : { severity: 'blocking', message });
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

// ---- estimate (uploads a saved canvas's PR needs, at grooming) ---------------------------------

// The pace desk uploads PR images at, machine-wide.
export const UPLOAD_PACE = Object.freeze({ perMinute: 6, perHour: 300 });

// Config §5 Themes: the theme names every screen is captured in. Unset or `none` is one look.
export function themes() {
  let v;
  try { v = E.configValues('themes'); } catch (e) { if (e instanceof E.DeskConfigError) throw e; v = null; }
  return !v || E.isNone(v) ? [] : [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
}

// One stitched image per board and theme: the uploads a ticket's PR needs and the minutes they take
// at UPLOAD_PACE (whichever of the minute and hour caps is slower). With `key`, the boards are that
// ticket's (every board when it names none, or when source.json does not list it yet: `unlisted`).
// Boards are counted as the stitch groups them: by the file name compare gives each (screenNames),
// read with stitch-boards.mjs's parseCapture, so a board drawn as another's dark theme ("Order
// summary dark") counts as that board, and its theme counts toward the themes.
export function uploadEstimate(source, { key = null, themeCount = 1 } = {}) {
  const all = source?.boards ?? [];
  let files = screenNames(all);
  const t = key ? (source?.tickets ?? []).find((x) => x.key === key) : null;
  if (t?.boards?.length) {
    // As compare keeps them: every board whose title the ticket names, so two boards sharing a title
    // ("Checkout", captured as checkout and checkout-2) both count. A title no board has counts once.
    const named = new Set(t.boards);
    const missing = [...named].filter((n) => !all.some((b) => b.name === n));
    files = [...files.filter((_, i) => named.has(all[i].name)), ...screenNames(missing.map((name) => ({ name })))];
  }
  const parsed = files.map((f) => parseCapture(`canvas-${f}-1.png`));
  const bases = new Set(parsed.map((p) => p.screen));
  const drawn = new Set(parsed.map((p) => p.theme));
  const themesN = Math.max(1, themeCount, drawn.size);
  const uploads = bases.size * themesN;
  const minutes = Math.max(uploads / UPLOAD_PACE.perMinute, (uploads / UPLOAD_PACE.perHour) * 60);
  return { boards: bases.size, themes: themesN, uploads, minutes, over: minutes > 60, boardsPerHour: Math.floor(UPLOAD_PACE.perHour / themesN), unlisted: !!key && !t };
}

const duration = (m) => {
  const whole = Math.ceil(m);
  if (whole < 60) return `${whole} minute${whole === 1 ? '' : 's'}`;
  const h = Math.floor(whole / 60); const r = whole % 60;
  return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} minute${r === 1 ? '' : 's'}` : ''}`;
};

// The groom's lines for one estimate: the count and time, then a flag when it is over an hour.
export function estimateLines(e, { key = null } = {}) {
  if (!e.boards) return ['uploads: none: this canvas has no boards to stitch (a deck or a single page)'];
  const out = [`uploads: ${e.uploads} (${e.boards} board${e.boards === 1 ? '' : 's'} × ${e.themes} theme${e.themes === 1 ? '' : 's'}), about ${duration(e.minutes)} at ${UPLOAD_PACE.perMinute} a minute and ${UPLOAD_PACE.perHour} an hour`];
  if (e.unlisted) out.push(`note: ${key} is not among the tickets source.json lists yet, so every board is counted`);
  if (e.over) out.push(`flag: over an hour to upload: split ${key ?? 'the ticket'} by board, at most ${e.boardsPerHour} board${e.boardsPerHour === 1 ? '' : 's'} per ticket`);
  return out;
}

// ---- the command line ------------------------------------------------------------------------

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

// Playwright's Chromium for render and compare; exit 6 when no Playwright is installed.
async function playwrightChromium() {
  const { findPlaywright, importPlaywright } = await import('./find-playwright.mjs');
  const found = findPlaywright();
  if (!found.entry) fail(`playwright not found (tried: ${found.tried.join(', ')}): re-run desk-skills' ./install.sh, which installs desk's own`, 6);
  return (await importPlaywright(found)).chromium;
}

if (isMain) {
  const [cmd, target, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'write') {
      if (!target) fail('usage: desk-design write <dir> --url <u> --version <v> --key <K> [--boards <a,b>]');
      const args = ticketsFromArgs(rest);
      const url = opt(rest, '--url'); const version = opt(rest, '--version');
      if (!url || !version || !args.length) fail('write needs --url, --version and at least one --key');
      const prev = readJson(join(target, 'source.json'));
      const shape = (() => { try { return collect(target); } catch { return null; } })();
      const boards = shape ? (shape.canvas ? parseBoards(readJson(join(target, shape.canvas)) ?? {}) : []) : prev?.boards ?? [];
      const tickets = withBoards(args, boards, shape?.canvas ?? join(target, 'source.json'));
      const s = writeRecord(target, {
        url, version, fetched_at: opt(rest, '--fetched-at') ?? new Date().toISOString(),
        dir: opt(rest, '--epic') ?? prev?.dir ?? tickets[0].key, tickets, kind: shape?.kind, boards,
        ...(shape?.deck ? { slides: shape.slides } : {}),
        ...(shape ? { home: shape.home.split(sep).join('/'), remote: shape.remote } : {}),
      });
      console.log(`wrote: ${join(target, 'source.json')} (version ${s.version}; ${s.kind ?? 'unknown kind'}; tickets ${s.tickets.map((t) => t.key).join(' ')})`);
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
      const r = importExport(resolve(target), { state: E.stateDir(), url: opt(rest, '--url'), tickets: withBoards(ticketsFromArgs(rest), [], ''), epic: opt(rest, '--epic') });
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
      for (const s of designFact(issue.text ?? issue.fields?.description, { state: E.stateDir(), key: issue.key }).canvases) console.log(`${s.url}\t${s.snapshot ?? '-'}`);
    } else if (cmd === 'copies') {
      if (!target) fail('usage: desk-design copies <KEY | ticket file> [--key <K>]');
      const issue = loadIssue(target, opt(rest, '--key'));
      const root = toplevel(); const dir = designDir();
      const copies = copiesOf(issue.text ?? issue.fields?.description, { root, dir, ref: baseRef(root), state: E.stateDir() });
      for (const c of copies) console.log(`${c.url}\t${c.copy ?? '-'}`);
      process.exit(copies.some((c) => !c.copy) ? 1 : 0);
    } else if (cmd === 'render') {
      if (!target) fail('usage: desk-design render <saved dir>');
      const s = await render(resolve(target), { chromium: await playwrightChromium() });
      console.log(`rendered: ${join(target, 'screens')}/ (${s.screens.images.length} images, version ${s.version})`);
      for (const w of s.screens.widths) {
        console.log(`  ${w.width}px ${w.label}${w.breakpoint ? '' : ' (not a breakpoint)'}${w.boards.length ? `: ${w.boards.join(', ')}` : ''}`);
      }
    } else if (cmd === 'compare') {
      const storybook = opt(rest, '--storybook'); const out = opt(rest, '--out');
      if (!target || !storybook || !out) fail('usage: desk-design compare <saved dir> --storybook <built folder> --out <dir> [--boards <a,b>]');
      // Playwright loads at launch, so a --boards name matching no board exits 2 even with none installed.
      const chromium = { launch: async (...a) => (await playwrightChromium()).launch(...a) };
      const r = await compare(resolve(target), { chromium, storybook: resolve(storybook), out: resolve(out), boards: opt(rest, '--boards') ?? [] });
      for (const p of r.pairs) {
        console.log(`pair: ${p.board} = story ${p.story.id} (${p.by === 'story' ? 'its id or title and name' : 'its title'} matches the board)`);
        for (const s of p.shots) console.log(`  ${s.width}px${s.drawn ? ' (drawn)' : ''}: ${s.canvas} ${s.built}`);
        for (const n of [...new Set(p.shots.flatMap((s) => s.notes))]) console.log(`  note: the story could not load ${n}`);
      }
      for (const u of r.unmatched) console.log(`not compared: ${u}: no story's id or title matches the board's name`);
      console.log(`compared: ${r.pairs.length} of ${r.pairs.length + r.unmatched.length} boards, images in ${out}`);
    } else if (cmd === 'estimate') {
      if (!target) fail('usage: desk-design estimate <saved dir> [--key <K>]');
      const source = readJson(join(target, 'source.json'));
      if (!source) fail(`no source.json in ${target}: save the canvas first (desk-design save)`);
      const key = opt(rest, '--key') ?? null;
      for (const l of estimateLines(uploadEstimate(source, { key, themeCount: themes().length }), { key })) console.log(l);
    } else {
      fail('usage: desk-design.mjs write|save|import|propose|status|check|snapshots|copies|render|compare|estimate ... (see the top of the file)');
    }
  } catch (e) {
    console.error(`desk-design: ${e.message}`);
    process.exit(typeof e.code === 'number' ? e.code : 2);
  }
}
