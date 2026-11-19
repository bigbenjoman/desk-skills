// Which tickets may start this pass, as decisions: the candidates and their order, what holds every
// spawn (the batch budget among them), and how many slots there are. Two decisions, because taking the
// borrow lock that the slot count is read under is the runner's: decideEligibility runs before it, and
// decideSlots after it, with the other queues read under it.
//
// decideEligibility is a generator (pass/run-phase.mjs runSteps): a read only some tickets need is
// yielded as an action, and what the action's handler returns is what the yield gives back. decideSlots
// is a plain function run by runPhase. Neither starts a process, calls git, gh or Jira, or writes the
// queue: the handlers that do are pass.mjs's.
//
// Actions, beside the shared `report` ({ type, key, ... }; "->" is what the handler returns):
//   stall {line}       a stall only the person can clear: a line of the report's stalled list that the
//                      push names too
//   collides {key}     -> whether a file the ticket names is at its per-file budget
//   finished {key}     -> whether the ticket's worker already printed AUTOPILOT_DONE
//   reboot-wait {key}  -> why a worker stopped for a planned reboot still waits, or null once it may resume
//   eligibility {eligible, spawnable, held, spawnHeld}   what decideEligibility decided
//   slots {plan, machine, repo, repoUnlocked, slots, machineLine, repoLine}
//                      what decideSlots decided
import { parseBudget } from '../desk-env.mjs';
import { limitName } from '../usage-limit.mjs';
import { keysOf } from '../desk-q.mjs';
import { borrowPlan, machineBudget, repoBudget } from '../borrow.mjs';
import { say, untilText } from './shared.mjs';

const stall = (line) => ({ type: 'stall', line });

export const PACE_HELD = '7-day usage ahead of pace holds every spawn';
export const usageHeldText = (h) => `${limitName(h.type)}${untilText(h)} holds every spawn and resume, until it lifts or a probe call succeeds`;

// A killed worker waiting to resume, and a session handed off to its next stage, go ahead of every new
// ticket.
export const toResume = (r) => ['pending', 'usage', 'maintenance', 'reboot'].includes(r.resume);
export const toHandoff = (r) => r.handoff === 'pending';
const goesFirst = (r) => toResume(r) || toHandoff(r);
// A ticket linked in Jira as blocked by one held behind it (cycle_link) waits until the person says which
// comes first, so neither of the two starts while the triage item asks.
const inCycle = (r) => keysOf(r.cycle_link).length > 0;

// The batch budget, from snapshot.budget: {raw, label} as read (the queue's `budget_usd`, else
// $AUTOPILOT_BATCH_BUDGET_USD, else config §3b, else none), or {error} where the read failed. A positive
// number of USD or none/off/no cap. Anything else ("25 USD") holds every spawn rather than reading as no
// cap: a typo must never silently remove a guard. -> {cap, bad}, cap 0 for no cap.
function budgetOf(budget) {
  if (budget.error != null) return { cap: 0, bad: budget.error };
  try {
    const b = parseBudget(budget.raw, budget.label);
    return { cap: b.off ? 0 : b.usd, bad: null };
  } catch (e) { return { cap: 0, bad: e.message }; }
}

