// A batch base that conflicts with the default branch goes to a conflict fix worker in the base's own
// worktree rather than to the person, where config §3 pr-conflict-unreviewed is `yes`: no reviewer has
// read the base as one change. Its push is the batch-base-push grant every sync needs. It gets at most
// FIX_TRIES_MAX tries, one per head of the base, as a PR in conflict does (fix-tries.mjs).
//
// pass.mjs keeps the tries on the queue as `base_fix`:
//   { tries: [{ try, head, source, files, at, session, outcome }], running: <session id> | null }
// and asks baseFixCall what to do whenever the sync, or the base gate, meets the conflict:
//
//   spawn   start try `fix.try` in the base worktree
//   wait    the running try's worker is still live
//   stuck   no try is left: the person resolves it, and `why` names the last try's outcome
//   person  §3 does not let a worker resolve it
import { FIX_TRIES_MAX, tries, triesSpent } from './fix-tries.mjs';

export { FIX_TRIES_MAX };

const short = (sha) => String(sha ?? '?').slice(0, 12);
const fileList = (files) => (files?.length ? files.join(', ') : 'not listed');

// rec: the queue's base_fix, or null. c: { head (origin's base), source (origin's default branch),
// files, perm (§3 pr-conflict-unreviewed), alive (the running try's worker is live) }. A try already
// made at this head is one whose worker finished without moving the base.
export function baseFixCall(rec, c) {
  if (c.perm !== 'yes') return { call: 'person', why: `config §3 pr-conflict-unreviewed is "${c.perm}", so no worker resolves it` };
  const done = rec?.tries ?? [];
  const last = done[done.length - 1] ?? null;
  if (rec?.running && c.alive) return { call: 'wait', try: last };
  if (triesSpent(done, c.head)) {
    return { call: 'stuck', why: `still in conflict after ${tries(done.length)}${last?.outcome ? `; the last try ${last.outcome}` : ''}` };
  }
  return { call: 'spawn', fix: { try: done.length + 1, of: FIX_TRIES_MAX, head: c.head, source: c.source, files: c.files ?? null } };
}

// What a finished try's worker left, from its log's markers (harvest.mjs workerMarkers): its last
// park, else its last done, else that it said neither.
export function baseFixOutcome(markers) {
  const last = (k) => [...(markers ?? [])].reverse().find(([m]) => m === k)?.[1]?.trim();
  const park = last('AUTOPILOT_PARK');
  if (park) return `parked: ${park}`;
  const done = last('AUTOPILOT_DONE');
  return done ? `finished: ${done}` : 'ended with no marker';
}

// The ticket file the worker reads as its ticket ($DESK_STATE/tickets/<key>.md).
export function baseFixTicket({ key, base, source, fix }) {
  return [
    `# ${key}`, '',
    `Source: the autopilot pass, which met a conflict merging ${source} into this batch's base ${base}`, '',
    `Merging origin/${source} into ${base} conflicts, so the pass cannot sync the base. Conflicting files: ${fileList(fix.files)}.`, '',
    'Acceptance criteria:',
    `- origin/${base} holds origin/${source}, through a merge commit, with every conflict resolved and both sides' intent kept.`,
    `- The batch's tests pass on the merged ${base}.`, '',
  ].join('\n');
}

// The worker's briefing section.
export function baseFixBrief({ base, source, fix }) {
  return [
    `## Base conflict fix try ${fix.try} of ${fix.of}: ${base}`, '',
    `Merging origin/${source} (at ${short(fix.source)}) into ${base} (at ${short(fix.head)}) conflicts, so the pass cannot sync the base, and in feature mode no child spawns until it is synced.`,
    `Conflicting files: ${fileList(fix.files)}.`, '',
    `This is try ${fix.try} of ${fix.of}. A base still in conflict after try ${fix.of}, or after a try that leaves ${base} where it was, goes to the person.`, '',
  ].join('\n');
}

// The prompt the worker starts with (spawn-worker.sh's AUTOPILOT_TASK).
export function baseFixTask({ base, source, fix }) {
  return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET, this batch's base ${base}, which conflicts with ${source}. ` +
    `Your worktree is $WT, the base's own worktree, on ${base}. Your dev-server port is $PORT. ` +
    `Your task is conflict fix try ${fix.try} of ${fix.of} on ${base}: the "Base conflict fix" section of your briefing says what conflicts. ` +
    `Fix only that: git fetch origin, then merge origin/${source} into ${base} (git merge, never a rebase or a force push) and resolve the conflicts, keeping both sides' intent: this task is your authority to resolve them. ` +
    `Then verify the merged tree (desk-ticket Stage 4) and self-review the resolution (Stage 4b). Before you push, git log --oneline origin/${base}..HEAD --not origin/${source} must list only your merge commit and any commit that finishes it; anything else parks. ` +
    `Push with git push origin ${base}. Open no PR, and leave the promotion PR and every ticket's Jira as they are. End with AUTOPILOT_DONE: pr=none jira=none.`;
}
