// suite: desk-ci measure (minutes, red rate, round trips, call budget)
// desk-ci.mjs measure on fixture runs, jobs and pull requests: each job rounds up to the minute and a
// hosted one stops at 6 h, red rate, round trips and time to green read a PR's pushes and re-runs,
// sampled jobs scale back up within their month, and the API collector stays inside its call budget
// and the rate limit's reserve.
import { quantile, jobMinutes, pickSample, measure, collect, report } from '../desk/bin/desk-ci.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const iso = (base, s) => new Date(Date.parse(base) + s * 1000).toISOString();

// ---- rounding and quantiles
const span = (s) => ({ started_at: iso('2026-09-01T00:00:00Z', 0), completed_at: iso('2026-09-01T00:00:00Z', s) });
t('61s rounds up to 2 minutes', jobMinutes(span(61)), 2);
t('60s is 1 minute', jobMinutes(span(60)), 1);
t('1s bills a whole minute', jobMinutes(span(1)), 1);
t('a job that never ran bills nothing', jobMinutes({ started_at: null, completed_at: null }), 0);
t('median of an even count is the mean of the middle two', quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5.5);
t('p90 interpolates between ranks', Math.round(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) * 10) / 10, 9.1);
t('quantile of nothing is null', quantile([], 0.5), null);

// ---- a window: three PRs and a push to main
const T0 = '2026-09-10T10:00:00Z';
const T1 = iso(T0, 3600);
const T2 = iso(T0, 7200);
const HOSTED = { labels: ['ubuntu-latest'], runner_group_name: 'GitHub Actions' };
const job = (base, o) => ({ status: 'completed', run_attempt: 1, ...HOSTED, ...o,
  created_at: iso(base, o.created ?? 0), started_at: iso(base, o.start), completed_at: iso(base, o.end) });
const run = (o) => ({ status: 'completed', run_attempt: 1, name: 'CI', event: 'pull_request', pull_requests: [], ...o });
const runs = [
  // PR 1: the test job fails, a re-run passes.
  run({ id: 1, head_sha: 'a', head_branch: 'feat/one', pull_requests: [{ number: 1 }], conclusion: 'success', run_attempt: 2, created_at: T0, updated_at: iso(T0, 680) }),
  // PR 2: two jobs fail, a new push passes.
  run({ id: 2, head_sha: 'b', head_branch: 'feat/two', pull_requests: [{ number: 2 }], conclusion: 'failure', created_at: T1, updated_at: iso(T1, 200) }),
  run({ id: 3, head_sha: 'c', head_branch: 'feat/two', pull_requests: [{ number: 2 }], conclusion: 'success', created_at: iso(T1, 1800), updated_at: iso(T1, 1920) }),
  // PR 3, matched by branch: green first time on a self-hosted runner.
  run({ id: 4, head_sha: 'd', head_branch: 'feat/three', conclusion: 'success', created_at: T2, updated_at: iso(T2, 500) }),
  // A push to main on macOS.
  run({ id: 5, name: 'Deploy', event: 'push', head_sha: 'e', head_branch: 'main', conclusion: 'success', created_at: iso(T0, 100), updated_at: iso(T0, 130) }),
  run({ id: 6, status: 'in_progress', head_sha: 'f', head_branch: 'feat/one', conclusion: null, created_at: T2, updated_at: T2 }),
];
const jobs = new Map([
  [1, [job(T0, { name: 'test', conclusion: 'failure', start: 10, end: 71 }), job(T0, { name: 'lint', conclusion: 'success', start: 5, end: 35 }),
    job(T0, { name: 'test', run_attempt: 2, conclusion: 'success', created: 600, start: 620, end: 680 })]],
  [2, [job(T1, { name: 'build', conclusion: 'failure', start: 30, end: 150 }), job(T1, { name: 'lint', conclusion: 'failure', start: 30, end: 200 })]],
  [3, [job(T1, { name: 'build', conclusion: 'success', created: 1800, start: 1830, end: 1920 })]],
  [4, [job(T2, { name: 'e2e', conclusion: 'success', start: 300, end: 500, labels: ['self-hosted', 'arm64'], runner_group_name: 'Default' })]],
  [5, [job(iso(T0, 100), { name: 'ship', conclusion: 'success', start: 0, end: 30, labels: ['macos-14'] })]],
]);
const prs = [
  { number: 1, created_at: '2026-09-10T09:00:00Z', merged_at: '2026-09-11T00:00:00Z', head: { ref: 'feat/one' } },
  { number: 2, created_at: '2026-09-10T09:00:00Z', merged_at: '2026-09-12T00:00:00Z', head: { ref: 'feat/two' } },
  { number: 3, created_at: '2026-09-10T09:00:00Z', merged_at: '2026-10-01T00:00:00Z', head: { ref: 'feat/three' } },
];
const m = measure({ runs, jobs, prs, since: '2026-07-20', until: '2026-10-17' });
const ci = m.workflows.find((w) => w.workflow === 'CI');

