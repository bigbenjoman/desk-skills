// The post-merge watch. For WATCH_DAYS after a ticket's PR merges, a revert of it on the default
// branch, or a default-branch run that fails within RED_HOURS of the merge, is recorded against the
// ticket in <state>/post-merge.jsonl, where the levers' post-merge guardrail and revert trip read it.
// The queue maps a PR to its ticket and its merge time. Appended only, one line per record:
//   {kind: 'revert',   ticket, pr, merged_at, commit, subject, at}
//   {kind: 'red_main', ticket, pr, merged_at, run: {id, name, url, created_at}, at}
//   {kind: 'scan', at, complete, why?}   one per scan; the next is due SCAN_EVERY_MS after it
// A scan that could not read a source says so on its scan line and records nothing from that source.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const FILE = 'post-merge.jsonl';
export const WATCH_DAYS = 14;
export const RED_HOURS = 24;
export const SCAN_EVERY_MS = 86_400_000;
const DAY_MS = 86_400_000;
const RUN_LIMIT = 200;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

export const postMergePath = (state) => join(state, FILE);

export function readPostMerge(state) {
  const path = postMergePath(state);
  if (!existsSync(path)) return [];
  const out = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    try { const d = JSON.parse(raw); if (d && typeof d === 'object') out.push(d); } catch { /* a torn line */ }
  }
  return out;
}

