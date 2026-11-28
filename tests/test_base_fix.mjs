// suite: base conflict fix (a batch base in conflict with the default branch goes to a worker, twice)
// layer: L1
import { baseFixCall, baseFixOutcome, lockWaitPark, baseFixTicket, baseFixBrief, baseFixTask, epicReviewCall, epicReviewTicket, epicReviewBrief, epicReviewTask, promotionChecksCall, promotionChecksTicket, promotionChecksBrief, promotionChecksTask, mergeTry, cleanedTry, notStarted, FIX_TRIES_MAX, START_TRIES_MAX } from '../desk/bin/base-fix.mjs';
import { epicDue, epicCarry } from '../desk/bin/batch-state.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const M = 'm'.repeat(40);
const c = (o = {}) => ({ head: H1, source: M, files: ['a.txt'], perm: 'yes', alive: false, ...o });
const ctxOf = (fix) => ({ key: 'base-feat-x', base: 'feat/x', source: 'main', fix });

// AC1: a first conflict starts try 1.
const first = baseFixCall(null, c());
t('AC1 a first conflict starts try 1', `${first.call} ${first.fix.try} of ${first.fix.of}`, `spawn 1 of ${FIX_TRIES_MAX}`);
t('AC1 the try is for the base head it met, with its files', `${first.fix.head} ${first.fix.files.join(',')}`, `${H1} a.txt`);

// AC5: only §3 pr-conflict-unreviewed `yes` lets a worker take it.
for (const perm of ['no', 'ask', undefined]) {
  t(`AC5 pr-conflict-unreviewed ${perm}: the person's`, baseFixCall(null, c({ perm })).call, 'person');
}
t('AC5 and it says which row', baseFixCall(null, c({ perm: 'ask' })).why, 'config §3 pr-conflict-unreviewed is "ask", so no worker resolves it');

// A running try's live worker is waited on, never doubled.
const one = { tries: [{ try: 1, head: H1 }], running: 'sid-1' };
t('a live try is waited on', baseFixCall(one, c({ alive: true })).call, 'wait');

// AC4: a try that left the base where it was, or two tries, go to the person with what the last did.
const done1 = { tries: [{ try: 1, head: H1, outcome: 'parked: neither side can be kept' }], running: null };
const s1 = baseFixCall(done1, c());
t('AC4 a try already made at this head: stuck', s1.call, 'stuck');
t('AC4 naming the last try\'s outcome', s1.why, 'still in conflict after 1 fix try; the last try parked: neither side can be kept');
const next = baseFixCall(done1, c({ head: H2 }));
t('a try that moved the base, still in conflict: try 2', `${next.call} ${next.fix?.try}`, 'spawn 2');
const done2 = { tries: [{ try: 1, head: H1 }, { try: 2, head: H2, outcome: 'ended with no marker' }], running: null };
t('AC4 after two tries: stuck', baseFixCall(done2, c({ head: '3'.repeat(40) })).why, 'still in conflict after 2 fix tries; the last try ended with no marker');

// The outcome a finished worker left.
t('outcome: the last park', baseFixOutcome([['AUTOPILOT_STAGE', '4/9'], ['AUTOPILOT_PARK', 'which side? ']]), 'parked: which side?');
t('outcome: a done', baseFixOutcome([['AUTOPILOT_DONE', 'pr=none jira=none']]), 'finished: pr=none jira=none');
t('outcome: neither', baseFixOutcome([]), 'ended with no marker');
t('outcome: a park answered, then a done, is finished', baseFixOutcome([['AUTOPILOT_PARK', 'which side?'], ['AUTOPILOT_DONE', 'pr=none jira=none']]), 'finished: pr=none jira=none');
t('outcome: a done, then a park, is parked', baseFixOutcome([['AUTOPILOT_DONE', 'pr=none'], ['AUTOPILOT_PARK', 'push refused']]), 'parked: push refused');

