// suite: pass phase: report (base drift, the report's lines, the groups and the verdict)
// layer: L1
import { driftCandidates, decideDrift, decideReportOpening, blockedOf, decidePutOffRefresh, decideReportLines, decideGroups, verdictOf, decideVerdict, decideVerdictLines, heldWhyOf, lockHeldLine, crashVerdict, mergeGaps, mergeGapLine } from '../desk/bin/pass/report.mjs';
import { inputsHash, questionKey, lookup } from '../desk/bin/not-now.mjs';
import { HELD_PREFIX } from '../desk/bin/batch-state.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);
// A generator decision's actions, each yield given back what `answer` returns for it.
const drive = (steps, answer) => { const acts = []; for (let r = steps.next(); !r.done; r = steps.next(answer(r.value))) acts.push(r.value); return acts; };
const lines = (acts) =>acts.filter((a) => a.type === 'out' || a.type === 'line').map((a) => a.line);

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));
const emptyReport = () => ({ advanced: [], parked: [], done: [], failed: [], spawned: [], waiting: [], quiet: [], stalled: [], personStalls: [], outOfScope: [], paused: [], unrecognised: [], putOff: [], clears: [], inputs: [], recovered: [] });
const registry = (read, why = null) => ({ read, why, sessions: read ? [] : null, liveSids: read ? new Set() : null });

// ---- base drift
{
  const tickets = byKey([
    { key: 'A', state: 'running', worktree: '/wt/A' },
    { key: 'B', state: 'done', worktree: '/wt/B' },
    { key: 'C', state: 'triaged' },
    { key: 'D', state: 'parked', worktree: '/wt/D' },
    { key: 'E', state: 'running', worktree: '/wt/E' },
    { key: 'F', state: 'running', worktree: '/wt/F' },
  ]);
  t('only tickets still being worked, with a worktree, are counted', j(driftCandidates({ tickets }).map((x) => x.key)), '["A","D","E","F"]');
  const acts = decideDrift({ tickets, branch: 'main', behind: { A: '3', D: '0', E: 'fatal: not a git repository' } });
  t('a worktree behind the default branch is a drift line; level, unreadable or missing ones are not', j(acts),
    j([{ type: 'drift', key: 'A', line: 'A is 3 behind main' }]));
}

