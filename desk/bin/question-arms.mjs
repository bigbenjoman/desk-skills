// How a parked ticket's question reaches the person, by the arm of the question-handling lever its
// pin names (lever-registry.mjs). Every branch on the lever is here, so supervisor.mjs, digest.mjs and
// pass.mjs carry none of it:
//   batched        the ask waits for the check-in digest, as with the lever off; and a park that
//                  recommends a call desk may not take for the worker applies it by default at the
//                  first check-in after it parked (defaultsAtCheckin)
//   one-at-a-time  each ask handed to the person (decider.mjs handItems) is pushed at once
//   mixed          a blocking ask is pushed at once, the rest wait for the digest
// A ticket whose pin names no value runs with the lever off, and nothing here changes what desk does
// for it. An ask is blocking when another ticket of the batch is held behind its ticket, or when the
// hand-over found nothing else in the batch running; the raised ask records the flag and the arm.
//
// Nothing is pushed in quiet hours, 22:00 to 08:00 local time: an ask handed on then is not pushed
// later, and waits for the digest as it would on batched. A park reading `PRODUCTION BROKEN:` is the
// pass's to push, at any hour and on every arm (digest.mjs urgentParks), so it is never pushed here.
//
// A push goes through <state>/ask-pushes.json: queued at the hand-over (queuePushes), sent by the
// supervisor's next notification (duePushes) and kept as pushed once out (markPushed), when the ask is
// recorded as presented by push. The digest still lists a pushed ask, but not as fresh (pushedAsks).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leverValueFor } from './lever-pin.mjs';
import { blockersOf, FINISHED } from './queue-states.mjs';
import { askId, recordAsks } from './ask-ledger.mjs';
import { nextCheckin, neverDefault } from './ask-defaults.mjs';
import { askCategoryIn } from './decisions.mjs';
import { PRODUCTION_BROKEN } from './promotion.mjs';

const LEVER = 'question-handling';
// Quiet hours, local: from QUIET_FROM o'clock to QUIET_TO o'clock the next morning.
const QUIET_FROM = 22;
const QUIET_TO = 8;
const quiet = (now) => now.getHours() >= QUIET_FROM || now.getHours() < QUIET_TO;
const QUIET_HOURS = `${QUIET_FROM}:00 to ${String(QUIET_TO).padStart(2, '0')}:00`;
// How long a pushed ask is remembered: long after any digest could list its park.
const PUSHED_KEEP_MS = 30 * 24 * 3_600_000;

// The arm ticket `t` runs on, or null with the lever off for it; a pin that cannot be read is off.
function armOf(t) {
  try { return leverValueFor(LEVER, t); } catch { return null; }
}

// Whether ticket `key`'s ask blocks in queue `q`: another unfinished ticket is held behind it, or no
// other ticket is running.
function blocking(key, q) {
  const others = Object.entries(q?.tickets ?? {}).filter(([k]) => k !== key).map(([, t]) => t ?? {});
  return others.some((t) => !FINISHED.includes(t.state) && blockersOf(t).includes(key)) || !others.some((t) => t.state === 'running');
}

// The raised step of handed item `i` (one park, `p` its park record) in queue `q`, as ask-ledger.mjs
// takes it: with its arm and blocking flag where the lever is on for the ticket.
export function raised(i, p, q) {
  const arm = armOf(q?.tickets?.[i.ticket]);
  return { step: 'raised', kind: p.kind, question: p.question ?? i.text, ...(arm ? { arm, blocking: blocking(i.ticket, q) } : {}) };
}

