// What a pass says, as decisions: base drift, the report's lines, the ticket groups and the verdict.
// Pure: each reads only the snapshot it is given. pass.mjs reads what each needs (a worktree's git
// count, a seen-file, the groups desk-q finds, the check-in) into the snapshot, and carries out the
// actions; each decision runs at the point in the pass whose state it reads.
//
// The actions:
//   { type: 'out', line }                  a line for the report's list of changes (`out`)
//   { type: 'line', line }                 a line for the pass's output (`lines`), after that list
//   { type: 'table' }                      the place in `lines` the status table goes
//   { type: 'report', key?, list, line }   a line for the pass's report list `list`
//   { type: 'set', key, fields }           queue fields to set on the ticket
//   { type: 'drift', key, line }           a ticket behind the default branch, for the drift line
//   { type: 'seen', file, text }           a seen-file in the state directory, rewritten
//   { type: 'read-inputs', key, inputs, branch }  a put-off park's inputs read again (a yield, given
//                                          back as the inputs now: decidePutOffRefresh)
//   { type: 'park-inputs', key, question, inputs }  a put-off park's refreshed inputs, written only
//                                          while the ticket is still parked on `question`
import { isHeld, batchIdle, waitingOnRead, settlesByScript } from '../batch-state.mjs';
import { restating } from '../clears-when.mjs';
import { promotionHolds } from '../gate.mjs';
import { lookup, inputsHash } from '../not-now.mjs';
import { urgentParks } from '../digest.mjs';
import { batchScopeTotals } from '../scope-report.mjs';

const out = (line) => ({ type: 'out', line });
const line = (l) => ({ type: 'line', line: l });

// ---- base drift --------------------------------------------------------------
// Only tickets still being worked: a done ticket's worktree falls behind and nothing rebases it.
// The tickets whose worktree the pass counts commits in, given a snapshot without `behind`.
export const driftCandidates = (s) => Object.values(s.tickets).filter((t) => t.state !== 'done' && t.worktree);

// The snapshot adds:
//   branch   the default branch
//   behind   { [key]: the rev-list count's output } for each candidate whose worktree exists
export function decideDrift(s) {
  const acts = [];
  for (const t of driftCandidates(s)) {
    const behind = s.behind?.[t.key];
    if (/^\d+$/.test(behind ?? '') && Number(behind) > 0) acts.push({ type: 'drift', key: t.key, line: `${t.key} is ${behind} behind ${s.branch}` });
  }
  return acts;
}

// ---- report: its opening -------------------------------------------------------
// The snapshot adds the lines and findings of the phases before it:
//   report                 the pass's report lists
//   baseLines, maintLines, dateLines, linkLines, epicLines   each phase's own lines, in that order
//   incidentalBad, appendOnlyBad, fileBudgetBad, conflictRecordBad   a row read as its default, or null
//   budgetUnread           why each of this repo's other batches' queues did not read, so its running
//                          tickets were not counted toward the per-file budget
//   conflicts              [{ file, configured, now, recent }] for each file with merge-time conflicts
//   unreadableQueues       the other queues whose running workers' ports were not read
//   portLeaseLines         what the port leases and claims did this pass: unreadable, a stale holder or claim dropped
//   concurrency, eligible  the batch's worker count, and how many triaged tickets could spawn
//   queueBin               queue.mjs, as the person runs it
export function decideReportOpening(s) {
  const acts = [];
  const r = s.report;
  if (!s.registry.read) acts.push(out(`! could not read the session registry — no ticket was advanced this pass: ${s.registry.why}`));
  for (const l of [...s.baseLines, ...s.maintLines, ...s.dateLines, ...s.linkLines]) acts.push(out(l));
  for (const [label, items] of [['spawned', r.spawned], ['advanced', r.advanced], ['done', r.done], ['failed', r.failed]]) {
    if (items.length) acts.push(out(`${label}: ${items.join(' | ')}`));
  }
  if (r.outOfScope.length) acts.push(out(`out of triaged scope (report only):\n  ${r.outOfScope.join('\n  ')}`));
  if (s.incidentalBad) acts.push(out(`scope: ${s.incidentalBad} — read as the default (lockfiles)`));
  if (s.appendOnlyBad) acts.push(out(`collisions: ${s.appendOnlyBad} — read as none, so a shared append-only file still collides`));
  if (s.fileBudgetBad) acts.push(out(`collisions: ${s.fileBudgetBad} — read as 1 for every file, so no two tickets naming one file run at once`));
  for (const why of s.budgetUnread ?? []) acts.push(out(`collisions: ${why} — that batch's running tickets were not counted toward the per-file budget`));
  if (s.conflictRecordBad) acts.push(out(`collisions: the conflict record was not read (${s.conflictRecordBad}), so every file runs at its configured budget`));
  for (const c of s.conflicts) {
    if (c.now < c.configured) acts.push(out(`collisions: ${c.file} runs ${c.now} of its configured ${c.configured}, after ${c.recent} merge-time conflict(s) in the last 7 days`));
  }
  for (const why of s.unreadableQueues) acts.push(out(`ports: ${why} — its running workers' ports were not skipped`));
  for (const l of s.portLeaseLines ?? []) acts.push(out(l));
  for (const l of s.epicLines) acts.push(out(l));
  if (r.paused.length) acts.push(out(`paused on the usage limit: ${r.paused.join(' | ')}`));
  for (const u of r.unrecognised) acts.push(out(`unrecognised usage-limit event: ${u} — not read as a pause, so the stall check applies as before`));
  if (r.stalled.length) acts.push(out(`STALLED:\n  ${r.stalled.join('\n  ')}`));
  if (r.quiet.length) acts.push(out(`quiet: ${r.quiet.join(', ')}`));
  // A worker count of 0 is a pause, not a finished batch: say what is waiting behind it.
  if (s.concurrency <= 0 && s.eligible) {
    acts.push(out(`paused: new spawns are paused by the batch's worker count (concurrency ${s.concurrency}); ${s.eligible} triaged ticket(s) wait. ` +
      `Resume with node ${s.queueBin} set-batch concurrency=<n> concurrency_by=user`));
  }
  return acts;
}