// ---- the report's opening
const opening = (fields = {}) => ({
  tickets: {}, registry: registry(true), now: NOW, report: emptyReport(),
  baseLines: [], maintLines: [], dateLines: [], linkLines: [], epicLines: [],
  incidentalBad: null, appendOnlyBad: null, fileBudgetBad: null, conflictRecordBad: null, conflicts: [], unreadableQueues: [],
  concurrency: 2, eligible: 0, queueBin: '/bin/queue.mjs', ...fields,
});
{
  const report = { ...emptyReport(), spawned: ['S'], advanced: ['A1', 'A2'] };
  const got = lines(decideReportOpening(opening({ registry: registry(false, 'its file is not JSON'), report, baseLines: ['base: synced'] })));
  t('AC1 a registry marked unread opens the list of changes, saying no ticket was advanced', got[0], '! could not read the session registry — no ticket was advanced this pass: its file is not JSON');
  t('AC1 and the rest follow it', j(got.slice(1)), j(['base: synced', 'spawned: S', 'advanced: A1 | A2']));
  t('a registry that was read says nothing of it', j(lines(decideReportOpening(opening()))), '[]');
}
{
  const report = { ...emptyReport(), failed: ['F1'], done: ['D1', 'D2'], advanced: ['A1'], spawned: ['S1'] };
  t('AC2 spawned, advanced, done and failed are printed under those labels, in that order',
    j(lines(decideReportOpening(opening({ report })))), j(['spawned: S1', 'advanced: A1', 'done: D1 | D2', 'failed: F1']));
}
{
  const report = { ...emptyReport(), done: ['D'], outOfScope: ['X: a.js', 'Y: b.js'], paused: ['P1', 'P2'], unrecognised: ['odd'], stalled: ['S: 3 passes'], quiet: ['Q1', 'Q2'] };
  const got = lines(decideReportOpening(opening({
    report, baseLines: ['b'], maintLines: ['m'], dateLines: ['d'], linkLines: ['l'], epicLines: ['e1', 'e2'],
    incidentalBad: 'bad incidental', appendOnlyBad: 'bad append', fileBudgetBad: 'bad budget', conflictRecordBad: 'not JSON',
    conflicts: [{ file: 'f.mjs', configured: 3, now: 1, recent: 4 }, { file: 'g.mjs', configured: 2, now: 2, recent: 1 }],
    unreadableQueues: ['other: unreadable'], concurrency: 0, eligible: 2,
  })));
  t('every opening line, in the order the pass gives them', j(got), j([
    'b', 'm', 'd', 'l', 'done: D', 'out of triaged scope (report only):\n  X: a.js\n  Y: b.js',
    'scope: bad incidental — read as the default (lockfiles)',
    'collisions: bad append — read as none, so a shared append-only file still collides',
    'collisions: bad budget — read as 1 for every file, so no two tickets naming one file run at once',
    'collisions: the conflict record was not read (not JSON), so every file runs at its configured budget',
    'collisions: f.mjs runs 1 of its configured 3, after 4 merge-time conflict(s) in the last 7 days',
    'ports: other: unreadable — its running workers\' ports were not skipped',
    'e1', 'e2', 'paused on the usage limit: P1 | P2',
    'unrecognised usage-limit event: odd — not read as a pause, so the stall check applies as before',
    'STALLED:\n  S: 3 passes', 'quiet: Q1, Q2',
    'paused: new spawns are paused by the batch\'s worker count (concurrency 0); 2 triaged ticket(s) wait. Resume with node /bin/queue.mjs set-batch concurrency=<n> concurrency_by=user',
  ]));
  t('a worker count of 0 with nothing triaged waiting is not a pause', j(lines(decideReportOpening(opening({ concurrency: 0, eligible: 0 })))), '[]');
}
{
  const got = lines(decideReportOpening(opening({ fileBudgetBad: 'bad budget', budgetUnread: ['/q/XB-1/queue.json is not valid JSON (x)'], conflictRecordBad: 'not JSON' })));
  t('DS-664 AC4 each other batch whose queue did not read is named after the budget row, as not counted toward the per-file budget', j(got), j([
    'collisions: bad budget — read as 1 for every file, so no two tickets naming one file run at once',
    'collisions: /q/XB-1/queue.json is not valid JSON (x) — that batch\'s running tickets were not counted toward the per-file budget',
    'collisions: the conflict record was not read (not JSON), so every file runs at its configured budget',
  ]));
}

