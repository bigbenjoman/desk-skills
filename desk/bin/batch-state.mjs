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

// An epic admitted with no session (epic-plan.mjs), parked in its own feature batch until the person
// answers its drafted plan; its children are held behind it.
export const FEATURE_PLAN_PREFIX = 'feature plan awaiting your answer';
export const planPark = (t) => t?.state === 'parked' && String(t.park?.question ?? '').startsWith(FEATURE_PLAN_PREFIX);

// Why a triage record's design is not one a worker can build from, or null when its Design section
// links at least one Claude Design canvas and each is saved on the batch's base or snapshotted
// (ticket-facts.mjs records `design`).
export function designGap(r) {
  if (r?.design_error) return `its design could not be read (${r.design_error})`;
  const d = r?.design;
  if (!d) return 'its design was never read: re-run triage';
  const missing = unreadCanvases(r);
  if (missing.length) return `its canvas is not on ${d.ref}: save ${missing.join(', ')} there (desk-design save), or snapshot it`;
  if (!(d.canvases ?? []).length) return d.figma ? 'its only design is a Figma frame, which a worker cannot read' : 'it links no Claude Design canvas';
  return null;
}

// The Claude Design canvases a triage record links that a worker cannot read: neither saved on the
// base nor snapshotted.
export function unreadCanvases(r) {
  return (r?.design?.canvases ?? []).filter((c) => !c.saved && !c.snapshot).map((c) => c.url);
}

// The park for a ticket in any lane whose design no worker can read, or null: a session that can read
// the artifact snapshots it, since a worker has no Artifact tool and would only park asking for it.
export function designPark(r) {
  const urls = unreadCanvases(r);
  return urls.length
    ? `design not snapshotted: ${urls.join(', ')}: snapshot it from a session that can read it (/desk-admit does), or have it shared with that subscription, then resume`
    : null;
}

// Lane C always needs a person before code; lane D only while its design is not saved where a worker
// can read it.
export const needsPersonLane = (r) => r?.lane === 'C' || (r?.lane === 'D' && designGap(r) !== null);

// A park that puts its ticket in lane C, or lane D with its canvas not saved where a worker can read
// it: a requeue only parks it again. "not lane C" or "from lane C" rules the lane out.
const LANE_C = /(?<!\b(?:not|from|no longer|than) )\blane C\b/i;
const LANE_D = /(?<!\b(?:not|from|no longer|than) )\blane D\b/i;
const NO_CANVAS = /\bcanvas (?:is |was )?not (?:saved|on)\b|\bno saved canvas\b|\blinks no Claude Design canvas\b|\bonly (?:in|design is a) Figma\b/i;
export const sessionPark = (question) => LANE_C.test(question) || (LANE_D.test(question) && NO_CANVAS.test(question));

// A queue ticket only an interactive session takes on: lane C, one parked at triage on its lane, or
// one whose worker parked it in lane C or a canvas-less lane D. Any other lane D park is requeued.
export const needsSession = (t) => t?.lane === 'C' || /^lane [CD]\b/.test(t?.park?.question ?? '') || sessionPark(String(t?.park?.question ?? ''));

// A parked lane C or D triage record whose lane challenge could not read the code (triage.sh's
// INCONCLUSIVE): one unchecked opinion, which the user confirms or re-lanes rather than reading as settled.
export const laneUnchecked = (r) => needsPersonLane(r) && r.lane_challenge?.verdict === 'INCONCLUSIVE';

// The park question for a lane C or D triage record that needs a person, or null for any other.
// plan-batch and queue.mjs admit both seed a ticket's park from it.
export function lanePark(r) {
  if (!needsPersonLane(r)) return null;
  const reason = String(r.lane_reason ?? 'needs a person');
  const why = r.lane === 'D' ? `${designGap(r)}; ${reason}` : reason;
  return laneUnchecked(r)
    ? `lane ${r.lane} UNCHECKED (challenge could not read the code): confirm lane ${r.lane} or re-lane — ${why.slice(0, 120)}`
    : `lane ${r.lane} — ${why.slice(0, 160)}`;
}

// Where a held ticket's hold leads: the parked or failed tickets it waits on, an empty list when every
// predecessor is progressing (running, waiting to spawn, done with a PR that is open, or itself held
// and going somewhere) or merged (done with a merged PR: the release is due), or null when one
// predecessor can never get there and nobody is already being asked about it (finished with no PR, a
// PR closed unmerged, never admitted, dropped or missing), and for a hold with no recorded blocker.
// A predecessor failed or parked for a reason of its own is already a question for the person, so the
// tickets behind it wait on that answer. `prState(n)` gives a PR's state when the caller looked it up
// ('OPEN' | 'MERGED' | 'CLOSED'); unknown counts as open.
function holdLeadsTo(q, t, prState, seen) {
  // `seen` is the current path only: a ticket on it again is a hold cycle (a hand-edited queue), which
  // can never release. Two paths meeting at one held ticket (a diamond) is normal and is followed.
  if (!isHeld(t) || seen.has(t)) return null;
  seen.add(t);
  const preds = String(t.held_by ?? '').split('|').filter(Boolean);
  let parks = preds.length > 0 ? [] : null;
  for (const p of preds) {
    const pt = q.tickets?.[p];
    if (!pt) parks = null;
    else if (['running', 'triaged'].includes(pt.state) || spinePark(pt)) continue;
    else if (pt.state === 'done') { if (pt.result?.pr == null || prState(pt.result.pr) === 'CLOSED') parks = null; }
    else if (pt.state === 'failed' || (pt.state === 'parked' && !isHeld(pt))) parks.push(p);
    else { const up = holdLeadsTo(q, pt, prState, seen); parks = up && [...parks, ...up]; }
    if (!parks) break;
  }
  seen.delete(t);
  return parks && [...new Set(parks)];
}

// A held ticket is still going somewhere on its own: every predecessor progressing or merged.
export const waitingOnMerge = (q, t, prState = () => null) => holdLeadsTo(q, t, prState, new Set())?.length === 0;

// The parked or failed tickets a held ticket waits on, or null: it waits on their answer, and is not a
// question of its own. Null too when it waits on a merge or is stuck.
export function waitingOnPark(q, t, prState = () => null) {
  const parks = holdLeadsTo(q, t, prState, new Set());
  return parks?.length ? parks : null;
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
