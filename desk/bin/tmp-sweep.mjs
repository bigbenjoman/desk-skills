// What holds a tmpfs /tmp, and clearing the part of it that is only a cache. While the memory watch's
// TMPFS-HIGH holds spawns, each pass clears the regenerable caches no process has open, reads /tmp
// again, and keeps one needs-you ask naming what is left for as long as it is still over its line.
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { addAsk, settleTmpfs } from './asks.mjs';

const HOUR = 3_600_000;
// Caches a tool rebuilds on its next run, by the name of their entry directly under /tmp. `idle`: left
// until nothing under it has changed for that long. `jest`: left while any Jest runs, since Jest writes
// its cache between transforms without keeping a file open.
export const REGENERABLE = [
  { re: /^jest_/, what: 'Jest cache', jest: true },
  { re: /^node-compile-cache$/, what: 'Node compile cache' },
  { re: /^v8-compile-cache(-|$)/, what: 'V8 compile cache' },
  { re: /^cdk\.out/, what: 'CDK synth output', idle: HOUR },
  { re: /^\.?turbod?($|[-_.])/, what: 'Turborepo cache' },
  { re: /^\.?vite($|[-_.])/, what: 'Vite cache' },
];
export const regenerable = (name) => REGENERABLE.find((r) => r.re.test(name)) ?? null;

// The bytes `path` takes on a tmpfs (its blocks, as df counts them) and the newest mtime under it,
// links not followed.
export function entrySize(path) {
  let bytes = 0, newest = 0;
  const walk = (p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    bytes += st.blocks != null ? st.blocks * 512 : st.size;
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory()) return;
    let names = [];
    try { names = readdirSync(p); } catch { return; }
    for (const n of names) walk(join(p, n));
  };
  walk(path);
  return { bytes, newest };
}

// Each entry directly under `dir`, largest first: [{ name, path, bytes, newest }], `path` resolved so it
// compares with what /proc shows open.
export function tmpEntries(dir = '/tmp') {
  let root = dir, names = [];
  try { root = realpathSync(dir); names = readdirSync(root); } catch { return []; }
  return names.map((name) => ({ name, path: join(root, name), ...entrySize(join(root, name)) })).sort((a, b) => b.bytes - a.bytes);
}

// What the processes this user can read have open: each file descriptor's target and working directory
// (`paths`), and each command line as its arguments (`cmds`). null where `proc` cannot be read, so
// nothing can be shown unused.
export function openFiles(proc = '/proc') {
  let pids;
  try { pids = readdirSync(proc).filter((p) => /^\d+$/.test(p)); } catch { return null; }
  const paths = new Set(), cmds = [];
  for (const pid of pids) {
    const at = join(proc, pid);
    try { cmds.push(readFileSync(join(at, 'cmdline'), 'utf8').split('\0').filter(Boolean)); } catch { /* gone, or another user's */ }
    try { paths.add(readlinkSync(join(at, 'cwd'))); } catch { /* as above */ }
    let fds = [];
    try { fds = readdirSync(join(at, 'fd')); } catch { /* as above */ }
    for (const fd of fds) {
      try { paths.add(readlinkSync(join(at, 'fd', fd))); } catch { /* closed since the listing */ }
    }
  }
  return { paths: [...paths], cmds };
}

// Whether a command line is Jest or one of its workers.
const isJest = (args) => args.some((a) => /(^|\/)jest(\.js)?$/.test(a) || a.includes('/jest-worker/'));
const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);

// The entries to clear: regenerable, nothing open under them, no Jest running for a Jest cache, and an
// idle rule's entry unchanged for its time. None where what is open could not be read.
export function planSweep(entries, open, now = Date.now()) {
  if (!open) return [];
  const jest = open.cmds.some(isJest);
  return entries.flatMap((e) => {
    const rule = regenerable(e.name);
    if (!rule || open.paths.some((p) => under(p, e.path)) || (rule.jest && jest) || (rule.idle && now - e.newest < rule.idle)) return [];
    return [{ ...e, what: rule.what }];
  });
}

