// The "PR status" step of a pass, as a decision: each done ticket's PR is read once a pass, its
// state, draft, review decision, mergeable state and checks in one call, and kept on the ticket as
// pr_status for desk-q, which makes no network call of its own. A merge is recorded here whoever made
// it, the merge driver or anyone else, and the lists the reopen, undraft and fix-try steps work from
// are built from what was read.
//
// The decision is a generator (pass/run-phase.mjs runSteps): the read of a PR, and a write whose
// result it goes on to use, are actions it yields, and what the action's handler returns is what the
// yield gives back. So each ticket's reads and writes run in the order they did, while the decision
// itself starts no process and writes nothing. The handlers that do I/O are pass.mjs's.
//
// The snapshot (pass/shared.mjs phaseSnapshot, with `tickets` the queue's tickets as the pass read them
// for this step: the same objects the steps after it read) adds:
//   dry      a dry run: nothing is written but pr_status
//   passAt    the pass's start time, ISO
//   archived  the queue's archived tickets by key (queue-store.mjs archivedOf), never written
//   repo      §0 GitHub repo, for a PR's url where its read gave none
//   logins    desk's accounts, as E.verdictLogins gives them (null when unset)
//   previews  preview-build leases are in use: §4 Vercel names a team and the kind is not off
//   ledger    the ledger lever is on
//   mergeLog  the merge log's events, each with its line (merge-log.mjs readLogLines), or null unreadable
//   folded    the last merge-log line the ticket ledger folded (-1 for none), by the key of each ticket
//             the ledger has in this batch, or null when the ledger was unread or has not named the batch
//
// Actions ("->" is what the handler returns):
//   fix-finished {key, at, fixTries}   the ticket's fix try is over: fix.finished=at, and, for a
//                                      conflict try, fix_tries as given (else fixTries is null)
//   read-pr {key, pr, was}             -> PR #pr's status (with its history, triggers and errors kept
//                                      from `was`, the ticket's last pr_status), or null unread. GitHub
//                                      is asked once a pass per PR; a second ticket's read reuses it
//   follow-on {key, fields, expect, pr, url, by}   as below, and only while the ticket is done on PR
//                                      #pr of url's repo (onThisPr) and, with `by` ({key, archived, url})
//                                      not archived, while by.key still holds them (tookPostMerge)
//   pr-status {key, status}            keep status on the ticket as pr_status
//   set {key, fields}                  -> queue.mjs set's result
//   merged {key, at, merge}            -> queue.mjs merged's record, or '' (at: GitHub's merge time, or null).
//                                      With the ledger lever on, merge is {by, pr, head_sha, base}, who
//                                      merged which PR at which head onto which base, recorded on the
//                                      ticket as its merge (queue.mjs merged --by --pr --head-sha --base)
//   merge-log {}                       -> { events }: the merge log read now, as mergeLog is (with the
//                                      lever on, before a merge is recorded). No answer keeps mergeLog
//   automerge {key, events}            append these automerge_armed and automerge_disarmed events, each
//                                      folding one merge-log line, to the ticket ledger (a live or an
//                                      archived ticket's)
//   follow-on {key, fields, expect}    -> queue.mjs set's result for fields, written only while the
//                                      ticket's followState is one of `expect` ({ ok, skipped } when not)
//   out {line}                         a report line
//   fetch-origin {}                    git fetch origin in the repo root
//   prune-builds {open}                remove the check-build checkouts of every PR not in `open`
//   park {key, question}               park the ticket: its PR is not its own (shared.mjs notOwnPr)
//   free-previews {done}               -> { freed: [pr] }, { unreadable: why } or { failed: why }:
//                                      release the preview-build unit of each { pr, at, reason } in
//                                      done, unless taken or renewed after `at`, when its preview finished
//   lists {drafts, undrafted, reopens, prStates, merges, unread, unknownMergers}   what the steps after
//                                      this one work from: each list of { t, s } (reopens with `owed`), each
//                                      PR's state by number, the merge lines, the PRs whose read failed
//                                      (`unread`), and how many merges were recorded with the merge log
//                                      unread, so with their merger unknown
import { FOLLOW_ON_MAX, followOnPending, postMergeOwed } from '../harvest.mjs';
import { fromReview, reviewStep } from '../undraft.mjs';
import { LINK_STEP, notOwnPr, foreignQuestion } from './shared.mjs';
import { owesReopen } from '../queue-store.mjs';
import { FAILED, PREVIEW_CHECK } from '../gate.mjs';
import { latest, CLAIM_MS } from '../merge-log.mjs';
import { invalid } from '../ticket-ledger.mjs';

