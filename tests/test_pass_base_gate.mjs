// suite: pass phase: the base gate (the decision, run through the generator runner)
// layer: L1
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideBaseGate, decideBaseRed, sliceLabel } from '../desk/bin/pass/base-gate.mjs';
import { batchLine } from '../desk/bin/base-red.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const merged = (key, fields = {}) => ({ key, state: 'done', merged_at: '2026-11-18T10:00:00.000Z', result: { pr: Number(key.replace(/\D/g, '')) }, ...fields });
const byKey = (...ts) => Object.fromEntries(ts.map((x) => [x.key, x]));
const snap = (queue, fields = {}) => ({
  queue: { tickets: {}, promotion: { pr: 50 }, gate: null, ...queue }, alive: false, baseFix: false, conflict: null, settled: false,
  driverLive: true, slice: 5, base: 'feat/x', source: 'main', repo: 'o/r', log: '/state/logs/base-gate.log', dry: false, now: NOW, ...fields,
});

// The runner with stub handlers: each read answers from `answers` (a value, or a function of the
// action), else from what a quiet pass reads.
const READS = { milestone: false, 'pr-state': 'MERGED', 'base-head': HEAD, 'pr-draft': { state: 'OPEN', isDraft: false }, 'undo-ready': { ok: true, out: '' }, flush: { ok: true, conflicts: [] }, 'start-gate': 4242 };
const WRITES = ['set-batch', 'out', 'report', 'pending'];
function drive(s, answers = {}) {
  const handlers = Object.fromEntries([...Object.keys(READS), ...WRITES].map((type) => [type, (a) => {
    const v = Object.hasOwn(answers, type) ? answers[type] : READS[type];
    return typeof v === 'function' ? v(a) : v;
  }]));
  const report = { failed: [] };
  const actions = runSteps({ name: 'base gate', snapshot: () => s, decide: decideBaseGate, handlers, report });
  if (report.failed.length) { fails++; console.log(`FAIL a handler was missing: ${j(report.failed)}`); }
  return actions;
}
const types = (as) => as.map((a) => a.type);
const lines = (as, type = 'out') => as.filter((a) => a.type === type).map((a) => a.line);
const pending = (as) => as.at(-1)?.type === 'pending' ? as.at(-1).pending : 'no pending action last';
const batchWrites = (as) => as.filter((a) => a.type === 'set-batch').flatMap((a) => a.fields);
const fiveMerged = byKey(...['T-1', 'T-2', 'T-3', 'T-4', 'T-5'].map((k) => merged(k)), { key: 'T-6', state: 'running' });

