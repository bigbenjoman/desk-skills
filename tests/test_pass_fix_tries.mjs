// suite: pass phase: fix tries (the decision, run through the generator runner)
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideFixTries, tryLabel } from '../desk/bin/pass/fix-tries.mjs';
import { reviewerGated } from '../desk/bin/pass/shared.mjs';
import { parseOperatorChecks } from '../desk/bin/fix-tries.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const HEAD = 'a'.repeat(40);
const ok = (name) => ({ name, status: 'completed', conclusion: 'success', runId: '1' });
const red = (name, runId) => ({ name, status: 'completed', conclusion: 'failure', runId });
const pr = (checks, o = {}) => ({ pr: 697, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeState: 'BLOCKED', head: HEAD, checks, ...o });
const dirtyPr = (o = {}) => pr([ok('tests')], { mergeable: 'CONFLICTING', mergeState: 'DIRTY', pr: 704, ...o });
const redPr = () => pr([ok('tests'), red('Backend tests', '901'), red('Lint', '902')]);
const tk = (o = {}) => ({ key: 'T-1', branch: 'task/T-1', ...o });
const { checks: operator } = parseOperatorChecks(['Flows image missing: build it: ensure-flows-image.sh']);
const GATE = { required: ['tests'], advisory: [] };
const yes = { perm: 'yes', key: 'Resolve a ready PR\'s conflict' };
const snap = (undrafted, fields = {}) => ({
  undrafted: undrafted.map(([tt, s]) => ({ t: tt, s })), rowErrors: [], dry: false, base: 'main', reviewer: null, gate: GATE, stateChecks: [],
  conflictRows: { 'pr-conflict-reviewed': yes, 'pr-conflict-unreviewed': yes }, feedbackFirst: true, judgement: 'yes', ...fields,
});
// The ctx fixCall reads, as the pass's `reads` handler builds it: every check rerun twice, the last
// rerun's gap over.
const ctx = (o = {}) => ({ repo: 'acme/widgets', base: 'main', ...GATE, operator, builds: [], premerge: [], stateChecks: [], reruns: () => 2, cooledDown: true, waived: () => false, conflictFiles: () => ['src/a.ts'], ...o });
const reads = (o = {}) => ({ ctx: ctx(o.ctx), baseMerge: () => false, moves: () => ({ carry: () => false, scope: () => null, baseMerge: () => false }), comments: () => [], atHead: () => null, ...o.reads });

// The runner with stub handlers: each read answers from `answers` (a value, or a function of the
// action), else from what a quiet pass reads.
const READS = { 'conflict-files': ['src/a.ts'], 'note-conflict': null, 'human-seen': false, reads: () => reads(), feedback: null, 'settle-worked': [], 'check-build': null };
const WRITES = ['set', 'report', 'out', 'gate-hold', 'apply'];
function drive(s, answers = {}) {
  const handlers = Object.fromEntries([...Object.keys(READS), ...WRITES].map((type) => [type, (a) => {
    const v = Object.hasOwn(answers, type) ? answers[type] : READS[type];
    return typeof v === 'function' ? v(a) : v;
  }]));
  const report = { failed: [] };
  const actions = runSteps({ name: 'fix tries', snapshot: () => s, decide: decideFixTries, handlers, report });
  if (report.failed.length) { fails++; console.log(`FAIL a handler was missing: ${j(report.failed)}`); }
  return actions;
}
const types = (as) => as.map((a) => a.type);
const applied = (as) => as.filter((a) => a.type === 'apply');
const lines = (as, type = 'out') => as.filter((a) => a.type === type).map((a) => a.line);