// A park made only on the busy test lock is said with its own marker, and spends no try.
t('DS-663 lock wait: the marker before the last park', lockWaitPark([['AUTOPILOT_PARK_WAIT', 'test-lock'], ['AUTOPILOT_PARK', 'lock busy']]), true);
t('DS-663 lock wait negative: a park with no marker', lockWaitPark([['AUTOPILOT_PARK', 'which side?']]), false);
t('DS-663 lock wait negative: the marker before an earlier park only', lockWaitPark([['AUTOPILOT_PARK_WAIT', 'test-lock'], ['AUTOPILOT_PARK', 'lock busy'], ['AUTOPILOT_PARK', 'which side?']]), false);
t('DS-663 lock wait negative: a done after it', lockWaitPark([['AUTOPILOT_PARK_WAIT', 'test-lock'], ['AUTOPILOT_PARK', 'lock busy'], ['AUTOPILOT_DONE', 'pr=none']]), false);
t('DS-663 lock wait negative: another wait', lockWaitPark([['AUTOPILOT_PARK_WAIT', 'a person'], ['AUTOPILOT_PARK', 'x']]), false);
const waited = { tries: [{ try: 1, head: H1, lock_wait: true, outcome: 'parked: lock busy' }], running: null };
const again = baseFixCall(waited, c());
t('DS-663 AC4 a try that waited only on the test lock spends none: try 1 again at the same head', `${again.call} ${again.fix?.try}`, 'spawn 1');
t('DS-663 AC4 negative: the try after it, at the same head, is spent as before', baseFixCall({ tries: [...waited.tries, { try: 1, head: H1, outcome: 'parked: x' }], running: null }, c()).call, 'stuck');
const fromCtx = { key: 'base-feat-x', base: 'feat/x', source: 'main', fix: { ...first.fix, from: { try: 1, ref: 'refs/desk/base-fix/base-feat-x/1', sha: H2 } } };
t('DS-663 AC2 a try from a kept merge is briefed on it', baseFixBrief(fromCtx).includes(`HEAD is already ${H2.slice(0, 12)}, the merge of origin/main into feat/x that try 1 committed and did not push, kept on refs/desk/base-fix/base-feat-x/1`), true);
t('DS-663 AC2 and its task does not merge again', baseFixTask(fromCtx).includes('carry on from your HEAD') && !baseFixTask(fromCtx).includes('then merge origin/main'), true);
t('DS-663 both tasks name the lock-wait marker', [baseFixTask(ctxOf(first.fix)), baseFixTask(ctxOf({ ...first.fix, check: { command: 'x', output: 'y' } }))].every((s) => s.includes('AUTOPILOT_PARK_WAIT: test-lock on the line before your AUTOPILOT_PARK')), true);

// A worker that may not push the base could only park: without §3 batch-base-push no try starts.
const noPush = baseFixCall(null, c({ push: { perm: 'ask', key: 'batch-base-push', ok: false } }));
t('no base push grant: the person\'s', noPush.call, 'person');
t('and it says which row, and how to grant it', noPush.why, 'config §3 batch-base-push is "ask", so no worker may push the resolved base (run passes with AUTOPILOT_BASE_PUSH_APPROVED=1 to let one)');
t('with the grant: a try starts', baseFixCall(null, c({ push: { perm: 'yes', key: 'batch-base-push', ok: true } })).call, 'spawn');

// The worker's ticket file, briefing and task.
const ctx = { key: 'base-feat-x', base: 'feat/x', source: 'main', fix: first.fix };
t('the ticket file names the conflict and its files', baseFixTicket(ctx).includes('Merging origin/main into feat/x conflicts, so the pass cannot sync the base. Conflicting files: a.txt.'), true);
t('the briefing has its section', baseFixBrief(ctx).startsWith('## Base conflict fix try 1 of 2: feat/x'), true);
t('the briefing with no files listed says so', baseFixBrief({ ...ctx, fix: { ...first.fix, files: null } }).includes('Conflicting files: not listed.'), true);
const task = baseFixTask(ctx);
t('the task merges, never rebases', task.includes('merge origin/main into feat/x (git merge, never a rebase or a force push)'), true);
t('DS-594 the task pushes only the base, by HEAD from its detached worktree', task.includes('Push with git push origin HEAD:refs/heads/feat/x.') && task.includes('on a detached HEAD at origin/feat/x: never check feat/x out'), true);
t('the task opens no PR', task.includes('Open no PR'), true);

