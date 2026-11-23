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
//
// Actions:
//   superseded {key}            -> null (still needed) | { error } | { why: 'green' | 'on-base', by: { pr, at } | null, sha? }
//   pr-close {key, pr, comment} -> { ok, out }
//   write {key, fields}         -> whether the write went in
//   drop-worktree {key}         -> what was said of the worktree, or null
//   report (say)
import { say } from './shared.mjs';
import { doneByFields } from './parks.mjs';

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

export function* decideSupersededRepairs(s) {
  for (const t of Object.values(s.tickets)) {
    if (!repairCandidate(t, s.isRepair)) continue;
    const r = yield { type: 'superseded', key: t.key };
    if (!r) continue;
    if (r.error) { yield say(t.key, 'waiting', `${t.key}: could not tell whether the red base it repairs is fixed elsewhere (${r.error}): left as it is`); continue; }
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
      : ['state=done', 'park=null', 'handoff=null', 'handoff_stage=null', 'resume=null', `result.summary=closed unmerged: ${how}${closedOwn}`]), 'fix=null'];
    if (!(yield { type: 'write', key: t.key, fields })) continue;
    const wt = yield { type: 'drop-worktree', key: t.key };
    yield say(t.key, 'done', `${t.key}: ${how} (${fixed}): ${pr != null ? `PR #${pr} closed unmerged, ` : ''}recorded ${by ? `done by #${by.pr}` : 'done'}, no worker spawned${wt ? `; ${wt}` : ''}`);
  }
}
