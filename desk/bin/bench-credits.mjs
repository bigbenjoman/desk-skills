// Whether usage credits are off on every Claude account desk signs in with, which the bench's Fable
// side needs: a headless request that would bill usage credits goes through without asking.
//
// Each rate_limit_event line in a stream-json log carries the account's state in rate_limit_info
// (tests/fixtures/usage-limit-allowed.json): overageStatus, overageDisabledReason and isUsingOverage.
// Credits are off only when overage is rejected for a named reason other than out_of_credits: an empty
// balance is not off, since a top-up would make the next request billable.
import { snapshot, accountFor } from './bench-quota.mjs';
import { probeLogins } from './claude-logins.mjs';
import { loginProbeLog, probeNow, usageDir } from './usage-probe.mjs';
import { EVENT } from './usage-pace.mjs';

const rateInfos = (text) => String(text ?? '').split('\n').flatMap((line) => {
  if (!line.startsWith(EVENT)) return [];
  try { const i = JSON.parse(line)?.rate_limit_info; return i && typeof i === 'object' ? [i] : []; } catch { return []; }
});

// The newest event's credit fields, or null when the text has no event that can be read.
//   -> { status, reason, using } | null
export function newestCredits(text) {
  const i = rateInfos(text).at(-1);
  return i ? { status: i.overageStatus, reason: i.overageDisabledReason, using: i.isUsingOverage } : null;
}

// Whether a log line, or any line of a log, records a request using overage.
export const usingOverage = (text) => rateInfos(text).some((i) => i.isUsingOverage === true);

const shown = (r) => [`overageStatus ${r.status}`, r.reason && `overageDisabledReason ${r.reason}`, r.using === true && 'isUsingOverage true'].filter(Boolean).join(', ');

// What a reading says.  -> { state: 'off' | 'on' | 'unknown', reading: <what it read> }
export function creditState(r) {
  if (!r) return { state: 'unknown', reading: 'no rate-limit reading could be read' };
  if (typeof r.status !== 'string' || !r.status) return { state: 'unknown', reading: 'its newest rate-limit reading names no overageStatus' };
  if (r.using === true || r.status !== 'rejected') return { state: 'on', reading: shown(r) };
  if (r.reason === 'out_of_credits') return { state: 'on', reading: `${shown(r)}, so only the empty balance is stopping them` };
  if (typeof r.reason !== 'string' || !r.reason) return { state: 'unknown', reading: `${shown(r)}, with no reason named` };
  return { state: 'off', reading: shown(r) };
}

// One login's state from a probe made now, which counts only if this probe wrote its output.
export function probedCredits(login, { dir = usageDir(), env = process.env } = {}) {
  const file = loginProbeLog(dir, login);
  const prior = snapshot(file);
  const p = probeNow({ dir, env, login });
  const after = snapshot(file);
  if (!after || (prior && prior.at === after.at && prior.text === after.text)) return { state: 'unknown', reading: `no new rate-limit reading${p.ok ? '' : `: the usage probe failed (${p.why})`}` };
  return creditState(newestCredits(after.text));
}

// The logins the check covers: every one desk may start or probe work on (only the default login where
// no subscriptions list exists), and the one the run itself is signed in with.
export function creditLogins(env = process.env) {
  return [...new Map([...probeLogins(), accountFor('claude', env).login].map((l) => [l.dir, l])).values()];
}

// Null when every login reads credits off, else why the Fable side may not run, naming each login that
// does not and its reading.
export function fableRefusal({ env = process.env, dir = usageDir(), logins = creditLogins(env), read = probedCredits } = {}) {
  const bad = logins.map((l) => ({ l, ...read(l, { dir, env }) })).filter((c) => c.state !== 'off');
  if (!bad.length) return null;
  return `refusing the Fable side: ${bad.map(({ l, state, reading }) => `Claude login ${l.name} ${state === 'on' ? `does not read usage credits off (${reading})` : `has an unknown usage credit state (${reading})`}`).join('; ')}`;
}