t('a run still in progress is left out', m.runs.completed, 5);
t('billed minutes round up per job, macOS at ×10', m.totals.billed, 21);
t('self-hosted minutes are counted apart', m.totals.self, 4);
t('a re-run counts both attempts', ci.attempts, 5);
t('failure rate is over attempts', Math.round(ci.failureRate * 1000) / 10, 40);
t('first failing job is the earliest red job', JSON.stringify(ci.firstFailing), '{"test":1,"build":1}');
t('per-job minutes', m.jobs.find((j) => j.job === 'test').billed, 3);
t('PRs with CI, matched by number or branch', m.prs.withCi, 3);
t('CI red rate per PR', m.prs.red, 2);
t('a re-run and a new push are each a round trip', m.prs.roundTrips.n, 2);
t('round-trip cost is the minutes spent after the red', m.prs.roundTrips.medianMinutes, 1.5);
t('round-trip wait is red to green', m.prs.roundTrips.medianWait, 1164.5 * 1000);
t('nothing left red', m.prs.roundTrips.unresolved, 0);
t('time to green median', m.prs.timeToGreen.median, 680 * 1000);
t('time to green p90', m.prs.timeToGreen.p90, 1672 * 1000);
t('hosted queue time median', m.queue.hosted.median, 20);
t('self-hosted queue time', m.queue.self.median, 300);
const sep = m.months.find((x) => x.month === '2026-09');
t('merged PRs by month', `${sep.merged} ${m.months.find((x) => x.month === '2026-10').merged}`, '2 1');
t('minutes per merged PR', sep.perMerged, 12.5);

// A PR whose last push stays red is unresolved.
const red = measure({ runs: [runs[1]], jobs: new Map([[2, jobs.get(2)]]), prs, since: '2026-07-20', until: '2026-10-17' });
t('a PR still red has an unresolved trip', red.prs.roundTrips.unresolved, 1);
t('and no time to green', red.prs.timeToGreen.n, 0);

// A push cancelled by a newer one is not green: the round trip runs on to the push that passes.
const T3 = '2026-09-20T10:00:00Z';
const cancelled = [
  run({ id: 20, head_sha: 'x', head_branch: 'feat/four', pull_requests: [{ number: 4 }], conclusion: 'failure', created_at: T3, updated_at: iso(T3, 60) }),
  run({ id: 21, head_sha: 'y', head_branch: 'feat/four', pull_requests: [{ number: 4 }], conclusion: 'cancelled', created_at: iso(T3, 600), updated_at: iso(T3, 630) }),
  run({ id: 22, head_sha: 'z', head_branch: 'feat/four', pull_requests: [{ number: 4 }], conclusion: 'success', created_at: iso(T3, 900), updated_at: iso(T3, 1000) }),
];
const cm = measure({ runs: cancelled, prs: [{ number: 4, created_at: T3, head: { ref: 'feat/four' } }], since: '2026-07-20', until: '2026-10-17',
  jobs: new Map([
    [20, [job(T3, { name: 'test', conclusion: 'failure', start: 0, end: 60 })]],
    [21, [job(T3, { name: 'test', conclusion: 'cancelled', created: 600, start: 600, end: 630 })]],
    [22, [job(T3, { name: 'test', conclusion: 'success', created: 900, start: 900, end: 1000 })]],
  ]) });
