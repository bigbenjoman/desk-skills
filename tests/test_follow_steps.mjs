// suite: follow steps (which follow steps a checker runs, the pass phase that starts and reads it, and what it found)
// covers: desk/bin/follow-steps.mjs desk/bin/pass/follow-steps.mjs
// Pure functions, plus scratch output files under a throwaway directory.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { followKind, followDelayMs, followDueAt, followDueSince, owedSteps, checkOf, readFollow, failedRun, followComment, followSettings, followPrompt, FOLLOW_RESULT_MARK, FOLLOW_TIMEOUT_MS, FOLLOW_RETRY_MS, FOLLOW_WAIT_MS } from '../desk/bin/follow-steps.mjs';
import { decideFollowSteps, followAwaits } from '../desk/bin/pass/follow-steps.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);
const T = scratch('desk-follow-steps-');

// ---- the classifier --------------------------------------------------------
const kind = (step, more = {}, labels = []) => followKind({ step, row: null, ...more }, labels);
const RUNNABLE = [
  "on the merge commit's tests run on main, check the slowest shard takes about 300 s or less, and the tests check still reports",
  "read audit.jsonl for the worker's cost on its next run",
  'check the required checks on PR #768 all passed',
  'the next CI run on main reports the lint job green',
  'batch-notes.md has the DS-645 note once the pass harvests it',
  'queue.json records follow_on_done for the ticket',
];
for (const s of RUNNABLE) t(`AC1 runnable: ${s}`, kind(s), 'runnable');
const UNKNOWN = [
  'run provision-telnyx-assistant.ts --env staging',
  'start staging-crons frequent',
  'force-push the branch',
  'Issue link not made: no grant: desk-jira link M-7 relates-to M-1',
  'place a test call on staging',
  'check the invoice totals look right',
  'open the CI dashboard in the browser and check the shard graph',
  're-run the tests workflow on main',
  'check the page loads after the deploy',
  'read the worker logs and post the cost in Slack',
];
for (const s of UNKNOWN) t(`AC4 not runnable: ${s}`, kind(s), 'unknown');
t('AC4 a step naming a §3 row is not runnable, however it reads', kind('read audit.jsonl for the cost', { row: 'staging-write' }), 'unknown');
t('AC4 a step gated on production is not runnable (DS-785 owns those)', kind('the CI run on production is green', { after: 'production' }), 'unknown');
t('a step gated on the default branch can be', kind('the CI run on main is green', { after: 'main' }), 'runnable');
t('AC3 a step carrying a person-step label is the person\'s', kind('needs-ben: read audit.jsonl for the cost', {}, ['needs-ben']), 'person');
t('AC3 a label is carried whole only', kind('needs-bento read audit.jsonl for the cost', {}, ['needs-ben']), 'runnable');
{
  const STEP = "two weeks after the merge, compare ps + tail + TaskStop calls per session (phase0-report --per-ticket's wait_calls) and CI-red fix tries per ticket across the two weeks before and after, in DS-692's report.";
  t('DS-966 AC1 a step reading a desk report with a --flag is runnable', kind(STEP), 'runnable');
  t('DS-966 AC1 and so is the same step without the flag', kind(STEP.replace(' --per-ticket', '')), 'runnable');
  t('DS-966 AC1 a report named as a node command, with flags and values, is a desk read', kind('node ~/.claude/desk/bin/phase0-report.mjs --per-ticket --days 14 shows wait_calls down'), 'runnable');
  t('DS-966 AC1 cache-report counts as a desk read', kind('cache-report --since 2026-12-01 shows a cache hit rate above 80%'), 'runnable');
  t('DS-966 AC4 a report step that also writes is not runnable', kind('run phase0-report --per-ticket and post the table as a Jira comment'), 'unknown');
  t('DS-966 AC4 a report step that names staging is not', kind('phase0-report --per-ticket on staging'), 'unknown');
  t('DS-966 AC4 a --flag with no desk report named is still elsewhere', kind('the CI run with --verbose is green'), 'unknown');
  t('DS-966 a report with no read-only CLI is not a desk report', kind('bench-report --tasks t.json shows arm 2 ahead'), 'unknown');
}
{
  const DAY = 24 * 60 * 60 * 1000;
  const d = (step, more = {}) => followDelayMs({ step, row: null, ...more });
  t('DS-966 AC2 a step saying "two weeks after the merge" waits 14 days', d('two weeks after the merge, compare the wait calls in audit.jsonl'), 14 * DAY);
  t('DS-966 "3 days after merging" waits 3 days', d('3 days after merging, read audit.jsonl'), 3 * DAY);
  t('DS-966 "a week after the merge" waits 7 days', d('a week after the merge, read audit.jsonl'), 7 * DAY);
  t('DS-966 wait_days wins over the text', d('two weeks after the merge, read audit.jsonl', { wait_days: 5 }), 5 * DAY);
  t('DS-966 a step with no delay is due at once', d('the CI run on main is green'), 0);
  t('DS-966 "two weeks before and after" names no delay after the merge', d('compare the two weeks before and after in audit.jsonl'), 0);
  const OUT = Date.parse('2026-11-21T00:00:00.000Z');
  const S = { step: 'two weeks after the merge, compare wait_calls in audit.jsonl', row: null };
  t('DS-966 a delayed step falls due its delay after the code went out', new Date(followDueAt(S, OUT)).toISOString(), '2026-12-05T00:00:00.000Z');
  t('DS-966 AC2 it is owed no run before then', j(owedSteps({ follow_on: [S] }, [], { now: OUT + 13 * DAY, out: OUT })), '[]');
  t('DS-966 AC3 and is owed one once due', j(owedSteps({ follow_on: [S] }, [], { now: OUT + 14 * DAY, out: OUT })), j([S]));
  const tk = (more = {}) => ({ K: { key: 'K', merged_at: '2026-11-21T00:00:00.000Z', follow_on: [S], ...more } });
  t('DS-966 AC3 an idle batch is woken once a delayed step falls due since it went idle', followDueSince(tk(), OUT + DAY, OUT + 14 * DAY), true);
  t('DS-966 but not before it is due', followDueSince(tk(), OUT + DAY, OUT + 13 * DAY), false);
  t('DS-966 nor again once a pass ran after it fell due', followDueSince(tk(), OUT + 14 * DAY + 1, OUT + 15 * DAY), false);
  t('DS-966 nor for a step already checked', followDueSince(tk({ follow_checks: [{ ...S, result: 'fail', at: 'x' }] }), OUT + DAY, OUT + 14 * DAY), false);
}

