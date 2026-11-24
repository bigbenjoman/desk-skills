// What became of merged PRs no queue ticket is behind, read from GitHub for the handoff report
// (handoff-report.mjs): reverts of each and red default-branch runs on its merge commit (post-merge.mjs
// findRecords, as the post-merge watch finds them for tickets), follow-up fix PRs merged within
// FOLLOW_UP_HOURS that touch any of its files, and its review rounds (the distinct commits its reviews
// before the merge were on).
//
// The reads are batched: one GraphQL query for up to CHUNK PRs at a time (by number, or by the head
// branch a session pushed), then one per page (of up to MAX_PAGES) of the default branch's commits and
// the repo's merged PRs over the span those merges cover. A PR's outcome is final once it merged at least FOLLOW_UP_HOURS ago and
// every read of it was complete; final outcomes are cached in the repo's state, so a later run reads
// GitHub only for PRs not final yet. A revert later than FOLLOW_UP_HOURS after the merge is not seen
// once cached.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gh as ghRead } from './gate.mjs';
import { findRecords } from './post-merge.mjs';

export const FOLLOW_UP_HOURS = 48;
const HOUR_MS = 3_600_000;
const CHUNK = 20;
const PAGE = 100;
// The most pages of the default branch's commits and of merged PRs one run reads over the span.
const MAX_PAGES = 10;
const SUITES = 50;
// A follow-up fix: a PR whose title starts as a fix, hotfix or revert does.
const FIX_TITLE = /^(?:fix|hotfix|revert)\b/i;
const FIELDS = `number title mergedAt headRefName mergeCommit{oid checkSuites(first:${SUITES}){totalCount nodes{conclusion workflowRun{databaseId event createdAt url workflow{databaseId name}}}}} files(first:${PAGE}){totalCount nodes{path}} reviews(last:100){nodes{submittedAt commit{oid}}}`;

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

