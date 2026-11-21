// suite: aws fallback (the watchdog that turns a repo's AWS fallback on, and desk-ci's off and status)
// covers: desk/bin/aws-fallback.mjs .github/workflows/aws-fallback-watch.yml
// The watchdog, off and status in-process against fixtures of the contents, variables, runs and jobs
// API, then `desk-ci.mjs aws-fallback` end to end against a fake gh.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watch, off, status, watchedRepos, queuedAws, onAws, fallbackIssue, FALLBACK_VAR, WATCHED_VAR, STUCK_MS } from '../desk/bin/aws-fallback.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const NOW = Date.parse('2026-11-21T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60e3).toISOString();
const b64 = (s) => Buffer.from(s).toString('base64');
const LABELS = 'aws-runner-labels: [acme-linux-arm64]\n';
const job = (id, run, min, more = {}) => ({ id, run_id: run, name: `job ${id}`, status: 'queued', labels: ['acme-linux-arm64'], created_at: ago(min), html_url: `https://x/job/${id}`, ...more });

// A fake `gh api`: GET answers from `routes` by path (a function throws), writes are recorded and
// answered from `writes` by "<METHOD> <path>". A missing GET is a 404.
function fakeApi(routes, writes = {}) {
  const calls = [];
  const api = (path, { method = 'GET', body } = {}) => {
    calls.push(body === undefined ? `${method} ${path}` : `${method} ${path} ${JSON.stringify(body)}`);
    const key = method === 'GET' ? path : `${method} ${path}`;
    const r = method === 'GET' ? routes[key] : writes[key];
    if (typeof r === 'function') return r();
    if (r === undefined && method === 'GET') { const e = new Error(`gh api -X GET ${path}: Not Found (HTTP 404)`); e.status = 404; throw e; }
    return r ?? null;
  };
  return { api, calls, writes: () => calls.filter((c) => !c.startsWith('GET ')) };
}
const repoRoutes = (repo, { config = LABELS, variable = null, queued = [], inProgress = [], jobs = {}, runStatus = 'completed' } = {}) => ({
  ...(config == null ? {} : { [`repos/${repo}/contents/.github/desk-ci.yml`]: { content: b64(config) } }),
  ...(variable == null ? {} : { [`repos/${repo}/actions/variables/${FALLBACK_VAR}`]: variable }),
  [`repos/${repo}/actions/runs?status=queued&per_page=100`]: { workflow_runs: queued.map((id) => ({ id })) },
  [`repos/${repo}/actions/runs?status=in_progress&per_page=100`]: { workflow_runs: inProgress.map((id) => ({ id })) },
  ...Object.fromEntries(Object.entries(jobs).map(([id, js]) => [`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`, { jobs: js }])),
  ...Object.fromEntries([...queued, ...inProgress].map((id) => [`repos/${repo}/actions/runs/${id}`, { id, status: runStatus }])),
});
const ENV = { [WATCHED_VAR]: 'acme/app', FALLBACK_TOKEN: 'tok', GITHUB_REPOSITORY: 'acme/desk-skills' };
const ISSUE_WRITES = { 'POST repos/acme/desk-skills/issues': { number: 7 } };
// The desk-skills issues opened since a fallback variable's updated_at.
const issuesSince = (at, issues, page = 1) => ({ [`repos/acme/desk-skills/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}&since=${encodeURIComponent(at)}`]: issues });
const runWatch = (routes, env = ENV, writes = ISSUE_WRITES, issueRoutes = {}) => {
  const f = fakeApi(routes, writes);
  const issues = fakeApi(issueRoutes, writes);
  const log = [];
  const code = watch({ env, api: f.api, issueApi: issues.api, now: NOW, sleep: () => {}, log: (l) => log.push(l) });
  return { code, log, writes: f.writes(), issues: issues.writes() };
};