// ---- report: its lines after the promotion ledger ------------------------------
// Blocked-on-questions must be visible, or "no change this pass" reads as "idle" when it really means
// "nobody answered yet": the triaged tickets with questions open, among the pass's ticket rows.
export const blockedOf = (rows) => rows.filter((r) => r.state === 'triaged' && (r.open_questions ?? 0) > 0);

// The promotion PR's §4 Merge hold line: a child into the base merged past a hold, so the base's own
// merge into the default branch is the person's, after the hold's step. Said on every pass until the
// promotion PR that carries it merges.
function promotionHoldLine(s) {
  const p = s.promotion;
  if (!s.base || !s.source || s.base === s.source) return null;
  // The last promotion's merge is recorded without a next one to move `since` past it.
  if (p?.pr != null && (p.merged ?? []).some((m) => m.pr === p.pr)) return null;
  if (p?.merged_at) return null;
  const held = promotionHolds(Object.values(s.tickets ?? {}), p?.since ?? null);
  if (!held.length) return null;
  return `${p?.pr != null ? `promotion PR #${p.pr}` : `${s.base} into ${s.source}`}: only a person merges it, after the §4 Merge holds its children carry — ${held.join('; ')}`;
}

// ---- put-off parks asked again -------------------------------------------------
// A put-off park whose `pr-head` or `config:<id>` input has changed since is asked again: its
// refreshed inputs go on the park, where the verdict and the digest read them, and decideReportLines
// lists it under PARKED. A generator run by runSteps: each park's inputs are read again (yield
// `read-inputs`, given back as the inputs now) and its set staged before the next park's are read.
// The snapshot adds:
//   putOff   [{ key, question, inputs, branch }] each put-off park
export function* decidePutOffRefresh(s) {
  for (const p of s.putOff) {
    const now = yield { type: 'read-inputs', key: p.key, inputs: p.inputs, branch: p.branch };
    if (inputsHash(now) === inputsHash(p.inputs)) continue;
    yield { type: 'park-inputs', key: p.key, question: p.question, inputs: now };
  }
}

