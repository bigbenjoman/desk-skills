// The ledger lever's shadow appends: what one queue write changed, as ticket-ledger events.
//
// With the ledger lever on, every queue write (queue-store.mjs writeQueueFile) appends the difference
// between the queue on disk before it and the queue it wrote: per ticket, a typed event for a change
// of state, a held or released event for each blocker added or lifted, and one legacy_set for every
// other field changed with it, and for the batch, its red base starting or clearing (base_red,
// base_green) and its platform outage starting or clearing (platform_outage, platform_clear). It
// records what queue.json kept, never the changes a writer asked for. A ticket leaving the queue is
// archived, or moved out of the
// batch; one arriving with a moved_from record is moved in. The first write the lever sees for a batch
// the log has never named first seeds one event per ticket from the queue as it stood.
//
// queue.json is written first and the log second, and a failed append never fails the queue write: it
// comes back as one missed append for the writer to report.
//
// With the ledger-record lever on as well (record mode), the log is written first: an append that is
// an illegal transition refuses the write, and neither changes. queue.json then records, as
// `ledger_seq`, the log's seq it holds its batch's events up to, so a pass finding later events of its
// batch, or no queue.json at all, restores it from the log (restoreQueue). A failed append still
// leaves queue.json written, as one missed append.
//
// queueDifference rebuilds a batch's queue from the log and names each ticket field where queue.json
// differs from it: the pass reports that after its writes, and `queue.mjs rebuild` writes the rebuild out.
import { basename, dirname } from 'node:path';
import { BATCHES_DIR, leverOn, levers } from './desk-env.mjs';
import { append, fold, read, invalid, diffQueues, project, withoutProjectionOnly, parkOf, waitsOfField, ANSWERED, WAITS, PARK_KINDS, PROJECTION_ONLY, TRANSITIONS, ILLEGAL } from './ticket-ledger.mjs';
import { fieldDiffs, flattenQueue } from './queue-fields.mjs';
import { readQueueAt, same, versionOf, batchFields } from './queue-store.mjs';
import { FINISHED, blockersOf } from './queue-states.mjs';
import { parkKindOf } from './batch-state.mjs';
import { lock, unlock, writeJsonAtomic } from './dir-lock.mjs';

// What the log calls the standing batch, as `queue.mjs transfer <TICKET> standing` does.
export const STANDING = 'standing';
// Fields every write stamps: appended with the fields they were written with, never on their own, so
// a write that changed only projection-only fields appends nothing.
export const STAMPS = ['updated_at'];

// Whether the ledger lever is on. A config that cannot be read is off: the side that changes nothing.
export function ledgerOn() {
  try { return leverOn('ledger'); } catch { return false; }
}

// Record mode: { on, ignored }. The ledger-record lever has an effect only with the ledger lever on;
// alone it is `ignored`. A config that cannot be read is neither.
export const RECORD_LEVER = 'ledger-record';
export function recordMode() {
  try {
    const l = levers();
    const rec = l.on.includes(RECORD_LEVER);
    const ledger = l.on.includes('ledger');
    return { on: rec && ledger, ignored: rec && !ledger };
  } catch { return { on: false, ignored: false }; }
}
export const recordOn = () => recordMode().on;

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
    case 'done': return { type: 'finished', data: { pr: count(now.result?.pr), fields: null } };
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
// With `strict` (record mode), a done ticket started running without a requeue throws, naming the
// ticket's state and the event, rather than being recorded as the field.
function stateEvents(was, now, at, { strict = false, key } = {}) {
  const start = was?.state ?? null;
  const steps = [];
  if (was === undefined && now.state !== 'queued') steps.push({ type: 'admitted', data: {} });
  else if (['parked', 'failed'].includes(start) && now.state === 'triaged') steps.push({ type: 'requeued', data: {} });
  const last = stateEvent(steps.length ? 'queued' : start, now, at);
  if (last) steps.push(last);
  if (strict && start === 'done' && last?.type === 'spawned') {
    throw Object.assign(new Error(`refused, nothing written: spawned for ${key} is illegal from its current state done (allowed from: ${TRANSITIONS.spawned.from.join('|')}): requeue it first`), { code: ILLEGAL });
  }
  const events = [];
  let from = start;
  for (const s of steps) {
    if (!TRANSITIONS[s.type].from.includes(from)) break;
    events.push(s);
    from = TRANSITIONS[s.type].to;
  }
  return { events, reached: !!last && events.length === steps.length, to: from };
}
// The typed events whose replay clears a ticket's park (ticket-ledger.mjs apply).
const CLEARS_PARK = ['admitted', 'requeued', 'spawned', 'finished', 'unparked'];

