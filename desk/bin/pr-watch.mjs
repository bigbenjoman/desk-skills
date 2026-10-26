#!/usr/bin/env node
// Watches one PR under Monitor until the thing waited on happens, prints one line, and exits: one
// plain command, so starting it never prompts, where a hand-written `gh pr checks` or `gh pr view`
// loop prompts every time. State lives in the process, like `queue.mjs watch`.
//
//   pr-watch.mjs checks <n>        every check on the head has completed and no workflow run on it
//                                  is still in flight; names each failed check
//   pr-watch.mjs head <n> <sha>    the head has moved off <sha>; prints the new sha
//   pr-watch.mjs merged <n>        the PR has merged or closed
//   options: --repo owner/name (default this repo), --interval <s> (default 60)
//
// A PR that cannot be read at start (no such PR, gh signed out) prints the error once and exits 1.
// After that a failed read is retried, and only MAX_MISSES in a row end the watch the same way.
// `checks` and `head` also end on a PR that merges or closes, since what they wait on cannot follow.
import { execFileSync } from 'node:child_process';
import { normaliseRollup, latestPerCheck, evaluateGate, FAILED } from './gate.mjs';

const MAX_MISSES = 5;
const USAGE = 'usage: pr-watch.mjs checks <n> | head <n> <sha> | merged <n> [--repo owner/name] [--interval s]';

const ghError = (e) => (String(e?.stderr ?? '').trim() || String(e?.message ?? e)).split('\n')[0];

function readPr(n, repo) {
  const out = execFileSync('gh', ['pr', 'view', n, '--repo', repo, '--json', 'number,state,headRefOid,mergedAt,statusCheckRollup'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

const short = (sha) => String(sha ?? '').slice(0, 7);
const ended = (pr) => pr.state === 'MERGED' ? `PR #${pr.number} merged${pr.mergedAt ? ` at ${pr.mergedAt}` : ''}`
  : pr.state === 'CLOSED' ? `PR #${pr.number} closed without merging` : null;

// The workflow runs on a commit: a job that `needs` another has no check until that one finishes, so
// a run still in flight is checks still to come, as gate.mjs reads it.
function readRuns(sha, repo) {
  return JSON.parse(execFileSync('gh', ['run', 'list', '--repo', repo, '--commit', sha, '--limit', '100', '--json', 'databaseId,name,workflowName,status,conclusion'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
}

// The line to print when the wait is over, or null to keep waiting.
function checksDone(pr, repo) {
  const all = normaliseRollup(pr.statusCheckRollup);
  const checks = latestPerCheck(all);
  if (!checks.length || checks.some((c) => c.status !== 'completed')) return ended(pr);
  if (evaluateGate(all, { runs: readRuns(pr.headRefOid, repo) }).pending.length) return ended(pr);
  const failed = checks.filter((c) => FAILED.has(c.conclusion));
  const at = `PR #${pr.number} checks done on ${short(pr.headRefOid)}`;
  return failed.length
    ? `${at}: ${failed.length} of ${checks.length} failed: ${failed.map((c) => `${c.name} (${c.conclusion})`).join(', ')}`
    : `${at}: none failed (${checks.length} checks)`;
}

function headMoved(pr, sha) {
  if (pr.headRefOid && !pr.headRefOid.toLowerCase().startsWith(sha.toLowerCase())) return `PR #${pr.number} head moved: ${short(sha)} -> ${pr.headRefOid}`;
  const end = ended(pr);
  return end && `${end}, head still ${short(pr.headRefOid)}`;
}

async function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v ?? ''; };
  const repoArg = opt('--repo');
  const iv = opt('--interval');
  const intervalMs = (iv !== null && Number(iv) > 0 ? Number(iv) : 60) * 1000;
  const [cmd, n, sha] = argv;
  if (!['checks', 'head', 'merged'].includes(cmd) || !/^\d+$/.test(n ?? '') || (cmd === 'head' && !/^[0-9a-f]{7,40}$/i.test(sha ?? ''))) {
    console.log(USAGE);
    return 2;
  }
  const repo = repoArg || (await import('./desk-env.mjs')).ghRepo();
  const done = cmd === 'checks' ? (pr) => checksDone(pr, repo) : cmd === 'head' ? (pr) => headMoved(pr, sha) : ended;
  let misses = 0;
  for (let first = true; ; first = false) {
    try {
      const line = done(readPr(n, repo));
      misses = 0;
      if (line) { console.log(line); return 0; }
    } catch (e) {
      if (first || ++misses >= MAX_MISSES) {
        console.log(`pr-watch: PR #${n} in ${repo}${first ? '' : ` (${misses} reads in a row)`}: ${ghError(e)}`);
        return 1;
      }
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.log(`pr-watch: ${e.message}`); process.exit(1); });
