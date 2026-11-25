// How a parked ticket's question reaches the person, by the arm of the question-handling lever its
// pin names (lever-registry.mjs). Every branch on the lever is here, so supervisor.mjs, digest.mjs and
// pass.mjs carry none of it:
//   batched        the ask waits for the check-in digest, as with the lever off; and a park that
//                  recommends a call desk may not take for the worker applies it by default at the
//                  first check-in after the digest listed it (defaultsAtCheckin)
//   one-at-a-time  each ask handed to the person (decider.mjs handItems) is pushed at once
//   mixed          a blocking ask is pushed at once, the rest wait for the digest
// A ticket whose pin names no value runs with the lever off, and nothing here changes what desk does
// for it. An ask is blocking when another ticket of the batch is held behind its ticket, or when
// nothing else in the batch is running. Whichever path raises an ask first (a hand-over, the digest,
// the pass's take or urgent push), its raised step carries the arm and the flag (raisedOf).
//
// Nothing is pushed in quiet hours, 22:00 to 08:00 local time: an ask handed on then is pushed once
// they end, unless a check-in digest has listed it first. A park reading `PRODUCTION BROKEN:` is the
// pass's to push, at any hour and on every arm (digest.mjs urgentParks), so it is never pushed here.
//
// The pushes are reconciled on each supervisor tick, under its batch lock (duePushes): every park
// still handed on and unanswered (<state>/handed.json) that its arm pushes, and that no push and no
// digest has presented, is due. Once the notification is out, markPushed keeps it in
// <state>/ask-pushes.json and records the ask as presented by push in the ledger; either record counts
// as pushed, so one whose register write failed is not pushed again. The digest still lists a pushed
// ask, but not as fresh (pushedAsks).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leverValueFor } from './lever-pin.mjs';
import { blockersOf, FINISHED } from './queue-states.mjs';
import { askId, readAsks, recordAsks } from './ask-ledger.mjs';
import { fold } from './ticket-ledger.mjs';
import { ledgerTarget } from './queue-ledger.mjs';
import { answered, readHanded } from './decider.mjs';
import { isHeld } from './batch-state.mjs';
import { writeJsonAtomic } from './dir-lock.mjs';
import { nextCheckin, neverDefault } from './ask-defaults.mjs';
import { askCategoryIn } from './decisions.mjs';
import { PRODUCTION_BROKEN } from './promotion.mjs';

const LEVER = 'question-handling';
// Quiet hours, local: from QUIET_FROM o'clock to QUIET_TO o'clock the next morning.
const QUIET_FROM = 22;
const QUIET_TO = 8;
const quiet = (now) => now.getHours() >= QUIET_FROM || now.getHours() < QUIET_TO;
// How long a pushed ask is remembered: long after any digest could list its park.
const PUSHED_KEEP_MS = 30 * 24 * 3_600_000;
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

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
// The arm and blocking flag ticket `key`'s raised ask carries in queue `q`: none with the lever off.
function armFields(key, q) {
  const arm = armOf(q?.tickets?.[key]);
  return arm ? { arm, blocking: blocking(key, q) } : {};
}

// The raised step of parked ticket `t` in queue `q`, as ask-ledger.mjs takes it, for any path that
// raises its ask.
export const raisedOf = (t, q) => ({ step: 'raised', key: t.key, since: t.park?.since, kind: t.park?.kind, question: t.park?.question, ...armFields(t.key, q) });
// The same for handed item `i` (one park, `p` its park record), its key and since given by the caller.
export const raised = (i, p, q) => ({ step: 'raised', kind: p.kind, question: p.question ?? i.text, ...armFields(i.ticket, q) });

// The time each ask of queue file `queue`'s ledger was presented `via` a check-in digest or a push:
// Map(ask id -> at), empty where the ledger cannot be read.
function presentedVia(queue, via) {
  try {
    return new Map(readAsks(fold(ledgerTarget(queue).repoDir)).flatMap((a) => a.presented.filter((p) => p.via === via).map((p) => [a.ask, p.at])));
  } catch { return new Map(); }
}
export const digestPresented = (queue) => presentedVia(queue, 'digest');

const registerPath = (state) => join(state, 'ask-pushes.json');
// The asks pushed from batch state folder `state`: { <ask id>: at }.
function readPushed(state) {
  try { return JSON.parse(readFileSync(registerPath(state), 'utf8'))?.pushed ?? {}; } catch { return {}; }
}

