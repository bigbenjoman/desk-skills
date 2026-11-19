// suite: pass phase: eligibility, the batch budget and slots (the candidates, what holds every spawn, the slot count)
import { runPhase, runSteps } from '../desk/bin/pass/run-phase.mjs';
import { PACE_HELD, decideEligibility, decideSlots, ticketSlotsOf, toResume, toHandoff } from '../desk/bin/pass/eligibility.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const byKey = (...ts) => Object.fromEntries(ts.map((x) => [x.key, x]));
const triaged = (key, fields = {}) => ({ key, state: 'triaged', open_questions: 0, ...fields });
const keys = (rs) => rs.map((r) => r.key);

// A snapshot with nothing holding: a budget of none, every row reading, memory and the test lock clear.
const snap = (tickets, more = {}) => ({
  tickets, budget: { raw: 'none', label: 'the batch budget' }, modelsBad: null, checkin: { ok: true },
  health: { stalls: [], holding: [] }, pace: { bad: null, hold: false, line: 'pace: on pace' }, paceProbe: '',
  memory: { low: false, avail: 20, hold: 4, start: 8, dropTo: 1 }, lockQueue: null,
  spawnGrant: { may: true, key: 'autopilot-workers', perm: 'yes', queueBin: '/bin/queue.mjs' },
  maintHold: false, usageHold: null, probes: [], pacingRow: 'Usage pacing headroom (points)', ...more,
});

// The runner with stub handlers: each read answers from `answers` (a value, or a function of the
// action), else from READS; `stall` and `report` lines are collected.
const READS = { collides: false, finished: false, 'reboot-wait': null };
function eligibility(s, answers = {}) {
  let out = null;
  const lines = [];
  const stalls = [];
  const handlers = {
    ...Object.fromEntries(Object.keys(READS).map((type) => [type, (a) => {
      const v = Object.hasOwn(answers, type) ? answers[type] : READS[type];
      return typeof v === 'function' ? v(a) : v;
    }])),
    report: (a) => lines.push(a.line),
    stall: (a) => { lines.push(a.line); stalls.push(a.line); },
    eligibility: (a) => { out = a; },
  };
  const report = { failed: [] };
  const actions = runSteps({ name: 'eligibility', snapshot: () => s, decide: decideEligibility, handlers, report });
  return { ...out, lines, stalls, actions, failed: report.failed };
}

// decideSlots's snapshot for an eligibility result `e`: a batch of 2 with nothing running, no machine
// profile and no other batch, unless `more` says otherwise.
const slotsSnap = (e, more = {}) => ({
  borrowOn: false, concurrency: 2, cap: 3, running: 0, spawnable: e.spawnable.length, others: [], machineCap: null,
  memory: { avail: 20, start: 8 }, spawnHeld: e.spawnHeld, lockWhy: null, ownBaseFix: 0, baseWanted: false,
  machineProfiled: false, repoCaps: {}, otherRepos: [], repoBatches: [], batch: null, lastStart: null, maintHold: false, ...more,
});
function slots(s) {
  let out = null;
  runPhase({ name: 'slots', snapshot: () => s, decide: decideSlots, handlers: { slots: (a) => { out = a; } }, report: { failed: [] } });
  return out;
}