// Who a merge no merge-log line names was made by: GitHub, under auto-merge, as no desk process made it.
const GITHUB_AUTOMERGE = 'github-automerge';
const sameRepo = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
// Whether ticket t's PR #n is this repo's: a status kept from needs-you's elsewhereDone names another
// repo's PR of the same number, whose merge-log lines are not this ticket's.
const ownRepoPr = (s, t, n) => !(t.pr_status?.pr === n && t.pr_status.url && s.repo)
  || repoOfPr(t.pr_status.url) === repoOfPr(`https://github.com/${s.repo}/pull/${n}`);

// Who merged ticket t's PR #n, as status st read it merged, from the merge log `log` as read when the
// merge is recorded: the PR's merged line, else a desk merger's claim on it made under CLAIM_MS before
// the merge (it merged and has not recorded it yet: GitHub's auto-merge never claims), else GitHub under
// auto-merge. A claim after the merge merged nothing. The head is the one GitHub merged, else the line's.
// null with the lever off.
function mergerOf(s, n, st, log) {
  if (!s.ledger) return null;
  const mine = (log ?? []).filter((e) => sameRepo(e.repo, s.repo) && String(e.pr) === String(n));
  const line = latest(mine, { repo: s.repo, pr: n });
  const last = mine.at(-1);
  const before = Date.parse(st.merged_at ?? s.passAt) - Date.parse(last?.at);
  const m = line?.event === 'merged' ? line : last?.event === 'claim' && before >= 0 && before < CLAIM_MS ? last : null;
  return { by: m?.by ?? GITHUB_AUTOMERGE, pr: Number(n), head_sha: st.head ?? m?.sha ?? null, base: st.base ?? null };
}

// The merge-log lines on ticket t's PR #n that arm or disarm auto-merge and that the ledger has not yet
// folded, as ledger events, oldest first. None with the lever off, the merge log or ledger unread, or a
// ticket the ledger does not have in this batch.
function armEvents(s, t, n) {
  if (!s.ledger || !s.mergeLog || !s.folded || !Object.hasOwn(s.folded, t.key) || !ownRepoPr(s, t, n)) return [];
  const after = s.folded[t.key];
  return s.mergeLog
    .filter((e) => Number.isInteger(e.line) && e.line > after && sameRepo(e.repo, s.repo) && String(e.pr) === String(n) && ['armed', 'disarmed'].includes(e.event))
    .map((e) => (e.event === 'armed'
      ? { type: 'automerge_armed', data: { by: e.by, pr: Number(n), head_sha: e.sha, line: e.line }, at: e.at }
      : { type: 'automerge_disarmed', data: { by: e.by, pr: Number(n), line: e.line }, at: e.at }))
    .filter((e) => !invalid({ ...e, batch: 'batch', key: t.key }));
}

const IS_PREVIEW = new RegExp(PREVIEW_CHECK, 'i');
// A PR's preview once every preview check on its head has finished: { failed: [names], at }, `at` the
// earliest of their finish times (a check run's completion, a status context's last state). null while
// one runs, none has reported, or one carries no time (its unit then lapses at its TTL). A unit taken
// after `at` is for a build these checks predate, as a rerun's, so freeing waits for that build's own.
function previewFinished(checks) {
  const p = (checks ?? []).filter((c) => IS_PREVIEW.test(c?.name ?? ''));
  if (!p.length || p.some((c) => c.status !== 'completed')) return null;
  const times = p.map((c) => Date.parse(c.completed ?? c.started ?? ''));
  if (times.some(Number.isNaN)) return null;
  return { failed: p.filter((c) => FAILED.has(c.conclusion)).map((c) => c.name), at: new Date(Math.min(...times)).toISOString() };
}