// ---- the report's lines after the promotion ledger
const after = (fields = {}) => ({
  tickets: {}, registry: registry(true), now: NOW, report: emptyReport(), drift: [], answerBin: '/bin/answer.mjs',
  base: null, source: 'main', promotion: undefined, overrides: [], overridesSeen: [], reviewClash: null, reviewSeen: '',
  blocked: [], heldBack: [], resumeRows: [], register: { ok: true, entries: new Map() }, askedAgain: [], ...fields,
});
{
  const heldBack = [{ key: 'H-1', holds: [{ file: 'pass.mjs', by: ['R-1'], elsewhere: [{ key: 'X-1', label: 'batch XB-1' }, { key: 'X-2', label: 'the standing batch' }], k: 3 }] }];
  t('DS-664 AC1 a held ticket names the tickets running in other batches after its own batch\'s, each with its batch',
    lines(decideReportLines(after({ heldBack })))[0], 'held back by a collision: H-1 (pass.mjs has 3 running of its 3: R-1, X-1 in batch XB-1, X-2 in the standing batch)');
}
{
  const tickets = byKey([
    { key: 'H', merged_at: '2026-11-18T10:00:00Z', promotion_hold: 'run the migration', result: { pr: 9 } },
    { key: 'G', merged_at: '2026-11-18T09:00:00Z', promotion_hold: 'old', result: { pr: 8 } },
  ]);
  const acts = decideReportLines(after({ tickets, base: 'feat/x', promotion: { pr: 40, since: '2026-11-18T09:30:00Z' }, report: { ...emptyReport(), waiting: ['W: earlier'] } }));
  t('a merge hold since the last promotion is waiting on the person, after what was already waiting', j(acts), j([
    { type: 'report', list: 'waiting', line: 'promotion PR #40: only a person merges it, after the §4 Merge holds its children carry — H (#9): run the migration' },
    { type: 'out', line: 'WAITING ON YOU:\n  W: earlier\n  promotion PR #40: only a person merges it, after the §4 Merge holds its children carry — H (#9): run the migration' },
  ]));
  t('with no promotion PR yet, the hold names the base and the default branch',
    lines(decideReportLines(after({ tickets, base: 'feat/x' })))[0].split(':')[0], 'WAITING ON YOU');
  t('...and its line', decideReportLines(after({ tickets, base: 'feat/x' }))[0].line.slice(0, 18), 'feat/x into main: ');
  t('a promotion recorded merged holds nothing', j(decideReportLines(after({ tickets, base: 'feat/x', promotion: { pr: 40, merged: [{ pr: 40 }] } }))), '[]');
  t('a batch with no base of its own holds nothing', j(decideReportLines(after({ tickets }))), '[]');
}
{
  const overrides = [
    { id: 'o1', ticket: 'K-1', question: 'Q?', chose: 'b', was: 'a', by: 'Ben', at: '2026-11-18' },
    { id: 'o2', ticket: 'K-2', question: 'R?', chose: 'd', was: 'c', by: 'Ben', at: '2026-11-18' },
  ];
  const acts = decideReportLines(after({ overrides, overridesSeen: ['o1'] }));
  t('an override not yet listed is waiting on the person once, and recorded as listed', j(acts.map((a) => a.type)), '["report","seen","out"]');
  t('...its line', acts[0].line, 'K-2: decision overridden — "R?" is now "d" (was "c"), by Ben at 2026-11-18');
  t('...and the seen-file keeps both ids', j(acts[1]), j({ type: 'seen', file: 'overrides-reported.json', text: '["o1","o2"]\n' }));
  t('every override already listed says nothing', j(decideReportLines(after({ overrides, overridesSeen: ['o1', 'o2'] }))), '[]');
}
{
  t('a review-row clash is logged once, and recorded', j(decideReportLines(after({ reviewClash: 'X never reads clean' }))),
    j([{ type: 'out', line: 'review rows: X never reads clean' }, { type: 'seen', file: 'review-rows-reported.txt', text: 'X never reads clean' }]));
  t('the same clash again says nothing', j(decideReportLines(after({ reviewClash: 'X never reads clean', reviewSeen: 'X never reads clean' }))), '[]');
}
{
  const got = lines(decideReportLines(after({
    blocked: [{ key: 'B-1', open_questions: 2 }],
    heldBack: [{ key: 'H-1', holds: [{ file: 'pass.mjs', by: ['R-1', 'R-2'], k: 2 }] }],
    resumeRows: [
      { key: 'R-1', resume: 'pending', resume_why: 'killed by OOM', toResume: true, rebootWait: null },
      { key: 'R-2', resume: 'reboot', resume_why: 'stopped for a planned reboot', toResume: true, rebootWait: 'stopped for a planned reboot, resumed after the computer restarts' },
      { key: 'R-3', resume: 'reboot', resume_why: 'stopped', toResume: true, rebootWait: null },
      { key: 'R-4', resume: null, toResume: false, rebootWait: null },
    ],
    report: { ...emptyReport(), parked: ['P-1: q'], clears: ['c'], recovered: ['r'], inputs: ['i'], putOff: ['p'] },
    drift: ['A is 3 behind main', 'B is 1 behind main'],
  })));
  t('the waits, parks and drift, in the order the pass gives them', j(got), j([
    'BLOCKED ON ANSWERS: B-1 (2)\n  answer with: node /bin/answer.mjs <TICKET> "<answer>"',
    'held back by a collision: H-1 (pass.mjs has 2 running of its 2: R-1, R-2)',
    'waiting to resume (killed; resumed ahead of new tickets when a slot frees): R-1 (killed by OOM), R-3 (stopped)',
    'waiting for the reboot: R-2 (stopped for a planned reboot, resumed after the computer restarts)',
    'PARKED:\n  P-1: q', 'clears-when:\n  c', 'recovered:\n  r', 'park inputs:\n  i',
    'put off, so not asked again until their inputs change (the digest lists them):\n  p',
    'base drift: A is 3 behind main, B is 1 behind main',
  ]));
}
{
  const at = '2026-11-10T09:00:00.000Z';
  const was = { 'pr-head': 'aaa' };
  const register = { ok: true, entries: new Map([[questionKey('Q?'), { hash: inputsHash(was), inputs: was, by: 'Ben', at }]]) };
  const reads = { 'P-1': { 'pr-head': 'bbb' }, 'P-2': was };
  const refresh = drive(decidePutOffRefresh({ putOff: [
    { key: 'P-1', question: 'Q?', inputs: was, branch: 'fix/P-1' },
    { key: 'P-2', question: 'Q?', inputs: was, branch: 'fix/P-2' },
  ] }), (a) => (a.type === 'read-inputs' ? reads[a.key] : undefined));
  t('a put-off park whose input changed gets its refreshed inputs; one unchanged does not',
    j(refresh.filter((a) => a.type === 'park-inputs')), j([{ type: 'park-inputs', key: 'P-1', question: 'Q?', inputs: { 'pr-head': 'bbb' } }]));
  t('...each park is read again and its write staged before the next park is read',
    j(refresh.map((a) => `${a.type}:${a.key}`)), '["read-inputs:P-1","park-inputs:P-1","read-inputs:P-2"]');
  t('...and a read names the park\'s inputs and branch', j(refresh[0]), j({ type: 'read-inputs', key: 'P-1', inputs: was, branch: 'fix/P-1' }));
  const acts = decideReportLines(after({ register, askedAgain: [{ key: 'P-1', question: 'Q?', now: { 'pr-head': 'bbb' } }] }));
  t('a put-off park asked again is reported, and writes nothing more', j(acts.map((a) => `${a.type}:${a.key ?? ''}`)), '["report:P-1","out:"]');
  t('...and it is listed under PARKED, saying what changed', acts[1].line, `PARKED:\n  P-1: Q? — ${lookup(register, { question: 'Q?', inputs: { 'pr-head': 'bbb' } }).line}`);
  t('...which is a changed line', /^Changed since Ben put it off/.test(acts[0].line.split(' — ')[1]), true);
}
t('blocked on answers: triaged tickets with questions open',
  j(blockedOf([{ key: 'A', state: 'triaged', open_questions: 1 }, { key: 'B', state: 'triaged', open_questions: 0 }, { key: 'C', state: 'parked', open_questions: 2 }, { key: 'D', state: 'triaged' }]).map((x) => x.key)), '["A"]');

