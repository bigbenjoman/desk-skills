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
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueFile, stateDir, subscriptionsPath } from './desk-env.mjs';
import { readQueue } from './batch-state.mjs';
import { listBatches } from './batches.mjs';
import { loginOf, loginKey, probeLogins, workerLoginDir } from './claude-logins.mjs';
import { checkLogins, loginEnv, readSubscriptions } from './logins.mjs';
import { chooseLogin } from './login-choice.mjs';
import { newestReading, WEEK_MS } from './usage-pace.mjs';
import { loginProbeLog, usageDir } from './usage-probe.mjs';

// Every bench across this repo's batches, and the one the environment pins, whose limit has not lifted
// at `now`, by login key, and the config folder of each running worker. A queue that cannot be read
// benches nothing.
function batchesNow(now) {
  const benched = {};
  const running = [];
  const batches = [];
  try { batches.push({ queue: queueFile(), state: stateDir() }); } catch { /* no pinned batch */ }
  try { batches.push(...listBatches().filter((b) => !batches.some((p) => resolve(p.queue) === resolve(b.queue)))); } catch { /* outside a repo there are none */ }
  for (const b of batches) {
    let q;
    try { q = readQueue(b.queue); } catch { continue; }
    for (const [k, r] of Object.entries(q.benched ?? {})) if (r && (r.resets_at == null || now < r.resets_at * 1000)) benched[k] = r;
    for (const t of Object.values(q.tickets ?? {})) if (t.state === 'running') running.push(t.login ? t.login.config_dir ?? null : workerLoginDir(b.state, t.key));
  }
  return { benched, running };
}

const reading = (l) => newestReading({ files: [loginProbeLog(usageDir(), l)], login: l, recent: WEEK_MS });

// -> { login, env, all }: the login chosen (null when the caller's own is kept), the environment the
// call runs in, and whether every usable login is benched.
export function callLogin({ env = process.env, now = Date.now() } = {}) {
  const keep = { login: null, env, all: false };
  const subs = readSubscriptions(subscriptionsPath());
  const own = loginOf(env.CLAUDE_CONFIG_DIR);
  const inUse = probeLogins();
  if (!subs.exists || (inUse.length === 1 && inUse[0].dir === own.dir)) return keep;
  const { benched, running } = batchesNow(now);
  const { usable } = checkLogins(subs, { tools: ['claude'], env });
  const open = usable.filter((l) => !benched[loginKey(l)]);
  if (!open.length) return { ...keep, all: usable.length > 0 };
  const login = chooseLogin(open.map((l) => ({ login: l, reading: reading(l), running: running.filter((d) => d === l.configDir).length })), now);
  if (!login || login.dir === own.dir) return keep;
  return { login, env: loginEnv(login, env), all: false };
}

// ---- CLI ---------------------------------------------------------------------------------------
//   dir    for a shell caller: `keep` (run as the caller is), `all` (every usable login benched, so run
//          as the caller is), `default` (unset CLAUDE_CONFIG_DIR) or the config folder to point it at
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
}
