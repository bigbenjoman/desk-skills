// A red-base repair another PR made needless, settled before any worker runs it again. While a repair
// waits (in draft for its checks, queued, parked, or owed a fix try), someone else can fix the base: the
// base goes green, or the repair's own changes land through their PR. A worker spawned on it then finds
// nothing to do and parks for a person to close it. So before the spawn step, each such repair whose
// base has gone green since it began, or whose changes are all on the base already, has its PR closed
// unmerged, naming the PR that fixed the base, is recorded done by that PR (as a park on another's
// merged PR is, parks.mjs doneByOther), and has its worktree removed. No worker is spawned and nothing
// parks. A repair for which no fixing PR can be named is recorded done with its own PR, closed, so the
// next red spell admits a repair afresh.
//
// The snapshot:
//   tickets    the queue's tickets, by key
//   isRepair   (key) -> whether the key is a red-base repair of this batch's base
//   base       the base's name, for the lines
//   dry        a dry run: say what would be done, change nothing
//   repairKey  the live red record's repair_key, or null when the base is not red now
//
// Actions:
//   push-fix {key}              -> null (nothing of its own to push) | { pr } | { why } (not pushed)
//   superseded {key}            -> null (still needed) | { error } | { why: 'untested', words } (the base is red only on
//                                  passes that tested nothing: kept open) | { why: 'green' | 'on-base', by: { pr, at } | null,
//                                  sha?, mark? } (mark: the green read it closes on, kept as closed_green)
//   pr-close {key, pr, comment} -> { ok, out }
//   write {key, fields}         -> whether the write went in
//   drop-worktree {key}         -> what was said of the worktree, or null
//   report (say)
import { say } from './shared.mjs';
import { doneByFields } from './parks.mjs';
import { untestedChecks, untestedWords } from '../base-red.mjs';

// What the driver's own reads of the base say of a repair begun at `began` (ms): { untested: words } where
// the base is red only on passes that tested nothing, so the failure was never exercised and it is kept
// open; else { green, at, mark }. `red` is the red record (readBaseRed), `greenRec` the last green read
// (readGreenRec), whose mark is the tip SHA it read (its time in a record from before that was kept).
// Green: the base is not red, read green since the repair began, and not on the read the repair was
// closed on before (closedGreen), so a requeue is not closed again on it.
export function greenRead({ red, greenRec, base, began, closedGreen = null }) {
  if (red?.branch === base && untestedChecks(red).length) return { untested: untestedWords(red) };
  const at = Date.parse(greenRec?.at ?? '');
  const mark = greenRec ? (greenRec.sha ?? greenRec.at) : null;
  return { green: (!red || red.branch !== base) && Number.isFinite(at) && at > began && mark !== closedGreen, at, mark };
}

// The repair's PR while it is open: its result or draft PR, unless the PR status reads it closed or merged.
export const openRepairPr = (t) => {
  const n = t.result?.pr ?? t.draft_pr ?? null;
  if (n == null) return null;
  const st = t.pr_status;
  return st && String(st.pr ?? n) === String(n) && ['CLOSED', 'MERGED'].includes(st.state) ? null : n;
};

// A repair a worker could still be spawned on: not running, not merged, not already done by another
// PR, and not done unless its PR is still open (a fix try, a conflict or a merge waits on it).
export const repairCandidate = (t, isRepair) => isRepair(t.key) && t.state !== 'running' && !t.merged_at && !t.done_by
  && (t.state !== 'done' || openRepairPr(t) != null);

const short = (sha) => String(sha ?? '').slice(0, 12);