// ---- groups
{
  const tickets = byKey([{ key: 'A', group: { g: 'Running', at: 'T0' } }, { key: 'B', group: { g: 'Merging', at: 'T1' } }, { key: 'C' }]);
  t('a row whose group changed records it with the one it left; one unchanged is not written',
    j(decideGroups({ tickets, at: 'T2', groups: { A: 'Merging', B: 'Merging', C: 'Queued' } })), j([
      { type: 'set', key: 'A', fields: ['group={"g":"Merging","at":"T2","from":"Running","from_at":"T0"}'] },
      { type: 'set', key: 'C', fields: ['group={"g":"Queued","at":"T2","from":null,"from_at":null}'] },
    ]));
  t('groups that could not be read are said, and nothing is written', j(decideGroups({ tickets, at: 'T2', groupsError: 'ENOENT' })),
    j([{ type: 'out', line: 'groups: not recorded this pass (ENOENT)' }]));
}

// ---- verdict
const vsnap = (tickets, fields = {}) => {
  const queue = { tickets: byKey(tickets), ...(fields.queue ?? {}) };
  return { tickets: queue.tickets, queue, report: emptyReport(), blocked: [], putOff: new Set(), parkNotes: new Map(), prStates: {},
    gatePending: false, epicPending: false, promotionPending: false, spawned: 0, slug: 'o__r', ...fields, queue };
};
{
  const tickets = [
    { key: 'P-1', state: 'parked', park: { question: 'Which copy?' } },
    { key: 'P-2', state: 'parked', park: { question: `${HELD_PREFIX}X` } },
    { key: 'P-3', state: 'parked', park: { question: 'put off' } },
    { key: 'P-4', state: 'parked', park: { question: 'PRODUCTION BROKEN: checkout is down' } },
    { key: 'R-1', state: 'running' },
  ];
  const s = vsnap(tickets, { putOff: new Set(['P-3']), parkNotes: new Map([['P-1', 'a note']]),
    report: { ...emptyReport(), failed: ['F-1: crashed'], waiting: ['W-1: merge it'] }, blocked: [{ key: 'B-1', open_questions: 2 }] });
  const v = verdictOf(s);
  t('waiting is the failures, WAITING ON YOU and the open questions', j(v.waiting), j(['F-1: crashed', 'W-1: merge it', 'B-1: 2 question(s) open — answer with answer.mjs B-1 "<answer>"']));
  t('parked is every park for its own reason: not a hold, nor one put off', j(v.parked), j([
    { key: 'P-1', question: 'Which copy?', note: 'a note' }, { key: 'P-4', question: 'PRODUCTION BROKEN: checkout is down' }]));
  t('a running ticket is not idle, and parks show the person', j([v.idle, v.status]), '[false,"show_person"]');
  t('the verdict names each item that needs the person, and pushes the production-broken park now', j(decideVerdict(s)), j([
    { type: 'line', line: 'NOTIFY: 5 item(s) need you — P-1, P-4, F-1, W-1, B-1' },
    { type: 'push', push: { key: 'urgent:o__r:P-4', text: 'P-4: PRODUCTION BROKEN: checkout is down' } },
  ]));
}
{
  // DS-852: a park a pass settles waits on the pass, not the person; one only the person settles does not.
  const waits = (key, clears_when) => ({ key, state: 'parked', lane: 'A', park: { question: `${key}?`, clears_when } });
  const s = vsnap([
    waits('S-1', { kind: 'run-completed', run: 44719886024 }),
    waits('S-2', { kind: 'none' }),
    waits('S-3', { kind: 'links-made', links: [{ key: 'S-3', type: 'Relates', other: 'S-9' }], pr: 12 }),
    waits('S-4', { kind: 'file-exists', path: 'a.json', root: 'state', person: true }),
    waits('S-5', { kind: 'live-read', reads: ['gateway-models'] }),
    waits('S-6', { kind: 'checks-pass', pr: 7, checks: ['tests'] }),
  ]);
  const v = verdictOf(s);
  t('DS-852 AC1 a park on a run or checks, or a live read, is not parked for the person', j(v.parked.map((p) => p.key)), j(['S-2', 'S-3', 'S-4']));
  t('DS-852 AC1, AC3, AC4 NOTIFY names a park on none or one only the person settles, never one on a run', lines(decideVerdict(s))[0], 'NOTIFY: 3 item(s) need you — S-2, S-3, S-4');
  // A clears-when still to be restated stays in `parked`: that is how the decider is asked to restate it.
  const u = vsnap([waits('U-1', { kind: 'unreadable', text: 'when the deploy looks fine', at: '2026-11-20T10:00:00Z' })]);
  t('DS-852 an unreadable clears-when stays parked, for the decider to restate', j(verdictOf(u).parked.map((p) => p.key)), j(['U-1']));
  // A park on a PR merging whose PR conflicts with its base (a park note) is the person's: it cannot merge on its own.
  const c = vsnap([waits('C-1', { kind: 'pr-merged', pr: 12 })], { parkNotes: new Map([['C-1', 'PR #12 conflicts with main']]) });
  t('DS-852 a park on a conflicting PR is parked for the person, with its note', j(verdictOf(c).parked), j([{ key: 'C-1', question: 'C-1?', note: 'PR #12 conflicts with main' }]));
  t('DS-852 without the note, a park on a PR merging is the pass\'s', j(verdictOf(vsnap([waits('C-1', { kind: 'pr-merged', pr: 12 })])).parked), '[]');
  // A production-broken park is pushed whatever it waits on.
  const pb = vsnap([{ key: 'S-7', state: 'parked', lane: 'A', park: { question: 'PRODUCTION BROKEN: checkout is down', clears_when: { kind: 'run-completed', run: 9 } } }]);
  t('DS-852 a production-broken park on a run is still pushed', j(decideVerdict(pb).filter((a) => a.type === 'push')),
    j([{ type: 'push', push: { key: 'urgent:o__r:S-7', text: 'S-7: PRODUCTION BROKEN: checkout is down' } }]));
  // An idle batch whose only park waits on a run is not finished.
  const idleRun = vsnap([waits('S-1', { kind: 'run-completed', run: 44719886024 }), { key: 'D-1', state: 'done', result: { pr: 5 } }], { prStates: { 5: 'MERGED' } });
  t('DS-852 AC1 an idle batch waiting on a run is idle', verdictOf(idleRun).idle, true);
  t('DS-852 AC1 its NOTIFY line names no ticket and does not call the batch finished', j(lines(decideVerdict(idleRun))),
    j(['NOTIFY: nothing needs you — 1 park(s) wait on a condition a pass checks, and are requeued once it holds']));
}
{
  const done = vsnap([{ key: 'D-1', state: 'done', result: { pr: 5 } }], { prStates: { 5: 'MERGED' } });
  t('every done ticket merged is idle', j([verdictOf(done).idle, verdictOf(done).status]), '[true,"idle"]');
  t('...and says the batch is finished', j(lines(decideVerdict(done))), j(['NOTIFY: the batch is finished — nothing left to run']));
  t('a promotion still to come is not idle', verdictOf({ ...done, promotionPending: true }).idle, false);
  t('DS-550 a preview database still to delete is not idle, so its pass keeps running', verdictOf({ ...done, previewDbPending: true }).idle, false);
  t('a done ticket whose PR is still open is not idle', verdictOf(vsnap([{ key: 'D-1', state: 'done', result: { pr: 5 } }], { prStates: { 5: 'OPEN' } })).idle, false);
  const quiet = vsnap([{ key: 'R-1', state: 'running' }]);
  t('nothing waiting and nothing spawned is nothing yet', verdictOf(quiet).status, 'nothing_yet');
  t('a spawn with nothing waiting goes on', verdictOf({ ...quiet, spawned: 1 }).status, 'go_on');
  t('with nothing to say, there is no NOTIFY line', j(decideVerdict(quiet)), '[]');
}
{
  const s = { push: [{ text: 'digest' }, { text: 'urgent' }], out: ['a', 'b'], footer: ['health', 'pace'], idle: false };
  t('the output: each push, the list of changes, the footer, then the table\'s place', j(decideVerdictLines(s)), j([
    { type: 'line', line: 'PUSH: digest' }, { type: 'line', line: 'PUSH: urgent' }, { type: 'line', line: 'a\nb' },
    { type: 'line', line: 'health' }, { type: 'line', line: 'pace' }, { type: 'line', line: '' }, { type: 'table' },
  ]));
  t('an empty list of changes says so', lines(decideVerdictLines({ ...s, push: [], out: [] }))[0], 'no change this pass');
  const queue = { tickets: byKey([{ key: 'A', state: 'done', out_of_scope: ['x.js', 'y.js'], resumes: 1 }, { key: 'B', state: 'done', out_of_scope: [] }]) };
  const idle = lines(decideVerdictLines({ ...s, push: [], idle: true, queue, costTable: 'COST' }));
  t('an idle batch adds IDLE, the scope totals, the resumes and the cost', j(idle.slice(-4)), j([
    '\nIDLE — every ticket is done, parked, or failed, none is held waiting on a merge, and every done ticket\'s PR is merged or closed (or it finished with no PR). Nothing left to spawn or merge.',
    'scope: 1 of 2 checked ticket(s) changed files outside their triaged scope, 2 file(s) in all (report only)',
    'resumed after a kill: A 1 time(s) (done)', 'COST']));
}
{
  const free = { spawned: 0, eligible: 2, held: null, baseHold: false, baseLag: null, lowMemory: false, availGB: 9, minAvailGB: 6,
    lockQueueHeldText: null, machine: { room: 1, line: 'm' }, repoUnlocked: false, repoLine: 'r', repo: { room: 1, line: 'R' }, concurrency: 2 };
  t('a spawn, or nothing eligible, holds nothing', j([heldWhyOf({ ...free, spawned: 1 }), heldWhyOf({ ...free, eligible: 0 })]), '[null,null]');
  t('the first hold that applied names why', j([
    heldWhyOf({ ...free, held: 'usage' }), heldWhyOf({ ...free, baseHold: true, baseLag: '30 behind' }), heldWhyOf({ ...free, lowMemory: true, availGB: 3.21 }),
    heldWhyOf({ ...free, lockQueueHeldText: 'the lock queue' }), heldWhyOf({ ...free, machine: { room: 0, line: 'm 9/9' } }),
    heldWhyOf({ ...free, repoUnlocked: true }), heldWhyOf({ ...free, repo: { room: 0, line: 'R 3/3' } }), heldWhyOf({ ...free, concurrency: 0 }), heldWhyOf(free),
  ]), j(['usage', 'the batch base sync holds every spawn: 30 behind', 'memory: 3.2G available, under the 6G spawn gate', 'the lock queue',
    'the machine budget: m 9/9', 'the repo\'s shared cap: r', 'the repo\'s shared cap: R 3/3', 'the batch\'s worker count is 0', null]));
  t('a harm signal is named rather than avail', heldWhyOf({ ...free, lowMemory: true, harmWhy: 'memory harm: OOM-KILL within the last 10m (…)' }), 'memory harm: OOM-KILL within the last 10m (…)');
}
// #1480: the tickets the lock-queue gate held read as a stall only while a run waits on a queue.
{
  const q = (lock, waiting) => ({ lock, waiting, line: `${lock} lock queue: ${waiting} run(s) waiting on its 1 slot(s)` });
  const gate = (...queues) => ({ ...queues[0], room: 1, queues });
  t('#1480 nothing held, no line', lockHeldLine({ gate: gate(q('test', 3)), held: [], running: 2, concurrency: 3 }), null);
  t('#1480 AC2 with live waiters the stall names the lock queue and its live count', j(lockHeldLine({ gate: gate(q('light', 1), q('test', 0)), held: ['A', 'B'], running: 2, concurrency: 3 })),
    j({ stall: true, line: 'light lock queue: 1 run(s) waiting on its 1 slot(s): holding new workers and resumes into Stage 4 (A, B), past the 1 this pass had room for' }));
  t('#1480 with no run waiting on any lock, the hold is no stall: it names this pass\'s own starts and the workers against the cap', j(lockHeldLine({ gate: gate(q('light', 0), q('test', 0)), held: ['A'], running: 2, concurrency: 5 })),
    j({ stall: false, line: 'held for the next pass, not a stall (A): no run is waiting on the lock, and this pass already started the 1 suite-bound session(s) it may start at once; 2 worker(s) running against the batch\'s cap of 5' }));
}

