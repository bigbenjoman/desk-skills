// What became of merged PRs no queue ticket is behind, read from GitHub for the handoff report
// (handoff-report.mjs). Each PR is measured on its own windows from its merge:
//   red main      a default-branch push run on its merge commit failing within RED_HOURS
//                 (post-merge.mjs findRecords, on the check suites of that commit)
//   follow-ups    merged PRs titled as a fix, hotfix or revert within FOLLOW_UP_HOURS that touch any
//                 of its files
//   reverts       PRs merged into the default branch within post-merge's WATCH_DAYS, found by a
//                 title search for Revert and a body search for Reverts, whose title reverts its
//                 title or whose body says it reverts it ("Reverts owner/repo#N"); a revert pushed
//                 straight to the default branch, with no PR, is not seen
//   review rounds the distinct commits its reviews before the merge were on
// A window is done once it has closed and was read in full; a PR is final once all are done. Each
// PR's reads are bounded to its own windows, so one whose windows were read in full is final even
// when another's were too long to read. Outcomes are cached in the repo's state, partial ones with
// their windows still open, and a later run reads only the windows not done. Runs at once merge
// their outcomes into the cache under its lock.
//
// The reads are batched GraphQL queries, CHUNK aliased reads in each: the PRs themselves; one search
// per open window, by a bounded `merged:` range sorted by creation; and the further pages of any
// list over a page (a PR's files or reviews, a search's results, a follow-up's files), at most
// MAX_PAGES pages of each. A list longer than that leaves its window open.
import { readFileSync } from 'node:fs';
import { withDirLock, writeJsonAtomic } from './dir-lock.mjs';
import { gh as ghRead } from './gate.mjs';
import { findRecords, RED_HOURS, revertedPr, WATCH_DAYS } from './post-merge.mjs';

const FOLLOW_UP_HOURS = 48;
const HOUR_MS = 3_600_000;
const CHUNK = 10;
const PAGE = 100;
const MAX_PAGES = 10;
const SUITES = 50;
// A follow-up fix: a PR whose title starts as a fix, hotfix or revert does.
const FIX_TITLE = /^(?:fix|hotfix|revert)\b/i;
const pageOf = (fields) => `pageInfo{hasNextPage endCursor} nodes{${fields}}`;
const REVIEWS = 'submittedAt commit{oid}';
const CORE = `number title mergedAt baseRefName mergeCommit{oid checkSuites(first:${SUITES}){totalCount nodes{conclusion branch{name} workflowRun{databaseId event createdAt url workflow{databaseId name}}}}} `
  + `files(first:${PAGE}){totalCount ${pageOf('path')}} reviews(first:${PAGE}){totalCount ${pageOf(REVIEWS)}}`;
const CANDIDATE = `... on PullRequest{number title body mergedAt baseRefName files(first:${PAGE}){totalCount ${pageOf('path')}}}`;

const readCache = (path) => {
  try { const d = JSON.parse(readFileSync(path, 'utf8')); return { prs: d?.prs ?? {}, missing: d?.missing ?? [] }; } catch { return { prs: {}, missing: [] }; }
};
const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
const after = (c) => (c ? `, after:${JSON.stringify(c)}` : '');