// A merge the merged-tree check failed goes the conflict's way, with the check's output.
const treeCheck = { command: 'apps/api: uv run python check.py', output: 'Revision 122 is present more than once' };
const treeFix = baseFixCall(null, c({ files: [], check: treeCheck })).fix;
t('AC1 a failed merged-tree check starts try 1 with its output', `${treeFix.try} ${treeFix.check.output}`, '1 Revision 122 is present more than once');
t('AC1 negative: a conflict carries no check', 'check' in first.fix, false);
t('AC5 tries spent: says the check still fails', baseFixCall(done1, c({ check: treeCheck })).why, 'still failing the check after 1 fix try; the last try parked: neither side can be kept');
const treeCtx = { key: 'base-feat-x', base: 'feat/x', source: 'main', fix: treeFix };
const treeBrief = baseFixBrief(treeCtx);
t('AC2 the briefing quotes the output', treeBrief.includes('> Revision 122 is present more than once'), true);
t('AC2 the briefing renumbers the base\'s own after the source\'s head', treeBrief.includes("renumber feat/x's own so they come after the head of origin/main, and leave main's as they are"), true);
t('AC2 negative: a conflict briefing does not', baseFixBrief(ctx).includes('renumber'), false);
t('AC2 the ticket makes the check an acceptance criterion', baseFixTicket(treeCtx).includes('`desk-env cmds merged-tree-check-cmd` prints passes on the merged feat/x'), true);
const treeTask = baseFixTask(treeCtx);
t('AC2 the task runs the check before the push', treeTask.indexOf('Before you push, run those items again') > 0 && treeTask.indexOf('Before you push, run those items again') < treeTask.indexOf('Otherwise push with git push origin HEAD:refs/heads/feat/x'), true);
t('AC1 a conflict task runs the check before its push', task.indexOf('merged-tree-check-cmd') > 0 && task.indexOf('merged-tree-check-cmd') < task.indexOf('Push with git push origin HEAD:refs/heads/feat/x'), true);
t('AC1 a conflict ticket makes the check a criterion', baseFixTicket(ctx).includes('merged-tree-check-cmd'), true);
t('AC5 the task pushes nothing while it fails',treeTask.includes('If the check still fails, push nothing and park quoting its output'), true);