t('a cancelled push does not end a round trip', cm.prs.roundTrips.medianWait, 940 * 1000);
t('nor count as time to green', cm.prs.timeToGreen.median, 1000 * 1000);

// ---- red as GitHub shows it: a continue-on-error job, and a check today's ruleset does not require
const T4 = '2026-09-25T10:00:00Z';
const pr5 = [{ number: 5, created_at: T4, head: { ref: 'feat/five' } }];
const coe = (o) => run({ head_sha: 'p', head_branch: 'feat/five', pull_requests: [{ number: 5 }], created_at: T4, updated_at: iso(T4, 300), ...o });
// The e2e job is continue-on-error: it fails, and GitHub concludes the run success.
const om = measure({ runs: [coe({ id: 30, conclusion: 'success' })], prs: pr5, since: '2026-07-20', until: '2026-10-17',
  jobs: new Map([[30, [job(T4, { name: 'test', conclusion: 'success', start: 0, end: 120 }), job(T4, { name: 'e2e', conclusion: 'failure', start: 0, end: 300 })]]]) });
t('a run whose only failed job is continue-on-error counts green', `${om.totals.failed} ${om.prs.red} ${om.prs.roundTrips.n} ${om.prs.roundTrips.unresolved}`, '0 0 0 0');
t('and its PR has a time to green', om.prs.timeToGreen.median, 300 * 1000);
t('and it names no first failing job', JSON.stringify(om.workflows[0].firstFailing), '{}');
// A re-run's earlier attempt keeps no conclusion of its own: a failure in the continue-on-error job
// alone does not make it red, while a failure in another job does.
const rerun = (attempt1) => measure({ runs: [coe({ id: 31, conclusion: 'success', run_attempt: 2 })], prs: pr5, since: '2026-07-20', until: '2026-10-17',
  jobs: new Map([[31, [...attempt1, job(T4, { name: 'test', run_attempt: 2, conclusion: 'success', created: 200, start: 200, end: 260 }),
    job(T4, { name: 'e2e', run_attempt: 2, conclusion: 'failure', created: 200, start: 200, end: 300 })]]]) });
const quiet = rerun([job(T4, { name: 'test', conclusion: 'success', start: 0, end: 60 }), job(T4, { name: 'e2e', conclusion: 'failure', start: 0, end: 100 })]);
t('an earlier attempt failing only a continue-on-error job is green', `${quiet.totals.failed} ${quiet.prs.red} ${quiet.prs.timeToGreen.median}`, `0 0 ${100 * 1000}`);
const loud = rerun([job(T4, { name: 'test', conclusion: 'failure', start: 0, end: 60 }), job(T4, { name: 'e2e', conclusion: 'failure', start: 0, end: 100 })]);
t('an earlier attempt failing a blocking job is red', `${loud.totals.failed} ${loud.prs.red} ${loud.prs.roundTrips.n}`, '1 1 1');
t('and its first failing job is the blocking one', JSON.stringify(loud.workflows[0].firstFailing), '{"test":1}');
// Red follows what GitHub shows: a run on a PR that failed in a job today's ruleset does not require
// (desk-skills run 38913682072, before the tests aggregate existed) is red, and so is a failed push.
const lintFails = measure({ runs: [coe({ id: 32, conclusion: 'failure' })], prs: pr5, required: ['test'], since: '2026-07-20', until: '2026-10-17',
  jobs: new Map([[32, ['test', 'lint'].map((n) => job(T4, { name: n, conclusion: n === 'lint' ? 'failure' : 'success', start: 0, end: 60 }))]]) });