// ---- the pure parts ----------------------------------------------------------------------------
t('the watched list: owner/name each once, the rest named', watchedRepos(' acme/app, acme/app,acme/api  nope '), { repos: ['acme/app', 'acme/api'], bad: ['nope'] });
t('an empty watched list', watchedRepos(undefined), { repos: [], bad: [] });
t('a declared label, and its -on-demand twin, are on AWS', [onAws(['self-hosted', 'acme-linux-arm64'], ['acme-linux-arm64']), onAws(['acme-linux-arm64-on-demand'], ['acme-linux-arm64']), onAws(['ubuntu-latest'], ['acme-linux-arm64'])], [true, true, false]);
t('labels match as ci-lint matches them: any case, spaces trimmed', [onAws([' ACME-Linux-ARM64 '], ['acme-linux-arm64']), onAws(['acme-linux-arm64'], ['Acme-Linux-Arm64'])], [true, true]);
const q = queuedAws([job(1, 10, 5), job(2, 11, 20), job(3, 12, 30), job(4, 13, 40, { labels: ['ubuntu-latest'] }), job(5, 14, 50, { status: 'in_progress' })], ['acme-linux-arm64'], NOW);
t('the oldest job queued on AWS over 15 minutes, and every run with a job queued on AWS', [q.oldest.id, q.runs], [3, [10, 11, 12]]);
t('15 minutes exactly is not over', queuedAws([job(1, 10, STUCK_MS / 60e3)], ['acme-linux-arm64'], NOW).oldest, null);

// ---- AC1: a job queued on an AWS label for over 15 minutes -------------------------------------
const stuckRoutes = repoRoutes('acme/app', { queued: [20], inProgress: [21], jobs: { 20: [job(1, 20, 25)], 21: [job(2, 21, 3), job(3, 21, 3, { status: 'completed', labels: ['ubuntu-latest'] })] } });
const a1 = runWatch(stuckRoutes);
t('AC1 the fallback is turned on, then each run with a queued AWS job is cancelled and only its cancelled jobs re-run', a1.writes, [
  `POST repos/acme/app/actions/variables {"name":"${FALLBACK_VAR}","value":"on"}`,
  'POST repos/acme/app/actions/runs/20/cancel', 'POST repos/acme/app/actions/runs/20/rerun-failed-jobs',
  'POST repos/acme/app/actions/runs/21/cancel', 'POST repos/acme/app/actions/runs/21/rerun-failed-jobs',
]);
const issue = a1.issues.length === 1 ? JSON.parse(a1.issues[0].replace(/^POST \S+ /, '')) : {};
t('AC1 one issue in desk-skills', [a1.issues.length, a1.issues[0]?.split(' ')[1]], [1, 'repos/acme/desk-skills/issues']);
t('AC1 the issue names the repo, the time and the oldest queued job', [issue.title, issue.body?.includes(`turned its AWS fallback on at ${new Date(NOW).toISOString()}`), issue.body?.includes(`**job 1** on acme-linux-arm64, queued since ${ago(25)}: https://x/job/1`)], ['AWS fallback on for acme/app', true, true]);
t('AC1 the issue opens before any run is restarted, and the run passes', [a1.code, a1.log.indexOf('acme/app: opened issue #7') < a1.log.findIndex((l) => /run 20 cancelled/.test(l))], [0, true]);
const noIssue = runWatch(stuckRoutes, ENV, { 'POST repos/acme/desk-skills/issues': () => { throw new Error('Validation Failed (HTTP 422)'); } });
t('AC1 an issue that cannot open: the runs are still restarted, and the run fails', [noIssue.writes.includes('POST repos/acme/app/actions/runs/20/rerun-failed-jobs'), noIssue.code, noIssue.log.includes('acme/app: could not open its issue: Validation Failed (HTTP 422)')], [true, 1, true]);
const patched = runWatch({ ...stuckRoutes, [`repos/acme/app/actions/variables/${FALLBACK_VAR}`]: { value: 'off', updated_at: ago(600) } });
t('AC1 a variable set to something else is updated, not created', patched.writes[0], `PATCH repos/acme/app/actions/variables/${FALLBACK_VAR} {"name":"${FALLBACK_VAR}","value":"on"}`);
let polls = 0;
const slow = runWatch({ ...stuckRoutes, 'repos/acme/app/actions/runs/20': () => ({ status: ++polls > 2 ? 'completed' : 'in_progress' }) });
t('AC1 a run is re-run only once its cancel has finished', [polls, slow.writes.includes('POST repos/acme/app/actions/runs/20/rerun-failed-jobs')], [3, true]);
const stuckRun = runWatch({ ...stuckRoutes, 'repos/acme/app/actions/runs/20': { status: 'in_progress' } });
t('AC1 a run that never finishes cancelling is not re-run, the issue names it in a comment, and the run fails', [stuckRun.writes.includes('POST repos/acme/app/actions/runs/20/rerun-failed-jobs'), stuckRun.issues, stuckRun.code], [false, [
  stuckRun.issues[0], 'POST repos/acme/desk-skills/issues/7/comments {"body":"Not re-run (the cancel or the re-run failed, or the cancel had not finished; the watchdog\'s log says which): 20. Cancel and re-run them by hand."}',
], 1]);