// DS-508 AC2: the epic PR's review tries share base_fix, one per head and at most FIX_TRIES_MAX.
const v1 = { pr: 300, head: H1 };
const r1 = epicReviewCall(null, v1, { alive: false });
t('DS-508 AC2 a draft epic PR with no clean review starts review try 1', `${r1.call} ${r1.fix.kind} ${r1.fix.try} of ${r1.fix.of} #${r1.fix.pr}`, `spawn review 1 of ${FIX_TRIES_MAX} #300`);
const reviewing = { tries: [{ kind: 'review', try: 1, head: H1, pr: 300 }], running: 'sid-r' };
t('DS-508 AC2 a live review try is waited on', epicReviewCall(reviewing, v1, { alive: true }).call, 'wait');
const reviewed = { tries: [{ kind: 'review', try: 1, head: H1, pr: 300, outcome: 'finished: pr=300 jira=none' }], running: null };
const rs = epicReviewCall(reviewed, v1, { alive: false });
t('DS-508 AC2 a try already made at this head goes to the person, naming it', `${rs.call}: ${rs.why}`, `stuck: no clean review at ${H1.slice(0, 12)} after 1 review try; the last try finished: pr=300 jira=none`);
t('DS-508 AC2 a head the try moved gets the next try', epicReviewCall(reviewed, { pr: 300, head: H2 }, { alive: false }).fix?.try, 2);
const twice = { tries: [{ kind: 'review', try: 1, head: H1, pr: 300 }, { kind: 'review', try: 2, head: H2, pr: 300 }], running: null };
t('DS-508 AC2 after the last try, the person', epicReviewCall(twice, { pr: 300, head: '3'.repeat(40) }, { alive: false }).call, 'stuck');
t('DS-508 AC2 a later epic PR starts its own tries, not the last one\'s', epicReviewCall(twice, { pr: 301, head: '3'.repeat(40) }, { alive: false }).fix?.try, 1);
t('DS-508 conflict tries do not count review tries', baseFixCall(twice, c()).fix?.try, 1);
const ectx = { key: 'base-feat-x', base: 'feat/x', source: 'main', epic: 'E-9', fix: r1.fix };
t('DS-508 the review ticket names the PR and the clean review it needs', epicReviewTicket(ectx).includes('A clean review (§4 Clean review verdict) of PR #300 is posted on it at its head.'), true);
t('DS-508 the review briefing has its section', epicReviewBrief(ectx).startsWith('## Epic PR review try 1 of 2: #300'), true);
const etask = epicReviewTask(ectx);
t('DS-508 the review task names its ticket the way every task does', /Your ticket is \$TICKET\. /.test(etask), true);
t('DS-594 the review task pushes HEAD to the base from its detached worktree', etask.includes('push with git push origin HEAD:refs/heads/feat/x,') && etask.includes('on a detached HEAD at origin/feat/x'), true);
t('DS-594 both tasks name the push-retry form of that push, in place of the contract\'s branch forms', [task, etask].every((s) => s.includes('run as node ~/.claude/desk/bin/push-retry.mjs origin HEAD:refs/heads/feat/x: it takes the place of the worker contract\'s origin <branch> push forms')), true);
t('DS-594 the review task\'s sentences are spaced', etask.includes('(Stage 4b). Fix every'), true);
// DS-508 AC1, AC6: an epic batch's epic PR is due once every child merged into the base, a ticket held
// behind the epic itself aside, and again only once a child merges after it.
const kid = (key, at) => ({ key, state: 'done', result: { pr: 1 }, merged_at: at });
const eq = (o = {}) => ({ base: 'feat/E', epic: 'E-1', feature: false, tickets: { 'A-1': kid('A-1', '2026-11-06T10:00:00Z'), 'A-2': { key: 'A-2', state: 'parked', held_by: 'A-1|E-1' } }, ...o });
t('DS-508 AC1 every child merged, one held behind the epic: due', epicDue(eq()), true);
t('DS-508 AC1 a child still open: not due', epicDue(eq({ tickets: { 'A-1': { ...kid('A-1', null) } } })), false);
t('DS-508 AC1 a child done with no PR does not hold it back', epicDue(eq({ tickets: { 'A-1': kid('A-1', '2026-11-06T10:00:00Z'), 'A-3': { key: 'A-3', state: 'done', result: { pr: null } } } })), true);
t('DS-508 AC1 with nothing merged into the base, nothing to land', epicDue(eq({ tickets: { 'A-3': { key: 'A-3', state: 'done', result: { pr: null } } } })), false);
t('DS-508 AC1 feature mode is the base gate\'s, not this',epicDue(eq({ feature: true })), false);
t('DS-508 AC1 no epic: not an epic batch', epicDue(eq({ epic: null })), false);
t('DS-508 AC6 merged epic PR: not due', epicDue(eq({ promotion: { pr: 9, merged_at: '2026-11-07T00:00:00Z' } })), false);
t('DS-508 AC6 a child merged after it: due again', epicDue(eq({ promotion: { pr: 9, merged_at: '2026-11-05T00:00:00Z' } })), true);
// DS-784: the next epic PR keeps every earlier merge, through a retry that failed to open it too.
t('DS-784 no epic PR merged yet: nothing carried', JSON.stringify(epicCarry({ pr: null, why: 'x' })), '{}');
const carried = epicCarry({ pr: 9, merged_at: '2026-11-07T00:00:00Z' });
t('DS-784 a merged epic PR is carried as since and in merged', JSON.stringify(carried), '{"since":"2026-11-07T00:00:00Z","merged":[{"pr":9,"merged_at":"2026-11-07T00:00:00Z"}]}');
t('DS-784 a failed reopen\'s record keeps both for the retry', JSON.stringify(epicCarry({ ...carried, pr: null, why: 'refused' })), JSON.stringify(carried));
t('DS-784 a second merge adds to the first', epicCarry({ ...carried, pr: 12, merged_at: '2026-11-09T00:00:00Z' }).merged.map((m) => m.pr).join(), '9,12');
t('DS-508 the review task posts the review and never undrafts or merges', etask.includes('Post the final review on PR #300 at its head') && etask.includes('Never mark the PR ready, merge it'), true);