// Clears what planSweep picks under `dir`: { freed, failed, left, unread }, `left` every entry still
// there, largest first, and `unread` true where /proc could not be read.
export function sweepTmp({ dir = '/tmp', proc = '/proc', now = Date.now(), remove = (p) => rmSync(p, { recursive: true, force: true }) } = {}) {
  const entries = tmpEntries(dir);
  const open = openFiles(proc);
  const freed = [], failed = [];
  for (const e of planSweep(entries, open, now)) {
    try { remove(e.path); freed.push(e); } catch (err) { failed.push({ ...e, why: String(err?.message ?? err).split('\n')[0] }); }
  }
  const gone = new Set(freed.map((e) => e.name));
  return { freed, failed, left: entries.filter((e) => !gone.has(e.name)), unread: !open };
}

const size = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)}G` : `${Math.max(1, Math.round(b / 2 ** 20))}M`);
// The largest `n` entries, as `jest_rs 2.0G, node-compile-cache 625M`.
export const largest = (entries, n = 5) => entries.slice(0, n).map((e) => `${e.name} ${size(e.bytes)}`).join(', ');

// What the pass reports of a sweep.
export function sweepLines(r) {
  const out = [];
  if (r.unread) out.push('/tmp (tmpfs): /proc could not be read, so what has a file open there is not known and no cache was cleared');
  if (r.freed.length) out.push(`/tmp (tmpfs): cleared ${size(r.freed.reduce((n, e) => n + e.bytes, 0))} of regenerable cache no process had open: ${r.freed.map((e) => `${e.name} ${size(e.bytes)} (${e.what})`).join(', ')}`);
  for (const e of r.failed) out.push(`/tmp (tmpfs): ${e.name} (${e.what}) could not be cleared: ${e.why}`);
  return out;
}

export const askText = ({ gib, limitGiB, left }) => `/tmp is a tmpfs, so what it holds is memory: it holds ${gib.toFixed(1)}G, over the ${limitGiB}G line that holds new workers, ` +
  `after desk cleared every cache it could. Largest left: ${largest(left) || 'nothing it can list'}. Clear what you can (du -sh /tmp/*); workers start again once it is under ${limitGiB}G`;

// One pass's step while TMPFS-HIGH holds spawns: clear what can be cleared (not on a dry run), read /tmp
// again, and keep the ask naming what is left while it is over `limitGiB`, or drop it once it is not.
// `usage()` is /tmp's GiB now, null where it cannot be read, which keeps the hold.
//   -> { lines, over }, `over` false releasing the hold
export function tmpfsStep({ askState, limitGiB, usage, dry = false, sweep = sweepTmp, now = Date.now() }) {
  const r = dry ? null : sweep({ now });
  const lines = r ? sweepLines(r) : [];
  const gib = usage();
  if (gib == null) return { lines: [...lines, '/tmp (tmpfs): could not be read again after the sweep, so its hold stands'], over: true };
  const over = gib >= limitGiB;
  if (dry) return { lines, over };
  try {
    if (over) {
      const { id, added } = addAsk(askState, askText({ gib, limitGiB, left: r.left }), now, { settles: 'tmpfs' });
      lines.push(`/tmp (tmpfs): still ${gib.toFixed(1)}G, over its ${limitGiB}G line: largest left ${largest(r.left) || 'none listed'}${added ? ` (needs-you: ask ${id})` : ''}`);
    } else {
      lines.push(`/tmp (tmpfs): ${gib.toFixed(1)}G now, under its ${limitGiB}G line, so it no longer holds spawns`);
      lines.push(...settledLines(askState));
    }
  } catch (e) { lines.push(`/tmp (tmpfs): its needs-you ask could not be updated (${String(e?.message ?? e).split('\n')[0]})`); }
  return { lines, over };
}

// Drops the ask once /tmp no longer holds spawns: the lines saying so.
export const settledLines = (askState) => settleTmpfs(askState).map((a) => `needs-you: ask ${a.id} dropped, as /tmp is under its line`);
