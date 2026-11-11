#!/usr/bin/env node
// A PR's review threads as the merge driver weighs them under §3 merge-feedback-first, and which of
// them a clean desk-review verdict has settled. merge-driver.sh pipes its GraphQL read (THREADS_QUERY)
// in, resolves the threads `resolve` names, and holds the PR on what is `left`:
//
//   review-threads.mjs query      the GraphQL query the payload answers
//   review-threads.mjs read --handle <§1 GitHub handle> --clean "<§4 Clean review verdict>" < payload.json
//   review-threads.mjs verdict --handle <handle> --clean "<row>" --base <base branch> --pr <n> < payload.json
//   review-threads.mjs approved --handle <handle> --clean "<row>" < payload.json   (approvedAt)
//
// prints one JSON line: { decision, head, verdict, resolve: [thread], left: [thread] }, where a thread is
// { id, path, line, first, text }: `first` is the first line of its opening comment, `text` the two as
// one line names the thread (threadLine).
//
// A thread is settled when the latest desk-review verdict the handle posted is clean at the PR's head
// and the thread was opened by an earlier desk-review of the handle's: that verdict counts every P0 and
// P1 outstanding at the head, so a finding it no longer counts was fixed, outdated or not inline at all.
// A thread anyone else opened, or the handle opened outside a desk-review, is never settled here.
//
// pass.mjs imports readThreads and THREADS_QUERY: a ready PR's threads left, or a review at its head
// that is not clean (`review`), go to a fix worker (fix-tries.mjs feedbackFix, reviewFix).
//
// `verdict` prints what the merge driver holds a merge on where §4 Local review command is set
// (readVerdict). `read`'s `verdict` says only what settles threads: it is null for a verdict carried
// from an older head and for a review under a plain-text row, and goes unread under §3
// merge-feedback-first no.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { latestReview, verdictAt, verdictAtHead, reviewCarries, carryComment, markerClean } from './undraft.mjs';
import { pairs, leverOn } from './desk-env.mjs';
import { LOCAL_MARKERS } from '../templates/scripts/desk/review-gate.mjs';

export const THREADS_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
  headRefOid reviewDecision
  reviews(last:100){nodes{id author{login} body state submittedAt commit{oid}}}
  reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine
    comments(first:1){nodes{author{login} body pullRequestReview{id}}}}}}}}`;

// Whether a §4 row is set to something: not empty, a TODO or none.
const rowSet = (row) => { const s = String(row ?? '').trim(); return !!s && !/^(todo|none)\b/i.test(s); };
const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

// payload: the GraphQL response. handle: §1 GitHub handle. clean: the §4 Clean review verdict row; a
// plain-text row is read against every count the verdict's marker writes, and an unset one settles nothing.
// `review` is the handle's latest desk-review when its verdict is at the head and not clean
// ({ id, verdict, body }), else null.
export function readThreads(payload, { handle, clean }) {
  const pr = payload?.data?.repository?.pullRequest;
  if (!pr) return null;
  const reviews = pr.reviews?.nodes ?? [];
  const row = String(clean ?? '').trim();
  const latest = handle && rowSet(row) ? latestReview(reviews, handle) : null;
  const want = Object.keys(pairs(row)).length ? row : markerClean(latest?.verdict);
  const atHead = latest ? verdictAt(latest.verdict, pr.headRefOid, want) : null;
  const settles = !!atHead?.clean;
  const review = atHead?.settle ? { id: latest.id, verdict: latest.verdict, body: latest.body } : null;
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
      && LOCAL_MARKERS.includes(firstLine(opener?.body)) && i < at;
    const th = { id: t.id, path: t.path ?? '', line: t.line ?? t.originalLine ?? null, first: firstLine(c?.body) };
    (ours ? resolve : left).push({ ...th, text: threadLine(th) });
  }
  return { decision: pr.reviewDecision || 'NONE', head: pr.headRefOid ?? '', verdict: settles ? latest.verdict.sha : null, review, resolve, left };
}

// Whether §4 Local review command names a review, so that a merge waits on its clean verdict.
export const localReviewSet = rowSet;

// Whether a clean review stands at the PR's head, for a merge: { head, clean, carried, range, said,
// why, settle, person }. A clean verdict for an older head counts where it still holds at the head
// (carry(sha, body), as verdictCarries or restsOnCarries says; `range` is the base range the latter
// checked, and `said` the comment that tells the PR). Not clean, `settle` is a review at the head that says so, and
// `person` a row only the person can set; with neither, a review worker has what it needs: there is
// no verdict, a stale one, or one the gate cannot read, and `targeted` what that review need read only
// (scope(sha, body), as reviewScope says), when a clean review for an older head narrows it.
export function readVerdict(payload, { handle, clean, carry, scope }) {
  const pr = payload?.data?.repository?.pullRequest;
  if (!pr) return null;
  const head = pr.headRefOid ?? '';
  const row = String(clean ?? '').trim();
  if (!rowSet(row)) return { head, clean: false, carried: null, why: '§4 Clean review verdict is not set, so no review can be read as clean', settle: false, person: true };
  const { v, carried, range, targeted } = verdictAtHead(pr.reviews?.nodes ?? [], handle, head, row, carry, scope);
  if (v.clean) return { head, clean: true, carried, range, said: range ? carryComment(carried, head, range) : null, why: null, settle: false, person: false };
  // An unclean verdict carried from an older head is not at this one: reviewing the head posts it there.
  return { head, clean: false, carried: null, why: v.why, settle: !!v.settle && !carried, person: false, ...(targeted ? { targeted } : {}) };
}

// When the PR last had an approval at its head: the newest of an APPROVED review of the head and the
// handle's clean verdict at it (never one carried from an older head). { head, at, by }, `at` null when
// there is neither, for the driver to weigh against when a red approval check's run started.
export function approvedAt(payload, { handle, clean }) {
  const pr = payload?.data?.repository?.pullRequest;
  if (!pr) return null;
  const head = pr.headRefOid ?? '';
  const reviews = pr.reviews?.nodes ?? [];
  const hits = reviews.filter((r) => r.state === 'APPROVED' && head && r.commit?.oid === head && r.submittedAt)
    .map((r) => ({ at: r.submittedAt, by: `an APPROVED review by ${r.author?.login ?? 'someone'}` }));
  if (rowSet(clean)) {
    const { plain, v, review } = verdictAtHead(reviews, handle, head, String(clean).trim());
    // Under a plain-text row the clean review is the handle's latest with a body, marker or not
    // (plainVerdictAt); under a counts row it is the latest carrying a verdict marker.
    const own = (x) => !!handle && String(x.author?.login ?? '').toLowerCase() === handle.toLowerCase() && !!String(x.body ?? '').trim();
    const r = !v.clean ? null : plain ? reviews.filter(own).pop() : reviews.find((x) => x.id === review?.id);
    if (r?.submittedAt) hits.push({ at: r.submittedAt, by: 'a clean review verdict' });
  }
  const best = hits.sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];
  return { head, at: best?.at ?? null, by: best?.by ?? null };
}

// A thread as one line names it: `path:line "first line"`, cut to a readable length.
function threadLine(t, max = 100) {
  const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ''}` : 'a PR-level thread';
  const first = t.first.length > max ? `${t.first.slice(0, max - 1)}…` : t.first;
  return first ? `${where} "${first}"` : where;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