// AC1: a ready PR in conflict with its base and no fix try yet gets one fix-worker action.
{
  const as = drive(snap([[tk(), dirtyPr()]]));
  t('AC1 a conflicted ready PR with no try yet returns one fix-worker action', applied(as).length, 1);
  const c = applied(as)[0]?.call;
  t('AC1 it is try 1 of 2 of a conflict fix, for that PR at its head', j([c?.call, c?.fix?.kind, c?.fix?.try, c?.fix?.of, c?.fix?.pr, c?.fix?.head === HEAD]), j(['requeue', 'conflict', 1, 2, 704, true]));
  t('AC1 its conflicting files are read and noted first, then who has seen it', j(types(as)), j(['conflict-files', 'note-conflict', 'gate-hold', 'human-seen', 'reads', 'apply']));
  t('AC1 the files noted are the ones git named', j(as.find((a) => a.type === 'note-conflict').entry), j({ files: ['src/a.ts'], ticket: 'T-1', pr: 704, head: HEAD }));
  const noted = drive(snap([[tk(), dirtyPr()]]), { 'note-conflict': 'conflicts: PR #704 (T-1) is in conflict, but its files could not be worked out' });
  t('a conflict record that was not written is said', lines(noted)[0], 'conflicts: PR #704 (T-1) is in conflict, but its files could not be worked out');
  // Under a §3 row that is not yes, no worker resolves it.
  const asked = drive(snap([[tk(), dirtyPr()]], { conflictRows: { 'pr-conflict-reviewed': yes, 'pr-conflict-unreviewed': { perm: 'ask', key: 'Resolve an unreviewed PR\'s conflict' } } }));
  t('a conflict under a row that is not yes gets no try', applied(asked).length, 0);
  t('and says what the person does', lines(asked, 'report')[0], 'T-1: CONFLICT — PR #704 is out of draft and conflicts with main, and config §3 Resolve an unreviewed PR\'s conflict is "ask", so no fix worker resolves it: resolve it on the PR\'s branch and push');
  const seen = drive(snap([[tk(), dirtyPr()]], { conflictRows: { 'pr-conflict-reviewed': yes, 'pr-conflict-unreviewed': { perm: 'ask', key: 'x' } } }), { 'human-seen': true });
  t('a PR a person has seen reads the reviewed row', applied(seen).length, 1);
}

// #737: with merge-feedback-first on, a red check reading an outside reviewer's review goes ahead of the
// feedback route: a stale changes-requested decision from that reviewer's older review, after a feedback
// try, waits for its review of the new head rather than going to the person.
{
  const EXT = [{ name: '🔐 Review gate', kind: 'external', login: 'agent-pullbot' }];
  const OLD = 'b'.repeat(40);
  const payload = { data: { repository: { pullRequest: { headRefOid: HEAD, reviewDecision: 'CHANGES_REQUESTED',
    reviews: { nodes: [{ id: 'R1', author: { login: 'agent-pullbot' }, body: 'P0: drops the row', state: 'CHANGES_REQUESTED', commit: { oid: OLD } }] }, reviewThreads: { nodes: [] } } } } };
  const fb = { decision: 'CHANGES_REQUESTED', head: HEAD, verdict: null, review: null, resolve: [], left: [], payload };
  const tried = tk({ fix_tries: [{ try: 1, of: 2, head: OLD, kind: 'feedback', what: 'review feedback: changes requested' }] });
  const as = drive(snap([[tried, pr([ok('tests'), red('🔐 Review gate', '88')])]], { stateChecks: EXT }), { feedback: fb, reads: () => reads({ ctx: { stateChecks: EXT } }) });
  t('#737 a stale changes-requested from the outside reviewer waits for its next review, not the person', applied(as).length, 0);
  const at = { ...payload, data: { repository: { pullRequest: { ...payload.data.repository.pullRequest, reviews: { nodes: [{ id: 'R2', author: { login: 'agent-pullbot' }, body: 'P1: still drops it', state: 'CHANGES_REQUESTED', commit: { oid: HEAD } }] } } } } };
  const as2 = drive(snap([[tried, pr([ok('tests'), red('🔐 Review gate', '88')])]], { stateChecks: EXT }), { feedback: { ...fb, payload: at }, reads: () => reads({ ctx: { stateChecks: EXT } }) });
  const c = applied(as2)[0]?.call;
  t('#737 its review of the new head goes to a feedback try marked for it, with its text', `${c?.call} ${c?.fix?.kind} ${c?.fix?.external?.login} ${c?.fix?.threads?.[0]?.text.startsWith("agent-pullbot's review at the head: P1")}`, 'requeue feedback agent-pullbot true');
}

