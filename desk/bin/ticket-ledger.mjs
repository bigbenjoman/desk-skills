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
import { STATES, FINISHED, PARK_KINDS, blockersOf } from './queue-states.mjs';
import { batchFields, same } from './queue-store.mjs';

export const SNAPSHOT_EVERY = 1000;
// The fold rules a snapshot's state was folded under. Raise it whenever apply() folds an event
// differently, so a snapshot folded under the old rules is replayed from the start (readSnapshot).
// 2: a HISTORY_EVENTS event never sets a ticket's batch.
export const FOLD_RULES = 2;
export const LOCK_WAIT_MS = 2000;
export const MODES = ['shadow', 'record'];
// Observations a pass recomputes on every run: written to queue.json, never appended, ignored by the diff.
export const PROJECTION_ONLY = ['log_bytes', 'idle_passes', 'pr_status', 'suite_wait_since', 'progress_sha', 'progress_at'];
export { PARK_KINDS };
export const ESCALATE_TO = ['person', 'repair', 'requeue'];
// How an ask reached its answerer (ask_presented), and who answered it (ask_answered): ask-ledger.mjs.
export const ASK_VIA = ['push', 'digest', 'decider', 'session'];
export const ASK_BY = ['person', 'decider', 'default'];
// The steps an ask's tokens are measured for (ask_tokens): the parked round, its presentation, the round after.
export const ASK_TOKEN_STEPS = ['raise', 'present', 'act'];
// Where a verdict the pass read at a PR's head was reviewed (verdict_read): by the ticket's cloud session,
// or on this computer (undraft.mjs verdictReadAt).
export const REVIEWER_LOCATIONS = ['cloud', 'local'];
// How many of the latest event ids a fold keeps, so a retry that straddles a snapshot is still skipped.
const ID_WINDOW = 1000;

// A commit SHA as a ledger event's head_sha holds it: lowercase hex, 7 to 40 characters.
export const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v);

