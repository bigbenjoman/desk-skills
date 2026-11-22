// suite: pass phase: deadlines (each wait a ticket is in, with its deadline, escalated once past it)
import { runPhase } from '../desk/bin/pass/run-phase.mjs';
import { decideDeadlines, nextWaits, waitsOf, WAITS } from '../desk/bin/pass/deadlines.mjs';
import { deciderItems } from '../desk/bin/decider.mjs';
import { UNKNOWN_LIMIT_MS } from '../desk/bin/undraft.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

// A fixed clock: every pass's time is minutes after T0.
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const at = (mins) => new Date(T0 + mins * 60000).toISOString();
const LIMIT = UNKNOWN_LIMIT_MS / 60000;
const HEAD = 'a'.repeat(40);
const pr = (key, mergeable, isDraft, fields = {}) => ({ key, state: 'done', result: { pr: 801 }, pr_status: { pr: 801, state: 'OPEN', isDraft, mergeable, head: HEAD }, ...fields });
const draft = (key, mergeable, fields) => pr(key, mergeable, true, fields);
const ready = (key, mergeable, fields) => pr(key, mergeable, false, fields);
// The undraft step's record of a draft's spell with no answer, as undraftCall keeps it.
const spell = (call, since, more = {}) => ({ undraft: { call, pr: 801, sha: HEAD, unknown_since: since, ...more } });
const handedOff = (key, fields = {}) => ({ key, state: 'triaged', handoff: 'pending', handoff_stage: '4b', ...fields });
// The decider's item ids for `lines`: one id is one item, however many passes list it.
const ids = (lines) => deciderItems({ waiting: lines, parked: [] }).map((i) => i.id);
// The queue writes a pass made.
const writes = (p) => p.actions.filter((x) => x.type === 'set').length;

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

t('the deadlines: a mergeability answer has the undraft limit before its repair and again after, to the person; a handoff 15 minutes, to a requeue', j(WAITS),
  j({ mergeability: { ms: 2 * UNKNOWN_LIMIT_MS, escalate_to: 'person' }, handoff: { ms: 900000, escalate_to: 'requeue' } }));

// AC3: UNKNOWN for less than its deadline: the wait starts, and nothing is escalated.
{
  const a = draft('A', 'UNKNOWN', spell('wait', at(0)));
  const first = pass([a], 0);
  t('AC3 the first pass to see UNKNOWN starts the wait at the undraft step\'s first sight, with its deadline and escalation', j(a.waits),
    j({ mergeability: { since: at(0), deadline: at(2 * LIMIT), escalate_to: 'person', pr: 801 } }));
  t('AC3 and escalates nothing', first.lines.length, 0);
  const later = pass([a], LIMIT + 5);
  t('AC3 while the undraft step still waits on its one repair, nothing is escalated', later.lines.length, 0);
  t('AC3 and its wait is written once only', later.actions.length, 0);
  const r = ready('R', 'UNKNOWN');
  pass([r], 0);
  t('AC3 a ready PR short of its deadline, with no merge-ref note, escalates nothing', pass([r], 2 * LIMIT - 1).lines.length, 0);
}

// AC1 and AC2: a draft the undraft step has made the person's is escalated once, in the undraft step's
// own DRAFT line, which says how long it has waited; the sweep records it and says no second line.
{
  const a = draft('A', 'UNKNOWN', spell('wait', at(0)));
  pass([a], 0);
  Object.assign(a, spell('person', at(0), { unknown_repair: { at: at(LIMIT), head: HEAD, ok: true } }));
  const due = pass([a], 2 * LIMIT + 1);
  t('AC1 a draft its undraft call made the person\'s is escalated, then', a.waits.mergeability.escalated, at(2 * LIMIT + 1));
  t('AC1 in the undraft step\'s DRAFT line, with no second line from the sweep', due.lines.length, 0);
  const again = pass([a], 2 * LIMIT + 15);
  t('AC2 still UNKNOWN at the next pass, its escalation is not recorded again', j([a.waits.mergeability.escalated, again.actions.length]), j([at(2 * LIMIT + 1), 0]));
  t('AC2 nor said by the sweep', again.lines.length, 0);
}

// AC1 and AC2: a ready PR the merge driver has made the person's is escalated with its note, which
// says how long; the line stays listed while it waits, as one decider item, and is not escalated again.
{
  const note = 'GitHub has not worked out whether #801 conflicts with its base at aaaaaaaaa for 61 minutes, and starts no run for that head; desk already updated its branch from its base once, and GitHub still has no answer: push a new commit (an empty one will do) for a fresh merge ref, or open a new PR from its branch';
  const r = ready('R', 'UNKNOWN');
  pass([r], 0);
  r.merge_blocked = `merge ref: ${note}`;
  const due = pass([r], 40);
  t('AC1 a ready PR with the merge driver\'s merge-ref note is escalated to the person with how long it has waited', j(due.lines), j([`R: NO MERGE ANSWER — PR #801: ${note}`]));
  t('AC1 the escalation is recorded on the wait', r.waits.mergeability.escalated, at(40));
  r.merge_blocked = `merge ref: ${note.replace('61 minutes', '75 minutes')}`;
  const again = pass([r], 55);
  t('AC2 the next pass records no new escalation and writes nothing', j([r.waits.mergeability.escalated, writes(again)]), j([at(40), 0]));
  t('AC2 its line, still listed while it waits, is the same decider item', j(ids(again.lines)), j(ids(due.lines)));
  const lone = ready('L', 'UNKNOWN');
  pass([lone], 0);
  const late = pass([lone], 2 * LIMIT + 1);
  t('AC1 with no merge driver acting on it, a ready PR past its deadline is escalated by the sweep, with how long', j(late.lines),
    j([`L: NO MERGE ANSWER — PR #801: GitHub has not worked out whether it conflicts with its base for ${2 * LIMIT + 1} minutes, since ${at(0)}, past its ${2 * LIMIT}-minute deadline; push a new commit to #801 (an empty one will do) for a fresh merge ref; if it still has no answer, open a new PR from its branch`]));
}