// The snapshot adds:
//   report, drift           the report lists, and the drift lines
//   answerBin               answer.mjs, as the person runs it
//   base, source, promotion the batch base, the default branch, and the queue's `promotion`
//   overrides, overridesSeen  the digest's overridden calls (digest.mjs readDecisions), and the ids
//                           already listed: a call the person overrode is listed once, on the next pass,
//                           for the orchestrator to act on, as the work may need redoing to the new choice
//   reviewClash, reviewSeen a §4 Local review command whose reviews §4 Clean review verdict can never
//                           read clean, and the clash last logged: logged once for that pair of rows,
//                           since workers run /desk-review in its place until /desk-setup settles it
//   blocked                 blockedOf the pass's rows
//   heldBack                [{ key, holds: [{ file, by, elsewhere, k }] }] the triaged tickets a running one's
//                           file holds: `by` this batch's running keys, `elsewhere` [{ key, label }] those
//                           running in the repo's other batches, each with its batch's label
//   resumeRows              the pass's triaged rows as the held phase read them, each
//                           { key, resume, resume_why, toResume, rebootWait }
//   askedAgain              [{ key, question, now }] the put-off parks decidePutOffRefresh asked again,
//                           whose refreshed inputs `now` were written and not taken back
//   register                the "not now" register
export function decideReportLines(s) {
  const acts = [];
  const waiting = [...s.report.waiting];
  const wait = (l, key) => { waiting.push(l); acts.push({ type: 'report', ...(key ? { key } : {}), list: 'waiting', line: l }); };
  const hold = promotionHoldLine(s);
  if (hold) wait(hold);
  const fresh = [];
  for (const e of s.overrides) {
    // A lever's override is applied by the override itself (lever-changes.mjs): no ticket waits on it.
    if (s.overridesSeen.includes(e.id) || e.lever) continue;
    fresh.push(e.id);
    wait(`${e.ticket}: decision overridden — "${e.question}" is now "${e.chose}" (was "${e.was}"), by ${e.by} at ${e.at}`, e.ticket);
  }
  if (fresh.length) acts.push({ type: 'seen', file: 'overrides-reported.json', text: `${JSON.stringify([...s.overridesSeen, ...fresh])}\n` });
  if (s.reviewClash && s.reviewSeen !== s.reviewClash) {
    acts.push(out(`review rows: ${s.reviewClash}`), { type: 'seen', file: 'review-rows-reported.txt', text: s.reviewClash });
  }
  if (waiting.length) acts.push(out(`WAITING ON YOU:\n  ${waiting.join('\n  ')}`));

  if (s.blocked.length) acts.push(out(`BLOCKED ON ANSWERS: ${s.blocked.map((b) => `${b.key} (${b.open_questions})`).join(', ')}\n  answer with: node ${s.answerBin} <TICKET> "<answer>"`));
  const budgetText = (h) => {
    const names = [...h.by, ...(h.elsewhere ?? []).map((o) => `${o.key} in ${o.label}`)];
    return `${h.file} has ${names.length} running of its ${h.k}: ${names.join(', ')}`;
  };
  if (s.heldBack.length) acts.push(out(`held back by a collision: ${s.heldBack.map((x) => `${x.key} (${x.holds.map(budgetText).join('; ')})`).join(', ')}`));
  const resumeWaits = s.resumeRows.filter((r) => r.toResume && !(r.resume === 'reboot' && r.rebootWait));
  if (resumeWaits.length) acts.push(out(`waiting to resume (killed; resumed ahead of new tickets when a slot frees): ${resumeWaits.map((r) => `${r.key} (${r.resume_why})`).join(', ')}`));
  const bootWaits = s.resumeRows.filter((r) => r.resume === 'reboot' && r.rebootWait);
  if (bootWaits.length) acts.push(out(`waiting for the reboot: ${bootWaits.map((r) => `${r.key} (${r.rebootWait})`).join(', ')}`));

  // A put-off park asked again is listed under PARKED, saying what changed.
  const parked = [...s.report.parked];
  for (const p of s.askedAgain) {
    const l = `${p.key}: ${p.question} — ${lookup(s.register, { question: p.question, inputs: p.now }).line}`;
    parked.push(l);
    acts.push({ type: 'report', key: p.key, list: 'parked', line: l });
  }
  const r = s.report;
  if (parked.length) acts.push(out(`PARKED:\n  ${parked.join('\n  ')}`));
  if (r.clears.length) acts.push(out(`clears-when:\n  ${r.clears.join('\n  ')}`));
  if (r.recovered.length) acts.push(out(`recovered:\n  ${r.recovered.join('\n  ')}`));
  if (r.inputs.length) acts.push(out(`park inputs:\n  ${r.inputs.join('\n  ')}`));
  if (r.putOff.length) acts.push(out(`put off, so not asked again until their inputs change (the digest lists them):\n  ${r.putOff.join('\n  ')}`));
  if (s.drift.length) acts.push(out(`base drift: ${s.drift.join(', ')}`));
  return acts;
}