// A field's check: a name ending in ? also takes null, but the field must still be present.
const CHECKS = {
  string: (v) => typeof v === 'string' && v !== '',
  int: (v) => Number.isInteger(v) && v >= 0,
  list: (v) => Array.isArray(v),
  strings: (v) => Array.isArray(v) && v.length > 0 && v.every(CHECKS.string),
  object: (v) => v != null && typeof v === 'object' && !Array.isArray(v),
  sha: isSha,
  kind: (v) => PARK_KINDS.includes(v),
  escalate: (v) => ESCALATE_TO.includes(v),
  bool: (v) => typeof v === 'boolean',
  via: (v) => ASK_VIA.includes(v),
  answerer: (v) => ASK_BY.includes(v),
  tokenStep: (v) => ASK_TOKEN_STEPS.includes(v),
  location: (v) => REVIEWER_LOCATIONS.includes(v),
  usd: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  share: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
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
  // line: the merge-log line it folds (merge-log.mjs readLogLines), so each line is folded once.
  automerge_armed: { scope: 'ticket', data: { by: 'string', pr: 'int', head_sha: 'sha', line: 'int' } },
  automerge_disarmed: { scope: 'ticket', data: { by: 'string', pr: 'int', line: 'int' } },
  merged: { scope: 'ticket', data: { by: 'string', pr: 'int', head_sha: 'sha', base: 'string' } },
  // stages: the merged PR's time by stage, as merge-stages.mjs records it.
  merge_stages: { scope: 'ticket', data: { pr: 'int', stages: 'object' } },
  // A desk-format verdict the pass read at PR pr's head head_sha, and where it was reviewed (location).
  verdict_read: { scope: 'ticket', data: { pr: 'int', head_sha: 'sha', location: 'location' } },
  // A park, hold or stall interval as stuck-time.mjs records it: opened (end null) or closed.
  stuck: { scope: 'ticket', data: { cause: 'string', start: 'string', end: 'string?' } },
  // An ask, a park handed to the person or the decider, as ask-ledger.mjs records each step of it: `ask`
  // is its id, <KEY>:<park.since>.
  ask_raised: { scope: 'ticket', data: { ask: 'string', since: 'string', kind: 'kind', blocking: 'bool?', arm: 'string?' } },
  ask_presented: { scope: 'ticket', data: { ask: 'string', via: 'via', ref: 'string?', notification: 'string?', share: 'share?' } },
  ask_answered: { scope: 'ticket', data: { ask: 'string', by: 'answerer', session: 'string?', latency_s: 'int?' } },
  ask_acted: { scope: 'ticket', data: { ask: 'string', round: 'int?' } },
  // One step's tokens and list-price dollars, by its source (the round's log, the decider, the person's
  // session or shell). A step that could not be read whole is complete false, its figures what was read
  // (null for none), never 0; approx marks a figure that is an attribution, not a reading.
  ask_tokens: { scope: 'ticket', data: { ask: 'string', step: 'tokenStep', source: 'string', input: 'int?', output: 'int?', cache_read: 'int?', cache_write: 'int?', usd: 'usd?', complete: 'bool', approx: 'bool?' } },
  // fields: the done fields written with it (queue-ledger.mjs DONE_FIELDS), laid on as a legacy_set's are.
  finished: { scope: 'ticket', data: { pr: 'int?', fields: 'object?' } },
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

export const ASK_EVENTS = ['ask_raised', 'ask_presented', 'ask_answered', 'ask_acted', 'ask_tokens'];
// The ticket events no queue write makes: each is appended by its own writer (the pass's auto-merge
// lines from the merge log, a merged PR's stages, a stuck interval, an ask's steps), naming the batch
// that writer is in. They are history, so they never move a ticket into that batch, and queue.json
// never owes the log one (queue-ledger.mjs).
export const HISTORY_EVENTS = ['automerge_armed', 'automerge_disarmed', 'merge_stages', 'stuck', 'verdict_read', ...ASK_EVENTS];
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
  ...Object.fromEntries(['answered', 'held', 'released', 'unparked']
    .map((t) => [t, { from: UNFINISHED, to: KEEP }])),
  // A done ticket's PR can still wait, on GitHub's mergeability answer, and have auto-merge armed or disarmed.
  ...Object.fromEntries(['waiting', 'waited', 'automerge_armed', 'automerge_disarmed'].map((t) => [t, { from: STATES, to: KEEP }])),
  // A merged PR's stages are read after its merge, whatever the ticket's state by then.
  merge_stages: { from: ANY, to: KEEP },
  // A verdict is read whatever the ticket's state by then.
  verdict_read: { from: ANY, to: KEEP },
  // A stuck interval opens and closes whatever the ticket's state, as a pass reads it.
  stuck: { from: ANY, to: KEEP },
  // An ask's steps are recorded whatever the ticket's state by the time each is written.
  ...Object.fromEntries(ASK_EVENTS.map((t) => [t, { from: ANY, to: KEEP }])),
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
  questions: [], answered: [], waits: {}, automerge: null, merge_log: null, spawn: null, merge_stages: null, stuck: {}, asks: {} });
// The queue.json field holding the triage questions answered so far, each an answered event's qid.
export const ANSWERED = 'answered_questions';
// The queue.json field holding a ticket's open waits, { <on>: a waiting event's data less its `on` }, or
// null once none is open (pass/deadlines.mjs).
export const WAITS = 'waits';
// Queue field `v` as the fold keeps it, each wait with its `on`, or null when it is not a map of waits.
export const waitsOfField = (v) => {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v) || !Object.values(v).every((w) => w && typeof w === 'object' && !Array.isArray(w))) return null;
  return Object.fromEntries(Object.entries(v).map(([on, w]) => [on, { ...w, on }]));
};
export const withoutProjectionOnly = (fields) => Object.fromEntries(Object.entries(fields ?? {}).filter(([f]) => !PROJECTION_ONLY.includes(f)));