// The pushes due now from batch state folder `state` for queue `q` (its file `queue`, of repo `slug`):
// each park handed on, unanswered since, that its arm pushes and nothing has presented by push or
// digest. Run under the supervisor's batch lock, through to markPushed. -> [{ key, text, ticket, since }]
export function duePushes(state, q, { queue, slug, now = new Date() } = {}) {
  if (quiet(now)) return [];
  const handed = Object.values(readHanded(state)).filter((e) => e.kind === 'parked');
  const asks = handed.flatMap((e) => {
    const t = q?.tickets?.[e.ticket];
    const since = t?.park?.since;
    if (t?.state !== 'parked' || isHeld(t) || !since || Date.parse(e.at) < Date.parse(since)) return [];
    const arm = armOf(t);
    if (!(arm === 'one-at-a-time' || (arm === 'mixed' && blocking(e.ticket, q)))) return [];
    const question = String(t.park.question ?? e.text ?? '');
    if (PRODUCTION_BROKEN.test(question)) return [];
    return [{ entry: e, ask: askId(e.ticket, since), ticket: e.ticket, since, question }];
  });
  if (!asks.length) return [];
  const pushed = readPushed(state);
  const left = asks.filter((a) => !pushed[a.ask] && !answered(state, a.entry));
  if (!left.length) return [];
  // The ledger's record of a push stands where the register's write failed.
  const shown = digestPresented(queue);
  const sent = presentedVia(queue, 'push');
  return [...new Map(left.filter((a) => !shown.has(a.ask) && !sent.has(a.ask)).map((a) => [a.ask, a])).values()]
    .map((a) => ({ key: `ask:${slug}:${a.ask}`, text: `${a.ticket}: ${a.question}`, ticket: a.ticket, since: a.since }));
}

// Records pushes `sent` (duePushes's, once the notification is out) as pushed, and each ask presented
// by push in the ticket ledger of queue file `queue`. Never throws. -> report lines.
export function markPushed(state, sent, { queue, now = new Date() } = {}) {
  if (!sent.length) return [];
  const lines = [];
  try {
    const pushed = readPushed(state);
    for (const p of sent) pushed[askId(p.ticket, p.since)] = now.toISOString();
    for (const [ask, at] of Object.entries(pushed)) if (now.getTime() - Date.parse(at) > PUSHED_KEEP_MS) delete pushed[ask];
    writeJsonAtomic(registerPath(state), { pushed });
  } catch (e) {
    lines.push(`question-handling: ${sent.map((p) => p.ticket).join(', ')} pushed, but not recorded in ${registerPath(state)} (${firstLine(e)}); the next tick may push again`);
  }
  return [...lines, ...recordAsks(queue, sent.map((p) => ({ step: 'presented', key: p.ticket, since: p.since, via: 'push', ref: p.key, notification: p.key })), { by: 'supervisor', now })];
}

// The asks pushed from batch state folder `state`, by ask id (<KEY>:<park.since>): the register's, and
// with its queue file `queue` any the ledger records presented by push, which stands where the
// register's write failed.
export function pushedAsks(state, queue = null) {
  const out = new Set(Object.keys(readPushed(state)));
  if (queue) for (const a of presentedVia(queue, 'push').keys()) out.add(a);
  return out;
}

// Whether call `d` (a parsed decision) must never apply by default: a product call, one a check-in
// default never takes (ask-defaults.mjs neverDefault: money, legal, production, customer copy), or a
// fact only the person holds, such as who owns something.
const neverDefaults = (d) => {
  const text = `${d.question} ${d.options.join(' ')}`;
  return d.category === 'product' || neverDefault(text, d.chose) != null || askCategoryIn(`${text} ${d.chose}`) === 'user-fact';
};

// Whether ticket `t`'s park, recommending call `d` that desk may not take for the worker, applies it by
// default at `now`: on the batched arm only, once a check-in digest has listed it and the next
// check-in time of `times` (digest.mjs checkinTimes) after that has passed, so the person had a whole
// check-in to answer it. `presented`, called only on that arm, gives digestPresented's map.
export function defaultsAtCheckin(t, d, { times, presented, now = new Date() } = {}) {
  if (armOf(t) !== 'batched' || !t?.park?.since || !times?.length || neverDefaults(d)) return false;
  const listed = presented?.().get(askId(t.key, t.park.since));
  const at = listed ? nextCheckin(times, new Date(listed)) : null;
  return !!at && at <= now;
}

// The answer the next worker reads for a call applied by default.
export const defaultAnswer = (d) => `${d.chose}. This was the option the last worker recommended when it parked on this ${d.category} call. `
  + 'The check-in digest listed it and nobody answered it by the next check-in, so desk applied it by default; the person can still reverse it. Build it and carry on rather than park on it again.';

// The decision logged for it, in decisions.mjs's shape, with how to reverse it from the digest.
export const defaultCall = (d, key, at) => ({
  ...d,
  question: `${d.question} The check-in digest listed it and nobody answered by the next check-in, so desk applied the recommendation by default at ${at}. To reverse it, override it here with ${d.options.filter((o) => o !== d.chose).join(' or ')}, then answer ${key} with that choice.`,
});
