// §4 Evidence workflow: the repo's own workflow that takes a PR's screenshots and writes them into its
// body, in place of the `_drag <file>_` cells a worker leaves when it cannot take them itself. Where no
// such workflow fills them, cells whose file was never taken go to a capture worker (missingShots). The pass
// starts it for a draft PR whose body still has those cells and carries a fenced ```evidence block
// (undraft.mjs evidenceCall decides when), as `gh workflow run <file> --ref <default branch> -f pr=<n>`:
// the workflow runs the default branch's code and reads the PR number alone, so a worker's branch can
// change neither. Once per PR head:
//
//   <dir>/<n>-<head>.json   { workflow, runId, url, at, cells }, written as it is started
//   <dir>/fixes.json        the repo-level fixes started for runs that failed (readFixes)
//
// The run is read back by its id (gh workflow run prints the run's URL). A run whose id was not
// printed is read as done once DISPATCH_GRACE_MS has passed, so its cells go on from then as any left
// by a finished run do (undraft.mjs undraftCall).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREENSHOT_FILE, expandHome, configValue, configValues, ghRepo, permission } from './desk-env.mjs';
import { failureLines } from './gate.mjs';

export const DISPATCH_GRACE_MS = 30 * 60 * 1000;

const file = (dir, n, head) => join(dir, `${n}-${head}.json`);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// The §4 Evidence workflow row's items (desk-env configValues) as { workflow } or { errors }, or null
// when it is unset or `none`. One item: the workflow's file name.
export function parseEvidenceRow(items) {
  if (!items || !items.length) return null;
  if (items.length === 1 && /^none$/i.test(items[0].trim())) return null;
  const errors = [];
  if (items.length > 1) errors.push(`${items.length} items, want one`);
  const wf = items[0].trim();
  if (!/^[\w.-]+\.ya?ml$/.test(wf)) errors.push(`\`${wf}\` is not a workflow file name`);
  return errors.length ? { errors } : { workflow: wf };
}