// Lays queue.json fields onto ticket `t`: the fields with a typed home (state, park, held_by, result.pr,
// merge) go there too, so a typed event and a field set agree on one value.
function overlay(t, fields) {
  const f = withoutProjectionOnly(fields);
  Object.assign(t.fields, f);
  if (STATES.includes(f.state)) t.state = f.state;
  if ('park' in f) t.park = f.park ?? null;
  if ('held_by' in f || 'holds' in f) t.holds = blockersOf(f);
  if ('result' in f) t.pr = f.result?.pr ?? null;
  if ('merge' in f) t.merge = f.merge ?? null;
  if (ANSWERED in f) t.answered = Array.isArray(f[ANSWERED]) ? [...f[ANSWERED]] : [];
  if (WAITS in f) t.waits = waitsOfField(f[WAITS]) ?? {};
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

// Lays an ask event onto ticket `t`'s record of that ask: { ask, since, kind, blocking, arm, raised_at,
// presented: [{ via, ref, notification, share, at }], answered: { by, session, latency_s, at } | null,
// acted: { round, at } | null, tokens: { <step>:<source>: ask_tokens data and at } }. A step recorded
// already keeps its first record.
const askRecord = (ask) => ({ ask, since: null, kind: null, blocking: null, arm: null, raised_at: null, presented: [], answered: null, acted: null, tokens: {} });
// The key an ask's tokens are kept under on its record: its step and source.
export const tokensKey = (d) => `${d.step}:${d.source}`;
function askStep(t, ev) {
  const d = ev.data ?? {};
  t.asks ??= {};
  const a = (t.asks[d.ask] ??= askRecord(d.ask));
  if (ev.type === 'ask_raised') { if (a.raised_at == null) Object.assign(a, { since: d.since, kind: d.kind, blocking: d.blocking ?? null, arm: d.arm ?? null, raised_at: ev.at }); }
  else if (ev.type === 'ask_presented') { if (!a.presented.some((p) => p.via === d.via)) a.presented.push({ via: d.via, ref: d.ref ?? null, notification: d.notification ?? null, share: d.share ?? null, at: ev.at }); }
  else if (ev.type === 'ask_answered') a.answered ??= { by: d.by, session: d.session ?? null, latency_s: d.latency_s ?? null, at: ev.at };
  else if (ev.type === 'ask_acted') a.acted ??= { round: d.round ?? null, at: ev.at };
  else if (ev.type === 'ask_tokens') { a.tokens ??= {}; a.tokens[tokensKey(d)] ??= { ...d, at: ev.at }; }
}

// Whether ticket `t` (a folded ledger ticket) has a verdict read at PR pr's head head_sha already: an
// appender skips one it has (append's `skip`), so a verdict read on every pass is recorded once.
export const verdictRead = (t, { pr, head_sha }) => !!t?.verdicts?.some((v) => v.pr === pr && v.head_sha === head_sha);

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
  if (ev.type !== 'moved' && !HISTORY_EVENTS.includes(ev.type)) t.batch = ev.batch;
  const to = TRANSITIONS[ev.type].to;
  if (to !== KEEP) t.state = to;
  switch (ev.type) {
    // merge_log is how far the log has folded the merge log for this ticket, which no seed restates.
    // Nor its asks, which are history no queue field holds.
    case 'seeded': Object.assign(t, newTicket(ev.key), { batch: ev.batch, merge_log: t.merge_log, asks: t.asks ?? {} }); overlay(t, d.fields); break;
    case 'legacy_set': overlay(t, d.fields); break;
    case 'admitted': t.archived = false; t.park = null; break;
    case 'triaged': t.questions = [...d.questions]; break;
    case 'answered': t.answered.push(d.qid); break;
    case 'spawned': t.spawn = { ...d }; t.park = null; break;
    case 'parked': t.park = parkOf(d); break;
    case 'unparked': case 'requeued': t.park = null; break;
    // queue.json keeps held_by once a hold is set, as null when every blocker is released.
    case 'held': t.holds = [...new Set([...t.holds, ...d.by])]; t.fields.held_by = null; break;
    case 'released': t.holds = t.holds.filter((k) => k !== d.by); t.fields.held_by = null; break;
    // queue.json keeps the field once a wait has started, as null when none is open.
    case 'waiting': t.waits[d.on] = { ...d }; t.fields[WAITS] = null; break;
    case 'waited': delete t.waits[d.on]; t.fields[WAITS] = null; break;
    case 'pr_opened': t.pr = d.pr; break;
    // An arm on the PR the ticket's merge already names is history folded late: it arms nothing.
    case 'automerge_armed': if (t.merge?.pr !== d.pr) t.automerge = { by: d.by, pr: d.pr, head_sha: d.head_sha }; t.merge_log = Math.max(t.merge_log ?? -1, d.line); break;
    case 'automerge_disarmed': t.automerge = null; t.merge_log = Math.max(t.merge_log ?? -1, d.line); break;
    // merged_at keeps a ticket's first merge, as queue.mjs merged does.
    case 'merged': t.merge = { ...d, at: ev.at }; t.fields.merged_at ??= ev.at; t.automerge = null; break;
    case 'merge_stages': t.merge_stages = { pr: d.pr, ...d.stages }; break;
    // t.verdicts: each verdict read, once per PR and head, with where it was reviewed (verdictRead).
    case 'verdict_read': t.verdicts ??= []; if (!verdictRead(t, d)) t.verdicts.push({ pr: d.pr, head_sha: d.head_sha, location: d.location, at: ev.at }); break;
    // t.stuck: each open interval's cause and its start.
    case 'stuck': t.stuck ??= {}; if (d.end == null) t.stuck[d.cause] = d.start; else delete t.stuck[d.cause]; break;
    // t.asks: each ask's record, its steps as they were written (ask-ledger.mjs readAsks). No queue field
    // holds it, so the projection never shows it.
    case 'ask_raised': case 'ask_presented': case 'ask_answered': case 'ask_acted': case 'ask_tokens': askStep(t, ev); break;
    case 'finished': t.park = null; if (d.fields) overlay(t, d.fields); if (d.pr != null) t.pr = d.pr; break;
    // A ticket that leaves every batch leaves its blockers there: added again, it is held by what then holds it.
    case 'moved': t.batch = d.to; if (d.to == null) { t.holds = []; delete t.fields.held_by; } break;
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
    if (t.merge) { out.merge = { ...t.merge }; out.merged_at = t.fields.merged_at ?? t.merge.at; }
    if (t.answered.length) out[ANSWERED] = [...t.answered];
    const waits = Object.entries(t.waits);
    if (waits.length || WAITS in t.fields) out[WAITS] = waits.length ? Object.fromEntries(waits.map(([on, { on: _, ...w }]) => [on, w])) : t.fields[WAITS] ?? null;
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
// replays from the start instead. A snapshot folded under other fold rules than these (`fold` not
// FOLD_RULES; none before rule 2) does not read as one either: its state is what those rules made of
// the events, and the archives beside it fold them again under these.
const readSnapshot = (paths) => {
  if (!existsSync(paths.snapshot)) return null;
  try {
    const s = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
    return s?.fold === FOLD_RULES && s.state && Number.isInteger(s.state.seq) ? s.state : false;
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
// `skip(state, ev)`, where given, is asked of each event with the log folded under the lock, and an event
// it says is there already is left out, so a retry writes nothing twice. -> the envelopes written.
export function append(repoDir, events, { mode = 'shadow', by, now = () => new Date().toISOString(), waitMs = LOCK_WAIT_MS, snapshotEvery = SNAPSHOT_EVERY, skip = null } = {}) {
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
    const todo = skip ? list.filter((ev) => !skip(state, ev)) : list;
    if (!todo.length) return [];
    const writer = byOf(by);
    const seen = new Set(state.ids);
    const out = todo.map((ev, i) => ({ v: 1, seq: state.seq + i + 1, id: ev.id ?? randomUUID(), at: ev.at ?? now(),
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
  writeDurable(paths.snapshot, `${JSON.stringify({ v: 1, fold: FOLD_RULES, at: new Date().toISOString(), state }, null, 2)}\n`);
  syncDir(paths.dir);
  writeDurable(paths.events, '');
  syncDir(paths.dir);
}
