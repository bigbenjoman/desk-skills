// The ticket ledger: every change to a ticket or a batch as one typed event, in one append-only log per
// repo, <repo>/ledger/events.jsonl beside the standing queue (~/.claude/desk/repos/<slug>), from which any ticket's state and any batch's queue.json shape
// is rebuilt.
//
// Each line is an envelope {v, seq, id, at, batch, key, type, by, data}. seq is assigned under the
// ledger lock; id makes a retried append idempotent, because a fold skips an id it has already folded.
// An append is one write of all its lines and one fsync, under the ledger lock (ledger/.lock), which a
// writer takes after the queue lock, never before it, and waits for at most LOCK_WAIT_MS.
//
// Modes: in record mode append refuses an event that is illegal from its ticket's current state
// (TRANSITIONS) and writes nothing; in shadow mode it writes it, and read and fold report it.
//
// Once the live file holds SNAPSHOT_EVERY events, the folded state goes to ledger/snapshot.json and
// those events move to events.<seq>.jsonl.gz beside it; a fold is the snapshot plus the live file.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { lock, unlock } from './dir-lock.mjs';
import { STATES, FINISHED, PARK_KINDS } from './queue-states.mjs';
import { batchFields, keys as keysOf, same } from './queue-store.mjs';

export const SNAPSHOT_EVERY = 1000;
export const LOCK_WAIT_MS = 2000;
export const MODES = ['shadow', 'record'];
// Observations a pass recomputes on every run: written to queue.json, never appended, ignored by the diff.
export const PROJECTION_ONLY = ['log_bytes', 'idle_passes', 'pr_status', 'suite_wait_since', 'progress_sha', 'progress_at'];
export { PARK_KINDS };
export const ESCALATE_TO = ['person', 'repair', 'requeue'];
// How many of the latest event ids a fold keeps, so a retry that straddles a snapshot is still skipped.
const ID_WINDOW = 1000;

// A field's check: a name ending in ? also takes null, but the field must still be present.
const CHECKS = {
  string: (v) => typeof v === 'string' && v !== '',
  int: (v) => Number.isInteger(v) && v >= 0,
  list: (v) => Array.isArray(v),
  strings: (v) => Array.isArray(v) && v.length > 0 && v.every(CHECKS.string),
  object: (v) => v != null && typeof v === 'object' && !Array.isArray(v),
  sha: (v) => typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v),
  kind: (v) => PARK_KINDS.includes(v),
  escalate: (v) => ESCALATE_TO.includes(v),
};

// Every event type, the scope it belongs to (a ticket's, or a batch's with key null), and its data fields.
export const EVENTS = Object.freeze({
  seeded: { scope: 'ticket', data: { fields: 'object' } },
  admitted: { scope: 'ticket', data: {} },
  triaged: { scope: 'ticket', data: { questions: 'list' } },
  answered: { scope: 'ticket', data: { qid: 'string' } },
  spawned: { scope: 'ticket', data: { login: 'string?', port: 'int?', worker: 'string', round: 'int' } },
  parked: { scope: 'ticket', data: { kind: 'kind', question: 'string', approve: 'object?', since: 'string', deadline: 'string?' } },
  unparked: { scope: 'ticket', data: {} },
  held: { scope: 'ticket', data: { by: 'strings' } },
  released: { scope: 'ticket', data: { by: 'string' } },
  waiting: { scope: 'ticket', data: { on: 'string', since: 'string', deadline: 'string', escalate_to: 'escalate' } },
  waited: { scope: 'ticket', data: { on: 'string' } },
  pr_opened: { scope: 'ticket', data: { pr: 'int', head_sha: 'sha' } },
  automerge_armed: { scope: 'ticket', data: { by: 'string', pr: 'int', head_sha: 'sha' } },
  automerge_disarmed: { scope: 'ticket', data: { by: 'string', pr: 'int' } },
  merged: { scope: 'ticket', data: { by: 'string', pr: 'int', head_sha: 'sha', base: 'string' } },
  finished: { scope: 'ticket', data: { pr: 'int?' } },
  failed: { scope: 'ticket', data: { subtype: 'string' } },
  requeued: { scope: 'ticket', data: {} },
  moved: { scope: 'ticket', data: { from: 'string?', to: 'string?' } },
  archived: { scope: 'ticket', data: {} },
  legacy_set: { scope: 'ticket', data: { fields: 'object' } },
  base_red: { scope: 'batch', data: { check: 'string', since: 'string', deadline: 'string', merges: 'list' } },
  base_green: { scope: 'batch', data: {} },
  platform_outage: { scope: 'batch', data: { check: 'string', since: 'string', deadline: 'string' } },
  platform_clear: { scope: 'batch', data: {} },
});

