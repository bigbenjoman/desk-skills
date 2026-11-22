// The "deadlines" step of a pass, as a decision: every wait a ticket is in carries when it started, its
// deadline and where it escalates to, and one sweep a pass escalates a wait past its deadline once.
//
// The waits a ticket is in are kept on it as `waits`, { <on>: { since, deadline, escalate_to, ... } },
// or null once none is open: `escalated` records when the sweep escalated it, so a wait is escalated
// once until it ends and a new one starts. With the ledger lever on, a wait starting, escalated or
// ending is a waiting or waited event in the ticket ledger (queue-ledger.mjs).
//
// The waits (WAITS):
//   mergeability  a done ticket's open PR whose mergeability GitHub reads UNKNOWN, kept per PR: it
//                 starts when the undraft step first saw that answer (the draft's undraft record keeps
//                 it as unknown_since), else at this pass, and ends once GitHub answers or the PR closes
//   handoff       a ticket handed off between sessions whose next session has not started: it starts
//                 at the pass that first sees the handoff pending, and ends once the session starts
//
// The snapshot: { tickets (the queue's, as the pass read them for this step), at (the pass's time, ISO),
// dry }. The actions are the shared `set` and `report` (pass/shared.mjs).
import { set, say } from './shared.mjs';
import { repairSaid } from '../undraft.mjs';

const MIN = 60 * 1000;
// How long each wait may last before it escalates, and where to: the person, or a requeue.
export const WAITS = Object.freeze({
  mergeability: { ms: 30 * MIN, escalate_to: 'person' },
  handoff: { ms: 15 * MIN, escalate_to: 'requeue' },
});

// What ticket `t` waits on now: { <on>: what identifies that wait, and for mergeability when it was
// first seen, as `since`, where the undraft record keeps it }.
export function waitsOf(t) {
  const now = {};
  const n = t.state === 'done' ? t.result?.pr ?? null : null;
  const s = t.pr_status;
  if (n != null && s?.pr === n && s.state === 'OPEN' && s.mergeable === 'UNKNOWN') {
    const seen = t.undraft?.pr === n ? t.undraft.unknown_since ?? null : null;
    now.mergeability = { pr: n, ...(seen ? { since: seen } : {}) };
  }
  if (t.state === 'triaged' && t.handoff === 'pending') now.handoff = { stage: String(t.handoff_stage ?? '?') };
  return now;
}

const minsSince = (since, at) => Math.max(0, Math.floor((Date.parse(at) - Date.parse(since)) / MIN));

// The line escalating ticket `t`'s wait `w` on `on`, at `at`.
function escalation(t, on, w, at) {
  const mins = minsSince(w.since, at);
  const limit = WAITS[on].ms / MIN;
  if (on === 'mergeability') {
    const repair = t.undraft?.pr === w.pr && t.undraft?.unknown_repair ? `; ${repairSaid(t.undraft.unknown_repair)}` : '';
    return `${t.key}: NO MERGE ANSWER — GitHub has not worked out whether PR #${w.pr} conflicts with its base for ${mins} minutes, since ${w.since}, past its ${limit}-minute deadline${repair}. ` +
      `Push a new commit to #${w.pr} (an empty one will do) for a fresh merge ref; if it still has no answer, open a new PR from its branch`;
  }
  return `${t.key}: HANDOFF NOT STARTED — its Stage ${w.stage} session has not started ${mins} minutes after its handoff, since ${w.since}, past its ${limit}-minute deadline. ` +
    `If nothing in this report holds it back (a slot, memory, a usage limit), requeue it: queue.mjs requeue ${t.key}`;
}

// Ticket `t`'s waits after this pass, and the lines escalating those past their deadline at `at`. A
// wait still open keeps its start, deadline and escalation; a wait on another PR or stage is a new one.
export function nextWaits(t, at) {
  const was = t.waits && typeof t.waits === 'object' ? t.waits : {};
  const next = {};
  const lines = [];
  for (const [on, seen] of Object.entries(waitsOf(t))) {
    const { since: first, ...id } = seen;
    const open = was[on] && Object.entries(id).every(([k, v]) => was[on][k] === v) ? was[on] : null;
    const since = open?.since ?? (Number.isFinite(Date.parse(first)) ? first : at);
    let w = open ?? { since, deadline: new Date(Date.parse(since) + WAITS[on].ms).toISOString(), escalate_to: WAITS[on].escalate_to, ...id };
    if (!w.escalated && Date.parse(at) >= Date.parse(w.deadline)) {
      w = { ...w, escalated: at };
      lines.push(escalation(t, on, w, at));
    }
    next[on] = w;
  }
  return { waits: next, lines };
}

export function decideDeadlines(snap) {
  const actions = [];
  for (const t of Object.values(snap.tickets)) {
    const { waits, lines } = nextWaits(t, snap.at);
    for (const line of lines) actions.push(say(t.key, 'waiting', line));
    const open = Object.keys(waits).length ? waits : null;
    if (!snap.dry && JSON.stringify(open) !== JSON.stringify(t.waits ?? null)) actions.push(set(t.key, `waits=${JSON.stringify(open)}`));
  }
  return actions;
}