// ---- AC2: every AWS job started within 15 minutes ---------------------------------------------
const a2 = runWatch(repoRoutes('acme/app', { queued: [20], jobs: { 20: [job(1, 20, 10), job(2, 20, 40, { status: 'in_progress' })] } }));
t('AC2 nothing is written and no issue opens', [a2.writes, a2.issues, a2.code], [[], [], 0]);
t('AC2 the log says so', a2.log, ['acme/app: unchanged, no job queued on acme-linux-arm64 for over 15 minutes']);

// ---- AC3: the fallback is on already -----------------------------------------------------------
const onRoutes = { ...stuckRoutes, [`repos/acme/app/actions/variables/${FALLBACK_VAR}`]: { value: 'on', updated_at: ago(30) } };
const opened = (min, title = 'AWS fallback on for acme/app') => [{ number: 7, title, created_at: ago(min) }];
const a3 = runWatch(onRoutes, ENV, ISSUE_WRITES, issuesSince(ago(30), opened(29)));
t('AC3 it stays on: nothing written, no second issue', [a3.writes, a3.issues, a3.code], [[], [], 0]);
t('AC3 the log says since when', a3.log, [`acme/app: AWS fallback on since ${ago(30)}, left on`]);
for (const [why, issues] of [['no issue opened since it went on', []], ['only an older issue, or one for another repo', [...opened(40), ...opened(20, 'AWS fallback on for acme/api')]]]) {
  const missing = runWatch(onRoutes, ENV, ISSUE_WRITES, issuesSince(ago(30), issues));
  const body = missing.issues.length === 1 ? JSON.parse(missing.issues[0].replace(/^POST \S+ /, '')) : {};
  t(`AC3 on already, ${why}: still left on, and one issue opens saying since when`, [missing.writes, missing.issues.length, body.title, body.body?.includes(`on since ${ago(30)}`), missing.code], [[], 1, 'AWS fallback on for acme/app', true, 0]);
}
const busy = Array.from({ length: 100 }, (_, i) => ({ number: 100 + i, title: `PR ${i}`, pull_request: {}, created_at: ago(1) }));
const paged = runWatch(onRoutes, ENV, ISSUE_WRITES, { ...issuesSince(ago(30), busy), ...issuesSince(ago(30), opened(29), 2) });
t('AC3 on already, its issue on the second page of a busy repo: no second issue', [paged.issues, paged.code], [[], 0]);
const unread = runWatch(onRoutes);
t('AC3 on already, the issues cannot be read: nothing opened or written, and the run fails', [unread.writes, unread.issues, unread.code], [[], [], 1]);

