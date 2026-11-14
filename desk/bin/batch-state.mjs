// What a batch's queue says about itself, shared by pass.mjs and queue.mjs. Pure: takes the parsed
// queue, reads nothing. Also the exit-code contract every orchestration script shares, and the one
// place they read the queue and triage records, so a corrupt file refuses the same way in all four.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { personClears } from './clears-when.mjs';

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
// The two every script reads: the batch queue and a ticket's triage record.
export const readQueue = (path) => readJsonOrRefuse(path,
  `restore it, or re-create ${path} (queue.mjs init <batch-name>, then re-seed it with plan-batch.mjs) — refusing to read it as an empty batch`);
export const readTriage = (stateDir, t) => readJsonOrRefuse(join(stateDir, 'triage', `${t}.json`), `re-run triage.sh ${t}`);

// The PR state the last pass recorded for a done ticket's PR (pr_status), or null when none was read.
// Nothing here calls GitHub.
export const prStatusOf = (t) => (t?.state === 'done' && t.result?.pr != null && t.pr_status?.pr === t.result.pr ? t.pr_status : null);

// A ticket shipped outside its worker, recorded done: the `queue.mjs` arguments pass.mjs and
// needs-you.mjs both write. Where the queue's PR status is that PR's, it is marked merged as well, or the
// done ticket would read as an unmerged PR until the next pass reads GitHub.
export const shippedSet = (t, how, pr = null, mergedAt = null) => ['set', t.key, 'state=done', 'park=null', 'handoff=null', 'handoff_stage=null', 'resume=null',
  `result.summary=shipped outside its worker: ${how}`, ...(pr == null ? [] : [`result.pr=${pr}`]),
  ...(pr != null && Number(t.pr_status?.pr) === Number(pr) ? ['pr_status.state=MERGED', ...(mergedAt ? [`pr_status.merged_at=${mergedAt}`] : [])] : [])];

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

// The question a worker parked on and nobody has answered yet, or null: its park file's `question`
// while no answer file sits beside it. A half-written park file is not an error.
export function openQuestion(stateDir, t) {
  const park = join(stateDir, 'parks', `${t}.json`);
  if (!existsSync(park) || existsSync(join(stateDir, 'answers', `${t}.txt`))) return null;
  try { return JSON.parse(readFileSync(park, 'utf8')).question || null; } catch { return null; }
}

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

export const HELD_PREFIX = 'held by orchestrator';

