// The "follow steps" step of a pass, as a decision: which merged tickets get a follow-step checker
// (follow-steps.mjs) for the steps they left that only read CI, desk's logs or desk's state, whose
// finished checker is read, and whose has run too long. Pure: it reads only the snapshot it is given.
//
// A ticket's steps are owed a run once its code is out (needs-you.mjs outAt: merged, or promoted for a
// batch child), each step's own gate holds (needs-you.mjs followGateHeld: an `after: main` step once the
// default branch has its merge), the step is due (follow-steps.mjs followDelayMs after the code went
// out) and the pass has made its review's post-merge criteria into steps. A step a checker found pending
// is checked again, while FOLLOW_WAIT_MS has not passed since it fell due. One checker per ticket at a time, for every step it owes; its record (follow_run) stays on the
// ticket until a pass reads how it ended.
//
// The snapshot:
//   tickets   the queue's tickets, by key
//   labels    the repo's §4 Person-step labels, lowercased
//   out       a Map of the keys whose code is out, to when it went out, in ms
//   held      a Set of `<key>:<gate>` for each gate (merge, main) that holds for the ticket's steps
//   alive     a Set of the keys whose follow_run process is still running
//   now       the time, in ms
import { followOnPending, postMergeOwed } from '../harvest.mjs';
import { owedSteps, checkOf, followKind, followDue, followRetrying, FOLLOW_TIMEOUT_MS } from '../follow-steps.mjs';

const ready = (s, t) => followOnPending(t) && !postMergeOwed(t) && s.out.has(t.key);

// -> actions, in ticket order:
//   { type: 'harvest', key, run }    read the ended run's output, record it and clear follow_run
//   { type: 'stop', key, run }       stop a run past FOLLOW_TIMEOUT_MS; the next pass reads it
//   { type: 'start', key, steps }    start a checker for these steps
export function decideFollowSteps(s) {
  const out = [];
  for (const t of Object.values(s.tickets)) {
    const run = t.follow_run;
    if (run) {
      if (!s.alive.has(t.key)) out.push({ type: 'harvest', key: t.key, run });
      else if (s.now - Date.parse(run.started) > FOLLOW_TIMEOUT_MS) out.push({ type: 'stop', key: t.key, run });
      continue;
    }
    if (!ready(s, t)) continue;
    const steps = owedSteps(t, s.labels, { now: s.now, out: s.out.get(t.key) }).filter((x) => s.held.has(`${t.key}:${x.after ?? 'merge'}`));
    if (steps.length) out.push({ type: 'start', key: t.key, steps });
  }
  return out;
}

// Whether a ticket still waits on a checker: one is running, or a step one found pending is due again
// within FOLLOW_WAIT_MS of falling due. Either keeps the batch from idling, so a pass comes back to it. A
// step not due yet does not: the supervisor wakes an idle batch once it is (followDueSince).
export const followAwaits = (s) => Object.values(s.tickets).some((t) => t.follow_run
  || (ready(s, t) && t.follow_on.some((x) => followKind(x, s.labels) === 'runnable' && checkOf(t, x)?.result === 'pending'
    && followDue(x, s.out.get(t.key), s.now) && followRetrying(x, s.out.get(t.key), s.now))));
