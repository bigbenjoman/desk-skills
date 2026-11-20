// suite: ci main red (the red-main alarm's lane decisions and the macOS nightly gate)
// The decisions as pure functions, then `alarm` and `nightly-due` end to end against a fake gh.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testsLane, macosLane, withTrigger, ranSuite, decide, nightlyDue, PLAN_JOB } from './ci_main_red.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();
let id = 100;
const run = (conclusion, h, more = {}) => ({ databaseId: id++, conclusion, event: 'push', url: `https://x/runs/${id}`, headSha: 'abcdef0123', createdAt: ago(h), ...more });
const mac = (...runs) => macosLane(runs, NOW);

// The macOS lane.
t('green and fresh', mac(run('success', 2)).red, false);
t('failed', mac(run('failure', 2)).red, true);
const cancelled = mac(run('cancelled', 9, { event: 'schedule' }), run('success', 20));
t('a cancelled scheduled run is red', cancelled.red, true);
t('and says so', /latest schedule run cancelled at abcdef0/.test(cancelled.line), true);
t('a timed-out scheduled run is red', mac(run('timed_out', 9, { event: 'schedule' }), run('success', 20)).red, true);
t('a cancelled push run is red', mac(run('cancelled', 1), run('success', 3)).red, true);
t('a later green push supersedes a cancelled scheduled run', mac(run('success', 1), run('cancelled', 9, { event: 'schedule' })).red, false);
const stale = mac(run('success', 40));
t('a run over 36 h old is red', stale.red, true);
t('and says it is stale, with the age', /stale: the latest run that finished started 40 h ago/.test(stale.line), true);
t('35 h is still fresh', mac(run('success', 35)).red, false);
t('the age is the latest not-cancelled run, past a cancelled one', /started 50 h ago/.test(mac(run('cancelled', 2), run('success', 50)).line), true);
t('only cancelled runs: red and stale', /stale: no run on main finished without being cancelled/.test(mac(run('cancelled', 2), run('cancelled', 26)).line), true);
t('no run at all is red', mac().red, true);
// The gate skips a schedule after a lane run under 24 h old, so up to about 48 h can pass between suite
// runs; a push in that gap finishes its tests run before its macOS run, which is then running.
t('over 36 h old with a run on main in progress: not stale', macosLane([run('success', 40)], NOW, true).red, false);
t('a run in progress does not hide a failure', macosLane([run('failure', 40)], NOW, true).red, true);
// A scheduled run that skipped the suite counts as neither a result nor freshness.
t('a skipped schedule run does not freshen a stale lane', mac(run('success', 1, { event: 'schedule', skipped: true }), run('success', 40)).red, true);
t('nor hide a red one', mac(run('success', 1, { event: 'schedule', skipped: true }), run('failure', 20)).red, true);
t('a skipped schedule run over a green lane is green', mac(run('success', 1, { event: 'schedule', skipped: true }), run('success', 20)).red, false);

// Which runs skipped the suite.
t('only the plan job ran: skipped', ranSuite([{ name: PLAN_JOB, conclusion: 'success' }, { name: 'macOS shard ${{ matrix.shard }}/${{ matrix.of }}', conclusion: 'skipped' }]), false);
t('a shard ran: not skipped', ranSuite([{ name: PLAN_JOB, conclusion: 'success' }, { name: 'macOS shard 1/4', conclusion: 'success' }]), true);
t('the one-job nightly before the lane ran the suite', ranSuite([{ name: 'nightly macOS full suite', conclusion: 'success' }]), true);

// The tests lane: a cancelled run says nothing.
t('tests: latest failed is red', testsLane([run('failure', 1), run('success', 2)]).red, true);
t('tests: a cancelled run is passed over', testsLane([run('cancelled', 1), run('success', 2)]).red, false);
t('tests: timed out is red', testsLane([run('timed_out', 1)]).red, true);
t('tests: no run is not red', testsLane([]).red, false);