// ---- the batch budget ----
// AC1: a budget that does not read as a number holds every spawn: nothing starts, and the stall says so.
{
  const e = eligibility(snap(byKey(triaged('A'), triaged('B')), { budget: { raw: '25 USD', label: 'the batch budget' } }));
  t('AC1 a budget of "25 USD" holds every spawn', e.held, 'the batch budget holds every spawn');
  t('AC1 and no candidate may start: no slot', slots(slotsSnap(e)).slots, 0);
  t('AC1 the person is told why, and that nothing spawns until it is fixed',
    j(e.stalls), j(['desk: the batch budget is "25 USD" — want a positive number of USD, or none/off/no cap. Refusing to guess. — not spawning until it is fixed']));
}
{
  const e = eligibility(snap(byKey(triaged('A')), { budget: { raw: '25 USD', label: 'the queue\'s budget_usd' } }));
  t('the queue\'s own budget is named as such', e.stalls[0].startsWith('desk: the queue\'s budget_usd is "25 USD"'), true);
  const unread = eligibility(snap(byKey(triaged('A')), { budget: { error: 'desk: config unreadable' } }));
  t('a budget that could not be read at all holds every spawn too', j([unread.held, unread.stalls]), j(['the batch budget holds every spawn', ['desk: config unreadable — not spawning until it is fixed']]));
}
{
  const spentOut = byKey({ key: 'A', state: 'done', cost: 6 }, { key: 'B', state: 'done', cost: 4.5 }, triaged('C'));
  const e = eligibility(snap(spentOut, { budget: { raw: '10', label: 'the batch budget' } }));
  t('a batch that spent its budget holds every spawn', e.held, 'the batch budget holds every spawn');
  t('and says how much of it went', j(e.stalls), j(['batch budget reached: $10.50 of $10 — not spawning anything further']));
  const under = eligibility(snap(spentOut, { budget: { raw: '11', label: 'the batch budget' } }));
  t('under its budget nothing holds, and nothing is said', j([under.held, under.lines]), j([null, []]));
  t('no cap holds nothing whatever was spent', eligibility(snap(spentOut, { budget: { raw: 'off', label: 'the batch budget' } })).held, null);
}

// ---- the candidates and their order ----
// AC2: five new triaged tickets and two free slots: all five are candidates, in queue order, and two slots.
{
  const e = eligibility(snap(byKey(triaged('A'), triaged('B'), triaged('C'), triaged('D'), triaged('E'))));
  t('AC2 every new triaged ticket is a candidate, in queue rank order', j(keys(e.spawnable)), j(['A', 'B', 'C', 'D', 'E']));
  t('AC2 and two free slots are two slots', slots(slotsSnap(e)).slots, 2);
  t('AC2 nothing holds and nothing is said', j([e.held, e.lines]), j([null, []]));
}
// AC3: a killed worker waiting to resume goes ahead of new tickets ranked above it, as a handoff does.
{
  const e = eligibility(snap(byKey(triaged('A'), triaged('B'), triaged('C', { resume: 'pending' }))));
  t('AC3 the resuming ticket is the first candidate', j(keys(e.spawnable)), j(['C', 'A', 'B']));
  const h = eligibility(snap(byKey(triaged('A'), triaged('B', { handoff: 'pending' }), triaged('C', { resume: 'usage' }))));
  t('a handoff goes first too, and the two keep their queue order', j(keys(h.spawnable)), j(['B', 'C', 'A']));
  t('toResume and toHandoff read the queue fields', j([toResume({ resume: 'maintenance' }), toResume({ resume: 'done' }), toHandoff({ handoff: 'pending' })]), j([true, false, true]));
}
{
  const tickets = byKey(triaged('A', { open_questions: 1 }), { key: 'B', state: 'running' }, triaged('C'), { key: 'D', state: 'parked' }, triaged('E'));
  t('only a triaged ticket with no open question is a candidate', j(keys(eligibility(snap(tickets)).spawnable)), j(['C', 'E']));
  t('one whose files are at their budget is not, and its read is asked only for a triaged ticket with no question',
    j(keys(eligibility(snap(tickets), { collides: (a) => { if (!['C', 'E'].includes(a.key)) throw new Error(a.key); return a.key === 'C'; } }).spawnable)), j(['E']));
}
{
  const e = eligibility(snap(byKey(triaged('A', { cycle_link: 'B' }), triaged('C', { cycle_link: 'D|E' }), triaged('F'))));
  t('a ticket in a link cycle waits', j(keys(e.spawnable)), j(['F']));
  t('and the report says which comes first is asked', j(e.lines),
    j(['not spawning A (linked in Jira as blocked by B, which is held behind it), C (linked in Jira as blocked by D, E, which are held behind it): which comes first is asked in needs-you']));
  t('a cycle is not a person stall', j(e.stalls), '[]');
}
{
  const e = eligibility(snap(byKey(triaged('A'), triaged('B'), triaged('C'))), { finished: (a) => a.key !== 'B' });
  t('a ticket whose worker already printed AUTOPILOT_DONE is not respawned', j(keys(e.spawnable)), j(['B']));
  t('and the person is told how to re-run it', j(e.stalls), j(['not respawning (its worker already printed AUTOPILOT_DONE): A, C — if the re-run is deliberate: node /bin/queue.mjs requeue <TICKET>']));
  t('and a finished ticket is not counted eligible', e.eligible.length, 1);
}
{
  const tickets = byKey(triaged('A', { resume: 'reboot' }), triaged('B', { resume: 'reboot' }), triaged('C'));
  const e = eligibility(snap(tickets), { 'reboot-wait': (a) => (a.key === 'A' ? 'waits for the restart' : null) });
  t('a worker stopped for a planned reboot waits until it may resume', j(keys(e.spawnable)), j(['B', 'C']));
  const asked = [];
  eligibility(snap(tickets), { 'reboot-wait': (a) => { asked.push(a.key); return null; } });
  t('and only a reboot stop is asked about', j(asked), j(['A', 'B']));
}