// AC4: each decision returns its actions without starting a process, calling git, gh or Jira, or
// writing anything, the queue included.
{
  const { out, threw, calls } = withNoIo(() => {
    const tickets = byKey([{ key: 'A', state: 'running', worktree: '/wt/A' }, { key: 'P', state: 'parked', park: { question: 'Q?' } }]);
    return [
      decideDrift({ tickets, branch: 'main', behind: { A: '2' } }),
      decideReportOpening(opening({ registry: registry(false, 'x'), report: { ...emptyReport(), spawned: ['A'] } })),
      drive(decidePutOffRefresh({ putOff: [{ key: 'P', question: 'Q?', inputs: { 'pr-head': 'a' }, branch: 'fix/P' }] }), () => ({ 'pr-head': 'b' })),
      decideReportLines(after({ overrides: [{ id: 'o', ticket: 'A', question: 'q', chose: 'b', was: 'a', by: 'x', at: 'y' }], reviewClash: 'c' })),
      decideGroups({ tickets, at: 'T', groups: { A: 'Running' } }),
      decideVerdict(vsnap(Object.values(tickets))),
      decideVerdictLines({ push: [], out: ['a'], footer: [], idle: true, queue: { tickets }, costTable: null }),
    ];
  });
  t('AC4 each decision returns its actions', j(out?.map((acts) => acts.length)), '[1,2,2,5,1,1,5]');
  t('AC4 and starts no process and writes no file on the way', j([threw, calls]), '[null,[]]');
}

