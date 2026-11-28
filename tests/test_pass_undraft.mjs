// suite: pass phase: reopen and undraft (the decisions)
// layer: L1
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideReopen, decideRenames, decideUndraft, decideRelease, undraftWrite } from '../desk/bin/pass/undraft.mjs';
import { conflictFilesIn, fixTryQuote, cloudHead } from '../desk/bin/pass/shared.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
import { flakyWaiver, notesIn, parseFlaky, normaliseRollup } from '../desk/bin/gate.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const HEAD = 'a'.repeat(40);
const BASE_HEAD = 'c'.repeat(40);
const AT = '2026-11-19T12:00:00.000Z';
const ALL_ZERO = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const marker = (counts) => `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${HEAD} ${counts} vendor=codex-cross round=1 -->\nclean`;
const review = (body) => ({ id: 'R1', author: { login: 'ben' }, body, commit: { oid: HEAD } });
const ticket = (key, fields = {}) => ({ key, state: 'done', branch: `task/${key}`, result: { pr: 701 }, ...fields });
const status = (fields = {}) => ({ pr: 701, state: 'OPEN', isDraft: true, head: HEAD, base: 'main', base_head: BASE_HEAD, checks: [], ...fields });
// The draft's gh pr view: mergeable, green on `tests`, with one review at its head.
const view = (reviews, fields = {}) => ({
  headRefOid: HEAD, headRefName: 'task/A', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', body: '', comments: [],
  reviews, statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...fields,
});
// The undraft snapshot, with stub readers: none starts a process or reads anything.
const undraftSnap = (drafts, fields = {}) => ({
  drafts, spine: null, dry: false, at: AT, repo: 'o/r', base: 'main',
  cfg: { perm: 'yes', permKey: 'pr-ready', approved: false, rerun: 'yes', localReview: '/desk-review', clean: ALL_ZERO, judgement: 'no', conflictUnreviewed: 'no', conflictReviewed: 'no', handle: 'ben', required: ['tests'], advisory: [], stateChecks: [], builds: [], evidence: null, upload: 'no' },
  gates: { required: ['tests'], advisory: [] }, evidenceErrors: null, buildErrors: [], fixRowErrors: [], clearsRows: {}, failureClass: false,
  gatedByReviewer: () => false,
  reads: {
    untriggered: () => ({}), runOf: () => null, fault: () => null, stale: () => ({}),
    baseMoves: () => ({ carry: () => false, scope: () => null, baseMerge: () => false, behind: () => null }),
    driver: () => ({ reruns: () => 0, rerunsOk: () => 0, cancels: () => 0, cooledDown: true }),
    built: () => null, evidenceRun: () => null, missingShots: () => [], shotDir: () => '/state/images/A', baseReads: () => ({}),
    reviewComments: () => ({ comments: [] }),
  },
  ...fields,
});

// The runner with stub handlers: each read answers from `answers` (a value, or a function of the action).
const READS = { 'pr-close': { ok: true, out: '' }, 'pr-reopen': { ok: true, out: '' }, fetch: true, 'child-renames': [], events: { hold: null }, 'pr-view': null, 'pr-files': [], 'conflict-files': null, 'base-at': null, ready: { ok: true, out: '' }, comment: { ok: true, out: '' }, 'update-branch': { ok: true, out: '' } };
const RECS = ['cancel', 'build', 'rebuilt', 'evidence'];
const WRITES = ['set', 'report', 'out', 'set-batch', 'apply-fix', 'take', 'gate-hold', 'upload', 'rerun-draft', 'carried', 'record-carry', 'verdict-read', 'note', 'undraft-error', 'evidence-failures'];
function drive(decide, s, answers = {}) {
  const handlers = Object.fromEntries([...Object.keys(READS), ...RECS, ...WRITES].map((type) => [type, (a) => {
    if (Object.hasOwn(answers, type)) return typeof answers[type] === 'function' ? answers[type](a) : answers[type];
    return RECS.includes(type) ? a.rec : READS[type];
  }]));
  const report = { failed: [] };
  const actions = runSteps({ name: 'undraft', snapshot: () => s, decide, handlers, report });
  return { actions, failed: report.failed };
}
const types = (as) => as.map((a) => a.type);
const lines = (as, type = 'out') => as.filter((a) => a.type === type).map((a) => a.line);
const waits = (as) => as.filter((a) => a.type === 'report' && a.list === 'waiting').map((a) => a.line);
const sets = (as) => as.filter((a) => a.type === 'set').flatMap((a) => a.fields);
// What acts on a draft: undraft it, re-run, cancel or build its checks, start a run, or send a worker.
const ACTS = new Set(['ready', 'comment', 'rerun-draft', 'cancel', 'build', 'rebuilt', 'evidence', 'apply-fix', 'upload', 'update-branch']);
const acts = (as) => as.filter((a) => ACTS.has(a.type)).map((a) => a.type);

