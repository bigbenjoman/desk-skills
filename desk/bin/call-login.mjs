// The Claude login a pass's own model call starts on: the decider, triage and its lane challenge, and
// epic planning's headless calls. It is chosen as a new worker's is (pass.mjs pickLogin): among the
// usable logins that are not benched, the one with the most room (login-choice.mjs). A login is benched
// when any of this repo's batches benched it (the queue's `benched`) and its reset has not passed; a
// bench with no reset time stands until a pass's probe clears it.
//
// With no subscriptions file, or this process's own login the only one in use, there is nothing to
// choose and the call keeps the caller's environment. With every usable login benched it keeps it too,
// and `all` says so: the decider then starts nothing, and triage and epic planning start as they would
// with one login, on the caller's own.
//
// With accounts pinned (logins.mjs multiAccount) there is no caller's own to fall back on: ~/.claude is
// the person's own Claude Code. With no usable login, or every one benched, the call waits (`wait`, and
// `all`): the decider starts nothing, and triage and epic planning are put off to a pass with room.
//
// Starting nothing on ~/.claude does not stop a worker already running there: claude-logins.mjs still reads
// its registry.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueFile, stateDir, subscriptionsPath } from './desk-env.mjs';
import { readQueue } from './batch-state.mjs';
import { listBatches } from './batches.mjs';
import { loginOf, loginKey, probeLogins, workerLoginDir } from './claude-logins.mjs';
import { checkLogins, loginEnv, multiAccount, readSubscriptions } from './logins.mjs';
import { chooseLogin } from './login-choice.mjs';
import { newestReading, WEEK_MS } from './usage-pace.mjs';
import { loginProbeLog, usageDir } from './usage-probe.mjs';

// Whether a limit lifting at `resetsAt` (epoch seconds, or null) replaces the bench `was` on a login:
// the limit that lifts last stands, one with no reset time outlasting any with one. pass.mjs's bench and
// liveBenches both keep it.
export const laterLift = (was, resetsAt) => !was || resetsAt == null || (was.resets_at != null && resetsAt > was.resets_at);

// With no subscriptions file, or the caller's own login the only one in use, there is no login to
// choose: work runs on the caller's own. `subs` is readSubscriptions', `inUse` probeLogins'.
export const nothingToChoose = (subs, own, inUse) => !subs.exists || (inUse.length === 1 && inUse[0].dir === own.dir);

// Every bench in `maps` (queues' `benched`) whose limit has not lifted at `now`, by login key: where two
// bench one login, the later lift (laterLift).
export function liveBenches(maps, now) {
  const out = {};
  for (const m of maps) {
    for (const [k, v] of Object.entries(m ?? {})) {
      if (!v || (v.resets_at != null && now >= v.resets_at * 1000)) continue;
      if (laterLift(out[k], v.resets_at)) out[k] = v;
    }
  }
  return out;
}

// The Claude login new work starts on among `logins`, as a new worker's is (pass.mjs pickLogin): of
// those `benched` does not hold, the one login-choice ranks first on its week-long probe reading, with
// `running(login)` workers on it. `dirs` are the state folders whose worker logs count too.
//   -> { login, out: [{ login, at }] }: `login` null when every one is benched; `out` each benched login
//      with when it lifts (`at`, epoch seconds, or null)
export function claudeChoice(logins, { benched, running, now = Date.now(), dirs } = {}) {
  const out = logins.filter((l) => benched[loginKey(l)]).map((l) => ({ login: l, at: benched[loginKey(l)].resets_at ?? null }));
  const open = logins.filter((l) => !benched[loginKey(l)]);
  const login = chooseLogin(open.map((l) => ({ login: l, running: running(l),
    reading: newestReading({ ...(dirs ? { dirs } : {}), files: [loginProbeLog(usageDir(), l)], login: l, now, recent: WEEK_MS }) })), now);
  return { login, out };
}

// Every bench across this repo's batches, and the one the environment pins, whose limit has not lifted
// at `now`, by login key, and the config folder of each running worker. A queue that cannot be read
// benches nothing.
function batchesNow(now) {
  const maps = [];
  const running = [];
  const batches = [];
  try { batches.push({ queue: queueFile(), state: stateDir() }); } catch { /* no pinned batch */ }
  try { batches.push(...listBatches().filter((b) => !batches.some((p) => resolve(p.queue) === resolve(b.queue)))); } catch { /* outside a repo there are none */ }
  for (const b of batches) {
    let q;
    try { q = readQueue(b.queue); } catch { continue; }
    maps.push(q.benched);
    for (const t of Object.values(q.tickets ?? {})) if (t.state === 'running') running.push(t.login ? t.login.config_dir ?? null : workerLoginDir(b.state, t.key));
  }
  return { benched: liveBenches(maps, now), running };
}

// Why a pinned-accounts call starts nothing: the start of each reason given for it.
export const NO_ROOM = 'every Claude account is at its limit or signed out';

// -> { login, env, all, wait }: the login chosen (null when the caller's own is kept), the environment
// the call runs in (null when it waits), whether every usable login is benched, and whether the call
// waits for one with room rather than run.
export function callLogin({ env = process.env, now = Date.now() } = {}) {
  const keep = { login: null, env, all: false, wait: false };
  const subs = readSubscriptions(subscriptionsPath());
  const pinned = multiAccount(subs);
  const own = loginOf(env.CLAUDE_CONFIG_DIR);
  if (!pinned && nothingToChoose(subs, own, probeLogins())) return keep;
  const { benched, running } = batchesNow(now);
  const { usable } = checkLogins(subs, { tools: ['claude'], env });
  const { login, out } = claudeChoice(usable, { benched, running: (l) => running.filter((d) => d === l.configDir).length, now });
  if (pinned && (!login || out.length === usable.length)) return { login: null, env: null, all: true, wait: true };
  if (out.length === usable.length) return { ...keep, all: usable.length > 0 };
  if (!login || (!pinned && login.dir === own.dir)) return keep;
  return { login, env: loginEnv(login, env), all: false, wait: false };
}

// ---- CLI ---------------------------------------------------------------------------------------
//   dir    for a shell caller: `keep` (run as the caller is), `all` (every usable login benched, so run
//          as the caller is), `default` (unset CLAUDE_CONFIG_DIR) or the config folder to point it at.
//          With accounts pinned and none with room it prints `all` and exits 3: start nothing
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv[2] !== 'dir') {
    console.error('usage: call-login.mjs dir');
    process.exit(2);
  }
  const c = callLogin();
  console.log(c.all ? 'all' : !c.login ? 'keep' : c.login.configDir ?? 'default');
  if (c.wait) process.exit(3);
}