// ---- what is owed, and what was recorded ---------------------------------
{
  const A = { step: 'the CI run on main is green', row: null };
  const B = { step: 'check the page loads', row: null };
  const C = { step: 'the CI run on main is green', row: null, after: 'main' };
  const tk = { follow_on: [A, B, C], follow_checks: [{ ...A, result: 'fail', found: 'x', evidence: 'y' }] };
  t('owed steps are the runnable ones with no record, by text and gate', j(owedSteps(tk)), j([C]));
  t('a record is found by text and gate', j([checkOf(tk, A)?.result ?? null, checkOf(tk, C)]), j(['fail', null]));
  const now = Date.parse('2026-11-20T12:00:00.000Z');
  const pending = (at) => ({ follow_on: [A], follow_checks: [{ ...A, result: 'pending', found: 'run 9 in progress', evidence: 'u', at }] });
  t('a step found pending is owed again once FOLLOW_RETRY_MS has passed', j(owedSteps(pending(new Date(now - FOLLOW_RETRY_MS).toISOString()), [], { now })), j([A]));
  t('but not before', j(owedSteps(pending(new Date(now - FOLLOW_RETRY_MS + 1000).toISOString()), [], { now })), '[]');
  t('nor once retries are over', j(owedSteps(pending('2026-11-20T10:00:00.000Z'), [], { now, retry: false })), '[]');
  const requeued = { result: { pr: 9 }, follow_on: [A], follow_checks: [{ ...A, pr: 8, result: 'pass', found: 'x', evidence: 'y' }] };
  t('a record an earlier PR\'s checker made is not this PR\'s', j([checkOf(requeued, A), owedSteps(requeued)]), j([null, [A]]));
}