// A clean, green draft leaves draft, with its comment, and its record reads ready.
{
  const { actions } = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([review(marker(ALL_ZERO))]) });
  t('a clean green draft is undrafted and commented on', j(acts(actions)), '["ready","comment"]');
  t('and its record reads ready', JSON.parse(sets(actions).find((f) => f.startsWith('undraft='))?.slice(8) ?? '{}').call, 'ready');
}

// issue-1556: a cloud ticket's draft PR with the verdict its session posted at its current head goes
// straight on, with no review try, and the ledger records the verdict as the cloud's; one at an older
// head gets a review try, as today.
{
  const OLD = 'b'.repeat(40);
  const cloudT = (head = HEAD, fields = {}) => ticket('A', { location: 'cloud', cloud: { started: AT, pr_at: AT, head }, ...fields });
  const at = (sha) => review(marker(ALL_ZERO).replace(`sha=${HEAD}`, `sha=${sha}`));
  const { actions } = drive(decideUndraft, undraftSnap([{ t: cloudT(), s: status() }]), { 'pr-view': view([at(HEAD)]) });
  t('issue-1556 AC1 a cloud PR with its verdict at the head is undrafted, with no review try', j(acts(actions)), '["ready","comment"]');
  t('issue-1556 AC3 and its verdict is recorded as the cloud\'s', j(actions.filter((a) => a.type === 'verdict-read').map((a) => [a.key, a.pr, a.head === HEAD, a.location])), j([['A', 701, true, 'cloud']]));
  t('issue-1556 the undraft line says the cloud session\'s verdict let it on', lines(actions).some((l) => l.includes('on the verdict its cloud session posted')), true);
  const old = drive(decideUndraft, undraftSnap([{ t: cloudT(OLD), s: status() }]), { 'pr-view': view([at(OLD)]) }).actions;
  const fix = old.find((a) => a.type === 'apply-fix')?.fix;
  t('issue-1556 AC2 a cloud PR whose verdict is at an older head gets a review try', `${fix?.call}:${fix?.fix?.kind}:${acts(old).includes('ready')}`, 'requeue:rereview:false');
  t('issue-1556 AC2 and no verdict is recorded', types(old).includes('verdict-read'), false);
  const local = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([at(HEAD)]) }).actions;
  t('issue-1556 AC3 a local ticket\'s verdict is recorded as local', j(local.filter((a) => a.type === 'verdict-read').map((a) => a.location)), '["local"]');
  t('issue-1556 a dry run records nothing', types(drive(decideUndraft, undraftSnap([{ t: cloudT(), s: status() }], { dry: true }), { 'pr-view': view([at(HEAD)]) }).actions).includes('verdict-read'), false);
  t('issue-1556 cloudHead: the head a cloud ticket\'s session left', cloudHead(cloudT()), HEAD);
  t('issue-1556 cloudHead: none for a local ticket, or one with no head kept', j([cloudHead(ticket('A', { cloud: { head: HEAD } })), cloudHead(ticket('A', { location: 'cloud', cloud: { started: AT } }))]), '[null,null]');
  t('issue-1556 cloudHead: none once a local review try has reviewed that head', j([cloudHead(cloudT(HEAD, { fix_tries: [{ try: 1, head: HEAD, kind: 'rereview' }] })), cloudHead(cloudT(HEAD, { fix: { try: 1, head: HEAD, kind: 'rereview' } }))]), '[null,null]');
  t('issue-1556 cloudHead: none once a gaps try, which may post the verdict again, started there', cloudHead(cloudT(HEAD, { fix: { try: 1, head: HEAD, kind: 'gaps' } })), null);
  t('issue-1556 cloudHead: a try at another head leaves it', cloudHead(cloudT(HEAD, { fix_tries: [{ try: 1, head: OLD, kind: 'rereview' }] })), HEAD);
}