// Parked "held by orchestrator" (a dependency chain, released by merge-driver.sh release_chain or by
// the one sanctioned manual release once every predecessor's PR has merged).
export const isHeld = (t) => t?.state === 'parked' && String(t.park?.question ?? '').startsWith(HELD_PREFIX);

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
// reads its label again once they release it.
export const dateHeld = (t) => (isHeld(t) && t.held_label && !String(t.held_by ?? '').split('|').some(Boolean) ? dateHoldOf([t.held_label]) : null);
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
export function designPark(r) {
  const urls = unreadCanvases(r);
  return urls.length
    ? `design not snapshotted: ${urls.join(', ')}: snapshot it from a session that can read it (/desk-admit does), or have it shared with that subscription, then resume`
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
const NEVER = [['aws', /\baws\b/i], ['ssm', /\bssm\b/i], ['curl', /\bcurl\b/], ['wget', /\bwget\b/], ['gh api', /\bgh api\b/],
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
// plain push or draft PR the pass finishes itself (recoveries.mjs pushPark), so neither is one.
const TO_WORKER = /\b(?:refus\w*|denied|not (?:allowed|granted|permitted|given)|never (?:allowed|given|granted)|can(?:not|'t) (?:run|use|reach|hold|write|call)|no (?:headless )?worker (?:can|may|could|is allowed|holds?|is given))\b/i;
const PUSH_STEP = /\b(?:git push|gh pr|push(?:ed|ing|es)?|(?:draft )?PR)\b/i;
const CODE = /`([^`\n]+)`/;
const SCRIPT = /[\w./-]+\.(?:sh|mjs|js|py|ts)\b/;
export function workerRefusedStep(question) {
  const q = String(question ?? '');
  if (refusedStep(q)?.grantable || sessionPark(q)) return null;
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

// A queue ticket only an interactive session takes on: lane C, one parked at triage on its lane, or
// one whose worker parked it in lane C or a canvas-less lane D, or one whose park's step the person
// approved where no worker can run it (park.session_step, answer.mjs). Any other lane D park is requeued.
export const needsSession = (t) => t?.lane === 'C' || /^lane [CD]\b/.test(t?.park?.question ?? '') || sessionPark(String(t?.park?.question ?? '')) || !!t?.park?.session_step;

// A park a pass settles without the person: its recorded clears-when is one a script reads, no step of
// the person's makes it hold, and a worker rather than a session takes the ticket on once it does. A
// claimed park is its session's (pass.mjs clearable never settles one), so it is not one. The digest
// and needs-you leave it out, and desk-q shows it as waiting.
export const settlesByScript = (t) => {
  const c = t?.park?.clears_when;
  return t?.state === 'parked' && !isHeld(t) && !t.park?.claim?.session && !!c?.kind && c.kind !== 'none' && !personClears(c) && !needsSession(t);
};

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

// Whether blocker `b` (a triage record's `blockers` entry) is a step only the person takes, such as a
// migration applied or a sign-off: a Task whose summary says apply, confirm or sign off, or one whose
// summary names a step the blocked ticket's triage record `rec` lists in ben_steps. Open and in no
// batch, it holds the blocked ticket's merge, not its build (merge_after).
const STEP_WORDS = /\b(appl(?:y|ies|ied)|confirm(?:s|ed)?|sign(?:s|ed)?[- ]?off)\b/i;
export function personStep(b, rec = null) {
  const summary = String(b?.summary ?? '').trim().toLowerCase();
  if (!summary) return false;
  const named = (Array.isArray(rec?.ben_steps) ? rec.ben_steps : [])
    .some((s) => [s?.step, s?.blocker].some((x) => String(x ?? '').trim() && summary.includes(String(x).trim().toLowerCase())));
  return named || (/^task$/i.test(String(b?.type ?? '').trim()) && STEP_WORDS.test(summary));
}

// Where a held ticket's hold leads: the parked or failed tickets it waits on, an empty list when every
// predecessor is progressing (running, waiting to spawn, done with a PR that is open, itself held
// and going somewhere, or a blocker in no batch it was admitted behind, held_outside) or merged (done
// with a merged PR: the release is due), or null when one predecessor can never get there and nobody
// is already being asked about it (finished with no PR, a PR closed unmerged, never admitted, dropped
// or missing), and for a hold with no recorded blocker.
// A predecessor failed or parked for a reason of its own is already a question for the person, so the
// tickets behind it wait on that answer. `prState(n)` gives a PR's state when the caller looked it up
// ('OPEN' | 'MERGED' | 'CLOSED'); unknown counts as open.
function holdLeadsTo(q, t, prState, seen) {
  // `seen` is the current path only: a ticket on it again is a hold cycle (a hand-edited queue), which
  // can never release. Two paths meeting at one held ticket (a diamond) is normal and is followed.
  if (!isHeld(t) || seen.has(t)) return null;
  // Held on its label, it starts on its day by itself, and a fixed label is only read by a pass, so
  // the batch is not settled while either waits.
  if (dateHeld(t)) return [];
  seen.add(t);
  const preds = String(t.held_by ?? '').split('|').filter(Boolean);
  const outside = String(t.held_outside ?? '').split('|');
  let parks = preds.length > 0 ? [] : null;
  for (const p of preds) {
    const pt = q.tickets?.[p];
    if (!pt) { if (!outside.includes(p)) parks = null; }
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

// Settled: nothing running, nothing left to spawn, nothing waiting on a merge to be released or on a
// live read, and no spine waiting on the person's approval. A done ticket's own PR may still be open.
export function batchSettled(q, prState) {
  return Object.values(q.tickets ?? {}).every((t) => ['done', 'parked', 'failed'].includes(t.state) && !waitingOnMerge(q, t, prState) && !spinePark(t) && !waitingOnRead(t));
}

// Idle: settled, and every done ticket's PR merged or closed, so the merge driver has nothing left.
// A done ticket with no PR is finished; a PR whose state is unknown counts as open.
export function batchIdle(q, prState = () => null) {
  return batchSettled(q, prState) && Object.values(q.tickets ?? {})
    .every((t) => t.state !== 'done' || t.result?.pr == null || ['MERGED', 'CLOSED'].includes(prState(t.result.pr)));
}

// An epic batch not in feature mode lands its base on the default branch through one epic PR (the
// queue's `promotion`), opened once every child has merged into the base. A ticket held behind the
// epic key itself waits on that PR, so it is not a child the PR waits for.
export const epicBatch = (q) => q?.feature !== true && !!q?.epic && !!q?.base;
export const epicChildren = (q) => Object.values(q.tickets ?? {}).filter((t) => !String(t.held_by ?? '').split('|').includes(q.epic));
// A child is through once done and merged into the base, or done with no PR (nothing to merge).
export const childDone = (t) => t.state === 'done' && (!!t.merged_at || t.result?.pr == null);
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