// ---- groups ------------------------------------------------------------------
// Each row's group as desk-q shows it, and the pass that first found it there, kept on the ticket as
// `group` ({g, at}): desk-q's STARTS says how long a row has sat in it, and the digest lists a Merging
// PR with no change for two hours. Read after the pass's own writes, so a spawn or a fix try counts now.
// `from` and `from_at` are the group it left and when it entered that one: desk-q times a PR's Merging
// age from leaving Running when its head was pushed while it was there, under review.
// The snapshot adds `groups` ({ [key]: group }, desk-q groupsNow), or `groupsError`, the first line of
// why they were not read, and `at`, the pass's time.
export function decideGroups(s) {
  if (s.groupsError != null) return [out(`groups: not recorded this pass (${s.groupsError})`)];
  const acts = [];
  for (const [key, g] of Object.entries(s.groups ?? {})) {
    const was = s.tickets[key]?.group;
    if (was?.g !== g) acts.push({ type: 'set', key, fields: [`group=${JSON.stringify({ g, at: s.at, from: was?.g ?? null, from_at: was?.at ?? null })}`] });
  }
  return acts;
}

// ---- verdict -----------------------------------------------------------------
// Everything that waits on the person: this pass's failures, WAITING ON YOU, the stalls only they can
// clear, unanswered questions, and every ticket parked for its own reason (a hold is not one: it
// releases by itself, nor is a park a pass settles: its live reads, or a clears-when a script reads,
// unless the park carries a note saying the PR it waits on conflicts with its base or was closed).
// The snapshot adds:
//   queue                    the queue as the pass ends
//   report, blocked          the report lists, and blockedOf the pass's rows
//   putOff                   a Set of the keys of put-off parks
//   parkNotes                a Map of a parked ticket's note, by key
//   prStates                 { [pr]: state } for each PR the pass read
//   gatePending, epicPending, promotionPending   a base gate, epic PR or promotion still to come
//   followPending            a follow-step checker running or still to start (pass/follow-steps.mjs)
//   spawned                  how many tickets this pass spawned
// -> { waiting, parked, idle, status, needsYou }
// A park a pass settles by checking its recorded clears-when. One still to be restated is not: it stays
// in `parked`, the only way the decider (decider.mjs deciderItems) is asked to restate it.
const passChecks = (t) => settlesByScript(t) && !restating(t.park.clears_when);
// Each park the person could be shown: its own reason, not put off, and no live read the pass is running.
const ownParks = (s) => Object.values(s.queue.tickets).filter((t) => t.state === 'parked' && !isHeld(t) && !s.putOff.has(t.key) && !waitingOnRead(t))
  .map((t) => ({ t, p: { key: t.key, question: t.park?.question ?? '', ...(s.parkNotes.has(t.key) ? { note: s.parkNotes.get(t.key) } : {}) } }));
export function verdictOf(s) {
  const r = s.report;
  const waiting = [
    ...r.failed,
    ...r.waiting,
    ...r.personStalls,
    ...s.blocked.map((b) => `${b.key}: ${b.open_questions} question(s) open — answer with answer.mjs ${b.key} "<answer>"`),
  ];
  // A park with a note is still the person's: the PR it waits on conflicts with its base or was closed
  // unmerged, so it cannot merge on its own and the condition a pass checks would never hold.
  const parked = ownParks(s).filter(({ t, p }) => p.note || !passChecks(t)).map(({ p }) => p);
  const idle = batchIdle(s.queue, (n) => s.prStates[n] ?? null) && !s.gatePending && !s.epicPending && !s.promotionPending && !s.followPending;
  const status = idle ? 'idle' : (waiting.length || parked.length) ? 'show_person' : s.spawned ? 'go_on' : 'nothing_yet';
  const needsYou = [...parked.map((p) => p.key), ...waiting.map((x) => x.split(':')[0])];
  return { waiting, parked, idle, status, needsYou };
}