// The undraft record's spell is the wait's start only where it is this spell.
{
  const a = draft('A', 'UNKNOWN', spell('wait', at(-40)));
  pass([a], 0);
  t('a wait first seen by the undraft step starts then', a.waits.mergeability.since, at(-40));
  const other = draft('B', 'UNKNOWN', { undraft: { call: 'wait', pr: 799, sha: HEAD, unknown_since: at(-40) } });
  pass([other], 0);
  t('an undraft record for another PR is not this wait\'s start', other.waits.mergeability.since, at(0));
  const head = draft('C', 'UNKNOWN', { undraft: { call: 'wait', pr: 801, sha: 'b'.repeat(40), unknown_since: at(-4000) } });
  pass([head], 0);
  t('an undraft record kept from another head, with no repair, is not this wait\'s start', head.waits.mergeability.since, at(0));
  const ready2 = draft('D', 'UNKNOWN', { undraft: { call: 'ready', pr: 801, sha: HEAD, unknown_since: at(-4000) } });
  pass([ready2], 0);
  t('nor is one whose call no longer waits on the answer', ready2.waits.mergeability.since, at(0));
  t('and with no owner keeping it, it is past no deadline on its first pass', pass([ready2], 1).lines.length, 0);
  const bad = draft('E', 'UNKNOWN', spell('wait', 'whenever'));
  pass([bad], 0);
  t('an unknown_since that is not a time starts the wait at this pass', bad.waits.mergeability.since, at(0));
}

// AC4: UNKNOWN, then MERGEABLE: the wait is closed and nothing is escalated.
{
  const a = draft('A', 'UNKNOWN', spell('wait', at(0)));
  pass([a], 0);
  a.pr_status.mergeable = 'MERGEABLE';
  const r = pass([a], 2 * LIMIT + 1);
  t('AC4 once GitHub answers, the wait is closed', a.waits, null);
  t('AC4 and nothing is escalated', r.lines.length, 0);
  a.pr_status.mergeable = 'UNKNOWN';
  a.undraft.unknown_since = at(70);
  pass([a], 70);
  t('AC4 a later spell with no answer is a new wait, from its own start', j([a.waits.mergeability.since, a.waits.mergeability.escalated ?? null]), j([at(70), null]));
  const c = draft('B', 'UNKNOWN');
  pass([c], 0);
  c.pr_status = { ...c.pr_status, state: 'MERGED' };
  pass([c], 5);
  t('a PR that merged ends its wait', c.waits, null);
  const d = ready('D', 'UNKNOWN');
  pass([d], 0);
  d.result.pr = 802; d.pr_status = { pr: 802, state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', head: HEAD };
  pass([d], 2 * LIMIT + 1);
  t('a new PR is a new wait, not escalated on the old one\'s clock', j([d.waits.mergeability.pr, d.waits.mergeability.since, d.waits.mergeability.escalated ?? null]), j([802, at(2 * LIMIT + 1), null]));
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
  t('AC5 past it, it is escalated for a requeue', j(due.lines),
    j([`H: HANDOFF NOT STARTED — its Stage 4b session has not started 16 minutes after its handoff, since ${at(0)}, past its 15-minute deadline. If nothing in this report holds it back (a slot, memory, a usage limit), requeue it: queue.mjs requeue H`]));
  const again = pass([h], 30);
  t('AC5 and once: the next pass records no new escalation', j([h.waits.handoff.escalated, writes(again)]), j([at(16), 0]));
  t('AC5 its line, still listed while it waits, is the same decider item', j(ids(again.lines)), j(ids(due.lines)));
  Object.assign(h, { state: 'running', handoff: null });
  const started = pass([h], 31);
  t('AC5 once its session starts, the wait ends and its line goes', j([h.waits, started.lines.length]), j([null, 0]));
}

// Two waits on two tickets in one pass, a dry run, and the decision starts no process and writes nothing.
{
  const a = ready('A', 'UNKNOWN', { waits: { mergeability: { since: at(0), deadline: at(2 * LIMIT), escalate_to: 'person', pr: 801 } } });
  const h = handedOff('H', { waits: { handoff: { since: at(0), deadline: at(15), escalate_to: 'requeue', stage: '4b' } } });
  const dry = pass([a, h], 2 * LIMIT + 1, { dry: true });
  t('a dry run says each escalation', dry.lines.length, 2);
  t('and records none', j(dry.actions.filter((x) => x.type === 'set')), '[]');
  const r = withNoIo(() => decideDeadlines({ tickets: { A: a, H: h }, at: at(2 * LIMIT + 1), dry: false }));
  t('the decision starts no process and writes nothing', j([r.threw, r.calls]), j([null, []]));
  t('it sets each ticket\'s waits and says each escalation', j(r.out.map((x) => `${x.type} ${x.key}`)), j(['report A', 'set A', 'report H', 'set H']));
  t('a wait kept on another stage is a new one', nextWaits(handedOff('H', { handoff_stage: 7, waits: h.waits }), at(31)).waits.handoff.since, at(31));
}

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