// AC2: failed after two fix tries not spent on red checks naming a cause: stuck, and no third try.
{
  const two = [{ try: 1, head: 'b'.repeat(40), kind: 'checks', what: 'red: Lint' }, { try: 2, head: 'c'.repeat(40), kind: 'checks', what: 'red: Lint' }];
  const as = drive(snap([[tk({ fix_tries: two }), redPr()]]));
  const c = applied(as)[0]?.call;
  t('AC2 after two tries it returns a stuck record', j([applied(as).length, c?.call, c?.why]), j([1, 'stuck', 'still red after 2 fix tries: Backend tests, Lint']));
  t('AC2 and no third try', as.some((a) => a.type === 'apply' && a.call.call === 'requeue'), false);
  const first = drive(snap([[tk(), redPr()]]));
  t('a red PR with no try yet gets try 1', j([applied(first)[0]?.call.call, applied(first)[0]?.call.fix.try]), j(['requeue', 1]));
  t('a red PR is not read for conflicts or reviewers', j(types(first)), j(['gate-hold', 'reads', 'apply']));
}

// AC4: the decision starts no process, calls no git, gh or Jira, and writes nothing.
{
  const two = [{ try: 1, head: 'b'.repeat(40), kind: 'checks' }, { try: 2, head: 'c'.repeat(40), kind: 'checks' }];
  const r = withNoIo(() => types(drive(snap([[tk(), dirtyPr()], [tk({ key: 'T-2', fix_tries: two }), redPr()], [tk({ key: 'T-3' }), pr([ok('tests')])]]))));
  t('AC4 the decision returns its actions with no process started or file written', j([r.threw, r.calls]), j([null, []]));
  t('AC4 and returns them', r.out?.filter((x) => x === 'apply').length, 2);
}

// Config rows that do not parse make no try at all.
{
  const as = drive(snap([[tk(), dirtyPr()]], { rowErrors: ['§4 State checks does not parse: x (want y)'] }));
  t('a row that does not parse says so once, and makes no try', j(as), j([{ type: 'out', line: 'fix tries: none this pass, since config §4 State checks does not parse: x (want y). Run /desk-setup' }]));
  t('with no ready PR it says nothing', j(drive(snap([], { rowErrors: ['x'] }))), '[]');
}

// The reviewer check: a PR red only on a verdict state check, with the reviewer check failing, is held.
{
  const verdictPr = pr([ok('tests'), red('desk-review', '9')]);
  const s = snap([[tk(), verdictPr]], { reviewer: { key: 'reviewer', why: 'the account is not counted' }, gate: { required: ['tests', 'desk-review'], advisory: [] }, stateChecks: [{ name: 'desk-review', kind: 'verdict' }] });
  t('reviewerGated reads that PR as held', reviewerGated(verdictPr, s), true);
  t('and not with no failing reviewer check', reviewerGated(verdictPr, { ...s, reviewer: null }), false);
  const as = drive(s);
  t('a held PR reads its review, with gate reviewers\' counted, then marks its hold and gets nothing else', j(as), j([{ type: 'reads', key: 'T-1', dirty: false, dirtyFiles: null }, { type: 'feedback', key: 'T-1', pr: 697, gate: true }, { type: 'gate-hold', key: 'T-1', on: true }]));
}

