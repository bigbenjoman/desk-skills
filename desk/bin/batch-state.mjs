// What a batch's queue says about itself, shared by pass.mjs and queue.mjs. Pure: takes the parsed
// queue, reads nothing. Also the exit-code contract every orchestration script shares, and the one
// place they read the queue and triage records, so a corrupt file refuses the same way in all four.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { personClears } from './clears-when.mjs';
import { attachArchive, mergedPrs } from './queue-store.mjs';
import { PARK_KINDS, blockersOf } from './queue-states.mjs';
import { postMergeUnmade } from './harvest.mjs';

// pass.mjs, plan-batch.mjs, queue.mjs and answer.mjs exit only with these, so the orchestrator branches
// on a number rather than on wording: go on; nothing to do yet, keep looping; show the person (an
// error, a refusal, a ticket that needs them, or a finished batch).
export const EXIT = Object.freeze({ GO_ON: 0, NOTHING_YET: 10, SHOW_PERSON: 11 });

// A refusal the person can act on: thrown where a predictable bad input is met, it reaches them as its
// message, never as a stack.
export class Refusal extends Error {}
export const describeCrash = (e) => (e instanceof Refusal ? e.message : e?.stack ?? String(e));

// The regex source that finds work id `k` in a PR's title or head branch: `issue-N` also as `#N`; any
// other id bounded so the slug after it (`fix/BUG-119-login`) matches and a longer id (`BUG-119-5`,
// `BUG-1190`) does not. merge-driver.sh and intake.mjs landedOn both match PRs with it.
export function keyPattern(k) {
  const n = /^issue-([0-9]+)$/.exec(k)?.[1];
  if (n) return `(^|[^A-Za-z0-9-])issue-${n}([^0-9]|$)|#${n}([^0-9]|$)`;
  return `(^|[^A-Za-z0-9-])${k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^A-Za-z0-9-]|-[^0-9])`;
}

// A JSON state file read at the point of use: a missing, unreadable or corrupt one refuses with the
// action that fixes it, never a bare JSON.parse stack.
export function readJsonOrRefuse(path, action) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new Refusal(`${path} could not be read (${e.code ?? e.message}): ${action}`); }
  try { return JSON.parse(text); } catch (e) { throw new Refusal(`${path} is not valid JSON (${e.message}): ${action}`); }
}
// The paths this module builds under a batch's state folder, `<KEY>` standing for the ticket. Every
// one goes through statePath, which refuses a name not declared here.
export const STATE_PATHS = Object.freeze({ triage: 'triage/<KEY>.json', parks: 'parks/<KEY>.json', answers: 'answers/<KEY>.txt' });
export function statePath(stateDir, name, key) {
  if (!Object.hasOwn(STATE_PATHS, name)) throw new Error(`not a declared state path: ${name}`);
  return join(stateDir, STATE_PATHS[name].split('<KEY>').join(key));
}
// The two every script reads: the batch queue and a ticket's triage record. A queue's archived tickets
// are found by key behind its live ones (queue-store.mjs attachArchive).
export const readQueue = (path) => attachArchive(readJsonOrRefuse(path,
  `restore it, or re-create ${path} (queue.mjs init <batch-name>, then re-seed it with plan-batch.mjs) — refusing to read it as an empty batch`), path);
export const readTriage = (stateDir, t) => readJsonOrRefuse(statePath(stateDir, 'triage', t), `re-run triage.sh ${t}`);
// A triage record's unknowns as text, each once, in its order.
export const unknownsOf = (unknowns) => [...new Set((Array.isArray(unknowns) ? unknowns : []).map((u) => String(u?.question ?? u ?? '').trim()).filter(Boolean))];
// Those of queue ticket `t` still open: less each one answer.mjs recorded answered (answered_questions).
export const openUnknowns = (unknowns, t) => {
  const done = new Set(Array.isArray(t?.answered_questions) ? t.answered_questions : []);
  return unknownsOf(unknowns).filter((u) => !done.has(u));
};

// The PR state the last pass recorded for a done ticket's PR (pr_status), or null when none was read.
// Nothing here calls GitHub.
export const prStatusOf = (t) => (t?.state === 'done' && t.result?.pr != null && t.pr_status?.pr === t.result.pr ? t.pr_status : null);

// merged_at keeps only a ticket's first merge, so a live ticket requeued after it is not merged on it: only
// its current PR merging counts (merge-driver.sh release_chain, queue.mjs requeue's own holds). Whether t,
// merged once, has gone round again since: waiting for its next worker (triaged or running, held behind its
// own blockers at the requeue, or failed before a worker spawned); respawned, in any state (merged_pr, which
// its spawn keeps); or, respawned before merged_pr was kept, done on a PR its status reads OPEN after
// merged_at, or done on a PR other than the one its status names. A status read before merged_at is from
// before the driver merged it, so it counts at once. A parked ticket never requeued (one a stop holds
// included), or a done one never respawned, keeps the merge it records. Never for an archived ticket.
const through = (t) => t.state === 'done' && (t.result?.pr == null || prStatusOf(t)?.state === 'MERGED');
// Waiting for its next worker: queued or running, held behind its blockers (held_by: a stop holds behind
// none), or failed before a worker spawned (a requeue clears session_id, and only a spawn sets it).
export const awaitingWorker = (t) => ['triaged', 'running'].includes(t.state)
  || (t.state === 'parked' && String(t.park?.question ?? '').startsWith('held by orchestrator') && blockersOf(t).length > 0)
  || (t.state === 'failed' && t.spawn_failed === true && !t.session_id);
const openLater = (t) => prStatusOf(t)?.state === 'OPEN' && Date.parse(t.pr_status.at) > Date.parse(t.merged_at);
// Done on a PR other than the one its status names: that status is from an earlier round.
const otherRound = (t) => t.state === 'done' && t.result?.pr != null && t.pr_status?.pr != null && Number(t.pr_status.pr) !== Number(t.result.pr);
export const reworked = (t) => !!t?.merged_at && !through(t) && (awaitingWorker(t) || mergedPrs(t).length > 0 || openLater(t) || otherRound(t));

// A ticket shipped outside its worker, recorded done: the `queue.mjs` arguments pass.mjs and
// needs-you.mjs both write. Where the queue's PR status is that PR's, it is marked merged as well, or the
// done ticket would read as an unmerged PR until the next pass reads GitHub.
export const shippedSet = (t, how, pr = null, mergedAt = null) => ['set', t.key, 'state=done', 'park=null', 'handoff=null', 'handoff_stage=null', 'resume=null',
  `result.summary=shipped outside its worker: ${how}`, ...(pr == null ? [] : [`result.pr=${pr}`]),
  ...(pr != null && Number(t.pr_status?.pr) === Number(pr) ? ['pr_status.state=MERGED', ...(mergedAt ? [`pr_status.merged_at=${mergedAt}`] : [])] : [])];

// A parked ticket recorded done on PR #pr, its park cleared: the `queue.mjs set` fields the pass writes
// when it opens a refused worker's draft itself, and queue.mjs finish when the orchestrator finished the
// last step. draft_pr only while the PR is a draft.
export const doneOnPr = (pr, { draft = false, summary }) => ['state=done', 'park=null', 'handoff_stage=null', `result.pr=${pr}`,
  ...(draft ? [`draft_pr=${pr}`] : []), `result.summary=${summary}`];