// The triggering run takes its own place, with its own conclusion, whether or not the listing has it.
const listed = [run('success', 1), run('success', 3)];
t('the trigger replaces its listed copy', withTrigger(listed, { ...listed[0], conclusion: 'failure' }).map((r) => r.conclusion).join(), 'failure,success');
t('an unlisted newer trigger goes first', withTrigger(listed, run('failure', 0)).map((r) => r.conclusion).join(), 'failure,success,success');
t('no trigger leaves the list', withTrigger(listed, null), listed);

// What happens to the issue.
const red = [{ red: true, line: 'macOS: stale' }, { red: false, line: 'tests: ok' }];
const green = [{ red: false, line: 'macOS: ok' }, { red: false, line: 'tests: ok' }];
const trig = (conclusion) => ({ name: 'macOS', conclusion, headSha: 'abcdef0123', url: 'u' });
t('red, no issue: create', decide({ lanes: red, issue: null, trigger: trig('cancelled') }).action, 'create');
t('the body lists the red lane', /Red now:\n- macOS: stale/.test(decide({ lanes: red, issue: null, trigger: null }).body), true);
t('red, an issue, a red trigger: comment', decide({ lanes: red, issue: 7, trigger: trig('cancelled') }).action, 'comment');
t('red, an issue, a green trigger: assign only', decide({ lanes: red, issue: 7, trigger: trig('success') }).action, 'assign');
t('red, an issue, the daily check: assign only', decide({ lanes: red, issue: 7, trigger: null }).action, 'assign');
t('green, an issue: close', decide({ lanes: green, issue: 7, trigger: trig('success') }).action, 'close');
t('green, no issue: nothing', decide({ lanes: green, issue: null, trigger: null }).action, 'none');

// The nightly gate.
t('a push run passed 10 h ago: not due', nightlyDue([run('success', 10)], NOW), false);
t('a dispatch run passed 10 h ago: not due', nightlyDue([run('success', 10, { event: 'workflow_dispatch' })], NOW), false);
t('the last green push was 25 h ago: due', nightlyDue([run('success', 25)], NOW), true);
t('a failed push run: due', nightlyDue([run('failure', 2)], NOW), true);
t('a passed schedule run (perhaps a skip) does not count: due', nightlyDue([run('success', 2, { event: 'schedule' })], NOW), true);

// End to end with a fake gh: `run list`/`run view`/`issue list` answer from files, everything is logged.
const T = scratch('desk-ci-red-');
try {
  const BIN = join(T, 'bin');
  mkdirSync(BIN);
  const LOG = join(T, 'gh.log');
  writeFileSync(join(BIN, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${LOG}"
case "$1 $2" in
  "run list") w=$4; case "$*" in
    *"--status completed"*) cat "${T}/runs-$w.json" ;;
    *) if [ -f "${T}/live-$w.json" ]; then cat "${T}/live-$w.json"; else echo '[]'; fi ;;
  esac ;;
  "run view") cat "${T}/jobs-$3.json" ;;
  "issue list") cat "${T}/issues.json" ;;
  "issue create") echo "https://github.com/acme/x/issues/42" ;;