// A draft's review round whose gaps only widen a broad AC an earlier try worked, past triage's files: the
// pass reads the PR's files and triage's scope, and puts the scope question rather than a fix try.
{
  const BROAD1 = 'AC2: "an avatar wherever a person shows" — src/list.tsx:4 shows a name with no avatar';
  const gapReview = review(`${marker(ALL_ZERO.replace('gaps=0', 'gaps=1'))}\n\n### Requirement gaps\n- AC2: "an avatar wherever a person shows" — src/card.tsx:9 shows a name with no avatar\n`);
  const tried = ticket('A', { fix_tries: [{ try: 1, head: 'b'.repeat(40), kind: 'review', gaps: [BROAD1] }] });
  const asked = [];
  const wide = (files) => undraftSnap([{ t: tried, s: status() }], {
    cfg: { ...undraftSnap([]).cfg, judgement: 'yes' },
    reads: { ...undraftSnap([]).reads, outside: (n, head, key) => { asked.push(`${n}@${head === HEAD}@${key}`); return files; }, title: (key) => (key === 'A' ? 'Show the avatar on the people list' : null) },
  });
  const run = (files) => drive(decideUndraft, wide(files), { 'pr-view': view([gapReview]) }).actions.find((a) => a.type === 'apply-fix')?.fix;
  const past = run(['src/card.tsx']);
  t('a widening round past triage\'s files is the person\'s scope question, not a fix try', j([past?.call, /^review gaps only you can settle: PERSON'S CALL: AC2 reads wider than the title \("Show the avatar on the people list"\)/.test(past?.why ?? '')]), j(['stuck', true]));
  t('the out-of-scope files are read for that PR at its head and ticket', asked[0], '701@true@A');
  t('a change inside triage\'s files is not asked the scope question', run([])?.why?.startsWith('review gaps only you can settle'), false);
}

// #831: the draft path reads §4 Known flaky checks as the merge driver does, from the error_notes the pass
// kept on the PR's checks: red only on a listed test, the draft leaves draft; any other failure holds it.
{
  const flaky = parseFlaky(['Integration: tests/orders.test.ts > retries a timed-out order']).flaky;
  const rollup = [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'Integration', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/9/job/90' }];
  const listed = { path: 'tests/orders.test.ts', title: 'tests/orders.test.ts > retries a timed-out order', message: 'AssertionError: expected 200 to be 504' };
  const kept = (notes) => normaliseRollup(rollup).map((c) => (c.name === 'Integration' ? { ...c, error_notes: notes } : c));
  const files = { 701: ['src/x.ts'] };
  const waived = (n, head, checks, names) => flakyWaiver(checks, { required: ['tests'], flaky, files: files[n], notes: notesIn(checks) })?.applies === true && names.includes('Integration');
  const run = (notes, s = {}) => drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status({ checks: kept(notes), ...s }) }], { reads: { ...undraftSnap([]).reads, waived } }),
    { 'pr-view': view([review(marker(ALL_ZERO))], { statusCheckRollup: rollup }) }).actions;
  t('#831 a draft red only on its listed flaky test leaves draft', acts(run([listed])).includes('ready'), true);
  t('#831 one also red on another test in that check does not', acts(run([listed, { ...listed, title: 'tests/orders.test.ts > totals an order' }])).includes('ready'), false);
  t('#831 nor one whose checks kept no annotations', acts(run(undefined)).includes('ready'), false);
  t('#831 nor one read at another head', acts(run([listed], { head: 'b'.repeat(40) })).includes('ready'), false);
  files[701] = ['tests/orders.test.ts'];
  t('#831 nor one changing the listed test\'s file', acts(run([listed])).includes('ready'), false);
}

// AC1: a review at the head that holds a P1 is no undraft: it goes to a fix worker.
{
  const { actions } = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([review(marker(ALL_ZERO.replace('p1=0', 'p1=1')))]) });
  t('AC1 a draft whose review holds a P1 gets no undraft action', acts(actions).includes('ready'), false);
  // Its body lists no finding with its file:line, so there is nothing to send a fix worker: the person's.
  t('AC1 with no finding listed it goes to the person', j([acts(actions), waits(actions).length]), '[[],1]');
  const listed = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([review(`${marker(ALL_ZERO.replace('p1=0', 'p1=1'))}\n- **P1** \`src/a.js:12\` reads the wrong head`)]) }).actions;
  t('AC1 with its finding listed it goes to a review fix try, and only that', j(acts(listed)), '["apply-fix"]');
  const fix = listed.find((a) => a.type === 'apply-fix')?.fix;
  t('AC1 the try is a review fix, requeued', `${fix?.call}:${fix?.fix?.kind}`, 'requeue:review');
  t('AC1 and nothing is put to the person', j(waits(listed)), '[]');
}

