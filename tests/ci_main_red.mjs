// The red-main alarm (.github/workflows/ci-main-red.yml) and the macOS lane's nightly gate
// (.github/workflows/nightly-macos.yml). Both read run metadata through gh, with GH_REPO set.
//
// A lane is red while:
//   tests - its latest finished push run on main failed (failure, timed_out or startup_failure); a
//           cancelled or skipped run says nothing about the code;
//   macOS - its latest run on main that ran the suite failed or was cancelled (a cancelled run is
//           usually the job timeout, which GitHub reports as cancelled), or its latest such run that
//           was not cancelled is more than STALE_MS old. A run that passed with only its plan job
//           run (the schedule, skipping the suite because a lane run had just passed) counts as neither.
// While one is red, one issue labelled ci-main-red is open and assigned to OWNER; it is commented when
// a run goes red, and commented and closed once every lane is green and fresh.
//
// CLI (from anywhere in the repo):
//   node tests/ci_main_red.mjs alarm
//     opens, updates or closes the issue. The run that triggered it, if any, comes from RUN_ID,
//     RUN_NAME, RUN_EVENT, RUN_URL, RUN_SHA, RUN_CONCLUSION and RUN_CREATED; OWNER is who it is
//     assigned to.
//   node tests/ci_main_red.mjs nightly-due [--github-output]
//     prints due=true unless a macOS lane run on main passed in the last DUE_MS; --github-output
//     appends it to $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DUE_MS = 24 * 3600e3;
export const STALE_MS = 36 * 3600e3;
export const LABEL = 'ci-main-red';
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const SILENT = new Set(['cancelled', 'skipped']);
const LANE_EVENTS = new Set(['push', 'workflow_dispatch']);
const FIELDS = 'databaseId,conclusion,event,url,headSha,createdAt';

const at = (r) => Date.parse(r.createdAt);
const hours = (ms) => `${Math.floor(ms / 3600e3)} h`;
const short = (r) => `${r.conclusion} at ${String(r.headSha ?? '').slice(0, 7)} ${r.url}`;

// The listed runs (newest first) with the run that triggered the alarm in its place: the listing may
// not show it yet, or not its conclusion.
export function withTrigger(runs, trigger) {
  if (!trigger) return runs;
  return [trigger, ...runs.filter((r) => r.databaseId !== trigger.databaseId)].sort((a, b) => at(b) - at(a));
}

// A macOS run that concluded success with no job run but its plan skipped the suite (the quiet-day gate).
export const PLAN_JOB = 'macOS plan';
export const ranSuite = (jobs) => jobs.some((j) => j.name !== PLAN_JOB && j.conclusion !== 'skipped');

// -> { red, line }
export function testsLane(runs) {
  const r = runs.find((x) => !SILENT.has(x.conclusion));
  if (!r) return { red: false, line: 'tests: no finished run' };
  return { red: FAILED.has(r.conclusion), line: `tests: ${short(r)}` };
}

// `runs` newest first; a run with `skipped: true` skipped the suite. -> { red, line }
export function macosLane(runs, now) {
  const ran = runs.filter((r) => !r.skipped && r.conclusion !== 'skipped');
  const last = ran[0];
  if (!last) return { red: true, line: 'macOS: no run on main that ran the suite' };
  const reds = [];
  if (FAILED.has(last.conclusion) || last.conclusion === 'cancelled') reds.push(`latest ${last.event} run ${short(last)}`);
  const done = ran.find((r) => r.conclusion !== 'cancelled');
  if (!done) reds.push('stale: no run on main finished without being cancelled');
  else if (now - at(done) > STALE_MS) reds.push(`stale: the latest run that finished started ${hours(now - at(done))} ago (${short(done)})`);
  return reds.length ? { red: true, line: `macOS: ${reds.join('; ')}` } : { red: false, line: `macOS: ${short(last)}` };
}