const UNFINISHED = STATES.filter((s) => !FINISHED.includes(s));
const ANY = [null, ...STATES];
const KEEP = Symbol('unchanged');
// Which states each ticket event may come from, and the state it leaves (KEEP: unchanged). seeded and
// legacy_set leave the state their fields name; moved and archived leave it as it was.
export const TRANSITIONS = Object.freeze({
  admitted: { from: [null, ...FINISHED], to: 'queued' },
  triaged: { from: ['queued', 'triaged'], to: 'triaged' },
  spawned: { from: ['queued', 'triaged', 'parked'], to: 'running' },
  parked: { from: ['queued', 'triaged', 'running'], to: 'parked' },
  finished: { from: ['running', 'parked'], to: 'done' },
  failed: { from: ['running'], to: 'failed' },
  requeued: { from: ['parked', 'failed'], to: 'queued' },
  merged: { from: ['done'], to: 'done' },
  pr_opened: { from: ANY, to: KEEP },
  seeded: { from: ANY, to: KEEP },
  moved: { from: ANY, to: KEEP },
  archived: { from: ANY, to: KEEP },
  legacy_set: { from: ANY, to: KEEP },
  ...Object.fromEntries(['answered', 'waiting', 'waited', 'held', 'released', 'automerge_armed', 'automerge_disarmed', 'unparked']
    .map((t) => [t, { from: UNFINISHED, to: KEEP }])),
});

export const ledgerPaths = (repoDir) => {
  const dir = join(repoDir, 'ledger');
  return { dir, events: join(dir, 'events.jsonl'), lock: join(dir, '.lock'), snapshot: join(dir, 'snapshot.json') };
};

// Why event `ev` (as given to append: type, batch, key, data, and optionally id and at) is malformed,
// naming its type and the field, or null when it is well formed.
export function invalid(ev) {
  if (ev == null || typeof ev !== 'object') return 'an event must be an object';
  const spec = EVENTS[ev.type];
  if (!spec) return `unknown event type "${ev.type}" (want: ${Object.keys(EVENTS).join('|')})`;
  if (!(ev.batch === null || CHECKS.string(ev.batch))) return `${ev.type}: field "batch" must be a batch name or null`;
  if (spec.scope === 'ticket' && !CHECKS.string(ev.key)) return `${ev.type}: field "key" is required (a ticket key)`;
  if (spec.scope === 'batch' && ev.key != null) return `${ev.type}: field "key" must be null (a batch event)`;
  if (ev.id !== undefined && !CHECKS.string(ev.id)) return `${ev.type}: field "id" must be a non-empty string`;
  if (ev.at !== undefined && !CHECKS.string(ev.at)) return `${ev.type}: field "at" must be an ISO time`;
  const data = ev.data ?? {};
  if (!CHECKS.object(data)) return `${ev.type}: field "data" must be an object`;
  for (const [f, check] of Object.entries(spec.data)) {
    const nullable = check.endsWith('?');
    if (!(f in data)) return `${ev.type}: required field "${f}" is missing`;
    if (nullable && data[f] === null) continue;
    if (!CHECKS[check.replace(/\?$/, '')](data[f])) return `${ev.type}: field "${f}" is not a valid ${check.replace(/\?$/, '')}`;
  }
  return null;
}

// --- the reducer ---

export const emptyState = () => ({ v: 1, seq: 0, tickets: {}, batches: {}, ids: [] });
const newTicket = (key) => ({ key, batch: null, state: null, archived: false, fields: {}, park: null, holds: [], pr: null, merge: null,
  questions: [], answered: [], waits: {}, automerge: null, spawn: null });
// The queue.json field holding the triage questions answered so far, each an answered event's qid.
export const ANSWERED = 'answered_questions';
export const withoutProjectionOnly = (fields) => Object.fromEntries(Object.entries(fields ?? {}).filter(([f]) => !PROJECTION_ONLY.includes(f)));

// Lays queue.json fields onto ticket `t`: the fields with a typed home (state, park, held_by, result.pr,
// merge) go there too, so a typed event and a field set agree on one value.
function overlay(t, fields) {
  const f = withoutProjectionOnly(fields);
  Object.assign(t.fields, f);
  if (STATES.includes(f.state)) t.state = f.state;
  if ('park' in f) t.park = f.park ?? null;
  if ('held_by' in f) t.holds = keysOf(f.held_by);
  if ('result' in f) t.pr = f.result?.pr ?? null;
  if ('merge' in f) t.merge = f.merge ?? null;
  if (ANSWERED in f) t.answered = Array.isArray(f[ANSWERED]) ? [...f[ANSWERED]] : [];
}