const a = isMain ? process.argv.slice(2) : [null];
const at = (flag) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
if (!isMain) { /* imported */ } else if (a[0] === 'query') {
  console.log(THREADS_QUERY);
} else if (a[0] === 'read') {
  let r = null;
  try { r = readThreads(JSON.parse(readFileSync(0, 'utf8')), { handle: at('--handle'), clean: at('--clean') }); } catch { /* unreadable: null */ }
  if (!r) { console.error('review-threads: no pull request in the payload'); process.exit(1); }
  console.log(JSON.stringify(r));
} else if (a[0] === 'verdict') {
  const base = at('--base');
  const git = (args) => { try { return { ok: true, out: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }; } catch { return { ok: false, out: '' }; } };
  let r = null;
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    const head = payload?.data?.repository?.pullRequest?.headRefOid;
    // Fetched only for a verdict at an older head, as the pass does before it asks the same thing, and
    // carried as the pass carries it: under the review-reuse lever, only while what it rests on holds.
    const reuse = leverOn('review-reuse');
    const carry = (sha, body) => git(['fetch', '-q', 'origin', base, `pull/${at('--pr')}/head`]).ok && reviewCarries({ reuse, from: sha, head, base: `origin/${base}`, body, git });
    r = readVerdict(payload, { handle: at('--handle'), clean: at('--clean'), carry });
  } catch { /* unreadable: null */ }
  if (!r) { console.error('review-threads: no pull request in the payload'); process.exit(1); }
  console.log(JSON.stringify(r));
} else if (a[0] === 'approved') {
  let r = null;
  try { r = approvedAt(JSON.parse(readFileSync(0, 'utf8')), { handle: at('--handle'), clean: at('--clean') }); } catch { /* unreadable: null */ }
  if (!r) { console.error('review-threads: no pull request in the payload'); process.exit(1); }
  console.log(JSON.stringify(r));
} else {
  console.error('usage: review-threads.mjs query | read --handle <login> --clean "<row>" < payload.json | verdict --handle <login> --clean "<row>" --base <branch> --pr <n> < payload.json | approved --handle <login> --clean "<row>" < payload.json'); process.exit(2);
}