// Held only because the gate counts another account, a head the merge driver would hold for want
// of a clean verdict still gets its review try while the gate is red.
{
  const verdictPr = pr([ok('tests'), red('desk-review', '9')]);
  const base = { gate: { required: ['tests', 'desk-review'], advisory: [] }, stateChecks: [{ name: 'desk-review', kind: 'verdict' }] };
  const s = snap([[tk(), verdictPr]], { ...base, reviewer: { key: 'reviewer', kind: 'mismatch', why: 'the gate counts another account' } });
  const fb = { head: HEAD, left: [], decision: null, review: null, payload: {} };
  const stale = { clean: false, why: 'its review verdict is for bbbbbbbbb, not the head' };
  const as = drive(s, { feedback: fb, reads: () => reads({ reads: { atHead: () => stale } }) });
  const c = applied(as)[0]?.call;
  t('#881 a mismatch-held PR with a stale verdict marks its hold and gets a review try', j([as.find((a) => a.type === 'gate-hold'), c?.call, c?.fix?.kind, c?.fix?.ready, c?.fix?.held]), j([{ type: 'gate-hold', key: 'T-1', on: true }, 'requeue', 'rereview', true, true]));
  t('#881 its try says why', c?.fix?.what, 'review its head: its review verdict is for bbbbbbbbb, not the head');
  const clean = drive(s, { feedback: fb, reads: () => reads({ reads: { atHead: () => ({ clean: true }) } }) });
  t('#881 one whose head has a clean verdict gets nothing', applied(clean).length, 0);
  const findings = drive(s, { feedback: { ...fb, review: { id: 'R1', verdict: { p0: '0', p1: '1' }, body: '### P1 (1)\n- a.ts:1 x' } }, reads: () => reads({ reads: { atHead: () => stale } }) });
  const fx = applied(findings)[0]?.call;
  t('#902 one with a review at its head that is not clean gets a review fix, out of draft', j([fx?.call, fx?.fix?.kind, fx?.fix?.ready]), j(['requeue', 'review', true]));
  t('#902 and is not marked held', j(findings.find((a) => a.type === 'gate-hold')), j({ type: 'gate-hold', key: 'T-1', on: false }));
  const signinFindings = drive(snap([[tk(), verdictPr]], { ...base, reviewer: { key: 'reviewer-signin', kind: 'auth', why: 'signed out' } }), { feedback: { ...fb, review: { id: 'R1', verdict: { p0: '1', p1: '0' }, body: '### P0 (1)\n- a.ts:1 x' } }, reads: () => reads() });
  t('#902 whatever the reviewer check failed on', applied(signinFindings)[0]?.call?.fix?.kind, 'review');
  const elsewhere = drive(s, { feedback: { ...fb, head: 'd'.repeat(40), review: { id: 'R1', verdict: { p0: '1' }, body: 'x' } }, reads: () => reads() });
  t('#902 a review read at another head is not worked, and the hold stands', j([applied(elsewhere).length, elsewhere.find((a) => a.type === 'gate-hold')?.on]), j([0, true]));
  const personOnly = { id: 'R2', verdict: { p0: '0', p1: '0', gaps: '1' }, body: "### Requirement gaps\n- PERSON'S CALL · AC2: \"x\" — only the person can settle it\n" };
  const toPerson = drive(s, { feedback: { ...fb, review: personOnly }, reads: () => reads() });
  t('#902 a review whose only gap is the person\'s goes to them, and the hold lifts', j([applied(toPerson)[0]?.call?.call, toPerson.find((a) => a.type === 'gate-hold')?.on]), j(['stuck', false]));
  const noList = drive(s, { feedback: { ...fb, review: { id: 'R3', verdict: { p0: '1' }, body: 'no list' } }, reads: () => reads() });
  t('#902 a review that yields no call keeps its hold', j([applied(noList).length, noList.find((a) => a.type === 'gate-hold')?.on]), j([0, true]));
  const p0 = { id: 'R4', verdict: { p0: '1', p1: '0' }, body: '### P0 (1)\n- src/a.ts:3 the refund rollback deletes the event' };
  const masked = drive(s, { feedback: { ...fb, review: null, gateReview: p0 }, reads: () => reads() });
  t('#902 a gate reviewer\'s review is worked though desk\'s own later verdict is clean', applied(masked)[0]?.call?.fix?.kind, 'review');
  const signin = drive(snap([[tk(), verdictPr]], { ...base, reviewer: { key: 'reviewer-signin', kind: 'auth', why: 'signed out' } }), { feedback: fb, reads: () => reads({ reads: { atHead: () => stale } }) });
  t('#881 a reviewer that cannot be read still holds the review', j(signin), j([{ type: 'reads', key: 'T-1', dirty: false, dirtyFiles: null }, { type: 'feedback', key: 'T-1', pr: 697, gate: true }, { type: 'gate-hold', key: 'T-1', on: true }]));
}