const pv = { pr: 400, head: H1, failing: ['flows-image', 'portal (1/3)'] };
const p1 = promotionChecksCall(null, pv, { alive: false });
t('DS-786 AC1 a red promotion PR starts check try 1, naming its checks', `${p1.call} ${p1.fix.kind} ${p1.fix.try} of ${p1.fix.of} #${p1.fix.pr} ${p1.fix.failing.join('|')}`, `spawn checks 1 of ${FIX_TRIES_MAX} #400 flows-image|portal (1/3)`);
const checking = { tries: [{ kind: 'checks', try: 1, head: H1, pr: 400 }], running: 'sid-c' };
t('DS-786 AC1 a live check try is waited on', promotionChecksCall(checking, pv, { alive: true }).call, 'wait');
const checked = { tries: [{ kind: 'checks', try: 1, head: H1, pr: 400, outcome: 'parked: the Flows image is missing' }], running: null };
const ps1 = promotionChecksCall(checked, pv, { alive: false });
t('DS-786 AC2 a try already made at this head goes to the person, naming the checks and the last try', `${ps1.call} ${ps1.tried}: ${ps1.why}`, `stuck 1: still failing flows-image, portal (1/3) at ${H1.slice(0, 12)} after 1 check try; the last try parked: the Flows image is missing`);
t('DS-786 AC1 a head the try moved gets the next try', promotionChecksCall(checked, { ...pv, head: H2 }, { alive: false }).fix?.try, 2);
const checkedTwice = { tries: [{ kind: 'checks', try: 1, head: H1, pr: 400 }, { kind: 'checks', try: 2, head: H2, pr: 400 }], running: null };
t('DS-786 AC2 after the last try, the person', promotionChecksCall(checkedTwice, { ...pv, head: '3'.repeat(40) }, { alive: false }).call, 'stuck');
t('DS-786 AC1 the next promotion PR starts its own tries', promotionChecksCall(checkedTwice, { ...pv, pr: 401 }, { alive: false }).fix?.try, 1);
t('DS-786 negative: conflict tries do not count check tries', baseFixCall(checkedTwice, c()).fix?.try, 1);
t('DS-786 negative: review tries do not count check tries', epicReviewCall(checkedTwice, { pr: 400, head: H1 }, { alive: false }).fix?.try, 1);
t('DS-786 negative: check tries do not count review tries', promotionChecksCall(twice, { ...pv, pr: 300 }, { alive: false }).fix?.try, 1);
t('DS-786 mergeTry: only a try with no kind merges the default branch in', [{}, { kind: 'review' }, { kind: 'checks' }].map(mergeTry).join(), 'true,false,false');
t('DS-786 cleanedTry: a merge try and a check try leave nothing in the base worktree, a review try is left', [{}, { kind: 'review' }, { kind: 'checks' }].map(cleanedTry).join(), 'true,false,true');
const otherLive = (rec) => ({ tries: [...rec.tries, { try: 1, head: H2, source: H1 }], running: 'sid-m' });
t('DS-786 AC2 a spent PR stays the person\'s while a conflict fix worker holds the worktree', promotionChecksCall(otherLive(checked), pv, { alive: true }).call, 'stuck');
t('DS-786 AC1 negative: a PR with tries left waits on a conflict fix worker', promotionChecksCall(otherLive({ tries: [] }), pv, { alive: true }).call, 'wait');
const promoNoPush = promotionChecksCall(null, pv, { alive: false, push: { ok: false, perm: 'no', key: 'batch-base-push' } });
t('DS-786 AC2 without the base push grant no try starts: the person, told why', `${promoNoPush.call} ${promoNoPush.tried}: ${promoNoPush.why}`, 'person 0: flows-image, portal (1/3) fail, and config §3 batch-base-push is "no", so no worker may push a fix to the base');
t('DS-786 AC1 with the grant a try starts', promotionChecksCall(null, pv, { alive: false, push: { ok: true, perm: 'yes', key: 'batch-base-push' } }).call, 'spawn');
const pctx = { key: 'base-feat-x', base: 'feat/x', source: 'main', fix: p1.fix };
t('DS-786 the check ticket names the PR and its failing checks', promotionChecksTicket(pctx).includes(`At its head ${H1.slice(0, 12)} these checks fail: flows-image, portal (1/3).`), true);
t('DS-786 the check briefing has its section', promotionChecksBrief(pctx).startsWith('## Promotion PR check try 1 of 2: #400'), true);
const ptask = promotionChecksTask(pctx);
t('DS-786 the check task pushes HEAD to the base from its detached worktree', ptask.includes('push with git push origin HEAD:refs/heads/feat/x.') && ptask.includes('on a detached HEAD at origin/feat/x'), true);
t('DS-786 the check task parks on a check no change on the base clears, and never undrafts or merges', ptask.includes('push nothing for it and park naming the check') && ptask.includes('Never mark the PR ready, merge it'), true);

