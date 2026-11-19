// suite: pass phase: reopen and undraft (the decisions)
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideReopen, decideRenames, decideUndraft, decideRelease, undraftWrite } from '../desk/bin/pass/undraft.mjs';
import { conflictFilesIn, fixTryQuote } from '../desk/bin/pass/shared.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
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
const READS = { 'pr-close': { ok: true, out: '' }, 'pr-reopen': { ok: true, out: '' }, fetch: true, 'child-renames': [], events: { hold: null }, 'pr-view': null, 'pr-files': [], 'conflict-files': null, 'base-at': null, ready: { ok: true, out: '' }, comment: { ok: true, out: '' } };
const RECS = ['cancel', 'build', 'rebuilt', 'evidence'];
const WRITES = ['set', 'report', 'out', 'set-batch', 'apply-fix', 'take', 'gate-hold', 'upload', 'rerun-draft', 'carried', 'note', 'undraft-error', 'evidence-failures'];
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
const ACTS = new Set(['ready', 'comment', 'rerun-draft', 'cancel', 'build', 'rebuilt', 'evidence', 'apply-fix', 'upload']);
const acts = (as) => as.filter((a) => ACTS.has(a.type)).map((a) => a.type);

// A clean, green draft leaves draft, with its comment, and its record reads ready.
{
  const { actions } = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]), { 'pr-view': view([review(marker(ALL_ZERO))]) });
  t('a clean green draft is undrafted and commented on', j(acts(actions)), '["ready","comment"]');
  t('and its record reads ready', JSON.parse(sets(actions).find((f) => f.startsWith('undraft='))?.slice(8) ?? '{}').call, 'ready');
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

// A draft that cannot be read, and a record that already says the call, write nothing.
{
  const { actions } = drive(decideUndraft, undraftSnap([{ t: ticket('A'), s: status() }]));
  t('an unread draft is said for the next pass', j(lines(actions)), j(['undraft: PR #701 (A) could not be read; the next pass tries again']));
  const rec = { call: 'ready', why: null, action: null, sha: HEAD, carried_from: null, pr: 701 };
  t('a record that already says it is not written again', undraftWrite(ticket('A', { undraft: { ...rec, at: 'x' } }), rec, { dry: false, at: AT }), null);
  t('nor on a dry run', undraftWrite(ticket('A'), rec, { dry: true, at: AT }), null);
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

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