const registerPath = (state) => join(state, 'ask-pushes.json');
function readRegister(state) {
  try {
    const r = JSON.parse(readFileSync(registerPath(state), 'utf8'));
    return { pending: r?.pending ?? {}, pushed: r?.pushed ?? {} };
  } catch { return { pending: {}, pushed: {} }; }
}
function update(state, change, now) {
  const r = readRegister(state);
  const out = change(r);
  for (const [ask, at] of Object.entries(r.pushed)) if (now - Date.parse(at) > PUSHED_KEEP_MS) delete r.pushed[ask];
  const file = registerPath(state);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(r, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return out;
}

// Queues a push for each of items `items` just handed to the person (decider.mjs handItems) that its
// arm pushes, in batch state folder `state`, for queue `q` of repo `slug`. -> report lines.
export function queuePushes(state, items, q, { slug, now = new Date() } = {}) {
  const asks = items.filter((i) => i.kind === 'parked' && i.since).flatMap((i) => {
    const t = q?.tickets?.[i.ticket];
    const arm = armOf(t);
    const question = String(t?.park?.question ?? i.text ?? '');
    if (!(arm === 'one-at-a-time' || (arm === 'mixed' && blocking(i.ticket, q))) || PRODUCTION_BROKEN.test(question)) return [];
    return [{ ask: askId(i.ticket, i.since), ticket: i.ticket, since: i.since, arm, question }];
  });
  if (!asks.length) return [];
  const names = asks.map((a) => `${a.ticket} (${a.arm})`).join(', ');
  if (quiet(now)) return [`question-handling: not pushed in quiet hours (${QUIET_HOURS}), each waits for the check-in digest: ${names}`];
  update(state, (r) => {
    for (const a of asks) if (!r.pushed[a.ask]) r.pending[a.ask] = { ...a, key: `ask:${slug}:${a.ask}`, at: now.toISOString() };
  }, now.getTime());
  return [`question-handling: pushed at the next notification: ${names}`];
}

// The pushes queued in `state` to send now, as the supervisor sends a pass's: [{ key, text }]. One whose
// park queue `q` no longer holds (answered or settled since) is dropped, and in quiet hours all are,
// each left to the digest.
export function duePushes(state, q, now = new Date()) {
  if (!existsSync(registerPath(state)) || !Object.keys(readRegister(state).pending).length) return [];
  const live = (p) => { const t = q?.tickets?.[p.ticket]; return t?.state === 'parked' && t.park?.since === p.since; };
  return update(state, (r) => {
    for (const [ask, p] of Object.entries(r.pending)) if (quiet(now) || !live(p)) delete r.pending[ask];
    return Object.values(r.pending).map((p) => ({ key: p.key, text: `${p.ticket}: ${p.question}` }));
  }, now.getTime());
}

// Records the queued pushes `keys` as sent: kept as pushed, and each ask presented by push in the
// ticket ledger of queue file `queue`. -> report lines.
export function markPushed(state, keys, { queue, now = new Date() } = {}) {
  const sent = new Set(keys);
  if (!sent.size || !existsSync(registerPath(state))) return [];
  const done = update(state, (r) => {
    const out = Object.entries(r.pending).filter(([, p]) => sent.has(p.key));
    for (const [ask] of out) { delete r.pending[ask]; r.pushed[ask] = now.toISOString(); }
    return out.map(([, p]) => p);
  }, now.getTime());
  return recordAsks(queue, done.map((p) => ({ step: 'presented', key: p.ticket, since: p.since, via: 'push', ref: p.key, notification: p.key })), { by: 'supervisor', now });
}

// The asks pushed from batch state folder `state`, by ask id (<KEY>:<park.since>).
export const pushedAsks = (state) => new Set(Object.keys(readRegister(state).pushed));

// Whether call `d` (a parsed decision) must never apply by default: a product call, one a check-in
// default never takes (ask-defaults.mjs neverDefault: money, legal, production, customer copy), or a
// fact only the person holds, such as who owns something.
const neverDefaults = (d) => {
  const text = `${d.question} ${d.options.join(' ')}`;
  return d.category === 'product' || neverDefault(text, d.chose) != null || askCategoryIn(`${text} ${d.chose}`) === 'user-fact';
};

// Whether ticket `t`'s park, recommending call `d` that desk may not take for the worker, applies it by
// default at `now`: on the batched arm only, once a check-in time of `times` (digest.mjs checkinTimes)
// has passed since it parked.
export function defaultsAtCheckin(t, d, { times, now = new Date() } = {}) {
  if (armOf(t) !== 'batched' || !t?.park?.since || !times?.length || neverDefaults(d)) return false;
  const at = nextCheckin(times, new Date(t.park.since));
  return !!at && at <= now;
}

// The answer the next worker reads for a call applied by default.
export const defaultAnswer = (d) => `${d.chose}. This was the option the last worker recommended when it parked on this ${d.category} call. `
  + 'Nobody answered it by the check-in after it parked, so desk applied it by default; the person can still reverse it. Build it and carry on rather than park on it again.';

// The decision logged for it, in decisions.mjs's shape, with how to reverse it from the digest.
export const defaultCall = (d, key, at) => ({
  ...d,
  question: `${d.question} Nobody answered by the check-in, so desk applied the recommendation by default at ${at}. To reverse it, override it here with ${d.options.filter((o) => o !== d.chose).join(' or ')}, then answer ${key} with that choice.`,
});