t('a failed job that is not a required check today still makes a PR run red', `${lintFails.totals.failed} ${lintFails.prs.red} ${JSON.stringify(lintFails.workflows[0].firstFailing)}`, '1 1 {"lint":1}');
const push = measure({ runs: [run({ id: 33, name: 'Deploy', event: 'push', head_sha: 'q', head_branch: 'main', conclusion: 'failure', created_at: T4, updated_at: iso(T4, 60) })],
  prs: pr5, since: '2026-07-20', until: '2026-10-17', jobs: new Map([[33, [job(T4, { name: 'ship', conclusion: 'failure', start: 0, end: 60 })]]]) });
t('a failed run that tests no PR is red by its conclusion', `${push.workflows[0].failed} ${JSON.stringify(push.workflows[0].firstFailing)}`, '1 {"ship":1}');
// An earlier attempt failing a job no ruleset requires is red too.
const early = rerun([job(T4, { name: 'lint', conclusion: 'failure', start: 0, end: 60 }), job(T4, { name: 'e2e', conclusion: 'failure', start: 0, end: 100 })]);
t('an earlier attempt failing any job that is not continue-on-error is red', `${early.totals.failed} ${JSON.stringify(early.workflows[0].firstFailing)}`, '1 {"lint":1}');
// A continue-on-error job that failed first is not named as the first failing job.
const coeFirst = measure({ runs: [coe({ id: 34, conclusion: 'success' }), coe({ id: 35, head_sha: 'p2', conclusion: 'failure', created_at: iso(T4, 600), updated_at: iso(T4, 900) })],
  prs: pr5, since: '2026-07-20', until: '2026-10-17', jobs: new Map([
    [34, [job(T4, { name: 'test', conclusion: 'success', start: 0, end: 60 }), job(T4, { name: 'e2e', conclusion: 'failure', start: 0, end: 90 })]],
    [35, [job(T4, { name: 'e2e', conclusion: 'failure', created: 600, start: 600, end: 650 }), job(T4, { name: 'test', conclusion: 'failure', created: 600, start: 600, end: 900 })]]]) });
t('the first failing job leaves out a continue-on-error job', JSON.stringify(coeFirst.workflows[0].firstFailing), '{"test":1}');

// ---- a job past GitHub's 6 h limit
const T5 = '2026-09-28T10:00:00Z';
const stuck = measure({ runs: [run({ id: 40, name: 'Deploy Storybook', event: 'push', head_sha: 'u', head_branch: 'main', conclusion: 'cancelled', created_at: T5, updated_at: iso(T5, 248280) }),
  run({ id: 41, name: 'Soak', event: 'schedule', head_sha: 'v', head_branch: 'main', conclusion: 'success', created_at: T5, updated_at: iso(T5, 30000) })],
prs: [], since: '2026-07-20', until: '2026-10-17', jobs: new Map([
  [40, [job(T5, { name: 'deploy', conclusion: 'cancelled', start: 0, end: 248280 })]],
  [41, [job(T5, { name: 'soak', conclusion: 'success', start: 0, end: 30000, labels: ['self-hosted', 'arm64'], runner_group_name: 'Default' })]]]) });
