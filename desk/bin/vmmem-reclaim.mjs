// The WSL page-cache reclaim: give the Linux page cache back to Windows.
//
// On WSL2 the VM (VmmemWSL) keeps the Linux page cache as its own memory, so Windows counts it as used
// however little the processes inside hold. Dropping the caches and compacting memory as root
// (`sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory`) hands it back, with
// no effect on running work. Off unless the machine profile's `vmmem-reclaim` row is `on`:
//   vmmem-reclaim               on or off (off when unset)
//   vmmem-reclaim-gap-gb        reclaim once vmmem less Linux RSS is at or above this (3 when unset)
//   vmmem-reclaim-interval-min  at most one reclaim per this many minutes (5 when unset)
// `desk-env mem watch` reclaims on the gap (reclaimStep), and the pass, before VMMEM-HIGH holds spawns,
// runs one reclaim whatever the gap and holds only if the VM is still over its line (reclaimBeforeHold).
// Every run, either's, is one JSON line in ~/.desk-autopilot/vmmem-reclaim.jsonl with the figures
// before and after; the interval counts from the last line there, so both share it machine-wide.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RECLAIM_KEY = 'vmmem-reclaim';
export const RECLAIM_GAP_KEY = 'vmmem-reclaim-gap-gb';
export const RECLAIM_INTERVAL_KEY = 'vmmem-reclaim-interval-min';
export const RECLAIM_DEFAULTS = Object.freeze({ gapGiB: 3, intervalMin: 5 });
export const RECLAIM_SCRIPT = 'sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory';

const positive = (v, dflt) => { const s = String(v ?? '').trim(); return /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? Number(s) : dflt; };
const fixed = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}G` : '?');

// The three rows, read through `get(key)` (a profile value or null): -> { on, gapGiB, intervalMs }.
// Only `on` turns it on; a gap or interval that does not read as a number above 0 keeps its default.
export function reclaimSettings(get) {
  const intervalMin = positive(get(RECLAIM_INTERVAL_KEY), RECLAIM_DEFAULTS.intervalMin);
  return { on: String(get(RECLAIM_KEY) ?? '').trim() === 'on', gapGiB: positive(get(RECLAIM_GAP_KEY), RECLAIM_DEFAULTS.gapGiB), intervalMs: intervalMin * 60_000 };
}

// Whether a reclaim is due: vmmem less RSS at or above the gap (`force` skips the gap, as the pass
// does before a hold), and no run within the interval of `lastAt` (ms, null for none).
//   -> { due, why }
export function reclaimDue({ now, usedGiB, rssGiB, lastAt = null }, { gapGiB, intervalMs }, { force = false } = {}) {
  if (!Number.isFinite(usedGiB)) return { due: false, why: 'vmmem could not be read' };
  if (!force) {
    if (!Number.isFinite(rssGiB)) return { due: false, why: 'RSS could not be read (ps)' };
    const gap = usedGiB - rssGiB;
    if (gap < gapGiB) return { due: false, why: `vmmem ${fixed(usedGiB)} is ${fixed(gap)} over RSS, under the ${gapGiB}G gap` };
  }
  if (Number.isFinite(lastAt) && now - lastAt < intervalMs) {
    return { due: false, why: `the last reclaim was ${Math.round((now - lastAt) / 60_000)}m ago, within the ${Math.round(intervalMs / 60_000)}m interval` };
  }
  return { due: true, why: force ? 'before VMMEM-HIGH holds spawns' : `vmmem ${fixed(usedGiB)} is ${fixed(usedGiB - rssGiB)} over RSS ${fixed(rssGiB)}, at or above the ${gapGiB}G gap` };
}

// Drops the caches and compacts memory as root: directly when already root, else through
// `wsl.exe -u root`, which asks for no password. DESK_VMMEM_RECLAIM_CMD stands in for the whole
// command (tests). -> { ok, error }
export function dropCaches({ run = spawnSync, uid = process.getuid?.(), env = process.env } = {}) {
  const [cmd, args] = env.DESK_VMMEM_RECLAIM_CMD ? ['sh', ['-c', env.DESK_VMMEM_RECLAIM_CMD]]
    : uid === 0 ? ['sh', ['-c', RECLAIM_SCRIPT]] : ['wsl.exe', ['-u', 'root', '-e', 'sh', '-c', RECLAIM_SCRIPT]];
  const r = run(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  if (r.error) return { ok: false, error: `${cmd}: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: `${cmd} exited ${r.status ?? r.signal}${String(r.stderr ?? '').trim() ? `: ${String(r.stderr).trim().split('\n')[0]}` : ''}` };
  return { ok: true, error: null };
}

