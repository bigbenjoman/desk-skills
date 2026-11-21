#!/usr/bin/env node
// A repo's AWS fallback: the repo variable DESK_AWS_FALLBACK, which every AWS job's runs-on reads, so
// at `on` the repo's CI runs on GitHub-hosted runners. Everything goes through `gh api`.
//   node aws-fallback.mjs watch
// The watchdog (.github/workflows/aws-fallback-watch.yml, every 10 minutes). For each repo in
// DESK_AWS_WATCHED_REPOS (comma-separated owner/name) it reads the AWS runner labels the repo's
// .github/desk-ci.yml declares at its default branch. A repo with a job queued on one of them for over
// 15 minutes gets its fallback turned on, every run with a job queued on one cancelled and re-run, and
// an issue in this repo naming it, the time and the oldest queued job. A repo whose fallback is on
// already is left as it is; one that declares no labels, or whose file cannot be read, is never
// changed. FALLBACK_TOKEN reads and writes the watched repos; GH_TOKEN opens the issue in
// GITHUB_REPOSITORY, assigned to OWNER. Exit 1 when a repo could not be read or fully handled.
//   node aws-fallback.mjs off --repo owner/name
// Deletes the repo's DESK_AWS_FALLBACK and reads it back, so its next runs queue for its AWS runners.
//   node aws-fallback.mjs status [--repo owner/name] [--home owner/name]
// Whether each repo's fallback is on and since when (the variable's updated_at), and when the
// watchdog in --home (default HOME_REPO) last ran. Without --repo, every repo --home watches.
// desk-ci.mjs runs off and status as `desk-ci.mjs aws-fallback off|status`.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCiConfig, CI_CONFIG } from './desk-ci.mjs';

export const FALLBACK_VAR = 'DESK_AWS_FALLBACK';
export const WATCHED_VAR = 'DESK_AWS_WATCHED_REPOS';
export const WATCHDOG = 'aws-fallback-watch.yml';
export const HOME_REPO = 'bigbenjoman/desk-skills';
export const STUCK_MS = 15 * 60e3;
export const ISSUE_LABEL = 'aws-fallback';
const CANCEL_POLLS = 20;
const POLL_MS = 3000;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const msg = (e) => String(e?.message ?? e).trim().split('\n')[0];

