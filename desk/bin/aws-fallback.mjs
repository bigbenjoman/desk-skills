#!/usr/bin/env node
// A repo's AWS fallback: the repo variable DESK_AWS_FALLBACK, which every AWS job's runs-on reads, so
// at `on` the repo's CI runs on GitHub-hosted runners. Everything goes through `gh api`.
//   node aws-fallback.mjs watch
// The watchdog (.github/workflows/aws-fallback-watch.yml, every 10 minutes). For each repo in
// DESK_AWS_WATCHED_REPOS (comma-separated owner/name) it reads the AWS runner labels the repo's
// .github/desk-ci.yml declares at its default branch. A repo with a job queued on one of them for over
// 15 minutes gets its fallback turned on, an issue in this repo naming it, the time and the oldest
// queued job, and then every run with a job queued on one cancelled and its cancelled jobs re-run; a
// comment on the issue names any run left cancelled. A repo whose fallback is on already is left as
// it is, and gets an issue only when none was opened since the fallback went on. One that declares no
// labels, or whose file cannot be read, is never changed. FALLBACK_TOKEN reads and writes the watched
// repos; GH_TOKEN opens the issue in GITHUB_REPOSITORY. Exit 1 when a repo could not be read or fully
// handled.
//   node aws-fallback.mjs off --repo owner/name
// Deletes the repo's DESK_AWS_FALLBACK and reads it back, so its next runs queue for its AWS runners.
//   node aws-fallback.mjs status [--repo owner/name]
// Whether each repo's fallback is on and since when (the variable's updated_at), and when the
// watchdog in HOME_REPO last ran. Without --repo, every repo HOME_REPO watches.
// desk-ci.mjs runs off and status as `desk-ci.mjs aws-fallback off|status`.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCiConfig, CI_CONFIG, ghCall, awsSet } from './desk-ci.mjs';

export const FALLBACK_VAR = 'DESK_AWS_FALLBACK';
export const WATCHED_VAR = 'DESK_AWS_WATCHED_REPOS';
const WATCHDOG = 'aws-fallback-watch.yml';
const HOME_REPO = 'bigbenjoman/desk-skills';
export const STUCK_MS = 15 * 60e3;
const CANCEL_POLLS = 20;
const POLL_MS = 3000;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const msg = (e) => String(e?.message ?? e).trim().split('\n')[0];
const ghApi = (token) => (path, opts = {}) => ghCall(path, { ...opts, token });

// DESK_AWS_WATCHED_REPOS's value -> { repos: owner/name each once, bad: entries that are not one }.
export function watchedRepos(value) {
  const items = String(value ?? '').split(/[\s,]+/).filter(Boolean);
  return { repos: [...new Set(items.filter((r) => REPO.test(r)))], bad: items.filter((r) => !REPO.test(r)) };
}

// A job label set runs on the repo's AWS runners when it holds a declared label or its -on-demand
// twin, matched as desk-ci.mjs's ci-lint and classify match them.
export const onAws = (labels, aws) => {
  const set = awsSet(aws);
  return (labels ?? []).some((l) => typeof l === 'string' && set.has(l.trim().toLowerCase()));
};
const queuedAt = (j) => Date.parse(j.created_at ?? j.started_at);

// The jobs of a repo's unfinished runs -> { oldest: the job queued longest on an AWS label, when that
// is over STUCK_MS, else null; runs: the id of every run with a job queued on an AWS label }.
export function queuedAws(jobs, aws, now) {
  const queued = jobs.filter((j) => j.status === 'queued' && onAws(j.labels, aws));
  const stuck = queued.filter((j) => now - queuedAt(j) > STUCK_MS).sort((a, b) => queuedAt(a) - queuedAt(b));
  return { oldest: stuck[0] ?? null, runs: [...new Set(queued.map((j) => j.run_id))] };
}

// The AWS runner labels the repo's desk-ci.yml declares at its default branch. Throws when it cannot be read.
function readLabels(api, repo) {
  const file = api(`repos/${repo}/contents/${CI_CONFIG}`);
  if (typeof file?.content !== 'string') throw new Error(`${CI_CONFIG} is not a file`);
  return parseCiConfig(Buffer.from(file.content, 'base64').toString('utf8')).awsLabels;
}

// -> { on, value, updatedAt }; value null when the repo has no such variable.
function readFallback(api, repo) {
  try {
    const v = api(`repos/${repo}/actions/variables/${FALLBACK_VAR}`);
    return { on: v.value === 'on', value: v.value, updatedAt: v.updated_at ?? null };
  } catch (e) {
    if (e.status === 404) return { on: false, value: null, updatedAt: null };
    throw e;
  }
}

function turnOn(api, repo, cur) {
  const body = { name: FALLBACK_VAR, value: 'on' };
  if (cur.value == null) api(`repos/${repo}/actions/variables`, { method: 'POST', body });
  else api(`repos/${repo}/actions/variables/${FALLBACK_VAR}`, { method: 'PATCH', body });
}

