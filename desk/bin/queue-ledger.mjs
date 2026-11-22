// The ledger lever's shadow appends: what one queue write changed, as ticket-ledger events.
//
// With the ledger lever on, every queue write (queue-store.mjs writeQueueFile) appends the difference
// between the queue on disk before it and the queue it wrote: per ticket, a typed event for a change
// of state and one legacy_set for every other field changed with it, and for the batch, its red base
// starting or clearing (base_red, base_green). It records what queue.json kept,
// never the changes a writer asked for. A ticket leaving the queue is archived, or moved out of the
// batch; one arriving with a moved_from record is moved in. The first write the lever sees for a batch
// the log has never named first seeds one event per ticket from the queue as it stood.
//
// queue.json is written first and the log second, and a failed append never fails the queue write: it
// comes back as one missed append for the writer to report.
//
// queueDifference rebuilds a batch's queue from the log and names each ticket field where queue.json
// differs from it: the pass reports that after its writes, and `queue.mjs rebuild` writes the rebuild out.
import { basename, dirname } from 'node:path';
import { BATCHES_DIR, leverOn } from './desk-env.mjs';
import { append, fold, invalid, diffQueues, project, withoutProjectionOnly, parkOf, waitsOfField, ANSWERED, WAITS, PARK_KINDS, TRANSITIONS } from './ticket-ledger.mjs';
import { fieldDiffs, flattenQueue } from './queue-fields.mjs';
import { readQueueAt, same } from './queue-store.mjs';
import { FINISHED } from './queue-states.mjs';
import { parkKindOf } from './batch-state.mjs';
import { lock, unlock } from './dir-lock.mjs';

// What the log calls the standing batch, as `queue.mjs transfer <TICKET> standing` does.
export const STANDING = 'standing';
// Fields every write stamps: appended with the fields they were written with, never on their own, so
// a write that changed only projection-only fields appends nothing.
export const STAMPS = ['updated_at'];

// Whether the ledger lever is on. A config that cannot be read is off: the side that changes nothing.
export function ledgerOn() {
  try { return leverOn('ledger'); } catch { return false; }
}

// The repo folder holding the log, and the batch, of queue `file`: <repo>/queue.json is the standing
// batch, <repo>/batches/<name>/queue.json is batch <name>.
export function ledgerTarget(file) {
  const dir = dirname(file);
  return basename(dirname(dir)) === BATCHES_DIR
    ? { repoDir: dirname(dirname(dir)), batch: basename(dir) }
    : { repoDir: dir, batch: STANDING };
}

const own = (o, k) => !!o && Object.hasOwn(o, k);
const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
const count = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 ? n : null;
};

// The typed event for ticket `now` reaching its state from state `from` (null for none): the event
// whose transition leaves that state. Its data comes from the fields the write left.
function stateEvent(from, now, at) {
  switch (now.state) {
    case 'queued': return from == null || from === 'done' ? { type: 'admitted', data: {} } : { type: 'requeued', data: {} };
    case 'triaged': return { type: 'triaged', data: { questions: Array.isArray(now.questions) ? now.questions : [] } };
    case 'running': return { type: 'spawned', data: { worker: text(now.session_id) ?? text(now.stage), round: count(now.resumes) ?? 0, login: text(now.login?.name), port: count(now.port) } };
    // The whole park, so its replay is the park queue.json keeps: its kind (worked out from its question
    // for a park recorded before parks carried one) and the write it awaits approval of, verbatim.
    case 'parked': {
      const p = now.park && typeof now.park === 'object' ? now.park : {};
      return { type: 'parked', data: { ...p, kind: PARK_KINDS.includes(p.kind) ? p.kind : parkKindOf(p.question),
        question: text(p.question), approve: p.approve && typeof p.approve === 'object' ? p.approve : null, since: text(p.since) ?? at, deadline: text(p.deadline) } };
    }
    case 'done': return { type: 'finished', data: { pr: count(now.result?.pr) } };
    case 'failed': return { type: 'failed', data: { subtype: text(now.failed?.subtype) ?? 'unknown' } };
    default: return null;
  }
}