// The PR a parked ticket recorded: the one it opened, else its draft. A PR that merged before the
// ticket was requeued for more work (merged_at) belongs to that earlier work, not to this park.
export const ownPr = (t) => { const earlier = t.merged_at ? Number(t.result?.pr) : NaN; return [t.result?.pr, t.draft_pr].find((n) => n != null && Number(n) !== earlier) ?? null; };
// A parked ticket's own PR, when one merging leaves only its after-merge steps: none once a worker was
// sent back on it already (merged_tail), so a park of that worker's stays the person's.
export function mergedTailPr(t) {
  const pr = ownPr(t);
  return pr == null || Number(t.merged_tail) === Number(pr) ? null : Number(pr);
}
// The `queue.mjs` arguments that send it back for those steps alone, which pass.mjs and needs-you.mjs
// both run around their own `requeue`: `before` it (null when there is nothing to clear; a handoff
// stage would start it at that stage's work rather than the tail), on a `refused` requeue (the stage put
// back, and the PR marked so it is not tried again), and `after` it, which the briefing reads (pass.mjs
// writeBrief).
export function mergedTailSteps(t, pr, mergedAt = null) {
  const stage = t.handoff_stage != null ? [`handoff_stage=${t.handoff_stage}`] : [];
  const at = mergedAt ? ` at ${String(mergedAt).slice(0, 16).replace('T', ' ')} UTC` : '';
  return {
    before: stage.length ? ['set', t.key, 'handoff_stage=null'] : null,
    refused: ['set', t.key, `merged_tail=${pr}`, ...stage],
    after: ['set', t.key, `merged_tail=${pr}`,
      `cleared=${JSON.stringify({ what: `PR #${pr} merged${at}, and ${t.key} is not done in Jira yet`, tail: { pr, merged_at: mergedAt } })}`],
  };
}

// Why a worktree holds work origin lacks, read with `git` (its arguments -> stdout, or null when the read
// fails): uncommitted tracked changes, or commits its branch has not pushed. -> the reason; null when it
// has neither; undefined when git cannot say. pass.mjs holds a worktree on it, and needs-you.mjs list
// drops that hold once it reads null.
export function gitHold(wt, git) {
  const diff = git(['diff', '--name-only', 'HEAD']);
  if (diff == null) return undefined;
  const dirty = diff.split('\n').filter(Boolean);
  if (dirty.length) return `its worktree ${wt} has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? `, and ${dirty.length - 5} more` : ''})`;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return undefined;
  const ahead = git(['rev-list', '--count', `origin/${branch}..HEAD`]);
  if (ahead == null) return undefined;
  return Number(ahead) > 0 ? `its branch ${branch} is ${ahead} commit(s) ahead of origin/${branch}, not pushed` : null;
}
// A hold gitHold wrote: { wt } with the worktree its reason names (null where it names none), else null
// for a hold of another kind, such as another process working in the worktree.
const DIRTY_HOLD = /^its worktree (\S+) has uncommitted changes/;
const AHEAD_HOLD = /^its branch \S+ is \d+ commit\(s\) ahead of origin\//;
export const gitHeld = (why) => { const s = String(why ?? ''); return DIRTY_HOLD.test(s) ? { wt: DIRTY_HOLD.exec(s)[1] } : AHEAD_HOLD.test(s) ? { wt: null } : null; };

// A running batch as a ticket can be moved into it (queue.mjs transfer), and the batches `queue.mjs
// running` printed as those: { name, base, word }, the standing batch's name null and its word
// `standing`. needs-you's move action and the decider both offer these, in the one sentence moveOffer
// writes.
export const moveTarget = (b) => ({ name: b.name ?? null, base: b.base, word: b.name ?? 'standing' });
export const moveTargetsOf = (out) => JSON.parse(out).map(moveTarget);
export const targetsText = (ts) => (ts.length ? ts.map((b) => `${b.word} (on ${b.base})`).join(', ') : 'none');
export const moveOffer = (ts) => `move <batch> takes it out of this batch and queues it in another, its next worker on that base: ${targetsText(ts)}`;

// Ticket `key`'s park record, parsed, or null where it has none or it is half-written.
function readPark(stateDir, key) {
  try { return JSON.parse(readFileSync(statePath(stateDir, 'parks', key), 'utf8')); } catch { return null; }
}
// Ticket `key`'s park file as `file`, and as `rec` only where it is on `question`: a file on another
// question than the one parked on is an earlier round's, read as no file.
function currentPark(stateDir, key, question) {
  const file = readPark(stateDir, key);
  return { file, rec: file && String(file.question ?? '').trim() === String(question ?? '').trim() ? file : null };
}

// The question a worker parked on and nobody has answered yet, or null: its park file's `question`
// while no answer file sits beside it. A half-written park file is not an error.
export function openQuestion(stateDir, t) {
  if (existsSync(statePath(stateDir, 'answers', t))) return null;
  return readPark(stateDir, t)?.question || null;
}

// A park whose question says it holds a write awaiting approval (the worker contract's wording for a
// write config §3 does not grant: a Jira comment, transition or edit, a PR body or review).
export const asksApproval = (question) => /\bawaiting (?:your )?approval\b/i.test(String(question ?? ''));
const APPROVE_FIELDS = ['kind', 'target', 'body'];
// The write ticket `key`'s park waits for the person to approve, from its park file's `approve`
// object: { approve: {kind, target, body}, missing: null }, the body kept verbatim. Where it has
// none and its question asks for an approval (or the object lacks a field), `approve` is null and
// `missing` names what the park file lacks, so the pass reports the park incomplete. Neither: both null.
// A file on another question than the one parked on is an earlier round's, read as no file. A PR
// number given as a number is its target as text.
export function parkApproval(stateDir, key, question) {
  const { file, rec } = currentPark(stateDir, key, question);
  const fileQ = String(file?.question ?? '').trim();
  const raw = rec?.approve && typeof rec.approve === 'object' ? rec.approve : null;
  const a = raw && typeof raw.target === 'number' ? { ...raw, target: String(raw.target) } : raw;
  const lacks = a ? APPROVE_FIELDS.filter((f) => typeof a[f] !== 'string' || !a[f].trim()) : APPROVE_FIELDS;
  if (a && !lacks.length) return { approve: { kind: a.kind.trim(), target: a.target.trim(), body: a.body }, missing: null };
  if (!a && !asksApproval(question)) return { approve: null, missing: null };
  return { approve: null, missing: a
    ? `its park file's approve object has no ${lacks.join(', ')}`
    : file?.approve && !rec
      ? `its park file is on another question ("${fileQ}") than the one parked on, so its approve is an earlier round's`
      : 'its park file carries no approve object ({"kind", "target", "body"}) holding the exact text to approve' };
}

// The fields a worker's park file declares: its question, and the write it awaits approval of.
const PARK_FILE_FIELDS = Object.freeze({ question: null, approve: Object.freeze([...APPROVE_FIELDS]) });
// What a park file holds that it does not declare, as the pass logs it, or null where it holds nothing
// else. It never refuses a park: a worker written before a field changed still parks.
export function validatePark(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const extra = Object.keys(rec).filter((k) => !Object.hasOwn(PARK_FILE_FIELDS, k));
  const a = rec.approve;
  if (a && typeof a === 'object' && !Array.isArray(a)) extra.push(...Object.keys(a).filter((k) => !PARK_FILE_FIELDS.approve.includes(k)).map((k) => `approve.${k}`));
  return extra.length ? `its park file holds ${extra.length === 1 ? 'a field' : 'fields'} the park file does not declare: ${extra.join(', ')}` : null;
}
// validatePark on ticket `key`'s park file; null where it has none, it is half-written, or it is on
// another question than the one parked on.
export const parkFileFault = (stateDir, key, question) => validatePark(currentPark(stateDir, key, question).rec);

// The text a park awaits approval of, as both needs-you and the pass report relay it: its kind and
// target, then the body as JSON so its line breaks survive on one line.
export const approvalText = (ap) => `its exact text (${ap.kind}${ap.target ? ` on ${ap.target}` : ''}, as JSON): ${JSON.stringify(ap.body)}`;

// Why a failed ticket's worker stopped, never empty: the reason the pass recorded (`failed.why`), else
// a park the ticket kept, else that none was recorded.
export const failedWhy = (t) => String(t?.failed?.why ?? '').trim() || String(t?.park?.question ?? '').trim()
  || `no reason was recorded: read its worker log, logs/${t?.key ?? '<KEY>'}.log`;

// A crash is a refusal like any other: it exits SHOW_PERSON, never node's own 1. `report` prints it.
export function crashShowsPerson(report = (e) => console.error(describeCrash(e))) {
  const die = (e) => { try { report(e); } finally { process.exit(EXIT.SHOW_PERSON); } };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
}

// How long an idle batch with anything parked, failed or held outside goes without a pass
// (supervisor.mjs), and how long a pass goes without asking GitHub again whether a ticket's outside
// blockers landed (pass/parks.mjs decideOutsideHolds): a busy batch passes every tick.
export const IDLE_RECHECK_MS = Number(process.env.DESK_IDLE_RECHECK_MS) || 30 * 60 * 1000;

export const HELD_PREFIX = 'held by orchestrator';
// A held ticket whose worker queue.mjs stop ended: held behind no blocker, so only the person starts it.
export const STOPPED_PREFIX = `${HELD_PREFIX}: stopped by queue.mjs stop`;
// The park kinds the orchestrator holds a ticket on, rather than its own step: a blocker, a stop, a date.
const HELD_KINDS = ['hold', 'stopped', 'date'];

// The kind of park `question` opens as: what a park recorded before parks carried their kind is read
// as, and what a new park whose writer names none is recorded as.
export function parkKindOf(question) {
  const q = String(question ?? '');
  if (q.startsWith(STOPPED_PREFIX)) return 'stopped';
  // A blocked-until label's hold (pass/parks.mjs), its date read or not (badLabelText).
  if (q.startsWith(`${HELD_PREFIX}: blocked until `) || q.startsWith(`${HELD_PREFIX}: its label `)) return 'date';
  if (q.startsWith(HELD_PREFIX)) return 'hold';
  if (q.startsWith(PERSON_STEP_PREFIX)) return 'person-step';
  return 'question';
}
// Ticket `t`'s park kind: the one its park records, else the one its question opens as.
export const parkKind = (t) => (PARK_KINDS.includes(t?.park?.kind) ? t.park.kind : parkKindOf(t?.park?.question));

export const stoppedHold = (t) => t?.state === 'parked' && !blockersOf(t).length && parkKind(t) === 'stopped';

// Parked on a hold, a stop or a date (a dependency chain, released by merge-driver.sh release_chain or by
// the one sanctioned manual release once every predecessor's PR has merged).
export const isHeld = (t) => t?.state === 'parked' && HELD_KINDS.includes(parkKind(t));

// Waiting behind the blockers in its held_by: held by the orchestrator, or parked at triage for its own
// reason (triagePark) with holds kept beside the park. Every reader that follows a chain of holds asks
// this, so a lane C or D, size, design or step park held behind a sibling reads as held to all of them.
export const holdsKept = (t) => isHeld(t) || (triagePark(t) && blockersOf(t).length > 0);

// A blocker outside the batch Done this long with its code merged only into another branch is raised to
// the person (pass/parks.mjs `unpromoted`, needs-you's unpromoted item).
export const UNPROMOTED_AFTER_MS = 24 * 3600_000;
// The blockers ticket `t` is still held behind outside its batch that the pass recorded as merged only
// into another branch, Done UNPROMOTED_AFTER_MS or more by `now`: [[key, {branch, pr, state, since, promote?}]].
export const unpromotedHolds = (t, now = Date.now()) => (holdsKept(t) ? Object.entries(t.unpromoted ?? {}) : [])
  .filter(([b, u]) => u?.branch && blockersOf(t).includes(b) && String(t.held_outside ?? '').split('|').includes(b)
    && now - Date.parse(u.since) >= UNPROMOTED_AFTER_MS);
// An unpromoted record's promotion PR state as words: "a draft", "open" or "red".
export const promotionState = (u) => (u.state === 'draft' ? 'a draft' : u.state);
// An unpromoted record's promotion PR: "no promotion PR", or "promotion PR #N, a draft" / ", open" / ", red".
export const promotionWords = (u) => (u.pr == null ? 'no promotion PR' : `promotion PR #${u.pr}, ${promotionState(u)}`);

// The keys of `q`'s held tickets that wait behind `key`: held by it, or by a ticket held behind it.
export function heldBehindOf(q, key) {
  const held = Object.values(q?.tickets ?? {}).filter((o) => o.key !== key && holdsKept(o));
  const behind = new Set();
  for (let edge = new Set([key]); edge.size;) {
    const next = held.filter((o) => !behind.has(o.key) && blockersOf(o).some((k) => edge.has(k))).map((o) => o.key);
    next.forEach((k) => behind.add(k));
    edge = new Set(next);
  }
  return behind;
}

// A label that holds a ticket until a calendar day, read on this machine's local date.
const UNTIL_LABEL = /^blocked-until-(.*)$/i;
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The YYYY-MM-DD day a blocked-until label names, or null when that is not a real day.
export function untilDay(label) {
  const m = UNTIL_LABEL.exec(String(label ?? '').trim());
  const d = m && /^(\d{4})-(\d{2})-(\d{2})$/.exec(m[1]);
  if (!d) return null;
  const at = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
  return at.getUTCMonth() === Number(d[2]) - 1 && at.getUTCDate() === Number(d[3]) ? m[1] : null;
}
// The hold a ticket's labels ask for: { label, bad: true } for a blocked-until label whose date cannot
// be read (it wins), else { label, until } for the latest day one names, else null.
export function dateHoldOf(labels) {
  const own = (Array.isArray(labels) ? labels : []).map(String).filter((l) => UNTIL_LABEL.test(l.trim()));
  const bad = own.find((l) => !untilDay(l));
  if (bad) return { label: bad, bad: true };
  return own.map((l) => ({ label: l, until: untilDay(l) })).sort((a, b) => b.until.localeCompare(a.until))[0] ?? null;
}
// A ticket pass.mjs holds on its blocked-until label (held_label), as dateHoldOf reads it, or null. A
// ticket held behind blockers too waits on them first (queue.mjs hold clears held_label), and the pass
// reads its label again once they release it. A stopped ticket is held on no date: the held_label a
// release left behind stays, so its start is not held again on that label, but never starts it.
export const dateHeld = (t) => (isHeld(t) && !stoppedHold(t) && t.held_label && !blockersOf(t).length ? dateHoldOf([t.held_label]) : null);
// What the person is told about a blocked-until label whose date cannot be read.
export const badLabelText = (label) => `its label ${label} names no date desk can read (blocked-until-YYYY-MM-DD): fix the label and re-run triage.sh, or let it start`;

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

// A ticket left in a finished feature batch, parked by the archive check (batch.mjs archiveCheck) with
// any earlier park kept behind this prefix. Only the person moves or drops it: no requeue, recorded
// condition or recommended take may start it in the finished batch.
export const LEFT_PREFIX = 'left in batch ';
export const leftPark = (t) => t?.state === 'parked' && String(t.park?.question ?? '').startsWith(LEFT_PREFIX);

// A park waiting on the §4 Live reads it named (live-read.mjs), which a pass runs on the host and
// settles: it waits on the pass, not on the person.
export const LIVE_READ = 'live-read';
export const waitingOnRead = (t) => t?.state === 'parked' && t.park?.clears_when?.kind === LIVE_READ;

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
const DESIGN_PARK_PREFIX = 'design not snapshotted: ';
export function designPark(r) {
  const urls = unreadCanvases(r);
  return urls.length
    ? `${DESIGN_PARK_PREFIX}${urls.join(', ')}: snapshot it from a session that can read it (/desk-admit does), or have it shared with that subscription, then resume`
    : null;
}

// Lane C always needs a person before code; lane D only while its design is not saved where a worker
// can read it.
export const needsPersonLane = (r) => r?.lane === 'C' || (r?.lane === 'D' && designGap(r) !== null);

// ---- one-off grants: a step the person approved in an answer to a park, carried to the next worker's
// settings for that one step and nothing wider. A park names the step its worker was refused:
//   - a force-push of the ticket's own branch may be granted once: answer.mjs records an approving
//     answer as the ticket's `grant`, and worker-settings.mjs allows one exact
//     `git push --force-with-lease=<branch>:<lease> origin <branch>`.
//   - a step worker settings never allow, whatever §3 or an answer says (aws, ssm, curl, wget,
//     `gh api`, a write under `.claude/`) is a session's: a requeue only parks it again (sessionPark).
const SHA = /^[0-9a-f]{40}$/;
// Each needs a word saying the worker could not do it, so a park mentioning the tool in passing is not caught.
// "needs" counts only right before the tool ("needs curl"): most questions say need somewhere.
// The CLI's name, a full path to it included, not a package scope or directory that holds it
// ("@aws-sdk/client-s3" is a dependency; "/opt/homebrew/bin/aws" is the CLI).
const NEVER = [['aws', /(?<![@\w-])aws\b(?![-/])/i], ['ssm', /(?<![@\w-])ssm\b(?![-/])/i], ['curl', /\bcurl\b/], ['wget', /\bwget\b/], ['gh api', /\bgh api\b/],
  ['.claude/ write', /(?:^|[^\w.])\.claude\//]];
const REFUSED = /\b(?:refus\w*|denied|den(?:y|ies)|not (?:allowed|granted|permitted)|blocked|can(?:not|'t) (?:run|use|reach|write|call))\b|\bneed(?:s|ed)? (?:the |to (?:run|use) )?(?:aws|ssm|curl|wget|gh api)\b/i;
const FORCE_PUSH = /\bforce[- ]?push\w*|\bforce-with-lease\b/i;

// The step a park's question says its worker was refused, { step, grantable }, or null. A step no
// worker is allowed wins over a grantable one: the worker cannot finish either way.
export function refusedStep(question) {
  const q = String(question ?? '');
  if (REFUSED.test(q)) for (const [step, re] of NEVER) if (re.test(q)) return { step, grantable: false };
  return FORCE_PUSH.test(q) ? { step: 'force-push', grantable: true } : null;
}
export const neverStep = (question) => { const s = refusedStep(question); return s && !s.grantable ? s.step : null; };

// The SHA a park on `branch` says a force-push may overwrite, from the exact
// `--force-with-lease=<branch>:<sha>` in its question and its inputs' `lease`, or null when it names
// none, or two that differ: a yes cannot say which it meant. A question naming none takes the inputs'
// SHA, which the person does not see (a re-park's comes from its clears-when, withLeaseInput): the
// grant is still only for this branch, and only while origin is at that SHA (grantPush).
export function namedLease(park, branch) {
  const named = String(park?.inputs?.lease ?? '').trim();
  const leases = new Set([...String(park?.question ?? '').matchAll(/--force-with-lease=([^\s:`'"]+):([0-9a-f]{40})(?![0-9a-f])/g)].filter((m) => m[1] === branch).map((m) => m[2]));
  if (SHA.test(named)) leases.add(named);
  return leases.size === 1 ? [...leases][0] : null;
}

// Whether a park's question asks for a force-push, clause by clause, rather than mentions one: the
// clause says the push is needed, refused or wants approving (there or in the next clause), or gives
// its flag, and does not set it aside ("merge rather than force-push", "it was refused, so I merged").
// §3's row name is not a mention of a push. A miss costs less than a false match: a miss is an ordinary
// park the person sees, and a false match sends the park's real question back unasked.
const PUSH_ASKED = new RegExp(String.raw`${REFUSED.source}|\b(?:approv\w*|allow|grant|permission|authori[sz]e|need(?:s|ed)?|requires?|ok(?:ay)? to|may i|can i|should i|could i|shall i|want me to|please)\b|--force-with-lease\b|^\s*force[- ]?push\b.*\?\s*$`, 'i');
const PUSH_SET_ASIDE = /\b(?:rather than|instead(?! of (?:merg|rebas))|without (?:\w+ )?force[- ]?push\w*|avoid\w*|no need|(?:do|does|did|will|would)(?:n't| not) need|(?:is|was|are|were)(?:n't| not) (?:needed|required)|no (?:\S+ )?force[- ]?push\w*|never|so i(?:'ve| have)? (?:merged|rebased|went|used|kept)|or (?:merg|rebas)\w*|(?:merg|rebas)\w* or)\b/i;
const APPROVE_NEXT = /^\s*(?:please\s+)?(?:approve|confirm)\b/i;
export function asksForcePush(question) {
  const q = String(question ?? '').replace(/\bgit-force-with-lease\b/gi, '');
  if (!refusedStep(q)?.grantable) return false;
  return q.split(/(?<=[.?!;])\s+|\n+/).some((c, i, all) => FORCE_PUSH.test(c) && !PUSH_SET_ASIDE.test(c) && (PUSH_ASKED.test(c) || APPROVE_NEXT.test(all[i + 1] ?? '')));
}

// A park that asks for a force-push without naming the SHA it would overwrite: no grant can come from it.
export const unnamedForcePush = (park, branch) => asksForcePush(park?.question) && namedLease(park, branch) === null;

// The briefing section for the worker after such a park was refused, or null for any other round.
export function leaseRefusedBrief(t) {
  const question = t?.lease_refused?.question;
  if (!question || question !== t.prev_park?.question) return null;
  return `## Your last park was refused\n\nIt asked for a force-push and named no lease SHA, so no grant can come from it: ${question}\n` +
    `If you still need that push, park again with the exact \`git push --force-with-lease=${t.branch}:<sha> origin ${t.branch}\` in the question and \`"lease": "<sha>"\` in AUTOPILOT_PARK_INPUTS, <sha> being what \`git rev-parse origin/${t.branch}\` prints. If you do not, carry on without asking.\n`;
}

// An answer approves the step it answers only when it is nothing but a yes ("yes", "approved", "Yes,
// force-push it"): "Sure, merge instead" opens with one and approves nothing. Anything else takes --approve.
const YES_WORD = String.raw`(?:yes|yep|y|approved?|ok(?:ay)?|go ahead|do it|push it|force[- ]?push(?: it)?|confirmed?|granted|sure|please)`;
const YES = new RegExp(String.raw`^\s*${YES_WORD}(?:[\s,.!:;-]+${YES_WORD})*[\s.!]*$`, 'i');
export const approves = (text) => YES.test(String(text ?? ''));
// An answer approving a step it names no grant for: a bare yes, or one opening with a yes that holds
// back, redirects or puts off nothing ("Approved, go ahead and build it", not "Yes, but merge instead").
const OPENS_YES = new RegExp(String.raw`^\s*${YES_WORD}\b`, 'i');
const HOLDS_BACK = /\b(?:no|not|never|instead|rather|skip\w*|without|but|wait|hold off|later|only)\b|n't\b/i;
export const approvesStep = (text) => approves(text) || (OPENS_YES.test(String(text ?? '')) && !HOLDS_BACK.test(String(text ?? '')));

// The step a park says its worker cannot run, where no grant covers it and the question alone does not
// already make it a session's (sessionPark): a refused script or command, a staging write, a credential
// no worker is given. Named by the refusing sentence's first code span, else the question's, else its
// first script, else that sentence; null for any other park. A grantable force-push is a grant's, and a
// plain push or draft PR the pass finishes itself (recoveries.mjs pushPark), so neither is one. Nor is
// a park that offers to go on without the step ("shall I leave it out?"): a yes there approves that.
// Only a question the worker puts as its own offer counts, so "it cannot pass without the image" does not.
const OFFER = /\b(?:(?:shall|should|can|could|may) (?:i|we)|(?:do you )?want me to)\b/i;
const WITHOUT_STEP = /\b(?:instead|without|skip\w*|leave (?:\S+ ){0,3}out|drop(?:ped|ping)? (?:it|the|that|this))\b/i;
const offersWithout = (q) => q.split(/(?<=[.?!;])\s+|\n+/).some((c) => /\?\s*$/.test(c) && OFFER.test(c) && WITHOUT_STEP.test(c));
const TO_WORKER = /\b(?:refus\w*|denied|not (?:allowed|granted|permitted|given)|never (?:allowed|given|granted)|can(?:not|'t) (?:run|use|reach|hold|write|call)|no (?:headless )?worker (?:can|may|could|is allowed|holds?|is given))\b/i;
const PUSH_STEP = /\b(?:git push|gh pr|push(?:ed|ing|es)?|(?:draft )?PR)\b/i;
const CODE = /`([^`\n]+)`/;
const SCRIPT = /[\w./-]+\.(?:sh|mjs|js|py|ts)\b/;
export function workerRefusedStep(question) {
  const q = String(question ?? '');
  if (refusedStep(q)?.grantable || sessionPark(q) || offersWithout(q)) return null;
  const said = q.split(/(?<=[.?!;])\s+|\n+/).find((c) => TO_WORKER.test(c));
  if (!said) return null;
  const step = (CODE.exec(said)?.[1] ?? CODE.exec(q)?.[1] ?? SCRIPT.exec(q)?.[0] ?? said).trim();
  return PUSH_STEP.test(step) ? null : step.slice(0, 200);
}

// The grant an answer records on a parked ticket, { grant }, or { why } when it records none. The lease
// is the SHA the park names (namedLease), so the approval was of that one overwrite, and a grant is
// always pinned: only a pinned grant lets a pass make the push unattended (passLeaseGrant).
export function grantFor({ t, text, approve = false, now = new Date() }) {
  const step = refusedStep(t?.park?.question);
  if (t?.state !== 'parked' || !step) return { why: 'its park names no step a grant covers' };
  if (!step.grantable) return { why: `${step.step} is never a worker's, so only a session can do it` };
  if (!approve && !approves(text)) return { why: 'the answer approves nothing' };
  if (!approve && !asksForcePush(t.park.question)) return { why: 'its park only mentions a force-push, so a yes to it approves none (--approve says it does)' };
  const branch = String(t.branch ?? '').trim();
  if (!branch) return { why: 'the ticket records no branch to push' };
  const lease = namedLease(t.park, branch);
  if (!lease) return { why: `no lease SHA: the park names none, so requeue it for a worker to name the \`--force-with-lease=${branch}:<sha>\` it would overwrite` };
  return { grant: { step: step.step, branch, lease, at: now.toISOString(), pinned: true } };
}

// A park's inputs as the pass records them: a park whose clears-when is a lease push names the SHA it
// would overwrite in that condition, so its inputs carry it as `lease` where they name none. The
// condition is cleared to none when a pass may not make the push (pass.mjs pushParked), and the inputs
// keep the SHA, so a yes to the park is a pinned grant for that one overwrite. A lease the inputs
// already name is the worker's own and is kept.
export function withLeaseInput(inputs, cond) {
  const named = String(inputs?.lease ?? '').trim();
  if (named || cond?.kind !== 'push-ok' || !SHA.test(String(cond.lease ?? ''))) return inputs ?? {};
  return { ...(inputs ?? {}), lease: cond.lease };
}

// Whether a ticket's one-off grant lets a pass make a parked lease push (`c`, a push-ok condition with
// a lease) where config §3 git-force-with-lease is not yes: a pinned grant for that branch and that SHA.
export const passLeaseGrant = (grant, c) => grant?.step === 'force-push' && grant.pinned === true
  && SHA.test(String(grant.lease ?? '')) && grant.branch === c?.branch && grant.lease === c?.lease;

// The git arguments (after `git`) of the one push a grant allows on `branch`, or null. Spent once
// origin's branch (`remote`) has moved off the lease: git's own lease check then refuses the push, and
// the next worker's settings leave it out.
export function grantPush(grant, { branch, remote }) {
  if (grant?.step !== 'force-push' || grant.branch !== branch || !SHA.test(String(grant.lease ?? '')) || remote !== grant.lease) return null;
  return ` push --force-with-lease=${branch}:${grant.lease} origin ${branch}`;
}

// A park that puts its ticket in lane C, or lane D with its canvas not saved where a worker can read
// it, or that names a step no worker is ever allowed (neverStep): a requeue only parks it again.
// "not lane C" or "from lane C" rules the lane out.
const LANE_C = /(?<!\b(?:not|from|no longer|than) )\blane C\b/i;
const LANE_D = /(?<!\b(?:not|from|no longer|than) )\blane D\b/i;
const NO_CANVAS = /\bcanvas (?:is |was )?not (?:saved|on)\b|\bno saved canvas\b|\blinks no Claude Design canvas\b|\bonly (?:in|design is a) Figma\b/i;
export const sessionPark = (question) => LANE_C.test(question) || (LANE_D.test(question) && NO_CANVAS.test(question)) || neverStep(question) !== null;

// A park saying its ticket has no worker work left: it asks for the ticket to leave the queue, or says
// no worker has anything to do on it. A requeue only parks it again, so drop is its recommendation.
const NO_WORKER_WORK = /\bno (?:more |further )?worker work\b|\bnothing (?:left )?for (?:a |the |any )?worker\b|\b(?:take|drop|remove) (?:it|this(?: ticket)?|[A-Z][A-Z0-9]*-\d+) (?:off|out of|from) (?:the |its |this )?(?:autopilot )?(?:queue|batch)\b/i;
export const noWorkerWork = (question) => NO_WORKER_WORK.test(String(question ?? ''));

// The step a park says only a person or another account takes ("No worker can run it", "only a person
// with org access can do this", "only agent-pullbot can post it"), as the sentence that says so, or
// null. A requeue with no answer since only parks it again, and no action on it is the recommendation.
// It needs a step taken ("can run it"), never a call made ("only you can decide"), and no product role
// ("only admins can delete invoices"): a question the worker acts on once answered is not one.
const PERSON_ONLY = /\bno (?:headless |autopilot )?worker (?:can|could|is able to|is allowed to) (?:run|clear|do|post|finish|merge|push)\b|\bonly (?:an? |the )?(?:person|human|you|someone|another (?:account|login|user|person)|[\w-]+bot|bot account)(?![\w-])(?:(?!\b(?:can|could|whether|if|i|we)\b)[^.?!;\n]){0,80}?\b(?:can|could) (?:run|post|grant|merge|push|trigger|dispatch|clear|do|install|sign|log in)\b/i;
export const personOnlyStep = (question) => String(question ?? '').split(/(?<=[.?!;])\s+|\n+/)
  .find((c) => PERSON_ONLY.test(c))?.replace(/\s+/g, ' ').trim() ?? null;

// A queue ticket only an interactive session takes on: lane C, one parked at triage on its lane, or
// one whose worker parked it in lane C or a canvas-less lane D, or one whose park's step the person
// approved where no worker can run it (park.session_step, answer.mjs). Any other lane D park is requeued.
export const needsSession = (t) => t?.lane === 'C' || /^lane [CD]\b/.test(t?.park?.question ?? '') || sessionPark(String(t?.park?.question ?? '')) || !!t?.park?.session_step;

// Plan-first work: a lane C ticket parked at triage on its lane (lanePark's words), with nothing ahead
// of it, which only an interactive session takes on. A worker's own lane C park asks its own question,
// and one whose lane challenge could not read the code asks the person to confirm it, so neither is.
export const planFirst = (t) => t?.state === 'parked' && t.lane === 'C' && !isHeld(t) && !t.park?.session_step
  && !blockersOf(t).length && String(t.park?.question ?? '').startsWith(laneParkHead('C', false));
// The claim of the interactive session working a parked ticket in any lane (queue.mjs park --claimed-by),
// or null. That session works it, so nobody else is asked to; a pass drops the claim once the session
// has ended (pass.mjs). Once a pass finds uncommitted work behind it, the park's question says what to
// do, so the claim is no longer the news.
export const sessionClaim = (t) => (t?.state === 'parked' && !isHeld(t) && t.park?.claim?.session && !t.park.claim.dirty_at ? t.park.claim : null);
// The claim of the interactive session working a plan-first ticket, or null.
export const planFirstClaim = (t) => (planFirst(t) ? sessionClaim(t) : null);
// Whether unclaimed plan-first work has waited past `ms` since it parked, so the person hears of it.
export const planFirstDue = (t, ms, now = Date.now()) => planFirst(t) && !planFirstClaim(t)
  && now - (Date.parse(t.park?.since ?? '') || 0) > ms;
// The one item a batch's due plan-first tickets make, as needs-you lists it and the digest asks it: its
// lead words, and the not-now key it is put off under, which the same tickets in any order keep.
export const planFirstWaits = (keys) => `${keys.length} plan-first ticket${keys.length === 1 ? ' waits' : 's wait'} for a session`;
export const planFirstPutOff = (keys) => ({ question: 'plan-first waiting', inputs: { waiting: [...keys].sort().join(', ') } });

// A park a pass settles without the person: its recorded clears-when is one a script reads, no step of
// the person's makes it hold, and a worker rather than a session takes the ticket on once it does. A
// claimed park is its session's (pass.mjs clearable never settles one), so it is not one. Nor is it the
// person's while its clears-when is unreadable: that waits on the decider to restate it, and becomes
// none (theirs) once the decider has seen it, or a pass finds no restate came in time (clears-when.mjs
// RESTATE_MS). The digest and needs-you leave it out, and desk-q shows it as waiting.
export const settlesByScript = (t) => {
  const c = t?.park?.clears_when;
  return t?.state === 'parked' && !isHeld(t) && !t.park?.claim?.session && !!c?.kind && c.kind !== 'none' && !personClears(c) && !needsSession(t);
};

// A park a pass settles that waits on an Actions run or a PR's checks: those finish within minutes, so
// an idle batch holding one is rechecked every RUN_RECHECK_MS (supervisor.mjs), not IDLE_RECHECK_MS.
const RUN_KINDS = new Set(['run-completed', 'checks-pass']);
export const waitingOnRun = (t) => settlesByScript(t) && RUN_KINDS.has(t.park.clears_when.kind);
export const RUN_RECHECK_MS = Number(process.env.DESK_RUN_RECHECK_MS) || 2 * 60 * 1000;

// A parked lane C or D triage record whose lane challenge could not read the code (triage.sh's
// INCONCLUSIVE): one unchecked opinion, which the user confirms or re-lanes rather than reading as settled.
export const laneUnchecked = (r) => needsPersonLane(r) && r.lane_challenge?.verdict === 'INCONCLUSIVE';

// The park question for a lane C or D triage record that needs a person, or null for any other.
// plan-batch and queue.mjs admit both seed a ticket's park from it.
const laneParkHead = (lane, unchecked) => (unchecked ? `lane ${lane} UNCHECKED (` : `lane ${lane} — `);
export function lanePark(r) {
  if (!needsPersonLane(r)) return null;
  const reason = String(r.lane_reason ?? 'needs a person');
  const why = r.lane === 'D' ? `${designGap(r)}; ${reason}` : reason;
  return laneUnchecked(r)
    ? `${laneParkHead(r.lane, true)}challenge could not read the code): confirm lane ${r.lane} or re-lane — ${why.slice(0, 120)}`
    : `${laneParkHead(r.lane, false)}${why.slice(0, 160)}`;
}

// The park for a ticket sized L or XL, which is split rather than run whole, or null for any other size.
const OVERSIZED = ['L', 'XL'];
export const sizePark = (size) => {
  const s = String(size ?? '').toUpperCase();
  return OVERSIZED.includes(s) ? `size ${s} — split it before batching` : null;
};

// The first of `labels` that a labels row names (`stepLabels`, lowercased), or null.
export function stepLabel(labels, stepLabels = []) {
  const want = new Set((stepLabels ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  return want.size ? (Array.isArray(labels) ? labels : []).find((l) => want.has(String(l).trim().toLowerCase())) ?? null : null;
}

// The park for a ticket labelled as the person's own step, by §4 Person-step labels (`stepLabels`) or
// Person-input labels (`inputLabels`) on its triage record's `labels`, or null. It is admitted parked on
// it, beside lanePark and designPark, so no worker spawns and Needs you lists it.
const PERSON_STEP_PREFIX ="the person's step: ";
const INPUT_ROW = '(config §4 Person-input labels)';
export function labelPark(r, stepLabels = [], inputLabels = []) {
  const input = stepLabel(r?.labels, inputLabels);
  const l = input ?? stepLabel(r?.labels, stepLabels);
  return l ? `${PERSON_STEP_PREFIX}labelled ${l} ${input ? INPUT_ROW : '(config §4 Person-step labels)'}, so no worker can do it. Take the step, mark it Done in Jira, then drop it from the batch` : null;
}
export const personStepPark = (t) => t?.state === 'parked' && parkKind(t) === 'person-step';
// A queue ticket parked at triage for its own reason (lanePark, designPark, sizePark, labelPark): a hold
// waits beside that park rather than replacing it, so no release sends it to a worker.
export const triagePark = (t) => {
  const q = String(t?.park?.question ?? '');
  return t?.state === 'parked' && (personStepPark(t) || q.startsWith(DESIGN_PARK_PREFIX)
    || OVERSIZED.some((s) => q.startsWith(sizePark(s)))
    || ['C', 'D'].some((l) => q.startsWith(laneParkHead(l, true)) || q.startsWith(laneParkHead(l, false))));
};
// A person's step parked on a Person-input label: what it makes, the build reads, so a ticket it blocks
// is held behind it, never merged after it.
export const personInputPark = (t) => personStepPark(t) && String(t.park.question).includes(INPUT_ROW);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
// Whether `text` holds `phrase` whole, not as part of a longer word or key.
const holdsWhole = (text, phrase) => !!phrase && new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(phrase)}(?![\\p{L}\\p{N}_]|-\\p{N})`, 'iu').test(text);

// How blocker `b` (a triage record's `blockers` entry) holds the ticket whose triage record is `rec`,
// when it is a step only the person takes: 'build' when it carries one of §4 Person-input labels
// (`inputLabels`), as its step produces something the build reads, which wins over everything below;
// 'merge' when it carries one of §4 Person-step labels (`stepLabels`), when one of `rec`'s ben_steps
// names its key or holds its whole summary, or when it is a Task whose summary says apply, confirm or
// sign off; otherwise null, an ordinary blocker. Labels come from ticket-facts.mjs.
const STEP_WORDS = /\b(appl(?:y|ies|ied)|confirm(?:s|ed)?|sign(?:s|ed)?[- ]?off)\b/i;
export function personStep(b, rec = null, stepLabels = [], inputLabels = []) {
  if (stepLabel(b?.labels, inputLabels)) return 'build';
  if (stepLabel(b?.labels, stepLabels)) return 'merge';
  const key = squash(b?.key);
  const summary = squash(b?.summary);
  const named = (Array.isArray(rec?.ben_steps) ? rec.ben_steps : [])
    .some((s) => [s?.step, s?.blocker].some((x) => holdsWhole(squash(x), key) || holdsWhole(squash(x), summary)));
  return named || (/^task$/i.test(squash(b?.type)) && STEP_WORDS.test(summary)) ? 'merge' : null;
}

// Triage's call on each open blocker (`blocker_needs`): the ticket needs it to build, needs it only to
// merge, or does not need it.
export const BLOCKER_CALLS = ['build', 'merge', 'none'];
// Triage's call on blocker `key` in triage record `rec`: {needs, why}, or null when none is recorded. A
// record written before the three calls holds a boolean: true is 'build', false is 'none'.
export function blockerCall(rec, key) {
  const n = rec?.blocker_needs?.[key];
  if (!n || typeof n !== 'object') return null;
  const needs = BLOCKER_CALLS.includes(n.needs) ? n.needs : n.needs === true ? 'build' : n.needs === false ? 'none' : null;
  return needs ? { needs, why: String(n.why ?? '').trim() || 'no reason given' } : null;
}
// The open blockers in triage record `rec`'s `blockers` (ticket-facts.mjs) that `blocker_needs` gives no
// call: triage.sh refuses a record with any.
export const uncalledBlockers = (rec) => (Array.isArray(rec?.blockers) ? rec.blockers : [])
  .filter((b) => b?.key && b.category !== 'done' && !blockerCall(rec, b.key)).map((b) => b.key);
// How open blocker `b`, in no batch, holds the ticket whose triage record is `rec`: {needs, by, why}, or
// null with neither a person's step (personStep) nor a triage call (blockerCall) to go on, which is
// asked. Where the step and the call point different ways, the one that holds more wins: 'build' (a full
// hold) over 'merge' (a merge-only gate) over 'none'. `by` is 'step' or 'triage', whichever decided it.
export function blockerHold(b, rec, stepLabels = [], inputLabels = []) {
  const step = personStep(b, rec, stepLabels, inputLabels);
  const call = blockerCall(rec, b?.key);
  if (call && BLOCKER_CALLS.indexOf(call.needs) < BLOCKER_CALLS.indexOf(step ?? 'none')) return { needs: call.needs, by: 'triage', why: call.why };
  if (step) return { needs: step, by: 'step', why: step === 'build' ? 'your input step: the build reads what it makes' : 'your step' };
  return call ? { needs: call.needs, by: 'triage', why: call.why } : null;
}
// Whether blocker `b` holds rec's ticket's merge on triage's call alone (blockerHold 'merge' by
// 'triage'): another ticket's code, no step of the person's, so it is lifted once Done and landed.
export const triageGate = (b, rec, stepLabels = [], inputLabels = []) => {
  const hold = b ? blockerHold(b, rec, stepLabels, inputLabels) : null;
  return hold?.needs === 'merge' && hold.by === 'triage';
};
// The call taken where triage found ticket `t` does not need blocker `k` (`status` in Jira, in no batch),
// logged as plan-batch and intake both log it.
export const startWithout = (t, k, status, why) => ({ question: `${t} is blocked by ${k} (${status}), which is not in this batch: start without it? Triage: ${why}`,
  options: [`start without ${k}`, `wait for ${k}`], chose: `start without ${k}`, category: 'engineering' });

// Where a held ticket's hold leads: the parked or failed tickets it waits on, an empty list when every
// predecessor is progressing (running, waiting to spawn, done with a PR that is open, itself held
// and going somewhere, or a blocker in no batch it was admitted behind, held_outside) or merged (done
// with a merged PR: the release is due), or null when one predecessor can never get there and nobody
// is already being asked about it (finished with no PR, a PR closed unmerged, never admitted, dropped
// or missing), and for a hold with no recorded blocker.
// A predecessor failed or parked for a reason of its own is already a question for the person, so the
// tickets behind it wait on that answer. `prState(n)` gives a PR's state when the caller looked it up
// ('OPEN' | 'MERGED' | 'CLOSED'); unknown counts as open.
function holdLeadsTo(q, t, prState, seen, memo = new Map()) {
  // `seen` is the current path only: a ticket on it again is a hold cycle (a hand-edited queue), which
  // can never release. Two paths meeting at one held ticket (a diamond) is normal and is followed.
  if (!holdsKept(t) || seen.has(t)) return null;
  // Held on its label, it starts on its day by itself, and a fixed label is only read by a pass, so
  // the batch is not settled while either waits.
  if (dateHeld(t)) return [];
  // A ticket's answer is the same by whichever path the walk reaches it (one cut short by the path is
  // on a cycle, which answers null from anywhere), so it is read once per walk: a dense held_by graph
  // (each ticket naming every one before it) has exponentially many paths.
  if (memo.has(t)) return memo.get(t);
  seen.add(t);
  const preds = blockersOf(t);
  const outside = String(t.held_outside ?? '').split('|');
  let parks = preds.length > 0 ? [] : null;
  for (const p of preds) {
    const pt = q.tickets?.[p];
    if (!pt) { if (!outside.includes(p)) parks = null; }
    else if (['running', 'triaged'].includes(pt.state) || spinePark(pt)) continue;
    else if (pt.state === 'done') { if (!blockerThrough(pt, prState) && (pt.result?.pr == null || prState(pt.result.pr) === 'CLOSED')) parks = null; }
    else if (pt.state === 'failed' || (pt.state === 'parked' && !isHeld(pt))) parks.push(p);
    else { const up = holdLeadsTo(q, pt, prState, seen, memo); parks = up && [...parks, ...up]; }
    if (!parks) break;
  }
  seen.delete(t);
  const out = parks && [...new Set(parks)];
  memo.set(t, out);
  return out;
}

// A held ticket is still going somewhere on its own: every predecessor progressing or merged.
export const waitingOnMerge = (q, t, prState = () => null) => holdLeadsTo(q, t, prState, new Set())?.length === 0;

// The parked or failed tickets a held ticket waits on, or null: it waits on their answer, and is not a
// question of its own. Null too when it waits on a merge or is stuck.
export function waitingOnPark(q, t, prState = () => null) {
  const parks = holdLeadsTo(q, t, prState, new Set());
  return parks?.length ? parks : null;
}

// The held tickets from `from` to `to` along held_by, both ends included, or null when `from` is not
// held behind `to`, directly or through other held tickets. Depth first, the first path found.
function holdPath(q, from, to, seen = new Set()) {
  if (!holdsKept(from) || seen.has(from.key)) return null;
  seen.add(from.key);
  const preds = blockersOf(from);
  if (preds.includes(to)) return [from.key, to];
  for (const p of preds) {
    const up = holdPath(q, q.tickets?.[p], to, seen);
    if (up) return [from.key, ...up];
  }
  return null;
}

// Each parked ticket waiting on "pr <n> merged" (this repo's PR) for its own reason, a hold being no
// such reason: the PR, the queue ticket whose PR it is (`owner`, another ticket, or null), and `path`
// when that owner is held behind the park, directly or through other holds: [owner, …, park]. Such a
// pair waits on each other and neither moves. `parked` says which parks to read.
export function prParkWaits(q, parked = () => true) {
  const out = [];
  for (const a of Object.values(q.tickets ?? {})) {
    const c = a.park?.clears_when;
    if (a.state !== 'parked' || isHeld(a) || c?.kind !== 'pr-merged' || c.repo || !Number.isInteger(Number(c.pr)) || !parked(a)) continue;
    const pr = Number(c.pr);
    const owner = Object.values(q.tickets).find((t) => t.key !== a.key && t.result?.pr != null && Number(t.result.pr) === pr) ?? null;
    out.push({ park: a.key, pr, owner: owner?.key ?? null, path: owner ? holdPath(q, owner, a.key) : null });
  }
  return out;
}

// The batch's worker count and whose it is. `concurrency_by: 'user'` marks a count the user set,
// and `concurrency_user` keeps their number while the ladder lowers `concurrency` on memory, so the
// orchestrator can return to it. Never above the §3b cap. `mem` ({ avail, start } in GiB: available
// memory and the ladder's line) says whether memory is what lowered it: with available memory at or
// above the line, the ladder lowers nothing, whatever the footprint ceiling reads.
export function batchConcurrency(q, { def, cap }, mem = null) {
  const raw = Number(q.concurrency ?? def);
  const n = Math.min(raw, cap);
  const user = q.concurrency_by === 'user' ? Number(q.concurrency_user ?? raw) : null;
  const capped = raw > cap ? `, capped at the §3b cap of ${cap}` : '';
  const why = user == null ? (raw === def ? `the §3b default${capped}` : `set by the ladder (§3b default ${def})${capped}`)
    : raw === user ? `set by the user${capped}`
      : raw < user ? (mem && mem.start > 0 && mem.avail >= mem.start
        ? `below the user's ${user}${capped}, though available memory is ${mem.avail.toFixed(1)}G, at or above the ladder's ${mem.start}G line, so memory did not lower it, and the footprint ceiling is no reason to: set it back to ${user}`
        : `lowered on memory from the user's ${user}${capped}${mem && mem.start > 0 ? ` (available memory ${mem.avail.toFixed(1)}G, under the ladder's ${mem.start}G line)` : ''}: raise back to ${user} once memory allows`)
        : `above the user's ${user}${capped}: the ladder keeps the user's number, so set it back to ${user}`;
  return { n, user, line: `workers: concurrency ${raw === n ? n : `${raw} → ${n}`}, ${why}` };
}

// Settled: nothing running, nothing left to spawn, nothing waiting on a merge to be released or on a
// live read, and no spine waiting on the person's approval. A done ticket's own PR may still be open.
export function batchSettled(q, prState) {
  return Object.values(q.tickets ?? {}).every((t) => ['done', 'parked', 'failed'].includes(t.state) && !waitingOnMerge(q, t, prState) && !spinePark(t) && !waitingOnRead(t));
}

// Idle: settled, and every done ticket's PR merged or closed, so the merge driver has nothing left.
// A done ticket with no PR is finished, as is one whose own status names its PR merged (another repo's
// PR, needs-you's elsewhereDone, which prStates never holds); a PR whose state is unknown counts as open. A merged ticket
// whose review's post-merge criteria the pass has not made follow-on steps yet is not: only a pass adds
// them, so the batch keeps getting passes until one has.
export function batchIdle(q, prState = () => null) {
  return batchSettled(q, prState) && Object.values(q.tickets ?? {})
    .every((t) => (t.state !== 'done' || t.result?.pr == null || prStatusOf(t)?.state === 'MERGED' || ['MERGED', 'CLOSED'].includes(prState(t.result.pr))) && !postMergeUnmade(t));
}

// An epic batch not in feature mode lands its base on the default branch through one epic PR (the
// queue's `promotion`), opened once every child has merged into the base. A ticket held behind the
// epic key itself waits on that PR, so it is not a child the PR waits for.
export const epicBatch = (q) => q?.feature !== true && !!q?.epic && !!q?.base;
export const epicChildren = (q) => Object.values(q.tickets ?? {}).filter((t) => !blockersOf(t).includes(q.epic));
// A child is through once done and merged into the base, or done with no PR (nothing to merge).
export const childDone = (t) => t.state === 'done' && (!!t.merged_at || t.result?.pr == null);
// A blocker is through, so nothing held behind it waits on it: done, with its merge recorded (merged_at)
// or its PR merged. `prState(n)` is the PR's state where the caller read it from GitHub, and null counts
// as not merged; without it, the last pass's pr_status is read and a PR it has not read counts as
// merged. Done with no PR and no merge is not through: whether its dependants start is the person's.
// One done by another's PR (done_by) has no result.pr of its own, and that PR's merge is its merged_at.
// With a PR of its own, merged_at is not read: it keeps only a ticket's first merge, so a requeued
// blocker whose new PR is open, closed unmerged or (where the caller reads GitHub) unread is not through
// on it: its dependants wait on the change that PR lands. A status naming its current PR merged is
// final, and is how a ticket done on another repo's PR is read (needs-you's elsewhereDone), never as
// this repo's PR of the same number.
export const blockerThrough = (t, prState = null) => {
  if (t?.state !== 'done') return false;
  const n = t.result?.pr;
  if (n == null) return !!t.merged_at;
  const kept = prStatusOf(t)?.state;
  if (kept === 'MERGED') return true;
  const s = prState ? prState(n) : kept;
  if (s === 'MERGED') return true;
  return !prState && !['OPEN', 'CLOSED'].includes(s);
};
// Whether ticket k of `tickets` has merged its current work: a merge recorded (merged_at), unless it is a
// live one gone round again since (reworked). An archived one (found through `tickets`' archive, not its
// own) never is reworked. A merge moves its ticket to Done in Jira and a requeue moves it back from
// nothing, so a reworked ticket is usually Done there: every reader asks this, whatever the tracker says.
export function mergedCurrent(tickets, k) {
  const o = tickets?.[k];
  return !!o?.merged_at && !(Object.hasOwn(tickets, k) && reworked(o));
}
// Whether blocker k of `tickets` is finished for laying holds, which nothing would release: its current
// work merged, or done with no PR and no merge (childDone's other half). A reader asking only whether it
// merged (a requeue's own holds, a route to another batch) keeps a ticket behind one done with no PR: whether
// its dependants start is the person's.
export function holdThrough(tickets, k) {
  const o = tickets?.[k];
  return !!o && (mergedCurrent(tickets, k) || (!o.merged_at && childDone(o)));
}
// The blockers among `keys` to hold ticket `key` behind, less `key` itself and those in `tickets` through
// for holds (holdThrough). -> { holds, cycles: those in
// `behind` (heldBehindOf), already waiting behind `key`, so not held, outside: the holds in no batch }.
export function holdsAmong(key, keys, tickets, behind) {
  const holds = []; const cycles = [];
  for (const k of new Set(keys)) {
    if (k === key || holdThrough(tickets, k)) continue;
    (behind.has(k) ? cycles : holds).push(k);
  }
  return { holds, cycles, outside: holds.filter((k) => !tickets[k]) };
}
// Due, so the base still has to land: every child through, at least one merged into the base since the
// last epic PR merged (`merged_at`, or `since` on the one opened after it).
export function epicDue(q) {
  if (!epicBatch(q)) return false;
  const kids = epicChildren(q);
  const last = q.promotion?.merged_at ?? q.promotion?.since ?? null;
  const merged = kids.filter((t) => t.merged_at);
  return kids.length > 0 && kids.every(childDone)
    && merged.some((t) => last == null || Date.parse(t.merged_at) > Date.parse(last));
}
// When the first promotion PR recorded on `q.promotion` (since, merged_at, each merged[].merged_at) to
// merge after ticket `t` merged into the base took it to the default branch; null while none has.
export function promotedAt(q, t) {
  const own = Date.parse(t?.merged_at);
  const p = q?.promotion ?? {};
  const after = [p.since, p.merged_at, ...(p.merged ?? []).map((m) => m?.merged_at)]
    .filter(Boolean).map((x) => Date.parse(x)).filter((x) => x > own);
  return after.length ? new Date(Math.min(...after)).toISOString() : null;
}
// The promotion PR that took batch child `t` to the default branch: the first merged after it
// (promotedAt), as { pr, merged_at, merge_commit }, or null where the batch keeps no record of one. Its
// merge commit is the pass's or the merge driver's record of it, else list's refresh's
// (promotion_commits, by PR number, which no promotion PR opened since can take for its own).
export function promotionPr(q, t) {
  const own = Date.parse(t?.merged_at);
  const p = q?.promotion ?? {};
  const all = [...(p.merged ?? []), ...(p.merged_at ? [{ pr: p.pr, merged_at: p.merged_at, merge_commit: p.merge_commit }] : [])]
    .filter((m) => m?.pr != null && Date.parse(m.merged_at) > own).sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at));
  const m = all[0];
  return m ? { pr: m.pr, merged_at: m.merged_at, merge_commit: m.merge_commit ?? q?.promotion_commits?.[String(m.pr)] ?? null } : null;
}
// What the next epic PR's record carries from promotion `p`: the last merge as `since` and every merge
// so far in `merged`, kept through a retry whose record has neither `pr` nor `merged_at`.
export function epicCarry(p) {
  // Its merge commit kept beside it: it gates the children's production steps (needs-you.mjs gateHeld).
  const merged = [...(p?.merged ?? []), ...(p?.merged_at ? [{ pr: p.pr ?? null, merged_at: p.merged_at, ...(p.merge_commit ? { merge_commit: p.merge_commit } : {}) }] : [])];
  const since = p?.merged_at ?? p?.since ?? null;
  return { ...(since ? { since } : {}), ...(merged.length ? { merged } : {}) };
}
