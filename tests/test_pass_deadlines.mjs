// suite: pass phase: deadlines (each wait a ticket is in, with its deadline, escalated once past it)
// layer: L1
import { runPhase } from '../desk/bin/pass/run-phase.mjs';
import { decideDeadlines, nextWaits, waitsOf, WAITS, EVIDENCE_PROGRESS_MS, BASE_RED_MS, baseRedWait, OUTAGE_MS, outageWait } from '../desk/bin/pass/deadlines.mjs';
import { SUITE_WAIT_CEILING_MS } from '../desk/bin/pass/shared.mjs';
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
// would keep them. `slotHeld` is pass.mjs's: the handoffs full slots held, with their holders.
// -> { actions, lines (the waiting lines), waits (the lines that are nobody's), failed }
function pass(tickets, mins, { dry = false, slotHeld = {} } = {}) {
  const report = { failed: [], waiting: [], waits: [] };
  const byKey = Object.fromEntries(tickets.map((x) => [x.key, x]));
  const actions = runPhase({
    name: 'deadlines', snapshot: () => ({ tickets: byKey, at: at(mins), dry, slotHeld }), decide: decideDeadlines, report,
    handlers: {
      set: (a) => { for (const f of a.fields) { const i = f.indexOf('='); byKey[a.key][f.slice(0, i)] = JSON.parse(f.slice(i + 1)); } },
      report: (a) => report[a.list].push(a.line),
    },
  });
  return { actions, lines: report.waiting, waits: report.waits, failed: report.failed };
}

t('the deadlines: a mergeability answer has the undraft limit before its repair and again after, to the person; a handoff 15 minutes, to a requeue; progress 45 minutes, to the person', j(WAITS),
  j({ mergeability: { ms: 2 * UNKNOWN_LIMIT_MS, escalate_to: 'person' }, handoff: { ms: 900000, escalate_to: 'requeue' }, progress: { ms: 2700000, escalate_to: 'person' } }));
t('and progress at Stage 5 90 minutes', EVIDENCE_PROGRESS_MS, 5400000);

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

// A handoff full slots hold waits for a slot, naming the holders, with no deadline until one frees.
{
  const full = { slotHeld: { H: ['A-1', 'A-2'] } };
  const SLOT = 'H: waiting for a slot (held by A-1, A-2) — its Stage 4b session starts once one frees, and its 15-minute deadline runs from then';
  const h = handedOff('H');
  pass([h], 0, full);
  const held = pass([h], 26, full);
  t('issue-1491 AC1 26 minutes after its handoff with every slot held, it waits for a slot, naming the holders, and is not past its deadline',
    j([held.waits, held.lines]), j([[SLOT], []]));
  t('issue-1491 AC1 its wait records the holders and no deadline, and stays open while held', j(h.waits), j({ handoff: { since: at(0), escalate_to: 'requeue', stage: '4b', held_by: ['A-1', 'A-2'] } }));
  const freed = pass([h], 30);
  t('issue-1491 AC2 once a slot frees, its clock starts then, unescalated', j([h.waits, freed.lines, freed.waits]),
    j([{ handoff: { since: at(30), deadline: at(45), escalate_to: 'requeue', stage: '4b' } }, [], []]));
  t('issue-1491 AC2 within 15 minutes of the slot freeing nothing is escalated', pass([h], 44).lines.length, 0);
  t('issue-1491 AC3 past its deadline with a slot free, it is past its deadline as before', pass([h], 46).lines[0]?.startsWith('H: HANDOFF NOT STARTED — its Stage 4b session has not started 16 minutes after its handoff'), true);

  const e = handedOff('E');
  pass([e], 0);
  pass([e], 16);
  const now = pass([e], 20, { slotHeld: { E: ['A-1'] } });
  t('issue-1491 an escalated handoff later held by full slots waits for a slot instead, and leaves WAITING ON YOU', j([now.lines.length, now.waits.length, e.waits.handoff.escalated ?? null]), j([0, 1, null]));
  const late = handedOff('L');
  pass([late], 0);
  t('issue-1491 AC3 a handoff with no slot hold is past its deadline as today', pass([late], 26).lines.length, 1);
}