// The PR a commit subject reverts, or null: `Revert "<title> (#N)"` (a squash merge, with or without
// the revert's own ` (#M)` after it) or `Revert "Merge pull request #N from …"` (a merge commit). A
// revert of a revert puts the change back, so it reverts nothing.
export function revertedPr(subject) {
  const m = /^Revert "(.*)"/.exec(String(subject ?? ''));
  if (!m || m[1].startsWith('Revert "')) return null;
  const n = /\(#(\d+)\)\s*$/.exec(m[1]) ?? /^Merge pull request #(\d+)\b/.exec(m[1]);
  return n ? Number(n[1]) : null;
}

// Every ticket in the queue with a merged PR: [{ticket, pr, merged_at}].
export function mergedTickets(queue) {
  const out = [];
  for (const [ticket, t] of Object.entries(queue?.tickets ?? {})) {
    const pr = Number(t?.pr_status?.pr ?? t?.result?.pr);
    if (Number.isInteger(pr) && pr > 0 && Number.isFinite(Date.parse(t?.merged_at))) out.push({ ticket, pr, merged_at: t.merged_at });
  }
  return out;
}

const recordKey = (r) => (r.kind === 'revert' ? `${r.ticket}|revert|${r.commit}` : r.kind === 'red_main' ? `${r.ticket}|red_main|${r.run?.id}` : null);

// The records a scan finds. `commits` are [{sha, at, subject}] from the default branch; `runs` are
// [{id, name, url, conclusion, created_at}] from it, or null when they could not be read.
export function findRecords({ merges, commits, runs, at }) {
  const byPr = new Map(merges.map((m) => [m.pr, m]));
  const found = [];
  for (const c of commits) {
    const m = byPr.get(revertedPr(c.subject));
    if (!m) continue;
    const gap = Date.parse(c.at) - Date.parse(m.merged_at);
    if (gap >= 0 && gap <= WATCH_DAYS * DAY_MS) found.push({ kind: 'revert', ticket: m.ticket, pr: m.pr, merged_at: m.merged_at, commit: c.sha, subject: c.subject, at });
  }
  for (const r of runs ?? []) {
    if (!FAILED.has(r.conclusion)) continue;
    for (const m of merges) {
      const gap = Date.parse(r.created_at) - Date.parse(m.merged_at);
      if (gap > 0 && gap <= RED_HOURS * 3_600_000) {
        found.push({ kind: 'red_main', ticket: m.ticket, pr: m.pr, merged_at: m.merged_at, run: { id: r.id, name: r.name, url: r.url, created_at: r.created_at }, at });
      }
    }
  }
  return found;
}

// One scan, if one is due: `log(sinceIso)` gives the default branch's commits and `runs()` its runs,
// each throwing when it cannot read. -> {ran, written: [records], complete, why, line}
export function postMergeScan({ state, queue, log, runs, now = Date.now(), force = false }) {
  const have = readPostMerge(state);
  const last = Math.max(-Infinity, ...have.filter((r) => r.kind === 'scan').map((r) => Date.parse(r.at)).filter(Number.isFinite));
  if (!force && now - last < SCAN_EVERY_MS) return { ran: false, written: [], complete: true, why: null, line: null };
  const at = new Date(now).toISOString();
  // A merge a day older than the watch is still read, so a scan a day late misses nothing in it.
  const merges = mergedTickets(queue).filter((m) => now - Date.parse(m.merged_at) <= (WATCH_DAYS + 1) * DAY_MS);
  const why = [];
  let commits = [];
  let runList = null;
  if (merges.length) {
    const since = new Date(Math.min(...merges.map((m) => Date.parse(m.merged_at)))).toISOString();
    try { commits = log(since); } catch (e) { why.push(`default-branch log not read: ${firstLine(e)}`); }
    try { runList = runs(); } catch (e) { why.push(`default-branch runs not read: ${firstLine(e)}`); }
  }
  const seen = new Set(have.map(recordKey).filter(Boolean));
  const written = findRecords({ merges, commits, runs: runList, at }).filter((r) => !seen.has(recordKey(r)) && seen.add(recordKey(r)));
  const complete = !why.length;
  const lines = [...written, { kind: 'scan', at, complete, ...(complete ? {} : { why: why.join('; ') }) }];
  mkdirSync(state, { recursive: true });
  appendFileSync(postMergePath(state), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const named = written.map((r) => `${r.ticket} ${r.kind === 'revert' ? `reverted by ${r.commit.slice(0, 12)}` : `red main in run ${r.run.id}`}`);
  const line = written.length || !complete
    ? `post-merge watch: ${named.length ? named.join(', ') : 'nothing recorded'}${complete ? '' : `; scan incomplete (${why.join('; ')})`}`
    : null;
  return { ran: true, written, complete, why: complete ? null : why.join('; '), line };
}

function firstLine(e) { return String(e?.stderr || e?.message || e).trim().split('\n')[0]; }

// The default branch's commits since `since`, from `ref` in the repo at `cwd`.
export function gitLog(cwd, ref, since) {
  const out = execFileSync('git', ['-C', cwd, 'log', ref, `--since=@${Math.floor(Date.parse(since) / 1000)}`,'--format=%H%x09%cI%x09%s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').filter(Boolean).map((l) => { const [sha, at, ...s] = l.split('\t'); return { sha, at, subject: s.join('\t') }; });
}

// The default branch's latest workflow runs on GitHub.
export function ghRuns(repo, branch) {
  const out = execFileSync('gh', ['run', 'list', '--repo', repo, '--branch', branch, '--limit', String(RUN_LIMIT), '--json', 'databaseId,workflowName,conclusion,createdAt,url'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out).map((r) => ({ id: r.databaseId, name: r.workflowName, url: r.url, conclusion: r.conclusion, created_at: r.createdAt }));
}

// The scan as a pass runs it, once a day: the default branch fetched in `cwd`, then read from origin.
// -> the line for the pass's report, or null when there is nothing to say.
export function postMergeWatch({ state, queue, repo, branch, cwd, now = Date.now() }) {
  try {
    return postMergeScan({
      state, queue, now,
      log: (since) => {
        execFileSync('git', ['-C', cwd, 'fetch', '-q', 'origin', branch], { stdio: 'ignore' });
        return gitLog(cwd, `origin/${branch}`, since);
      },
      runs: () => ghRuns(repo, branch),
    }).line;
  } catch (e) { return `post-merge watch: not run (${firstLine(e)})`; }
}
