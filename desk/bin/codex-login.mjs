// The Codex login a desk-codex call runs on. With one Codex login, or no subscriptions file, there is
// nothing to choose and the call keeps the caller's environment, unless the file sets every Codex
// login it lists off, when no call runs. With more, it runs on the usable login (signed in, in rotation
// or on standby) with the most room, ranked as a Claude login's is (login-choice.mjs) on whichever
// windows its plan has. A login whose newest reading is at a limit is benched until that window
// resets; with every usable login benched, or none usable, no call runs and `dead` says why.
import { subscriptionsPath } from './desk-env.mjs';
import { codexLogins, readCodexUsage } from './codex-usage.mjs';
import { chooseLogin } from './login-choice.mjs';
import { checkLogins, loginEnv, readSubscriptions } from './logins.mjs';

// A Codex window in the shape login-choice reads a Claude one in.
const asClaude =(w) => (w ? { utilization: w.used / 100, resetsAt: w.resetsAt } : null);

// When a reading's limit lifts, in epoch seconds: the latest reset of a window at its limit, or null
// with none at its limit. A window past its reset is already no reading (codex-usage.mjs).
export function benchedUntil(reading) {
  const out = ['five_hour', 'seven_day'].map((k) => reading?.[k]).filter((w) => w?.limited).map((w) => w.resetsAt);
  return out.length ? Math.max(...out) : null;
}

// -> { login, env, dead }: the login chosen (null when the caller's own is kept), the environment the
// call runs in, and, when no call may run, the reason.
export function codexCallLogin({ env = process.env, now = Date.now() } = {}) {
  const keep = { login: null, env, dead: null };
  const none = { login: null, env, dead: 'no Codex login is signed in with a rule of in rotation or standby (desk-env logins check)' };
  // With no subscriptions file desk has one login per tool, whatever folders exist (logins.mjs).
  const subs = readSubscriptions(subscriptionsPath());
  if (!subs.exists) return keep;
  // The file's rows decide, not the folders found: an off row whose folder is gone still sets it off.
  if (codexLogins().length <= 1) return subs.logins.some((l) => l.tool === 'codex' && l.rule !== 'off') ? keep : none;
  const { usable } = checkLogins(subs, { tools: ['codex'], env });
  if (!usable.length) return none;
  const { login, read } = codexChoice(usable, now);
  if (!login) {
    const first = [...read].sort((a, b) => a.until - b.until)[0];
    return { login: null, env, dead: `every Codex login is at its usage limit: the earliest to reset is ${first.login.name}, at ${new Date(first.until * 1000).toISOString()}` };
  }
  return { login, env: loginEnv(login, env), dead: null };
}

// The Codex login a call starts on among `logins`, with each one's reading and when its limit lifts.
// `login` is null when every one is at its limit. `claude` is the reading in a Claude reading's shape.
//   -> { login, read: [{ login, reading, claude, until }] }
export function codexChoice(logins, now = Date.now()) {
  const read = logins.map((login) => {
    const reading = readCodexUsage({ login, now });
    return { login, reading, until: benchedUntil(reading),
      claude: { five_hour: asClaude(reading.five_hour), seven_day: asClaude(reading.seven_day), at: reading.at, none: reading.none } };
  });
  const open = read.filter((r) => r.until == null);
  const login = open.length ? chooseLogin(open.map((r) => ({ login: r.login, running: 0, reading: r.claude })), now) : null;
  return { login, read };
}
