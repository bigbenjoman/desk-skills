// What a batch's queue says about itself, shared by pass.mjs and queue.mjs. Pure: takes the parsed
// queue, reads nothing. Also the exit-code contract every orchestration script shares.

// pass.mjs, plan-batch.mjs, queue.mjs and answer.mjs exit only with these, so the orchestrator branches
// on a number rather than on wording: go on; nothing to do yet, keep looping; show the person (an
// error, a refusal, a ticket that needs them, or a finished batch).
export const EXIT = Object.freeze({ GO_ON: 0, NOTHING_YET: 10, SHOW_PERSON: 11 });

// A crash is a refusal like any other: it exits SHOW_PERSON, never node's own 1. `report` prints it.
export function crashShowsPerson(report = (e) => console.error(e?.stack ?? String(e))) {
  const die = (e) => { try { report(e); } finally { process.exit(EXIT.SHOW_PERSON); } };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
}

export const HELD_PREFIX = 'held by orchestrator';

// Parked "held by orchestrator" (a dependency chain, released by merge-driver.sh release_chain or by
// the one sanctioned manual release once every predecessor's PR has merged).
export const isHeld = (t) => t?.state === 'parked' && String(t.park?.question ?? '').startsWith(HELD_PREFIX);

// A lane C or D triage record whose lane challenge could not read the code (triage.sh's INCONCLUSIVE):
// one unchecked opinion, which the user confirms or re-lanes rather than reading as settled.
export const laneUnchecked = (r) => ['C', 'D'].includes(r?.lane) && r.lane_challenge?.verdict === 'INCONCLUSIVE';

// The park question for a lane C or D triage record, or null for any other lane. plan-batch and
// queue.mjs admit both seed a ticket's park from it.
export function lanePark(r) {
  if (!['C', 'D'].includes(r?.lane)) return null;
  const reason = String(r.lane_reason ?? 'needs a person');
  return laneUnchecked(r)
    ? `lane ${r.lane} UNCHECKED (challenge could not read the code): confirm lane ${r.lane} or re-lane — ${reason.slice(0, 120)}`
    : `lane ${r.lane} — ${reason.slice(0, 160)}`;
}

// A held ticket is still going somewhere only while it can still be released: every predecessor is
// either progressing (running, waiting to spawn, done with a PR that is open, or itself held and
// going somewhere) or merged (done with a merged PR: the release is due). One predecessor that cannot
// get there (failed, parked for a reason of its own, finished with no PR, a PR closed unmerged, never
// admitted, missing) means it waits on a person, and so does a hold with no recorded blocker.
// `prState(n)` gives a PR's state when the caller looked it up ('OPEN' | 'MERGED' | 'CLOSED'); unknown
// counts as open.
export function waitingOnMerge(q, t, prState = () => null, seen = new Set()) {
  // `seen` is the current path only: a ticket on it again is a hold cycle (a hand-edited queue), which
  // can never release. Two paths meeting at one held ticket (a diamond) is normal and is followed.
  if (!isHeld(t) || seen.has(t)) return false;
  seen.add(t);
  const preds = String(t.held_by ?? '').split('|').filter(Boolean);
  const ok = preds.length > 0 && preds.every((p) => {
    const pt = q.tickets?.[p];
    if (!pt) return false;
    if (['running', 'triaged'].includes(pt.state)) return true;
    if (pt.state === 'done') return pt.result?.pr != null && prState(pt.result.pr) !== 'CLOSED';
    return waitingOnMerge(q, pt, prState, seen);
  });
  seen.delete(t);
  return ok;
}

// Idle: nothing running, nothing left to spawn, nothing waiting on a merge to be released.
export function batchIdle(q, prState) {
  return Object.values(q.tickets ?? {}).every((t) => ['done', 'parked', 'failed'].includes(t.state) && !waitingOnMerge(q, t, prState));
}
