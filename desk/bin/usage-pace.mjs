// Weekly usage pacing: a pass holds new spawns while the 7-day usage window is ahead of an even pace.
// One weekly allowance runs every repo's workers, so a factory left unpaced runs out mid-week. Pace is
// the share of the 7-day window gone since its last reset; spawns hold while utilisation is above pace
// plus config §3b "Usage pacing headroom (points)" (unset: 5, or `off`). Running workers carry on.
//
// The figures come from the `rate_limit_event` lines Claude Code writes to every worker's stream-json
// log (tests/fixtures/usage-limit-allowed.json): `rate_limit_info.unifiedWindows.seven_day` holds
// `utilization` (0–1) and `resetsAt` (epoch seconds). The window resets at `resetsAt`, read rather
// than assumed.
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as E from './desk-env.mjs';
import { resetText } from './usage-limit.mjs';
import { readLogFile } from './harvest.mjs';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Only a log written to in this long counts: an older event says little about usage now.
export const RECENT_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_HEADROOM = 5;
const ROW = () => E.CONFIG_ROWS['usage-pacing'].row;
const EVENT = '{"type":"rate_limit_event"';

// The §3b row: a number of percentage points (unset is the default), or `off`. Anything else is
// refused rather than read as off, so a typo never silently removes the guard.
//   -> { off: true } | { headroom } | { bad: <why> }
export function pacingSetting(raw = E.configValue('usage-pacing')) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return { headroom: DEFAULT_HEADROOM };
  if (v === 'off') return { off: true };
  if (/^\d+(\.\d+)?$/.test(v)) return { headroom: Number(v) };
  return { bad: `config §3b "${ROW()}" is "${raw}" — want a number of percentage points, or \`off\`` };
}

// The 7-day figures in one log's text: every top-level rate_limit_event that carries them, as
// { utilization, resetsAt }. The same text inside a tool call or its result is not this worker's usage.
export const sevenDayEvents = (text) => windowEvents(text).map((e) => e.seven_day).filter(Boolean);

// Both windows in one log's text: each top-level rate_limit_event as { five_hour, seven_day }, each
// window { utilization, resetsAt } or null when the event lacks it.
export const WINDOWS = ['five_hour', 'seven_day'];
export function windowEvents(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith(EVENT)) continue;
    let u = null;
    try { u = JSON.parse(line)?.rate_limit_info?.unifiedWindows; } catch { continue; }
    const e = Object.fromEntries(WINDOWS.map((k) => {
      const w = u?.[k];
      return [k, Number.isFinite(w?.utilization) && Number.isFinite(w?.resetsAt) && w.resetsAt > 0 ? { utilization: w.utilization, resetsAt: w.resetsAt } : null];
    }));
    if (e.five_hour || e.seven_day) out.push(e);
  }
  return out;
}

// Every repo's autopilot state directory: this repo's own (an override can move it) and each one
// under ~/.desk-autopilot, since one allowance runs them all.
export function stateDirs({ self = E.stateDir(), root = join(E.HOME, '.desk-autopilot') } = {}) {
  const dirs = [self];
  for (const d of existsSync(root) ? readdirSync(root) : []) dirs.push(join(root, d));
  return [...new Set(dirs.map((d) => resolve(d)))];
}

// The newest 7-day reading across every worker log written in the last RECENT_MS, or null. Events
// carry no time of their own, so "newest" is read from the window: the latest `resetsAt`, and within
// it the highest utilisation, since usage only rises until the window resets.
export const newestUsage = ({ dirs = stateDirs(), now = Date.now() } = {}) => newestReading({ dirs, now }).seven_day;

