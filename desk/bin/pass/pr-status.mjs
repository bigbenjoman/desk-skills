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
//   logins    desk's accounts, as E.verdictLogins gives them (null when unset)
//
// Actions ("->" is what the handler returns):
//   fix-finished {key, at, fixTries}   the ticket's fix try is over: fix.finished=at, and, for a
//                                      conflict try, fix_tries as given (else fixTries is null)
//   read-pr {key, pr, was}             -> PR #pr's status (with its history, triggers and errors kept
//                                      from `was`, the ticket's last pr_status), or null unread
//   pr-status {key, status}            keep status on the ticket as pr_status
//   set {key, fields}                  -> queue.mjs set's result
//   merged {key, at}                   -> queue.mjs merged's record, or '' (at: GitHub's merge time, or null)
//   follow-on {key, fields, expect}    -> queue.mjs set's result for fields, written only while the
//                                      ticket's followState is one of `expect` ({ ok, skipped } when not)
//   out {line}                         a report line
//   fetch-origin {}                    git fetch origin in the repo root
//   prune-builds {open}                remove the check-build checkouts of every PR not in `open`
//   park {key, question}               park the ticket: its PR is not its own (shared.mjs notOwnPr)
//   lists {drafts, undrafted, reopens, prStates, merges}   what the steps after this one work from:
//                                      each list of { t, s } (reopens with `owed`), each PR's state by
//                                      number, and the merge lines
import { FOLLOW_ON_MAX, followOnPending, postMergeOwed } from '../harvest.mjs';
import { fromReview, reviewStep } from '../undraft.mjs';
import { LINK_STEP, notOwnPr, foreignQuestion } from './shared.mjs';
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

// Ticket `t` parks on PR #n, which is not its own (`why`, notOwnPr's), and is said to: nothing is done to #n.
function* parkForeign(t, n, why, state, s, prStates) {
  prStates[n] = state;
  if (!s.dry) yield { type: 'park', key: t.key, question: foreignQuestion(n, why) };
  yield { type: 'out', line: `PR status: ${t.key}'s PR #${n} is not its own (${why}): ${s.dry ? 'would park it' : 'parked'}, and nothing is done to #${n}` };
}

export function* decidePrStatus(s) {
  const prStates = {};
  const merges = [];
  const drafts = [];
  const undrafted = [];
  const reopens = [];
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
    const keptForeign = t.pr_status?.pr === n ? notOwnPr(t, t.pr_status, s.logins) : null;
    if (keptForeign) { yield* parkForeign(t, n, keptForeign, t.pr_status.state, s, prStates); continue; }
    // A PR this pass's reopen closed and could not reopen is read again until it reopens.
    const owed = owesReopen(t);
    if (t.pr_status?.pr === n && PR_FINAL.includes(t.pr_status.state) && !(owed && t.pr_status.state === 'CLOSED')) {
      prStates[n] = t.pr_status.state;
      if (t.pr_status.state !== 'MERGED' || (t.merged_at && !postMergeOwed(t, n) && !commitOwed(t))) continue;
      if (t.pr_status.merged_at && !commitOwed(t)) st = t.pr_status;
    } else if (n in prStates) continue;
    if (!st) {
      st = yield { type: 'read-pr', key: t.key, pr: n, was: t.pr_status };
      if (!st) continue;
      // A PR on a branch its worker did not make, or another person's, is never this ticket's: the
      // ticket parks before any list the reopen, undraft, fix-try or merge steps work from holds it.
      const foreign = notOwnPr(t, st, s.logins);
      if (foreign) { yield* parkForeign(t, n, foreign, st.state, s, prStates); continue; }
      // A closed PR still owed its reopen counts as open, so the batch is not idle and no ticket held
      // behind it reads as stuck while the reopen is outstanding.
      prStates[n] = owed && st.state === 'CLOSED' ? 'OPEN' : st.state;
      yield { type: 'pr-status', key: t.key, status: st };
      if (st.state === 'OPEN' && st.isDraft === true) drafts.push({ t, s: st });
      if (st.state === 'OPEN' && st.isDraft === false) undrafted.push({ t, s: st });
      if ((st.state === 'OPEN' && Object.keys(st.reopen ?? {}).length && st.base_head) || (owed && st.state === 'CLOSED')) reopens.push({ t, s: st, owed });
      else if (owed && !s.dry) yield { type: 'set', key: t.key, fields: ['reopening=null'] };
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
    // and an earlier PR's criteria, still unrun on a requeued ticket, are not the worker's.
    if (st.state === 'MERGED' && !s.dry && (st.post_merge ?? []).length && String(t.post_merge_read ?? '') !== String(n)) {
      const have = t.follow_on_done ? [] : t.follow_on ?? [];
      const declared = have.some((h) => !fromReview(h) && !String(h?.step ?? '').startsWith(LINK_STEP));
      const later = declared ? [] : st.post_merge.map((x) => ({ step: reviewStep(x.step).slice(0, FOLLOW_ON_MAX), row: null, from: 'review', ...(x.after ? { after: x.after } : {}) })).filter((x) => !have.some((h) => reviewStep(h?.step) === x.step && (h?.after ?? null) === (x.after ?? null)));
      const steps = later.length ? [`follow_on=${JSON.stringify([...have, ...later])}`, ...(t.follow_on_done ? ['follow_on_done=null'] : [])] : [];
      // As read, or as this write leaves them, which is what the check under the lock sees when nobody else wrote.
      const expect = [followState(t), later.length ? followState({ follow_on: [...have, ...later], follow_on_done: null }) : followState(t)];
      const w = yield { type: 'follow-on', key: t.key, fields: [...steps, `post_merge_read=${n}`], expect };
      if (w?.ok && !w.skipped && later.length) {
        merges.push(`${t.key} (PR #${n}): ${later.length} ${later.length === 1 ? 'criterion' : 'criteria'} its review left for after the merge, now follow-on steps`);
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
