// A ticket's states in the queue, and the finished ones. A module of its own, importing nothing, so
// the ticket ledger can read them while the queue store, which appends to that ledger, is still loading.
export const STATES = ['queued', 'triaged', 'running', 'parked', 'done', 'failed'];
export const FINISHED = ['done', 'failed'];
// What a park waits on: a step only the person takes, a question, a blocker, a stop, a date, a failure.
export const PARK_KINDS = ['person-step', 'question', 'hold', 'stopped', 'date', 'failure'];

// Ticket `t`'s blockers, in the order they were added. held_by, the pipe-joined string every writer
// still sets (null once released), is read wherever the ticket has the field, so a writer that changes
// only held_by is read as it left it; `holds` is the same list, which each queue write lays beside it
// (holdsLaid), read only for a ticket without held_by.
// A requeue keeps a ticket's merged_at (ownPr reads it as the earlier work's) and records when it sent the
// ticket back (reworked_at), so the merge can outlive the work it recorded: a ticket sent back for more is
// not merged while that runs, nor once done again on a PR of its own until that PR merges. Whether t's
// recorded merge is its current work's: done, and either never sent back since the merge, no PR of its own
// (done by another's PR, or with no PR), or its PR read merged.
export const mergeRecorded = (t) => !!t?.merged_at && t.state === 'done'
  && (!(Date.parse(t.reworked_at) >= Date.parse(t.merged_at)) || t.result?.pr == null
    || (t.pr_status?.state === 'MERGED' && Number(t.pr_status.pr) === Number(t.result.pr)));
export const blockersOf = (t) => {
  if (!t || typeof t !== 'object') return [];
  if ('held_by' in t || !Array.isArray(t.holds)) return String(t.held_by ?? '').split('|').filter(Boolean);
  return t.holds.filter((k) => typeof k === 'string' && k !== '');
};

// Queue `q` with each ticket that has a held_by given `holds`, the same blockers as a list. -> `q`.
export function holdsLaid(q) {
  for (const t of Object.values(q?.tickets ?? {})) {
    if (t && typeof t === 'object' && 'held_by' in t) t.holds = blockersOf(t);
  }
  return q;
}