// AC2: a PR already reopened at this base head, its checks still unreported, is not reopened again.
{
  const reopens = [{ t: ticket('A'), s: status({ isDraft: false, reopen: { tests: 'x' } }), owed: false }];
  const again = drive(decideReopen, { reopens, reopenedAt: BASE_HEAD, dry: false, repo: 'o/r' }).actions;
  t('AC2 a PR reopened at the current base head is not reopened again', j(again), '[]');
  const moved = drive(decideReopen, { reopens, reopenedAt: 'd'.repeat(40), dry: false, repo: 'o/r' }).actions;
  t('AC2 while at a new base head it is closed and reopened, once', j(types(moved)), '["set","pr-close","pr-reopen","set","out","set-batch"]');
  t('AC2 and the batch keeps the head it was reopened at', j(moved.at(-1).fields), j([`reopened_at=${BASE_HEAD}`]));
  const owed = drive(decideReopen, { reopens: [{ ...reopens[0], s: status({ state: 'CLOSED' }), owed: true }], reopenedAt: BASE_HEAD, dry: false, repo: 'o/r' }).actions;
  t('AC2 one still owed its reopen is reopened at any head, with no second close', j(types(owed)), '["pr-reopen","set","out","set-batch"]');
  const failed = drive(decideReopen, { reopens, reopenedAt: null, dry: false, repo: 'o/r' }, { 'pr-reopen': { ok: false, out: 'boom' } }).actions;
  t('a reopen that fails is said, for the next pass', waits(failed)[0], 'reopen: PR #701 (A) is closed, to start its CI, and did not reopen (boom); the next pass tries again, or: gh pr reopen 701 --repo o/r');
}

// AC3: a person put the draft back: no undraft, rerun, build, review or fix, and a HELD line.
{
  const held = ticket('A', { undraft: { call: 'ready', pr: 701 } });
  const { actions } = drive(decideUndraft, undraftSnap([{ t: held, s: status() }]), { 'pr-view': view([review(marker(ALL_ZERO))]) });
  t('AC3 a draft a person put back gets no act', j(acts(actions)), '[]');
  t('AC3 and its events are not read, the record settles it', types(actions).includes('events'), false);
  t('AC3 and a HELD line', /^A: HELD — PR #701 stays draft: it was put back to draft after the pass undrafted it\. Undraft #701 to release it/.test(waits(actions)[0] ?? ''), true);
  const byEvent = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), {
    'pr-view': view([review(marker(ALL_ZERO.replace('p1=0', 'p1=1')))]),
    events: { hold: { why: 'it was put back to draft by sam at 2026-11-18', action: 'undraft #701 to release it' } },
  }).actions;
  t('AC3 one its events say was put back gets no fix try either', j(acts(byEvent)), '[]');
  t('AC3 and is recorded held', JSON.parse(sets(byEvent).find((f) => f.startsWith('undraft='))?.slice(8) ?? '{}').call, 'held');
}

// AC4: the call would act but the events could not be read: it stays draft, with the next-pass line.
{
  const { actions } = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([review(marker(ALL_ZERO))]), events: { unread: 'HTTP 502' } });
  t('AC4 unread events leave the draft as it is', j(acts(actions)), '[]');
  t('AC4 and nothing is recorded', j(sets(actions)), '[]');
  t('AC4 the next-pass line', lines(actions)[0], 'undraft: PR #701 (A) stays draft for now: its events, which say whether a person put it back to draft, could not be read (HTTP 502); the next pass tries again');
}

// AC5: the last undraft was refused: the next snapshot's decision records it failed and says so.
{
  const { actions } = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([review(marker(ALL_ZERO))]), ready: { ok: false, out: 'GraphQL: not allowed' } });
  t('AC5 a refused undraft records the PR failed', JSON.parse(sets(actions).find((f) => f.startsWith('undraft='))?.slice(8) ?? '{}').call, 'failed');
  t('AC5 and the "could not leave draft" line', lines(actions).at(-1), 'undraft: PR #701 (A) could not leave draft (GraphQL: not allowed); the next pass tries again');
  t('AC5 and it goes on the pass record', lines(actions, 'undraft-error')[0], 'A: gh pr ready 701 failed: GraphQL: not allowed');
  t('AC5 with no comment posted', acts(actions).includes('comment'), false);
}