// A repair whose worker exited, failed or recorded done, with no PR, while the base is still red: what it
// committed and left unpushed is the fix, pushed and opened as its PR (push-fix) rather than asked about.
// Only the live red spell's own repair (repairKey): one from an earlier spell fixed another failure. Not
// one this step closed itself (closed_superseded, cleared by a requeue), whose commits it judged needless.
// A handoff's next session pushes its own.
export const unpushedRepair = (t, s) => s.isRepair(t.key) && s.repairKey != null && t.key === s.repairKey
  && !t.closed_superseded && !t.merged_at && !t.done_by && !t.handoff
  && (t.state === 'failed' || t.state === 'done') && t.result?.pr == null && t.draft_pr == null;

export function* decideSupersededRepairs(s) {
  for (const t of Object.values(s.tickets)) {
    // Nothing of its own to push goes on to the check below, as before.
    if (unpushedRepair(t, s) && !s.dry) {
      const p = yield { type: 'push-fix', key: t.key };
      if (p?.pr) { yield say(t.key, 'done', `${t.key}: its worker left an unpushed fix while ${s.base} is still red: pushed ${t.branch} and opened draft PR #${p.pr}`); continue; }
      if (p?.why) { yield say(t.key, 'waiting', `${t.key}: its worker left a fix while ${s.base} is still red, but the pass did not push it: ${p.why}`); continue; }
    }
    if (!repairCandidate(t, s.isRepair)) continue;
    const r = yield { type: 'superseded', key: t.key };
    if (!r) continue;
    if (r.error) { yield say(t.key, 'waiting', `${t.key}: could not tell whether the red base it repairs is fixed elsewhere (${r.error}): left as it is`); continue; }
    if (r.why === 'untested') { yield say(t.key, 'waiting', `${t.key}: kept open: ${r.words}`); continue; }
    const how = r.why === 'green' ? `${s.base} has gone green since it began${r.sha ? `, at ${short(r.sha)}` : ''}` : `its changes are all on ${s.base} already`;
    const by = r.by?.pr != null ? r.by : null;
    const fixed = by ? `PR #${by.pr} fixed ${s.base}` : `${s.base} was fixed by a change no PR could be named for`;
    const pr = openRepairPr(t);
    if (s.dry) { yield say(t.key, 'done', `${t.key} (dry run): ${how} (${fixed}): would close${pr != null ? ` its PR #${pr} unmerged` : ''}, record it done and spawn nothing`); continue; }
    if (pr != null) {
      const c = yield { type: 'pr-close', key: t.key, pr: String(pr),
        comment: `desk is closing this red-base repair unmerged: ${how}, and ${fixed}, so it has nothing left to do.${by ? ` Its fix landed in #${by.pr}.` : ''}\n(${t.key}/desk-autopilot repair-superseded)` };
      if (!c?.ok) { yield say(t.key, 'waiting', `${t.key}: ${how}, but its PR #${pr} could not be closed (${String(c?.out ?? '').split('\n').pop()}): left as it is; the next pass tries again`); continue; }
    }
    const closedOwn = pr != null ? `; its PR #${pr} closed unmerged` : '';
    // A pending fix try is cleared too, so no worker is spawned on it.
    const fields = [...(by ? doneByFields(t, by.pr, { why: `it fixed the red ${s.base} this repair was for`, at: by.at }, `(it fixed the red ${s.base} this repair was for): ${how}${closedOwn}`)
      : ['state=done', 'park=null', 'handoff=null', 'handoff_stage=null', 'resume=null', `result.summary=closed unmerged: ${how}${closedOwn}`]), 'fix=null', 'closed_superseded=yes',
      // The green read it was closed on, so a requeue is not closed again on that same read.
      ...(r.mark ? [`closed_green=${r.mark}`] : [])];
    if (!(yield { type: 'write', key: t.key, fields })) continue;
    const wt = yield { type: 'drop-worktree', key: t.key };
    yield say(t.key, 'done', `${t.key}: ${how} (${fixed}): ${pr != null ? `PR #${pr} closed unmerged, ` : ''}recorded ${by ? `done by #${by.pr}` : 'done'}, no worker spawned${wt ? `; ${wt}` : ''}`);
  }
}