// Cancels a run and, once it has finished, re-runs its cancelled jobs (and only those, so a job that
// already passed does not run twice), so they pick their runners again. -> true when re-run.
function restart(api, repo, id, sleep, log) {
  try {
    try { api(`repos/${repo}/actions/runs/${id}/cancel`, { method: 'POST' }); } catch (e) { if (e.status !== 409) throw e; }
    for (let i = 0; i < CANCEL_POLLS; i++) {
      if (api(`repos/${repo}/actions/runs/${id}`).status === 'completed') {
        api(`repos/${repo}/actions/runs/${id}/rerun-failed-jobs`, { method: 'POST' });
        log(`${repo}: run ${id} cancelled and its cancelled jobs re-run`);
        return true;
      }
      sleep(POLL_MS);
    }
    log(`${repo}: run ${id} cancelled but not finished after ${(CANCEL_POLLS * POLL_MS) / 1000} s, so not re-run`);
  } catch (e) {
    log(`${repo}: run ${id} could not be cancelled and re-run: ${msg(e)}`);
  }
  return false;
}

const issueTitle = (repo) => `AWS fallback on for ${repo}`;
const offHint = (repo) => `Back to AWS once its runners work: \`node ~/.claude/desk/bin/desk-ci.mjs aws-fallback off --repo ${repo}\`. Where it stands: \`node ~/.claude/desk/bin/desk-ci.mjs aws-fallback status\`.\n`;

// The issue for a repo whose fallback the watchdog turned on. -> { title, body }
export function fallbackIssue({ repo, at, job, runs }) {
  const since = job.created_at ?? job.started_at;
  return {
    title: issueTitle(repo),
    body: `${repo}'s AWS runners stopped taking jobs, so the watchdog turned its AWS fallback on at ${at}: its CI runs on GitHub-hosted runners until you turn it off.\n\n`
      + `Oldest queued job: **${job.name}** on ${(job.labels ?? []).join(', ')}, queued since ${since}: ${job.html_url ?? `run ${job.run_id}`}\n\n`
      + `Runs being cancelled and their cancelled jobs re-run: ${runs.join(', ') || 'none'}. A comment here names any left cancelled.\n\n`
      + offHint(repo),
  };
}

// Opens `issue` in `home`. -> its number, or null when it could not be opened (logged).
function openIssue(issueApi, home, repo, issue, log) {
  try {
    const n = issueApi(`repos/${home}/issues`, { method: 'POST', body: issue })?.number ?? null;
    log(`${repo}: opened issue #${n}`);
    return n;
  } catch (e) { log(`${repo}: could not open its issue: ${msg(e)}`); return null; }
}

// A fallback that is on already: opens an issue only when none was opened since it went on (the
// watchdog's own failed to open, or someone turned it on by hand). -> true when nothing is missing.
function ensureIssue(issueApi, home, repo, cur, log) {
  try {
    const since = cur.updatedAt ? `&since=${encodeURIComponent(cur.updatedAt)}` : '';
    const issues = issueApi(`repos/${home}/issues?state=all&per_page=100${since}`) ?? [];
    const opened = issues.some((i) => i.title === issueTitle(repo) && !i.pull_request && (!cur.updatedAt || Date.parse(i.created_at) >= Date.parse(cur.updatedAt)));
    if (opened) return true;
  } catch (e) { log(`${repo}: cannot read ${home}'s issues: ${msg(e)}`); return false; }
  const body = `${repo}'s AWS fallback has been on since ${cur.updatedAt ?? 'an unknown time'}, and no issue said so: its CI runs on GitHub-hosted runners until you turn it off.\n\n${offHint(repo)}`;
  return openIssue(issueApi, home, repo, { title: issueTitle(repo), body }, log) != null;
}

// One watched repo. -> true when it was read and fully handled.
function watchRepo({ api, issueApi, home, repo, now, sleep, log }) {
  let aws;
  try { aws = readLabels(api, repo); } catch (e) {
    log(`${repo}: unchanged, cannot read its ${CI_CONFIG}: ${msg(e)}`);
    return false;
  }
  if (!aws.length) { log(`${repo}: unchanged, its ${CI_CONFIG} declares no aws-runner-labels`); return true; }
  let oldest, runs;
  try {
    const cur = readFallback(api, repo);
    if (cur.on) {
      log(`${repo}: AWS fallback on since ${cur.updatedAt ?? 'an unknown time'}, left on`);
      return ensureIssue(issueApi, home, repo, cur, log);
    }
    const live = ['queued', 'in_progress'].flatMap((s) => api(`repos/${repo}/actions/runs?status=${s}&per_page=100`)?.workflow_runs ?? []);
    const jobs = live.flatMap((r) => (api(`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`)?.jobs ?? []).map((j) => ({ run_id: r.id, ...j })));
    ({ oldest, runs } = queuedAws(jobs, aws, now));
    if (!oldest) { log(`${repo}: unchanged, no job queued on ${aws.join(', ')} for over ${STUCK_MS / 60e3} minutes`); return true; }
    turnOn(api, repo, cur);
  } catch (e) {
    log(`${repo}: unchanged, ${msg(e)}`);
    return false;
  }
  log(`${repo}: AWS fallback turned on: ${oldest.name} queued since ${oldest.created_at ?? oldest.started_at}`);
  const n = openIssue(issueApi, home, repo, fallbackIssue({ repo, at: new Date(now).toISOString(), job: oldest, runs }), log);
  const left = runs.filter((id) => !restart(api, repo, id, sleep, log));
  if (left.length && n != null) {
    try {
      issueApi(`repos/${home}/issues/${n}/comments`, { method: 'POST', body: { body: `Left cancelled, not re-run: ${left.join(', ')}. Re-run them by hand.` } });
    } catch (e) { log(`${repo}: could not comment on issue #${n}: ${msg(e)}`); }
  }
  return n != null && !left.length;
}

