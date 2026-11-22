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
//   merged {key, at}                   -> queue.mjs merged's record, or '' (at: GitHub's merge time, or null)
//   follow-on {key, fields, expect}    -> queue.mjs set's result for fields, written only while the
//                                      ticket's followState is one of `expect` ({ ok, skipped } when not)
//   out {line}                         a report line
//   fetch-origin {}                    git fetch origin in the repo root
//   prune-builds {open}                remove the check-build checkouts of every PR not in `open`
//   lists {drafts, undrafted, reopens, prStates, merges}   what the steps after this one work from:
//                                      each list of { t, s } (reopens with `owed`), each PR's state by
//                                      number, and the merge lines
import { FOLLOW_ON_MAX, followOnPending, postMergeOwed } from '../harvest.mjs';
import { fromReview, reviewStep } from '../undraft.mjs';
import { LINK_STEP } from './shared.mjs';
import { owesReopen } from '../queue-store.mjs';

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

export function* decidePrStatus(s) {
  const prStates = {};
  const merges = [];
  const drafts = [];
  const undrafted = [];
  const reopens = [];
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
    // A PR this pass's reopen closed and could not reopen is read again until it reopens.
    const owed = owesReopen(t);
    if (t.pr_status?.pr === n && PR_FINAL.includes(t.pr_status.state) && !(owed && t.pr_status.state === 'CLOSED')) {
      // prStates is this repo's PRs by number: a status naming another repo's PR (needs-you's
      // elsewhereDone) never fills the slot of this repo's PR of the same number.
      if (!t.pr_status.url || !s.repo || repoOfPr(t.pr_status.url) === repoOfPr(`https://github.com/${s.repo}/pull/${n}`)) prStates[n] = t.pr_status.state;
      if (t.pr_status.state !== 'MERGED' || (t.merged_at && !postMergeOwed(t, n) && !commitOwed(t))) continue;
      if (t.pr_status.merged_at && !commitOwed(t)) st = t.pr_status;
    }
    if (!st) {
      const again = n in reads;
      st = yield { type: 'read-pr', key: t.key, pr: n, was: t.pr_status };
      if (!st) continue;
      if (!again) reads[n] = st;
      // A closed PR still owed its reopen counts as open, so the batch is not idle and no ticket held
      // behind it reads as stuck while the reopen is outstanding.
      if (!again || (owed && st.state === 'CLOSED')) prStates[n] = owed && st.state === 'CLOSED' ? 'OPEN' : st.state;
      yield { type: 'pr-status', key: t.key, status: st };
      if (!again) {
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
    // merged_at on the ticket and its eta-history line (queue.mjs merged keeps the first merge time and
    // appends a key once).
    if (st.state === 'MERGED' && !t.merged_at && !s.dry) {
      const rec = yield { type: 'merged', key: t.key, at: st.merged_at ?? null };
      if (rec) merges.push(`${t.key} (PR #${n}): ${rec.split('\n').join('; ')}`);
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
  for (const m of merges) yield { type: 'out', line: `merge recorded: ${m}` };
  // needs-you judges a gated follow step from the repo root's remote refs, so origin is fetched each pass
  // while one waits: nothing else moves origin/<default> or the Promotion ref there on a quiet repo.
  if (Object.values(s.tickets).some(gatedFollow)) yield { type: 'fetch-origin' };
  // A PR's check-build checkout goes once its ticket closes: its PR merged or closed, or the ticket out of the queue.
  if (!s.dry) {
    const open = [...new Set(Object.values(s.tickets).map((t) => t.result?.pr).filter((n) => n != null && !PR_FINAL.includes(prStates[n])).map(String))];
    yield { type: 'prune-builds', open };
  }
  yield { type: 'lists', drafts, undrafted, reopens, prStates, merges };
}