// ---- the pass phase --------------------------------------------------------
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const CI = { step: 'the CI run on main is green', row: null };
const PAGE = { step: 'check the page loads', row: null };
const merged = (key, more = {}) => ({ key, state: 'done', result: { pr: 7 }, merged_at: '2026-11-20T11:00:00.000Z', follow_on: [CI, PAGE], ...more });
const OUT_AT = Date.parse('2026-11-20T11:00:00.000Z');
const snap = (tickets, { out = tickets.map((x) => x.key), outAt = OUT_AT, held = tickets.flatMap((x) => [`${x.key}:merge`, `${x.key}:main`]), alive = [] } = {}) => ({
  tickets: Object.fromEntries(tickets.map((x) => [x.key, x])), labels: [], out: new Map(out.map((k) => [k, outAt])), held: new Set(held), alive: new Set(alive), now: NOW,
});
const run = (started = '2026-11-20T11:55:00.000Z') => ({ id: 'A-x', pid: 4242, started, out: '/s/follow/A-x.json', steps: [CI] });
t('AC1 a merged ticket whose code is out gets a checker for its runnable steps only', j(decideFollowSteps(snap([merged('A')]))), j([{ type: 'start', key: 'A', steps: [CI] }]));
const none = (name, tk, opts) => t(name, j(decideFollowSteps(snap([tk], opts))), '[]');
none('a ticket whose code is not out yet gets none', merged('A'), { out: [] });
none('a ticket not merged gets none', merged('A', { merged_at: null }));
none('a ticket whose steps the person settled gets none', merged('A', { follow_on_done: '2026-11-20T11:30:00.000Z' }));
none('a ticket still owed its review\'s post-merge criteria gets none yet', merged('A', { pr_status: { post_merge: [{ step: 'x' }] } }));
none('a step already checked is not run again', merged('A', { follow_checks: [{ ...CI, pr: 7, result: 'fail', found: 'x', evidence: 'y' }] }));
none('a step whose gate does not hold yet is not run', merged('A', { follow_on: [{ ...CI, after: 'main' }] }), { held: ['A:merge'] });
t('one whose gate holds is', j(decideFollowSteps(snap([merged('A', { follow_on: [{ ...CI, after: 'main' }] })], { held: ['A:main'] })).map((a) => a.type)), '["start"]');
{
  const found = (at) => merged('A', { follow_checks: [{ ...CI, pr: 7, result: 'pending', found: 'run 9 in progress', evidence: 'u', at }] });
  t('a step found pending is checked again later', j(decideFollowSteps(snap([found('2026-11-20T11:30:00.000Z')])).map((a) => a.type)), '["start"]');
  none('but not once FOLLOW_WAIT_MS has passed since its code went out', found('2026-11-20T11:30:00.000Z'), { outAt: NOW - FOLLOW_WAIT_MS });
  t('while it may still be, the batch waits on it', followAwaits(snap([found('2026-11-20T11:55:00.000Z')])), true);
  t('and not after', followAwaits(snap([found('2026-11-20T11:55:00.000Z')], { outAt: NOW - FOLLOW_WAIT_MS })), false);
  t('a running checker keeps the batch waiting too', followAwaits(snap([merged('A', { follow_run: run() })])), true);
  t('a settled record does not', followAwaits(snap([merged('A', { follow_checks: [{ ...CI, pr: 7, result: 'fail', found: 'x', evidence: 'y', at: 'x' }] })])), false);
}
{
  const LATER = { step: 'a week after the merge, the CI run on main is green', row: null };
  none('DS-966 AC2 a step not due yet gets no checker', merged('A', { follow_on: [LATER] }));
  t('DS-966 AC2 and does not keep the batch from idling', followAwaits(snap([merged('A', { follow_on: [LATER] })])), false);
  t('DS-966 AC3 once due it gets one', j(decideFollowSteps(snap([merged('A', { follow_on: [LATER] })], { outAt: NOW - 7 * 24 * 60 * 60 * 1000 }))),
    j([{ type: 'start', key: 'A', steps: [LATER] }]));
  const found = merged('A', { follow_on: [LATER], follow_checks: [{ ...LATER, pr: 7, result: 'pending', found: 'x', evidence: 'u', at: '2026-11-20T11:30:00.000Z' }] });
  t('DS-966 a delayed step found pending is retried for FOLLOW_WAIT_MS after it fell due, not after its merge',
    j(decideFollowSteps(snap([found], { outAt: NOW - 7 * 24 * 60 * 60 * 1000 })).map((a) => a.type)), '["start"]');
}
none('AC4 a ticket with no runnable step gets none', merged('A', { follow_on: [PAGE] }));
none('a run still going is left to finish', merged('A', { follow_run: run() }), { alive: ['A'] });
t('a run past its time is stopped', j(decideFollowSteps(snap([merged('A', { follow_run: run('2026-11-20T11:00:00.000Z') })], { alive: ['A'] }))),
  j([{ type: 'stop', key: 'A', run: run('2026-11-20T11:00:00.000Z') }]));
t('a run that has ended is read, even once the person settled the steps', j(decideFollowSteps(snap([merged('A', { follow_on_done: 'x', follow_run: run() })])).map((a) => a.type)), '["harvest"]');
t('the timeout is a quarter of an hour', FOLLOW_TIMEOUT_MS, 15 * 60 * 1000);
{
  const { out, threw, calls } = withNoIo(() => decideFollowSteps(snap([merged('A'), merged('B', { follow_run: run() }), merged('C', { follow_run: run('2026-11-20T11:00:00.000Z') })], { alive: ['C'] })));
  t('the decision returns its actions', j(out?.map((a) => `${a.key}:${a.type}`)), '["A:start","B:harvest","C:stop"]');
  t('and starts no process and writes no file on the way', j([threw, calls]), '[null,[]]');
}

