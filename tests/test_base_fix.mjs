// suite: base conflict fix (a batch base in conflict with the default branch goes to a worker, twice)
import { baseFixCall, baseFixOutcome, baseFixTicket, baseFixBrief, baseFixTask, epicReviewCall, epicReviewTicket, epicReviewBrief, epicReviewTask, FIX_TRIES_MAX } from '../desk/bin/base-fix.mjs';
import { epicDue } from '../desk/bin/batch-state.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const M = 'm'.repeat(40);
const c = (o = {}) => ({ head: H1, source: M, files: ['a.txt'], perm: 'yes', alive: false, ...o });

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
t('the task pushes only the base', task.includes('Push with git push origin feat/x.'), true);
t('the task opens no PR', task.includes('Open no PR'), true);

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
const twice = { tries: [{ kind: 'review', try: 1, head: H1 }, { kind: 'review', try: 2, head: H2 }], running: null };
t('DS-508 AC2 after the last try, the person', epicReviewCall(twice, { pr: 300, head: '3'.repeat(40) }, { alive: false }).call, 'stuck');
t('DS-508 conflict tries do not count review tries', baseFixCall(twice, c()).fix?.try, 1);
const ectx = { key: 'base-feat-x', base: 'feat/x', source: 'main', epic: 'E-9', fix: r1.fix };
t('DS-508 the review ticket names the PR and the clean review it needs', epicReviewTicket(ectx).includes('A clean review (§4 Clean review verdict) of PR #300 is posted on it at its head.'), true);
t('DS-508 the review briefing has its section', epicReviewBrief(ectx).startsWith('## Epic PR review try 1 of 2: #300'), true);
const etask = epicReviewTask(ectx);
t('DS-508 the review task names its ticket the way every task does', /Your ticket is \$TICKET\. /.test(etask), true);
// DS-508 AC1, AC6: an epic batch's epic PR is due once every child merged into the base, a ticket held
// behind the epic itself aside, and again only once a child merges after it.
const kid = (key, at) => ({ key, state: 'done', result: { pr: 1 }, merged_at: at });
const eq = (o = {}) => ({ base: 'feat/E', epic: 'E-1', feature: false, tickets: { 'A-1': kid('A-1', '2026-11-06T10:00:00Z'), 'A-2': { key: 'A-2', state: 'parked', held_by: 'A-1|E-1' } }, ...o });
t('DS-508 AC1 every child merged, one held behind the epic: due', epicDue(eq()), true);
t('DS-508 AC1 a child still open: not due', epicDue(eq({ tickets: { 'A-1': { ...kid('A-1', null) } } })), false);
t('DS-508 AC1 feature mode is the base gate\'s, not this', epicDue(eq({ feature: true })), false);
t('DS-508 AC1 no epic: not an epic batch', epicDue(eq({ epic: null })), false);
t('DS-508 AC6 merged epic PR: not due', epicDue(eq({ promotion: { pr: 9, merged_at: '2026-11-07T00:00:00Z' } })), false);
t('DS-508 AC6 a child merged after it: due again', epicDue(eq({ promotion: { pr: 9, merged_at: '2026-11-05T00:00:00Z' } })), true);
t('DS-508 the review task posts the review and never undrafts or merges', etask.includes('Post the final review on PR #300 at its head') && etask.includes('Never mark the PR ready, merge it'), true);

process.exit(fails ? 1 : 0);