// One `gh api` call; GH_TOKEN is `token` when one is given. -> the parsed JSON, or null for no body.
// A failure throws with `status`, the HTTP code gh reported.
export function ghApi(token) {
  return (path, { method = 'GET', body } = {}) => {
    const args = ['api', '-H', 'Accept: application/vnd.github+json', '-X', method, path];
    if (body !== undefined) args.push('--input', '-');
    try {
      const out = execFileSync('gh', args, {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: body === undefined ? undefined : JSON.stringify(body),
        stdio: [body === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: token ? { ...process.env, GH_TOKEN: token } : process.env,
      });
      return out.trim() ? JSON.parse(out) : null;
    } catch (e) {
      const stderr = String(e.stderr ?? e.message).trim();
      const err = new Error(`gh api -X ${method} ${path}: ${stderr}`);
      err.status = Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || null;
      throw err;
    }
  };
}

// DESK_AWS_WATCHED_REPOS's value -> { repos: owner/name each once, bad: entries that are not one }.
export function watchedRepos(value) {
  const items = String(value ?? '').split(/[\s,]+/).filter(Boolean);
  return { repos: [...new Set(items.filter((r) => REPO.test(r)))], bad: items.filter((r) => !REPO.test(r)) };
}

// A job label set runs on the repo's AWS runners when it holds a declared label or its -on-demand twin.
export const onAws = (labels, aws) => (labels ?? []).some((l) => aws.some((a) => l === a || l === `${a}-on-demand`));
const queuedAt = (j) => Date.parse(j.created_at ?? j.started_at);

// The jobs of a repo's unfinished runs -> { oldest: the job queued longest on an AWS label, when that
// is over STUCK_MS, else null; runs: the id of every run with a job queued on an AWS label }.
export function queuedAws(jobs, aws, now) {
  const queued = jobs.filter((j) => j.status === 'queued' && onAws(j.labels, aws));
  const stuck = queued.filter((j) => now - queuedAt(j) > STUCK_MS).sort((a, b) => queuedAt(a) - queuedAt(b));
  return { oldest: stuck[0] ?? null, runs: [...new Set(queued.map((j) => j.run_id))] };
}

// The AWS runner labels the repo's desk-ci.yml declares at its default branch. Throws when it cannot be read.
export function readLabels(api, repo) {
  const file = api(`repos/${repo}/contents/${CI_CONFIG}`);
  if (typeof file?.content !== 'string') throw new Error(`${CI_CONFIG} is not a file`);
  return parseCiConfig(Buffer.from(file.content, 'base64').toString('utf8')).awsLabels;
}

// -> { on, value, updatedAt }; value null when the repo has no such variable.
export function readFallback(api, repo) {
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

// Cancels a run and, once it has finished, re-runs it, so its jobs pick their runners again. -> true when re-run.
function restart(api, repo, id, sleep, log) {
  try {
    try { api(`repos/${repo}/actions/runs/${id}/cancel`, { method: 'POST' }); } catch (e) { if (e.status !== 409) throw e; }
    for (let i = 0; i < CANCEL_POLLS; i++) {
      if (api(`repos/${repo}/actions/runs/${id}`).status === 'completed') {
        api(`repos/${repo}/actions/runs/${id}/rerun`, { method: 'POST' });
        log(`${repo}: run ${id} cancelled and re-run`);
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

// One watched repo. -> { error, fallback: { repo, at, job, runs } when this turned its fallback on }
export function watchRepo({ api, repo, now, sleep, log }) {
  let aws;
  try { aws = readLabels(api, repo); } catch (e) {
    log(`${repo}: unchanged, cannot read its ${CI_CONFIG}: ${msg(e)}`);
    return { error: true };
  }
  if (!aws.length) { log(`${repo}: unchanged, its ${CI_CONFIG} declares no aws-runner-labels`); return { error: false }; }
  let cur, oldest, runs;
  try {
    cur = readFallback(api, repo);
    if (cur.on) { log(`${repo}: AWS fallback on since ${cur.updatedAt ?? 'an unknown time'}, left on`); return { error: false }; }
    const live = ['queued', 'in_progress'].flatMap((s) => api(`repos/${repo}/actions/runs?status=${s}&per_page=100`)?.workflow_runs ?? []);
    const jobs = live.flatMap((r) => (api(`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`)?.jobs ?? []).map((j) => ({ run_id: r.id, ...j })));
    ({ oldest, runs } = queuedAws(jobs, aws, now));
    if (!oldest) { log(`${repo}: unchanged, no job queued on ${aws.join(', ')} for over ${STUCK_MS / 60e3} minutes`); return { error: false }; }
    turnOn(api, repo, cur);
  } catch (e) {
    log(`${repo}: unchanged, ${msg(e)}`);
    return { error: true };
  }
  log(`${repo}: AWS fallback turned on: ${oldest.name} queued since ${oldest.created_at ?? oldest.started_at}`);
  const restarted = runs.map((id) => restart(api, repo, id, sleep, log));
  return { error: restarted.includes(false), fallback: { repo, at: new Date(now).toISOString(), job: oldest, runs } };
}

// The issue for a repo whose fallback the watchdog turned on. -> { title, body }
export function fallbackIssue({ repo, at, job, runs }) {
  const since = job.created_at ?? job.started_at;
  return {
    title: `AWS fallback on for ${repo}`,
    body: `${repo}'s AWS runners stopped taking jobs, so the watchdog turned its AWS fallback on at ${at}: its CI runs on GitHub-hosted runners until you turn it off.\n\n`
      + `Oldest queued job: **${job.name}** on ${(job.labels ?? []).join(', ')}, queued since ${since}: ${job.html_url ?? `run ${job.run_id}`}\n\n`
      + `Runs cancelled and re-run: ${runs.join(', ') || 'none'}\n\n`
      + `Back to AWS once its runners work: \`node ~/.claude/desk/bin/desk-ci.mjs aws-fallback off --repo ${repo}\`. Where it stands: \`node ~/.claude/desk/bin/desk-ci.mjs aws-fallback status\`.\n`,
  };
}

// The watchdog's run. -> its exit code.
export function watch({ env, api, issueApi, now, sleep, log }) {
  const { repos, bad } = watchedRepos(env[WATCHED_VAR]);
  let code = 0;
  for (const b of bad) { log(`${b}: not an owner/name in ${WATCHED_VAR}, skipped`); code = 1; }
  if (!repos.length) { log(`no repos watched: ${WATCHED_VAR} is empty`); return code; }
  if (!env.FALLBACK_TOKEN) { log(`no token to read the watched repos: set the DESK_AWS_FALLBACK_TOKEN secret (${repos.join(', ')} unchecked)`); return 1; }
  for (const repo of repos) {
    const r = watchRepo({ api, repo, now, sleep, log });
    if (r.error) code = 1;
    if (!r.fallback) continue;
    try {
      const n = issueApi(`repos/${env.GITHUB_REPOSITORY}/issues`, { method: 'POST', body: { ...fallbackIssue(r.fallback), labels: [ISSUE_LABEL], ...(env.OWNER ? { assignees: [env.OWNER] } : {}) } });
      log(`${repo}: opened issue #${n?.number}`);
    } catch (e) { log(`${repo}: could not open its issue: ${msg(e)}`); code = 1; }
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
export function status({ api, repos, home, log }) {
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
const USAGE = 'usage: aws-fallback.mjs watch | off --repo owner/name | status [--repo owner/name] [--home owner/name]';

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
  if (cmd === 'status') return status({ api: ghApi(), repos: repo ? [repo] : [], home: flag('home') || HOME_REPO, log });
  console.error(USAGE);
  return 2;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  try { process.exitCode = cli(process.argv.slice(2)); } catch (e) { console.error(msg(e)); process.exitCode = 2; }
}
