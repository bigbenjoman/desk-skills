// Fingerprints recorded on code whose lever part is the same as today's, mapped to today's part-only
// fingerprint, so their tickets count again (levers-evaluate.mjs recount). A lever's fingerprint once
// hashed each of its code files whole, so an edit anywhere in a file changed it. For a lever with a part,
// every version of each of its files is read from the source checkout's git history. The versions whose
// part is today's (by its markers, or in a version from before them, with today's blocks found in it
// unchanged and in order) are combined with today's copy of each whole file, and each combination's
// whole-file hash maps to today's part-only one. A lever with no part keeps the fingerprint it had.
//
// The map is machine-wide, as the fingerprints are of the code installed on this computer:
// ~/.desk-autopilot/levers/fp-map.json, { v, at, levers: { <lever>: { fp, from: [old fp] } } }.
//
//   import { fpMapFile, readFpMap, writeFpMap, mapFp, historyMap } from './lever-fp-history.mjs'
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOME } from './desk-env.mjs';
import { REGISTRY, installedPath, codeFingerprint, partBlocks, partText } from './lever-registry.mjs';

export const fpMapFile = (root = join(HOME, '.desk-autopilot')) => join(root, 'levers', 'fp-map.json');

// The map's levers, {} with none written or one that does not parse.
export function readFpMap(root) {
  try {
    const j = JSON.parse(readFileSync(fpMapFile(root), 'utf8'));
    return j?.levers && typeof j.levers === 'object' && !Array.isArray(j.levers) ? j.levers : {};
  } catch { return {}; }
}
export function writeFpMap(levers, { root, at }) {
  const file = fpMapFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, at, levers }, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

// A fingerprint of `lever` recorded on a start or a pin, as the code it ran on reads today: the
// part-only fingerprint the map gives it, else as recorded.
export const mapFp = (map, lever, fp) => (fp && Array.isArray(map?.[lever]?.from) && map[lever].from.includes(fp) ? map[lever].fp : fp);

// Whether `text` holds each of `blocks` (arrays of lines) as consecutive lines, in order.
function hasBlocks(text, blocks) {
  const lines = String(text).split('\n');
  let at = 0;
  for (const b of blocks) {
    let found = -1;
    for (let i = at; i + b.length <= lines.length && found < 0; i++) if (b.every((l, k) => lines[i + k] === l)) found = i;
    if (found < 0) return false;
    at = found + b.length;
  }
  return true;
}

// git run in `checkout`, binary-safe. -> { ok, out: Buffer }
const gitIn = (checkout) => (args, input) => {
  const r = spawnSync('git', ['-C', checkout, ...args], { input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) };
};

// Every version of `path` any ref of the checkout has held, each once. -> [Buffer], or null when git
// cannot say.
function versionsOf(path, git) {
  const log = git(['log', '--all', '--full-history', '--format=%H', '--', path]);
  if (!log.ok) return null;
  const commits = log.out.toString('utf8').split('\n').filter(Boolean);
  if (!commits.length) return [];
  const check = git(['cat-file', '--batch-check'], commits.map((c) => `${c}:${path}\n`).join(''));
  if (!check.ok) return null;
  const blobs = [...new Set(check.out.toString('utf8').split('\n').map((l) => l.split(' ')).filter((p) => p[1] === 'blob').map((p) => p[0]))];
  if (!blobs.length) return [];
  const cat = git(['cat-file', '--batch'], blobs.map((b) => `${b}\n`).join(''));
  if (!cat.ok) return null;
  const out = [];
  let i = 0;
  while (i < cat.out.length) {
    const nl = cat.out.indexOf(10, i);
    if (nl < 0) break;
    const [, type, size] = cat.out.subarray(i, nl).toString('utf8').split(' ');
    const n = Number(size);
    if (type !== 'blob' || !Number.isInteger(n)) return null;
    out.push(cat.out.subarray(nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  return out;
}

// Each lever with a part: today's part-only fingerprint and every whole-file fingerprint of a version
// whose own code was today's. `notes` names each lever that could not be mapped, and why.
//   -> { levers: { <lever>: { fp, from: [old fp] } }, notes: [text] }
export function historyMap({ checkout, registry = REGISTRY, resolve = installedPath, git = gitIn(checkout) }) {
  const levers = {};
  const notes = [];
  const read = (p) => { try { return readFileSync(resolve(p)); } catch { return null; } };
  const cache = new Map();
  const versions = (path) => { if (!cache.has(path)) cache.set(path, versionsOf(path, git)); return cache.get(path); };
  for (const [name, l] of Object.entries(registry)) {
    if (!l.code.some((c) => c.part)) continue;
    const now = codeFingerprint(l.code, read);
    if (!now.fp || now.missing.length) { notes.push(`${name}: today's code has no whole fingerprint (${now.missing.join(', ')} unreadable or unmarked), so nothing maps to it`); continue; }
    let unread = null;
    const choices = l.code.map((c) => {
      const today = read(c.path);
      if (!c.part) return [today];
      const ref = partBlocks(today.toString('utf8'), c.part);
      const want = partText(ref);
      const all = versions(c.path);
      if (!all) { unread = c.path; return [today]; }
      return all.filter((buf) => { const t = buf.toString('utf8'); const own = partBlocks(t, c.part); return own ? partText(own) === want : hasBlocks(t, ref); });
    });
    if (unread) { notes.push(`${name}: the git history of ${unread} cannot be read in ${checkout}, so nothing maps to it`); continue; }
    // Each combination hashed whole, in registry order, as fingerprints were taken before parts.
    const from = new Set();
    const walk = (i, h) => {
      if (i === choices.length) { from.add(h.digest('hex').slice(0, 16)); return; }
      for (const body of choices[i]) walk(i + 1, h.copy().update(`${l.code[i].path}\0${body.length}\0`).update(body));
    };
    walk(0, createHash('sha256'));
    from.delete(now.fp);
    levers[name] = { fp: now.fp, from: [...from].sort() };
  }
  return { levers, notes };
}