// The fields a ticket is recorded done with (batch-state.mjs doneOnPr, and the branch queue.mjs finish
// sets where the ticket had none): written with a finished event, they go in its data, never a legacy_set.
export const DONE_FIELDS = ['park', 'result', 'draft_pr', 'handoff_stage', 'branch'];

// The done fields among `fields`, taken out of them into finished event `e`.
function doneFields(e, fields) {
  const picked = Object.fromEntries(DONE_FIELDS.filter((f) => own(fields, f)).map((f) => [f, fields[f]]));
  if (!Object.keys(picked).length) return;
  e.data.fields = picked;
  for (const f of Object.keys(picked)) delete fields[f];
}

// The merged event for ticket `now`, whose state after this write's state events is `from`, when its
// merge record (queue.mjs merged) changed in `fields` and names who merged which PR at which head onto
// which base: dated the merge's own time, and taken out of `fields` with merged_at where the event's
// replay leaves it as queue.json keeps it (a first merge). A record missing any of them (a merge recorded
// with no PR, by an older caller) is recorded as the field. -> the event, or null.
function mergedEvent(was, now, fields, from, { batch, key }) {
  const m = now.merge;
  if (!own(fields, 'merge') || from !== 'done' || !m || typeof m !== 'object' || !text(m.at)) return null;
  const e = { type: 'merged', batch, key, data: { by: m.by, pr: m.pr, head_sha: m.head_sha, base: m.base }, at: m.at };
  if (invalid(e) || Object.keys(m).some((f) => !own(e.data, f) && f !== 'at')) return null;
  delete fields.merge;
  if (own(fields, 'merged_at') && was?.merged_at == null && same(now.merged_at, m.at)) delete fields.merged_at;
  return e;
}

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

// The blockers ticket `was` gained and lost in becoming `now`, each a held or released event, taken out
// of the fields `fields` records with it, when the ticket's state `from` (after its state events) allows
// them. A change their replay would not leave as queue.json keeps it (blockers reordered or repeated, a
// held_by not written as its blockers joined, or null once none is left) is recorded as the field. A
// ticket new to this queue arrives with no blockers but those `logged` names, the ones the log still
// holds for it (null when unread): with none there, its blockers are a held event; with any, or unread,
// they are the field, which alone replaces those the log kept from its last stay.
function holdEvents(was, now, fields, from, logged) {
  if (!own(fields, 'held_by') || !TRANSITIONS.held.from.includes(from)) return [];
  if (was === undefined && (!Array.isArray(logged) || logged.length)) return [];
  const before = was === undefined ? [] : blockersOf(was);
  const after = blockersOf(now);
  const added = after.filter((k) => !before.includes(k));
  const removed = before.filter((k) => !after.includes(k));
  const kept = before.filter((k) => after.includes(k));
  if (!added.length && !removed.length) return [];
  if ([before, after].some((l) => new Set(l).size !== l.length) || !same([...kept, ...added], after)) return [];
  if (now.held_by !== (after.length ? after.join('|') : null)) return [];
  delete fields.held_by;
  return [...(added.length ? [{ type: 'held', data: { by: added } }] : []), ...removed.map((by) => ({ type: 'released', data: { by } }))];
}