// The candidates this pass may start, in the order they start, what holds every spawn, and the report's
// lines on why any is not starting. Snapshot:
//   tickets       the queue's tickets, in queue order
//   budget        the batch budget as read (budgetOf)
//   modelsBad     why config §3b "Worker models" does not read, or null
//   checkin       checkinTimes's {ok, why}
//   health        health.mjs's {stalls, holding}
//   pace          usage-pace.mjs's {bad, hold, line}, and paceProbe what a probe call for it read
//   memory        {low, avail, hold, start, dropTo}: the spawn gate (config §3b "Spawn gate")
//   lockQueue     suite-wait.mjs lockQueue's reading, or null where it is not read
//   spawnGrant    {may, key, perm, queueBin}: config §3 autopilot-workers, and the queue.mjs path
//   maintHold     whether the maintenance window holds
//   usageHold     the usage limit holding the batch, or null, and probes each probe call's why
//   pacingRow     config §3b's usage-pacing row name
export function* decideEligibility(s) {
  const all = Object.values(s.tickets);
  const running = all.filter((r) => r.state === 'running').length;
  // Spend is reported only when a cap exists.
  const spent = all.reduce((n, r) => n + (Number(r.cost) || 0), 0);
  const { cap, bad: budgetBad } = budgetOf(s.budget);
  if (budgetBad) yield stall(`${budgetBad} — not spawning until it is fixed`);
  const overBudget = !!budgetBad || (cap > 0 && spent >= cap);
  if (cap > 0 && spent >= cap) yield stall(`batch budget reached: $${spent.toFixed(2)} of $${cap} — not spawning anything further`);
  // A malformed Worker models row holds every spawn, the way a malformed budget does, and so does a
  // Check-in times row that does not read, since the questions a new worker parks would reach no check-in.
  if (s.modelsBad) yield stall(`${s.modelsBad} — not spawning until it is fixed`);
  if (!s.checkin.ok) yield stall(`${s.checkin.why} — not spawning until it is fixed`);
  for (const line of s.health.stalls) yield stall(line);
  if (s.pace.bad) yield stall(`${s.pace.bad} — not spawning until it is fixed`);
  else if (s.pace.hold) yield say(null, 'stalled', `${s.pace.line} (${running} running carry on; fix tries still start${s.paceProbe})`);
  // Low memory only delays a spawn by a pass; it never kills anything.
  const m = s.memory;
  if (m.low) {
    yield say(null, 'stalled', m.avail < m.hold
      ? `memory: ${m.avail.toFixed(1)}G available, under the ${m.hold}G floor — §3b says drop to ${m.dropTo} worker(s); ` +
        `holding spawns (${running} running; a worker mid-suite will drain)`
      : `memory: ${m.avail.toFixed(1)}G available, in the §3b hold band (${m.hold}–${m.start}G) — holding spawns this pass ` +
        `(${running} running; a worker mid-suite will drain)`);
  }
  if (s.lockQueue?.unread) yield say(null, 'stalled', s.lockQueue.line);

  const eligibleBase = [];
  for (const r of all) {
    if (r.state === 'triaged' && (r.open_questions ?? 0) === 0 && !inCycle(r) && !(yield { type: 'collides', key: r.key })) eligibleBase.push(r);
  }
  const cycleWaits = all.filter((r) => r.state === 'triaged' && inCycle(r));
  if (cycleWaits.length) yield say(null, 'stalled', `not spawning ${cycleWaits.map((r) => `${r.key} (linked in Jira as blocked by ${keysOf(r.cycle_link).join(', ')}, which ${keysOf(r.cycle_link).length === 1 ? 'is' : 'are'} held behind it)`).join(', ')}: which comes first is asked in needs-you`);
  // A ticket whose worker already printed AUTOPILOT_DONE has finished, whatever its state says.
  const finished = new Set();
  for (const r of eligibleBase) if (yield { type: 'finished', key: r.key }) finished.add(r);
  const blockedByDone = eligibleBase.filter((r) => finished.has(r));
  // A worker stopped for a planned reboot is held until it may resume.
  const rebootWaits = [];
  for (const r of eligibleBase) if (r.resume === 'reboot' && (yield { type: 'reboot-wait', key: r.key })) rebootWaits.push(r);
  const eligible = eligibleBase.filter((r) => !finished.has(r) && !rebootWaits.includes(r)).sort((a, b) => goesFirst(b) - goesFirst(a));
  const g = s.spawnGrant;
  if (!g.may && eligible.length) {
    yield stall(`not spawning ${eligible.length} ticket(s): config §3 ${g.key} is "${g.perm}"` +
      (g.perm === 'ask' ? ' — confirm the batch with the user, then run passes with AUTOPILOT_USER_APPROVED=1' : ' — run /desk-setup to grant it'));
  }
  // Say why a triaged ticket is not spawning: a silent refusal reads as slowness.
  if (blockedByDone.length) {
    yield stall(`not respawning (its worker already printed AUTOPILOT_DONE): ${blockedByDone.map((r) => r.key).join(', ')} — ` +
      `if the re-run is deliberate: node ${g.queueBin} requeue <TICKET>`);
  }

  if (s.usageHold) yield say(null, 'stalled', `${usageHeldText(s.usageHold)} (probe: ${s.probes.filter(Boolean).join('; ') || 'not run'})`);
  const held = s.maintHold ? 'the maintenance window holds every spawn' : s.usageHold ? usageHeldText(s.usageHold) : overBudget ? 'the batch budget holds every spawn' : s.modelsBad ? 'config §3b "Worker models" holds every spawn'
    : !s.checkin.ok ? 'config §3b "Check-in times" holds every spawn'
    : s.health.holding.length ? `a failing health check (${s.health.holding.join(', ')}) holds every spawn`
    : !g.may ? `config §3 ${g.key} is "${g.perm}"`
    : s.pace.bad ? `config §3b "${s.pacingRow}" holds every spawn`
    : s.pace.hold ? PACE_HELD : null;
  // Pacing holds new tickets, never a fix try: its PR is already out and stalls until the try runs, so
  // it starts within the worker count as any spawn does.
  const spawnable = held === PACE_HELD ? eligible.filter((r) => r.fix && !r.fix.finished) : eligible;
  const spawnHeld = held === PACE_HELD && spawnable.length ? null : held;
  yield { type: 'eligibility', eligible, spawnable, held, spawnHeld };
}