// ---- AC5: no AWS runner labels declared --------------------------------------------------------
for (const [label, config] of [['no aws-runner-labels key', 'hosted-workflows: [release.yml]\n'], ['only a bare self-hosted label', 'aws-runner-labels: [self-hosted]\n']]) {
  const a5 = runWatch(repoRoutes('acme/app', { config, queued: [20], jobs: { 20: [job(1, 20, 60, { labels: ['self-hosted'] })] } }));
  t(`AC5 ${label}: never changed`, [a5.writes, a5.issues, a5.code, a5.log], [[], [], 0, ['acme/app: unchanged, its .github/desk-ci.yml declares no aws-runner-labels']]);
}

// ---- AC6: the declared labels cannot be read ---------------------------------------------------
const a6 = runWatch({ ...stuckRoutes, ...repoRoutes('acme/api', { config: null, queued: [30], jobs: { 30: [job(9, 30, 60)] } }) }, { ...ENV, [WATCHED_VAR]: 'acme/api,acme/app' });
t('AC6 no file: that repo is unchanged, the next one is still watched', [a6.writes.some((w) => w.includes('acme/api')), a6.writes.some((w) => w.includes('acme/app'))], [false, true]);
t('AC6 the log names the repo and the error, and the run fails', [/^acme\/api: unchanged, cannot read its \.github\/desk-ci\.yml: .*HTTP 404/.test(a6.log[0]), a6.code], [true, 1]);
const apiErr = () => { const e = new Error('gh api -X GET repos/acme/app/contents/.github/desk-ci.yml: Server Error (HTTP 502)'); e.status = 502; throw e; };
const a6b = runWatch({ ...stuckRoutes, 'repos/acme/app/contents/.github/desk-ci.yml': apiErr });
t('AC6 an API error: unchanged, named in the log', [a6b.writes, a6b.issues, a6b.code, /^acme\/app: unchanged, cannot read its .*HTTP 502/.test(a6b.log[0])], [[], [], 1, true]);
const a6c = runWatch({ ...stuckRoutes, 'repos/acme/app/actions/runs?status=queued&per_page=100': apiErr });
t('AC6 an API error reading the runs: unchanged, named in the log', [a6c.writes, a6c.code, /^acme\/app: unchanged, .*HTTP 502/.test(a6c.log[0])], [[], 1, true]);

// ---- the watched list and the token ------------------------------------------------------------
const none = runWatch(stuckRoutes, { ...ENV, [WATCHED_VAR]: '' });
t('no repos watched: nothing read, the run passes', [none.writes, none.code, none.log], [[], 0, [`no repos watched: ${WATCHED_VAR} is empty`]]);
const noTok = runWatch(stuckRoutes, { ...ENV, FALLBACK_TOKEN: '' });
t('no token: nothing changed, the run fails naming the secret', [noTok.writes, noTok.code, /DESK_AWS_FALLBACK_TOKEN/.test(noTok.log[0])], [[], 1, true]);

// ---- AC4: off ---------------------------------------------------------------------------------
let present = true;
const offApi = fakeApi({ [`repos/acme/app/actions/variables/${FALLBACK_VAR}`]: () => { if (present) return { value: 'on', updated_at: ago(30) }; const e = new Error('Not Found (HTTP 404)'); e.status = 404; throw e; } },
  { [`DELETE repos/acme/app/actions/variables/${FALLBACK_VAR}`]: () => { present = false; return null; } });
const offLog = [];
t('AC4 off deletes the variable and reads it back off', [off({ api: offApi.api, repo: 'acme/app', log: (l) => offLog.push(l) }), offApi.writes(), offLog], [0, [`DELETE repos/acme/app/actions/variables/${FALLBACK_VAR}`], ['acme/app: AWS fallback off, read back: its next runs queue for its AWS runners']]);
const offAgain = [];
t('AC4 off when already off writes nothing', [off({ api: offApi.api, repo: 'acme/app', log: (l) => offAgain.push(l) }), offAgain], [0, [`acme/app: AWS fallback already off (no ${FALLBACK_VAR} variable)`]]);

