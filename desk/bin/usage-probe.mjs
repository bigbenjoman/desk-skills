// The usage reading desk-q's headers show, and the small check that keeps it fresh while no worker
// runs. Worker logs carry a rate_limit_event after most API calls (usage-pace.mjs); with none running,
// an open desk-q runs one Haiku call every PROBE_EVERY_MS whose event carries both windows, about 2 s
// and 3.6k tokens. Its stream-json output is kept as <usage dir>/probe.log and read like a worker log.
// Never billed to an API key: the call runs without ANTHROPIC_API_KEY, on the signed-in account.
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as E from './desk-env.mjs';
import { newestReading, stateDirs, usageDir, probeLog } from './usage-pace.mjs';
import { takeBorrowLock } from './borrow.mjs';
import { usageLimit } from './usage-limit.mjs';

export const PROBE_EVERY_MS = 5 * 60 * 1000;
// However many desk-q windows are open, at most one probe starts in this long.
export const PROBE_GAP_MS = 60 * 1000;
export const PROBE_ARGS = ['-p', 'Reply with: ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
  '--setting-sources', '', '--strict-mcp-config', '--tools', ''];
export { usageDir, probeLog };

// The newest reading of both windows: every repo's worker logs and the last probe's output, the same
// sources a pass's newestUsage reads.
//   -> { five_hour, seven_day, at }
export const readUsage = ({ dir = usageDir(), dirs = stateDirs({ self: dir }), now = Date.now() } = {}) =>
  newestReading({ dirs, files: [probeLog(dir)], now });

// A probe is due only with no worker running anywhere and no reading in the last PROBE_EVERY_MS.
export const probeDue = ({ running, reading, now }) => running === 0 && (reading?.at == null || now - reading.at > PROBE_EVERY_MS);

// The probe's environment: the caller's without ANTHROPIC_API_KEY.
export function probeEnv(env = process.env) {
  const { ANTHROPIC_API_KEY: _key, ...rest } = env;
  return rest;
}

// Start one probe, unless another desk-q started one in the last PROBE_GAP_MS. The start time is
// read and written under a lock, so two windows reaching a probe together start one between them.
// `done` is called when it exits.  -> { ran: true } | { ran: false, why }
export async function probe({ dir = usageDir(), lockDir = E.lockDir(), claude = 'claude', env = process.env, now = Date.now(), done = () => {} } = {}) {
  const lock = await takeBorrowLock({ dir: lockDir, name: 'desk-usage-probe.lock.d', waitMs: 0 });
  if (!lock.ok) return { ran: false, why: 'another desk-q is starting one' };
  const stamp = join(dir, 'probe.at');
  try {
    let last = 0;
    try { last = Number(readFileSync(stamp, 'utf8').trim()) || 0; } catch { /* never ran */ }
    if (now - last < PROBE_GAP_MS) return { ran: false, why: 'one started under a minute ago' };
    mkdirSync(dir, { recursive: true });
    writeFileSync(stamp, String(now));
  } finally { lock.release(); }
  // Written beside the last output and moved over it at exit, so the last reading stays while it runs.
  const part = `${probeLog(dir)}.part`;
  const fd = openSync(part, 'w');
  let ended = false;
  const end = (ok) => {
    if (ended) return;
    ended = true;
    if (ok) { try { renameSync(part, probeLog(dir)); } catch { /* gone */ } }
    done();
  };
  try {
    const child = spawn(claude, PROBE_ARGS, { env: probeEnv(env), stdio: ['ignore', fd, 'ignore'] });
    child.on('error', () => end(false));
    child.on('exit', (code) => end(code === 0));
    child.unref();
  } finally { closeSync(fd); }
  return { ran: true };
}

// One probe the caller waits for: has the usage limit lifted? A batch held on it asks once a pass,
// whatever the limit's reset time says, since a switch to another subscription lifts it early. Its
// output is kept as probe.log, so desk-q's reading is as fresh as the answer.
//   -> { ok: true } | { ok: false, limit: { type, resetsAt } | null, why }
export function probeNow({ dir = usageDir(), claude = 'claude', env = process.env, timeoutMs = 120_000 } = {}) {
  const r = spawnSync(claude, PROBE_ARGS, { env: probeEnv(env), encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = r.stdout ?? '';
  try {
    mkdirSync(dir, { recursive: true });
    if (out) writeFileSync(probeLog(dir), out);
    writeFileSync(join(dir, 'probe.at'), String(Date.now()));
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
