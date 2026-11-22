// The "deadlines" step of a pass, as a decision: every wait a ticket is in carries when it started, its
// deadline and where it escalates to, and one sweep a pass escalates a wait past its deadline once.
//
// The waits a ticket is in are kept on it as `waits`, { <on>: { since, deadline, escalate_to, ... } },
// or null once none is open: `escalated` records when the sweep escalated it, so a wait is escalated
// once until it ends and a new one starts. With the ledger lever on, a wait starting, escalated or
// ending is a waiting or waited event in the ticket ledger (queue-ledger.mjs). An escalated wait's line
// stays under WAITING ON YOU while the wait is open, as every line there does: the decider keys it on
// its ticket, class and PR (decider.mjs waitKey), so it is one item however many passes list it, and a
// pass that lists it no more lets the supervisor drop it as settled.
//
// The waits (WAITS):
//   mergeability  a done ticket's open PR whose mergeability GitHub reads UNKNOWN, kept per PR. Desk
//                 already acts on it: undraft.mjs for a draft, merge-driver.sh for a ready PR, each
//                 updating its branch once past UNKNOWN_LIMIT_MS and making it the person's past the
//                 limit again. The wait takes its start from the draft's undraft record where that
//                 record keeps this spell (unknownSpell), else this pass, and is escalated when its
//                 owner makes it the person's: a draft's undraft call, said by the undraft step as its
//                 DRAFT line, or a ready PR's `merge ref:` note, said here. Past its deadline with
//                 neither owner on it (no undraft record keeps the spell, or no merge driver runs), it
//                 is said here. It ends once GitHub answers or the PR closes.
//   handoff       a ticket handed off between sessions whose next session has not started: it starts
//                 at the pass that first sees the handoff pending, and ends once the session starts
//   progress      a running worker's time since its last progress: a stage change, a new commit on its
//                 worktree's HEAD or a push to its branch (progress_at, which the advance step keeps).
//                 Log growth is not progress: a hung call's heartbeat grows the log. Progress closes the
//                 wait, and the next pass with none opens a new one from it. While the advance step holds a suite wait (suite_wait_since) the wait
//                 is that step's: under SUITE_WAIT_CEILING_MS its clock is paused (the advance step moves
//                 progress_at on by the wait once it ends), and past it the ceiling's own report is made.
//
// The snapshot: { tickets (the queue's, as the pass read them for this step), at (the pass's time, ISO),
// dry }. The actions are the shared `set` and `report` (pass/shared.mjs).
import { set, say } from './shared.mjs';
import { toHandoff } from './eligibility.mjs';
import { prStatusOf } from '../batch-state.mjs';
import { UNKNOWN_LIMIT_MS, unknownSpell, freshMergeRef } from '../undraft.mjs';

const MIN = 60 * 1000;
// How long each wait may last before it escalates, and where to: the person, or a requeue. A PR with no
// mergeability answer has one limit before desk's one repair and one after it.
export const WAITS = Object.freeze({
  mergeability: { ms: 2 * UNKNOWN_LIMIT_MS, escalate_to: 'person' },
  handoff: { ms: 15 * MIN, escalate_to: 'requeue' },
  progress: { ms: 45 * MIN, escalate_to: 'person' },
});
// Stage 5 alone has the longer progress deadline: one build turn there can run long with no commit.
export const EVIDENCE_PROGRESS_MS = 90 * MIN;
const progressMs = (stage) => (parseInt(stage, 10) === 5 ? EVIDENCE_PROGRESS_MS : WAITS.progress.ms);

const MERGE_REF = /^merge ref: (.+)$/;

// What ticket `t` waits on at `at`: { <on>: { id (what identifies that wait), since (where another step
// first saw it), ms (its deadline, where not WAITS'), owner (whether another step decides when it is the person's), said (that step's
// words once it has: '' where that step says them itself) } }.
export function waitsOf(t, at) {
  const now = {};
  const s = prStatusOf(t);
  if (s?.state === 'OPEN' && s.mergeable === 'UNKNOWN') {
    const spell = s.isDraft === true ? unknownSpell(t.undraft, s.pr, s.head) : null;
    const note = s.isDraft === true ? null : MERGE_REF.exec(String(t.merge_blocked ?? ''));
    now.mergeability = {
      id: { pr: s.pr },
      ...(spell ? { since: spell.unknown_since } : {}),
      owner: !!spell,
      said: spell?.call === 'person' ? '' : note ? note[1] : null,
    };
  }
  if (t.state === 'triaged' && toHandoff(t)) now.handoff = { id: { stage: String(t.handoff_stage ?? '?') }, owner: false, said: null };
  if (t.state === 'running' && !t.usage_paused && Date.parse(t.progress_at) < Date.parse(at)) {
    // Progress made this pass (after the pass started) closes the wait, and the next pass with none opens
    // one from it. Progress a pass recorded and then ended before this sweep is a new stage or head, so a
    // new wait too. A suite wait the advance step holds owns it, and moves progress_at on once it ends, so
    // the wait follows progress_at until it is escalated. A usage hold opens none: the clock starts again
    // when it lifts.
    const stage = String(t.stage ?? '?');
    const read = t.progress_sha && typeof t.progress_sha === 'object' ? t.progress_sha : {};
    now.progress = { id: { stage, head: read.head ?? null, pushed: read.pushed ?? null }, since: t.progress_at, follows: true, ms: progressMs(stage), owner: t.suite_wait_since != null, said: null };
  }
  return now;
}