// The rerun a draft's red checks get when their failed logs name no file it changes: while that rerun
// runs, the pass's wait on its pending checks keeps saying whose rerun it is, so the ticket still reads as
// waiting on checks; at another head, or after another call, the wait is as before.
{
  const outside = { call: 'rerun', why: 'its "tests" check\'s failed log names no file this PR changes, so its run is re-run once at this head, every job, before any fix worker', action: null, sha: HEAD, carried_from: null, pr: 701 };
  const pending = { 'pr-view': view([review(marker(ALL_ZERO))], { statusCheckRollup: [{ name: 'tests', status: 'IN_PROGRESS', conclusion: null }] }) };
  const recOf = (undraft) => JSON.parse(sets(drive(decideUndraft, undraftSnap([{ t: ticket('A', { undraft }), s: status() }]), pending).actions).find((f) => f.startsWith('undraft='))?.slice(8) ?? '{}');
  const during = recOf(outside);
  t('#1640 AC4 while that rerun runs, the wait on its checks still names the rerun', `${during.call} | ${during.why}`, 'wait | checks still running (tests) in the rerun of checks whose failed logs name no file this PR changes');
  const next = drive(decideUndraft, undraftSnap([{ t: ticket('A', { undraft: { ...during, at: AT } }), s: status() }]), pending).actions;
  t('#1640 AC4 and the next pass, its checks still running, keeps that wait and writes nothing new', `${sets(next).some((f) => f.startsWith('undraft='))} | ${lines(next).at(-1)}`, 'false | undraft: PR #701 (A) stays draft for now: checks still running (tests)');
  t('#1640 AC4 one recorded at another head waits as before', recOf({ ...outside, sha: 'b'.repeat(40) }).why, 'checks still running (tests)');
  t('#1640 AC4 so does one after another rerun', recOf({ ...outside, why: 'its "tests" check was cancelled, so its run is re-run' }).why, 'checks still running (tests)');
}

// A draft that cannot be read, and a record that already says the call, write nothing.
{
  const { actions } = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]));
  t('an unread draft is said for the next pass', j(lines(actions)), j(['undraft: PR #701 (A) could not be read; the next pass tries again']));
  const rec = { call: 'ready', why: null, action: null, sha: HEAD, carried_from: null, pr: 701 };
  t('a record that already says it is not written again', undraftWrite(ticket('A', { undraft: { ...rec, at: 'x' } }), rec, { dry: false, at: AT }), null);
  t('nor on a dry run', undraftWrite(ticket('A'), rec, { dry: true, at: AT }), null);
}