// A PR recorded merged or closed is not read again, unless it merged and the ticket has no merged_at yet.
// A merged PR whose kept status names post-merge criteria not yet made follow-on steps is read on
// (harvest.mjs postMergeOwed).
const PR_FINAL = ['MERGED', 'CLOSED'];
// A follow step gated on the default branch or production (needs-you.mjs gateHeld) waits on its PR's
// merge commit, which a merge recorded without reading the PR (needs-you's done, a hand-ship) lacks, so
// that PR is read again for it. GitHub names a merged PR's merge commit, so one read records it.
const gatedFollow = (t) => followOnPending(t) && t.follow_on.some((x) => (x?.after ?? 'merge') !== 'merge');
const commitOwed = (t) => gatedFollow(t) && !t.pr_status?.merge_commit;
// A ticket's follow-on steps as the follow-on write compares them: as read, or as that write leaves them.
export const followState = (x) => JSON.stringify([x.follow_on ?? null, x.follow_on_done ?? null]);
// Ticket o took PR n's post-merge criteria: read for it, and named no other ticket as their owner.
export const tookPostMerge = (o, n) => !!o && String(o.post_merge_read ?? '') === String(n) && !o.post_merge_by;
// Ticket o is done on PR n of the repo PR url `url` names: one needs-you recorded done on another
// repo's PR of the same number (elsewhereDone) keeps that PR's url, and is not. Judged against the url
// GitHub gave the PR, not the remote's spelling of the repo, which a rename leaves behind.
export const repoOfPr = (url) => String(url ?? '').toLowerCase().split('/pull/')[0];
export const onThisPr = (o, n, url) => !!o && o.state === 'done' && o.result?.pr != null && String(o.result.pr) === String(n)
  && (!o.pr_status?.url || repoOfPr(o.pr_status.url) === repoOfPr(url));

// Why ticket `t`'s PR #n, as status `st`, is not its own (notOwnPr), or null. A merged PR the ticket was
// recorded shipped on (shipped_pr: the pass's shippedElsewhere, or the merge driver through queue.mjs
// merged) was built outside its worker by design, often on a branch of its own that names the key: it is
// the ticket's result, and being merged, nothing is done to it.
const foreignWhy = (t, n, st, logins) => (st?.state === 'MERGED' && t.shipped_pr != null && String(t.shipped_pr) === String(n) ? null : notOwnPr(t, st, logins));

// Ticket `t` parks on PR #n, which is not its own (`why`, notOwnPr's), and is said to: nothing is done to #n.
function* parkForeign(t, n, why, state, s, prStates) {
  prStates[n] = state;
  if (!s.dry) yield { type: 'park', key: t.key, question: foreignQuestion(n, why) };
  yield { type: 'out', line: `PR status: ${t.key}'s PR #${n} is not its own (${why}): ${s.dry ? 'would park it' : 'parked'}, and nothing is done to #${n}` };
}