// A GraphQL query's answer. GitHub answers a query in which an alias names no PR (an issue's number,
// another repo's PR) with that alias null and a NOT_FOUND error, and gh then exits 1: that answer is
// used, its other aliases read as usual, when the repository answered and every error is a NOT_FOUND
// at one of the repository aliases asked (`prAliases`). Any other error throws, a repository not
// found (one the token cannot see) among them.
function ask(gh, query, prAliases) {
  try { return JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`])); }
  catch (e) {
    let body = null;
    try { body = JSON.parse(String(e?.stdout ?? '')); } catch { /* not an answer */ }
    const named = (x) => x?.type === 'NOT_FOUND' && Array.isArray(x.path) && x.path.length === 2 && x.path[0] === 'repository' && prAliases.has(x.path[1]);
    if (body?.data?.repository && Array.isArray(body.errors) && body.errors.length && body.errors.every(named)) return body;
    throw e;
  }
}

// Many paged reads at once, CHUNK aliased in each query, each list's further pages in the rounds
// after, up to MAX_PAGES. `items`: [{ id, top, sel(cursor) -> selection, conn(answer) -> { pageInfo,
// nodes } }], `top` for a selection outside the repository (a search). `first` holds an item's answer
// to its first page where one was already read (null: it could not be).
//   -> Map(id -> { nodes, complete, answer }), `answer` the first page's
function readPaged(items, { gh, repoSel, count, first = new Map() }) {
  const out = new Map();
  let open = [];
  const take = (x, a) => {
    const c = a ? x.conn(a) : null;
    const had = out.get(x.id) ?? { nodes: [], complete: false, answer: a ?? null };
    had.nodes.push(...(c?.nodes ?? []));
    had.complete = !!c && !c.pageInfo?.hasNextPage;
    out.set(x.id, had);
    if (c?.pageInfo?.hasNextPage) open.push({ ...x, cursor: c.pageInfo.endCursor });
  };
  for (const x of items) {
    if (first.has(x.id)) take(x, first.get(x.id));
    else open.push({ ...x, cursor: null });
  }
  for (let round = 0; round < MAX_PAGES && open.length; round += 1) {
    const now = open;
    open = [];
    for (let i = 0; i < now.length; i += CHUNK) {
      const part = now.slice(i, i + CHUNK);
      const inRepo = part.map((x, j) => (x.top ? '' : `a${j}: ${x.sel(x.cursor)}`)).join(' ').trim();
      const outside = part.map((x, j) => (x.top ? `a${j}: ${x.sel(x.cursor)}` : '')).join(' ').trim();
      const data = ask(gh, `query{${inRepo ? `${repoSel}{${inRepo}}` : ''} ${outside}}`, new Set(part.map((x, j) => (x.top ? null : `a${j}`)).filter(Boolean))).data ?? {};
      count();
      part.forEach((x, j) => take(x, x.top ? data[`a${j}`] : data.repository?.[`a${j}`]));
    }
  }
  for (const x of open) out.get(x.id).complete = false;
  return out;
}

// The outcomes of the PRs `refs` name in `repo` (owner/name), whose default branch is `base`: a ref is
// { number }, or { head, from, to } for a branch a session pushed between those times (epoch ms), the
// merged PR with that head whose lifetime (opened to merged) overlaps the session's. `cachePath` is the
// cache file (none: nothing cached); `offline` reads nothing.
//   -> { of(ref) -> outcome | null, reads, cached, note }
// An outcome: { number, title, merged_at, final, open: [window], reverts, red_main, post_merge,
// follow_ups: [n], review_rounds }; { number, merged_at: null, final: false } for a PR not merged;
// { number, off_default: true, final: false } for one merged into another branch than `base`; or
// { head, unmatched: true } for a head whose merged PRs none overlaps the session (null where it has none). A number that names no
// PR here is null, and is cached as such so it is not asked again.
export function prOutcomes(refs, { repo, base, cachePath = null, offline = false, now = Date.now(), gh = ghRead }) {
  const cache = cachePath ? readCache(cachePath) : { prs: {}, missing: [] };
  const recs = new Map(Object.entries(cache.prs).map(([n, o]) => [Number(n), o]));
  const missing = new Set(cache.missing.map(Number));
  // The PRs this run read from GitHub: only these are written back over the cache.
  const touched = new Set();
  const headKey = (r) => `${r.head}|${r.from}|${r.to}`;
  const chosen = new Map();
  const unmatched = new Set();
  const known = (r) => (r.number != null ? r.number : chosen.get(headKey(r)) ?? null);
  // Settled: final, merged elsewhere, or no PR here; none is read again.
  const settled = (n) => missing.has(n) || recs.get(n)?.final || recs.get(n)?.off_default;
  let reads = 0;
  const count = () => { reads += 1; };
  const notes = [];
  const headRefs = refs.filter((r) => r.number == null);
  let cached = refs.filter((r) => r.number != null && settled(r.number)).length;
  if (offline) {
    const want = refs.filter((r) => r.number == null || !settled(r.number)).length;
    if (want) notes.push(`${want} PR(s) not read from GitHub (--offline)`);
  } else if (!repo) {
    if (refs.length > cached) notes.push(`${refs.length - cached} PR(s) not read: no GitHub repo for this checkout`);
  } else if (refs.length) {
    const [owner, name] = repo.split('/');
    const repoSel = `repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)})`;
    try {
      // The merged PRs each pushed head branch has had, oldest first; a ref takes the one whose
      // lifetime overlaps its session, so a branch name used again maps each session to its own PR.
      const names = [...new Set(headRefs.map((r) => r.head))];
      const byHead = readPaged(names.map((h) => ({ id: h, sel: (c) => `pullRequests(headRefName:${JSON.stringify(h)}, states:MERGED, first:${PAGE}${after(c)}, orderBy:{field:CREATED_AT, direction:ASC}){${pageOf('number createdAt mergedAt')}}`, conn: (a) => a })), { gh, repoSel, count });
      for (const r of headRefs) {
        const p = (byHead.get(r.head)?.nodes ?? []).find((x) => Date.parse(x.createdAt) <= r.to && Date.parse(x.mergedAt) >= r.from);
        chosen.set(headKey(r), p?.number ?? null);
        if (!p && byHead.get(r.head)?.nodes?.length) unmatched.add(headKey(r));
        if (p && settled(p.number)) cached += 1;
      }
      const numbers = [...new Set(refs.map(known).filter((n) => n != null && !settled(n)))];

      // Each PR, its files and reviews paged, where its red-main and review window is not done.
      const core = numbers.filter((n) => !recs.get(n)?.core?.done);
      const fresh = readPaged(core.map((n) => ({ id: n, sel: (c) => `pullRequest(number:${n}){${c ? `files(first:${PAGE}${after(c)}){${pageOf('path')}}` : CORE}}`, conn: (a) => a.files })), { gh, repoSel, count });
      const reviews = readPaged(core.map((n) => ({ id: n, sel: (c) => `pullRequest(number:${n}){reviews(first:${PAGE}${after(c)}){${pageOf(REVIEWS)}}}`, conn: (a) => a.reviews })),
        { gh, repoSel, count, first: new Map(core.map((n) => [n, fresh.get(n)?.answer ?? null])) });
      for (const n of core) {
        if (fresh.has(n)) touched.add(n);
        const p = fresh.get(n)?.answer;
        // Asked and answered with nothing: no PR of this repo has that number.
        if (!p?.number) { if (fresh.has(n) && fresh.get(n).answer === null) missing.add(n); continue; }
        const merged = Date.parse(p.mergedAt);
        if (!Number.isFinite(merged)) { recs.set(n, { number: n, merged_at: null, final: false }); continue; }
        // Merged into another branch than the default: its merge commit is not the default branch's.
        if (base && p.baseRefName && p.baseRefName !== base) { recs.set(n, { number: n, merged_at: p.mergedAt, base: p.baseRefName, off_default: true }); continue; }
        const sha = p.mergeCommit?.oid ?? null;
        // Only the default branch's suites on that commit: the same commit pushed elsewhere is not its merge.
        const runs = (p.mergeCommit?.checkSuites?.nodes ?? []).filter((s) => s?.workflowRun && (!base || s.branch?.name === base)).map((s) => ({
          id: s.workflowRun.databaseId, name: s.workflowRun.workflow?.name ?? null, url: s.workflowRun.url, conclusion: String(s.conclusion ?? '').toLowerCase(),
          created_at: s.workflowRun.createdAt, event: s.workflowRun.event, workflow_id: s.workflowRun.workflow?.databaseId ?? null, sha }));
        const red = findRecords({ merges: [{ ticket: null, pr: n, merged_at: p.mergedAt, sha, landed_at: p.mergedAt }], commits: [], runs, at: new Date(now).toISOString() })
          .filter((r) => r.kind === 'red_main').length;
        const rv = reviews.get(n);
        const complete = fresh.get(n).complete && rv.complete && Number(p.mergeCommit?.checkSuites?.totalCount ?? 0) <= SUITES;
        recs.set(n, {
          ...(recs.get(n) ?? {}), number: n, title: p.title ?? null, merged_at: p.mergedAt,
          core: { done: complete && now - merged >= RED_HOURS * HOUR_MS, red_main: red, files: fresh.get(n).nodes.map((f) => f.path),
            review_rounds: new Set(rv.nodes.filter((r) => r?.commit?.oid && Date.parse(r.submittedAt) <= merged).map((r) => r.commit.oid)).size },
        });
      }

      // A search per open window of each merged PR, bounded to that window: follow-ups and reverts.
      const merged = numbers.map((n) => recs.get(n)).filter((o) => o?.merged_at && o.core && !o.off_default);
      const range = (o, ms) => `merged:${o.merged_at}..${new Date(Math.min(now, Date.parse(o.merged_at) + ms)).toISOString()}`;
      const searches = merged.flatMap((o) => [
        ...(o.follow?.done ? [] : [{ id: `f${o.number}`, o, kind: 'follow', q: `repo:${repo} is:pr is:merged ${range(o, FOLLOW_UP_HOURS * HOUR_MS)} sort:created-asc` }]),
        // Reverts by title (GitHub's revert button) or by body ("Reverts owner/repo#N"), into the default branch.
        ...(o.revert?.done ? [] : ['revert in:title', 'reverts in:body'].map((how, i) => ({ id: `r${i}-${o.number}`, o, kind: 'revert',
          q: `repo:${repo} is:pr is:merged ${base ? `base:${base} ` : ''}${how} ${range(o, WATCH_DAYS * 24 * HOUR_MS)} sort:created-asc` }))),
      ]);
      const found = readPaged(searches.map((x) => ({ id: x.id, top: true, sel: (c) => `search(query:${JSON.stringify(x.q)}, type:ISSUE, first:${PAGE}${after(c)}){${pageOf(CANDIDATE)}}`, conn: (a) => a })), { gh, repoSel, count });
      // A follow-up candidate with more files than a page has its others read, to find a shared one.
      const fixes = new Map();
      for (const x of searches.filter((y) => y.kind === 'follow')) {
        for (const c of found.get(x.id).nodes) if (c?.number && FIX_TITLE.test(c.title ?? '')) fixes.set(c.number, c);
      }
      const longer = [...fixes.values()].filter((c) => c.files?.pageInfo?.hasNextPage);
      const files = readPaged(longer.map((c) => ({ id: c.number, sel: (cur) => `pullRequest(number:${c.number}){files(first:${PAGE}${after(cur)}){${pageOf('path')}}}`, conn: (a) => a.files })),
        { gh, repoSel, count, first: new Map(longer.map((c) => [c.number, { files: c.files }])) });
      const filesOf = (c) => files.get(c.number) ?? { nodes: c.files?.nodes ?? [], complete: !!c.files };
      for (const x of searches.filter((y) => y.kind === 'follow')) {
        const o = x.o;
        const at = Date.parse(o.merged_at);
        const hits = found.get(x.id);
        const mine = new Set(o.core.files);
        const cands = hits.nodes.map((c) => fixes.get(c?.number)).filter((c) => c && c.number !== o.number && Date.parse(c.mergedAt) > at);
        o.follow = { done: hits.complete && cands.every((c) => filesOf(c).complete) && now - at >= FOLLOW_UP_HOURS * HOUR_MS,
          list: cands.filter((c) => filesOf(c).nodes.some((f) => mine.has(f.path))).map((c) => c.number) };
      }
      // A PR's reverts: the candidates of both its searches, merged into the default branch, that name it.
      for (const o of merged) touched.add(o.number);
      for (const o of merged.filter((m) => !m.revert?.done)) {
        const at = Date.parse(o.merged_at);
        const both = searches.filter((x) => x.kind === 'revert' && x.o === o).map((x) => found.get(x.id));
        const names = (c) => revertedPr(c.title) === o.number || c.title === `Revert "${o.title}"`
          || [...String(c.body ?? '').matchAll(/\bReverts\s+([\w.-]+\/[\w.-]+)?#(\d+)\b/gi)].some((m) => Number(m[2]) === o.number && (!m[1] || m[1].toLowerCase() === repo.toLowerCase()));
        const list = [...new Set(both.flatMap((h) => h.nodes).filter((c) => c?.number && c.number !== o.number && Date.parse(c.mergedAt) >= at
          && (!base || c.baseRefName === base) && names(c)).map((c) => c.number))];
        o.revert = { done: both.every((h) => h.complete) && now - at >= WATCH_DAYS * 24 * HOUR_MS, list };
      }
      const cut = [...fresh.values(), ...reviews.values(), ...found.values(), ...files.values()].filter((r) => r.answer && !r.complete).length;
      if (cut) notes.push(`${cut} list(s) longer than ${MAX_PAGES} pages, so their windows stay open`);
    } catch (e) {
      notes.push(`PRs not read from GitHub: ${firstLine(e)}`);
    }
  }
  // Final once every window is done.
  for (const o of recs.values()) {
    if (!o.merged_at || !o.core || o.off_default) continue;
    o.open = [!o.core.done && 'red main and reviews', !o.follow?.done && 'follow-ups', !o.revert?.done && 'reverts'].filter(Boolean);
    o.final = !o.open.length;
  }
  if (cachePath) {
    // Every merged PR's windows, done or not, so a later run reads only the open ones. Merged into the
    // cache as it is now, under its lock: another run's outcomes written since this one read it are
    // kept, and only the PRs this run read replace theirs (a number read and found leaves `missing`).
    try {
      withDirLock(`${cachePath}.lock`, () => {
        const cur = readCache(cachePath);
        const prs = { ...cur.prs };
        const miss = new Set(cur.missing.map(Number));
        for (const n of touched) {
          const o = recs.get(n);
          if (missing.has(n)) { miss.add(n); delete prs[n]; }
          else if (o?.merged_at && (o.core || o.off_default)) { miss.delete(n); prs[n] = o; }
          else miss.delete(n);
        }
        writeJsonAtomic(cachePath, { prs, missing: [...miss].sort((a, b) => a - b) });
      });
    } catch (e) { notes.push(`cache not written: ${firstLine(e)}`); }
  }
  const view = (o) => (o?.off_default ? { number: o.number, off_default: true, final: false } : o?.merged_at && o.core ? {
    number: o.number, title: o.title, merged_at: o.merged_at, final: o.final, open: o.open,
    reverts: o.revert?.list?.length ?? 0, red_main: o.core.red_main, post_merge: (o.revert?.list?.length ?? 0) + o.core.red_main,
    follow_ups: o.follow?.list ?? [], review_rounds: o.core.review_rounds,
  } : o ?? null);
  const of = (r) => {
    if (r.number == null && unmatched.has(headKey(r))) return { head: r.head, unmatched: true };
    const n = known(r);
    return n == null || missing.has(n) ? null : view(recs.get(n));
  };
  return { of, reads, cached, note: notes.join('; ') || null };
}