esac
exit 0
`, { mode: 0o755 });
  const live = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const put = (f, v) => writeFileSync(join(T, f), JSON.stringify(v));
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ci_main_red.mjs');
  const cli = (args, env = {}) => {
    writeFileSync(LOG, '');
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: `${BIN}:${process.env.PATH}`, GH_REPO: 'acme/x', OWNER: 'owner1', GITHUB_OUTPUT: join(T, 'out'), ...env } });
    return { out, gh: readFileSync(LOG, 'utf8').trim().split('\n') };
  };
  put('runs-tests.yml.json', [{ databaseId: 1, conclusion: 'success', event: 'push', url: 'u1', headSha: 'aaaaaaa', createdAt: live(1) }]);
  // The latest macOS run is a scheduled skip; the one before it was cancelled at its timeout.
  put('runs-nightly-macos.yml.json', [
    { databaseId: 5, conclusion: 'success', event: 'schedule', url: 'u5', headSha: 'bbbbbbb', createdAt: live(1) },
    { databaseId: 4, conclusion: 'cancelled', event: 'schedule', url: 'u4', headSha: 'ccccccc', createdAt: live(25) },
    { databaseId: 3, conclusion: 'success', event: 'push', url: 'u3', headSha: 'ddddddd', createdAt: live(49) },
  ]);
  put('jobs-5.json', { jobs: [{ name: PLAN_JOB, conclusion: 'success' }, { name: 'macOS shard', conclusion: 'skipped' }] });
  put('jobs-3.json', { jobs: [{ name: PLAN_JOB, conclusion: 'success' }, { name: 'macOS shard 1/4', conclusion: 'success' }] });
  put('issues.json', []);
  const a = cli(['alarm']);
  t('alarm: reads jobs only of passed runs, newest first, until one ran the suite', a.gh.filter((l) => l.startsWith('run view')).join(' | '), 'run view 5 --json jobs | run view 3 --json jobs');
  t('alarm: a cancelled latest run opens the issue', a.gh.some((l) => l.startsWith('issue create --label ci-main-red')), true);
  t('alarm: and assigns it to the owner', a.gh.includes('issue edit 42 --add-assignee owner1'), true);
  t('alarm: and says what it did', /^macOS: latest schedule run cancelled at ccccccc u4; stale: the latest run that finished started 49 h ago/m.test(a.out), true);

  // The triggering push run, not listed yet, ran the suite and passed.
  put('issues.json', [{ number: 9 }]);
  put('jobs-6.json', { jobs: [{ name: PLAN_JOB, conclusion: 'success' }, { name: 'macOS shard 1/4', conclusion: 'success' }] });
  const c = cli(['alarm'], { RUN_ID: '6', RUN_NAME: 'macOS', RUN_EVENT: 'push', RUN_URL: 'u6', RUN_SHA: 'eeeeeee', RUN_CONCLUSION: 'success', RUN_CREATED: live(0) });
  t('alarm: the unlisted trigger is read first, and settles it', c.gh.filter((l) => l.startsWith('run view')).join(' | '), 'run view 6 --json jobs');
  t('alarm: every lane green and fresh closes the issue', c.gh.filter((l) => /^issue (comment|close) 9/.test(l)).length, 2);

  // A tests push run finishes while that push's macOS run, after a 40 h gap, is still running.
  put('issues.json', []);
  put('runs-nightly-macos.yml.json', [{ databaseId: 3, conclusion: 'success', event: 'push', url: 'u3', headSha: 'ddddddd', createdAt: live(40) }]);
  put('live-nightly-macos.yml.json', [{ databaseId: 7, status: 'in_progress' }, { databaseId: 3, status: 'completed' }]);
  const g = cli(['alarm'], { RUN_ID: '8', RUN_NAME: 'tests', RUN_EVENT: 'push', RUN_URL: 'u8', RUN_SHA: 'fffffff', RUN_CONCLUSION: 'success', RUN_CREATED: live(0) });
  t('alarm: a macOS run in progress keeps an old lane from reading stale', `${g.gh.some((l) => l.startsWith('issue create'))} ${g.out.trim().split('\n').pop()}`, 'false main is green and no issue is open');
  put('live-nightly-macos.yml.json', []);
  t('alarm: with none running, the same lane is stale', cli(['alarm']).gh.some((l) => l.startsWith('issue create')), true);

  put('runs-nightly-macos.yml.json', [{ databaseId: 3, conclusion: 'success', event: 'push', url: 'u3', headSha: 'ddddddd', createdAt: live(3) }]);
  t('nightly-due: a green push 3 h ago skips the suite', cli(['nightly-due', '--github-output']).out.trim(), 'due=false');
  t('nightly-due: writes the output', readFileSync(join(T, 'out'), 'utf8'), 'due=false\n');
  put('runs-nightly-macos.yml.json', [{ databaseId: 3, conclusion: 'success', event: 'push', url: 'u3', headSha: 'ddddddd', createdAt: live(30) }]);
  t('nightly-due: none in 24 h runs it', cli(['nightly-due']).out.trim(), 'due=true');
} finally { rmSync(T, { recursive: true, force: true }); }

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
