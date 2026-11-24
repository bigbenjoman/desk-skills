// What became of merged PRs no queue ticket is behind, read from GitHub for the handoff report
// (handoff-report.mjs). Each PR is measured on its own windows from its merge:
//   red main      a default-branch push run on its merge commit failing within RED_HOURS
//                 (post-merge.mjs findRecords, on the check suites of that commit)
//   follow-ups    merged PRs titled as a fix, hotfix or revert within FOLLOW_UP_HOURS that touch any
//                 of its files
//   reverts       merged PRs titled Revert within post-merge's WATCH_DAYS whose title reverts its
//                 title, or whose body says it reverts it ("Reverts owner/repo#N"); a revert pushed
//                 straight to the default branch, with no PR, is not seen
//   review rounds the distinct commits its reviews before the merge were on
// A window is done once it has closed and was read in full; a PR is final once all are done. Each
// PR's reads are bounded to its own windows, so one whose windows were read in full is final even
// when another's were too long to read. Outcomes are cached in the repo's state, partial ones with
// their windows still open, and a later run reads only the windows not done.
//
// The reads are batched GraphQL queries, CHUNK aliased reads in each: the PRs themselves; one search
// per open window, by a bounded `merged:` range sorted by creation; and the further pages of any
// list over a page (a PR's files or reviews, a search's results, a follow-up's files), at most
// MAX_PAGES pages of each. A list longer than that leaves its window open.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gh as ghRead } from './gate.mjs';
import { findRecords, RED_HOURS, revertedPr, WATCH_DAYS } from './post-merge.mjs';

export const FOLLOW_UP_HOURS = 48;
const HOUR_MS = 3_600_000;
const CHUNK = 10;
const PAGE = 100;
const MAX_PAGES = 10;
const SUITES = 50;
// A follow-up fix: a PR whose title starts as a fix, hotfix or revert does.
const FIX_TITLE = /^(?:fix|hotfix|revert)\b/i;
const pageOf = (fields) => `pageInfo{hasNextPage endCursor} nodes{${fields}}`;
const REVIEWS = 'submittedAt commit{oid}';
const CORE = `number title mergedAt mergeCommit{oid checkSuites(first:${SUITES}){totalCount nodes{conclusion workflowRun{databaseId event createdAt url workflow{databaseId name}}}}} `
  + `files(first:${PAGE}){totalCount ${pageOf('path')}} reviews(first:${PAGE}){totalCount ${pageOf(REVIEWS)}}`;
const CANDIDATE = `... on PullRequest{number title body mergedAt files(first:${PAGE}){totalCount ${pageOf('path')}}}`;

const readCache = (path) => {
  try { const d = JSON.parse(readFileSync(path, 'utf8')); return { prs: d?.prs ?? {}, heads: d?.heads ?? {} }; } catch { return { prs: {}, heads: {} }; }
};
function writeCache(path, cache) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
  renameSync(tmp, path);
}
const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
const after = (c) => (c ? `, after:${JSON.stringify(c)}` : '');

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
      const data = JSON.parse(gh(['api', 'graphql', '-f', `query=query{${inRepo ? `${repoSel}{${inRepo}}` : ''} ${outside}}`])).data ?? {};
      count();
      part.forEach((x, j) => take(x, x.top ? data[`a${j}`] : data.repository?.[`a${j}`]));
    }
  }
  for (const x of open) out.get(x.id).complete = false;
  return out;
}