// A green PR: its review threads are read, and a stale stuck record is cleared.
{
  const green = pr([ok('tests')]);
  const as = drive(snap([[tk({ stuck: { why: 'x' } }), green]]));
  t('threads that could not be read are said, and nothing is tried', lines(as)[0], 'fix tries: PR #697 (T-1): its review threads could not be read; the next pass tries again');
  t('a ticket with nothing to fix has its stuck record cleared', j(as.filter((a) => a.type === 'set')), j([{ type: 'set', key: 'T-1', fields: ['stuck=null'] }]));
  t('but not on a dry run', as.length - drive(snap([[tk({ stuck: { why: 'x' } }), green]], { dry: true })).length, 1);
  const fb = { head: HEAD, left: [], decision: null, review: { id: 'R1', verdict: { p0: '0', p1: '1' }, body: '### P1 (1)\n- src/a.ts:12 the loop never ends' }, payload: {} };
  const rv = drive(snap([[tk(), green]]), { feedback: fb });
  const c = applied(rv)[0]?.call;
  t('a review at its head that is not clean goes to a review fix, out of draft', j([c?.call, c?.fix?.kind, c?.fix?.ready]), j(['requeue', 'review', true]));
  const moved = drive(snap([[tk(), green]]), { feedback: { ...fb, head: 'd'.repeat(40) } });
  t('threads read at another head make no try', applied(moved).length, 0);
  const worked = { head: HEAD, left: [{ id: 'TH1', text: 'a thread' }], decision: null, review: null, payload: {} };
  const tried = tk({ state: 'done', fix: { kind: 'feedback', try: 1, of: 2, head: 'e'.repeat(40), finished: 'x', threads: [{ id: 'TH1', text: 'a thread' }] } });
  const unsettled = drive(snap([[tried, green]]), { feedback: worked, 'settle-worked': [] });
  t('a thread a finished try worked that GitHub would not settle holds any new try', j([types(unsettled).includes('settle-worked'), applied(unsettled).length]), j([true, 0]));
}

// A §4 Check builds check, built on its own: nothing is applied once the build starts.
{
  const build = { call: 'build', why: 'built', command: 'make it', checks: ['Image'] };
  const as = drive(snap([[tk(), redPr()]]), { reads: () => reads({ ctx: { builds: [{ name: 'Backend tests' }, { name: 'Lint' }], build: () => build } }) });
  t('a build that started applies nothing', j([types(as).includes('check-build'), applied(as).length]), j([true, 0]));
  const failed = drive(snap([[tk(), redPr()]]), { reads: () => reads({ ctx: { builds: [{ name: 'Backend tests' }, { name: 'Lint' }], build: () => build } }), 'check-build': { call: 'person', lead: 'its check build could not start', action: 'run it' } });
  t('one that could not start is stuck, with what to run', j([applied(failed)[0]?.call.call, applied(failed)[0]?.call.checks?.[0]]), j(['stuck', { name: 'Image', command: 'run it' }]));
}

// How the report names a try.
t('tryLabel: a numbered fix try', tryLabel({ kind: 'checks', try: 1, of: 2 }), 'fix try 1 of 2');
t('tryLabel: a review try', tryLabel({ kind: 'rereview', try: 2, of: 2 }), 'review try 2 of 2');
t('tryLabel: a protected files try', tryLabel({ kind: 'protected', try: 1, of: 2 }), 'protected files try 1 of 2');
t('tryLabel: an extra try', tryLabel({ kind: 'checks', extra: true }), 'extra fix try');
t('tryLabel: the capture try', tryLabel({ kind: 'capture' }), 'capture try');

if (fails) { console.log(`${fails} failure(s)`); process.exit(1); }
console.log('all passed');
