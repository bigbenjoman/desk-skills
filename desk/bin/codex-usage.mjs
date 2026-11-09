// Codex usage per login, read from the session logs Codex writes in each login's own folder, at no
// token cost. Every token_count event in <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl (older ones
// kept as .jsonl.zst) carries `rate_limits`: a `primary` and a `secondary` window, each
// { used_percent, window_minutes, resets_at (epoch seconds) } or null, with `plan_type` and
// `rate_limit_reached_type`. Which slot holds which window changes with the plan, so a window is read
// by its length, never by its slot: 300 minutes is the 5-hour window, 10,080 the weekly one. The logs
// name no account, so a reading is the login's whose folder it was read from. Nothing here reads
// auth.json or any token.
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { subscriptionsPath } from './desk-env.mjs';
import { isDir, readSubscriptions, toolLogins } from './logins.mjs';

const CODEX_WINDOWS = { five_hour: 300, seven_day: 10080 };
const KEYS = Object.keys(CODEX_WINDOWS);
const SLOTS = ['primary', 'secondary'];
const ROLLOUT = /(^|\/)rollout-[^/]*\.jsonl(\.zst)?$/;

// The Codex logins whose folders exist: the default ~/.codex, the subscriptions file's Codex rows,
// then the folders under ~/.codex-logins it does not list, each once by folder.  -> [login]
export const codexLogins = () => toolLogins('codex', readSubscriptions(subscriptionsPath())).filter((l) => isDir(l.dir));

// One rate_limits record as a reading: each window by length as { used, resetsAt, limited }, `none`
// the windows it lacks (its plan has no such window), `plan` its plan_type as logged. A window is at
// its limit at 100% used, or when rate_limit_reached_type names it: by slot where the type names one,
// otherwise the fullest window, the latest reset breaking a tie.
function readingOf(rl, at) {
  const r = { five_hour: null, seven_day: null, at, none: [], plan: typeof rl.plan_type === 'string' ? rl.plan_type : null };
  const seen = [];
  for (const slot of SLOTS) {
    const w = rl[slot];
    const k = KEYS.find((key) => CODEX_WINDOWS[key] === w?.window_minutes);
    if (!k || !Number.isFinite(w.used_percent) || !Number.isFinite(w.resets_at) || w.resets_at <= 0) continue;
    r[k] = { used: w.used_percent, resetsAt: w.resets_at, limited: w.used_percent >= 100 };
    seen.push({ k, slot });
  }
  const reached = rl.rate_limit_reached_type;
  if (reached != null && reached !== false && seen.length) {
    const named = seen.find((s) => String(reached).toLowerCase().includes(s.slot));
    const k = named?.k ?? seen.map((s) => s.k).sort((a, b) => (r[b].used - r[a].used) || (r[b].resetsAt - r[a].resetsAt))[0];
    r[k].limited = true;
  }
  r.none = KEYS.filter((k) => !seen.some((s) => s.k === k));
  return seen.length ? r : null;
}

// The last reading in one log's text, or null. `at` is the event's own timestamp, else `fallbackAt`.
function lastReading(text, fallbackAt = null) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e?.payload;
    if (p?.type !== 'token_count' || !p.rate_limits || typeof p.rate_limits !== 'object') continue;
    const ts = Date.parse(e.timestamp);
    const r = readingOf(p.rate_limits, Number.isFinite(ts) ? ts : fallbackAt);
    if (r) return r;
  }
  return null;
}

// A plain log's last TAIL_BYTES from its first whole line, or the whole log when that holds no reading;
// a compressed one whole. '' when it cannot be read (a .zst on a Node without zstd included).
const TAIL_BYTES = 1024 * 1024;
function logText(path, size, whole = false) {
  let fd;
  try {
    if (path.endsWith('.zst')) return zlib.zstdDecompressSync ? zlib.zstdDecompressSync(readFileSync(path)).toString('utf8') : '';
    if (!whole && size > TAIL_BYTES) {
      fd = openSync(path, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      const n = readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
      const text = buf.toString('utf8', 0, n);
      return text.slice(text.indexOf('\n') + 1);
    }
    return readFileSync(path, 'utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

// A log's reading, kept while its size and modified time hold.
const parsed = new Map();
function readingIn(path, st) {
  const had = parsed.get(path);
  if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return had.reading;
  let reading = lastReading(logText(path, st.size), st.mtimeMs);
  if (!reading && !path.endsWith('.zst') && st.size > TAIL_BYTES) reading = lastReading(logText(path, st.size, true), st.mtimeMs);
  parsed.set(path, { size: st.size, mtimeMs: st.mtimeMs, reading });
  return reading;
}

// Every session log under a Codex login's folder, plain or compressed, with its stat.
//   -> [{ path, st }], or null when the login has no sessions folder
export function rolloutLogs(codexDir) {
  const root = join(codexDir, 'sessions');
  let names;
  try { names = readdirSync(root, { recursive: true }).map(String).filter((n) => ROLLOUT.test(n)); } catch { return null; }
  const logs = [];
  for (const name of names) {
    const path = join(root, name);
    try { const st = statSync(path); if (st.isFile()) logs.push({ path, st }); } catch { /* gone */ }
  }
  return logs;
}

// One Codex login's newest reading, by the reading's own time, from the session logs under its own
// folder. Logs are read newest-written first, stopping at one last written before the newest reading so
// far: it cannot hold a newer one. A window whose reset has passed is no reading (null, and not in
// `none`), never its old figure; one at its limit is `limited` until its reset.
//   -> { five_hour, seven_day, at, none: [window], plan }
export function readCodexUsage({ login, now = Date.now() }) {
  const empty = { five_hour: null, seven_day: null, at: null, none: [], plan: null };
  const logs = rolloutLogs(login.dir);
  if (!logs) return empty;
  logs.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  let best = null;
  for (const { path, st } of logs) {
    if (best && st.mtimeMs < best.at) break;
    const r = readingIn(path, st);
    if (r && (!best || r.at > best.at)) best = r;
  }
  if (!best) return empty;
  const out = { ...best, none: [...best.none] };
  for (const k of KEYS) if (out[k] && out[k].resetsAt * 1000 <= now) out[k] = null;
  return out;
}

// Every Codex login with its reading.  -> [{ login, reading }]
export const codexUsageByLogin = ({ now = Date.now() } = {}) =>
  codexLogins().map((login) => ({ login, reading: readCodexUsage({ login, now }) }));