// The typed events for ticket `now` reaching its state from `was` (undefined for a ticket new here), in
// order: { events, reached }. A ticket new to the queue is admitted first, which also brings back one
// the log holds as archived; one taken from a park or a failure back to triage is requeued first. Each
// must be a legal transition from the state the one before it left (ticket-ledger.mjs TRANSITIONS), so
// the events stop at the first that is not, and `reached` says whether they end at the ticket's state;
// when they do not, the state is recorded with the other fields: the pass also sets states no typed
// event reaches, such as a running ticket back to triaged, and a ticket can join the queue done.
function stateEvents(was, now, at) {
  const start = was?.state ?? null;
  const steps = [];
  if (was === undefined && now.state !== 'queued') steps.push({ type: 'admitted', data: {} });
  else if (['parked', 'failed'].includes(start) && now.state === 'triaged') steps.push({ type: 'requeued', data: {} });
  const last = stateEvent(steps.length ? 'queued' : start, now, at);
  if (last) steps.push(last);
  const events = [];
  let from = start;
  for (const s of steps) {
    if (!TRANSITIONS[s.type].from.includes(from)) break;
    events.push(s);
    from = TRANSITIONS[s.type].to;
  }
  return { events, reached: !!last && events.length === steps.length };
}
// The typed events whose replay clears a ticket's park (ticket-ledger.mjs apply).
const CLEARS_PARK = ['admitted', 'requeued', 'spawned', 'finished', 'unparked'];

// The triage questions ticket `was` gained as answered in becoming `now`, each an answered event, taken
// out of the fields `fields` records with it. Only answers added to the list it had, on a ticket already
// in the queue and not finished: any other change to that list is recorded as the field.
function newlyAnswered(was, now, fields) {
  if (was === undefined || !own(fields, ANSWERED) || FINISHED.includes(now.state)) return [];
  const before = Array.isArray(was[ANSWERED]) ? was[ANSWERED] : [];
  const after = now[ANSWERED];
  if (!Array.isArray(after) || after.length <= before.length || !before.every((q, i) => same(q, after[i]))) return [];
  const added = after.slice(before.length);
  if (!added.every((q) => text(q))) return [];
  delete fields[ANSWERED];
  return added;
}

// The waits ticket `was` ended, started or escalated in becoming `now`, each a waited or waiting event,
// taken out of the fields `fields` records with it. A waits field that is not a map of whole waits is
// recorded as the field.
function waitEvents(was, now, fields) {
  if (!own(fields, WAITS)) return [];
  const before = waitsOfField(was?.[WAITS]);
  const after = waitsOfField(now[WAITS]);
  if (!before || !after) return [];
  const out = [
    ...Object.keys(before).filter((on) => !own(after, on)).map((on) => ({ type: 'waited', data: { on } })),
    ...Object.entries(after).filter(([on, w]) => !same(w, before[on])).map(([, w]) => ({ type: 'waiting', data: w })),
  ];
  if (out.some((e) => invalid({ ...e, batch: STANDING, key: now.key ?? 'ticket' }))) return [];
  delete fields[WAITS];
  return out;
}