// A crash's error verdict, given its message and the pass's report so far: what the pass had already
// done (started a worker, moved, parked or failed a ticket) is listed under the message and set in the
// JSON, so nobody reads the error as "nothing happened" and starts a ticket that already has a session.
// Its parks go in `parked_this_pass`: the verdict's `parked` is the decider's {key, question} list.
// -> { message, fields }: fields holds only the lists with entries, and is {} when nothing was done.
const CRASH_FIELDS = [['spawned', 'spawned'], ['advanced', 'advanced'], ['parked', 'parked_this_pass'], ['failed', 'failed']];
export function crashVerdict(message, report) {
  const did = CRASH_FIELDS.map(([k, field]) => [k, field, [...(report?.[k] ?? [])]]).filter(([, , v]) => v.length);
  if (!did.length) return { message, fields: {} };
  const lines = did.flatMap(([k, , v]) => [`before it stopped, this pass ${k}:`, ...v.map((l) => `  ${l}`)]);
  return { message: `${message}\n${lines.join('\n')}`, fields: Object.fromEntries(did.map(([, field, v]) => [field, v])) };
}

// The verdict's opening line, and the parks that are pushed now rather than shown in the session (a
// park reading production broken, whatever it waits on), given the snapshot verdictOf takes plus `slug`.
// An idle batch still holding a park a pass settles is not finished: the line says how many wait.
export function decideVerdict(s) {
  const v = verdictOf(s);
  const acts = [];
  const waits = Object.values(s.queue.tickets).filter((t) => passChecks(t) || waitingOnRead(t)).length;
  if (v.needsYou.length) acts.push(line(`NOTIFY: ${v.needsYou.length} item(s) need you — ${[...new Set(v.needsYou)].join(', ')}`));
  else if (v.idle && waits) acts.push(line(`NOTIFY: nothing needs you — ${waits} park(s) wait on a condition a pass checks, and are requeued once it holds`));
  else if (v.idle) acts.push(line('NOTIFY: the batch is finished — nothing left to run'));
  for (const p of urgentParks(ownParks(s).map(({ p }) => p), s.slug)) acts.push({ type: 'push', push: p });
  return acts;
}

// The pass's output after its pushes. The snapshot adds:
//   push        everything pushed now, in order
//   out         the report's list of changes
//   footer      the health, pacing, memory, ceiling, worker-count, budget and borrowing lines, in order
//   idle        verdictOf's idle; when it is, `queue` (the queue as the pass ends) and `costTable`
//               (worker-cost.mjs costTable of the batch's cost, or null with none)
export function decideVerdictLines(s) {
  const tickets = Object.values(s.queue?.tickets ?? {});
  const acts = s.push.map((p) => line(`PUSH: ${p.text}`));
  acts.push(line(s.out.length ? s.out.join('\n') : 'no change this pass'));
  for (const l of s.footer) acts.push(line(l));
  acts.push(line(''), { type: 'table' });
  if (s.idle) {
    acts.push(line('\nIDLE — every ticket is done, parked, or failed, none is held waiting on a merge, and every done ticket\'s PR is merged or closed (or it finished with no PR). Nothing left to spawn or merge.'));
    const sc = batchScopeTotals(tickets);
    acts.push(line(`scope: ${sc.tickets} of ${sc.checked} checked ticket(s) changed files outside their triaged scope, ${sc.files} file(s) in all (report only)`));
    const resumed = tickets.filter((t) => t.resumes > 0);
    if (resumed.length) acts.push(line(`resumed after a kill: ${resumed.map((t) => `${t.key} ${t.resumes} time(s) (${t.state})`).join(', ')}`));
    if (s.costTable) acts.push(line(s.costTable));
  }
  return acts;
}

// Why nothing spawned while something could have: the first hold that applied this pass, or null.
export function heldWhyOf(s) {
  if (s.spawned || !s.eligible) return null;
  return s.held ?? (s.baseHold ? `the batch base sync holds every spawn${s.baseLag ? `: ${s.baseLag}` : ''}`
    : s.lowMemory ? `memory: ${s.availGB.toFixed(1)}G available, under the ${s.minAvailGB}G spawn gate`
    : s.lockQueueHeldText ?? (s.machine.room <= 0 ? `the machine budget: ${s.machine.line}`
    : s.repoUnlocked ? `the repo's shared cap: ${s.repoLine}`
    : s.repo.room <= 0 ? `the repo's shared cap: ${s.repo.line}`
    : s.concurrency <= 0 ? `the batch's worker count is ${s.concurrency}` : null));
}