// What the alarm does with the open issue (null when none): { action: 'create' | 'comment' | 'assign' |
// 'close' | 'none', body }. A run that passed while another lane stays red adds no comment, nor does
// a scheduled check.
export function decide({ lanes, issue, trigger }) {
  const red = lanes.filter((l) => l.red).map((l) => `- ${l.line}`);
  const what = trigger ? `**${trigger.name}** finished **${trigger.conclusion}** on main at ${String(trigger.headSha).slice(0, 7)}: ${trigger.url}` : 'The daily check of main';
  if (red.length) {
    const body = `${what}\n\nRed now:\n${red.join('\n')}\n`;
    if (issue == null) return { action: 'create', body: `${body}\nThis issue closes itself when the latest run of each lane is green and fresh again (.github/workflows/ci-main-red.yml).` };
    return { action: trigger && trigger.conclusion !== 'success' ? 'comment' : 'assign', body };
  }
  if (issue == null) return { action: 'none', body: 'main is green and no issue is open' };
  return { action: 'close', body: `Green again: ${trigger ? `**${trigger.name}** passed at ${String(trigger.headSha).slice(0, 7)} (${trigger.url}), and ` : ''}the latest tests and macOS runs on main are green and fresh.` };
}

// -> due when no lane run (a push or a dispatch, which always run the suite) on main passed in DUE_MS.
export const nightlyDue = (runs, now) => !runs.some((r) => LANE_EVENTS.has(r.event) && r.conclusion === 'success' && now - at(r) < DUE_MS);

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const runList = (wf, more = []) => JSON.parse(gh(['run', 'list', '--workflow', wf, '--branch', 'main', '--status', 'completed', ...more, '--json', FIELDS]));

function triggerOf(env) {
  if (!env.RUN_ID) return null;
  return { databaseId: Number(env.RUN_ID), name: env.RUN_NAME, event: env.RUN_EVENT, conclusion: env.RUN_CONCLUSION, url: env.RUN_URL, headSha: env.RUN_SHA, createdAt: env.RUN_CREATED };
}

function alarm(env, now) {
  const trigger = triggerOf(env);
  const mine = (name, keep) => (trigger?.name === name && keep(trigger) ? trigger : null);
  const tests = withTrigger(runList('tests.yml', ['--event', 'push', '--limit', '10']), mine('tests', (r) => r.event === 'push'));
  const macos = withTrigger(runList('nightly-macos.yml', ['--limit', '50']), mine('macOS', () => true));
  // Only a success can be a skipped suite; look up jobs newest first until one ran it.
  for (const r of macos) {
    if (r.conclusion === 'success') r.skipped = !ranSuite(JSON.parse(gh(['run', 'view', String(r.databaseId), '--json', 'jobs'])).jobs ?? []);
    if (!r.skipped && !SILENT.has(r.conclusion)) break;
  }
  const lanes = [testsLane(tests), macosLane(macos, now)];
  for (const l of lanes) console.log(l.line);
  try { gh(['label', 'create', LABEL, '--color', 'B60205', '--description', 'a CI lane on main is red, cancelled or stale']); } catch { /* it exists */ }
  const issue = JSON.parse(gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '1', '--json', 'number']))[0]?.number ?? null;
  const d = decide({ lanes, issue, trigger });
  const assign = (n) => { try { gh(['issue', 'edit', String(n), '--add-assignee', env.OWNER]); } catch { console.log(`could not assign issue #${n} to ${env.OWNER}`); } };
  if (d.action === 'create') {
    const url = gh(['issue', 'create', '--label', LABEL, '--title', 'main is red: a CI lane on main is failing, cancelled or stale', '--body', d.body]).trim();
    if (env.OWNER) assign(url.replace(/^.*\//, ''));
  } else if (d.action === 'comment' || d.action === 'assign') {
    if (d.action === 'comment') gh(['issue', 'comment', String(issue), '--body', d.body]);
    if (env.OWNER) assign(issue);
  } else if (d.action === 'close') {
    gh(['issue', 'comment', String(issue), '--body', d.body]);
    gh(['issue', 'close', String(issue)]);
  }
  console.log(d.action === 'none' ? d.body : `${d.action}${issue != null ? ` #${issue}` : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  const now = Date.now();
  if (cmd === 'alarm') alarm(process.env, now);
  else if (cmd === 'nightly-due') {
    const due = nightlyDue(runList('nightly-macos.yml', ['--limit', '50']), now);
    console.log(`due=${due}`);
    if (args.includes('--github-output')) appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\n`);
  } else { console.error('usage: ci_main_red.mjs alarm | nightly-due [--github-output]'); process.exit(2); }
}