// A body the evidence workflow can fill: `_drag <file>_` cells left, and a fenced ```evidence block
// saying what to shoot.
// A cell is never inside a code span or a fenced block: a body that writes `_drag <file>_` there is
// describing the cell, not leaving one (DS-381). A span stays on its line and closes only on a run of
// its own length; a backtick run with no partner is left as text, so it cannot hide the cells below it.
const outsideCode = (body) => String(body ?? '').replace(/^[ \t]*(```|~~~)[^]*?^[ \t]*\1[^\n]*$/gm, '').replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, '');
export const dragCells = (body) => (outsideCode(body).match(/_drag \S+_/g) ?? []).length;
export const hasEvidenceBlock = (body) => /^\s*```evidence\b/m.test(String(body ?? ''));
// The files a body's `_drag <file>_` cells name, once each, in the order they first appear.
export const dragFiles = (body) => [...new Set([...outsideCode(body).matchAll(/_drag (\S+)_/g)].map((m) => m[1]))];
// The files a body's cells name that `shots` (the file names in the ticket's screenshot directory)
// does not hold: screenshots nobody took, which a capture try (fix-tries.mjs captureTry) takes.
export const missingShots = (body, shots) => dragFiles(body).filter((f) => !(shots ?? []).includes(f));
// A ticket's screenshot directory: the one its worker was briefed with, or the one a handed-off session
// printed (images_dir). The pass also uploads from it where no round's log names one.
export const ticketShotDir = (t, stateDir) => expandHome(t.images_dir ?? join(stateDir, 'images', t.key));
// The screenshot files that directory holds.
export const ticketShots = (t, stateDir) => {
  try { return readdirSync(ticketShotDir(t, stateDir)).filter((f) => SCREENSHOT_FILE.test(f)); } catch { return []; }
};
// The run id in gh workflow run's output (it prints the run's URL), or null.
export function runIdFrom(out) {
  const m = String(out ?? '').match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

// `cells`: the `_drag <file>_` cells left when it was started, so a run that filled none is told apart.
export function recordDispatch(dir, n, head, { workflow, out, cells = null, at = new Date().toISOString() }) {
  mkdirSync(dir, { recursive: true });
  const runId = runIdFrom(out);
  const url = runId ? String(out).match(/https:\S+\/actions\/runs\/\d+/)?.[0] ?? null : null;
  const rec = { workflow, runId, url, at, cells };
  writeFileSync(file(dir, n, head), `${JSON.stringify(rec)}\n`);
  return rec;
}

// The run started for PR n at head, or null when none was: { state: 'running' | 'done', conclusion,
// url, workflow, runId, cells }. view(runId) reads the run ({ status, conclusion } from gh run view, or
// null when it cannot be read, which reads as still running).
export function evidenceRecord(dir, n, head, view, now = Date.now()) {
  if (!head) return null;
  const rec = readJson(file(dir, n, head));
  if (!rec) return null;
  const base = { workflow: rec.workflow, url: rec.url ?? null, runId: rec.runId ?? null, cells: rec.cells ?? null, at: rec.at ?? null };
  if (!rec.runId) {
    const done = now - Date.parse(rec.at) >= DISPATCH_GRACE_MS;
    return { ...base, state: done ? 'done' : 'running', conclusion: done ? 'unknown (its run id was not printed)' : null };
  }
  const r = view?.(rec.runId) ?? null;
  if (!r || r.status !== 'completed') return { ...base, state: 'running', conclusion: null };
  return { ...base, state: 'done', conclusion: r.conclusion ?? 'unknown' };
}

// ---- a run that failed ---------------------------------------------------------------------------
// A finished run that failed, or that filled none of the cells it was started for, is broken for a
// reason in the repo or its CI (an expired bypass, a preview it cannot reach), not cells it could not
// reach: a worker fixes it for the repo, once for every PR it fails the same way. Its run is read back
// by id, so one with no id is the person's as before.
export const runFailed = (rec, left) => !!rec?.runId && rec.state === 'done'
  && (rec.conclusion === 'failure' || (rec.conclusion === 'success' && rec.cells != null && left >= rec.cells));

// The first error line of `gh run view <id> --log-failed` (each line `<job>\t<step>\t<time> <text>`),
// or null when it has none.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/;
const ERROR = /\b(?:error|errors|fatal|failed|failure|exception)\b/i;
const logLines = (log) => String(log ?? '').split(/\r?\n/).map((l) => l.replace(ANSI, '').split('\t').pop().replace(STAMP, '').trim());
export function firstErrorLine(log) {
  const line = logLines(log).find((l) => ERROR.test(l));
  return line ? line.replace(/^##\[error\]\s*/, '').trim() || null : null;
}

// The lines of a failed job's log that name a cause (a typed error such as `ReferenceError: x`, an
// errno such as ENOENT, `error TS2304`, a failed test), at most LOG_ERRORS_MAX of them, each once. A
// job's closing exit-code line and a summary counting no failures name none.
const LOG_ERRORS_MAX = 5;
const NAMES_CAUSE = /\b[A-Za-z]*(?:Error|Exception)\b|\b(?:ENOENT|EACCES|EPERM|EEXIST|ECONNREFUSED|ETIMEDOUT|EADDRINUSE)\b|\bFAIL\b/;
const NO_CAUSE = /\bcontinue-on-error\b|\b0 (?:errors?|failed|failures?)\b/i;
export function errorLinesIn(log) {
  const lines = failureLines(logLines(log).map((l) => ({ annotation_level: 'failure', message: l.replace(/^##\[error\]\s*/, '').trim() })));
  return [...new Set(lines.filter((l) => (NAMES_CAUSE.test(l) || ERROR.test(l)) && !NO_CAUSE.test(l)))].slice(0, LOG_ERRORS_MAX);
}

// The line with what differs between two runs of one failure taken out: timestamps, SHAs, run ids and
// other long numbers, and PR numbers.
export const normaliseLine = (line) => String(line ?? '')
  .replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, '<time>')
  .replace(/\b[0-9a-f]{7,40}\b/gi, (m) => (/\d/.test(m) && /[a-f]/i.test(m) ? '<sha>' : m))
  .replace(/#\d+\b/g, '#<n>')
  .replace(/\b\d{4,}\b/g, '<n>')
  .replace(/\s+/g, ' ')
  .trim();

// What groups the same failure across PRs: the workflow file and its first error line, normalised.
export const NO_ERROR_LINE = 'no error line in its failed log';
export const failureKey = (workflow, line) => `${workflow}: ${line ? normaliseLine(line) : NO_ERROR_LINE}`;

// The repo-level fixes started for failed runs, keyed by failureKey: { [key]: { workflow, line, run,
// url, fix, at, done_at, prs: { [n]: { ticket, head, rerun } } } }. `fix` is the ticket that fixes it,
// `done_at` when it was first read as done; a PR's `rerun` is the head its run was started again at
// once the fix was done.
const fixesFile = (dir) => join(dir, 'fixes.json');
export const readFixes = (dir) => readJson(fixesFile(dir)) ?? {};
export function writeFixes(dir, fixes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fixesFile(dir), `${JSON.stringify(fixes, null, 2)}\n`);
}

// What each failed run's PR does, given the fixes started so far. failures: [{ n, ticket, head, key,
// workflow, line, run, url, at }] (`at`: when its run was started). fixState(fix) -> 'open' (its ticket
// is not done), 'done' (it is, and what it changed is on the default branch) or 'gone' (it failed).
// Returns { file: [{ key, workflow, line, run, url, prs: [failure] }], prs: [{ ...failure, call, fix }] }:
//   file    no fix is started for this failure, or its fix was done before this run started (the
//           failure came back): one is filed for every PR it fails
//   wait    its fix is not done yet: the PR waits on it
//   rerun   its fix is done and its run, started before that, has not been started again at this head
//   person  its run failed the same way when it was started again after the fix, or the fix failed
export function evidenceFixPlan(failures, fixes, fixState) {
  const file = new Map();
  const prs = [];
  const fileIt = (f) => {
    if (!file.has(f.key)) file.set(f.key, { key: f.key, workflow: f.workflow, line: f.line, run: f.run, url: f.url, prs: [] });
    file.get(f.key).prs.push(f);
    prs.push({ ...f, call: 'file', fix: null });
  };
  // A failure is back once any of its runs started after its fix was done: decided for the key before
  // any PR is, so none is started again under the fix that did not hold.
  const back = new Set(failures.filter((f) => {
    const rec = fixes[f.key];
    return rec?.fix && rec.done_at && f.at && fixState(rec.fix) === 'done' && Date.parse(f.at) > Date.parse(rec.done_at);
  }).map((f) => f.key));
  for (const f of failures) {
    const rec = fixes[f.key];
    if (!rec?.fix) { fileIt(f); continue; }
    const st = fixState(rec.fix);
    const was = rec.prs?.[f.n];
    if (st === 'gone') prs.push({ ...f, call: 'person', fix: rec.fix, why: `${rec.fix}, the fix started for it, failed` });
    else if (st !== 'done') prs.push({ ...f, call: 'wait', fix: rec.fix });
    else if (was?.rerun === f.head) prs.push({ ...f, call: 'person', fix: rec.fix, why: `it failed the same way when it was run again after ${rec.fix} fixed it` });
    else if (back.has(f.key)) fileIt(f);
    else prs.push({ ...f, call: 'rerun', fix: rec.fix });
  }
  return { file: [...file.values()], prs };
}

// The fix ticket for one failure on `prs` ([{ n, ticket }]), as desk-jira's Bug template:
// { summary, body }. `repo` is owner/name, `base` the default branch.
export function fixTicket({ workflow, line, run, url, prs }, { repo, base, today = new Date().toISOString().slice(0, 10) }) {
  const err = line ?? NO_ERROR_LINE;
  const short = err.length > 90 ? `${err.slice(0, 89)}…` : err;
  const list = prs.map((p) => `#${p.n} (${p.ticket})`).join(', ');
  const runRef = url ?? `run ${run}`;
  const summary = `evidence workflow ${workflow} fails on every PR: ${short}`;
  const body = `## Problem
The evidence workflow \`${workflow}\` failed on ${prs.length === 1 ? 'a draft PR' : `${prs.length} draft PRs`} with the same error, so none of their screenshots were taken. The failure is in the workflow, its script or the repo's CI, not in the PRs, and every PR waits on this ticket.

## Where seen
${repo} · ${runRef} · PRs ${list} · seen ${today}

## Steps to reproduce
1. Run \`gh workflow run ${workflow} --repo ${repo} --ref ${base} -f pr=${prs[0].n}\`.
2. Read the run's log with \`gh run view <run id> --repo ${repo} --log-failed\`.

**Expected:** the run takes the screenshots and writes them into the PR body.
**Actual:** it fails with \`${err}\`.

## Diagnosis
Read from ${runRef} (run id ${run}).
First error line: \`${err}\`.
Suggested fix: read the full log, find what the workflow or its script needs that it no longer gets, and fix it in the repo on ${base}.

## Acceptance criteria
1. AC1: Given a draft PR with \`_drag <file>_\` cells and an \`evidence\` block, when \`${workflow}\` runs for it on ${base}, then it no longer fails with \`${err}\`.

## Verification
* Unit: none, as the workflow runs only on GitHub.
* Manual: once this merges, the next desk pass starts \`${workflow}\` again on ${list}, and each run's conclusion is read there.

## Design
No UI.

## Out of scope
* The PRs' own changes.

## Decisions
* ${today} desk: a failed evidence run is fixed for the repo by a worker, not handed to the person one PR at a time. Where the fix needs a secret or a dashboard setting only the person holds, the worker parks naming that setting and why.

## Build on
* \`.github/workflows/${workflow}\` and the script it runs.
`;
  return { summary, body };
}

// `gh`'s arguments to start the evidence workflow for PR n: on `ref`, the default branch whose code it
// runs, with the PR number its one input. The pass (pass.mjs startEvidence) and dispatchCall both use it.
export const evidenceRunArgs = (workflow, repo, ref, n) => ['workflow', 'run', workflow, '--repo', repo, '--ref', ref, '-f', `pr=${n}`];

// A worker's own dispatch of §4 Evidence workflow, which it may start from the moment its draft PR
// opens, before the queue records the PR. Its settings allow only
// `node <bin>/evidence.mjs dispatch <its branch> <n>`, the branch fixed by the rule. A `pr=*` rule
// could not hold the number to digits, as the shell expands an unquoted `*` against files the worker
// writes, so this checks the arguments instead and starts the run with evidenceRunArgs, on the config
// row's default branch, never a batch base.
//
//   node evidence.mjs dispatch <branch> <pr>
//
// `view` is gh pr view's { headRefName, state, isCrossRepository } for the PR, or null when it could
// not be read. -> { args } for `gh`, or { refused } saying why.
export function dispatchCall({ argv, view, workflow, repo, ref, allowed }) {
  if (argv.length !== 2) return { refused: 'usage: evidence.mjs dispatch <branch> <pr>' };
  const [branch, pr] = argv;
  if (!/^[1-9]\d*$/.test(pr)) return { refused: `"${pr}" is not a PR number` };
  if (!allowed) return { refused: '§3 worker-workflow-dispatch is not yes' };
  if (!workflow) return { refused: '§4 Evidence workflow names no usable workflow' };
  if (!repo) return { refused: 'no §0 GitHub repo' };
  if (!view) return { refused: `PR #${pr} could not be read` };
  if (view.headRefName !== branch || view.isCrossRepository) return { refused: `PR #${pr} is not ${branch}'s own PR` };
  if (view.state !== 'OPEN') return { refused: `PR #${pr} is ${String(view.state).toLowerCase()}` };
  return { args: evidenceRunArgs(workflow, repo, ref, pr) };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd !== 'dispatch') { console.error('usage: evidence.mjs dispatch <branch> <pr>'); process.exit(2); }
  const safe = (f) => { try { return f(); } catch { return null; } };
  const repo = safe(ghRepo);
  const row = parseEvidenceRow(safe(() => configValues('evidence-workflow')));
  const view = /^[1-9]\d*$/.test(argv[1] ?? '') && repo ? safe(() => JSON.parse(execFileSync('gh', ['pr', 'view', argv[1], '--repo', repo, '--json', 'headRefName,state,isCrossRepository'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))) : null;
  const call = dispatchCall({
    argv, view, workflow: row?.workflow ?? null, repo,
    ref: String(safe(() => configValue('default-branch')) ?? '').trim() || 'main',
    allowed: safe(() => permission('worker-workflow-dispatch')) === 'yes',
  });
  if (call.refused) { console.error(`evidence.mjs: refused: ${call.refused}`); process.exit(1); }
  const r = spawnSync('gh', call.args, { stdio: 'inherit' });
  if (r.error) { console.error(`evidence.mjs: ${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}