// ---- what a checker found ------------------------------------------------------
const output = (name, result, more = {}) => {
  const p = join(T, `${name}.json`);
  writeFileSync(p, `${JSON.stringify({ type: 'result', total_cost_usd: 0.04, result, ...more })}\n`);
  return p;
};
const STEPS = [CI, { step: 'read audit.jsonl for the cost', row: null }];
{
  const p = output('two', `Checked.\n${FOLLOW_RESULT_MARK} ${j({ steps: [{ n: 0, result: 'pass', found: 'run 9 passed', evidence: 'https://github.com/a/b/actions/runs/9' }, { n: 1, result: 'fail', found: 'no cost line', evidence: '/s/audit.jsonl' }] })}`);
  t('AC1 AC2 each step\'s result, what it found and its evidence are read, with the cost', j(readFollow(p, STEPS)),
    j({ cost: 0.04, results: [{ ...CI, result: 'pass', found: 'run 9 passed', evidence: 'https://github.com/a/b/actions/runs/9' }, { ...STEPS[1], result: 'fail', found: 'no cost line', evidence: '/s/audit.jsonl' }] }));
}
{
  const p = output('one', `${FOLLOW_RESULT_MARK} ${j({ steps: [{ n: 0, result: 'pass', found: 'ok', evidence: 'u' }] })}`);
  t('a step the checker left out is failed, its evidence the output file', j(readFollow(p, STEPS).results[1]), j({ ...STEPS[1], result: 'fail', found: 'the checker gave no result for it', evidence: p }));
}
{
  const p = output('pending', `${FOLLOW_RESULT_MARK} ${j({ steps: [{ n: 0, result: 'pending', found: 'run 9 in progress', evidence: 'u' }, { n: 1, result: 'maybe' }] })}`);
  t('a step whose run has not finished is pending; a result it does not know is failed', j(readFollow(p, STEPS).results.map((x) => x.result)), '["pending","fail"]');
}
t('a checker that left no result line is an error', readFollow(output('none', 'I could not finish.'), STEPS).error, `gave no ${FOLLOW_RESULT_MARK} line`);
t('a checker with no output is an error', readFollow(join(T, 'missing.json'), STEPS).error, 'gave no output');
t('an error fails every step of the run, naming why and where', j(failedRun({ out: '/o', steps: [CI] }, 'left no output')),
  j([{ ...CI, result: 'fail', found: 'the follow-step checker left no output', evidence: '/o' }]));

// ---- the PR comment, the settings and the prompt ------------------------------------
{
  const c = followComment('DS-1', [{ ...CI, result: 'pass', found: 'run 9 passed', evidence: 'https://x/9' }, { ...PAGE, result: 'fail', found: 'no', evidence: '/e' }]);
  t('AC1 the PR comment names each step and how it went, and its marker', /- passed: the CI run on main is green\. Found: run 9 passed\. Evidence: https:\/\/x\/9\n- \*\*failed\*\*: check the page loads\. Found: no\. Evidence: \/e\n\nEach failed step is listed in needs-you\.\n\(DS-1\/desk-autopilot follow-steps\)$/.test(c), true);
  t('a comment with every step passed says nothing is left', /Nothing is left for a person\./.test(followComment('DS-1', [{ ...CI, result: 'pass', found: 'ok', evidence: 'u' }])), true);
}
{
  const s = followSettings({ bin: '/b', dirs: ['/state', '/home'] });
  t('the checker reads only: gh run, pr view and checks, desk-gh reads, and the files under its directories',
    j(s.permissions.allow), j(['Bash(gh run list:*)', 'Bash(gh run view:*)', 'Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(node /b/desk-gh.mjs read:*)',
      'Bash(node /b/phase0-report.mjs)', 'Bash(node /b/phase0-report.mjs --*)', 'Bash(node /b/cache-report.mjs:*)',
      'Read(//state/**)', 'Grep(//state/**)', 'Glob(//state/**)', 'Read(//home/**)', 'Grep(//home/**)', 'Glob(//home/**)']));
  t('and may not write', j(s.permissions.deny), j(['Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent']));
  const p = followPrompt({ slug: 'acme__x', repo: 'acme/x', t: { key: 'DS-1', result: { pr: 7 }, merged_at: 'm' }, steps: [CI], bin: '/b', dirs: ['/state'] });
  t('the prompt numbers each step and asks for the result line', /\n0\. the CI run on main is green\n[\s\S]*FOLLOW_RESULT: \{"steps"/.test(p), true);
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