export function* decidePrStatus(s) {
  const prStates = {};
  const merges = [];
  const unread = [];
  const drafts = [];
  const undrafted = [];
  const reopens = [];
  const previews = [];
  let unknownMergers = 0;
  // A PR recorded on two tickets (the merge driver's shipped_pr on one, shippedElsewhere's on the
  // other) is read from GitHub once a pass (pass.mjs's read-pr handler), and each ticket keeps its
  // status: one left without it would owe that PR's review for good (harvest.mjs postMergeUnmade).
  // Only the first acts on it as a draft, undrafted or reopened PR, so nothing is done to the PR twice.
  const reads = {};
  // The tickets whose post-merge read was written this pass, as owner or not: the loop reaches an owner
  // another ticket on its PR already wrote for with its snapshot from before that write.
  const postMergeWritten = new Set();
  // Ticket o, as read this pass, takes merged PR n's post-merge criteria (st.post_merge) as follow-on
  // steps, or with `by` ({ key, archived }) is stamped read naming by.key, only while that owner, if
  // live, still has them under the lock.
  function* readPostMerge(o, n, st, url, by = null) {
    const have = o.follow_on_done ? [] : o.follow_on ?? [];
    const declared = have.some((h) => !fromReview(h) && !String(h?.step ?? '').startsWith(LINK_STEP));
    const later = declared || by ? [] : st.post_merge.map((x) => ({ step: reviewStep(x.step).slice(0, FOLLOW_ON_MAX), row: null, from: 'review', ...(x.after ? { after: x.after } : {}) })).filter((x) => !have.some((h) => reviewStep(h?.step) === x.step && (h?.after ?? null) === (x.after ?? null)));
    const steps = later.length ? [`follow_on=${JSON.stringify([...have, ...later])}`, ...(o.follow_on_done ? ['follow_on_done=null'] : [])] : [];
    // As read, or as this write leaves them, which is what the check under the lock sees when nobody else wrote.
    const expect = [followState(o), later.length ? followState({ follow_on: [...have, ...later], follow_on_done: null }) : followState(o)];
    const named = by ? [`post_merge_by=${by.key}`] : o.post_merge_by ? ['post_merge_by=null'] : [];
    const w = yield { type: 'follow-on', key: o.key, fields: [...steps, `post_merge_read=${n}`, ...named], expect, pr: n, url, ...(by ? { by } : {}) };
    if (w?.ok && !w.skipped) postMergeWritten.add(o.key);
    if (w?.ok && !w.skipped && later.length) {
      merges.push(`${o.key} (PR #${n}): ${later.length} ${later.length === 1 ? 'criterion' : 'criteria'} its review left for after the merge, now follow-on steps`);
    }
  }
  for (const t of Object.values(s.tickets)) {
    // A fix try is over once its worker has finished: later spawns are no longer that try's.
    if (t.state === 'done' && t.fix && !t.fix.finished && !s.dry) {
      // The merge driver holds PRs sharing a file behind a repair, timed from when its worker finished.
      const fixTries = t.fix.kind === 'conflict'
        ? (t.fix_tries ?? []).map((x) => (x.kind === 'conflict' && x.at === t.fix.at && !x.finished ? { ...x, finished: s.passAt } : x))
        : null;
      yield { type: 'fix-finished', key: t.key, at: s.passAt, fixTries };
    }
    const n = t.state === 'done' ? t.result?.pr : null;
    if (n == null) continue;
    let st = null;
    // A status kept from an earlier pass is checked too, before a merged or closed one is taken as read.
    const keptForeign = t.pr_status?.pr === n ? foreignWhy(t, n, t.pr_status, s.logins) : null;
    if (keptForeign) { yield* parkForeign(t, n, keptForeign, t.pr_status.state, s, prStates); continue; }
    // Auto-merge armed or disarmed on the PR, as the merge log has it, once the PR is known the ticket's
    // and before any merge it led to; on every pass, merged or not, so a line one pass could not fold is
    // folded by the next.
    function* fold() {
      const arms = s.dry ? [] : armEvents(s, t, n);
      if (arms.length) yield { type: 'automerge', key: t.key, events: arms };
    }
    // A PR this pass's reopen closed and could not reopen is read again until it reopens.
    const owed = owesReopen(t);
    if (t.pr_status?.pr === n && PR_FINAL.includes(t.pr_status.state) && !(owed && t.pr_status.state === 'CLOSED')) {
      // prStates is this repo's PRs by number: a status naming another repo's PR (needs-you's
      // elsewhereDone) never fills the slot of this repo's PR of the same number.
      if (!t.pr_status.url || !s.repo || repoOfPr(t.pr_status.url) === repoOfPr(`https://github.com/${s.repo}/pull/${n}`)) prStates[n] = t.pr_status.state;
      if (t.pr_status.state !== 'MERGED' || (t.merged_at && !postMergeOwed(t, n) && !commitOwed(t))) { yield* fold(); continue; }
      if (t.pr_status.merged_at && !commitOwed(t)) st = t.pr_status;
    }
    if (!st) {
      const again = n in reads;
      st = yield { type: 'read-pr', key: t.key, pr: n, was: t.pr_status };
      // A PR already known merged or closed (read again only for its merge commit or post-merge
      // criteria) is gone, not unread: an outage hold waits on no PR it already knows has left.
      if (!st) { if (!(n in prStates) && !unread.includes(n)) unread.push(n); continue; }
      // A PR on a branch its worker did not make, or another person's, is never this ticket's: the
      // ticket parks before any list the reopen, undraft, fix-try or merge steps work from holds it.
      const foreign = foreignWhy(t, n, st, s.logins);
      if (foreign) { yield* parkForeign(t, n, foreign, st.state, s, prStates); continue; }
      if (!again) reads[n] = st;
      // A closed PR still owed its reopen counts as open, so the batch is not idle and no ticket held
      // behind it reads as stuck while the reopen is outstanding.
      if (!again || (owed && st.state === 'CLOSED')) prStates[n] = owed && st.state === 'CLOSED' ? 'OPEN' : st.state;
      yield { type: 'pr-status', key: t.key, status: st };
      if (!again) {
        // A finished preview frees its PR's preview-build unit for the next build, not at its TTL.
        const preview = s.previews && !s.dry ? previewFinished(st.checks) : null;
        if (preview) previews.push({ pr: n, at: preview.at, failed: preview.failed, reason: preview.failed.length ? `preview finished: ${preview.failed.join(', ')} failed` : 'preview finished' });
        if (st.state === 'OPEN' && st.isDraft === true) drafts.push({ t, s: st });
        if (st.state === 'OPEN' && st.isDraft === false) undrafted.push({ t, s: st });
      }
      // One reopen per PR, and the ticket that owes one (its reopen failed) is the one it goes to,
      // whichever of the PR's tickets the loop reached first.
      if (!again || owed) {
        const at = reopens.findIndex((r) => String(r.t.result?.pr) === String(n));
        if ((st.state === 'OPEN' && Object.keys(st.reopen ?? {}).length && st.base_head) || (owed && st.state === 'CLOSED')) {
          if (at < 0) reopens.push({ t, s: st, owed });
          else if (owed && !reopens[at].owed) reopens[at] = { t, s: st, owed };
        } else if (owed && !s.dry) yield { type: 'set', key: t.key, fields: ['reopening=null'] };
      }
    }
    yield* fold();
    // merged_at on the ticket and its eta-history line (queue.mjs merged keeps the first merge time and
    // appends a key once), with who merged it, which the ledger records as one merged event. The merge log
    // is read again here, after the PR's read: a merger records its line only once it has merged.
    if (st.state === 'MERGED' && !t.merged_at && !s.dry) {
      const own = s.ledger && ownRepoPr(s, t, n);
      const log = own ? ((yield { type: 'merge-log' }) ?? { events: s.mergeLog }).events : null;
      const merge = own ? mergerOf(s, n, st, log) : null;
      const rec = yield { type: 'merged', key: t.key, at: st.merged_at ?? null, ...(merge ? { merge } : {}) };
      if (rec) {
        merges.push(`${t.key} (PR #${n}): ${rec.split('\n').join('; ')}`);
        if (merge && !log) unknownMergers++;
      }
    }
    // A criterion its review left for after the merge is a follow-on step from now on, which needs-you
    // lists: the person checks it once, on the live system, rather than before the merge. Kept apart from
    // merged_at, which the merge driver, needs-you and a hand-shipped ticket may have recorded first. An
    // item the person already marked run (an earlier PR's, on a requeued ticket) is reopened with only
    // these steps. One write, so a refused one leaves the criteria owed to the next pass, and one made only
    // while the follow-on steps are as read: needs-you's done (queue.mjs follow-ran) changing them before
    // this is written skips it whole, so the next pass adds the criteria to what done left. Steps the worker
    // declared for after the merge win over the criteria: the two word one check differently, so both would
    // ask for it twice, and the criteria are the fallback for a worker that declared none. Kept link steps
    // and an earlier PR's criteria, still unrun on a requeued ticket, are not the worker's. A PR recorded
    // on two done tickets gives its criteria to one: the one, live or archived, that already took them,
    // else the lowest key among the live ones, as an archived ticket is never written. A ticket recorded
    // done on another repo's PR of the same number is on neither list. Whichever of them
    // the pass reaches first writes the owner's share too, so an owner whose kept status names no criteria
    // (needs-you's done) still gets them. Each other is stamped read with no steps and names the owner
    // (post_merge_by), so the person is not asked for the same check twice, and only while, under the lock,
    // the owner has taken them: an owner dropped or changed before its write lands leaves the criteria
    // owed to every ticket on the PR, not stamped away. Their criteria come from a read of the PR this
    // pass, never one ticket's kept status: one kept from before the last review would otherwise be given
    // to the owner in place of what the owner's own read finds.
    if (st.state === 'MERGED' && !s.dry && (st.post_merge ?? []).length && String(t.post_merge_read ?? '') !== String(n) && !postMergeWritten.has(t.key)) {
      const url = st.url ?? `https://github.com/${s.repo}/pull/${n}`;
      // Live and archived entries apart: a readmitted ticket has both under one key.
      const live = Object.values(s.tickets).filter((o) => o?.key && onThisPr(o, n, url));
      const gone = Object.values(s.archived ?? {}).filter((o) => o?.key && onThisPr(o, n, url));
      let pm = st;
      if ([...live, ...gone].some((o) => o.key !== t.key)) {
        if (!(n in reads)) {
          const r = yield { type: 'read-pr', key: t.key, pr: n, was: t.pr_status };
          if (r) {
            reads[n] = r;
            yield { type: 'pr-status', key: t.key, status: r };
          }
        }
        pm = reads[n] ?? null;
      }
      if (pm?.state === 'MERGED' && (pm.post_merge ?? []).length) {
        const tookLive = live.find((o) => o.key !== t.key && tookPostMerge(o, n));
        const took = tookLive ?? gone.find((o) => o.key !== t.key && tookPostMerge(o, n));
        const owner = took ?? live.sort((a, b) => (String(a.key) < String(b.key) ? -1 : 1))[0] ?? t;
        if (owner.key === t.key) yield* readPostMerge(t, n, pm, url);
        else {
          if (!took && !postMergeWritten.has(owner.key)) yield* readPostMerge(owner, n, pm, url);
          // An archived owner that took them stays so; a live one must still have them under the lock.
          yield* readPostMerge(t, n, pm, url, { key: owner.key, archived: !!took && !tookLive, url: pm.url ?? url });
        }
      }
    }
  }
  // A ticket archived with merge-log lines still unfolded (its batch unseeded, or the append refused, in
  // the pass that merged it) has them folded now, while the ledger knows it. The archive is not written.
  if (!s.dry && s.folded) {
    for (const o of Object.values(s.archived ?? {})) {
      const n = o?.state === 'done' ? o.result?.pr : null;
      if (n == null || Object.hasOwn(s.tickets, o.key) || !Object.hasOwn(s.folded, o.key)) continue;
      const arms = armEvents(s, o, n);
      if (arms.length) yield { type: 'automerge', key: o.key, events: arms };
    }
  }
  for (const m of merges) yield { type: 'out', line: `merge recorded: ${m}` };
  if (previews.length) {
    const r = yield { type: 'free-previews', done: previews };
    if (r?.unreadable) yield { type: 'out', line: `preview builds: leases were unreadable, so no preview-build unit was freed this pass (${r.unreadable})` };
    if (r?.failed) yield { type: 'out', line: `preview builds: freeing finished previews' preview-build units failed (${r.failed}); a unit still held lapses at its TTL` };
    for (const p of previews.filter((x) => r?.freed?.includes(x.pr))) {
      yield { type: 'out', line: `preview builds: PR #${p.pr}'s preview ${p.failed.length ? `failed (${p.failed.join(', ')})` : 'finished'}, so its preview-build unit is free for the next build` };
    }
  }
  // needs-you judges a gated follow step from the repo root's remote refs, so origin is fetched each pass
  // while one waits: nothing else moves origin/<default> or the Promotion ref there on a quiet repo.
  if (Object.values(s.tickets).some(gatedFollow)) yield { type: 'fetch-origin' };
  // A PR's check-build checkout goes once its ticket closes: its PR merged or closed, or the ticket out of the queue.
  if (!s.dry) {
    const open = [...new Set(Object.values(s.tickets).map((t) => t.result?.pr).filter((n) => n != null && !PR_FINAL.includes(prStates[n])).map(String))];
    yield { type: 'prune-builds', open };
  }
  yield { type: 'lists', drafts, undrafted, reopens, prStates, merges, unread, unknownMergers };
}