// The events queue `before` (the file as it stood, or null) becoming queue `after` records in `batch`.
// `archived` holds each ticket this write moved to the archive, as it was archived. `elsewhere(key)`
// says the log already has that ticket in another batch, so its leaving this one records nothing.
export function queueEvents(before, after, { batch, archived = {}, elsewhere = () => false, at = new Date().toISOString() } = {}) {
  const bt = before?.tickets ?? {};
  const atk = after?.tickets ?? {};
  const live = Object.fromEntries(Object.keys(atk).map((k) => [k, atk[k]]));
  for (const [k, t] of Object.entries(archived)) live[k] = t;
  const changed = new Map();
  for (const d of diffQueues({ tickets: bt }, { tickets: live })) {
    if (!changed.has(d.ticket)) changed.set(d.ticket, []);
    changed.get(d.ticket).push(d);
  }
  const out = [];
  const ev = (key, type, data) => out.push({ type, batch, key, data, at });
  for (const key of new Set([...changed.keys(), ...Object.keys(archived)])) {
    const was = own(bt, key) ? bt[key] : undefined;
    const now = live[key];
    if (now === undefined) {
      if (!elsewhere(key)) ev(key, 'moved', { from: batch, to: null });
      continue;
    }
    const diffs = changed.get(key) ?? [];
    if (diffs.some((d) => !STAMPS.includes(d.field))) {
      const fields = Object.fromEntries(diffs.map((d) => [d.field, d.after === undefined ? null : d.after]));
      if (was === undefined && now.moved_from && typeof now.moved_from === 'object') {
        ev(key, 'moved', { from: text(now.moved_from.batch) ?? STANDING, to: batch });
      } else if (own(fields, 'state')) {
        const { events: typed, reached } = stateEvents(was, now, at);
        if (typed.length && typed.every((e) => !invalid({ ...e, batch, key }))) {
          for (const e of typed) ev(key, e.type, e.data);
          if (reached) delete fields.state;
          // A park the queue keeps is laid back over one an event's replay cleared, and one a parked
          // event's replay leaves as it is needs no field of its own.
          const parked = typed.findLast((e) => e.type === 'parked');
          if (parked && same(parkOf(parked.data), now.park)) delete fields.park;
          else if (now.park != null && typed.some((e) => CLEARS_PARK.includes(e.type))) fields.park = now.park;
        }
      }
      for (const qid of newlyAnswered(was, now, fields)) ev(key, 'answered', { qid });
      for (const e of waitEvents(was, now, fields)) ev(key, e.type, e.data);
      if (Object.keys(fields).length) ev(key, 'legacy_set', { fields });
    }
    if (own(archived, key)) ev(key, 'archived', {});
  }
  for (const e of redBaseEvents(before, after)) ev(null, e.type, e.data);
  return out;
}

// The batch's red base (the queue's `base_red`, pass/base-gate.mjs decideBaseRed) starting or clearing
// in this write: one base_red event as a spell is first recorded, one base_green as it is cleared. Its
// escalation, a change to the same spell's record, appends nothing.
function redBaseEvents(before, after) {
  const was = before?.base_red ?? null;
  const now = after?.base_red ?? null;
  if (was && !now) return [{ type: 'base_green', data: {} }];
  if (!now || typeof now !== 'object' || (was && was.branch === now.branch && was.since === now.since)) return [];
  const e = { type: 'base_red', data: { check: now.check, since: now.since, deadline: now.deadline, merges: now.merges } };
  return invalid({ ...e, batch: STANDING, key: null }) ? [] : [e];
}

// One seeded event per ticket of queue `q` (the file as it stood) in `batch`, but for any in `skip`.
export const seedEvents = (q, batch, skip = new Set(), at = new Date().toISOString()) => Object.keys(q?.tickets ?? {})
  .filter((k) => !skip.has(k))
  .map((key) => ({ type: 'seeded', batch, key, data: { fields: withoutProjectionOnly(q.tickets[key]) }, at }));

