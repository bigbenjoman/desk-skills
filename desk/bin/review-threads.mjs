#!/usr/bin/env node
// A PR's review threads as the merge driver weighs them under §3 merge-feedback-first, and which of
// them a clean desk-review verdict has settled. merge-driver.sh pipes its GraphQL read (THREADS_QUERY)
// in, resolves the threads `resolve` names, and holds the PR on what is `left`:
//
//   review-threads.mjs query      the GraphQL query the payload answers
//   review-threads.mjs read --handle <§1 GitHub handle> --clean "<§4 Clean review verdict>" < payload.json
//
// prints one JSON line: { decision, head, verdict, resolve: [thread], left: [thread] }, where a thread is
// { id, path, line, first, text }: `first` is the first line of its opening comment, `text` the two as
// one line names the thread (threadLine).
//
// A thread is settled when the latest desk-review verdict the handle posted is clean at the PR's head
// and the thread was opened by an earlier desk-review of the handle's: that verdict counts every P0 and
// P1 outstanding at the head, so a finding it no longer counts was fixed, outdated or not inline at all.
// A thread anyone else opened, or the handle opened outside a desk-review, is never settled here.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { latestReview, verdictAt, pairs, DESK_REVIEW_CLEAN } from './undraft.mjs';
import { LOCAL_MARKER } from '../templates/scripts/desk/review-gate.mjs';

export const THREADS_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
  headRefOid reviewDecision
  reviews(last:100){nodes{id author{login} body commit{oid}}}
  reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine
    comments(first:1){nodes{author{login} body pullRequestReview{id}}}}}}}}`;

const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

// payload: the GraphQL response. handle: §1 GitHub handle. clean: the §4 Clean review verdict row; a
// plain-text row is read against desk-review's own counts, and an unset one settles nothing.
export function readThreads(payload, { handle, clean }) {
  const pr = payload?.data?.repository?.pullRequest;
  if (!pr) return null;
  const reviews = pr.reviews?.nodes ?? [];
  const row = String(clean ?? '').trim();
  const want = !row || /^(todo|none)\b/i.test(row) ? null : Object.keys(pairs(row)).length ? row : DESK_REVIEW_CLEAN;
  const latest = handle && want ? latestReview(reviews, handle) : null;
  const settles = !!latest && verdictAt(latest.verdict, pr.headRefOid, want).clean;
  const index = new Map(reviews.map((r, i) => [r.id, i]));
  const at = latest ? index.get(latest.id) ?? -1 : -1;
  const own = (login) => !!handle && String(login ?? '').toLowerCase() === handle.toLowerCase();
  const resolve = [], left = [];
  for (const t of pr.reviewThreads?.nodes ?? []) {
    if (t.isResolved) continue;
    const c = t.comments?.nodes?.[0];
    const i = index.get(c?.pullRequestReview?.id);
    const opener = i == null ? null : reviews[i];
    const ours = settles && own(c?.author?.login) && own(opener?.author?.login)
      && firstLine(opener?.body) === LOCAL_MARKER && i < at;
    const th = { id: t.id, path: t.path ?? '', line: t.line ?? t.originalLine ?? null, first: firstLine(c?.body) };
    (ours ? resolve : left).push({ ...th, text: threadLine(th) });
  }
  return { decision: pr.reviewDecision || 'NONE', head: pr.headRefOid ?? '', verdict: settles ? latest.verdict.sha : null, resolve, left };
}

// A thread as one line names it: `path:line "first line"`, cut to a readable length.
export function threadLine(t, max = 100) {
  const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ''}` : 'a PR-level thread';
  const first = t.first.length > max ? `${t.first.slice(0, max - 1)}…` : t.first;
  return first ? `${where} "${first}"` : where;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const a = process.argv.slice(2);
  const at = (flag) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
  if (a[0] === 'query') {
    console.log(THREADS_QUERY);
  } else if (a[0] === 'read') {
    let r = null;
    try { r = readThreads(JSON.parse(readFileSync(0, 'utf8')), { handle: at('--handle'), clean: at('--clean') }); } catch { /* unreadable: null */ }
    if (!r) { console.error('review-threads: no pull request in the payload'); process.exit(1); }
    console.log(JSON.stringify(r));
  } else {
    console.error('usage: review-threads.mjs query | read --handle <login> --clean "<row>" < payload.json'); process.exit(2);
  }
}
