// suite: pass phase: fix tries (the decision, run through the generator runner)
// layer: L1
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideFixTries, decideOutage, tryLabel } from '../desk/bin/pass/fix-tries.mjs';
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
  t('#925 and the pass says it waits for that reviewer', lines(as).some((l) => /PR #697 \(T-1\) is out of draft: .*waits for agent-pullbot to review the head/.test(l)), true);
  const wasStuck = drive(snap([[{ ...tried, stuck: { why: 'x' } }, pr([ok('tests'), red('🔐 Review gate', '88')])]], { stateChecks: EXT }), { feedback: fb, reads: () => reads({ ctx: { stateChecks: EXT } }) });
  t('#925 a ticket stuck before has its stuck record cleared while it waits for the reviewer', j(wasStuck.filter((a) => a.type === 'set')), j([{ type: 'set', key: 'T-1', fields: ['stuck=null'] }]));
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
  // A round whose gaps only widen a broad AC an earlier try worked, past triage's files: the scope question.
  const broad1 = 'AC2: "an avatar wherever a person shows" — src/list.tsx:4 shows a name with no avatar';
  const wideTk = tk({ fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review', gaps: [broad1] }] });
  const wideFb = { ...fb, review: { id: 'R2', verdict: { p0: '0', p1: '0', gaps: '1' }, body: '### Requirement gaps\n- AC2: "an avatar wherever a person shows" — src/card.tsx:9 shows a name with no avatar\n' } };
  const wideReads = (outside) => () => reads({ reads: { outside: () => outside, title: () => 'Show the avatar on the people list' } });
  const wide = applied(drive(snap([[wideTk, green]]), { feedback: wideFb, reads: wideReads(['src/card.tsx']) }))[0]?.call;
  t('a ready PR\'s widening round past triage\'s files is the person\'s scope question, not a fix try', j([wide?.call, /^review gaps only you can settle: PERSON'S CALL: AC2 reads wider than the title \("Show the avatar on the people list"\)/.test(wide?.why ?? '')]), j(['stuck', true]));
  const inside = applied(drive(snap([[wideTk, green]]), { feedback: wideFb, reads: wideReads([]) }))[0]?.call;
  t('inside triage\'s files it is not', inside?.why?.startsWith('review gaps only you can settle'), false);
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

// A deploy platform failing for every PR: one outage for the batch (decideOutage), its PRs held from
// fix tries, re-run on one PR on a back-off, and cleared once a PR passes it.
{
  const G = { required: ['tests', 'Deploy preview'], advisory: [] };
  const LINE = 'Error: The project is blocked by the platform, please retry later';
  const T0 = Date.parse('2026-11-22T10:00:00Z');
  const deploy = (n, o = {}) => ({ ...red('Deploy preview', String(900 + n)), errors: [o.line ?? LINE], ...o.check });
  const entry = (n, checks, o = {}) => ({ t: tk({ key: `O-${n}`, branch: `task/O-${n}` }), s: pr(checks, { pr: n, ...o }) });
  const three = [701, 702, 703].map((n) => entry(n, [ok('tests'), deploy(n)]));
  const handlersFor = (answers) => Object.fromEntries(['out', 'report', 'outage-rerun', 'outage-hold', 'outage-held'].map((type) => [type, (a) => (typeof answers[type] === 'function' ? answers[type](a) : answers[type])]));
  const outage = (prs, o = {}, answers = {}) => {
    const report = { failed: [] };
    const as = runSteps({ name: 'outage', snapshot: () => ({ prs, gate: G, was: {}, now: T0, dry: false, rowErrors: [], ...o }), decide: decideOutage, handlers: handlersFor({ 'outage-rerun': { ok: true }, ...answers }), report });
    if (report.failed.length) { fails++; console.log(`FAIL a handler was missing: ${j(report.failed)}`); }
    return { as, held: as.find((a) => a.type === 'outage-held'), hold: as.find((a) => a.type === 'outage-hold')?.hold, reruns: as.filter((a) => a.type === 'outage-rerun') };
  };
  const fixes = (prs, o) => drive(snap(prs.map((e) => [e.t, e.s]), { gate: G, outage: o.held.held.size ? o.held.held : null, outageRerun: o.held.rerun }), { reads: () => reads({ ctx: { required: G.required } }) });

  // AC1: the same check red on three PRs with one platform line: no fix try for any.
  const first = outage(three);
  t('AC1 the check is held for the batch, with its three PRs', j(first.held.held.get('Deploy preview')?.prs), j([701, 702, 703]));
  t('AC1 no fix try is spent on it for any of them', applied(fixes(three, first)).map((a) => `${a.key} ${a.call.call} ${a.call.label}`).join(), 'O-701 held OUTAGE,O-702 held OUTAGE,O-703 held OUTAGE');
  t('AC1 the hold is kept from the pass it began', j(first.hold), j({ 'Deploy preview': { line: 'error: the project is blocked by the platform, please retry later', text: LINE, prs: [701, 702, 703], since: '2026-11-22T10:00:00.000Z', reruns: [], seen: [701, 702, 703].map((n) => ({ pr: n, head: HEAD, run: String(900 + n) })) } }));
  // AC2: one line, naming the check and the error line, and no STUCK line.
  const said = lines(first.as, 'report');
  t('AC2 the pass says it once, naming the check and the error line', said.length === 1 && said[0].startsWith(`OUTAGE — the deploy platform is failing for every PR: "Deploy preview" is red on 3 open PRs (#701, #702, #703) with the same error, "${LINE}", so no fix try is spent on it and none of them is stuck.`), true);
  t('AC2 and says when the next re-run is', /next re-run on one PR whose run has completed is due at 10:12 UTC/.test(said[0]), true);
  t('AC2 no rerun before the back-off has passed', first.reruns.length, 0);
  // AC3: once the back-off has passed, the check is re-run on one PR whose run has completed.
  const running = entry(701, [ok('tests'), deploy(701), { name: 'Build', status: 'in_progress', conclusion: null, runId: '1601' }]);
  running.s.checks[1] = { ...running.s.checks[1], runId: '1601' };
  const later = outage([running, ...three.slice(1)], { was: first.hold, now: T0 + 13 * 60 * 1000 });
  t('AC3 after the gap, one PR is re-run, never one whose run is still in progress', j(later.reruns.map((a) => [a.pr, a.run])), j([[702, '1602']]));
  t('AC3 the re-run is kept on the hold', j(later.hold['Deploy preview'].reruns.map((x) => [x.pr, x.ok])), j([[702, true]]));
  const after = outage(three, { was: later.hold, now: T0 + 30 * 60 * 1000 });
  t('AC3 the next waits twice as long after one that stayed red', after.reruns.length, 0);
  t('AC3 then it is due again', outage(three, { was: later.hold, now: T0 + 38 * 60 * 1000 }).reruns.length, 1);
  // While that re-run runs, the hold stays though only two PRs are red on it.
  const probing = [entry(701, [ok('tests'), deploy(701)]), entry(702, [ok('tests'), { name: 'Deploy preview', status: 'in_progress', conclusion: null, runId: '1602' }]), entry(703, [ok('tests'), deploy(703)])];
  const mid = outage(probing.filter((e) => e.s.pr !== 703), { was: later.hold, now: T0 + 14 * 60 * 1000 });
  t('a hold whose re-run is still running stays, with one PR left red', j(mid.held.held.get('Deploy preview')?.prs), j([701]));
  // So does one where another held PR's run of it is running, the merge driver's rerun and not the hold's.
  const driven = [entry(701, [ok('tests'), deploy(701)]), entry(703, [ok('tests'), { name: 'Deploy preview', status: 'in_progress', conclusion: null, runId: '1603' }])];
  const byDriver = outage(driven, { was: first.hold, now: T0 + 5 * 60 * 1000 });
  t('a hold with a held PR re-running it under the driver stays, its start kept', j([byDriver.held.held.get('Deploy preview')?.prs, byDriver.hold?.['Deploy preview']?.since ?? first.hold['Deploy preview'].since, lines(byDriver.as).some((l) => l.includes('its hold is lifted'))]), j([[701], '2026-11-22T10:00:00.000Z', false]));
  t('and the PR still red on it gets no fix try', applied(fixes(driven, byDriver)).map((a) => `${a.key} ${a.call.call}`).join(), 'O-701 held');
  // AC4: that re-run goes green: the hold clears, and the other PRs' checks are re-run.
  const green = [entry(701, [ok('tests'), deploy(701)]), entry(702, [ok('tests'), ok('Deploy preview')]), entry(703, [ok('tests'), deploy(703)])];
  const cleared = outage(green, { was: later.hold, now: T0 + 20 * 60 * 1000 });
  t('AC4 the hold clears', j([cleared.held.held.size, cleared.hold]), j([0, {}]));
  t('AC4 the other PRs\' checks are re-run', j(cleared.reruns.map((a) => [a.pr, a.run])), j([[701, '1601'], [703, '1603']]));
  t('AC4 the pass says so', lines(cleared.as).some((l) => l.startsWith('outage: "Deploy preview" passes on PR #702 again, so its platform is back and the hold is cleared: re-ran it on #701, #703')), true);
  t('AC4 a PR re-run as it cleared waits for that run, with no fix try', applied(fixes(green, cleared)).length, 0);
  // AC5: red on one PR only, it goes on as today.
  const one = outage([three[0]]);
  t('AC5 red on one PR there is no hold', j([one.held.held.size, one.reruns.length, lines(one.as, 'report').length]), j([0, 0, 0]));
  t('AC5 and it gets its fix try as today', applied(fixes([three[0]], one)).map((a) => a.call.call).join(), 'requeue');
  // AC6: red on several PRs with build-output lines that differ, each goes to its fix tries.
  const differ = [entry(701, [ok('tests'), deploy(701, { line: 'Type error: x is not a string' })]), entry(702, [ok('tests'), deploy(702, { line: 'Module not found: y' })]), entry(703, [ok('tests'), deploy(703, { line: 'Lint failed: 4 problems' })])];
  const dif = outage(differ);
  t('AC6 lines that differ make no hold', dif.held.held.size, 0);
  t('AC6 each PR goes to its fix tries', applied(fixes(differ, dif)).map((a) => a.call.call).join(), 'requeue,requeue,requeue');
  // A hold no longer red as one, with no re-run running, is lifted.
  const gone = outage([three[0]], { was: first.hold, now: T0 + 60 * 1000 });
  t('a hold red on one PR alone, with nothing re-running, is lifted', j([gone.held.held.size, gone.hold, lines(gone.as).some((l) => l.includes('its hold is lifted'))]), j([0, {}, true]));
  t('a dry run keeps no hold', outage(three, { dry: true }).hold, undefined);
  // The hold keeps its own line while a PR is red with it, so those PRs are re-run as it clears.
  const other = 'Error: Build queue timed out';
  const shifted = [entry(701, [ok('tests'), deploy(701)]), entry(702, [ok('tests'), ok('Deploy preview')]), ...[703, 704, 705].map((n) => entry(n, [ok('tests'), deploy(n, { line: other })]))];
  const kept = outage(shifted, { was: { 'Deploy preview': { ...first.hold['Deploy preview'], prs: [701, 702] } }, now: T0 + 20 * 60 * 1000 });
  t('a hold cleared while more PRs are red with another line re-runs its own and theirs', j(kept.reruns.map((a) => a.pr)), j([701, 703, 704, 705]));
  const both = outage(shifted.filter((e) => e.s.pr !== 702), { was: { 'Deploy preview': { ...first.hold['Deploy preview'], prs: [701, 702] } }, now: T0 + 5 * 60 * 1000 });
  t('one PR still red with the hold\'s line and more with a new one: all of them are held', j(both.held.held.get('Deploy preview')?.prs), j([701, 703, 704, 705]));
  // A re-run waiting on the preview build as the hold clears: the hold is kept, and that PR waits too.
  const clearing = outage(green, { was: later.hold, now: T0 + 20 * 60 * 1000 }, { 'outage-rerun': (a) => (a.pr === 703 ? { ok: false, wait: true, why: 'waits on the preview build for o/r#701' } : { ok: true }) });
  t('a re-run waiting on the preview build as it clears is kept as owed for the next pass', j([clearing.hold, clearing.held.rerun]), j([{ 'Deploy preview': { cleared: true, text: LINE, owed: [{ pr: 703, head: HEAD, run: '1603' }] } }, [701, 703]]));
  t('and says so', lines(clearing.as).some((l) => l.includes('re-ran it on #701; #703 waits on the preview build, and a later pass re-runs it')), true);
  t('neither gets a fix try this pass', applied(fixes(green, clearing)).length, 0);
  // DS-853 fix try 2: the owed re-run is made though the PR that passed has merged since, and the PR
  // waits for it rather than going to a fix try.
  const merged = [entry(701, [ok('tests'), { name: 'Deploy preview', status: 'in_progress', conclusion: null, runId: '1601' }]), entry(703, [ok('tests'), deploy(703)])];
  const paid = outage(merged, { was: clearing.hold, now: T0 + 25 * 60 * 1000 });
  t('an owed re-run is made once the PR that passed has merged', j([paid.reruns.map((a) => [a.pr, a.run]), paid.hold, paid.held.rerun]), j([[[703, '1603']], {}, [703]]));
  t('and says so', lines(paid.as).some((l) => l === 'outage: "Deploy preview"\'s platform is back, and the re-run its hold owed PR #703 is made now'), true);
  t('and that PR gets no fix try this pass', applied(fixes(merged, paid)).length, 0);
  const again = outage(merged, { was: clearing.hold, now: T0 + 25 * 60 * 1000 }, { 'outage-rerun': { ok: false, wait: true, why: 'waits on the preview build for o/r#9' } });
  // Unchanged, the kept hold is not rewritten: it stays owed as the file holds it.
  t('an owed re-run that waits again stays owed', j([again.hold, again.held.rerun, again.reruns.length]), j([undefined, [703], 1]));
  const gotGreen = outage([entry(703, [ok('tests'), ok('Deploy preview')])], { was: clearing.hold, now: T0 + 25 * 60 * 1000 });
  t('an owed re-run on a PR now green is dropped, with nothing re-run', j([gotGreen.reruns.length, gotGreen.hold, gotGreen.held.rerun]), j([0, {}, []]));
  const pushed = outage([entry(703, [ok('tests'), deploy(703)], { head: 'f'.repeat(40) })], { was: clearing.hold, now: T0 + 25 * 60 * 1000 });
  t('one on a PR pushed to since is dropped: its new head\'s runs are its own', j([pushed.reruns.length, pushed.hold]), j([0, {}]));
  // A PR whose status could not be read this pass keeps its debt; one the pass read as gone drops it.
  const unread = outage([merged[0]], { was: clearing.hold, now: T0 + 25 * 60 * 1000, unread: new Set([703]) });
  t('an owed re-run on a PR not read this pass is kept', j([unread.reruns.length, unread.hold]), j([0, undefined]));
  const closed = outage([merged[0]], { was: clearing.hold, now: T0 + 25 * 60 * 1000, unread: new Set() });
  t('one on a PR read as merged or closed is dropped', j([closed.reruns.length, closed.hold]), j([0, {}]));
  // A newer run of the check at the same head (a reopen's) is its own: the debt is dropped, not re-run.
  const replaced = outage([entry(703, [ok('tests'), deploy(703, { check: { runId: '2603' }, line: 'src/app.ts:12 Type error' })])], { was: clearing.hold, now: T0 + 25 * 60 * 1000 });
  t('an owed re-run whose run a newer one replaced is dropped, with nothing re-run', j([replaced.reruns.length, replaced.hold]), j([0, {}]));
  // A same-name check of another kind (a status that passed) is not the run owed: the debt stands.
  const sameName = outage([entry(703, [ok('tests'), { name: 'Deploy preview', status: 'completed', conclusion: 'success', runId: null, workflow: null }, deploy(703, { check: { workflow: 'Deploy' } })])], { was: clearing.hold, now: T0 + 25 * 60 * 1000 });
  t('an owed re-run is matched on its run, not a same-name status that passed', j(sameName.reruns.map((a) => [a.pr, a.run])), j([[703, '1603']]));
  // A held PR the pass could not read as the hold clears is owed its re-run of the run last seen red.
  const clearUnread = outage([green[0], green[1]], { was: later.hold, now: T0 + 20 * 60 * 1000, unread: new Set([703]) });
  t('a held PR not read as the hold clears is owed its last red run', j(clearUnread.hold?.['Deploy preview']?.owed), j([{ pr: 703, head: HEAD, run: '1603' }]));
  const readAgain = outage([entry(703, [ok('tests'), deploy(703)])], { was: clearUnread.hold, now: T0 + 25 * 60 * 1000 });
  t('and is re-run once it is read again, red on that run', j(readAgain.reruns.map((a) => [a.pr, a.run])), j([[703, '1603']]));
  // PRs owed a re-run are not counted toward a new outage: their red runs are the cleared one's.
  const bothWait = outage(green, { was: later.hold, now: T0 + 20 * 60 * 1000 }, { 'outage-rerun': { ok: false, wait: true, why: 'waits on the preview build for o/r#9' } });
  const twoOwed = outage([entry(701, [ok('tests'), deploy(701)]), entry(703, [ok('tests'), deploy(703)])], { was: bothWait.hold, now: T0 + 25 * 60 * 1000 });
  t('two PRs owed a re-run make no new outage, and both are re-run', j([twoOwed.held.held.size, twoOwed.reruns.map((a) => a.pr), twoOwed.hold, lines(twoOwed.as, 'report').length]), j([0, [701, 703], {}, 0]));
  // A PR whose run is still going as the hold clears (another job of it running) is owed its re-run too.
  const going = entry(703, [ok('tests'), deploy(703), { name: 'Build', status: 'in_progress', conclusion: null, runId: '1603' }]);
  const unfinished = outage([green[0], green[1], going], { was: later.hold, now: T0 + 20 * 60 * 1000 });
  t('a PR whose run is still going as it clears is owed its re-run, not re-run yet', j([unfinished.reruns.map((a) => a.pr), unfinished.hold, [...unfinished.held.rerun].sort()]), j([[701], { 'Deploy preview': { cleared: true, text: LINE, owed: [{ pr: 703, head: HEAD, run: '1603' }] } }, [701, 703]]));
  t('and the pass says a later pass re-runs it', lines(unfinished.as).some((l) => l.includes('re-ran it on #701; #703 has a run still going, and a later pass re-runs it')), true);
  const still = outage([going], { was: unfinished.hold, now: T0 + 22 * 60 * 1000 });
  t('while that run goes on, it stays owed, with no fix try', j([still.reruns.length, still.hold, still.held.rerun]), j([0, undefined, [703]]));
  const done = outage([entry(703, [ok('tests'), deploy(703)])], { was: unfinished.hold, now: T0 + 25 * 60 * 1000 });
  t('once that run completes red, the next pass re-runs it', j([done.reruns.map((a) => [a.pr, a.run]), done.hold]), j([[[703, '1603']], {}]));
  // DS-853 fix try 3: an owed run is found among the checks as stored (no `workflow`), though another
  // workflow's check of the same name is newer, passed or red.
  const otherWf = (conclusion) => outage([entry(703, [ok('tests'), deploy(703), { name: 'Deploy preview', status: 'completed', conclusion, runId: '2703' }])], { was: unfinished.hold, now: T0 + 25 * 60 * 1000 });
  t('an owed run is re-run though another workflow\'s same-name check passed since', j(otherWf('success').reruns.map((a) => [a.pr, a.run])), j([[703, '1603']]));
  t('and though another workflow\'s same-name check is red and newer', j(otherWf('failure').reruns.map((a) => [a.pr, a.run])), j([[703, '1603']]));
  t('the owed run passing on its own drops the debt, whatever the other workflow reads', j(outage([entry(703, [ok('tests'), { ...ok('Deploy preview'), runId: '1603' }, { ...red('Deploy preview', '2703'), errors: ['src/a.ts:1 x'] }])], { was: unfinished.hold, now: T0 + 25 * 60 * 1000 }).reruns.length), j(0));
  // A held PR whose run is going again (re-run) keeps its `seen` entry, so a clearing on a pass that
  // cannot read it still owes it that run.
  const rerunning = entry(703, [ok('tests'), { name: 'Deploy preview', status: 'in_progress', conclusion: null, runId: '1603' }]);
  const reGoing = outage([three[0], three[1], rerunning], { was: first.hold, now: T0 + 5 * 60 * 1000 });
  // Its seen entry kept, the hold is unchanged, so it is not rewritten.
  t('a held PR re-running its red run keeps its seen entry', j([reGoing.hold, first.hold['Deploy preview'].seen.find((x) => x.pr === 703)]), j([undefined, { pr: 703, head: HEAD, run: '1603' }]));
  const reHold = reGoing.hold ?? first.hold;
  const clearsUnread = outage([green[0], green[1]], { was: reHold, now: T0 + 20 * 60 * 1000, unread: new Set([703]) });
  t('so the hold clearing while it is unread owes it that run', j(clearsUnread.hold?.['Deploy preview']?.owed), j([{ pr: 703, head: HEAD, run: '1603' }]));
  t('and once read red on that run it is re-run', j(outage([entry(703, [ok('tests'), deploy(703)])], { was: clearsUnread.hold, now: T0 + 25 * 60 * 1000 }).reruns.map((a) => [a.pr, a.run])), j([[703, '1603']]));
  const clearsGoing = outage([green[0], green[1], rerunning], { was: reHold, now: T0 + 20 * 60 * 1000 });
  t('a hold clearing while that run is still going owes it too, with no fix try', j([clearsGoing.hold?.['Deploy preview']?.owed, clearsGoing.held.rerun.includes(703)]), j([[{ pr: 703, head: HEAD, run: '1603' }], true]));
  // A two-PR hold with one PR not read this pass is not lifted: it stays until that PR is read, so the
  // other PR is still re-run once the unread one reads green.
  const pair = outage([three[0], three[1]]);
  const halfRead = outage([three[0]], { was: pair.hold, now: T0 + 5 * 60 * 1000, unread: new Set([702]) });
  t('a hold with a held PR not read this pass is not lifted, and its other PR stays held', j([lines(halfRead.as).some((l) => l.includes('its hold is lifted')), halfRead.held.held.get('Deploy preview')?.prs, (halfRead.hold ?? pair.hold)['Deploy preview']?.seen?.map((x) => x.pr)]), j([false, [701], [701, 702]]));
  const pairBack = outage([three[0], entry(702, [ok('tests'), ok('Deploy preview')])], { was: halfRead.hold ?? pair.hold, now: T0 + 10 * 60 * 1000 });
  t('so once that PR reads green, the hold clears and the other PR is re-run', j(pairBack.reruns.map((a) => [a.pr, a.run])), j([[701, '1601']]));
  // A held PR the pass did not try to read (its ticket left the queue) is gone, not unread: the hold
  // lifts, and the PR left red on it goes to its fix tries.
  const dropped1 = outage([three[0]], { was: pair.hold, now: T0 + 5 * 60 * 1000, unread: new Set() });
  t('a hold whose other PR left the queue is lifted', j([lines(dropped1.as).some((l) => l.includes('its hold is lifted')), dropped1.hold, dropped1.held.held.size]), j([true, {}, 0]));
  t('and the PR left red on it gets its fix try', applied(fixes([three[0]], dropped1)).map((a) => a.call.call).join(), 'requeue');
  t('a seen entry at an old head is not kept', outage([three[0], three[1], entry(703, [ok('tests'), { name: 'Deploy preview', status: 'in_progress', conclusion: null, runId: '1603' }], { head: 'f'.repeat(40) })], { was: first.hold, now: T0 + 5 * 60 * 1000 }).hold?.['Deploy preview']?.seen?.some((x) => x.pr === 703), false);
  // A stuck record naming a held check drops it, whatever the PR's route this pass.
  const stuckT = tk({ key: 'O-701', branch: 'task/O-701', stuck: { why: 'x', pr: 701, head: HEAD, lead: 'still red after 2 tries', checks: [{ name: 'Lint' }, { name: 'Deploy preview' }] } });
  const dropped = drive(snap([[stuckT, three[0].s]], { gate: G, outage: first.held.held, outageRerun: [] }), { reads: () => reads({ ctx: { required: G.required } }) });
  t('a stuck record naming a check the outage now holds drops it', dropped.filter((a) => a.type === 'set').map((a) => a.fields.join()).join(), `stuck=${j({ ...stuckT.stuck, checks: [{ name: 'Lint' }], why: 'still red after 2 tries: Lint' })}`);
  // A re-run waiting on the preview build another PR holds is no re-run tried: the back-off does not grow.
  const leased = outage(three, { was: first.hold, now: T0 + 13 * 60 * 1000 }, { 'outage-rerun': { ok: false, wait: true, why: 'waits on the preview build for o/r#9' } });
  t('a re-run waiting on the preview build is not counted', j([leased.reruns.length, leased.hold]), j([1, undefined]));
  t('and the pass says it waits', lines(leased.as, 'report')[0]?.includes('It waits on the preview build before its re-run on PR #701'), true);
}

if (fails) { console.log(`${fails} failure(s)`); process.exit(1); }
console.log('all passed');