// Appends, in one append call, what the write of `after` over `before` to queue `file` changed, seeding
// the batch `before` belongs to first when the log has never named it. `from` is that batch when it is
// not the one `file` holds: a whole queue moved here from another batch (move-batch), each of whose
// tickets gets a moved event naming both. -> { appended } or, when the append failed,
// { appended: 0, missed: 1, why }. Never throws.
export function recordWrite(file, before, after, { by, archived = {}, from = null } = {}) {
  try {
    const { repoDir, batch } = ledgerTarget(file);
    const state = fold(repoDir);
    const elsewhere = (k) => own(state.tickets, k) && state.tickets[k].batch !== batch;
    const at = new Date().toISOString();
    const events = [];
    const leaving = Object.keys(before?.tickets ?? {}).filter((k) => !own(after?.tickets, k) && !own(archived, k) && elsewhere(k));
    const seedAs = from ?? batch;
    if (!own(state.batches, seedAs)) events.push(...seedEvents(before, seedAs, new Set(leaving), at));
    if (from) {
      for (const key of Object.keys(after?.tickets ?? {})) if (own(before?.tickets, key)) events.push({ type: 'moved', batch, key, data: { from, to: batch }, at });
    }
    events.push(...queueEvents(before, after, { batch, archived, elsewhere, at }));
    if (!events.length) return { appended: 0 };
    append(repoDir, events, { by });
    return { appended: events.length };
  } catch (e) {
    return { appended: 0, missed: 1, why: String(e?.message ?? e).split('\n')[0] };
  }
}

// A rebuilt ticket's `holds` is its held_by as a list, which queue.json does not keep.
const REBUILT_ONLY = ['holds'];
// Queue `q`'s tickets alone, as the difference compares them: the queue's own fields are carried into
// a rebuild from queue.json (ticket-ledger.mjs project), and its archive is on neither side.
const comparable = (q) => ({
  queue: { tickets: Object.fromEntries(Object.entries(q?.tickets ?? {}).map(([k, t]) => [k,
    t && typeof t === 'object' ? Object.fromEntries(Object.entries(withoutProjectionOnly(t)).filter(([f]) => !REBUILT_ONLY.includes(f))) : t])) },
});

// The stamp every write sets is compared as set or not: a write of projection-only fields moves it in
// queue.json and appends nothing (STAMPS). Every other field is compared by its value.
const STAMP_PATH = new RegExp(`^\\S+ (?:${STAMPS.join('|')})$`);
const leaf = (v, path) => (v != null && STAMP_PATH.test(path) ? `<set:${typeof v}>` : JSON.stringify(v));

// Queue `file`'s batch rebuilt from the log, and every ticket field where queue.json differs from it:
// { rebuilt, seeded, diffs: [{ path, rebuilt, queue }] }, each path "<ticket> <field>" (queue-fields.mjs).
// It holds the queue lock, as every writer does (waiting up to `waitMs`), so no write lands between
// reading queue.json and reading the log. With `seed`, a batch the log has never named is first seeded
// from queue.json, appended as `by`, and `seeded` counts its events. Throws when the queue or the log
// cannot be read, or the lock cannot be taken.
export function queueDifference(file, { seed = false, by, waitMs = 10_000 } = {}) {
  const { repoDir, batch } = ledgerTarget(file);
  const dir = `${file}.lock`;
  lock(dir, { waitMs, timeout: (pid) => new Error(`the queue is locked by pid ${pid ?? '?'} past the ${waitMs / 1000}s wait`) });
  try {
    const current = readQueueAt(file);
    if (!current) throw new Error(`no queue to compare at ${file}`);
    let state = fold(repoDir);
    let seeded = 0;
    if (seed && !own(state.batches, batch)) {
      const events = seedEvents(current, batch);
      if (events.length) { append(repoDir, events, { by }); state = fold(repoDir); seeded = events.length; }
    }
    const rebuilt = project(state, batch, current);
    const diffs = fieldDiffs(flattenQueue(comparable(rebuilt), { leaf }), flattenQueue(comparable(current), { leaf }))
      .map((d) => ({ path: d.path, rebuilt: d.a, queue: d.b }));
    return { rebuilt, seeded, diffs };
  } finally { unlock(dir); }
}

// The line a writer prints for a missed append, or null when there was none. It starts MISSED_PREFIX.
export const MISSED_PREFIX = 'ledger: 1 missed append';
export const missedLine = (r, file) => (r?.missed ? `${MISSED_PREFIX} for ${file}: ${r.why}. queue.json was written` : null);
// The environment variable naming the writer of a queue.mjs command run for another process, such as
// the pass: unset, the command names itself.
export const LEDGER_BY_ENV = 'DESK_LEDGER_BY';
