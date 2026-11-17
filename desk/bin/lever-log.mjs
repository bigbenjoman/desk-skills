// A repo's lever log: every lever action, automatic or by hand, as one JSON line in
// ~/.desk-autopilot/<slug>/levers.jsonl. It sits in the repo's own state folder, not a batch's, so it
// outlives queue archiving. Every event shares one envelope; `kind` and `reason_code` come from closed
// lists, and `reason` is the actor's own sentence, stored as written.
//
//   import { append, read } from './lever-log.mjs'
//   append(slug, { lever, kind, actor, reason_code, reason, ... })  -> the event as written
//   appendWith(slug, () => event | null)                            -> the event as written, or null
//   read(slug, { kinds, since })                                    -> { events, bad: [{ line, error }] }
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { batchPaths, SAFE_ID } from './desk-env.mjs';
import { withDirLock } from './dir-lock.mjs';
import { REGISTRY, REASON_CODES } from './lever-registry.mjs';

export const VERSION = 1;
export const KINDS = Object.freeze(['assign', 'transition', 'trip', 'ramp', 'override', 'freeze', 'thaw', 'row_change', 'fp_reset', 'evidence_incomplete', 'audit', 'audit_deferred', 'needs_you', 'pair']);
// Kinds that may name no lever: those acting on every lever in the repo or on the machine, a ticket's
// assignment across every lever, an item about the whole repo, and a pair trial's state change (its
// `levers` names the two).
const NO_LEVER = Object.freeze(['freeze', 'thaw', 'row_change', 'assign', 'needs_you', 'pair']);
// Kinds that act on the machine rather than one repo: their `repo` is `*` in whichever log holds them.
const MACHINE_WIDE = Object.freeze(['freeze', 'thaw']);
// A transition by hand is Ben's own call, with no evaluation or evidence file behind it.
const BY_HAND = 'ben';

export class LeverLogError extends Error {}

export function logFile(slug) {
  if (typeof slug !== 'string' || !SAFE_ID.test(slug) || slug.includes('..')) throw new LeverLogError(`lever-log: "${slug}" is not a repo slug`);
  return join(batchPaths(slug).state, 'levers.jsonl');
}

const text = (v) => typeof v === 'string' && v.trim() !== '';

// Throws LeverLogError naming the first thing wrong with the event: kind, then reason code, then the
// fields that kind needs.
function check(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new LeverLogError('lever-log: an event is an object');
  const { kind, reason_code: code } = event;
  if (!KINDS.includes(kind)) throw new LeverLogError(`lever-log: kind "${kind}" is not one of ${KINDS.join(', ')}`);
  if (!Object.hasOwn(REASON_CODES, code)) throw new LeverLogError(`lever-log: reason_code "${code}" is not in the closed list (lever-registry.mjs REASON_CODES)`);
  const need = (key) => { if (!text(event[key])) throw new LeverLogError(`lever-log: a ${kind} event needs "${key}"`); };
  need('actor');
  need('reason');
  // A pair trial's own events name the pair's two levers in `levers`: a `pair` state change, and a
  // ramp that carries `pair` (its key) in place of `lever`.
  const pairOf = kind === 'pair' || (kind === 'ramp' && event.pair != null && event.lever == null);
  if (pairOf) {
    const ls = event.levers;
    if (!Array.isArray(ls) || ls.length !== 2 || ls[0] === ls[1] || ls.some((l) => !Object.hasOwn(REGISTRY, l))) throw new LeverLogError(`lever-log: a ${kind} event for a pair needs "levers", two different registry levers`);
    if (kind === 'pair') { need('from'); need('to'); }
  } else if (!NO_LEVER.includes(kind) || event.lever != null) {
    need('lever');
    if (!Object.hasOwn(REGISTRY, event.lever)) throw new LeverLogError(`lever-log: lever "${event.lever}" is not declared in the lever registry`);
  }
  if (kind === 'transition') {
    need('from');
    need('to');
    if (event.actor !== BY_HAND) { need('eval_id'); need('evidence_file'); }
  }
  // An override sets the lever by hand to `value`, on or off (lever-changes.mjs).
  if (kind === 'override') {
    need('to');
    if (event.to === 'overridden' && !['on', 'off'].includes(event.value)) throw new LeverLogError('lever-log: an override to overridden needs "value", on or off');
  }
  // A trip is a revert with no evaluation behind it: the ticket and the record that tripped it stand in.
  if (kind === 'trip') {
    for (const key of ['from', 'to', 'ticket', 'evidence_file']) need(key);
    if (!Number.isInteger(event.evidence_line) || event.evidence_line < 1) throw new LeverLogError('lever-log: a trip event needs "evidence_line", the triggering record\'s 1-based line');
  }
  if (event.at != null && Number.isNaN(Date.parse(event.at))) throw new LeverLogError(`lever-log: at "${event.at}" is not a date`);
}

const LOCK_WAIT_MS = 10_000;

// Checks the event and appends it as one line, with `v`, `id`, `repo` (`*` for a machine-wide kind)
// and (unless given) `at` filled in. Throws LeverLogError, writing nothing, on an event that fails the
// check.
export function append(slug, event) {
  check(event);
  return appendWith(slug, () => event);
}

// As append, but `build()` runs under the log's lock and returns the event, or null to write nothing
// (append then returns null). A caller that decides from what the log already holds reads it there,
// so two callers deciding at once cannot both append.
export function appendWith(slug, build) {
  const file = logFile(slug);
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  return withDirLock(lock, () => {
    const event = build();
    if (event == null) return null;
    check(event);
    const { v, id, repo, at, ...rest } = event;
    const line = { v: VERSION, id: randomUUID(), at: at ?? new Date().toISOString(), repo: MACHINE_WIDE.includes(event.kind) ? '*' : slug, ...rest };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    return line;
  }, {
    waitMs: LOCK_WAIT_MS,
    pollMs: 20,
    timeoutError: (pid) => new LeverLogError(`lever-log: ${lock} is held by pid ${pid ?? '?'} past the ${LOCK_WAIT_MS / 1000}s wait: nothing was written`),
  });
}

// The log's events, oldest first, narrowed to `kinds` and to those at or after `since` when given. A
// line that does not parse as an event is skipped and named in `bad` by its 1-based line number.
export function read(slug, { kinds, since } = {}) {
  let body = '';
  try { body = readFileSync(logFile(slug), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const from = since == null ? null : Date.parse(since);
  if (Number.isNaN(from)) throw new LeverLogError(`lever-log: since "${since}" is not a date`);
  const events = [];
  const bad = [];
  body.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    let e;
    try { e = JSON.parse(raw); } catch (err) { bad.push({ line: i + 1, error: err.message }); return; }
    if (!e || typeof e !== 'object' || Array.isArray(e) || !KINDS.includes(e.kind) || Number.isNaN(Date.parse(e.at))) {
      bad.push({ line: i + 1, error: 'not a lever log event' });
      return;
    }
    if (kinds && !kinds.includes(e.kind)) return;
    if (from != null && Date.parse(e.at) < from) return;
    events.push(e);
  });
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { events, bad };
}