// The newest reading of each window across every worker log written in the last RECENT_MS, plus any
// `files` named (the usage probe's output), by the same rule as newestUsage. `at` is when the newest
// file holding a chosen event was last written, or null with no reading.
//   -> { five_hour, seven_day, at }
export function newestReading({ dirs = stateDirs(), files = [], now = Date.now() } = {}) {
  const best = { five_hour: null, seven_day: null }, from = {};
  const paths = [...files];
  for (const dir of dirs) {
    const logs = join(dir, 'logs');
    try { paths.push(...readdirSync(logs).map((name) => join(logs, name))); } catch { /* no logs */ }
  }
  for (const path of paths) {
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || now - st.mtimeMs > RECENT_MS) continue;
    for (const e of eventsOf(path, st)) {
      for (const k of WINDOWS) {
        const w = e[k], b = best[k];
        if (w && (!b || w.resetsAt > b.resetsAt || (w.resetsAt === b.resetsAt && w.utilization > b.utilization))) {
          best[k] = w;
          from[k] = st.mtimeMs;
        }
      }
    }
  }
  const at = Object.values(from);
  return { ...best, at: at.length ? Math.max(...at) : null };
}

// A log's events, kept while its size and modified time hold: an open desk-q rereads every two seconds.
const parsed = new Map();
function eventsOf(path, st) {
  const had = parsed.get(path);
  if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return had.events;
  const events = windowEvents(tail(path, st.size));
  parsed.set(path, { size: st.size, mtimeMs: st.mtimeMs, events });
  return events;
}

// A log's last TAIL_BYTES, from its first whole line, or the whole log when that holds no event: a
// worker writes one after most API calls, so the tail almost always has the newest, and a pass reads
// every repo's recent logs. A round moved aside is gzipped, so it is read whole. '' when it cannot be
// read.
const TAIL_BYTES = 1024 * 1024;
function tail(path, size) {
  let fd;
  try {
    if (path.endsWith('.gz')) return readLogFile(path);
    if (size > TAIL_BYTES) {
      fd = openSync(path, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      const n = readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
      const text = buf.toString('utf8', 0, n);
      const cut = text.slice(text.indexOf('\n') + 1);
      if (cut.includes(EVENT)) return cut;
    }
    const all = readFileSync(path, 'utf8');
    return all.includes(EVENT) ? all : '';
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

// The share of the 7-day window gone at `now`, in percent (0–100).
export function paceAt(resetsAt, now) {
  const gone = WEEK_MS - (resetsAt * 1000 - now);
  return Math.min(100, Math.max(0, (gone / WEEK_MS) * 100));
}

// The pass's decision and its report line.
//   -> { hold: bool, bad: <why> | null, line }
export function usagePace({ setting = pacingSetting(), usage = undefined, now = Date.now() } = {}) {
  if (setting.bad) return { hold: true, bad: setting.bad, line: `usage: ${setting.bad} — holding spawns` };
  const u = usage === undefined ? newestUsage({ now }) : usage;
  // A reading whose window has already reset says nothing about the new window.
  const known = u && u.resetsAt * 1000 > now;
  if (setting.off) {
    const fig = known ? `7-day ${Math.round(u.utilization * 100)}%, pace ${Math.round(paceAt(u.resetsAt, now))}%, ` : '';
    return { hold: false, bad: null, line: `usage: ${fig}pacing off (config §3b "${ROW()}")` };
  }
  if (!u) return { hold: false, bad: null, line: 'usage: no recent data' };
  if (!known) return { hold: false, bad: null, line: `usage: no recent data (the newest reading's 7-day window reset at ${resetText(u.resetsAt)})` };
  // To a tenth of a point: 0.55 * 100 is 55.00000000000001, which would hold at exactly pace + headroom.
  const used = Math.round(u.utilization * 1000) / 10;
  const pace = paceAt(u.resetsAt, now);
  const fig = `7-day ${Math.round(used)}%, pace ${Math.round(pace)}%`;
  if (used > pace + setting.headroom) return { hold: true, bad: null, line: `usage: ${fig} + ${setting.headroom}: holding spawns` };
  return { hold: false, bad: null, line: `usage: ${fig}` };
}
