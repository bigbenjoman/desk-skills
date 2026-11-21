// The post-merge watch. For WATCH_DAYS after a ticket's PR merges, a revert of it on the default
// branch, or a default-branch run that fails within RED_HOURS of the merge, is recorded against the
// ticket in <state>/post-merge.jsonl. A merge's runs are the default branch's runs on its merge
// commit, read one merge at a time, so a busy branch costs no more than a quiet one.
// The queue maps a PR to its ticket and its merge time. Appended only, one line per record:
//   {kind: 'revert',   ticket, pr, merged_at, commit, subject, at}
//   {kind: 'red_main', ticket, pr, merged_at, run: {id, name, url, created_at}, at}
//   {kind: 'scan', at, complete, why?}   one per scan; the next is due SCAN_EVERY_MS after it
// A scan that could not read a source says so on its scan line and records nothing from that source.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { everyTicket } from './queue-store.mjs';
import { promotionPr } from './batch-state.mjs';

export const FILE = 'post-merge.jsonl';
export const WATCH_DAYS = 14;
export const RED_HOURS = 24;
export const SCAN_EVERY_MS = 86_400_000;
const DAY_MS = 86_400_000;
const RUN_PAGE = 100;
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
  return m ? landedPr(m[1]) : null;
}

// Every ticket in the queue with a merged PR, archived ones included (a merged ticket is archived
// within a pass of its merge): [{ticket, pr, merged_at, own, base, promotion}]. `own` is the merge
// commit the pass read from the PR (pr_status.merge_commit) or null, `base` the branch it merged into,
// and `promotion` the promotion PR that took a batch child on (batch-state promotionPr) or null.
export function mergedTickets(queue) {
  const out = [];
  for (const [ticket, t] of Object.entries(everyTicket(queue))) {
    const pr = mergedPr(t);
    const own = SHA40.test(String(t.pr_status?.merge_commit ?? '')) ? t.pr_status.merge_commit : null;
    if (pr) out.push({ ticket, pr, merged_at: t.merged_at, own, base: t.pr_status?.base ?? null, promotion: promotionPr(queue, t) });
  }
  return out;
}
const SHA40 = /^[0-9a-f]{40}$/;

// The commit that put merge `m`'s code on the default branch, among `commits` (the default branch's,
// since the watch began), and when it landed: its own merge commit, else its promotion PR's, else the
// commit whose subject lands either PR. -> { sha, at } or null.
// Only the default branch's own commits count (`first` false marks one a merged side branch brought in).
function landing(m, all) {
  const commits = all.filter((c) => c.first !== false);
  const on = (sha) => (sha && commits.some((c) => c.sha === sha) ? sha : null);
  const by = (pr) => (pr == null ? null : commits.find((c) => landedPr(c.subject) === Number(pr))?.sha ?? null);
  const p = m.promotion;
  const own = on(m.own) ?? by(m.pr);
  if (own) return { sha: own, at: m.merged_at };
  const promoted = on(p?.merge_commit) ?? by(p?.pr);
  return promoted ? { sha: promoted, at: p.merged_at } : null;
}

// The PR a default-branch commit subject lands, or null: `<title> (#N)` (a squash merge) or
// `Merge pull request #N from …` (a merge commit).
export function landedPr(subject) {
  const s = String(subject ?? '');
  if (s.startsWith('Revert "')) return null;
  const n = /^Merge pull request #(\d+)\b/.exec(s) ?? /\(#(\d+)\)\s*$/.exec(s);
  return n ? Number(n[1]) : null;
}

// Queue ticket `t`'s merged PR number, or null when it has none merged.
export const mergedPr = (t) => {
  const pr = Number(t?.pr_status?.pr ?? t?.result?.pr);
  return Number.isInteger(pr) && pr > 0 && Number.isFinite(Date.parse(t?.merged_at)) ? pr : null;
};

const recordKey = (r) => (r.kind === 'revert' ? `${r.ticket}|revert|${r.commit}` : r.kind === 'red_main' ? `${r.ticket}|red_main|${r.run?.id}` : null);

// The records a scan finds. `commits` are [{sha, at, subject, first}] from the default branch; `runs` are
// [{id, name, url, conclusion, created_at, sha}], each on the commit `sha` it was read for, or null
// when none could be read. A merge's `sha` and `landed_at` are where and when its code reached the
// default branch: a run on that commit failing within RED_HOURS of then is the merge's.
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
    for (const m of merges.filter((x) => x.sha && x.sha === r.sha)) {
      const gap = Date.parse(r.created_at) - Date.parse(m.landed_at ?? m.merged_at);
      if (gap > 0 && gap <= RED_HOURS * 3_600_000) {
        found.push({ kind: 'red_main', ticket: m.ticket, pr: m.pr, merged_at: m.merged_at, run: { id: r.id, name: r.name, url: r.url, created_at: r.created_at }, at });
      }
    }
  }
  return found;
}