// DS-1034: a merge try that is due and does not start spends no try; START_TRIES_MAX failed starts are the person's.
{
  const fix = baseFixCall(null, c()).fix;
  const AT = '2026-11-27T00:00:00Z', LATER = '2026-11-27T00:05:00Z';
  const w1 = notStarted(null, fix, 'repo workers: 1 of the §3b cap of 1 running', { at: AT });
  t('DS-1034 AC1 a try that waits for room is kept as a start, not a try', JSON.stringify([w1.tries, w1.start]),
    JSON.stringify([[], { try: 1, files: ['a.txt'], since: AT, passes: 1, failed: 0, why: 'repo workers: 1 of the §3b cap of 1 running' }]));
  const w2 = notStarted(w1, fix, 'spawn refused: no seat', { failed: true, at: LATER });
  t('DS-1034 AC2 a refused spawn counts a failed start and keeps the first wait\'s time', `${w2.start.passes} ${w2.start.failed} ${w2.start.since} ${w2.start.why}`, `2 1 ${AT} spawn refused: no seat`);
  t('DS-1034 AC2 and the next pass tries again, as try 1', `${baseFixCall(w2, c()).call} ${baseFixCall(w2, c()).fix?.try}`, 'spawn 1');
  const w3 = notStarted(notStarted(w2, fix, 'spawn refused: no seat', { failed: true, at: LATER }), fix, 'spawn refused: no seat', { failed: true, at: LATER });
  const stuck = baseFixCall(w3, c());
  t(`DS-1034 AC2 after ${START_TRIES_MAX} failed starts it is the person's, naming why`, `${stuck.call}: ${stuck.why}`,
    `stuck: its fix worker could not be started in ${START_TRIES_MAX} tries; the last: spawn refused: no seat`);
  t('DS-1034 a start kept beside earlier tries keeps them', notStarted({ tries: [{ try: 1, head: H2 }], running: null, port: null }, fix, 'x', { at: AT }).tries.length, 1);
}

process.exit(fails ? 1 : 0);
