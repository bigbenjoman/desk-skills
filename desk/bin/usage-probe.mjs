// The usage reading desk-q's headers show, and the small check that keeps it fresh while no worker
// runs. A worker log carries a rate_limit_event at its session's start and seldom another
// (usage-pace.mjs); with none running,
// an open desk-q runs one Haiku call every PROBE_EVERY_MS whose event carries both windows, about 2 s
// and 3.6k tokens. Its stream-json output is kept as <usage dir>/probe.log and read like a worker log.
// Never billed to an API key: the call runs without ANTHROPIC_API_KEY, on the signed-in account.
//
// A probe given a login runs in that login's config folder, and its output and start time are kept as
// that login's: probe.log and probe.at for the default login, probe.<login>.log and probe.<login>.at
// for another, so another login's reading is never read as the default's. A login may be named by its
// name in the subscriptions file, whatever its rule, as well as given as a login.
import { mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { WINDOWS, WINDOW_LABELS, newestReading, stateDirs, usageDir, probeLog, windowUse } from './usage-pace.mjs';
import { tryBorrowLock } from './borrow.mjs';
import { sleepSync } from './dir-lock.mjs';
import { apiRefusal, resetText, usageLimit } from './usage-limit.mjs';
import { defaultLogin, loginEnv, readSubscriptions } from './logins.mjs';
import { claudeLogins, loginKey } from './claude-logins.mjs';
import { codexUsageByLogin } from './codex-usage.mjs';

export const PROBE_EVERY_MS = 5 * 60 * 1000;
// However many desk-q windows are open, at most one probe starts in this long.
export const PROBE_GAP_MS = 60 * 1000;
const PROBE_LOCK = 'desk-usage-probe.lock.d';
export const PROBE_ARGS = ['-p', 'Reply with: ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
  '--setting-sources', '', '--strict-mcp-config', '--tools', ''];
export { usageDir, probeLog };
// The login a caller names: a login as given, or by name, the Claude login of that name the
// subscriptions file lists (or finds) whatever its rule, `default` being ~/.claude where no login
// takes that name. A name no login has is an error, never read as the default's.
export function asLogin(login) {
  if (typeof login !== 'string') return login;
  const named = (x) => x.tool === 'claude' && x.name === login;
  const l = claudeLogins().find(named) ?? readSubscriptions(E.subscriptionsPath()).logins.find(named) ?? (login === 'default' ? defaultLogin('claude') : null);
  if (!l) throw new Error(`no Claude login named ${login}`);
  return l;
}
const forLogin = (login) => { const l = asLogin(login); return l?.configDir ? `.${loginKey(l)}` : ''; };
export const loginProbeLog = (dir = usageDir(), login = null) => { const k = forLogin(login); return k ? join(dir, `probe${k}.log`) : probeLog(dir); };
const probeStamp = (dir, login) => join(dir, `probe${forLogin(login)}.at`);
// When a probe last started on this login (ms), or null when none has.
export const lastProbeAt = (dir = usageDir(), login = null) => {
  try { const n = Number(readFileSync(probeStamp(dir, login), 'utf8')); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
};

// A login's newest reading of both windows, the default's with none named: its worker logs in every
// repo and its last probe's output, the same sources a pass's pacing reads.
//   -> { five_hour, seven_day, at, none }
export const readUsage = ({ dir = usageDir(), dirs = stateDirs({ self: dir }), login = null, now = Date.now() } = {}) =>
  newestReading({ dirs, files: [loginProbeLog(dir, login)], login: asLogin(login), now });

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

// A Codex login's line: its name and plan as its logs record it, each window's use and reset, a window
// at its limit as such, and when the reading was logged, since a login with no recent call keeps an old one.
function codexWindowText(k, reading, now) {
  const label = WINDOW_LABELS[k], w = reading[k];
  if (reading.none.includes(k)) return `no ${WINDOW_LONG_NAMES[k]} window`;
  if (!w || w.resetsAt * 1000 <= now) return `${label} no reading`;
  if (w.limited) return `${label} at its limit until ${resetText(w.resetsAt)}`;
  return `${label} ${Math.round(w.used)}%, resets ${resetText(w.resetsAt)}`;
}
export function codexReadingsText(rows, now) {
  const width = Math.max(...rows.map((r) => r.login.name.length));
  return rows.map(({ login, reading }) => `${login.name.padEnd(width)}  ${reading.at == null ? 'no reading'
    : [reading.plan ?? 'plan not logged', ...WINDOWS.map((k) => codexWindowText(k, reading, now)), `read ${resetText(Math.floor(reading.at / 1000))}`].join(' · ')}`).join('\n');
}

// The printed readings: the Claude logins, then a Codex section when this computer has a Codex login.
export function allReadingsText(claude, codex, now) {
  const text = readingsText(claude, now);
  return codex.length ? `Claude\n${text}\n\nCodex\n${codexReadingsText(codex, now)}` : text;
}

// A probe is due only with no worker running on what it reads and no reading in the last PROBE_EVERY_MS.
export const probeDue = ({ running, reading, now }) => running === 0 && (reading?.at == null || now - reading.at > PROBE_EVERY_MS);
// With no reading for a login at all, a pass probes it at most once per PROBE_EVERY_MS from the last
// probe's start, except that one started under PROBE_GAP_MS ago with no log written since is still
// running: the pass joins it (probeShared) and judges on its answer, rather than pacing blind.
export const noReadingProbeDue = ({ dir = usageDir(), login = null, now = Date.now() } = {}) => {
  const started = lastProbeAt(dir, login);
  if (started == null || now - started > PROBE_EVERY_MS) return true;
  return now - started < PROBE_GAP_MS && !loggedSince(dir, login, started);
};

// The probe's environment: the caller's without ANTHROPIC_API_KEY, in the login's folder when given one,
// on the 5-minute prompt cache, as a one-request call never reads a cache an hour later.
export function probeEnv(env = process.env, login = null) {
  const { ANTHROPIC_API_KEY: _key, ...rest } = env;
  return { ...(login ? loginEnv(asLogin(login), env) : rest), FORCE_PROMPT_CACHING_5M: '1' };
}

// The machine-wide gate on a login's probe start, which desk-q's probe and a pass's (probeShared) both
// pass through: under the probe lock, write `now` as the login's start stamp unless a probe of it
// started under PROBE_GAP_MS ago.  -> { mine: true } | { mine: false, started } (that probe's start)
//   | { mine: false, held: true, holder } (the lock is busy) | { mine: false, why } (it cannot be made)
function claimProbeStart({ dir, lockDir, login, now }) {
  const lock = tryBorrowLock({ dir: lockDir, name: PROBE_LOCK });
  if (!lock.ok) return { mine: false, ...(lock.held ? { held: true, holder: lock.holder } : { why: lock.why }) };
  try {
    const started = lastProbeAt(dir, login);
    if (started != null && now - started < PROBE_GAP_MS) return { mine: false, started };
    mkdirSync(dir, { recursive: true });
    writeFileSync(probeStamp(dir, login), String(now));
    return { mine: true };
  } finally { lock.release(); }
}

// Start one probe, unless another desk-q started one on the same login in the last PROBE_GAP_MS. The
// start time is read and written under a lock, so two windows reaching a probe together start one
// between them. `done` is called when it exits.  -> { ran: true } | { ran: false, why }
export async function probe({ dir = usageDir(), lockDir = E.lockDir(), claude = 'claude', env = process.env, login = null, now = Date.now(), done = () => {} } = {}) {
  const claim = claimProbeStart({ dir, lockDir, login, now });
  if (!claim.mine) return { ran: false, why: claim.started != null ? 'one started under a minute ago' : 'another desk-q is starting one' };
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
// `refused` is the API turning the call away with HTTP 401 or 403 (usage-limit.mjs apiRefusal), which
// no reset time lifts.
//   -> { ok: true } | { ok: false, limit: { type, resetsAt } | null, refused: { status, why } | null, why }
// Its stamp is written as the call ends, before its log, and only with output to log: a pass that finds
// the stamp under a minute old waits for a log written since it (probeShared), so one with no log to
// follow would keep that pass waiting out its time limit.
export function probeNow({ dir = usageDir(), claude = 'claude', env = process.env, login = null, timeoutMs = 120_000 } = {}) {
  return runProbe({ dir, claude, env, login, timeoutMs, stampEnd: true });
}

// The call itself, its output kept as the login's probe log. The log is written beside it and moved
// over it whole, so a pass waiting on this probe (probeShared) never reads it half written.
function runProbe({ dir, claude, env, login, timeoutMs, stampEnd = false }) {
  const r = spawnSync(claude, PROBE_ARGS, { env: probeEnv(env, login), encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = r.stdout ?? '';
  try {
    mkdirSync(dir, { recursive: true });
    if (out) {
      if (stampEnd) writeFileSync(probeStamp(dir, login), String(Date.now()));
      const log = loginProbeLog(dir, login), part = `${log}.${process.pid}.part`;
      writeFileSync(part, out);
      renameSync(part, log);
    }
  } catch { /* the answer stands without the reading */ }
  return probeAnswer(out, r, claude);
}

// What one probe's output says: has the limit lifted?  `r` is how the call ended (spawnSync's status,
// signal, error and stderr), or null for an answer read from the login's probe log.
function probeAnswer(out, r, claude) {
  const u = usageLimit(out);
  const limit = u.last?.kind === 'limit' && !u.last.resumed ? { type: u.last.type, resetsAt: u.last.resetsAt } : null;
  // Answered: a result that is not an error, and no rejection after the model last spoke.
  const answered = out.split('\n').some((l) => { try { const e = JSON.parse(l); return e?.type === 'result' && e.is_error === false; } catch { return false; } });
  const refused = apiRefusal(out);
  if ((r == null || r.status === 0) && answered && !limit && !refused) return { ok: true };
  const why = refused ? refused.why
    : limit ? 'rejected at the usage limit'
    : r == null ? 'its output holds no answer'
    : r.error ? r.error.message
    : `${claude} exited ${r.status ?? r.signal} with no answer${(r.stderr ?? '').trim() ? `: ${r.stderr.trim().split('\n').pop().slice(0, 200)}` : ''}`;
  return { ok: false, limit, refused, why };
}

const loginName = (login) => { const l = asLogin(login); return l?.configDir ? l.name : 'default'; };

// Whether the login's probe log was written at or after `since`. A filesystem that keeps mtimes to the
// second is compared to the second.
function loggedSince(dir, login, since) {
  try { return statSync(loginProbeLog(dir, login)).mtimeMs >= Math.floor(since / 1000) * 1000; } catch { return false; }
}

// The answer to the probe of a login that started at `since`: its probe log, once written at or after
// then.  -> answer | null
function answerSince(dir, login, since) {
  if (!loggedSince(dir, login, since)) return null;
  try { return probeAnswer(readFileSync(loginProbeLog(dir, login), 'utf8'), null); } catch { return null; }
}

// probeNow behind the same machine-wide lock and per-login start stamp desk-q's probe takes (probe,
// above), for a pass held on the usage limit. A probe of the login started under PROBE_GAP_MS ago,
// by another pass or a desk-q window, is not repeated: this waits for that probe's answer, up to its
// own time limit, and judges on it (`shared: true`). One that never answers keeps the hold, saying
// so. Only the pass probes this way; health's sign-in check and bench-quota call probeNow directly.
//   -> probeNow's answer, with `shared: true` when it is another probe's
export function probeShared({ dir = usageDir(), lockDir = E.lockDir(), claude = 'claude', env = process.env, login = null, timeoutMs = 120_000, pollMs = 1000 } = {}) {
  const until = Date.now() + timeoutMs;
  let started;
  for (;;) {
    let claim;
    try { claim = claimProbeStart({ dir, lockDir, login, now: Date.now() }); } catch { claim = { mine: true }; }
    if (claim.why) return probeNow({ dir, claude, env, login, timeoutMs });
    if (claim.mine) return runProbe({ dir, claude, env, login, timeoutMs: Math.max(1, until - Date.now()) });
    if (!claim.held) { started = claim.started; break; }
    if (Date.now() >= until) return { ok: false, limit: null, refused: null, why: `the usage probe lock stayed held by pid ${claim.holder ?? '?'} for ${Math.round(timeoutMs / 1000)}s` };
    sleepSync(Math.min(pollMs, 100));
  }
  for (;;) {
    const a = answerSince(dir, login, started);
    if (a) return { ...a, shared: true };
    if (Date.now() >= until) {
      return { ok: false, limit: null, refused: null, shared: true,
        why: `the shared probe of login ${loginName(login)}, started ${Math.round((Date.now() - started) / 1000)}s ago by another pass or desk-q, gave no answer within ${Math.round(timeoutMs / 1000)}s` };
    }
    sleepSync(Math.max(1, Math.min(pollMs, until - Date.now())));
  }
}

// ---- CLI ---------------------------------------------------------------------------------------
//   readings        each Claude login by name, with its 5-hour and 7-day use and reset times, then
//                   each Codex login with its plan and the same, read from its session logs
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv[2] === 'readings') {
    const now = Date.now();
    console.log(allReadingsText(usageByLogin({ now }), codexUsageByLogin({ now }), now));
  } else {
    console.error('usage: usage-probe.mjs readings');
    process.exit(2);
  }
}