// Whether `ev` is legal from its ticket's state in `state`: { legal, from }. Batch events always are.
export function legality(state, ev) {
  if (EVENTS[ev.type]?.scope !== 'ticket') return { legal: true, from: null };
  const from = state.tickets[ev.key]?.state ?? null;
  return { legal: TRANSITIONS[ev.type].from.includes(from), from };
}

// The park a parked event leaves: its data, which is the whole park record, less a typed field it
// carries as null because that park has none (an approval, a deadline).
const PARK_NULLABLE = Object.entries(EVENTS.parked.data).filter(([, c]) => c.endsWith('?')).map(([f]) => f);
export const parkOf = (d) => Object.fromEntries(Object.entries(d ?? {}).filter(([f, v]) => !(v == null && PARK_NULLABLE.includes(f))));

// Applies one envelope to `state` in place. An illegal transition is applied all the same: in shadow
// mode the queue write it records has already happened. Every batch an event names gets an entry in
// `state.batches`, so a batch with none has never been written to the log.
function apply(state, ev) {
  const d = ev.data ?? {};
  const b = (state.batches[ev.batch ?? ''] ??= {});
  if (EVENTS[ev.type].scope === 'batch') {
    if (ev.type === 'base_red') b.base_red = { ...d };
    else if (ev.type === 'base_green') delete b.base_red;
    else if (ev.type === 'platform_outage') b.platform_outage = { ...d };
    else if (ev.type === 'platform_clear') delete b.platform_outage;
    return;
  }
  const t = (state.tickets[ev.key] ??= newTicket(ev.key));
  if (ev.type !== 'moved') t.batch = ev.batch;
  const to = TRANSITIONS[ev.type].to;
  if (to !== KEEP) t.state = to;
  switch (ev.type) {
    case 'seeded': Object.assign(t, newTicket(ev.key), { batch: ev.batch }); overlay(t, d.fields); break;
    case 'legacy_set': overlay(t, d.fields); break;
    case 'admitted': t.archived = false; t.park = null; break;
    case 'triaged': t.questions = [...d.questions]; break;
    case 'answered': t.answered.push(d.qid); break;
    case 'spawned': t.spawn = { ...d }; t.park = null; break;
    case 'parked': t.park = parkOf(d); break;
    case 'unparked': case 'requeued': t.park = null; break;
    case 'held': t.holds = [...new Set([...t.holds, ...d.by])]; break;
    case 'released': t.holds = t.holds.filter((k) => k !== d.by); break;
    case 'waiting': t.waits[d.on] = { ...d }; break;
    case 'waited': delete t.waits[d.on]; break;
    case 'pr_opened': t.pr = d.pr; break;
    case 'automerge_armed': t.automerge = { ...d }; break;
    case 'automerge_disarmed': t.automerge = null; break;
    case 'merged': t.merge = { ...d, at: ev.at }; t.automerge = null; break;
    case 'finished': t.park = null; if (d.pr != null) t.pr = d.pr; break;
    case 'moved': t.batch = d.to; break;
    case 'archived': t.archived = true; break;
    default: break;
  }
}

// Folds envelopes `events`, oldest first, onto `base` (a snapshot's state, else empty), into a new
// state. An id already folded is skipped, as is a seq at or below base's. onIllegal(ev, from) hears
// each illegal transition.
export function reduce(events, base = null, { onIllegal = () => {} } = {}) {
  const state = structuredClone(base ?? emptyState());
  const seen = new Set(state.ids);
  const ids = [...state.ids];
  for (const ev of events) {
    if (ev.seq <= state.seq) continue;
    state.seq = ev.seq; // a skipped retry still takes its seq, so the next append numbers past it
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    ids.push(ev.id);
    const { legal, from } = legality(state, ev);
    if (!legal) onIllegal(ev, from);
    apply(state, ev);
  }
  state.ids = ids.slice(-ID_WINDOW);
  return state;
}