// ---- what holds every spawn ----
// AC4: usage ahead of pace starts no ticket and says so; a fix try still starts.
{
  const pace = { bad: null, hold: true, line: 'pace: 7-day 70% against 50% even' };
  const e = eligibility(snap(byKey(triaged('A'), triaged('B')), { pace, paceProbe: '; read by a probe call just now' }));
  t('AC4 usage ahead of pace holds every spawn', j([e.held, e.spawnHeld]), j([PACE_HELD, PACE_HELD]));
  t('AC4 no ticket starts this pass', j([keys(e.spawnable), slots(slotsSnap(e)).slots]), j([[], 0]));
  t('AC4 the pace-held line is returned', j(e.lines), j(['pace: 7-day 70% against 50% even (0 running carry on; fix tries still start; read by a probe call just now)']));
  const fix = eligibility(snap(byKey(triaged('A'), triaged('B', { fix: { finished: false } })), { pace }));
  t('a fix try still starts under pacing, within the worker count', j([keys(fix.spawnable), fix.held, fix.spawnHeld, slots(slotsSnap(fix)).slots]), j([['B'], PACE_HELD, null, 2]));
}
{
  const e = eligibility(snap(byKey(triaged('A')), { pace: { bad: 'desk: config §3b "Usage pacing headroom (points)" is "lots"', hold: false, line: '' } }));
  t('a pacing row that does not read holds every spawn, as a person stall', j([e.held, e.stalls]),
    j(['config §3b "Usage pacing headroom (points)" holds every spawn', ['desk: config §3b "Usage pacing headroom (points)" is "lots" — not spawning until it is fixed']]));
}
{
  const usageHold = { type: 'five_hour', resetsAt: null };
  const e = eligibility(snap(byKey(triaged('A')), { usageHold, probes: [null, 'HTTP 429'] }));
  t('the usage limit holds every spawn and resume', e.held.endsWith('holds every spawn and resume, until it lifts or a probe call succeeds'), true);
  t('and its line names the probe call', e.lines[0].endsWith('(probe: HTTP 429)'), true);
  t('with no probe run, it says so', eligibility(snap(byKey(triaged('A')), { usageHold })).lines[0].endsWith('(probe: not run)'), true);
}
{
  const all = snap(byKey(triaged('A')), {
    maintHold: true, usageHold: { type: 'five_hour', resetsAt: null }, budget: { raw: 'x', label: 'b' }, modelsBad: 'm', checkin: { ok: false, why: 'c' },
    health: { stalls: ['h'], holding: ['disk'] }, spawnGrant: { may: false, key: 'autopilot-workers', perm: 'no', queueBin: '/q' }, pace: { bad: 'p', hold: false, line: '' },
  });
  const order = [];
  const without = { maintHold: false, usageHold: null, budget: { raw: 'none', label: 'b' }, modelsBad: null, checkin: { ok: true },
    health: { stalls: [], holding: [] }, spawnGrant: { may: true, key: 'autopilot-workers', perm: 'yes', queueBin: '/q' }, pace: { bad: null, hold: false, line: '' } };
  let s = all;
  for (const k of Object.keys(without)) { order.push(eligibility(s).held); s = { ...s, [k]: without[k] }; }
  order.push(eligibility(s).held);
  t('what holds every spawn is named in its order of precedence', j(order), j([
    'the maintenance window holds every spawn', order[1], 'the batch budget holds every spawn', 'config §3b "Worker models" holds every spawn',
    'config §3b "Check-in times" holds every spawn', 'a failing health check (disk) holds every spawn', 'config §3 autopilot-workers is "no"',
    'config §3b "Usage pacing headroom (points)" holds every spawn', null]));
  t('every person stall is said, in the order the pass checks them', j(eligibility(all).stalls), j([
    'desk: b is "x" — want a positive number of USD, or none/off/no cap. Refusing to guess. — not spawning until it is fixed',
    'm — not spawning until it is fixed', 'c — not spawning until it is fixed', 'h', 'p — not spawning until it is fixed',
    'not spawning 1 ticket(s): config §3 autopilot-workers is "no" — run /desk-setup to grant it']));
}
{
  const ask = eligibility(snap(byKey(triaged('A'), triaged('B')), { spawnGrant: { may: false, key: 'autopilot-workers', perm: 'ask', queueBin: '/q' } }));
  t('a grant at ask says how to confirm the batch', j(ask.stalls), j(['not spawning 2 ticket(s): config §3 autopilot-workers is "ask" — confirm the batch with the user, then run passes with AUTOPILOT_USER_APPROVED=1']));
  t('with no candidate, a missing grant says nothing', j(eligibility(snap({}, { spawnGrant: { may: false, key: 'k', perm: 'no', queueBin: '/q' } })).stalls), '[]');
}
{
  const low = (avail) => eligibility(snap(byKey({ key: 'R', state: 'running' }, triaged('A')), { memory: { low: true, avail, hold: 4, start: 8, dropTo: 1 } })).lines;
  t('memory under the floor says to drop workers', j(low(3)), j(['memory: 3.0G available, under the 4G floor — §3b says drop to 1 worker(s); holding spawns (1 running; a worker mid-suite will drain)']));
  t('memory in the hold band holds this pass', j(low(6.3)), j(['memory: 6.3G available, in the §3b hold band (4–8G) — holding spawns this pass (1 running; a worker mid-suite will drain)']));
  t('low memory is not a person stall and holds nothing itself', j(eligibility(snap(byKey(triaged('A')), { memory: { low: true, avail: 3, hold: 4, start: 8, dropTo: 1 } })).stalls), '[]');
  t('a test lock queue that could not be read is said', j(eligibility(snap({}, { lockQueue: { unread: true, line: 'test lock: queue unread' } })).lines), j(['test lock: queue unread']));
}

