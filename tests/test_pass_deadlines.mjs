// suite: pass phase: deadlines (each wait a ticket is in, with its deadline, escalated once past it)
import { runPhase } from '../desk/bin/pass/run-phase.mjs';
import { decideDeadlines, nextWaits, waitsOf, WAITS } from '../desk/bin/pass/deadlines.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

// A fixed clock: every pass's time is minutes after T0.
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const at = (mins) => new Date(T0 + mins * 60000).toISOString();
const draft = (key, mergeable, fields = {}) => ({ key, state: 'done', result: { pr: 801 }, pr_status: { pr: 801, state: 'OPEN', isDraft: true, mergeable }, ...fields });
const handedOff = (key, fields = {}) => ({ key, state: 'triaged', handoff: 'pending', handoff_stage: '4b', ...fields });

// One pass of the sweep over `tickets` at `mins`, its writes laid back onto the tickets as the queue
// would keep them. -> { actions, lines (the waiting lines), failed }
function pass(tickets, mins, { dry = false } = {}) {
  const report = { failed: [], waiting: [] };
  const byKey = Object.fromEntries(tickets.map((x) => [x.key, x]));
  const actions = runPhase({
    name: 'deadlines', snapshot: () => ({ tickets: byKey, at: at(mins), dry }), decide: decideDeadlines, report,
    handlers: {
      set: (a) => { for (const f of a.fields) { const i = f.indexOf('='); byKey[a.key][f.slice(0, i)] = JSON.parse(f.slice(i + 1)); } },
      report: (a) => report[a.list].push(a.line),
    },
  });
  return { actions, lines: report.waiting, failed: report.failed };
}

t('the deadlines are the ticket\'s: 30 minutes to the person, 15 to a requeue', j(WAITS), j({ mergeability: { ms: 1800000, escalate_to: 'person' }, handoff: { ms: 900000, escalate_to: 'requeue' } }));

// AC3: UNKNOWN for less than its deadline: the wait starts, and nothing is escalated.
{
  const a = draft('A', 'UNKNOWN');
  const first = pass([a], 0);
  t('AC3 the first pass to see UNKNOWN starts the wait, with its start, deadline and escalation', j(a.waits),
    j({ mergeability: { since: at(0), deadline: at(30), escalate_to: 'person', pr: 801 } }));
  t('AC3 and escalates nothing', first.lines.length, 0);
  const later = pass([a], 29);
  t('AC3 at 29 minutes it still escalates nothing', later.lines.length, 0);
  t('AC3 and writes nothing, its wait unchanged', later.actions.length, 0);
}

// AC1 and AC2: past its deadline, escalated once to the person with how long it has waited; not again.
{
  const a = draft('A', 'UNKNOWN');
  pass([a], 0);
  const due = pass([a], 31);
  t('AC1 past the deadline it is escalated to the person, once, with how long it has waited', j(due.lines),
    j([`A: NO MERGE ANSWER — GitHub has not worked out whether PR #801 conflicts with its base for 31 minutes, since ${at(0)}, past its 30-minute deadline. Push a new commit to #801 (an empty one will do) for a fresh merge ref; if it still has no answer, open a new PR from its branch`]));
  t('AC1 the escalation is recorded on the wait', a.waits.mergeability.escalated, at(31));
  const again = pass([a], 45);
  t('AC2 still UNKNOWN at the next pass, it is not escalated again', again.lines.length, 0);
  t('AC2 and its wait is left as it was', again.actions.length, 0);
}

// The undraft step's first sight of UNKNOWN (the draft's unknown_since) is when the wait started, and
// the one repair DS-856 tried is said in the escalation.
{
  const tried = { at: at(-10), head: 'a'.repeat(40), ok: true };
  const a = draft('A', 'UNKNOWN', { undraft: { call: 'wait', pr: 801, unknown_since: at(-40), unknown_repair: tried } });
  const r = pass([a], 0);
  t('a wait first seen by the undraft step starts then', a.waits.mergeability.since, at(-40));
  t('so it is past its deadline at once, and the escalation says what was tried', r.lines[0]?.includes('for 40 minutes') && r.lines[0]?.includes('desk already updated its branch from its base once'), true);
  const other = draft('B', 'UNKNOWN', { undraft: { call: 'wait', pr: 799, unknown_since: at(-40) } });
  pass([other], 0);
  t('an undraft record for another PR is not this wait\'s start', other.waits.mergeability.since, at(0));
  const bad = draft('C', 'UNKNOWN', { undraft: { call: 'wait', pr: 801, unknown_since: 'whenever' } });
  pass([bad], 0);
  t('an unknown_since that is not a time starts the wait at this pass', bad.waits.mergeability.since, at(0));
}