// The borrow plan (borrow.mjs borrowPlan) for `workers` running, under decideSlots's snapshot `s`.
const planOf =(s, workers, on = s.borrowOn) => borrowPlan({
  on, share: s.concurrency, cap: s.cap, running: workers, wanted: s.spawnable,
  others: s.others, machine: s.machineCap, memory: s.memory, held: s.spawnHeld, lock: s.lockWhy,
});

// How many workers this pass may start: up to the batch's own number, and with config §3b "Borrow idle
// workers" on, above it into slots no other live batch has first claim on (borrow.mjs). With a machine
// profile its worker cap is a hard limit across every repo (machineBudget), and the repo's §3b cap is
// shared by all its batches (repoBudget). Snapshot, beside planOf's:
//   running       this batch's running tickets, and ownBaseFix 1 while its base conflict fix runs
//   baseWanted    whether a base worker with no ticket to spawn wants its one slot
//   machineProfiled  whether there is a machine profile; repoCaps each repo's §3b cap, by slug
//   otherRepos    every other queue (borrow.mjs otherQueues), and repoBatches this repo's other batches
//   batch, lastStart, maintHold
export function decideSlots(s) {
  const plan = planOf(s, s.running);
  const wanted = Math.min(plan.slots, s.spawnable) || (s.baseWanted ? 1 : 0);
  const machine = machineBudget({
    running: s.running + s.ownBaseFix, wanted, machine: s.machineCap, queues: s.otherRepos,
    profiled: s.machineProfiled, capOf: (slug) => s.repoCaps[slug],
  });
  const repo = repoBudget({
    batch: s.batch, running: s.running + s.ownBaseFix, wanted, last: s.lastStart, cap: s.cap, batches: s.repoBatches,
  });
  // A repo's batches share its cap only under the lock: without it two passes could each count the same
  // free slot, so a batch with a sibling that is live, running or unreadable (the ones repoBudget counts)
  // starts nothing this pass rather than counting unlocked. An idle sibling shares nothing, so it does not.
  const repoUnlocked = s.lockWhy != null && s.repoBatches.some((o) => o.error || o.live || o.running > 0);
  const slots = s.maintHold || repoUnlocked ? 0 : Math.min(plan.slots, machine.room, repo.room);
  const machineLine = machine.line + (s.machineCap != null && s.lockWhy ? ` (counted without the lock: ${s.lockWhy})` : '');
  const repoLine = repoUnlocked ? `repo workers: nothing starts this pass: the repo's batches share its §3b cap, and ${s.lockWhy}` : repo.line;
  return [{ type: 'slots', plan, machine, repo, repoUnlocked, slots, machineLine, repoLine }];
}

// The slots a ticket worker may take: a base conflict fix worker still at it holds one of the batch's
// own number; the machine and repo budgets have counted it already. In a batch of 1 it holds the batch's
// one worker, from the pass that starts it, and no ticket borrows a way round that.
//   -> {workers, plan, slots}
export function ticketSlotsOf(s, slots, { baseFixLive, baseFixOn }) {
  const workers = s.running + (baseFixLive ? 1 : 0);
  const plan = planOf(s, workers, s.borrowOn && !((baseFixLive || baseFixOn) && s.concurrency === 1));
  return { workers, plan, slots: Math.min(slots, plan.slots) };
}