// The run log: one JSON line per run, { at, by, beforeGiB, afterGiB, rssGiB, ok, error }. Kept under
// 256 KiB by dropping its older half.
export const reclaimLogPath = (home) => join(home, '.desk-autopilot', 'vmmem-reclaim.jsonl');
const LOG_MAX = 256 * 1024;
export function readReclaims(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { const e = JSON.parse(l); return Number.isFinite(e?.at) ? [e] : []; } catch { return []; } });
  } catch { return []; }
}
export const lastReclaim = (file) => readReclaims(file).at(-1) ?? null;
export function appendReclaim(file, entry) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  try {
    if (statSync(file).size > LOG_MAX) {
      const kept = readReclaims(file);
      writeFileSync(file, kept.slice(Math.floor(kept.length / 2)).map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  } catch { /* the next append trims it */ }
}

// A run, as the watch prints it.
export const reclaimLine = (e) => (e.ok
  ? `VMMEM-RECLAIM: dropped caches and compacted memory (${e.by}): vmmem ${fixed(e.beforeGiB)} -> ${fixed(e.afterGiB)}, RSS ${fixed(e.rssGiB)}`
  : `VMMEM-RECLAIM: failed (${e.by}): ${e.error}; vmmem ${fixed(e.beforeGiB)} -> ${fixed(e.afterGiB)}, RSS ${fixed(e.rssGiB)}`);

// One reclaim when it is due: `read()` is { usedGiB, rssGiB } now. Logs the run to `file` and returns
// { ran, line, why, entry }; `line` is null when nothing ran.
export function reclaimStep({ now = Date.now(), settings, read, file, force = false, by = 'watch', run, drop = dropCaches }) {
  const before = read();
  const d = reclaimDue({ now, ...before, lastAt: lastReclaim(file)?.at ?? null }, settings, { force });
  if (!d.due) return { ran: false, line: null, why: d.why, entry: null };
  const r = drop(run ? { run } : {});
  const after = read();
  const entry = { at: now, by, beforeGiB: before.usedGiB, afterGiB: after.usedGiB, rssGiB: after.rssGiB, ok: r.ok, error: r.error };
  let line = reclaimLine(entry);
  try { appendReclaim(file, entry); } catch (e) { line += ` (not logged: ${e.message})`; }
  return { ran: true, line, why: d.why, entry };
}

// The pass's step while VMMEM-HIGH holds spawns and the reclaim is on: one reclaim (the gap aside,
// the interval kept; none on a dry run), then vmmem read again against `vmmemShare` of the grant.
// `read()` is { usedGiB, grantGiB, rssGiB } now. -> { lines, over }, `over` false releasing the hold.
// With the reclaim off it changes nothing: the hold stands.
export function reclaimBeforeHold({ settings, vmmemShare, read, file, now = Date.now(), dry = false, run, drop }) {
  if (!settings.on) return { lines: [], over: true };
  const lines = [];
  if (!dry) {
    const s = reclaimStep({ now, settings, read, file, force: true, by: 'pass, before VMMEM-HIGH holds spawns', run, drop });
    lines.push(s.line ?? `VMMEM-RECLAIM: not run before VMMEM-HIGH holds spawns: ${s.why}`);
  }
  const { usedGiB, grantGiB } = read();
  if (!Number.isFinite(usedGiB) || !(grantGiB > 0)) return { lines: [...lines, 'VMMEM-HIGH: vmmem could not be read again, so its hold stands'], over: true };
  const share = usedGiB / grantGiB;
  const over = share >= vmmemShare;
  const pct = Math.round(vmmemShare * 100);
  lines.push(over
    ? `VMMEM-HIGH: the WSL VM still holds ${fixed(usedGiB)} of its ${fixed(grantGiB)} grant (${Math.round(share * 100)}%), at or over its ${pct}% line: hold new spawns`
    : `VMMEM-HIGH: the WSL VM holds ${fixed(usedGiB)} of its ${fixed(grantGiB)} grant now (${Math.round(share * 100)}%), under its ${pct}% line, so it no longer holds spawns`);
  return { lines, over };
}

// The `mem status` line for the reclaim: its state and its last run.
export function reclaimStatusLine(settings, last, now = Date.now()) {
  const head = settings.on
    ? `reclaim: on, at vmmem ${settings.gapGiB}G or more over RSS, at most every ${Math.round(settings.intervalMs / 60_000)}m`
    : `reclaim: off (desk-env machine set ${RECLAIM_KEY}=on turns it on)`;
  if (!last) return `${head}; last run: never`;
  const when = new Date(last.at).toISOString().slice(0, 16).replace('T', ' ');
  return `${head}; last run ${when} UTC (${Math.round((now - last.at) / 60_000)}m ago, ${last.by}): ${last.ok ? '' : `failed, ${last.error}; `}vmmem ${fixed(last.beforeGiB)} -> ${fixed(last.afterGiB)}, RSS ${fixed(last.rssGiB)}`;
}

// ---- .wslconfig ------------------------------------------------------------------------------
// WSL's own reclaim, `autoMemoryReclaim` in .wslconfig's [experimental] section (disabled, gradual or
// dropCache), which takes effect only after the next WSL restart (`wsl.exe --shutdown`).
// The value the file sets, or null where it sets none.
export function wslconfigReclaim(text) {
  let section = '';
  let value = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw.replace(/[#;].*$/, '').trim();
    const s = /^\[([^\]]+)\]$/.exec(l);
    if (s) { section = s[1].trim().toLowerCase(); continue; }
    const kv = /^autoMemoryReclaim\s*=\s*(\S+)/i.exec(l);
    if (kv && section === 'experimental') value = kv[1];
  }
  return value;
}
// The file's text with autoMemoryReclaim=dropCache under [experimental]: an existing setting replaced,
// else the line added to the section, else the section added at the end. Keeps the file's line ends.
export function withDropCache(text) {
  const src = String(text ?? '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.length ? src.split(/\r?\n/) : [];
  if (lines.length && lines.at(-1) === '') lines.pop();
  let section = '';
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/[#;].*$/, '').trim();
    const s = /^\[([^\]]+)\]$/.exec(l);
    if (s) { section = s[1].trim().toLowerCase(); if (section === 'experimental') at = i; continue; }
    if (section === 'experimental' && /^autoMemoryReclaim\s*=/i.test(l)) { lines[i] = 'autoMemoryReclaim=dropCache'; return lines.join(eol) + eol; }
  }
  if (at >= 0) lines.splice(at + 1, 0, 'autoMemoryReclaim=dropCache');
  else lines.push(...(lines.length ? [''] : []), '[experimental]', 'autoMemoryReclaim=dropCache');
  return lines.join(eol) + eol;
}
