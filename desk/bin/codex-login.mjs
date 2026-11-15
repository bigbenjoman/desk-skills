// The Codex login a desk-codex call runs on. With no subscriptions file, or a Codex default of ~/.codex
// and no other Codex folder, the call keeps the caller's environment, unless the file sets every Codex
// login it lists off, when no call runs. Otherwise it runs on the tool's default (logins.mjs), and
// only there: a default at its limit, signed out or with its folder gone is not swapped for another
// login. At its limit its call fails as a sole login's would; off or not signed in, no call runs and
// `dead` says why.
import { subscriptionsPath } from './desk-env.mjs';
import { codexLogins, readCodexUsage } from './codex-usage.mjs';
import { checkLogin, defaultOf, loginEnv, readSubscriptions } from './logins.mjs';

// A Codex window in a Claude reading's shape.
const asClaude =(w) => (w ? { utilization: w.used / 100, resetsAt: w.resetsAt } : null);

// When a reading's limit lifts, in epoch seconds: the latest reset of a window at its limit, or null
// with none at its limit. A window past its reset is already no reading (codex-usage.mjs).
export function benchedUntil(reading) {
  const out = ['five_hour', 'seven_day'].map((k) => reading?.[k]).filter((w) => w?.limited).map((w) => w.resetsAt);
  return out.length ? Math.max(...out) : null;
}

// -> { login, env, dead }: the login chosen (null when the caller's own is kept), the environment the
// call runs in, and, when no call may run, the reason.
export function codexCallLogin({ env = process.env } = {}) {
  const keep = { login: null, env, dead: null };
  // With no subscriptions file desk has one login per tool, whatever folders exist (logins.mjs).
  const subs = readSubscriptions(subscriptionsPath());
  if (!subs.exists) return keep;
  // The file's default, or in the older rules its first login in rotation. A file whose Codex rows
  // are all off picks an off one, and no call runs until a person names a default.
  const login = defaultOf(subs.logins, 'codex');
  if (login.rule === 'off') return { login: null, env, dead: `the Codex default, ${login.name}, is off (desk-env logins default codex <name>)` };
  // A default of ~/.codex with no other Codex folder found runs as a sole login always has, unchecked.
  if (!login.configDir && codexLogins().every((l) => l.dir === login.dir)) return keep;
  const { state, why } = checkLogin(login, { env });
  if (state !== 'signed in') return { login: null, env, dead: `the Codex default, ${login.name}, is ${state === 'error' ? `not checked: ${why}` : 'not signed in'} (desk-env logins check)` };
  return { login, env: loginEnv(login, env), dead: null };
}

// A Codex login's newest reading and when its limit lifts. `claude` is the reading in a Claude reading's
// shape.   -> { login, reading, claude, until }
export function codexReading(login, now = Date.now()) {
  const reading = readCodexUsage({ login, now });
  return { login, reading, until: benchedUntil(reading),
    claude: { five_hour: asClaude(reading.five_hour), seven_day: asClaude(reading.seven_day), at: reading.at, none: reading.none } };
}