// Batch `batch`'s queue.json shape from a folded state: each live ticket, in the order the log first
// named it, with its fields, its state, park, holds as a list, PR and merge record. Archived tickets
// and those moved to another batch are left out. No event records the batch's own fields
// (concurrency, base, …), so they are carried over from `current`, the queue.json on disk, as a
// rebuild carries the projection-only fields.
export function project(state, batch, current = null) {
  const tickets = {};
  for (const t of Object.values(state.tickets)) {
    if (t.batch !== batch || t.archived) continue;
    const out = { ...t.fields, key: t.key, state: t.state, holds: [...t.holds] };
    if (t.park != null || 'park' in t.fields) out.park = t.park;
    // Unheld is null, as every writer that releases a hold leaves it.
    if (t.holds.length || 'held_by' in t.fields) out.held_by = t.holds.length ? t.holds.join('|') : null;
    if (t.pr != null) out.result = { ...(t.fields.result ?? {}), pr: t.pr };
    if (t.merge) { out.merge = { ...t.merge }; out.merged_at = t.merge.at ?? t.fields.merged_at; }
    if (t.answered.length) out[ANSWERED] = [...t.answered];
    tickets[t.key] = out;
  }
  return { ...batchFields(current), batch, tickets };
}

// Every field that differs between queues `before` and `after`: { ticket (null for a batch field),
// field, before, after }. Projection-only fields and the file's version are not compared.
export function diffQueues(before, after) {
  const out = [];
  const fieldsOf = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
    .filter((f) => !PROJECTION_ONLY.includes(f));
  const cmp = (ticket, a, b) => {
    for (const field of fieldsOf(a, b)) if (!same(a?.[field], b?.[field])) out.push({ ticket, field, before: a?.[field], after: b?.[field] });
  };
  cmp(null, batchFields(before), batchFields(after));
  const bt = before?.tickets ?? {}; const at = after?.tickets ?? {};
  for (const k of new Set([...Object.keys(bt), ...Object.keys(at)])) cmp(k, bt[k], at[k]);
  return out;
}

// --- the log on disk ---

// A file's lines as envelopes, with any line that does not parse as one listed in `torn`.
function parseLines(text, file, torn) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let ev = null;
    try { ev = JSON.parse(line); } catch { /* listed below */ }
    if (ev && Number.isInteger(ev.seq) && EVENTS[ev.type]) out.push(ev);
    else torn.push({ file: basename(file), line: i + 1, text: line.slice(0, 200) });
  });
  return out;
}

// The snapshot's state: null when there is none, false when it does not read as one, so the reader
// replays from the start instead.
const readSnapshot = (paths) => {
  if (!existsSync(paths.snapshot)) return null;
  try {
    const s = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
    return s?.state && Number.isInteger(s.state.seq) ? s.state : false;
  } catch { return false; }
};
const rotated = (paths) => (existsSync(paths.dir) ? readdirSync(paths.dir) : [])
  .map((f) => /^events\.(\d+)\.jsonl\.gz$/.exec(f)).filter(Boolean)
  .map((m) => ({ file: join(paths.dir, m[0]), seq: Number(m[1]) })).sort((a, b) => a.seq - b.seq);
const liveText = (paths) => (existsSync(paths.events) ? readFileSync(paths.events, 'utf8') : '');

// The log as { base, events, torn, gaps }: base the snapshot's state (null when reading from the
// start), events every whole envelope after it in seq order, torn every line that did not parse, gaps
// every break in the seq run ({ after, next }). With `since`, it reads from the start when the
// snapshot is past that seq. Readers take no lock, so the live file is read before the snapshot and
// the archives: a rotation in between only adds a snapshot or archive covering lines already read.
function load(paths, { since } = {}) {
  const live = liveText(paths);
  const snap = readSnapshot(paths);
  const fromStart = snap === false || (since !== undefined && (!snap || since < snap.seq));
  const base = fromStart ? null : snap;
  const torn = [];
  const files = fromStart ? rotated(paths).map((r) => ({ file: r.file, text: gunzipSync(readFileSync(r.file)).toString('utf8') })) : [];
  files.push({ file: paths.events, text: live });
  let last = base?.seq ?? 0;
  const events = [];
  const gaps = [];
  for (const { file, text } of files) {
    for (const ev of parseLines(text, file, torn)) {
      if (ev.seq <= last) continue; // a line a crashed rotation left in both files
      if (ev.seq !== last + 1) gaps.push({ after: last, next: ev.seq });
      events.push(ev);
      last = ev.seq;
    }
  }
  return { base, events, torn, gaps };
}