// The events queue `before` (the file as it stood, or null) becoming queue `after` records in `batch`.
// `archived` holds each ticket this write moved to the archive, as it was archived. `elsewhere(key)`
// says the log already has that ticket in another batch, so its leaving this one records nothing.
// `logged(key)` is the blockers the log holds for that ticket, or null when the log was not read.
// `strict` is record mode (stateEvents).
export function queueEvents(before, after, { batch, archived = {}, elsewhere = () => false, logged = () => null, at = new Date().toISOString(), strict = false } = {}) {
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
    // holds is held_by as a list, which the log keeps as the ticket's holds: never a field of its own.
    const diffs = (changed.get(key) ?? []).filter((d) => d.field !== 'holds');
    if (diffs.some((d) => !STAMPS.includes(d.field))) {
      const fields = Object.fromEntries(diffs.map((d) => [d.field, d.after === undefined ? null : d.after]));
      // The state the ticket's hold events apply from, undefined for a ticket moved in from another batch.
      let from = was?.state ?? null;
      if (was === undefined && now.moved_from && typeof now.moved_from === 'object') {
        ev(key, 'moved', { from: text(now.moved_from.batch) ?? STANDING, to: batch });
        from = undefined;
      } else if (own(fields, 'state')) {
        const { events: typed, reached, to } = stateEvents(was, now, at, { strict, key });
        if (typed.length && typed.every((e) => !invalid({ ...e, batch, key }))) {
          from = to;
          if (reached) delete fields.state;
          // A park the queue keeps is laid back over one an event's replay cleared, and one a parked
          // event's replay leaves as it is needs no field of its own.
          const parked = typed.findLast((e) => e.type === 'parked');
          if (parked && same(parkOf(parked.data), now.park)) delete fields.park;
          else if (now.park != null && typed.some((e) => CLEARS_PARK.includes(e.type))) fields.park = now.park;
          const finished = typed.find((e) => e.type === 'finished');
          if (finished) doneFields(finished, fields);
          for (const e of typed) ev(key, e.type, e.data);
        }
      }
      for (const e of holdEvents(was, now, fields, from, was === undefined ? logged(key) : null)) ev(key, e.type, e.data);
      for (const qid of newlyAnswered(was, now, fields)) ev(key, 'answered', { qid });
      for (const e of waitEvents(was, now, fields)) ev(key, e.type, e.data);
      const merged = mergedEvent(was, now, fields, from, { batch, key });
      if (merged) out.push(merged);
      if (Object.keys(fields).length) ev(key, 'legacy_set', { fields });
    }
    if (own(archived, key)) ev(key, 'archived', {});
  }
  for (const c of BATCH_SPELLS) for (const e of spellEvents(before, after, c)) ev(null, e.type, e.data);
  return out;
}

// The batch's conditions kept as one queue field each, a spell at a time, as each writer records it:
// its red base (`base_red`, pass/base-gate.mjs decideBaseRed) and its platform outage
// (`platform_outage`, pass/fix-tries.mjs decideOutage). `same`: the spell `before` held is the one now.
const BATCH_SPELLS = [
  { field: 'base_red', start: 'base_red', clear: 'base_green', same: (a, b) => a.branch === b.branch && a.since === b.since,
    data: (r) => ({ check: r.check, since: r.since, deadline: r.deadline, merges: r.merges }) },
  { field: 'platform_outage', start: 'platform_outage', clear: 'platform_clear', same: (a, b) => a.since === b.since,
    data: (r) => ({ check: r.check, since: r.since, deadline: r.deadline }) },
];

// A batch condition starting or clearing in this write: one start event as a spell is first recorded,
// one clear as it is cleared. A change to the same spell's record (its escalation, the checks it
// names) appends nothing.
function spellEvents(before, after, { field, start, clear, same, data }) {
  const was = before?.[field] ?? null;
  const now = after?.[field] ?? null;
  if (was && !now) return [{ type: clear, data: {} }];
  if (!now || typeof now !== 'object' || (was && same(was, now))) return [];
  const e = { type: start, data: data(now) };
  return invalid({ ...e, batch: STANDING, key: null }) ? [] : [e];
}

// One seeded event per ticket of queue `q` (the file as it stood) in `batch`, but for any in `skip`.
export const seedEvents = (q, batch, skip = new Set(), at = new Date().toISOString()) => Object.keys(q?.tickets ?? {})
  .filter((k) => !skip.has(k))
  .map((key) => ({ type: 'seeded', batch, key, data: { fields: withoutProjectionOnly(q.tickets[key]) }, at }));

// Appends, in one append call, what the write of `after` over `before` to queue `file` changed, seeding
// the batch `before` belongs to first when the log has never named it. `from` is that batch when it is
// not the one `file` holds: a whole queue moved here from another batch (move-batch), each of whose
// tickets gets a moved event naming both. -> { appended, legacy } or, when the append failed,
// { appended: 0, missed: 1, why }. Never throws.
// With `mode: 'record'` it is called before queue.json is written: an illegal transition comes back
// as { appended: 0, refused: true, why } with nothing appended, and the result also carries `seq`,
// the `ledger_seq` the write records: the log's seq after the append, or `before`'s own where the
// log already held events of this batch past it, which a restore still owes queue.json.
export function recordWrite(file, before, after, { by, archived = {}, from = null, mode = 'shadow' } = {}) {
  const strict = mode === 'record';
  try {
    const { repoDir, batch } = ledgerTarget(file);
    const state = fold(repoDir);
    const since = Number.isInteger(before?.ledger_seq) ? before.ledger_seq : null;
    const behind = strict && since != null && read(repoDir, { batch, since }).events.length > 0;
    const elsewhere = (k) => own(state.tickets, k) && state.tickets[k].batch !== batch;
    const at = new Date().toISOString();
    const events = [];
    const leaving = Object.keys(before?.tickets ?? {}).filter((k) => !own(after?.tickets, k) && !own(archived, k) && elsewhere(k));
    const seedAs = from ?? batch;
    if (!own(state.batches, seedAs)) events.push(...seedEvents(before, seedAs, new Set(leaving), at));
    if (from) {
      for (const key of Object.keys(after?.tickets ?? {})) if (own(before?.tickets, key)) events.push({ type: 'moved', batch, key, data: { from, to: batch }, at });
    }
    const logged = (k) => (own(state.tickets, k) ? state.tickets[k].holds ?? null : []);
    events.push(...queueEvents(before, after, { batch, archived, elsewhere, logged, at, strict }));
    const legacy = events.filter((e) => e.type === 'legacy_set').length;
    if (!events.length) return { appended: 0, legacy, ...(strict ? { seq: behind ? since : state.seq } : {}) };
    const out = append(repoDir, events, { by, mode });
    return { appended: events.length, legacy, ...(strict ? { seq: behind ? since : out.at(-1).seq } : {}) };
  } catch (e) {
    const why = String(e?.message ?? e).split('\n')[0];
    if (strict && e?.code === ILLEGAL) return { appended: 0, refused: true, why };
    return { appended: 0, missed: 1, why };
  }
}