// ---- a crash's verdict
{
  const crash = 'pass.mjs crashed: desk: config §4 "Evidence workflow" mixes none with other items';
  const r = { ...emptyReport(), spawned: ['C-1 port=3201 model=default', 'C-2 port=3202 model=default'], parked: ['C-3: needs a fixture'] };
  const got = crashVerdict(crash, r);
  t('DS-843 AC1 a crash after spawning says so under the message and names each ticket it spawned', got.message,
    `${crash}\nbefore it stopped, this pass spawned:\n  C-1 port=3201 model=default\n  C-2 port=3202 model=default\nbefore it stopped, this pass parked:\n  C-3: needs a fixture`);
  t('DS-843 AC2 the JSON fields list the spawned tickets under a top-level `spawned`, and parks apart from the decider\'s `parked`', j(got.fields),
    j({ spawned: ['C-1 port=3201 model=default', 'C-2 port=3202 model=default'], parked_this_pass: ['C-3: needs a fixture'] }));
  t('DS-843 AC3 a crash before anything was done is the message alone, with no fields', j(crashVerdict(crash, emptyReport())), j({ message: crash, fields: {} }));
  t('DS-843 AC3 and so is one before the report exists', j(crashVerdict(crash, null)), j({ message: crash, fields: {} }));
}

