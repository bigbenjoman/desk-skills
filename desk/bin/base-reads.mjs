// A PR's red checks read against its default branch (failure-class.mjs baseSplit's reads), one
// implementation for the pass (pass.mjs, its fix tries and outage step) and the merge driver
// (stale-base.mjs, before it re-runs a red ready PR): the job's check runs at the PR's exact merge base,
// and its newest completed run among the newest commits the default branch has gained since that merge
// base (latestOnBase says how many). Each read once per reader (`cache`); one gh cannot read is unknown.
//
// makeBaseReads({ gh, repo, branch, cached }): gh(args) -> { ok, out } runs `gh` with args; cached(key,
// read) memoises a read for the reader's lifetime (the pass gives its own, which its other reads share;
// unset, memo() over a new Map).
import { runsState } from './failure-class.mjs';

const BASE_WALK = 25, HELD_WALK = 100;

// A read memoised in `cache`, its value or the error it threw, each kept and given back as it was.
export const memo = (cache = new Map()) => (key, read) => {
  if (!cache.has(key)) { try { cache.set(key, { v: read() }); } catch (e) { cache.set(key, { e }); } }
  const c = cache.get(key);
  if (c.e) throw c.e;
  return c.v;
};

export function makeBaseReads({ gh, repo, branch, cached = memo() }) {
  const checkRunsAt = (sha, name) => cached(`check-runs:${sha}:${name}`, () => {
    const r = gh(['api', `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`, '--jq', '[.check_runs[] | {status, conclusion}]']);
    try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; }
  });
  // Where a head stands: the default branch's tip and its merge base with it, or null unread.
  const baseAtOf = (head) => cached(`base-at:${head}`, () => {
    const r = gh(['api', `repos/${repo}/compare/${encodeURIComponent(branch)}...${head}`, '--jq', '[.base_commit.sha, .merge_base_commit.sha] | @tsv']);
    const [base_sha, merge_base] = r.ok ? r.out.split('\t') : [];
    return /^[0-9a-f]{40}$/.test(base_sha ?? '') && /^[0-9a-f]{40}$/.test(merge_base ?? '') ? { base_sha, merge_base } : null;
  });
  const mergeBaseOf = (head) => baseAtOf(head)?.merge_base ?? null;
  // The default branch's own commits since a merge base, newest first: its first-parent line from its
  // tip back to the merge base, so a merged PR's branch commits, whose runs are that branch's CI and not
  // the default branch's, are never read as the base. The tip is the one listed commit no other names as
  // a parent, since the compare lists by date, not by parent; with none or several, or a line that stops
  // short of the merge base, the list is unread. Every page is read. Null unread.
  const baseCommitsSince = (sha) => cached(`base-commits:${sha}`, () => {
    const r = gh(['api', `repos/${repo}/compare/${sha}...${encodeURIComponent(branch)}?per_page=100`, '--paginate', '--jq', '.commits[] | [.sha, ([.parents[].sha] | join(","))] | @tsv']);
    if (!r.ok) return null;
    const rows = r.out.split('\n').filter(Boolean).map((l) => { const [c, ps = ''] = l.split('\t'); return [c, ps.split(',').filter(Boolean)]; });
    const parents = new Map(rows), named = new Set(rows.flatMap(([, ps]) => ps));
    const tips = rows.filter(([c]) => !named.has(c));
    if (tips.length !== 1) return rows.length ? null : [];
    const line = [];
    let s = tips[0][0];
    for (; parents.has(s) && line.length < rows.length; s = parents.get(s)[0]) line.push(s);
    return s === sha ? line : null;
  });
  // The job's latest state on the base: its newest completed run among the newest BASE_WALK commits since
  // the merge base (HELD_WALK for a check already held, so a job that runs only on some pushes can still
  // clear its hold), else at the merge base itself when fewer came since. Null when a read fails (never
  // an older run read past one), or when none of those commits ran it: a job that does not run on the
  // base's pushes is not read commit by commit back to the merge base on every pass.
  const latestOnBaseOf = (head, name, held = false) => {
    const since = mergeBaseOf(head), commits = since ? baseCommitsSince(since) : null, walk = held ? HELD_WALK : BASE_WALK;
    if (!commits) return null;
    for (const sha of commits.slice(0, walk)) {
      const runs = checkRunsAt(sha, name);
      if (runs == null) return null;
      const state = runsState(runs); if (state) return state;
    }
    return commits.length > walk ? null : runsState(checkRunsAt(since, name));
  };
  // failure-class.mjs baseSplit's reads for one head.
  const forHead = (head) => ({
    mergeBase: () => mergeBaseOf(head),
    atMergeBase: (name) => { const sha = mergeBaseOf(head); return sha ? runsState(checkRunsAt(sha, name)) : null; },
    latestOnBase: (name, o) => latestOnBaseOf(head, name, o?.held === true),
  });
  return { checkRunsAt, baseAtOf, mergeBaseOf, baseCommitsSince, latestOnBaseOf, forHead };
}