// The watchdog's run. -> its exit code.
export function watch({ env, api, issueApi, now, sleep, log }) {
  const { repos, bad } = watchedRepos(env[WATCHED_VAR]);
  let code = 0;
  for (const b of bad) { log(`${b}: not an owner/name in ${WATCHED_VAR}, skipped`); code = 1; }
  if (!repos.length) { log(`no repos watched: ${WATCHED_VAR} is empty`); return code; }
  if (!env.FALLBACK_TOKEN) { log(`no token to read the watched repos: set the DESK_AWS_FALLBACK_TOKEN secret (${repos.join(', ')} unchecked)`); return 1; }
  for (const repo of repos) {
    if (!watchRepo({ api, issueApi, home: env.GITHUB_REPOSITORY, repo, now, sleep, log })) code = 1;
  }
  return code;
}

// -> exit code
export function off({ api, repo, log }) {
  const cur = readFallback(api, repo);
  if (cur.value == null) { log(`${repo}: AWS fallback already off (no ${FALLBACK_VAR} variable)`); return 0; }
  api(`repos/${repo}/actions/variables/${FALLBACK_VAR}`, { method: 'DELETE' });
  const after = readFallback(api, repo);
  if (after.value != null) { log(`${repo}: not off: ${FALLBACK_VAR} still reads back as ${after.value}`); return 1; }
  log(`${repo}: AWS fallback off, read back: its next runs queue for its AWS runners`);
  return 0;
}

// -> exit code
export function status({ api, repos, home = HOME_REPO, log }) {
  let code = 0;
  let list = repos;
  if (!list.length) {
    try { list = watchedRepos(api(`repos/${home}/actions/variables/${WATCHED_VAR}`).value).repos; } catch (e) {
      log(`cannot read ${home}'s ${WATCHED_VAR}: ${msg(e)}. Name a repo with --repo owner/name`);
      return 1;
    }
    if (!list.length) log(`${home} watches no repos (${WATCHED_VAR} is empty)`);
  }
  for (const repo of list) {
    try {
      const cur = readFallback(api, repo);
      if (cur.on) log(`${repo}: AWS fallback on since ${cur.updatedAt ?? 'an unknown time'}`);
      else log(`${repo}: AWS fallback off${cur.value == null ? '' : ` (${FALLBACK_VAR}=${cur.value} since ${cur.updatedAt ?? 'an unknown time'})`}`);
    } catch (e) { log(`${repo}: cannot read ${FALLBACK_VAR}: ${msg(e)}`); code = 1; }
  }
  try {
    const last = api(`repos/${home}/actions/workflows/${WATCHDOG}/runs?per_page=1`)?.workflow_runs?.[0];
    log(last ? `watchdog last ran ${last.created_at} (${last.conclusion ?? last.status}): ${last.html_url}` : `watchdog has not run on ${home}`);
  } catch (e) { log(`cannot read the watchdog's runs on ${home}: ${msg(e)}`); code = 1; }
  return code;
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const USAGE = 'usage: aws-fallback.mjs watch | off --repo owner/name | status [--repo owner/name]';

// The CLI, for this file and desk-ci.mjs. -> exit code
export function cli(args, env = process.env) {
  const [cmd, ...rest] = args;
  const flag = (name) => { const i = rest.indexOf(`--${name}`); return i < 0 ? null : rest[i + 1] ?? ''; };
  const log = (l) => console.log(l);
  const repo = flag('repo');
  if (repo != null && !REPO.test(repo)) { console.error(`--repo wants owner/name, not ${repo}`); return 2; }
  if (cmd === 'watch') return watch({ env, api: ghApi(env.FALLBACK_TOKEN), issueApi: ghApi(), now: Date.now(), sleep: sleepMs, log });
  if (cmd === 'off') {
    if (!repo) { console.error('usage: aws-fallback off --repo owner/name'); return 2; }
    return off({ api: ghApi(), repo, log });
  }
  if (cmd === 'status') return status({ api: ghApi(), repos: repo ? [repo] : [], log });
  console.error(USAGE);
  return 2;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  try { process.exitCode = cli(process.argv.slice(2)); } catch (e) { console.error(msg(e)); process.exitCode = 2; }
}
