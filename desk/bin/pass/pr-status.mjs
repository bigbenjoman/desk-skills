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
//
// Actions ("->" is what the handler returns):
//   fix-finished {key, at, fixTries}   the ticket's fix try is over: fix.finished=at, and, for a
//                                      conflict try, fix_tries as given (else fixTries is null)
//   read-pr {key, pr, was}             -> PR #pr's status (with its history, triggers and errors kept
//                                      from `was`, the ticket's last pr_status), or null unread
//   pr-status {key, status}            keep status on the ticket as pr_status
//   set {key, fields}                  -> queue.mjs set's result
//   merged {key, at}                   -> queue.mjs merged's record, or '' (at: GitHub's merge time, or null)
//   out {line}                         a report line
//   prune-builds {open}                remove the check-build checkouts of every PR not in `open`
//   lists {drafts, undrafted, reopens, prStates, merges}   what the steps after this one work from:
//                                      each list of { t, s } (reopens with `owed`), each PR's state by
//                                      number, and the merge lines
import { FOLLOW_ON_MAX } from '../harvest.mjs';

// A PR recorded merged or closed is not read again, unless it merged and the ticket has no merged_at yet.
const PR_FINAL = ['MERGED', 'CLOSED'];
// A merged PR whose kept status names post-merge criteria not yet made follow-on steps is read on.
const postMergeOwed = (t, n) => (t.pr_status?.post_merge ?? []).length > 0 && String(t.post_merge_read ?? '') !== String(n);

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
    // A PR this pass's reopen closed and could not reopen is read again until it reopens.
    const owed = t.reopening != null && String(t.reopening) === String(n);
    if (t.pr_status?.pr === n && PR_FINAL.includes(t.pr_status.state) && !(owed && t.pr_status.state === 'CLOSED')) {
      prStates[n] = t.pr_status.state;
      if (t.pr_status.state !== 'MERGED' || (t.merged_at && !postMergeOwed(t, n))) continue;
      if (t.pr_status.merged_at) st = t.pr_status;
    } else if (n in prStates) continue;
    if (!st) {
      st = yield { type: 'read-pr', key: t.key, pr: n, was: t.pr_status };
      if (!st) continue;
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
    // these steps. One write, so a refused one leaves the criteria owed to the next pass.
    if (st.state === 'MERGED' && !s.dry && (st.post_merge ?? []).length && String(t.post_merge_read ?? '') !== String(n)) {
      const have = t.follow_on_done ? [] : t.follow_on ?? [];
      const later = st.post_merge.map((x) => ({ step: String(x.step).slice(0, FOLLOW_ON_MAX), row: null })).filter((x) => !have.some((h) => h?.step === x.step));
      const steps = later.length ? [`follow_on=${JSON.stringify([...have, ...later])}`, ...(t.follow_on_done ? ['follow_on_done=null'] : [])] : [];
      const ok = yield { type: 'set', key: t.key, fields: [...steps, `post_merge_read=${n}`] };
      if (ok && later.length) {
        merges.push(`${t.key} (PR #${n}): ${later.length} ${later.length === 1 ? 'criterion' : 'criteria'} its review left for after the merge, now follow-on steps`);
      }
    }
  }
  for (const m of merges) yield { type: 'out', line: `merge recorded: ${m}` };
  // A PR's check-build checkout goes once its ticket closes: its PR merged or closed, or the ticket out of the queue.
  if (!s.dry) {
    const open = [...new Set(Object.values(s.tickets).map((t) => t.result?.pr).filter((n) => n != null && !PR_FINAL.includes(prStates[n])).map(String))];
    yield { type: 'prune-builds', open };
  }
  yield { type: 'lists', drafts, undrafted, reopens, prStates, merges };
}
