// What a batch's queue says about itself, shared by pass.mjs and queue.mjs. Pure: takes the parsed
// queue, reads nothing. Also the exit-code contract every orchestration script shares, and the one
// place they read the queue and triage records, so a corrupt file refuses the same way in all four.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// pass.mjs, plan-batch.mjs, queue.mjs and answer.mjs exit only with these, so the orchestrator branches
// on a number rather than on wording: go on; nothing to do yet, keep looping; show the person (an
// error, a refusal, a ticket that needs them, or a finished batch).
export const EXIT = Object.freeze({ GO_ON: 0, NOTHING_YET: 10, SHOW_PERSON: 11 });

// A refusal the person can act on: thrown where a predictable bad input is met, it reaches them as its
// message, never as a stack.
export class Refusal extends Error {}
export const describeCrash = (e) => (e instanceof Refusal ? e.message : e?.stack ?? String(e));

// A JSON state file read at the point of use: a missing, unreadable or corrupt one refuses with the
// action that fixes it, never a bare JSON.parse stack.
export function readJsonOrRefuse(path, action) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new Refusal(`${path} could not be read (${e.code ?? e.message}): ${action}`); }
  try { return JSON.parse(text); } catch (e) { throw new Refusal(`${path} is not valid JSON (${e.message}): ${action}`); }
}
// The two every script reads: the batch queue and a ticket's triage record.
export const readQueue = (path) => readJsonOrRefuse(path,
  `restore it, or re-create ${path} (queue.mjs init <batch-name>, then re-seed it with plan-batch.mjs) — refusing to read it as an empty batch`);
export const readTriage = (stateDir, t) => readJsonOrRefuse(join(stateDir, 'triage', `${t}.json`), `re-run triage.sh ${t}`);

// The question a worker parked on and nobody has answered yet, or null: its park file's `question`
// while no answer file sits beside it. A half-written park file is not an error.
export function openQuestion(stateDir, t) {
  const park = join(stateDir, 'parks', `${t}.json`);
  if (!existsSync(park) || existsSync(join(stateDir, 'answers', `${t}.txt`))) return null;
  try { return JSON.parse(readFileSync(park, 'utf8')).question || null; } catch { return null; }
}

// A crash is a refusal like any other: it exits SHOW_PERSON, never node's own 1. `report` prints it.
export function crashShowsPerson(report = (e) => console.error(describeCrash(e))) {
  const die = (e) => { try { report(e); } finally { process.exit(EXIT.SHOW_PERSON); } };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
}

export const HELD_PREFIX = 'held by orchestrator';

// Parked "held by orchestrator" (a dependency chain, released by merge-driver.sh release_chain or by
// the one sanctioned manual release once every predecessor's PR has merged).
export const isHeld = (t) => t?.state === 'parked' && String(t.park?.question ?? '').startsWith(HELD_PREFIX);

// A feature spine pass.mjs parked once its worker finished: 'approval' when its specs passed the check
// (the person approves or rejects them), 'specs' when they did not (the person sends it back with a
// note). Either way the person is deciding about the spine, so what is held behind it is waiting on
// that, not stuck.
export const SPINE_APPROVAL_PREFIX = 'spine awaiting approval';
export const SPINE_SPECS_PREFIX = 'spine specs incomplete';
export function spinePark(t) {
  if (t?.state !== 'parked') return null;
  const s = String(t.park?.question ?? '');
  return s.startsWith(SPINE_APPROVAL_PREFIX) ? 'approval' : s.startsWith(SPINE_SPECS_PREFIX) ? 'specs' : null;
}

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
    if (['running', 'triaged'].includes(pt.state) || spinePark(pt)) return true;
    if (pt.state === 'done') return pt.result?.pr != null && prState(pt.result.pr) !== 'CLOSED';
    return waitingOnMerge(q, pt, prState, seen);
  });
  seen.delete(t);
  return ok;
}

// The batch's worker count and whose it is. `concurrency_by: 'user'` marks a count the user set,
// and `concurrency_user` keeps their number while the ladder lowers `concurrency` on memory, so the
// orchestrator can return to it. Never above the §3b cap.
export function batchConcurrency(q, { def, cap }) {
  const raw = Number(q.concurrency ?? def);
  const n = Math.min(raw, cap);
  const user = q.concurrency_by === 'user' ? Number(q.concurrency_user ?? raw) : null;
  const capped = raw > cap ? `, capped at the §3b cap of ${cap}` : '';
  const why = user == null ? (raw === def ? `the §3b default${capped}` : `set by the ladder (§3b default ${def})${capped}`)
    : raw === user ? `set by the user${capped}`
      : raw < user ? `lowered on memory from the user's ${user}${capped}: raise back to ${user} once memory allows`
        : `above the user's ${user}${capped}: the ladder keeps the user's number, so set it back to ${user}`;
  return { n, user, line: `workers: concurrency ${raw === n ? n : `${raw} → ${n}`}, ${why}` };
}

// Settled: nothing running, nothing left to spawn, nothing waiting on a merge to be released, and no
// spine waiting on the person's approval. A done ticket's own PR may still be open.
export function batchSettled(q, prState) {
  return Object.values(q.tickets ?? {}).every((t) => ['done', 'parked', 'failed'].includes(t.state) && !waitingOnMerge(q, t, prState) && !spinePark(t));
}

// Idle: settled, and every done ticket's PR merged or closed, so the merge driver has nothing left.
// A done ticket with no PR is finished; a PR whose state is unknown counts as open.
export function batchIdle(q, prState = () => null) {
  return batchSettled(q, prState) && Object.values(q.tickets ?? {})
    .every((t) => t.state !== 'done' || t.result?.pr == null || ['MERGED', 'CLOSED'].includes(prState(t.result.pr)));
}
