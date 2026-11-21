// The ledger lever's shadow appends: what one queue write changed, as ticket-ledger events.
//
// With the ledger lever on, every queue write (queue-store.mjs writeQueueFile) appends the difference
// between the queue on disk before it and the queue it wrote: per ticket, a typed event for a change
// of state and one legacy_set for every other field changed with it. It records what queue.json kept,
// never the changes a writer asked for. A ticket leaving the queue is archived, or moved out of the
// batch; one arriving with a moved_from record is moved in. The first write the lever sees for a batch
// the log has never named first seeds one event per ticket from the queue as it stood.
//
// queue.json is written first and the log second, and a failed append never fails the queue write: it
// comes back as one missed append for the writer to report.
import { basename, dirname } from 'node:path';
import { BATCHES_DIR, leverOn } from './desk-env.mjs';
import { append, fold, invalid, diffQueues, withoutProjectionOnly, PARK_KINDS, TRANSITIONS } from './ticket-ledger.mjs';

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
    case 'parked': {
      const p = now.park ?? {};
      return { type: 'parked', data: { kind: PARK_KINDS.includes(p.kind) ? p.kind : 'question', question: text(p.question), approve: p.approve && typeof p.approve === 'object' ? p.approve : null, since: text(p.since) ?? at, deadline: text(p.deadline) } };
    }
    case 'done': return { type: 'finished', data: { pr: count(now.result?.pr) } };
    case 'failed': return { type: 'failed', data: { subtype: text(now.failed?.subtype) ?? 'unknown' } };
    default: return null;
  }
}

// The typed events for ticket `now` reaching its state from `was` (undefined for a ticket new here), in
// order. A ticket new to the queue is admitted first, which also brings back one the log holds as
// archived; one taken from a park or a failure back to triage is requeued first. Each must be a legal
// transition from the state the one before it left (ticket-ledger.mjs TRANSITIONS), or there are none
// and the state is recorded with the other fields: the pass also sets states no typed event reaches,
// such as a running ticket back to triaged.
function stateEvents(was, now, at) {
  const start = was?.state ?? null;
  const steps = [];
  if (was === undefined && now.state !== 'queued') steps.push({ type: 'admitted', data: {} });
  else if (['parked', 'failed'].includes(start) && now.state === 'triaged') steps.push({ type: 'requeued', data: {} });
  const last = stateEvent(steps.length ? 'queued' : start, now, at);
  if (!last) return [];
  steps.push(last);
  let from = start;
  for (const s of steps) {
    if (!TRANSITIONS[s.type].from.includes(from)) return [];
    from = TRANSITIONS[s.type].to;
  }
  return steps;
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
        const typed = stateEvents(was, now, at);
        if (typed.length && typed.every((e) => !invalid({ ...e, batch, key }))) {
          for (const e of typed) ev(key, e.type, e.data);
          delete fields.state;
        }
      }
      if (Object.keys(fields).length) ev(key, 'legacy_set', { fields });
    }
    if (own(archived, key)) ev(key, 'archived', {});
  }
  return out;
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

// The line a writer prints for a missed append, or null when there was none. It starts MISSED_PREFIX.
export const MISSED_PREFIX = 'ledger: 1 missed append';
export const missedLine = (r, file) => (r?.missed ? `${MISSED_PREFIX} for ${file}: ${r.why}. queue.json was written` : null);
// The environment variable naming the writer of a queue.mjs command run for another process, such as
// the pass: unset, the command names itself.
export const LEDGER_BY_ENV = 'DESK_LEDGER_BY';