// DS-902: a running worker's progress (a stage change, commit or push, kept as progress_at by the advance
// step) has a deadline of 45 minutes, 90 at Stage 5, escalated once to the person.
{
  const running = (key, fields = {}) => ({ key, state: 'running', stage: '3/9', progress_at: at(0), ...fields });
  const NOT = (key, stage, mins, limit) => `${key}: NOT PROGRESSING — its worker at Stage ${stage} has made no stage change, commit or push for ${mins} minutes, since ${at(0)}, past its ${limit}-minute deadline, though its log may still grow (a hung call heartbeats into it). Desk leaves it running: read its log to see what it is doing`;
  const w = running('W');
  const made = pass([w], 0);
  t('progress made this pass opens no wait', j([w.waits ?? null, made.lines.length]), j([null, 0]));
  pass([w], 5);
  t('the next pass with none opens one from the progress time', j(w.waits), j({ progress: { since: at(0), deadline: at(45), escalate_to: 'person', stage: '3/9', head: null, pushed: null } }));
  t('AC1 short of its deadline, nothing is escalated, however much its log grew', pass([w], 44).lines.length, 0);
  const due = pass([w], 46);
  t('AC1 past it, the worker is reported not progressing, to the person', j(due.lines), j([NOT('W', '3/9', 46, 45)]));
  t('AC1 and its escalation is recorded on the wait', w.waits.progress.escalated, at(46));
  const again = pass([w], 60);
  t('AC2 still not progressing, it is not escalated again and nothing is written', j([w.waits.progress.escalated, writes(again)]), j([at(46), 0]));
  t('AC2 its line, still listed while it waits, is the same decider item', j(ids(again.lines)), j(ids(due.lines)));

  const e = running('E', { stage: '5/9' });
  pass([e], 1);
  const long = pass([e], 60);
  t('AC3 at Stage 5, 60 minutes with no progress escalates nothing', long.lines.length, 0);
  t('AC3 its deadline is 90 minutes', e.waits.progress.deadline, at(90));
  t('and past 90 it is escalated', j(pass([e], 91).lines), j([NOT('E', '5/9', 91, 90)]));

  const s = running('S', { suite_wait_since: T0 + 30 * 60000 });
  pass([s], 1);
  t('AC4 a suite wait under its ceiling pauses the clock: past the progress deadline, nothing is escalated', pass([s], 50).lines.length, 0);
  const c = running('C', { suite_wait_since: T0 + 5 * 60000 });
  pass([c], 1);
  t('AC5 a suite wait past its ceiling is the advance step\'s ceiling report: no second escalation for progress', pass([c], 5 + SUITE_WAIT_CEILING_MS / 60000 + 15).lines.length, 0);
  Object.assign(c, { state: 'parked' });
  t('AC5 and once the ceiling parks it, its progress wait ends', (pass([c], 60), c.waits), null);

  const p = running('P');
  pass([p], 1);
  pass([p], 46);
  Object.assign(p, { progress_at: at(50.5) });
  const pushed = pass([p], 50);
  t('AC6 a push this pass closes the open progress wait, escalated or not', j([p.waits ?? null, pushed.lines.length]), j([null, 0]));
  pass([p], 55);
  t('AC6 and the next pass\'s wait runs from the push, not escalated', j([p.waits.progress.since, p.waits.progress.deadline, p.waits.progress.escalated ?? null]), j([at(50.5), at(95.5), null]));
  t('a running ticket with no progress time has no progress wait', j(waitsOf({ key: 'N', state: 'running' }, at(5))), '{}');

  // The advance step moves progress_at on by a suite wait that ended under its ceiling.
  const m = running('M');
  pass([m], 1);
  Object.assign(m, { progress_at: at(20) });
  pass([m], 50);
  t('a wait not yet escalated follows progress_at moved on by a suite wait: its deadline moves too', j([m.waits.progress.since, m.waits.progress.deadline, m.waits.progress.escalated ?? null]), j([at(20), at(65), null]));
  const q = running('Q');
  pass([q], 1);
  const first = pass([q], 46);
  Object.assign(q, { progress_at: at(20) });
  const later = pass([q], 80);
  t('AC2 an escalated wait whose progress_at a suite wait moved on is not escalated again: it keeps its start and escalation', j([q.waits.progress.since, q.waits.progress.escalated, writes(later)]), j([at(0), at(46), 0]));
  t('AC2 and its line stays the same decider item', j(ids(later.lines)), j(ids(first.lines)));
  // A pass that recorded a push and ended before its sweep: the next pass's sweep reads the push.
  const r = running('R', { progress_sha: { head: HEAD, pushed: null } });
  pass([r], 1);
  pass([r], 46);
  Object.assign(r, { progress_at: at(50.5), progress_sha: { head: HEAD, pushed: HEAD } });
  const after = pass([r], 55);
  t('an escalated wait ends at a push a cut-off pass recorded: the next pass\'s wait runs from it, not escalated, and nothing is said', j([r.waits.progress.since, r.waits.progress.escalated ?? null, after.lines.length]), j([at(50.5), null, 0]));

  const u = running('U');
  pass([u], 1);
  Object.assign(u, { usage_paused: { type: 'five_hour', resets_at: null } });
  const held = pass([u], 120);
  t('a worker held at a usage limit has no progress wait, so nothing is escalated however long the hold', j([u.waits, held.lines.length]), j([null, 0]));
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

// DS-903 AC3: the batch's red base escalates once past its 60-minute deadline, saying how long it lasted.
{
  const rec = { branch: 'main', check: 'tests', since: at(0), deadline: at(60), merges: [{ pr: 802, ticket: 'T-2' }] };
  t('AC3 the red base\'s deadline is 60 minutes', BASE_RED_MS, 60 * 60000);
  const before = baseRedWait(rec, at(59));
  t('AC3 before its deadline it is not escalated', j([before.rec.escalated ?? null, before.line]), j([null, null]));
  const due = baseRedWait(rec, at(61));
  t('AC3 past it, it is escalated, the line saying how long', j([due.rec.escalated, /^main: RED BASE — it has been red for 61 minutes, since .*, past its 60-minute deadline: tests still fails there.*#802 \(T-2\)$/.test(due.line)]), j([at(61), true]));
  const next = baseRedWait(due.rec, at(70));
  t('AC3 once only: a later pass keeps when it was escalated', next.rec.escalated, at(61));
  t('AC3 and the decider reads both passes\' lines as one item', new Set([...ids([due.line]), ...ids([next.line])]).size, 1);
}

// DS-904 AC3: the batch's platform outage escalates once past its 2-hour deadline, saying how long it lasted.
{
  const rec = { check: '"Deploy preview"', since: at(0), deadline: at(120) };
  t('AC3 the outage\'s deadline is 2 hours', OUTAGE_MS, 120 * 60000);
  const before = outageWait(rec, at(119), 'main');
  t('AC3 before its deadline it is not escalated', j([before.rec.escalated ?? null, before.line]), j([null, null]));
  const due = outageWait(rec, at(121), 'main');
  t('AC3 past it, it is escalated, the line saying how long', j([due.rec.escalated, /^main: PLATFORM OUTAGE — "Deploy preview" has been red on every open PR with a run of it for 121 minutes, since .*, past its 120-minute deadline: /.test(due.line)]), j([at(121), true]));
  const next = outageWait(due.rec, at(150), 'main');
  t('AC3 once only: a later pass keeps when it was escalated', next.rec.escalated, at(121));
  t('AC3 and the decider reads both passes\' lines as one item', new Set([...ids([due.line]), ...ids([next.line])]).size, 1);
  t('AC3 a held check with an Actions run: the pass keeps re-running it', due.line.includes('the pass keeps re-running it'), true);
  const status = outageWait(rec, at(121), 'main', { runnable: false }).line;
  t('AC3 a platform status with no Actions run is never said to be re-run: redeploy or push instead',
    j([status.includes('re-running'), status.includes('no Actions run reports it, so nothing desk re-runs turns it green'), status.includes('redeploy there or push to the PRs')]), j([false, true, true]));
}

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
