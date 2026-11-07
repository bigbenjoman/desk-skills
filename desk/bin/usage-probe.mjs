// The usage reading desk-q's headers show, and the small check that keeps it fresh while no worker
// runs. Worker logs carry a rate_limit_event after most API calls (usage-pace.mjs); with none running,
// an open desk-q runs one Haiku call every PROBE_EVERY_MS whose event carries both windows, about 2 s
// and 3.6k tokens. Its stream-json output is kept as <usage dir>/probe.log and read like a worker log.
// Never billed to an API key: the call runs without ANTHROPIC_API_KEY, on the signed-in account.
//
// A probe given a login runs in that login's config folder, and its output and start time are kept as
// that login's: probe.log and probe.at for the default login, probe.<login>.log and probe.<login>.at
// for another, so another login's reading is never read as the default's.
import { mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { WINDOWS, WINDOW_LABELS, newestReading, stateDirs, usageDir, probeLog, windowUse } from './usage-pace.mjs';
import { takeBorrowLock } from './borrow.mjs';
import { resetText, usageLimit } from './usage-limit.mjs';
import { loginEnv } from './logins.mjs';
import { claudeLogins, loginKey } from './claude-logins.mjs';

export const PROBE_EVERY_MS = 5 * 60 * 1000;
// However many desk-q windows are open, at most one probe starts in this long.
export const PROBE_GAP_MS = 60 * 1000;
export const PROBE_ARGS = ['-p', 'Reply with: ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
  '--setting-sources', '', '--strict-mcp-config', '--tools', ''];
export { usageDir, probeLog };
const forLogin = (login) => (login?.configDir ? `.${loginKey(login)}` : '');
export const loginProbeLog = (dir = usageDir(), login = null) => (forLogin(login) ? join(dir, `probe${forLogin(login)}.log`) : probeLog(dir));
const probeStamp = (dir, login) => join(dir, `probe${forLogin(login)}.at`);

// A login's newest reading of both windows, the default's with none named: its worker logs in every
// repo and its last probe's output, the same sources a pass's pacing reads.
//   -> { five_hour, seven_day, at, none }
export const readUsage = ({ dir = usageDir(), dirs = stateDirs({ self: dir }), login = null, now = Date.now() } = {}) =>
  newestReading({ dirs, files: [loginProbeLog(dir, login)], login, now });

// A login's newest reading from its own probe's output alone, which is what its next probe is judged on.
export const readLoginUsage = ({ login, dir = usageDir(), now = Date.now() }) =>
  newestReading({ dirs: [], files: [loginProbeLog(dir, login)], now });

// Every Claude login with its reading.  -> [{ login, reading }]
export const usageByLogin = ({ now = Date.now() } = {}) =>
  claudeLogins().map((login) => ({ login, reading: readUsage({ login, now }) }));

// One login's line: its name, then each window's use and reset time. A login with no recent reading
// says so rather than showing a figure, and a window its subscription lacks is named as lacking.
const WINDOW_LONG_NAMES = { five_hour: '5-hour', seven_day: '7-day' };
function windowText(k, reading, now) {
  const label = WINDOW_LABELS[k], w = reading[k];
  if (reading.none.includes(k)) return `no ${WINDOW_LONG_NAMES[k]} window`;
  if (!w) return `${label} no reading`;
  const { reset, pct } = windowUse(w, now);
  return `${label} ${pct}%, ${reset ? 'reset' : 'resets'} ${resetText(w.resetsAt)}`;
}
export function readingsText(rows, now) {
  const width = Math.max(...rows.map((r) => r.login.name.length));
  return rows.map(({ login, reading }) => `${login.name.padEnd(width)}  ${reading.at == null ? 'no reading' : WINDOWS.map((k) => windowText(k, reading, now)).join(' · ')}`).join('\n');
}

// A probe is due only with no worker running on what it reads and no reading in the last PROBE_EVERY_MS.
export const probeDue = ({ running, reading, now }) => running === 0 && (reading?.at == null || now - reading.at > PROBE_EVERY_MS);

// The probe's environment: the caller's without ANTHROPIC_API_KEY, in the login's folder when given one.
export function probeEnv(env = process.env, login = null) {
  if (login) return loginEnv(login, env);
  const { ANTHROPIC_API_KEY: _key, ...rest } = env;
  return rest;
}

// Start one probe, unless another desk-q started one on the same login in the last PROBE_GAP_MS. The
// start time is read and written under a lock, so two windows reaching a probe together start one
// between them. `done` is called when it exits.  -> { ran: true } | { ran: false, why }
export async function probe({ dir = usageDir(), lockDir = E.lockDir(), claude = 'claude', env = process.env, login = null, now = Date.now(), done = () => {} } = {}) {
  const lock = await takeBorrowLock({ dir: lockDir, name: 'desk-usage-probe.lock.d', waitMs: 0 });
  if (!lock.ok) return { ran: false, why: 'another desk-q is starting one' };
  const stamp = probeStamp(dir, login);
  try {
    let last = 0;
    try { last = Number(readFileSync(stamp, 'utf8').trim()) || 0; } catch { /* never ran */ }
    if (now - last < PROBE_GAP_MS) return { ran: false, why: 'one started under a minute ago' };
    mkdirSync(dir, { recursive: true });
    writeFileSync(stamp, String(now));
  } finally { lock.release(); }
  // Written beside the last output and moved over it at exit, so the last reading stays while it runs.
  const out = loginProbeLog(dir, login);
  const part = `${out}.part`;
  const fd = openSync(part, 'w');
  let ended = false;
  const end = (ok) => {
    if (ended) return;
    ended = true;
    if (ok) { try { renameSync(part, out); } catch { /* gone */ } }
    done();
  };
  try {
    const child = spawn(claude, PROBE_ARGS, { env: probeEnv(env, login), stdio: ['ignore', fd, 'ignore'] });
    child.on('error', () => end(false));
    child.on('exit', (code) => end(code === 0));
    child.unref();
  } finally { closeSync(fd); }
  return { ran: true };
}

// One probe the caller waits for: has the usage limit lifted? A batch held on it asks once a pass,
// whatever the limit's reset time says, since a switch to another subscription lifts it early. Its
// output is kept as the login's probe log, so desk-q's reading is as fresh as the answer.
//   -> { ok: true } | { ok: false, limit: { type, resetsAt } | null, why }
export function probeNow({ dir = usageDir(), claude = 'claude', env = process.env, login = null, timeoutMs = 120_000 } = {}) {
  const r = spawnSync(claude, PROBE_ARGS, { env: probeEnv(env, login), encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = r.stdout ?? '';
  try {
    mkdirSync(dir, { recursive: true });
    if (out) writeFileSync(loginProbeLog(dir, login), out);
    writeFileSync(probeStamp(dir, login), String(Date.now()));
  } catch { /* the answer stands without the reading */ }
  const u = usageLimit(out);
  const limit = u.last?.kind === 'limit' && !u.last.resumed ? { type: u.last.type, resetsAt: u.last.resetsAt } : null;
  // Answered: a result that is not an error, and no rejection after the model last spoke.
  const answered = out.split('\n').some((l) => { try { const e = JSON.parse(l); return e?.type === 'result' && e.is_error === false; } catch { return false; } });
  if (r.status === 0 && answered && !limit) return { ok: true };
  const why = limit ? 'rejected at the usage limit'
    : r.error ? r.error.message
    : `${claude} exited ${r.status ?? r.signal} with no answer${(r.stderr ?? '').trim() ? `: ${r.stderr.trim().split('\n').pop().slice(0, 200)}` : ''}`;
  return { ok: false, limit, why };
}

// ---- CLI ---------------------------------------------------------------------------------------
//   readings        each Claude login by name, with its 5-hour and 7-day use and reset times
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv[2] === 'readings') {
    const now = Date.now();
    console.log(readingsText(usageByLogin({ now }), now));
  } else {
    console.error('usage: usage-probe.mjs readings');
    process.exit(2);
  }
}