// The outcomes of the PRs `refs` name ([{ number } | { head }]) in `repo` (owner/name). `cachePath` is
// the cache file (none: nothing cached); `offline` reads nothing.
//   -> { of(ref) -> outcome | null, reads, cached, note }
// An outcome: { number, title, merged_at, final, open: [window], reverts, red_main, post_merge,
// follow_ups: [n], review_rounds }, or { number, merged_at: null, final: false } for a PR not merged.
export function prOutcomes(refs, { repo, cachePath = null, offline = false, now = Date.now(), gh = ghRead }) {
  const cache = cachePath ? readCache(cachePath) : { prs: {}, heads: {} };
  const recs = new Map(Object.entries(cache.prs).map(([n, o]) => [Number(n), o]));
  const heads = new Map(Object.entries(cache.heads));
  const known = (r) => (r.number != null ? r.number : heads.get(r.head));
  const want = refs.filter((r) => !recs.get(known(r))?.final);
  const cached = refs.length - want.length;
  let reads = 0;
  const count = () => { reads += 1; };
  const notes = [];
  if (want.length && offline) notes.push(`${want.length} PR(s) not read from GitHub (--offline)`);
  else if (want.length && !repo) notes.push(`${want.length} PR(s) not read: no GitHub repo for this checkout`);
  else if (want.length) {
    const [owner, name] = repo.split('/');
    const repoSel = `repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)})`;
    try {
      // The head branches a session pushed, as the merged PRs they head.
      const unknownHeads = [...new Set(want.filter((r) => r.number == null && !heads.has(r.head)).map((r) => r.head))];
      const byHead = readPaged(unknownHeads.map((h) => ({ id: h, sel: () => `pullRequests(headRefName:${JSON.stringify(h)}, states:MERGED, first:1){nodes{number}}`, conn: (a) => a })), { gh, repoSel, count });
      for (const [h, r] of byHead) if (r.nodes[0]?.number) heads.set(h, r.nodes[0].number);
      const numbers = [...new Set(want.map(known).filter((n) => n != null))];

      // Each PR, its files and reviews paged, where its red-main and review window is not done.
      const core = numbers.filter((n) => !recs.get(n)?.core?.done);
      const fresh = readPaged(core.map((n) => ({ id: n, sel: (c) => `pullRequest(number:${n}){${c ? `files(first:${PAGE}${after(c)}){${pageOf('path')}}` : CORE}}`, conn: (a) => a.files })), { gh, repoSel, count });
      const reviews = readPaged(core.map((n) => ({ id: n, sel: (c) => `pullRequest(number:${n}){reviews(first:${PAGE}${after(c)}){${pageOf(REVIEWS)}}}`, conn: (a) => a.reviews })),
        { gh, repoSel, count, first: new Map(core.map((n) => [n, fresh.get(n)?.answer ?? null])) });
      for (const n of core) {
        const p = fresh.get(n)?.answer;
        if (!p?.number) continue;
        const merged = Date.parse(p.mergedAt);
        if (!Number.isFinite(merged)) { recs.set(n, { number: n, merged_at: null, final: false }); continue; }
        const sha = p.mergeCommit?.oid ?? null;
        const runs = (p.mergeCommit?.checkSuites?.nodes ?? []).filter((s) => s?.workflowRun).map((s) => ({
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
      const merged = numbers.map((n) => recs.get(n)).filter((o) => o?.merged_at && o.core);
      const range = (o, ms) => `merged:${o.merged_at}..${new Date(Math.min(now, Date.parse(o.merged_at) + ms)).toISOString()}`;
      const searches = merged.flatMap((o) => [
        ...(o.follow?.done ? [] : [{ id: `f${o.number}`, o, kind: 'follow', q: `repo:${repo} is:pr is:merged ${range(o, FOLLOW_UP_HOURS * HOUR_MS)} sort:created-asc` }]),
        ...(o.revert?.done ? [] : [{ id: `r${o.number}`, o, kind: 'revert', q: `repo:${repo} is:pr is:merged revert in:title ${range(o, WATCH_DAYS * 24 * HOUR_MS)} sort:created-asc` }]),
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
      for (const x of searches) {
        const o = x.o;
        const at = Date.parse(o.merged_at);
        const hits = found.get(x.id);
        if (x.kind === 'follow') {
          const mine = new Set(o.core.files);
          const cands = hits.nodes.map((c) => fixes.get(c?.number)).filter((c) => c && c.number !== o.number && Date.parse(c.mergedAt) > at);
          o.follow = { done: hits.complete && cands.every((c) => filesOf(c).complete) && now - at >= FOLLOW_UP_HOURS * HOUR_MS,
            list: cands.filter((c) => filesOf(c).nodes.some((f) => mine.has(f.path))).map((c) => c.number) };
        } else {
          const names = (c) => revertedPr(c.title) === o.number || c.title === `Revert "${o.title}"`
            || [...String(c.body ?? '').matchAll(/\bReverts\s+([\w.-]+\/[\w.-]+)?#(\d+)\b/gi)].some((m) => Number(m[2]) === o.number && (!m[1] || m[1].toLowerCase() === repo.toLowerCase()));
          o.revert = { done: hits.complete && now - at >= WATCH_DAYS * 24 * HOUR_MS,
            list: hits.nodes.filter((c) => c?.number && c.number !== o.number && Date.parse(c.mergedAt) >= at && names(c)).map((c) => c.number) };
        }
      }
      const cut = [...fresh.values(), ...reviews.values(), ...found.values(), ...files.values()].filter((r) => r.answer && !r.complete).length;
      if (cut) notes.push(`${cut} list(s) longer than ${MAX_PAGES} pages, so their windows stay open`);
    } catch (e) {
      notes.push(`PRs not read from GitHub: ${firstLine(e)}`);
    }
  }
  // Final once every window is done.
  for (const o of recs.values()) {
    if (!o.merged_at || !o.core) continue;
    o.open = [!o.core.done && 'red main and reviews', !o.follow?.done && 'follow-ups', !o.revert?.done && 'reverts'].filter(Boolean);
    o.final = !o.open.length;
  }
  if (cachePath) {
    // Every merged PR's windows, done or not: a later run reads only the open ones.
    const keep = [...recs].filter(([, o]) => o.merged_at && o.core);
    const out = { prs: Object.fromEntries(keep), heads: Object.fromEntries([...heads].filter(([, n]) => recs.get(n)?.core)) };
    try { writeCache(cachePath, out); } catch (e) { notes.push(`cache not written: ${firstLine(e)}`); }
  }
  const view = (o) => (o?.merged_at && o.core ? {
    number: o.number, title: o.title, merged_at: o.merged_at, final: o.final, open: o.open,
    reverts: o.revert?.list?.length ?? 0, red_main: o.core.red_main, post_merge: (o.revert?.list?.length ?? 0) + o.core.red_main,
    follow_ups: o.follow?.list ?? [], review_rounds: o.core.review_rounds,
  } : o ?? null);
  return { of: (r) => view(recs.get(known(r))), reads, cached, note: notes.join('; ') || null };
}