// ---- DS-899 AC4: a merge an older caller recorded with no PR is reported, once per ticket
{
  const merge = (pr) => ({ by: null, pr, head_sha: null, base: null, at: '2026-11-21T09:00:00.000Z' });
  t('DS-899 AC4 one merge with its PR missing is one line naming it',
    mergeGapLine([{ key: 'A', merge: merge(null) }, { key: 'B', merge: merge(12) }, { key: 'C' }]),
    'merges: 1 recorded with the PR missing (A): queue.mjs merged was run with no --pr, so the merge names no PR');
  t('DS-899 AC4 no such merge, no line', mergeGapLine([{ key: 'B', merge: merge(12) }, { key: 'C', merged_at: '2026-11-21T09:00:00.000Z' }]), null);
  const kept = [{ key: 'A', merge: merge(null) }, { key: 'B', merge: merge(12) }];
  t('DS-899 AC4 the pass records the merge it named', j(mergeGaps(kept)), j(['A@2026-11-21T09:00:00.000Z']));
  t('DS-899 AC4 a later pass, the ticket still live, does not name it again', mergeGapLine(kept, mergeGaps(kept)), null);
  t('DS-899 AC4 but names a later merge of it with its PR missing',
    mergeGapLine([{ key: 'A', merge: { ...merge(null), at: '2026-11-22T09:00:00.000Z' } }], mergeGaps(kept)),
    'merges: 1 recorded with the PR missing (A): queue.mjs merged was run with no --pr, so the merge names no PR');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