// ---- slots, and borrowing ----
// AC5: another repo's queue that cannot be read counts at that repo's cap.
{
  const e = eligibility(snap(byKey(triaged('A'), triaged('B'))));
  const s = slots(slotsSnap(e, { machineCap: 4, machineProfiled: true, otherRepos: [{ slug: 'o__r', batch: null, error: 'bad JSON' }], repoCaps: { o__r: 3 } }));
  t('AC5 an unreadable queue counts at its repo\'s cap', s.machineLine,
    'machine budget: 3 of the machine\'s 4 worker(s) running across every repo; o/r\'s queue cannot be read (bad JSON), so it counts at its cap of 3 workers: starting at most 1');
  t('AC5 and the slots are what is left of the machine', s.slots, 1);
}
{
  const e = eligibility(snap(byKey(triaged('A'), triaged('B'))));
  t('with no machine profile, the repo uses its own rows', slots(slotsSnap(e)).machineLine, 'machine budget: none — no machine profile, so this repo uses its own §3b rows');
  t('one with no worker cap says so', slots(slotsSnap(e, { machineProfiled: true })).machineLine, 'machine budget: none — the machine profile has no autopilot-concurrency, so this repo uses its own §3b rows');
  t('a count made without the lock says why', slots(slotsSnap(e, { machineCap: 4, lockWhy: 'lock busy' })).machineLine.endsWith(' (counted without the lock: lock busy)'), true);
  t('the maintenance window leaves no slot', slots(slotsSnap(e, { maintHold: true })).slots, 0);
  t('running workers take the batch\'s own number', slots(slotsSnap(e, { running: 1 })).slots, 1);
  const sibling = { slug: 's', batch: 'other', live: true, running: 1, ready: 0, share: 2, last: null };
  const unlocked = slots(slotsSnap(e, { lockWhy: 'lock busy', repoBatches: [sibling] }));
  t('a live sibling batch counted without the lock starts nothing', j([unlocked.slots, unlocked.repoUnlocked, unlocked.repoLine]),
    j([0, true, 'repo workers: nothing starts this pass: the repo\'s batches share its §3b cap, and lock busy']));
  t('an idle one shares nothing', slots(slotsSnap(e, { lockWhy: 'lock busy', repoBatches: [{ ...sibling, live: false, running: 0 }] })).repoUnlocked, false);
  const shared = slots(slotsSnap(e, { repoBatches: [sibling] }));
  t('under the lock, the repo\'s cap is shared with its sibling', j([shared.slots, shared.repo.room]), j([2, 2]));
  const base = slots(slotsSnap(eligibility(snap({})), { machineCap: 1, machineProfiled: true, baseWanted: true, otherRepos: [{ slug: 'x', batch: null, q: { tickets: { Z: { state: 'running' } } } }] }));
  t('a base worker with no ticket still wants its one slot', base.machineLine.endsWith(': the machine is at its cap, so nothing starts this pass'), true);
}
{
  const e = eligibility(snap(byKey(triaged('A'), triaged('B'))));
  const s = slotsSnap(e, { concurrency: 1, borrowOn: true, machineCap: 4 });
  t('a live base conflict fix in a batch of 1 holds its one worker', j(ticketSlotsOf(s, 1, { baseFixLive: true, baseFixOn: true })), j({ workers: 1, plan: { slots: 0, own: 0, borrow: 0, line: null }, slots: 0 }));
  t('with none, a ticket takes the slot', ticketSlotsOf(s, 1, { baseFixLive: false, baseFixOn: false }).slots, 1);
  t('the ticket slots are never above the pass\'s', ticketSlotsOf(slotsSnap(e), 1, { baseFixLive: false, baseFixOn: false }).slots, 1);
}

// AC7: the decisions start no process, call no git, gh or Jira, and write nothing.
{
  const tickets = byKey(triaged('A', { resume: 'reboot' }), triaged('B', { cycle_link: 'A' }), triaged('C'));
  const s = snap(tickets, { budget: { raw: '25 USD', label: 'the batch budget' }, memory: { low: true, avail: 3, hold: 4, start: 8, dropTo: 1 } });
  const run = withNoIo(() => {
    const e = eligibility(s, { finished: (a) => a.key === 'C' });
    const d = slots(slotsSnap(e, { machineCap: 4, otherRepos: [{ slug: 'o', error: 'x' }], repoCaps: { o: 2 } }));
    return { e, d };
  });
  t('AC7 the decisions threw nothing', run.threw, null);
  t('AC7 they started no process and wrote nothing', j(run.calls), '[]');
  t('AC7 every action they returned had a handler', j(run.out.e.failed), '[]');
  t('AC7 their actions are reads, lines and the decision', j([...new Set(run.out.e.actions.map((a) => a.type))]), j(['stall', 'report', 'collides', 'finished', 'reboot-wait', 'eligibility']));
}

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
