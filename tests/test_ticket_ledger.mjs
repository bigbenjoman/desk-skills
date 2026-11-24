// suite: ticket ledger (typed events in one append-only log per repo, the reducer, the projection and the diff)
// layer: L1
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as L from '../desk/bin/ticket-ledger.mjs';
import { STATES } from '../desk/bin/queue-writer.mjs';
import { lock, unlock } from '../desk/bin/dir-lock.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const repo = () => scratch('ticket-ledger-');
const lines = (dir) => { const f = L.ledgerPaths(dir).events; return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
const SHA = 'abc1234def';

// One valid data payload per event type.
const VALID = {
  seeded: { fields: { state: 'queued' } },
  admitted: {},
  triaged: { questions: ['q1'] },
  answered: { qid: 'q1' },
  spawned: { login: 'work', port: 3231, worker: 'w1', round: 1 },
  parked: { kind: 'question', question: 'which?', approve: null, since: '2026-11-20T10:00:00Z', deadline: null },
  unparked: {},
  held: { by: ['DS-2'] },
  released: { by: 'DS-2' },
  waiting: { on: 'mergeability', since: '2026-11-20T10:00:00Z', deadline: '2026-11-20T10:30:00Z', escalate_to: 'person' },
  waited: { on: 'mergeability' },
  pr_opened: { pr: 12, head_sha: SHA },
  automerge_armed: { by: 'session x', pr: 12, head_sha: SHA },
  automerge_disarmed: { by: 'merge-driver', pr: 12 },
  merged: { by: 'merge-driver', pr: 12, head_sha: SHA, base: 'main' },
  finished: { pr: 12, fields: null },
  failed: { subtype: 'crash' },
  requeued: {},
  moved: { from: 'B1', to: 'B2' },
  archived: {},
  legacy_set: { fields: { note: 'x' } },
  base_red: { check: 'tests', since: '2026-11-20T10:00:00Z', deadline: '2026-11-20T11:00:00Z', merges: [] },
  base_green: {},
  platform_outage: { check: 'tests', since: '2026-11-20T10:00:00Z', deadline: '2026-11-20T12:00:00Z' },
  platform_clear: {},
};
const ev = (type, data = VALID[type], key = 'DS-1', batch = 'B1') => ({ type, batch, key: L.EVENTS[type].scope === 'batch' ? null : key, data });

t('every event type has a valid case here', j(Object.keys(VALID).sort()), j(Object.keys(L.EVENTS).sort()));

// Each event type: one valid and one malformed case.
for (const type of Object.keys(L.EVENTS)) {
  t(`${type}: a valid event is accepted`, L.invalid(ev(type)), null);
  const fields = Object.keys(L.EVENTS[type].data);
  let bad; let want;
  if (fields.length) {
    const data = { ...VALID[type] }; delete data[fields[0]];
    bad = ev(type, data); want = `${type}: required field "${fields[0]}" is missing`;
  } else if (L.EVENTS[type].scope === 'ticket') {
    bad = { ...ev(type), key: undefined }; want = `${type}: field "key" is required (a ticket key)`;
  } else {
    bad = { ...ev(type), key: 'DS-1' }; want = `${type}: field "key" must be null (a batch event)`;
  }
  t(`${type}: a malformed event is refused, naming the type and field`, L.invalid(bad), want);
}
t('a field of the wrong kind is named', L.invalid(ev('parked', { ...VALID.parked, kind: 'whatever' })), 'parked: field "kind" is not a valid kind');
t('a nullable field still has to be present', L.invalid(ev('finished', {})), 'finished: required field "pr" is missing');

// The transition table: one case per row, a legal from-state and, where there is one, an illegal one.
const at = (state) => (state == null ? L.emptyState() : L.reduce([{ v: 1, seq: 1, id: 's', batch: 'B1', key: 'DS-1', type: 'seeded', data: { fields: { state } } }]));
const illegalFrom = (type) => [null, ...STATES].find((s) => !L.TRANSITIONS[type].from.includes(s));
for (const [type, row] of Object.entries(L.TRANSITIONS)) {
  const from = row.from[0];
  const s = at(from);
  const after = L.reduce([{ v: 1, seq: s.seq + 1, id: `x-${type}`, ...ev(type) }], s);
  const want = type === 'seeded' ? 'queued' : typeof row.to === 'string' ? row.to : from;
  t(`${type} from ${from ?? 'none'} is legal and leaves ${want ?? 'none'}`, j([L.legality(s, ev(type)).legal, after.tickets['DS-1']?.state ?? null]), j([true, want]));
  const no = illegalFrom(type);
  if (no !== undefined) t(`${type} from ${no ?? 'none'} is illegal`, j(L.legality(at(no), ev(type))), j({ legal: false, from: no }));
}
t('a batch event is never illegal', L.legality(L.emptyState(), ev('base_red')).legal, true);

// AC1: three valid events append in order, each with a rising seq, its time and its writer.
{
  const dir = repo();
  const times = ['2026-11-20T10:00:00.000Z', '2026-11-20T10:00:01.000Z', '2026-11-20T10:00:02.000Z'];
  let i = 0;
  L.append(dir, [ev('admitted')], { by: 'pass', now: () => times[i++] });
  L.append(dir, [ev('spawned'), ev('parked')], { by: 'queue.mjs set', now: () => times[i++] });
  const r = L.read(dir);
  t('AC1 the read returns the three events in order', j(r.events.map((e) => e.type)), j(['admitted', 'spawned', 'parked']));
  t('AC1 each with a rising sequence number', j(r.events.map((e) => e.seq)), '[1,2,3]');
  t('AC1 each with its time', j(r.events.map((e) => e.at)), j(times));
  t('AC1 and its writer', j(r.events.map((e) => e.by.proc)), j(['pass', 'queue.mjs set', 'queue.mjs set']));
  t('AC1 the writer carries its pid', r.events[0].by.pid, process.pid);
  t('AC1 each has an id', r.events.every((e) => typeof e.id === 'string' && e.id.length > 0), true);
  t('AC1 the log is under ledger/ in the repo directory', existsSync(join(dir, 'ledger', 'events.jsonl')), true);
  t('AC1 no torn line, gap or illegal transition', j([r.torn, r.gaps, r.illegal]), '[[],[],[]]');
  t('AC1 read narrows by batch', L.read(dir, { batch: 'B2' }).events.length, 0);
  t('AC1 read narrows by since', j(L.read(dir, { since: 1 }).events.map((e) => e.seq)), '[2,3]');
}

// AC2: an unknown type, or a missing required field, is refused naming it, and the log is unchanged.
{
  const dir = repo();
  L.append(dir, [ev('admitted')]);
  const before = lines(dir);
  t('AC2 an unknown type is refused, named', threw(() => L.append(dir, [ev('triaged'), { type: 'teleported', batch: 'B1', key: 'DS-1', data: {} }]))?.includes('unknown event type "teleported"'), true);
  t('AC2 a missing field is refused, with the type and field named', threw(() => L.append(dir, [ev('spawned', { login: null, port: null, round: 1 })])),
    'refused, nothing written: spawned: required field "worker" is missing');
  t('AC2 the log is unchanged, the valid event in the same call included', lines(dir), before);
}

// AC3: record mode refuses spawned for a ticket whose last event left it done.
{
  const dir = repo();
  L.append(dir, [ev('admitted'), ev('spawned'), ev('finished')], { mode: 'record' });
  const before = lines(dir);
  t('AC3 refused, naming the event and the current state', threw(() => L.append(dir, [ev('spawned')], { mode: 'record' }))?.startsWith('refused, nothing written: spawned for DS-1 is illegal from its current state done'), true);
  t('AC3 nothing is written', lines(dir), before);
  t('AC3 a legal call in record mode is written', L.append(dir, [ev('merged')], { mode: 'record' }).length, 1);
  t('AC3 a call refused part way writes none of it', threw(() => L.append(dir, [ev('admitted', {}, 'DS-9'), ev('failed', VALID.failed, 'DS-9')], { mode: 'record' }))?.includes('failed for DS-9 is illegal from its current state queued'), true);
  t('AC3 so DS-9 has no event', L.fold(dir).tickets['DS-9'], undefined);
  t('AC3 an unknown mode is refused', threw(() => L.append(dir, [ev('admitted')], { mode: 'loud' }))?.startsWith('unknown ledger mode'), true);
}

// AC4: the same illegal spawned in shadow mode is written, and the read reports one illegal transition.
{
  const dir = repo();
  L.append(dir, [ev('admitted'), ev('spawned'), ev('finished')]);
  const [w] = L.append(dir, [ev('spawned')]);
  const r = L.read(dir);
  t('AC4 the illegal event is written', r.events.at(-1).id, w.id);
  t('AC4 the read reports it as one illegal transition', j(r.illegal.map((x) => [x.seq, x.key, x.type, x.from])), j([[4, 'DS-1', 'spawned', 'done']]));
  t('AC4 and the fold applies it', L.fold(dir).tickets['DS-1'].state, 'running');
  t('AC4 a read narrowed to its batch reports it too', L.read(dir, { batch: 'B1' }).illegal.length, 1);
  t('AC4 and one narrowed to another batch does not', L.read(dir, { batch: 'B2' }).illegal.length, 0);
}

// AC5: an event appended twice with the same id is folded once.
{
  const dir = repo();
  L.append(dir, [ev('admitted'), { ...ev('answered'), id: 'retry-1' }]);
  L.append(dir, [{ ...ev('answered'), id: 'retry-1' }]);
  t('AC5 both lines are in the log', L.read(dir).events.length, 3);
  t('AC5 the state reflects it once', j(L.fold(dir).tickets['DS-1'].answered), '["q1"]');
  t('AC5 a record-mode retry of an event already folded is not checked again', L.append(dir, [{ ...ev('answered'), id: 'retry-1' }], { mode: 'record' }).length, 1);
  t('AC5 the next append numbers past every retry', L.append(dir, [ev('answered', { qid: 'q2' })])[0].seq, 5);
  t('AC5 and is read and folded', j([L.read(dir).events.length, L.fold(dir).tickets['DS-1'].answered]), j([5, ['q1', 'q2']]));
}

// AC6: a last line cut off mid-write: every whole event is returned, the cut line reported once.
{
  const dir = repo();
  L.append(dir, [ev('admitted'), ev('spawned')]);
  appendFileSync(L.ledgerPaths(dir).events, '{"v":1,"seq":3,"id":"cut","type":"par');
  const r = L.read(dir);
  t('AC6 every whole event is returned', j(r.events.map((e) => e.type)), j(['admitted', 'spawned']));
  t('AC6 the cut line is reported once', j(r.torn.map((x) => [x.file, x.line])), j([['events.jsonl', 3]]));
  L.append(dir, [ev('parked')]);
  const r2 = L.read(dir);
  t('AC6 the next append starts a line of its own', j(r2.events.map((e) => [e.seq, e.type])), j([[1, 'admitted'], [2, 'spawned'], [3, 'parked']]));
  t('AC6 the cut line is still reported once', r2.torn.length, 1);
}

// AC7: past the snapshot threshold, the fold equals folding from the start, and the earlier events
// move to a compressed file beside the snapshot.
{
  const dir = repo();
  const all = [];
  const steps = [ev('admitted'), ev('spawned'), ev('parked'), ev('spawned'), ev('held'), ev('released'), ev('pr_opened'), ev('finished'), ev('merged'),
    ev('admitted', {}, 'DS-2'), ev('triaged', VALID.triaged, 'DS-2'), ev('base_red'), ev('moved', VALID.moved, 'DS-2')];
  for (const s of steps) all.push(...L.append(dir, [s], { snapshotEvery: 5 }));
  const p = L.ledgerPaths(dir);
  const gz = readdirSync(p.dir).filter((f) => f.endsWith('.jsonl.gz')).sort();
  t('AC7 the threshold rotated the earlier events', j(gz), j(['events.10.jsonl.gz', 'events.5.jsonl.gz']));
  t('AC7 into compressed files beside the snapshot', j(gunzipSync(readFileSync(join(p.dir, 'events.5.jsonl.gz'))).toString().trim().split('\n').map((l) => JSON.parse(l).seq)), '[1,2,3,4,5]');
  t('AC7 the snapshot holds the folded state at its seq', JSON.parse(readFileSync(p.snapshot, 'utf8')).state.seq, 10);
  t('AC7 the live file keeps only the tail', j(lines(dir).trim().split('\n').map((l) => JSON.parse(l).seq)), '[11,12,13]');
  t('AC7 the fold equals folding every event from the start', j(L.fold(dir)), j(L.reduce(all)));
  t('AC7 a read from the start still returns every event', j(L.read(dir).events.map((e) => e.seq)), j(all.map((e) => e.seq)));
  t('AC7 a read since the snapshot reads the tail', j(L.read(dir, { since: 11 }).events.map((e) => e.seq)), '[12,13]');
  t('AC7 the seq keeps rising after a rotation', L.append(dir, [ev('archived')], { snapshotEvery: 5 })[0].seq, 14);
  all.push(...L.read(dir, { since: 13 }).events);
  writeFileSync(p.snapshot, '{"v":1,"state":{"seq":1');
  t('AC7 a snapshot cut off mid-write is replayed from the start', j(L.fold(dir)), j(L.reduce(all)));
  t('AC7 and the read still returns every event', L.read(dir).events.length, 14);
}

// AC8: a batch's events project to queue.json's shape.
const seed = (key, fields, seq) => ({ v: 1, seq, id: `seed-${key}`, at: '2026-11-20T09:00:00Z', batch: 'B1', key, type: 'seeded', data: { fields } });
const env = (seq, e, atTime = `2026-11-20T10:00:${String(seq).padStart(2, '0')}Z`) => ({ v: 1, seq, id: `e${seq}`, at: atTime, by: { proc: 't', pid: 1 }, ...e });
{
  const s = L.reduce([
    seed('DS-1', { key: 'DS-1', state: 'queued', added_at: 'x', held_by: 'DS-3|DS-4', log_bytes: 9 }, 1),
    seed('DS-2', { key: 'DS-2', state: 'running', result: { summary: 'y' } }, 2),
    env(3, ev('released', { by: 'DS-3' })),
    env(4, ev('parked', { kind: 'hold', question: 'held', approve: null, since: 'z', deadline: null })),
    env(5, ev('finished', { pr: 40 }, 'DS-2')),
    env(6, ev('merged', { by: 'merge-driver', pr: 40, head_sha: SHA, base: 'main' }, 'DS-2')),
    env(7, ev('admitted', {}, 'DS-9', 'B2')),
  ]);
  const q = L.project(s, 'B1');
  t('AC8 the projection is a queue: batch and tickets', j(Object.keys(q)), '["batch","tickets"]');
  t('AC8 only the batch\'s live tickets', j(Object.keys(q.tickets)), '["DS-1","DS-2"]');
  t('AC8 each ticket\'s state', j([q.tickets['DS-1'].state, q.tickets['DS-2'].state]), '["parked","done"]');
  t('AC8 its park', j(q.tickets['DS-1'].park), j({ kind: 'hold', question: 'held', since: 'z' }));
  t('AC8 its holds as a list', j(q.tickets['DS-1'].holds), '["DS-4"]');
  t('AC8 and held_by kept in step for today\'s readers', q.tickets['DS-1'].held_by, 'DS-4');
  t('AC8 its PR, beside the result it already had', j(q.tickets['DS-2'].result), j({ summary: 'y', pr: 40 }));
  t('AC8 its merge record', j(q.tickets['DS-2'].merge), j({ by: 'merge-driver', pr: 40, head_sha: SHA, base: 'main', at: '2026-11-20T10:00:06Z' }));
  t('AC8 and when it merged', q.tickets['DS-2'].merged_at, '2026-11-20T10:00:06Z');
  t('AC8 the seeded fields come through', q.tickets['DS-1'].added_at, 'x');
  t('AC8 a projection-only field never does', 'log_bytes' in q.tickets['DS-1'], false);
  const reseeded = L.reduce([{ ...seed('DS-1', { key: 'DS-1', state: 'queued' }, 9), id: 'reseed' }], s).tickets['DS-1'];
  t('AC8 a ticket seeded again is what its fields say, nothing kept from before', j([reseeded.state, reseeded.park, reseeded.holds]), j(['queued', null, []]));
  const onDisk = { batch: 'B1', version: 7, concurrency: 2, base: 'feature/x', tickets: {} };
  t('AC8 the batch\'s own fields come from the queue on disk', j(L.project(s, 'B1', onDisk)), j({ batch: 'B1', concurrency: 2, base: 'feature/x', tickets: q.tickets }));
  const unheld = { key: 'DS-5', state: 'queued', held_by: null };
  const sq = L.project(L.reduce([seed('DS-5', unheld, 1)]), 'B1', { batch: 'B1', tickets: {} });
  t('AC8 an unheld ticket keeps held_by null', sq.tickets['DS-5'].held_by, null);
  t('AC8 so a seeded queue differs from its projection only by the holds list', j(L.diffQueues({ batch: 'B1', tickets: { 'DS-5': unheld } }, sq).map((d) => d.field)), '["holds"]');
  t('AC8 a moved ticket leaves its old batch', Object.keys(L.project(L.reduce([env(8, ev('moved', { from: 'B1', to: 'B2' }))], s), 'B1').tickets).join(), 'DS-2');
}

// Held and released replay: blockers add in order, a release takes out only the one it names, and
// held_by projects as them joined (null once none is left). A ticket that leaves every batch leaves its
// blockers behind, so one added again is held only by what holds it then.
{
  const s = L.reduce([
    seed('DS-1', { key: 'DS-1', state: 'triaged' }, 1),
    env(2, ev('held', { by: ['DS-3', 'DS-2'] })),
    env(3, ev('held', { by: ['DS-4'] })),
    env(4, ev('released', { by: 'DS-2' })),
  ]);
  const p = (st) => L.project(st, 'B1').tickets['DS-1'];
  t('held events add blockers in the order they came', j([p(s).holds, p(s).held_by]), j([['DS-3', 'DS-4'], 'DS-3|DS-4']));
  const none = L.reduce([env(5, ev('released', { by: 'DS-3' })), env(6, ev('released', { by: 'DS-4' }))], s);
  t('the last release leaves held_by null', j([p(none).holds, p(none).held_by]), j([[], null]));
  t('a seeded pipe-joined held_by reads as the same list', j(p(L.reduce([seed('DS-1', { key: 'DS-1', state: 'queued', held_by: 'DS-3|DS-4' }, 1)])).holds), j(['DS-3', 'DS-4']));
  t('a seeded holds list with no held_by reads the same', j(p(L.reduce([seed('DS-1', { key: 'DS-1', state: 'queued', holds: ['DS-3', 'DS-4'] }, 1)])).holds), j(['DS-3', 'DS-4']));
  const back = L.reduce([env(7, ev('moved', { from: 'B1', to: null })), env(8, ev('admitted')), env(9, ev('held', { by: ['DS-5'] }))], s);
  t('dropped and added again, it is held only by its new blocker', j([p(back).holds, p(back).held_by]), j([['DS-5'], 'DS-5']));
}

// AC9: an archived ticket is left out of the projected queue.
{
  const s = L.reduce([seed('DS-1', { key: 'DS-1', state: 'done' }, 1), seed('DS-2', { key: 'DS-2', state: 'queued' }, 2), env(3, ev('archived'))]);
  t('AC9 the archived ticket is left out', j(Object.keys(L.project(s, 'B1').tickets)), '["DS-2"]');
  t('AC9 admitted again, it is back', j(Object.keys(L.project(L.reduce([env(4, ev('admitted'))], s), 'B1').tickets)), '["DS-1","DS-2"]');
}

// AC10: two queues differing in one ticket's field: that ticket and field with both values.
{
  const a = { batch: 'B1', version: 3, tickets: { 'DS-1': { key: 'DS-1', state: 'running', log_bytes: 10, pr_status: { state: 'OPEN' } }, 'DS-2': { key: 'DS-2', state: 'queued' } } };
  const b = { batch: 'B1', version: 4, tickets: { 'DS-1': { key: 'DS-1', state: 'parked', log_bytes: 99, idle_passes: 2, progress_at: 'x' }, 'DS-2': { key: 'DS-2', state: 'queued' } } };
  t('AC10 the ticket and field, with both values', j(L.diffQueues(a, b)), j([{ ticket: 'DS-1', field: 'state', before: 'running', after: 'parked' }]));
  t('AC10 the projection-only fields are the design\'s six', j(L.PROJECTION_ONLY), j(['log_bytes', 'idle_passes', 'pr_status', 'suite_wait_since', 'progress_sha', 'progress_at']));
  t('AC10 the same queue has no difference', L.diffQueues(a, structuredClone(a)).length, 0);
  t('AC10 key order inside a value is no difference', L.diffQueues({ tickets: { A: { r: { x: 1, y: 2 } } } }, { tickets: { A: { r: { y: 2, x: 1 } } } }).length, 0);
}

// DS-895: a parked event carries the whole park, its kind and the write it awaits approval of among it;
// an answered event names the question it closes, and the rest stay open.
{
  const approve = { kind: 'jira-comment', target: 'DS-1', body: 'Root cause: x.\nFix: y.' };
  const park = { kind: 'person-step', question: 'awaiting approval', approve, since: 'z', class: 'unclassified', inputs: { pr: 4 } };
  const s = L.reduce([seed('DS-1', { key: 'DS-1', state: 'running' }, 1), env(2, ev('parked', { ...park, deadline: null }))]);
  t('DS-895 a parked event\'s replay is the park it carries, kind and approval verbatim', j(L.project(s, 'B1').tickets['DS-1'].park), j(park));
  t('DS-895 a parked event with an unknown kind is refused', L.invalid(ev('parked', { ...VALID.parked, kind: 'held' })), 'parked: field "kind" is not a valid kind');
  const qs = ['which colour?', 'which size?', 'which font?'];
  const a = L.reduce([seed('DS-1', { key: 'DS-1', state: 'triaged', open_questions: 3 }, 1), env(2, ev('answered', { qid: qs[1] }))]);
  t('DS-895 an answered event closes the question it names', j(a.tickets['DS-1'].answered), j([qs[1]]));
  t('DS-895 and the rebuilt queue lists it answered', j(L.project(a, 'B1').tickets['DS-1'].answered_questions), j([qs[1]]));
  const b = L.reduce([env(3, ev('answered', { qid: qs[0] }))], a);
  t('DS-895 a second answer adds its own question, after the first', j(L.project(b, 'B1').tickets['DS-1'].answered_questions), j([qs[1], qs[0]]));
  const c = L.reduce([env(4, ev('legacy_set', { fields: { answered_questions: null } }))], b);
  t('DS-895 a field write that clears the list leaves none answered', j([c.tickets['DS-1'].answered, L.project(c, 'B1').tickets['DS-1'].answered_questions]), j([[], null]));
}

// DS-901: a waiting event opens a wait the rebuilt queue keeps as `waits`, carrying its start, deadline and
// escalation; a waited event closes the one it names, and the field stays, as null, once none is open.
{
  const merge = { on: 'mergeability', since: '2026-11-20T10:00:00Z', deadline: '2026-11-20T10:30:00Z', escalate_to: 'person', pr: 40 };
  const hand = { on: 'handoff', since: '2026-11-20T10:00:00Z', deadline: '2026-11-20T10:15:00Z', escalate_to: 'requeue', stage: '4b' };
  const s = L.reduce([seed('DS-1', { key: 'DS-1', state: 'done', result: { pr: 40 } }, 1), seed('DS-2', { key: 'DS-2', state: 'triaged' }, 2),
    env(3, ev('waiting', merge)), env(4, ev('waiting', hand, 'DS-2'))]);
  const q = L.project(s, 'B1').tickets;
  t('AC6 a waiting event\'s wait is in the rebuilt queue, with its start, deadline and escalation', j(q['DS-1'].waits), j({ mergeability: { since: merge.since, deadline: merge.deadline, escalate_to: 'person', pr: 40 } }));
  t('AC6 a done ticket may wait, on its PR\'s mergeability', L.legality(L.reduce([seed('DS-1', { key: 'DS-1', state: 'done' }, 1)]), ev('waiting', merge)).legal, true);
  const esc = L.reduce([env(5, ev('waiting', { ...hand, escalated: '2026-11-20T10:16:00Z' }, 'DS-2'))], s);
  t('a waiting event again for the same wait carries its escalation', L.project(esc, 'B1').tickets['DS-2'].waits.handoff.escalated, '2026-11-20T10:16:00Z');
  const ended = L.reduce([env(6, ev('waited', { on: 'mergeability' })), env(7, ev('waited', { on: 'handoff' }, 'DS-2'))], esc);
  t('AC7 a waited event closes the wait it names, leaving the field null', j(Object.values(L.project(ended, 'B1').tickets).map((x) => x.waits)), '[null,null]');
  t('a ticket that never waited has no waits field', 'waits' in L.project(L.reduce([seed('DS-3', { key: 'DS-3', state: 'queued' }, 1)]), 'B1').tickets['DS-3'], false);
  const seeded = L.reduce([seed('DS-4', { key: 'DS-4', state: 'triaged', waits: { handoff: { since: 'x', deadline: 'y', escalate_to: 'requeue' } } }, 1), env(2, ev('waited', { on: 'handoff' }, 'DS-4'))]);
  t('a wait seeded from queue.json is closed by its waited event', L.project(seeded, 'B1').tickets['DS-4'].waits, null);
}

// The lock: an append waits for the ledger lock at most its wait, then throws and writes nothing.
{
  const dir = repo();
  L.append(dir, [ev('admitted')]);
  const before = lines(dir);
  lock(L.ledgerPaths(dir).lock);
  t('a held ledger lock times the append out', threw(() => L.append(dir, [ev('spawned')], { waitMs: 100 }))?.includes('locked by pid'), true);
  unlock(L.ledgerPaths(dir).lock);
  t('and writes nothing', lines(dir), before);
  t('the default wait is 2 s', L.LOCK_WAIT_MS, 2000);
  t('the default snapshot threshold is 1,000 events', L.SNAPSHOT_EVERY, 1000);
}

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