const lastScan = (have) => Math.max(-Infinity, ...have.filter((r) => r.kind === 'scan').map((r) => Date.parse(r.at)).filter(Number.isFinite));
// A merge a day older than the watch is still read, so a scan a day late misses nothing in it.
const watched = (queue, now) => mergedTickets(queue).filter((m) => now - Date.parse(m.merged_at) <= (WATCH_DAYS + 1) * DAY_MS);

// Whether a scan is due and has a merge to watch: the supervisor runs a pass for it on an idle batch,
// which would otherwise run none, so the watch lasts its WATCH_DAYS after the batch's last merge.
export function postMergeDue({ state, queue, now = Date.now() }) {
  return now - lastScan(readPostMerge(state)) >= SCAN_EVERY_MS && watched(queue, now).length > 0;
}

// One scan, if one is due: `log(sinceIso)` gives the default branch's commits since then and
// `runs(sha)` the default branch's runs on one commit, each throwing when it cannot read all of them.
// Each merge's runs are read on the commit that put its code there (landing). A batch child merged into
// another branch (`branch` names the default) whose promotion has not merged is not there yet: it has
// no runs to read.
// -> {ran, written: [records], line}
export function postMergeScan({ state, queue, log, runs, branch = null, now = Date.now() }) {
  const have = readPostMerge(state);
  if (now - lastScan(have) < SCAN_EVERY_MS) return { ran: false, written: [], line: null };
  const at = new Date(now).toISOString();
  const merges = watched(queue, now);
  const why = [];
  let commits = [];
  let runList = null;
  if (merges.length) {
    // An hour early, so a merge commit dated a moment before the PR's merge time is in the log.
    const since = new Date(Math.min(...merges.map((m) => Date.parse(m.merged_at))) - 3_600_000).toISOString();
    let logged = true;
    try { commits = log(since); } catch (e) { logged = false; why.push(`default-branch log not read: ${firstLine(e)}`); }
    const unread = [];
    for (const m of merges) {
      if (branch && m.base && m.base !== branch && !m.promotion) continue;
      const l = logged ? landing(m, commits) : null;
      m.sha = l?.sha ?? null; m.landed_at = l?.at ?? null;
      if (!m.sha) { unread.push(`#${m.pr}: no merge commit${logged ? ' on the default branch' : ' (the log was not read)'}`); continue; }
      try { (runList ??= []).push(...runs(m.sha).map((r) => ({ ...r, sha: m.sha }))); } catch (e) { unread.push(`#${m.pr} at ${m.sha.slice(0, 12)}: ${firstLine(e)}`); }
    }
    if (unread.length) why.push(`default-branch runs not read: ${unread.join('; ')}`);
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
  return { ran: true, written, line };
}

function firstLine(e) { return String(e?.stderr || e?.message || e).trim().split('\n')[0]; }

// The default branch's commits since `since`, from `ref` in the repo at `cwd`: every commit it reaches,
// so a revert inside a merged PR's branch is read, each marked `first` when it is on the branch's own
// first-parent line (a commit that landed there, not one a merge brought in).
export function gitLog(cwd, ref, since) {
  const read = (...a) => execFileSync('git', ['-C', cwd, 'log', ref, ...a, `--since=@${Math.floor(Date.parse(since) / 1000)}`, '--format=%H%x09%cI%x09%s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter(Boolean).map((l) => { const [sha, at, ...s] = l.split('\t'); return { sha, at, subject: s.join('\t') }; });
  const first = new Set(read('--first-parent').map((c) => c.sha));
  return read().map((c) => ({ ...c, first: first.has(c.sha) }));
}

// The default branch's workflow runs on GitHub on commit `sha`. A merge commit has a few runs, so one
// page holds them; one with more than a page throws rather than pass for a complete read.
export function ghRuns(repo, branch, sha, gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  const page = JSON.parse(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&branch=${encodeURIComponent(branch)}&per_page=${RUN_PAGE}`]));
  const list = page.workflow_runs ?? [];
  if (Number(page.total_count) > list.length) throw new Error(`${page.total_count} runs on ${sha.slice(0, 12)}, more than one page read`);
  return list.map((r) => ({ id: r.id, name: r.name, url: r.html_url, conclusion: r.conclusion, created_at: r.created_at }));
}

// The scan as a pass runs it, once a day: the default branch fetched in `cwd`, then read from origin.
// -> the line for the pass's report, or null when there is nothing to say.
export function postMergeWatch({ state, queue, repo, branch, cwd }) {
  try {
    return postMergeScan({
      state, queue, branch,
      log: (since) => {
        execFileSync('git', ['-C', cwd, 'fetch', '-q', 'origin', branch], { stdio: 'ignore' });
        return gitLog(cwd, `origin/${branch}`, since);
      },
      runs: (sha) => ghRuns(repo, branch, sha),
    }).line;
  } catch (e) { return `post-merge watch: not run (${firstLine(e)})`; }
}
