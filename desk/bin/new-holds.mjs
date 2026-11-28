// A change pushed after a PR opened (a fix try, a later worker round) can put a file under a §4 Merge
// holds path the PR did not touch before, and so turn a merge the driver would make into the person's.
// The pass reads each open PR's held files once per head (gate.mjs held) and compares them with its
// first read of that PR: what the first read held is the PR's own, and only a file held later is new.
//
//   newHolds(t, s, { defaultBranch, read }) -> null, or { record, holds, changed, fresh, drop, line?, ask? }
//     t       the queue's ticket: `hold_read` { pr, head, files, asked, asks } is the record of its PR's
//             reads (files: the first read's; asked: the new files the person was asked about; asks:
//             those asks, [{ id, files }]), `new_holds` the files held now that the first read did not hold
//     s       its PR status (pass/pr-status.mjs): state, pr, head, base
//     read    () -> gate.mjs held's { head, holds: [{ glob, why, files }] }, or null unread
//     record  the next hold_read, but for the id of the ask recorded for `ask`, which the caller adds
//     holds   the next new_holds: held at this head and not by the first read, so a reverted change
//             clears it; changed: whether it differs from the ticket's
//     fresh   the new files no ask has named yet, with the report line, the person's ask and t's key
//     drop    ask ids to remove: no file an ask named is held now, or it was asked of an earlier PR
//   writeHoldAsks(state, r, failed) -> the hold_read to write: r.record with the id of r.ask's ask added,
//             after removing r.drop's asks. The ask waits on the ticket (until: [r.key]), so pruneAsks
//             drops it once the ticket is finished; one not added leaves r.fresh out of asked, to be
//             asked again at the next head. Asks are the repo's (asks.mjs), so a named batch's state
//             writes them in the standing batch's folder; failed(what, error) hears each that could not be
//   nowNeedsText(t) -> "now needs your merge: <files>" while the ticket has new holds, else null
//             (desk-q.mjs, which draws the row, re-exported here)

import { repoStateOf } from './desk-env.mjs';
import { addAsk, removeAsk } from './asks.mjs';
import { andList, NOW_NEEDS, nowNeedsText } from './desk-q.mjs';

export { NOW_NEEDS, nowNeedsText };

const filesOf = (holds) => [...new Set((holds ?? []).flatMap((h) => h.files ?? []))].sort();

export function newHolds(t, s, { defaultBranch, read }) {
  if (s?.state !== 'OPEN' || !s.head || s.pr == null) return null;
  // A hold falls only on the merge into the default branch: one into a batch base merges past it.
  if (s.base && defaultBranch && s.base !== defaultBranch) return null;
  // A record of another PR (the ticket's earlier one, closed) is no record of this one.
  const was = t.hold_read?.pr === s.pr ? t.hold_read : null;
  if (was?.head === s.head) return null;
  const r = read();
  if (!r?.head) return null;
  const now = filesOf(r.holds);
  const own = was ? (was.files ?? []) : now;
  const holds = now.filter((f) => !own.includes(f));
  const live = was && holds.length;
  // An ask goes once no file it named is held, even while a later file still is.
  const prior = live ? (was.asks ?? []) : (t.hold_read?.asks ?? []);
  const stale = live ? prior.filter((a) => !(a.files ?? []).some((f) => holds.includes(f))) : prior;
  const drop = stale.map((a) => a.id);
  const gone = stale.flatMap((a) => a.files ?? []);
  const asked = live ? (was.asked ?? []).filter((f) => !gone.includes(f)) : [];
  const fresh = holds.filter((f) => !asked.includes(f));
  const record = { pr: s.pr, head: r.head, files: own, asked: [...asked, ...fresh], asks: live ? prior.filter((a) => !stale.includes(a)) : [] };
  const changed = JSON.stringify(holds) !== JSON.stringify(t.new_holds ?? []);
  if (!fresh.length) return { record, holds, changed, fresh, drop };
  const why = r.holds.filter((h) => h.files.some((f) => fresh.includes(f))).map((h) => `\`${h.glob}\`: ${h.why}`).join('; ');
  const it = fresh.length === 1 ? 'it' : 'them';
  return {
    record, holds, changed, fresh, drop, key: t.key,
    line: `${t.key}: PR #${s.pr} ${NOW_NEEDS}: ${fresh.join(', ')}. A change pushed after the PR opened put ${it} under §4 Merge holds (${why}), so the merge driver leaves the merge to you`,
    ask: `PR #${s.pr} (${t.key}) ${NOW_NEEDS}: a change pushed after it opened touched ${andList(fresh)}, under §4 Merge holds (${why}), so desk will not merge it. Recommended: keep the change and merge #${s.pr} yourself once it is green, then say done`,
  };
}

export function writeHoldAsks(state, r, failed = () => {}) {
  const dir = repoStateOf(state);
  for (const id of r.drop) { try { removeAsk(dir, id); } catch (e) { failed('removed', e); } }
  const asks = [...r.record.asks];
  let asked = r.record.asked;
  if (r.ask) {
    // A wait on the ticket, so pruneAsks drops it once the ticket is finished.
    try { asks.push({ id: addAsk(dir, r.ask, Date.now(), { until: r.key ? [r.key] : [] }).id, files: r.fresh }); }
    // Not asked, so not recorded as asked: the next head's read asks again.
    catch (e) { failed('recorded', e); asked = asked.filter((f) => !r.fresh.includes(f)); }
  }
  return { ...r.record, asked, asks };
}