// A ticket's `holds` is its held_by as a list, which a queue written before the lever was on lacks:
// held_by is compared instead.
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

// Queue `current` with its tickets as `rebuilt` (the log's projection) has them: in current's order,
// tickets new to the log after them, each keeping the projection-only fields current has for it.
function restoredFrom(current, rebuilt) {
  const ct = current.tickets ?? {};
  const rt = rebuilt.tickets;
  const order = [...Object.keys(ct).filter((k) => own(rt, k)), ...Object.keys(rt).filter((k) => !own(ct, k))];
  const kept = (t) => Object.fromEntries(PROJECTION_ONLY.filter((f) => own(t, f)).map((f) => [f, t[f]]));
  return { ...batchFields(current), tickets: Object.fromEntries(order.map((k) => [k, { ...rt[k], ...kept(ct[k]) }])) };
}

// A rebuilt ticket's `holds`, which a writer lays only beside a held_by (queue-states.mjs holdsLaid).
function tidyHolds(q) {
  for (const t of Object.values(q.tickets)) if (!own(t, 'held_by')) delete t.holds;
  return q;
}

// Record mode's restore of queue `file` from the log, under the queue lock (waiting up to `waitMs`):
// rebuilt whole when it is missing or does not read and the log has its batch, or, when it records a
// `ledger_seq` and the log holds events of its batch past it (a write the log took and queue.json
// never did), brought up to the log. A queue with no ledger_seq was written before record mode and is
// left as it is. -> { restored: null | 'missing' | 'behind', tickets, seq }, `tickets` naming each
// ticket the restore changed. Throws when the log cannot be read or the lock cannot be taken.
export function restoreQueue(file, { waitMs = 10_000 } = {}) {
  const { repoDir, batch } = ledgerTarget(file);
  const dir = `${file}.lock`;
  lock(dir, { waitMs, timeout: (pid) => new Error(`the queue is locked by pid ${pid ?? '?'} past the ${waitMs / 1000}s wait`) });
  try {
    const current = readQueueAt(file);
    const since = Number.isInteger(current?.ledger_seq) ? current.ledger_seq : null;
    const none = (seq) => ({ restored: null, tickets: [], seq });
    if (current && since == null) return none(null);
    if (current && !read(repoDir, { batch, since }).events.length) return none(since);
    const state = fold(repoDir);
    if (!own(state.batches, batch)) return none(since);
    const rebuilt = project(state, batch, current);
    const out = tidyHolds(current ? restoredFrom(current, rebuilt) : { version: 0, ...rebuilt });
    const was = current?.tickets ?? {};
    const tickets = [...new Set([...Object.keys(was), ...Object.keys(out.tickets)])].filter((k) => !same(was[k], out.tickets[k]));
    out.ledger_seq = state.seq;
    out.version = versionOf(current) + 1;
    writeJsonAtomic(file, out);
    return { restored: current ? 'behind' : 'missing', tickets, seq: state.seq };
  } finally { unlock(dir); }
}

// The line a writer prints for a missed append, or null when there was none. It starts MISSED_PREFIX.
export const MISSED_PREFIX = 'ledger: 1 missed append';
export const missedLine = (r, file) => (r?.missed ? `${MISSED_PREFIX} for ${file}: ${r.why}. queue.json was written` : null);
// The environment variable naming the writer of a queue.mjs command run for another process, such as
// the pass: unset, the command names itself.
export const LEDGER_BY_ENV = 'DESK_LEDGER_BY';
