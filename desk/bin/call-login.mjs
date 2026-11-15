// The Claude login a pass's own model call runs on: the decider, triage and its lane challenge, and
// epic planning's headless calls. Each runs on the repo's subscription, the one its new workers start
// on (desk-env.mjs thisRepoSubscription), and never on another login for its room.
//
// With no subscriptions file and the repo following the default, or the subscription the caller's own
// login, the call keeps the caller's environment. At the subscription's usage limit (a batch of this
// repo holds on it) the decider waits for the next one; triage and epic planning still run on it. With
// the subscription naming an account no login here is signed in to, there is no login to run on: the
// decider waits, and triage and epic planning run as the caller does.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueFile, subscriptionsPath, thisRepoSubscription } from './desk-env.mjs';
import { readQueue } from './batch-state.mjs';
import { listBatches } from './batches.mjs';
import { loginOf } from './claude-logins.mjs';
import { loginEnv, readSubscriptions, repoSubscription } from './logins.mjs';
import { limitName, resetText } from './usage-limit.mjs';

// Whether a limit lifting at `resetsAt` (epoch seconds, or null) replaces the bench `was` on a login:
// the limit that lifts last stands, one with no reset time outlasting any with one. liveBenches keeps it.
export const laterLift = (was, resetsAt) => !was || resetsAt == null || (was.resets_at != null && resetsAt > was.resets_at);

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

// The usage limit holding this repo's work on `login`, the repo's subscription, from its batches and the
// one the environment pins: the first batch's usage_hold on that login whose reset has not passed at
// `now`, or null. A pass records a hold only for a limit on the repo's subscription, its login in
// `login_dir` (none: the pass's own, `own`), and keeps it until a probe finds the limit lifted. A hold
// on another login, left from before the row changed, holds nothing, as pass.mjs reads it. A queue that
// cannot be read holds nothing.
function repoHold(login, own, now) {
  const batches = [];
  try { batches.push({ queue: queueFile() }); } catch { /* no pinned batch */ }
  try { batches.push(...listBatches().filter((b) => !batches.some((p) => resolve(p.queue) === resolve(b.queue)))); } catch { /* outside a repo there are none */ }
  for (const b of batches) {
    let h;
    try { h = readQueue(b.queue).usage_hold; } catch { continue; }
    if (!h || (h.login_dir === undefined ? own : loginOf(h.login_dir)).dir !== login.dir) continue;
    if (h.resets_at == null || now < h.resets_at * 1000) return h;
  }
  return null;
}

// The repo's subscription, or this computer's default where this repo's config cannot be read.
function subscriptionOf(subs, env) {
  try { return thisRepoSubscription({ repoSubscription }, subs, env); } catch { return repoSubscription(subs, { value: env.DESK_SUBSCRIPTION, source: 'DESK_SUBSCRIPTION' }); }
}

// -> { login, env, wait }: the repo's subscription's login (null when the call keeps the caller's
// environment), the environment the call runs in, and why the decider waits (null when it starts).
export function callLogin({ env = process.env, now = Date.now() } = {}) {
  const subs = readSubscriptions(subscriptionsPath());
  const sub = subscriptionOf(subs, env);
  if (!subs.exists && sub.source === 'default') return { login: null, env, wait: null };
  if (!sub.login) return { login: null, env, wait: `the repo's subscription, ${sub.email}, is not signed in to any login here` };
  const own = loginOf(env.CLAUDE_CONFIG_DIR);
  const hold = repoHold(sub.login, own, now);
  const wait = hold ? `the repo's subscription, ${sub.login.name}, is held on ${limitName(hold.type)}${hold.resets_at != null ? ` until ${resetText(hold.resets_at)}` : ''}` : null;
  if (sub.login.dir === own.dir) return { login: null, env, wait };
  return { login: sub.login, env: loginEnv(sub.login, env), wait };
}

// ---- CLI ---------------------------------------------------------------------------------------
//   dir    for a shell caller: `keep` (run as the caller is), `default` (unset CLAUDE_CONFIG_DIR) or
//          the config folder to point it at
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
  console.log(!c.login ? 'keep' : c.login.configDir ?? 'default');
}
