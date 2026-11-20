// The "follow steps" step of a pass, as a decision: which merged tickets get a follow-step checker
// (follow-steps.mjs) for the steps they left that only read CI, desk's logs or desk's state, whose
// finished checker is read, and whose has run too long. Pure: it reads only the snapshot it is given.
//
// A ticket's steps are owed a run once its code is out (needs-you.mjs outAt: merged, or promoted for a
// batch child) and the pass has made its review's post-merge criteria into steps. One checker per
// ticket at a time, for every step it owes; its record (follow_run) stays on the ticket until a pass
// reads how it ended.
//
// The snapshot:
//   tickets   the queue's tickets, by key
//   labels    the repo's §4 Person-step labels, lowercased
//   out       a Set of the keys whose code is out
//   alive     a Set of the keys whose follow_run process is still running
//   now       the time, in ms
import { followOnPending, postMergeOwed } from '../harvest.mjs';
import { owedSteps, FOLLOW_TIMEOUT_MS } from '../follow-steps.mjs';

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
    if (!followOnPending(t) || postMergeOwed(t) || !s.out.has(t.key)) continue;
    const steps = owedSteps(t, s.labels);
    if (steps.length) out.push({ type: 'start', key: t.key, steps });
  }
  return out;
}