// DS-856: a draft with no mergeability answer past the limit has its branch updated once, where §3
// pr-update-branch is yes, and the try is recorded; refused, it is the person's at once, naming why.
{
  const since = new Date(Date.parse(AT) - 45 * 60000).toISOString();
  const t0 = ticket('A', { undraft: { call: 'wait', why: 'GitHub has not yet worked out whether it conflicts with its base (UNKNOWN)', action: null, sha: HEAD, carried_from: null, pr: 701, unknown_since: since } });
  const snap = (updateBranch) => undraftSnap([{ t: t0, s: status() }], { cfg: { ...undraftSnap([]).cfg, updateBranch } });
  const unknown = { 'pr-view': view([review(marker(ALL_ZERO))], { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) };
  const rec = (as) => JSON.parse(sets(as).find((f) => f.startsWith('undraft='))?.slice(8) ?? '{}');
  const ok = drive(decideUndraft, snap('yes'), unknown).actions;
  const upd = ok.find((a) => a.type === 'update-branch');
  t('DS-856 AC1 past the limit the pass updates the branch of that PR once', `${upd?.pr} ${upd?.branch}`, '701 task/A');
  t('DS-856 AC1 and logs which PR and why', lines(ok).at(-1), `undraft: PR #701 (A) stays draft for now: GitHub has not worked out whether it conflicts with its base (UNKNOWN) at ${HEAD.slice(0, 12)} for 45 minutes: its merge ref looks wedged, and GitHub starts no run for that head, so its branch is updated from its base once (gh pr update-branch) for a fresh merge ref: requested`);
  t('DS-856 AC1 the try is recorded with the spell\'s start, so it is not made again', `${rec(ok).call} ${rec(ok).unknown_since} ${j(rec(ok).unknown_repair)}`, `wait ${since} ${j({ at: AT, head: HEAD, ok: true })}`);
  const no = drive(decideUndraft, snap('ask'), unknown).actions;
  t('DS-856 AC5 with §3 pr-update-branch not yes, nothing is updated', acts(no).includes('update-branch'), false);
  t('DS-856 AC5 and it waits on the person, saying no repair was permitted', /no repair was permitted, as config §3 pr-update-branch is "ask"/.test(waits(no)[0] ?? ''), true);
  const refused = drive(decideUndraft, snap('yes'), { ...unknown, 'update-branch': { ok: false, out: 'HTTP 422\nno new commits on the base branch' } }).actions;
  t('DS-856 a refused update is the person\'s at once, naming the refusal', `${rec(refused).call} ${/was refused: no new commits on the base branch$/.test(rec(refused).why)} ${rec(refused).unknown_repair?.ok}`, 'person true false');
  const slot = drive(decideUndraft, snap('yes'), { ...unknown, 'update-branch': { wait: 'waits on the preview build for o/r: held' } }).actions;
  t('DS-856 one waiting on the preview build records no try, so the next pass makes it', `${rec(slot).call} ${rec(slot).unknown_repair}`, 'wait undefined');
  const dry = drive(decideUndraft, { ...snap('yes'), dry: true }, unknown).actions;
  t('DS-856 a dry run only says it would update the branch', `${acts(dry).length} ${/^undraft \(dry run\): would update PR #701 \(A\)'s branch/.test(lines(dry).at(-1))}`, '0 true');
  // DS-901: the first pass to read UNKNOWN on a draft keeps that time on its undraft record, which the
  // deadline sweep (pass/deadlines.mjs) takes as when the draft's wait on mergeability started.
  const first = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), unknown).actions;
  t('DS-901 the first pass to read UNKNOWN records it as first seen then, and waits', `${rec(first).call} ${rec(first).unknown_since}`, `wait ${AT}`);
}

// The migration renames: a draft a person holds keeps its place; one renamed goes to its worker.
{
  const renamed = [{ from: 'm/0002_x.sql', to: 'm/0003_x.sql' }];
  const drafts = [{ t: ticket('A'), s: status() }];
  const undrafted = [{ t: ticket('B'), s: status({ isDraft: false }) }];
  const { actions } = drive(decideRenames, { drafts, undrafted, base: 'main' }, { 'child-renames': renamed });
  const taken = actions.filter((a) => a.type === 'take').map((a) => `${a.list}:${a.key}`);
  t('renames: a renamed child of each list goes to its worker and leaves the list', j(taken), '["drafts:A","undrafted:B"]');
  const held = drive(decideRenames, { drafts, undrafted: [], base: 'main' }, { 'child-renames': renamed, events: { unread: 'x' } }).actions;
  t('renames: a draft whose events are unread stays in the list', types(held).includes('take'), false);
}

// The person's own undraft releases their hold.
{
  const undrafted = [{ t: ticket('A', { undraft: { call: 'held', pr: 701 } }), s: status({ isDraft: false }) }, { t: ticket('B'), s: status({ isDraft: false }) }];
  const { actions } = drive(decideRelease, { undrafted, dry: false, at: AT });
  t('release: only the held one is released', j(lines(actions)), j(['released: PR #701 (A) was undrafted by a person; the merge driver merges it once it is green']));
  t('release: recorded ready', JSON.parse(sets(actions)[0].slice(8)).why, 'a person undrafted it');
}

// The shared helpers the fix tries use too.
t('conflictFilesIn reads merge-tree past its tree line', j(conflictFilesIn('tree\na.js\nb.js\n')), '["a.js","b.js"]');
t('conflictFilesIn: none named, or unread, is null', j([conflictFilesIn('tree\n'), conflictFilesIn(null)]), '[null,null]');
t('fixTryQuote keeps a protected try\'s files', j(fixTryQuote({ kind: 'protected', paths: ['x'] })), '{"paths":["x"]}');