// ---- AC7: status ------------------------------------------------------------------------------
const statusRoutes = {
  [`repos/acme/desk-skills/actions/variables/${WATCHED_VAR}`]: { value: 'acme/app,acme/api' },
  [`repos/acme/app/actions/variables/${FALLBACK_VAR}`]: { value: 'on', updated_at: '2026-11-21T10:00:00Z' },
  'repos/acme/desk-skills/actions/workflows/aws-fallback-watch.yml/runs?per_page=1': { workflow_runs: [{ created_at: '2026-11-21T11:50:00Z', conclusion: 'success', html_url: 'https://x/run/1' }] },
};
const st = [];
t('AC7 status: every watched repo, on since when or off, and the last watchdog run', [status({ api: fakeApi(statusRoutes).api, repos: [], home: 'acme/desk-skills', log: (l) => st.push(l) }), st], [0, [
  'acme/app: AWS fallback on since 2026-11-21T10:00:00Z', 'acme/api: AWS fallback off', 'watchdog last ran 2026-11-21T11:50:00Z (success): https://x/run/1',
]]);
const st2 = [];
status({ api: fakeApi({}).api, repos: ['acme/app'], home: 'acme/desk-skills', log: (l) => st2.push(l) });
t('AC7 status of one repo, before the watchdog has ever run', st2.at(-1), 'cannot read the watchdog\'s runs on acme/desk-skills: gh api -X GET repos/acme/desk-skills/actions/workflows/aws-fallback-watch.yml/runs?per_page=1: Not Found (HTTP 404)');
t('the issue body tells how to turn it off', fallbackIssue({ repo: 'acme/app', at: 'T', job: job(1, 2, 3), runs: [2] }).body.includes('desk-ci.mjs aws-fallback off --repo acme/app'), true);

// ---- desk-ci.mjs aws-fallback, end to end against a fake gh ------------------------------------
const T = scratch('aws-fallback-');
try {
  const BIN = join(T, 'bin');
  mkdirSync(BIN);
  const LOG = join(T, 'gh.log');
  writeFileSync(join(BIN, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${LOG}"
case "$*" in
  *"-X DELETE"*) exit 0 ;;
  *"actions/variables/${FALLBACK_VAR}"*) echo '{"value":"on","updated_at":"2026-11-21T10:00:00Z"}' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const DESK_CI = join(dirname(fileURLToPath(import.meta.url)), '../desk/bin/desk-ci.mjs');
  const cli = (...args) => spawnSync(process.execPath, [DESK_CI, 'aws-fallback', ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` } });
  const s = cli('status', '--repo', 'acme/app');
  t('desk-ci.mjs aws-fallback status prints the repo, and fails on the unreadable watchdog runs', [s.status, s.stdout.split('\n')[0]], [1, 'acme/app: AWS fallback on since 2026-11-21T10:00:00Z']);
  // This gh answers `on` after the delete too, so off must say it is not off.
  const o = cli('off', '--repo', 'acme/app');
  t('desk-ci.mjs aws-fallback off deletes the variable', readFileSync(LOG, 'utf8').includes(`api -H Accept: application/vnd.github+json -X DELETE repos/acme/app/actions/variables/${FALLBACK_VAR}`), true);
  t('and, reading it back still on, says it is not off and fails', [o.status, /not off/.test(o.stdout)], [1, true]);
  t('desk-ci.mjs aws-fallback off wants --repo', cli('off').status, 2);
  t('desk-ci.mjs aws-fallback with no subcommand prints the usage', [cli().status, /aws-fallback off --repo/.test(cli().stderr)], [2, true]);
} finally { rmSync(T, { recursive: true, force: true }); }

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