// AC1: the slice size of children merged since the last gate starts a gate.
{
  const as = drive(snap({ tickets: fiveMerged }));
  t('AC1 the slice size of children merged since the last promotion starts a gate', types(as).includes('start-gate'), true);
  t('its record is in the queue, and flushed, before it starts', j(types(as).slice(types(as).indexOf('base-head'), types(as).indexOf('start-gate') + 1)), j(['base-head', 'set-batch', 'flush', 'start-gate']));
  t('the record names the base head and the slice', j(JSON.parse(batchWrites(as)[0].slice('gate='.length))),
    j({ state: 'running', pid: null, started: '2026-11-18T12:00:00.000Z', sha: HEAD, slice: { n: 1, keys: ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'], of: 6, last: false } }));
  t('then its pid, flushed again', j([batchWrites(as)[1], types(as)[types(as).indexOf('start-gate') + 2]]), j(['gate.pid=4242', 'flush']));
  t('and it says so', lines(as)[0], 'BASE GATE: started on feat/x for slice 1: 5 of 6 children, since 5 children merged since the last promotion (pid 4242): merges main in, then runs every acceptance spec and the repo\'s Typecheck, Lint and Unit tests there; log /state/logs/base-gate.log');
  t('a started gate keeps the batch from idle', pending(as), true);
  // Since the last gate: children a passed gate covered do not count toward the next slice.
  const covered = { state: 'passed', sha: HEAD, ready: true, pr: 50, slice: { n: 1, keys: ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'], of: 9, last: false } };
  const later = byKey(...['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7', 'T-8', 'T-9', 'T-10'].map((k) => merged(k)));
  t('AC1 five more merged since the last gate, on a moved base, start the next', types(drive(snap({ tickets: later, gate: covered }), { 'base-head': MOVED })).includes('start-gate'), true);
  t('four merged since the last promotion start none', types(drive(snap({ tickets: byKey(...['T-1', 'T-2', 'T-3', 'T-4'].map((k) => merged(k))) }))).includes('start-gate'), false);
  const four = drive(snap({ tickets: byKey(...['T-1', 'T-2', 'T-3', 'T-4'].map((k) => merged(k))) }));
  t('and say how many more the slice needs, with no git read', j([lines(four), types(four).includes('base-head'), pending(four)]),
    j([['BASE GATE: the next slice runs once 1 more child(ren) merge into feat/x (4 of 5 so far), a milestone child merges, or the last child merges'], false, false]));
  const ms = drive(snap({ tickets: byKey(merged('T-1'), merged('T-2')) }), { milestone: (a) => a.key === 'T-2' });
  t('a milestone child merged starts one before the slice is full', j([types(ms).includes('start-gate'), lines(ms)[0].includes(', since milestone T-2 merged')]), '[true,true]');
  t('each uncovered child\'s milestone label is read, in order', j(ms.filter((a) => a.type === 'milestone').map((a) => a.key)), j(['T-1', 'T-2']));
  t('merges before the last promotion do not count', types(drive(snap({ tickets: fiveMerged, promotion: { pr: 50, since: '2026-11-18T11:00:00.000Z' } }))).includes('start-gate'), false);
}

// AC2: a failed gate on a base that has not moved starts no new gate.
{
  const failed = { state: 'failed', sha: HEAD, pr: 50, redrafted: true, failures: ['Unit tests failed'], slice: { n: 1, keys: ['T-1'], of: 6, last: false } };
  const as = drive(snap({ tickets: fiveMerged, gate: failed }));
  t('AC2 a failed gate whose base has not moved returns no new gate', types(as).includes('start-gate'), false);
  t('it reports the failure and how to run it again', j(lines(as, 'report')), j([
    'BASE GATE: Unit tests failed',
    'BASE GATE: failed on feat/x at aaaaaaaaaaaa (slice 1: 1 of 6 children), so promotion PR #50 stays draft. Fix it on feat/x: the gate runs again once feat/x moves, or now with queue.mjs set-batch gate=null',
  ]));
  t('and holds nothing', pending(as), false);
  t('once the base moves, it runs again', types(drive(snap({ tickets: fiveMerged, gate: failed }), { 'base-head': MOVED })).includes('start-gate'), true);
  t('a base head that could not be read is not a move', types(drive(snap({ tickets: fiveMerged, gate: failed }), { 'base-head': null })).includes('start-gate'), false);
}

// A gate recorded as running.
{
  const running = { state: 'running', pid: 77, started: '2026-11-18T11:00:00.000Z', sha: HEAD, slice: { n: 2, keys: ['T-1'], of: 3, last: true } };
  const live = drive(snap({ gate: running }, { alive: true }));
  t('a running gate whose process is alive is reported running, and holds', j([types(live), lines(live)]), j([['out', 'pending'],
    ['BASE GATE: running on feat/x (slice 2: 1 of 3 children, the last) since 2026-11-18T11:00:00.000Z (pid 77); log /state/logs/base-gate.log']]));
  t('and that holds the batch', pending(live), true);
  const dead = drive(snap({ gate: running, tickets: byKey(merged('T-1')) }));
  t('one whose process is gone is recorded failed first', j(JSON.parse(batchWrites(dead)[0].slice('gate='.length))),
    j({ ...running, state: 'failed', finished: '2026-11-18T12:00:00.000Z', failures: ['the gate stopped without a result (pid 77): see /state/logs/base-gate.log'] }));
  t('and reported as a failed gate', lines(dead, 'report')[0], 'BASE GATE: the gate stopped without a result (pid 77): see /state/logs/base-gate.log');
}

// What the gate waits on.
{
  const fix = drive(snap({ tickets: fiveMerged }, { baseFix: true, conflict: { line: 'src/a.ts conflicts' } }));
  t('a base fix worker in the base worktree holds the gate', j([types(fix), lines(fix)]), j([['out', 'pending'], ['BASE GATE: waits on the conflict fix worker on feat/x: src/a.ts conflicts']]));
  t('and the batch', pending(fix), true);
  const ask = drive(snap({ tickets: fiveMerged, base_push_ask: true }));
  t('an unapproved base sync holds the gate before it starts', j([types(ask).includes('start-gate'), lines(ask), pending(ask)]),
    j([false, ['BASE GATE: waits on the base sync, asked once for the batch in /desk-needs-you (its base-push item)'], true]));
  t('an approved one does not', types(drive(snap({ tickets: fiveMerged, base_push_ask: true, approved: { base_push: true } }))).includes('start-gate'), true);
  const dry = drive(snap({ tickets: fiveMerged }, { dry: true }));
  t('a dry run says it would start, writes nothing, and holds nothing', j([lines(dry), batchWrites(dry), pending(dry)]), j([['BASE GATE (dry run): would start on feat/x'], [], false]));
  const refused = drive(snap({ tickets: fiveMerged }), { flush: { ok: false, conflicts: [] } });
  t('a refused queue write starts no gate', j([types(refused).includes('start-gate'), lines(refused).at(-1), pending(refused)]),
    j([false, 'BASE GATE: not started on feat/x: its record could not be written to the queue (see the failures above); the next pass tries again', true]));
  const raced = drive(snap({ tickets: fiveMerged }), { flush: { ok: true, conflicts: [{ ticket: null, field: 'gate' }] } });
  t('nor does one whose gate field another writer took', types(raced).includes('start-gate'), false);
}

// The last slice: once every child has settled.
{
  const parked = { key: 'T-9', state: 'parked', park: { question: 'which colour?' } };
  const stopped = drive(snap({ tickets: byKey(merged('T-1'), parked) }, { settled: true }));
  t('a parked child stops the last slice, said in the waiting list', j(lines(stopped, 'report')), j(['BASE GATE: not run, since 1 child(ren) did not finish: T-9 (parked: which colour?). The base is checked once every child has merged into feat/x; promotion PR #50 stays draft']));
  t('and reads no PR state', types(stopped).includes('pr-state'), false);
  const noPr = drive(snap({ tickets: byKey(merged('T-1'), { key: 'T-2', state: 'done', result: {} }) }, { settled: true }));
  t('a child that finished with no PR cannot merge', lines(noPr, 'report')[0], 'BASE GATE: not run, since T-2 (finished with no PR) cannot merge into feat/x: requeue or drop it');
  const open = byKey(merged('T-1'), { key: 'T-2', state: 'done', result: { pr: 2 } });
  const waitDriver = drive(snap({ tickets: open }, { settled: true }), { 'pr-state': (a) => (a.pr === 2 ? 'OPEN' : 'MERGED') });
  t('an open child PR is waited on while a merge driver runs', j([lines(waitDriver), pending(waitDriver)]), j([['BASE GATE: waits on T-2 (PR #2) merging into feat/x'], true]));
  t('each child PR\'s state is read once, in order', j(waitDriver.filter((a) => a.type === 'pr-state').map((a) => a.pr)), '[1,2]');
  const noDriver = drive(snap({ tickets: open }, { settled: true, driverLive: false }), { 'pr-state': (a) => (a.pr === 2 ? 'OPEN' : 'MERGED') });
  t('and put to the person when none runs', lines(noDriver, 'report')[0], 'BASE GATE: waits on T-2 (PR #2) merging into feat/x, and no merge driver is running: merge them');
  const closed = drive(snap({ tickets: open }, { settled: true }), { 'pr-state': (a) => (a.pr === 2 ? 'CLOSED' : 'MERGED') });
  t('a closed child PR cannot merge, and is not waited on', j([lines(closed, 'report'), pending(closed)]), j([['BASE GATE: not run, since T-2 (PR #2 closed without merging) cannot merge into feat/x: requeue or drop it'], false]));
  const all = drive(snap({ tickets: byKey(merged('T-1'), merged('T-2')) }, { settled: true }));
  t('every child merged starts the last slice', JSON.parse(batchWrites(all)[0].slice('gate='.length)).slice.last, true);
  t('saying no why', lines(all)[0].startsWith('BASE GATE: started on feat/x for slice 1: 2 of 2 children, the last (pid 4242)'), true);
}

// A gate that passed, and the promotion PR it holds.
{
  const passed = (fields = {}) => ({ state: 'passed', sha: HEAD, pr: 50, ready: true, slice: { n: 1, keys: ['T-1'], of: 6, last: false }, ...fields });
  const one = byKey(merged('T-1'));
  const ok = drive(snap({ tickets: one, gate: passed(), promotion: { pr: 50, url: 'https://x/50' } }));
  t('a passed gate with its PR ready says so', j([lines(ok), pending(ok)]), j([['BASE GATE: passed on feat/x at aaaaaaaaaaaa (slice 1: 1 of 6 children): every acceptance spec, Typecheck, Lint and Unit tests. Promotion PR #50 is ready for review: https://x/50 (merging it is yours)'], false]));
  t('and asks gh nothing about its PR', types(ok).includes('pr-draft'), false);
  const two = byKey(merged('T-1'), merged('T-2'));
  const redraft = drive(snap({ tickets: two, gate: passed() }));
  t('a child no gate covered puts the ready PR back to draft', j(redraft.filter((a) => ['pr-draft', 'undo-ready'].includes(a.type))), j([{ type: 'pr-draft', pr: 50 }, { type: 'undo-ready', pr: 50 }]));
  t('recorded as redrafted', JSON.parse(batchWrites(redraft)[0].slice('gate='.length)).redrafted, true);
  t('and said', lines(redraft)[0], 'BASE GATE: passed on feat/x at aaaaaaaaaaaa (slice 1: 1 of 6 children), and 1 child(ren) no gate has covered merged into feat/x since, so promotion PR #50 is in draft until the next slice\'s gate passes: https://github.com/o/r/pull/50');
  t('a PR already draft is not undone again', types(drive(snap({ tickets: two, gate: passed() }), { 'pr-draft': { state: 'OPEN', isDraft: true } })).includes('undo-ready'), false);
  const refused = drive(snap({ tickets: two, gate: passed() }), { 'undo-ready': { ok: false, out: 'HTTP 403\nforbidden' } });
  t('a refused undo is put to the person', lines(refused, 'report')[0], 'BASE GATE: promotion PR #50 holds T-2, which no gate has covered, and could not go back to draft (forbidden): gh pr ready 50 --repo o/r --undo. The next pass tries again');
  t('an unread PR is a refused undo too', lines(drive(snap({ tickets: two, gate: passed() }), { 'pr-draft': null }), 'report')[0].includes('(it could not be read)'), true);
  t('a dry run asks gh nothing', types(drive(snap({ tickets: two, gate: passed() }, { dry: true }))).includes('pr-draft'), false);
  t('no promotion PR to mark ready is said', lines(drive(snap({ tickets: one, gate: passed({ pr: null }), promotion: { why: 'refused' } })), 'report')[0],
    'BASE GATE: passed on feat/x at aaaaaaaaaaaa (slice 1: 1 of 6 children), but the batch has no promotion PR to mark ready (refused): open one from feat/x to main');
  t('a PR still draft is said with its note', lines(drive(snap({ tickets: one, gate: passed({ ready: false, note: 'pr-ready is ask' }) })), 'report')[0],
    'BASE GATE: passed on feat/x at aaaaaaaaaaaa (slice 1: 1 of 6 children), but promotion PR #50 is still draft: pr-ready is ask. https://github.com/o/r/pull/50');
  const last = drive(snap({ tickets: one, gate: passed({ close_out: ['AC2'], slice: { n: 1, keys: ['T-1'], of: 1, last: true } }) }, { settled: true }));
  t('the last slice\'s pass is followed by the close-out', lines(last).at(-1), 'close-out: check only AC2 per criterion, which no spec covers; every other criterion\'s spec passed on feat/x');
  const parked = { key: 'T-9', state: 'parked', park: { question: 'q' } };
  const slice = drive(snap({ tickets: byKey(merged('T-1'), parked), gate: passed() }));
  t('a parked child is named as not in the slice, before the gate\'s own line', j(lines(slice)), j(['BASE GATE: not in this slice: T-9 (parked: q)',
    'BASE GATE: passed on feat/x at aaaaaaaaaaaa (slice 1: 1 of 6 children): every acceptance spec, Typecheck, Lint and Unit tests. Promotion PR #50 is ready for review: https://github.com/o/r/pull/50 (merging it is yours)']));
  const stoppedLast = drive(snap({ tickets: byKey(merged('T-1'), merged('T-2'), parked), gate: passed() }, { settled: true }));
  t('a stopped last slice, once its ready PR goes back to draft, says the PR stays draft', lines(stoppedLast, 'report')[0],
    'BASE GATE: the last slice is not run, since 1 child(ren) did not finish: T-9 (parked: q). The base is checked as a whole once every child has merged into feat/x; promotion PR #50 stays draft');
}

// A gate that failed on a conflict.
{
  const conflicted = { state: 'failed', sha: HEAD, pr: 50, redrafted: true, conflict: ['src/a.ts'], slice: { n: 1, keys: ['T-1'], of: 6, last: false } };
  const one = byKey(merged('T-1'));
  const worker = drive(snap({ tickets: one, gate: conflicted }, { conflict: { line: 'src/a.ts conflicts', worker: true } }));
  t('a conflict a fix worker takes is said, and holds', j([lines(worker), pending(worker)]), j([['BASE GATE: failed on feat/x at aaaaaaaaaaaa (slice 1: 1 of 6 children), since main conflicts with feat/x: src/a.ts conflicts. The gate runs again once feat/x moves'], true]));
  const person = drive(snap({ tickets: one, gate: conflicted }, { conflict: { line: 'src/a.ts conflicts', worker: false, said: false } }));
  t('one no fix worker may take goes to the person', lines(person, 'report')[0], 'BASE GATE: failed on feat/x at aaaaaaaaaaaa (slice 1: 1 of 6 children), so promotion PR #50 stays draft: src/a.ts conflicts');
  const said = drive(snap({ tickets: one, gate: conflicted }, { conflict: { line: 'src/a.ts conflicts', worker: false, said: true } }));
  t('once, where the base sync already said it', j([lines(said, 'report'), lines(said).length]), '[[],1]');
}

t('sliceLabel says no slice as null', sliceLabel(undefined), null);

// AC4: the decision starts no process, calls no git, gh or Jira, and writes nothing, the queue included.
{
  const { out, threw, calls } = withNoIo(() => [
    drive(snap({ tickets: fiveMerged })),
    drive(snap({ tickets: fiveMerged, gate: { state: 'failed', sha: HEAD, pr: 50, failures: [] } })),
    drive(snap({ tickets: byKey(merged('T-1'), merged('T-2')), gate: { state: 'passed', sha: HEAD, pr: 50, ready: true, slice: { n: 1, keys: ['T-1'], of: 2 } } }, { settled: true })),
  ].map(types));
  t('AC4 the decision returns its actions', j(out?.map((x) => x.includes('pending') && x.length > 1)), '[true,true,true]');
  t('AC4 and starts no process and writes no file on the way', j([threw, calls]), '[null,[]]');
}

// DS-903: the red base as the batch's record (decideBaseRed), from the merge driver's record of fixture
// check runs: its one line said once, escalated once past its deadline, and cleared once it is green.
{
  const SINCE = '2026-11-18T11:30:00.000Z';
  const minsOn = (m) => new Date(Date.parse(SINCE) + m * 60000).toISOString();
  const red = { branch: 'main', sha: HEAD, checks: [{ name: 'tests', sha: HEAD, url: 'https://github.com/o/r/actions/runs/77' }],
    merges: [{ pr: 802, ticket: 'T-2', sha: MOVED, at: SINCE }, { pr: 801, ticket: 'T-1', sha: HEAD, at: SINCE }], repair_key: 'main-red', since: SINCE, at: SINCE };
  const held = ['#811 (T-11)', '#812 (T-12)', '#813 (T-13)', '#814 (T-14)'];
  const line = batchLine(red, { held, repair: { key: 'main-red', state: 'admitted to start as a slot frees' } });
  const decide = (fields) => decideBaseRed({ recorded: null, red, known: true, line, at: minsOn(5), dry: false, ...fields });
  const recordOf = (as) => JSON.parse(batchWrites(as).find((f) => f.startsWith('base_red='))?.slice('base_red='.length) ?? 'null');
  const notices = (as) => as.filter((a) => a.type === 'notice').map((a) => a.line);

  const first = decide();
  t('AC1 a red base first read is one notice for the batch', notices(first).length, 1);
  t('AC1 naming the check and the two merges desk made', /"tests" \(run https:\/\/github\.com\/o\/r\/actions\/runs\/77\) failed/.test(notices(first)[0]) && notices(first)[0].includes('#802 (T-2), #801 (T-1)'), true);
  t('AC1 and the four PRs it holds on that one line, with no line of their own', `${held.every((h) => notices(first)[0].includes(h))} ${lines(first, 'report').length}`, 'true 0');
  const rec = recordOf(first);
  t('AC1 the batch records it once, with its start and a 60-minute deadline', j(rec), j({ branch: 'main', check: 'tests', since: SINCE, deadline: minsOn(60), merges: [{ pr: 802, ticket: 'T-2' }, { pr: 801, ticket: 'T-1' }] }));

  const again = decide({ recorded: rec, at: minsOn(20) });
  t('AC2 the next pass with the base still red sends no second notice, and writes nothing', j(again), '[]');
  const newSpell = decide({ recorded: rec, red: { ...red, since: minsOn(90) }, at: minsOn(95) });
  t('AC2 a new red spell is a new record and notice', `${notices(newSpell).length} ${recordOf(newSpell)?.since}`, `1 ${minsOn(90)}`);

  const late = decide({ recorded: rec, at: minsOn(75) });
  const esc = recordOf(late);
  t('AC3 past its deadline it is escalated to the person once, with how long it has lasted',
    j([notices(late).length, lines(late, 'report')]), j([0, ['main: RED BASE — it has been red for 75 minutes, since 2026-11-18T11:30:00.000Z, past its 60-minute deadline: tests still fails there, so the merge driver merges nothing into it. The last merges desk made: #802 (T-2), #801 (T-1)']]));
  t('AC3 and the escalation is recorded', esc?.escalated, minsOn(75));
  const later = decide({ recorded: esc, at: minsOn(80) });
  t('AC3 a later pass escalates it no second time: its line stays, the record is not written', j([batchWrites(later), lines(later, 'report').length, /red for 80 minutes/.test(lines(later, 'report')[0])]), j([[], 1, true]));

  t('AC4 once the driver reads it green, the record is cleared', j(batchWrites(decide({ recorded: esc, red: null, line: null }))), j(['base_red=null']));
  t('AC4 with nothing said', j(decide({ recorded: esc, red: null, line: null }).filter((a) => a.type !== 'set-batch')), '[]');
  t('AC4 a stale driver record keeps the batch\'s as it is', j(decide({ recorded: esc, red: null, known: false, line: null })), '[]');
  t('no red base and none recorded: nothing', j(decide({ red: null, line: null })), '[]');
  t('a dry run says the notice and records nothing', j([notices(decide({ dry: true })).length, batchWrites(decide({ dry: true }))]), j([1, []]));
  const r = withNoIo(() => decide());
  t('the decision starts no process and writes no file', j([r.threw, r.calls]), '[null,[]]');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