// AC7: each decision, run with a snapshot, starts no process, calls no git, gh or Jira, and writes nothing.
{
  const run = () => [
    drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([review(marker(ALL_ZERO.replace('p1=0', 'p1=1')))]) }),
    drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([review(marker(ALL_ZERO))]) }),
    drive(decideReopen, { reopens: [{ t: ticket('A'), s: status(), owed: false }], reopenedAt: null, dry: false, repo: 'o/r' }),
    drive(decideRenames, { drafts: [{ t: ticket('A'), s: status() }], undrafted: [], base: 'main' }, { 'child-renames': [{ from: 'a', to: 'b' }] }),
    drive(decideRelease, { undrafted: [{ t: ticket('A', { undraft: { call: 'held' } }), s: status() }], dry: false, at: AT }),
  ].map((r) => r.actions.length);
  const r = withNoIo(run);
  t('AC7 the decisions ran to the end under the trap', r.threw, null);
  t('AC7 and each returned its actions', r.out?.every((n) => n > 0), true);
  t('AC7 with no process started and nothing written', j(r.calls), '[]');
}

// DS-550 AC2: a preview-database PR never takes an evidence run, since the workflow posts its shots
// unchecked; its cells go to a capture worker, whose shots preview-db.mjs check reads.
{
  const BODY = '| after |\n|---|\n| _drag after-plans.png_ |\n\n```evidence\n/plans\n```\n';
  const asked = [];
  const snapWith = (hold) => undraftSnap([{ t: ticket('A'), s: status() }], {
    cfg: { ...undraftSnap([]).cfg, evidence: { workflow: 'pr-evidence.yml' } },
    reads: { ...undraftSnap([]).reads, missingShots: () => ['after-plans.png'], evidenceHold: (n) => { asked.push(n); return hold; } },
  });
  const run = (hold) => drive(decideUndraft, snapWith(hold), { 'pr-view': view([review(marker(ALL_ZERO))], { body: BODY }) }).actions;
  t('DS-550 AC5 a PR with no preview database starts its evidence run (negative control)', acts(run(null)).includes('evidence'), true);
  t('DS-550 AC2 the hold is asked for that PR', j(asked[0]), j(701));
  const held = run('held');
  t('DS-550 AC2 a held PR starts no evidence run', acts(held).includes('evidence'), false);
  t('DS-550 AC2 its cells go to a capture worker instead', held.some((a) => a.type === 'apply-fix' && /capture/.test(j(a))), true);
  // Files that are taken but did not pass the check as they are go to a capture worker, never the upload.
  const upAsked = [];
  const upSnap = (hold) => undraftSnap([{ t: ticket('A'), s: status() }], {
    cfg: { ...undraftSnap([]).cfg, upload: 'yes' },
    reads: { ...undraftSnap([]).reads, missingShots: () => [], uploadHold: (n, tk, shots) => { upAsked.push([n, shots]); return hold; } },
  });
  const upRun = (hold) => drive(decideUndraft, upSnap(hold), { 'pr-view': view([review(marker(ALL_ZERO))], { body: BODY }) }).actions;
  const free = upRun(null);
  t('DS-550 AC2 checked files are uploaded (negative control)', [free.some((a) => a.type === 'upload'), free.some((a) => a.type === 'apply-fix' && /capture/.test(j(a)))].join(), 'true,false');
  t('DS-550 AC2 the upload hold is asked for the files the cells name', j(upAsked[0]), j([701, ['after-plans.png']]));
  const unchecked = upRun('after-plans.png did not pass');
  t('DS-550 AC2 unchecked files are not uploaded but go to a capture worker', [unchecked.some((a) => a.type === 'upload'), unchecked.some((a) => a.type === 'apply-fix' && /capture/.test(j(a)))].join(), 'false,true');
}

// A draft the outage step re-ran as its hold cleared waits for that run, as a ready PR does: no fix try.
{
  const redRollup = [{ __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/9/job/90' }];
  const run = (fields) => acts(drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status({ checks: normaliseRollup(redRollup) }) }], fields), { 'pr-view': view([review(marker(ALL_ZERO))], { statusCheckRollup: redRollup }) }).actions);
  t('a draft red on a check goes to a fix worker', run({}).includes('apply-fix'), true);
  t('one the outage step re-ran as its hold cleared waits for that run', run({ outageRerun: [701] }).includes('apply-fix'), false);
}

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