// The outcomes of the PRs `refs` name ([{ number } | { head }]) in `repo` (owner/name), whose default
// branch is `base`. `cachePath` is the cache file (none: nothing cached); `offline` reads nothing.
//   -> { of(ref) -> outcome | null, reads, cached, note }
// An outcome: { number, title, merged_at, final, reverts, red_main, post_merge, follow_ups: [n],
// review_rounds }, or { number, merged_at: null, final: false } for a PR not merged.
export function prOutcomes(refs, { repo, base, cachePath = null, offline = false, now = Date.now(), gh = ghRead }) {
  const cache = cachePath ? readCache(cachePath) : { prs: {}, heads: {} };
  const got = new Map(Object.entries(cache.prs).map(([n, o]) => [Number(n), o]));
  const heads = new Map(Object.entries(cache.heads));
  const cachedN = (r) => (r.number != null ? got.has(r.number) : heads.has(r.head));
  const want = refs.filter((r) => !cachedN(r));
  const cached = refs.length - want.length;
  let reads = 0;
  let note = null;
  const fresh = [];
  if (want.length && offline) note = `${want.length} PR(s) not read from GitHub (--offline)`;
  else if (want.length && !repo) note = `${want.length} PR(s) not read: no GitHub repo for this checkout`;
  else if (want.length) {
    const [owner, name] = repo.split('/');
    const at = `repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)})`;
    try {
      for (let i = 0; i < want.length; i += CHUNK) {
        const part = want.slice(i, i + CHUNK);
        const q = part.map((r, j) => (r.number != null ? `p${j}: pullRequest(number:${Number(r.number)}){${FIELDS}}`
          : `h${j}: pullRequests(headRefName:${JSON.stringify(r.head)}, states:MERGED, first:1){nodes{${FIELDS}}}`)).join(' ');
        const data = JSON.parse(gh(['api', 'graphql', '-f', `query=query{${at}{${q}}}`])).data?.repository ?? {};
        reads += 1;
        part.forEach((r, j) => {
          const p = r.number != null ? data[`p${j}`] : data[`h${j}`]?.nodes?.[0];
          if (!p?.number) return;
          fresh.push(p);
          if (r.head) heads.set(r.head, p.number);
        });
      }
      const merged = fresh.filter((p) => Number.isFinite(Date.parse(p.mergedAt)));
      for (const p of fresh) if (!merged.includes(p)) got.set(p.number, { number: p.number, merged_at: null, final: false });
      if (merged.length) {
        const times = merged.map((p) => Date.parse(p.mergedAt));
        const since = new Date(Math.min(...times) - HOUR_MS).toISOString();
        const until = new Date(Math.min(now, Math.max(...times) + FOLLOW_UP_HOURS * HOUR_MS)).toISOString();
        const search = `repo:${repo} is:pr is:merged merged:${since}..${until}`;
        // The default branch's commits and the merged PRs over the span, a page of each per query.
        const after = (c) => (c ? `, after:${JSON.stringify(c)}` : '');
        const nodes = { history: [], search: [] };
        const next = { history: '', search: '' };
        for (let page = 0; page < MAX_PAGES && (next.history != null || next.search != null); page += 1) {
          const h = next.history == null ? '' : `${at}{object(expression:${JSON.stringify(base)}){... on Commit{history(since:${JSON.stringify(since)}, first:${PAGE}${after(next.history)}){pageInfo{hasNextPage endCursor} nodes{oid committedDate messageHeadline}}}}}`;
          const q = next.search == null ? '' : `search(query:${JSON.stringify(search)}, type:ISSUE, first:${PAGE}${after(next.search)}){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number title mergedAt files(first:${PAGE}){nodes{path}}}}}`;
          const span = JSON.parse(gh(['api', 'graphql', '-f', `query=query{${h} ${q}}`])).data ?? {};
          reads += 1;
          for (const [k, list] of [['history', span.repository?.object?.history], ['search', span.search]]) {
            if (next[k] == null) continue;
            if (!list) throw new Error(`no ${k === 'history' ? `${base} history` : 'merged-PR search'} in GitHub's answer`);
            nodes[k].push(...(list.nodes ?? []));
            next[k] = list.pageInfo?.hasNextPage ? list.pageInfo.endCursor : null;
          }
        }
        const others = nodes.search;
        const spanComplete = next.history == null && next.search == null;
        const commits = nodes.history.map((c) => ({ sha: c.oid, at: c.committedDate, subject: c.messageHeadline }));
        const merges = merged.map((p) => ({ ticket: null, pr: p.number, merged_at: p.mergedAt, sha: p.mergeCommit?.oid ?? null, landed_at: p.mergedAt }));
        const runs = merged.flatMap((p) => (p.mergeCommit?.checkSuites?.nodes ?? []).filter((s) => s?.workflowRun).map((s) => ({
          id: s.workflowRun.databaseId, name: s.workflowRun.workflow?.name ?? null, url: s.workflowRun.url, conclusion: String(s.conclusion ?? '').toLowerCase(),
          created_at: s.workflowRun.createdAt, event: s.workflowRun.event, workflow_id: s.workflowRun.workflow?.databaseId ?? null, sha: p.mergeCommit.oid })));
        const found = findRecords({ merges, commits, runs, at: new Date(now).toISOString() });
        for (const p of merged) {
          const mergedAt = Date.parse(p.mergedAt);
          const files = new Set((p.files?.nodes ?? []).map((f) => f.path));
          const followUps = others.filter((o) => o?.number && o.number !== p.number && FIX_TITLE.test(o.title ?? '')
            && Date.parse(o.mergedAt) > mergedAt && Date.parse(o.mergedAt) <= mergedAt + FOLLOW_UP_HOURS * HOUR_MS
            && (o.files?.nodes ?? []).some((f) => files.has(f.path))).map((o) => o.number);
          const reverts = found.filter((r) => r.pr === p.number && r.kind === 'revert').length;
          const red = found.filter((r) => r.pr === p.number && r.kind === 'red_main').length;
          const complete = spanComplete && Number(p.files?.totalCount ?? 0) <= PAGE && Number(p.mergeCommit?.checkSuites?.totalCount ?? 0) <= SUITES;
          got.set(p.number, {
            number: p.number, title: p.title ?? null, merged_at: p.mergedAt, final: complete && now - mergedAt >= FOLLOW_UP_HOURS * HOUR_MS,
            reverts, red_main: red, post_merge: reverts + red, follow_ups: followUps,
            review_rounds: new Set((p.reviews?.nodes ?? []).filter((r) => r?.commit?.oid && Date.parse(r.submittedAt) <= mergedAt).map((r) => r.commit.oid)).size,
          });
        }
        if (!spanComplete) note = `the default branch's commits or merged PRs over the span were more than ${MAX_PAGES} pages, so those PRs are not final`;
      }
    } catch (e) {
      note = `PRs not read from GitHub: ${firstLine(e)}`;
    }
  }
  if (cachePath) {
    const keep = (o) => o?.final;
    const out = { prs: Object.fromEntries([...got].filter(([, o]) => keep(o))), heads: Object.fromEntries([...heads].filter(([, n]) => keep(got.get(n)))) };
    try { writeCache(cachePath, out); } catch (e) { note = [note, `cache not written: ${firstLine(e)}`].filter(Boolean).join('; '); }
  }
  const of = (r) => got.get(r.number ?? heads.get(r.head)) ?? null;
  return { of, reads, cached, note };
}