// AC4: UNKNOWN, then MERGEABLE: the wait is closed and nothing is escalated.
{
  const a = draft('A', 'UNKNOWN');
  pass([a], 0);
  a.pr_status.mergeable = 'MERGEABLE';
  const r = pass([a], 31);
  t('AC4 once GitHub answers, the wait is closed', a.waits, null);
  t('AC4 and nothing is escalated', r.lines.length, 0);
  a.pr_status.mergeable = 'UNKNOWN';
  pass([a], 40);
  t('AC4 a later spell with no answer is a new wait, from its own start', j([a.waits.mergeability.since, a.waits.mergeability.escalated ?? null]), j([at(40), null]));
  const c = draft('B', 'UNKNOWN');
  pass([c], 0);
  c.pr_status = { ...c.pr_status, state: 'MERGED' };
  pass([c], 5);
  t('a PR that merged ends its wait', c.waits, null);
  const d = draft('D', 'UNKNOWN');
  pass([d], 0);
  d.result.pr = 802; d.pr_status = { pr: 802, state: 'OPEN', mergeable: 'UNKNOWN' };
  pass([d], 31);
  t('a new PR is a new wait, not escalated on the old one\'s clock', j([d.waits.mergeability.pr, d.waits.mergeability.since]), j([802, at(31)]));
  t('a CONFLICTING answer is no wait', j(waitsOf(draft('E', 'CONFLICTING'))), '{}');
  t('an unread mergeability is no wait', j(waitsOf(draft('E', null))), '{}');
  t('a ticket not done is no mergeability wait', j(waitsOf({ ...draft('E', 'UNKNOWN'), state: 'running' })), '{}');
}

// AC5: a handoff whose next session has not started by its deadline is escalated once for a requeue.
{
  const h = handedOff('H');
  pass([h], 0);
  t('AC5 a pending handoff starts a wait, escalating to a requeue', j(h.waits), j({ handoff: { since: at(0), deadline: at(15), escalate_to: 'requeue', stage: '4b' } }));
  t('AC5 within its deadline nothing is escalated', pass([h], 14).lines.length, 0);
  const due = pass([h], 16);
  t('AC5 past it, it is escalated once for a requeue', j(due.lines),
    j([`H: HANDOFF NOT STARTED — its Stage 4b session has not started 16 minutes after its handoff, since ${at(0)}, past its 15-minute deadline. If nothing in this report holds it back (a slot, memory, a usage limit), requeue it: queue.mjs requeue H`]));
  t('AC5 and not again at the next pass', pass([h], 30).lines.length, 0);
  Object.assign(h, { state: 'running', handoff: null });
  pass([h], 31);
  t('AC5 once its session starts, the wait ends', h.waits, null);
}

// Two waits on two tickets in one pass, a dry run, and the decision starts no process and writes nothing.
{
  const a = draft('A', 'UNKNOWN', { waits: { mergeability: { since: at(0), deadline: at(30), escalate_to: 'person', pr: 801 } } });
  const h = handedOff('H', { waits: { handoff: { since: at(0), deadline: at(15), escalate_to: 'requeue', stage: '4b' } } });
  const dry = pass([a, h], 31, { dry: true });
  t('a dry run says each escalation', dry.lines.length, 2);
  t('and records none', j(dry.actions.filter((x) => x.type === 'set')), '[]');
  const r = withNoIo(() => decideDeadlines({ tickets: { A: a, H: h }, at: at(31), dry: false }));
  t('the decision starts no process and writes nothing', j([r.threw, r.calls]), j([null, []]));
  t('it sets each ticket\'s waits and says each escalation', j(r.out.map((x) => `${x.type} ${x.key}`)), j(['report A', 'set A', 'report H', 'set H']));
  t('a wait kept on another stage is a new one', nextWaits(handedOff('H', { handoff_stage: 7, waits: h.waits }), at(31)).waits.handoff.since, at(31));
}

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