const minsSince = (since, at) => Math.max(0, Math.floor((Date.parse(at) - Date.parse(since)) / MIN));

// The WAITING ON YOU line for ticket `t`'s escalated wait `w` on `on` at `at`, or null where its owner
// says it. `said` is the owner's words, or null.
function escalation(t, on, w, said, at) {
  const mins = minsSince(w.since, at);
  const limit = minsSince(w.since, w.deadline);
  if (on === 'mergeability') {
    if (said === '') return null;
    return `${t.key}: NO MERGE ANSWER — PR #${w.pr}: ${said ?? `GitHub has not worked out whether it conflicts with its base for ${mins} minutes, since ${w.since}, past its ${limit}-minute deadline; ${freshMergeRef(w.pr)}`}`;
  }
  if (on === 'progress') {
    return `${t.key}: NOT PROGRESSING — its worker at Stage ${w.stage} has made no stage change, commit or push for ${mins} minutes, since ${w.since}, past its ${limit}-minute deadline, ` +
      'though its log may still grow (a hung call heartbeats into it). Desk leaves it running: read its log to see what it is doing';
  }
  return `${t.key}: HANDOFF NOT STARTED — its Stage ${w.stage} session has not started ${mins} minutes after its handoff, since ${w.since}, past its ${limit}-minute deadline. ` +
    `If nothing in this report holds it back (a slot, memory, a usage limit), requeue it: queue.mjs requeue ${t.key}`;
}

// Ticket `t`'s waits after this pass, and the lines for those escalated at `at`. A wait still open keeps
// its start, deadline and escalation; a wait on another PR or stage is a new one. One past its deadline,
// or made the person's by its owner, is escalated once, and its line said while it stays open.
export function nextWaits(t, at) {
  const was = t.waits && typeof t.waits === 'object' ? t.waits : {};
  const next = {};
  const lines = [];
  for (const [on, { id, since: first, follows = false, ms = WAITS[on].ms, owner, said }] of Object.entries(waitsOf(t, at))) {
    const matched = was[on] && Object.entries(id).every(([k, v]) => was[on][k] === v) ? was[on] : null;
    // A wait that follows its start keeps it only once escalated: until then its start and deadline move with it.
    const open = matched && !(follows && !matched.escalated) ? matched : null;
    const since = open?.since ?? (Number.isFinite(Date.parse(first)) ? first : at);
    let w = open ?? { since, deadline: new Date(Date.parse(since) + ms).toISOString(), escalate_to: WAITS[on].escalate_to, ...id };
    const due = said != null || (!owner && Date.parse(at) >= Date.parse(w.deadline));
    if (!w.escalated && due) w = { ...w, escalated: at };
    const line = w.escalated ? escalation(t, on, w, said, at) : null;
    if (line) lines.push(line);
    next[on] = w;
  }
  return { waits: next, lines };
}

// The red base under a batch (pass/base-gate.mjs decideBaseRed) is a wait of the batch's, kept as the
// queue's `base_red`, with its deadline BASE_RED_MS after it began. -> { rec, line }: past its deadline
// it is escalated to the person once (`escalated`, kept on the record), and its WAITING ON YOU line is
// said while it stays red, as a ticket's escalated wait's is, led by the branch and its class so the
// decider keys it as one item while its minutes grow (decider.mjs waitKey). Before it, line is null.
export const BASE_RED_MS = 60 * MIN;
export function baseRedWait(rec, at) {
  if (!rec.escalated && Date.parse(at) < Date.parse(rec.deadline)) return { rec, line: null };
  const w = rec.escalated ? rec : { ...rec, escalated: at };
  const merges = w.merges?.length ? w.merges.map((m) => `#${m.pr}${m.ticket ? ` (${m.ticket})` : ''}`).join(', ') : 'none in the merge log';
  return { rec: w, line: `${w.branch}: RED BASE — it has been red for ${minsSince(w.since, at)} minutes, since ${w.since}, past its ${minsSince(w.since, w.deadline)}-minute deadline: ` +
    `${w.check} still fails there, so the merge driver merges nothing into it. The last merges desk made: ${merges}` };
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
