// suite: base conflict fix (a batch base in conflict with the default branch goes to a worker, twice)
import { baseFixCall, baseFixOutcome, baseFixTicket, baseFixBrief, baseFixTask, FIX_TRIES_MAX } from '../desk/bin/base-fix.mjs';
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

// The worker's ticket file, briefing and task.
const ctx = { key: 'base-feat-x', base: 'feat/x', source: 'main', fix: first.fix };
t('the ticket file names the conflict and its files', baseFixTicket(ctx).includes('Merging origin/main into feat/x conflicts, so the pass cannot sync the base. Conflicting files: a.txt.'), true);
t('the briefing has its section', baseFixBrief(ctx).startsWith('## Base conflict fix try 1 of 2: feat/x'), true);
t('the briefing with no files listed says so', baseFixBrief({ ...ctx, fix: { ...first.fix, files: null } }).includes('Conflicting files: not listed.'), true);
const task = baseFixTask(ctx);
t('the task merges, never rebases', task.includes('merge origin/main into feat/x (git merge, never a rebase or a force push)'), true);
t('the task pushes only the base', task.includes('Push with git push origin feat/x.'), true);
t('the task opens no PR', task.includes('Open no PR'), true);

process.exit(fails ? 1 : 0);