t('a hosted job over 6 h counts as 360 min', stuck.totals.billed, 360);
t('a self-hosted job over 6 h is not capped', stuck.totals.self, 500);
t('the capped job is listed', JSON.stringify(stuck.capped.map((x) => [x.workflow, x.job, x.run, x.reported, x.counted])), '[["Deploy Storybook","deploy",40,4138,360]]');
const cappedReport = report(stuck, { repo: 'o/r', calls: 1, allowance: 1, budget: 1, reserve: 1, rate: { remaining: 1, limit: 1 }, notes: [] }, 'now');
t('the report lists it under Capped jobs', /## Capped jobs[\s\S]*\| Deploy Storybook \| deploy \| 40 \| 1 \| 4,138 \| 360 \|/.test(cappedReport), true);
t('a macOS job over 6 h is capped before the multiplier', jobMinutes(job(T5, { name: 'm', start: 0, end: 30000, labels: ['macos-14'] })), 360);

// ---- months: each month's minutes come from that month's own runs
// One workflow over three months whose runs take 10, 2 and 6 minutes. A sample of one run per
// workflow would put every month's minutes in the month of the run it read.
const months3 = [['2026-07-25', 10], ['2026-08-15', 2], ['2026-09-20', 6]].flatMap(([d, mins], mi) => Array.from({ length: 10 }, (_, i) => {
  const at = iso(`${d}T00:00:00Z`, i * 3600);
  return { r: run({ id: 200 + mi * 10 + i, name: 'Build', event: 'push', head_sha: `m${mi}${i}`, head_branch: 'main', conclusion: 'success', created_at: at, updated_at: iso(at, mins * 60) }),
    j: [job(at, { name: 'b', conclusion: 'success', start: 0, end: mins * 60 })] };
}));
const allRuns = months3.map((x) => x.r);
const fullJobs = new Map(months3.map((x) => [x.r.id, x.j]));
const sample3 = pickSample(allRuns, 6);
t('a sample reads runs in every month', [...new Set(sample3.map((r) => r.created_at.slice(0, 7)))].join(','), '2026-07,2026-08,2026-09');
const full = measure({ runs: allRuns, jobs: fullJobs, prs: [], since: '2026-07-20', until: '2026-10-17' });
const sampled3 = measure({ runs: allRuns, jobs: new Map(sample3.map((r) => [r.id, fullJobs.get(r.id)])), prs: [], since: '2026-07-20', until: '2026-10-17' });
t('each sampled month matches a full recount', JSON.stringify(sampled3.months.map((x) => [x.month, Math.round(x.billed)])), JSON.stringify(full.months.map((x) => [x.month, x.billed])));
t('and the full recount is per month', JSON.stringify(full.months.map((x) => x.billed)), '[100,20,60]');
// Only one run read in all: the months with no run read carry no minutes rather than borrowing another month's.
const one = measure({ runs: allRuns, jobs: new Map([[200, fullJobs.get(200)]]), prs: [], since: '2026-07-20', until: '2026-10-17' });
t('a month with no run read is unmeasured, not borrowed', `${JSON.stringify(one.months.map((x) => [x.month, x.billed]))} ${one.runs.unmeasured}`, '[["2026-07",100]] 20');

// ---- sampling: red and re-run runs are read first, the rest scale back up
const nightly = Array.from({ length: 11 }, (_, i) => run({ id: 100 + i, name: 'Nightly', event: 'schedule', head_sha: `n${i}`, head_branch: 'main',
  conclusion: i === 7 ? 'failure' : 'success', created_at: iso(T0, i * 86400), updated_at: iso(T0, i * 86400 + 61) }));
const picked = pickSample(nightly, 3);
t('a sample of 3 keeps the red run', picked.some((r) => r.id === 107), true);
t('a sample is the size asked for', picked.length, 3);
const nightlyJobs = new Map(picked.map((r) => [r.id, [job(r.created_at, { name: 'n', conclusion: r.conclusion, start: 0, end: 61 })]]));
const sm = measure({ runs: nightly, jobs: nightlyJobs, prs: [], since: '2026-07-20', until: '2026-10-17' });
t('sampled minutes are scaled per stratum', Math.round(sm.totals.billed), 22);
t('the report marks sampled figures', /sampled: jobs read for 3 of 11/.test(report(sm, { repo: 'o/r', calls: 1, allowance: 1, budget: 1, reserve: 1, rate: { remaining: 1, limit: 1 }, notes: [] }, 'now')), true);

// ---- the call budget, against a stubbed API
const SINCE = '2026-07-20';
const UNTIL = '2026-10-17';
function stub({ remaining, limit = 5000, count = 50, spend = 0, cap = Infinity, redId = 0, jobPages = 1 }) {
  const all = Array.from({ length: count }, (_, i) => run({ id: i + 1, head_sha: `s${i}`, head_branch: 'b', conclusion: i + 1 === redId ? 'failure' : 'success',
    created_at: iso(`${SINCE}T12:00:00Z`, Math.floor((i * 89 * 86400) / count)), updated_at: iso(`${SINCE}T12:00:00Z`, 60) }));
  const s = { calls: 0, maxDays: 0, all };
  s.api = (path) => {
    if (path === 'rate_limit') return { resources: { core: { limit, remaining: remaining - spend * s.calls, reset: 0 } } };
    s.calls++;
    let mm = /actions\/runs\?created=([\d-]+)\.\.([\d-]+)&per_page=100&page=(\d+)/.exec(path);
    if (mm) {
      const [, from, to, page] = mm;
      const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
      const inRange = all.filter((r) => r.created_at.slice(0, 10) >= from && r.created_at.slice(0, 10) <= to);
      s.maxDays = Math.max(s.maxDays, days);
      return { total_count: days > cap ? 1500 : inRange.length, workflow_runs: inRange.slice((page - 1) * 100, page * 100) };
    }
    if (/\/pulls\?/.test(path)) return [];
    mm = /actions\/runs\/(\d+)\/jobs\?filter=all&per_page=100&page=(\d+)/.exec(path);
    if (mm) {
      const one = job(all[mm[1] - 1].created_at, { name: 't', conclusion: 'success', start: 0, end: 30 });
      if (jobPages === 1) return { total_count: 1, jobs: [one] };
      return { total_count: 150, jobs: Array.from({ length: Number(mm[2]) === 1 ? 100 : 50 }, () => one) };
    }
    throw new Error(`unexpected path ${path}`);
  };
  return s;
}

let low = stub({ remaining: 150 });
let threw = '';
try { collect({ repo: 'o/r', since: SINCE, until: UNTIL, api: low.api }); } catch (e) { threw = e.message; }
t('a rate limit under the reserve stops before any call', `${/too low/.test(threw)} ${low.calls}`, 'true 0');

let s = stub({ remaining: 5000 });
let c = collect({ repo: 'o/r', since: SINCE, until: UNTIL, budget: 20, api: s.api });
t('calls stay within the budget', c.calls <= 20 && s.calls === c.calls, true);
t('what the lists leave reads jobs, as a sample', `${c.jobs.size} of ${c.runs.length}`, '16 of 50');
t('all runs are listed', c.coveredSince, SINCE);

s = stub({ remaining: 700, count: 300 });
c = collect({ repo: 'o/r', since: SINCE, until: UNTIL, budget: 1000, api: s.api });
t('the reserve caps the allowance below the budget', `${c.allowance} ${c.calls <= 200}`, '200 true');

s = stub({ remaining: 1200, count: 600, spend: 10 });
c = collect({ repo: 'o/r', since: SINCE, until: UNTIL, budget: 1000, api: s.api });
t('a rate limit others are spending is re-read and stops at the reserve', `${c.calls} ${c.notes.some((n) => /rate limit fell/.test(n))}`, '100 true');

s = stub({ remaining: 5000, count: 2000 });
c = collect({ repo: 'o/r', since: SINCE, until: UNTIL, budget: 10, api: s.api });
t('a run list the budget cannot cover narrows the window and says so', `${c.coveredSince > SINCE} ${c.notes.some((n) => /window covers/.test(n))}`, 'true true');
t('and keeps no run older than the window it reports', c.runs.every((r) => r.created_at.slice(0, 10) >= c.coveredSince), true);

s = stub({ remaining: 5000, count: 120, cap: 10 });
c = collect({ repo: 'o/r', since: SINCE, until: UNTIL, budget: 1000, api: s.api });
t('a range over the 1000-run listing cap is split', `${c.runs.length} ${c.coveredSince}`, `120 ${SINCE}`);

s = stub({ remaining: 5000, count: 20, redId: 20, jobPages: 2 });
c = collect({ repo: 'o/r', since: SINCE, until: UNTIL, budget: 14, api: s.api });
t('a red run last in the list is still read when job pages run the budget out', `${c.jobs.has(20)} ${c.jobs.size < 10}`, 'true true');


console.log(fails ? `${fails} FAILED` : 'all measure checks passed');
process.exit(fails ? 1 : 0);