// The events of the log, oldest first: { events, torn, gaps, illegal }. With `batch`, only that
// batch's; with `since`, only those after that seq (from the snapshot on, unless since is before it).
// illegal lists each event read that was an illegal transition, as { seq, id, batch, key, type, from }.
export function read(repoDir, { batch, since = 0 } = {}) {
  const { base, events, torn, gaps } = load(ledgerPaths(repoDir), { since });
  const illegal = [];
  reduce(events, base, { onIllegal: (ev, from) => illegal.push({ seq: ev.seq, id: ev.id, batch: ev.batch, key: ev.key, type: ev.type, from }) });
  const keep = (ev) => ev.seq > since && (batch === undefined || ev.batch === batch);
  return { events: events.filter(keep), torn, gaps, illegal: illegal.filter(keep) };
}

// The state the log folds to: the snapshot plus every event after it.
export function fold(repoDir) {
  const { base, events } = load(ledgerPaths(repoDir));
  return reduce(events, base);
}

const byOf = (by) => (by && typeof by === 'object' ? by : { proc: by ?? basename(process.argv[1] ?? 'node'), pid: process.pid });

// Appends `events` (each { type, batch, key, data } and optionally id and at) to repo `repoDir`'s log
// as one write and one fsync, under the ledger lock. Every event is checked first: a malformed one, or
// in record mode an illegal transition, throws naming it and writes nothing. `by` names the writer.
// -> the envelopes written.
export function append(repoDir, events, { mode = 'shadow', by, now = () => new Date().toISOString(), waitMs = LOCK_WAIT_MS, snapshotEvery = SNAPSHOT_EVERY } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown ledger mode "${mode}" (want: ${MODES.join('|')})`);
  const list = Array.isArray(events) ? events : [events];
  for (const ev of list) { const why = invalid(ev); if (why) throw new Error(`refused, nothing written: ${why}`); }
  if (!list.length) return [];
  const paths = ledgerPaths(repoDir);
  mkdirSync(paths.dir, { recursive: true });
  lock(paths.lock, { waitMs });
  try {
    const { base, events: tail } = load(paths);
    const state = reduce(tail, base);
    const writer = byOf(by);
    const seen = new Set(state.ids);
    const out = list.map((ev, i) => ({ v: 1, seq: state.seq + i + 1, id: ev.id ?? randomUUID(), at: ev.at ?? now(),
      batch: ev.batch, key: ev.key ?? null, type: ev.type, by: writer, data: ev.data ?? {} }));
    if (mode === 'record') {
      const work = structuredClone(state);
      for (const ev of out) {
        if (seen.has(ev.id)) continue;
        const { legal, from } = legality(work, ev);
        if (!legal) throw new Error(`refused, nothing written: ${ev.type} for ${ev.key} is illegal from its current state ${from ?? '(none: no event yet)'} (allowed from: ${TRANSITIONS[ev.type].from.map((s) => s ?? 'none').join('|')})`);
        apply(work, ev);
        seen.add(ev.id);
      }
    }
    const text = liveText(paths);
    // A line cut off mid-write stays a line of its own, never the start of the next one.
    const lead = text && !text.endsWith('\n') ? '\n' : '';
    const fd = openSync(paths.events, 'a');
    try {
      writeAll(fd, lead + out.map((ev) => `${JSON.stringify(ev)}\n`).join(''));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (tail.length + out.length >= snapshotEvery) snapshot(paths);
    return out;
  } finally { unlock(paths.lock); }
}

// Writes all of `data` to `fd`: one writeSync may take only part of it.
function writeAll(fd, data) {
  const buf = Buffer.from(data);
  for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off);
}

// Writes `data` to `file` through a temporary file fsynced before the rename, so a power cut leaves
// the old file or the whole new one.
function writeDurable(file, data) {
  const fd = openSync(`${file}.tmp`, 'w');
  try { writeAll(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${file}.tmp`, file);
}
const syncDir = (dir) => { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

// Folds the log into snapshot.json and moves the events it holds to events.<seq>.jsonl.gz, with the
// ledger lock held. Each step leaves a log that folds the same if the next never happens, a power cut
// included: the archive is written first, the snapshot second, both reach the disk, and the live
// file is emptied last. Its rename reaches the disk before the lock is released, so no later append
// lands in a file a power cut could swap back for the old one.
function snapshot(paths) {
  const { base, events } = load(paths);
  if (!events.length) return;
  const state = reduce(events, base);
  writeDurable(join(paths.dir, `events.${state.seq}.jsonl.gz`), gzipSync(events.map((ev) => `${JSON.stringify(ev)}\n`).join('')));
  writeDurable(paths.snapshot, `${JSON.stringify({ v: 1, at: new Date().toISOString(), state }, null, 2)}\n`);
  syncDir(paths.dir);
  writeDurable(paths.events, '');
  syncDir(paths.dir);
}
