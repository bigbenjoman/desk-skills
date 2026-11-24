// suite: stuck time (each park, hold and stall as an interval with its cause, and the hours stuck per cause per repo per week)
// layer: L1
// covers: desk/bin/stuck-time.mjs desk/bin/ticket-ledger.mjs desk/bin/levers-page.mjs desk/bin/lever-registry.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import * as ST from '../desk/bin/stuck-time.mjs';
import { append as ledgerAppend, fold } from '../desk/bin/ticket-ledger.mjs';
import { renderPage } from '../desk/bin/levers-page.mjs';
import { REGISTRY, GUARDRAILS, reasonWording } from '../desk/bin/lever-registry.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = JSON.stringify;
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'stuck-time.mjs');
// Wednesday of ISO week 2026-W48, which runs from Monday 23 November.
const D = (day, h, m = 0) => `2026-11-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const lines = (S) => (existsSync(join(S, 'stuck-intervals.jsonl')) ? readFileSync(join(S, 'stuck-intervals.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
// The record as a reader takes it: the latest line of each interval.
const intervals = (S) => [...new Map(lines(S).map((e) => [`${e.batch}|${e.key}|${e.cause}|${e.start}`, e])).values()];
const links = (S) => JSON.parse(readFileSync(join(S, 'stuck-links.json'), 'utf8'));
const open = (S) => intervals(S).filter((e) => e.end == null).map((e) => `${e.key} ${e.cause} ${e.start}`).sort();

// ---- a pass's step: an interval opens when its cause appears and closes when it goes ----------------------------
{
  const S = scratch('stuck-time-');
  // Pass 1, 10:00: A parked on a question since 08:00 (classed), B kept waiting by the usage hold, C by a collision.
  const parked = [{ key: 'A', kind: 'question', class: 'missing decision', since: D(24, 8) }];
  const l1 = ST.stuckStep(S, { batch: 'b1', parked, waits: [{ key: 'B', cause: 'usage' }, { key: 'C', cause: 'collision' }], now: D(24, 10) });
  t('a new cause opens an interval: a park from its since, a hold from the pass', j(open(S)), j(['A park: question (missing decision) 2026-11-24T08:00:00.000Z', 'B usage 2026-11-24T10:00:00.000Z', 'C collision 2026-11-24T10:00:00.000Z']));
  t('a step that writes everything says nothing', j(l1), j([]));
  // Pass 2, 10:10: the same causes; nothing new is written.
  ST.stuckStep(S, { batch: 'b1', parked, waits: [{ key: 'B', cause: 'usage' }, { key: 'C', cause: 'collision' }], now: D(24, 10, 10) });
  t('a cause still there writes nothing more', lines(S).length, 3);
  // Pass 3, 12:00: B spawned, C's collision ended and the memory gate holds it, A still parked.
  ST.stuckStep(S, { batch: 'b1', parked, waits: [{ key: 'C', cause: ST.spawnHoldCause({ why: 'memory', harm: 'TMPFS-HIGH' }) }], now: D(24, 12) });
  const closed = intervals(S).filter((e) => e.end != null).map((e) => [e.key, e.cause, e.start, e.end]);
  t('a cause gone closes its interval at the pass, with its start and cause',
    j(closed), j([['B', 'usage', D(24, 10), D(24, 12)], ['C', 'collision', D(24, 10), D(24, 12)]]));
  t('a new cause on the same ticket opens its own interval', open(S).includes(`C memory harm: TMPFS-HIGH ${D(24, 12)}`), true);
  // Another batch's pass in the same repo closes none of b1's intervals.
  ST.stuckStep(S, { batch: 'b2', parked: [], waits: [{ key: 'Z', cause: 'lock' }], now: D(24, 12, 30) });
  t('another batch\'s pass leaves this batch\'s intervals open', open(S).length, 3);
  // A line cut off mid-write is skipped, and the next line is still read.
  appendFileSync(join(S, 'stuck-intervals.jsonl'), '{"key":"Q","cau');
  ST.stuckStep(S, { batch: 'b1', parked: [], waits: [{ key: 'C', cause: 'memory harm: TMPFS-HIGH' }], now: D(24, 14) });
  t('after a cut line, the next pass\'s close of A is read', intervals(S).find((e) => e.key === 'A' && e.end)?.end, D(24, 14));

  // The summary for week 2026-W48 at Wednesday noon: A 08:00-14:00 (6h), B 2h, C 2h collision then
  // 12:00 to now memory (24h), Z 12:30 to now lock (23.5h).
  const s = ST.weekSummary(S, { now: Date.parse(D(25, 12)) });
  t('the week\'s hours per cause, most first, with the tickets each held',
    j(s.causes.map((c) => [c.cause, c.hours, c.tickets])), j([['memory harm: TMPFS-HIGH', 24, 1], ['lock', 23.5, 1], ['park: question (missing decision)', 6, 1], ['usage', 2, 1], ['collision', 2, 1]]));
  t('the week\'s total hours and tickets affected', j([s.week, s.hours, s.tickets]), j(['2026-W48', 57.5, 4]));
  t('an interval is clipped to the week: last week\'s summary has none of this week\'s hours', ST.weekSummary(S, { now: Date.parse(D(25, 12)), weeksAgo: 1 }).tickets, 0);
  // Overlapping causes on one ticket count once in the total, and in its parked hours.
  const O = scratch('stuck-time-overlap-');
  ST.stuckStep(O, { batch: null, parked: [], waits: [{ key: 'X', cause: 'base red' }, { key: 'X', cause: 'gate reviewer down' }], now: D(23, 9) });
  ST.stuckStep(O, { batch: null, parked: [], waits: [{ key: 'X', cause: 'gate reviewer down' }], now: D(23, 11) });
  ST.stuckStep(O, { batch: null, parked: [], waits: [], now: D(23, 12) });
  t('a ticket stuck on two causes at once counts its hours once', j([ST.weekSummary(O, { now: Date.parse(D(25, 12)) }).hours, ST.parkedHours(O, { now: Date.parse(D(25, 12)) })(null, 'X')]), j([3, 3]));
}

// ---- a ticket's hours: from its admission, and an interval its gone batch left open ends at that batch's last pass ---------
{
  const S = scratch('stuck-time-hours-');
  // Batch F-1's passes: K parked at 09:00 (first admission), requeued at 10:00; K again from 12:00; F-1's
  // last pass at 13:00, after which it was archived with an interval still open.
  ST.stuckStep(S, { batch: 'F-1', parked: [{ key: 'K', kind: 'question', since: D(23, 9) }], now: D(23, 9) });
  ST.stuckStep(S, { batch: 'F-1', parked: [], now: D(23, 10) });
  ST.stuckStep(S, { batch: 'F-1', parked: [{ key: 'K', kind: 'question', since: D(23, 12) }], now: D(23, 12) });
  ST.stuckStep(S, { batch: 'F-1', parked: [{ key: 'K', kind: 'question', since: D(23, 12) }], now: D(23, 13) });
  const now = Date.parse(D(25, 12));
  const live = ST.parkedHours(S, { now, live: [{ name: null, created: null }] });
  t('a ticket admitted again counts only the hours after its new admission', j([live('F-1', 'K'), live('F-1', 'K', Date.parse(D(23, 11)))]), j([2, 1]));
  t('an interval its gone batch left open ends at that batch\'s last pass, every week after too',
    j([ST.weekSummary(S, { now, live: [{ name: null, created: null }] }).hours, ST.weekSummary(S, { now: now + 7 * 86_400_000, live: [{ name: null, created: null }] }).tickets]), j([2, 0]));
  t('while the batch is live it still counts to now', ST.parkedHours(S, { now, live: [{ name: null, created: null }, { name: 'F-1', created: null }] })('F-1', 'K'), 49);
  const U = scratch('stuck-time-unreadable-');
  mkdirSync(join(U, 'stuck-intervals.jsonl'));
  t('a record that cannot be read gives no hours, not none', ST.parkedHours(U), null);
  t('no record at all gives none', ST.parkedHours(scratch('stuck-time-none-'))(null, 'K'), 0);
}

// ---- a name used again: the later batch neither closes nor revives the earlier one's open interval -----------------
{
  const S = scratch('stuck-time-reused-');
  // The first F-2's state folder; archived, a second F-2 gets a new one (batch.mjs moves the first to .done/).
  const firstState = join(S, 'batches', 'F-2'), secondState = join(S, 'batches', 'F-2-again');
  mkdirSync(firstState, { recursive: true });
  mkdirSync(secondState, { recursive: true });
  // The first F-2 parks K at 09:00 on the 23rd; its last pass is at 11:00, then it is archived.
  ST.stuckStep(S, { batch: 'F-2', batchState: firstState, parked: [{ key: 'K', kind: 'question', since: D(23, 9) }], now: D(23, 9) });
  ST.stuckStep(S, { batch: 'F-2', batchState: firstState, parked: [{ key: 'K', kind: 'question', since: D(23, 9) }], now: D(23, 11) });
  // A second F-2 passes on the 24th with nothing stuck.
  ST.stuckStep(S, { batch: 'F-2', batchState: secondState, parked: [], now: D(24, 9) });
  t('a later batch of the same name does not close the earlier one\'s interval', intervals(S).filter((e) => e.end != null).length, 0);
  const live = ST.liveOf([{ name: 'F-2', state: secondState }, { name: 'F-2 (archived)', state: firstState, archived: 'F-2' }]);
  t('the live batches are read with when each began, an archived one left out', j(live), j([{ name: 'F-2', created: D(24, 9) }]));
  t('the earlier one\'s open interval ends at its own last pass, not revived by the name', ST.weekSummary(S, { now: Date.parse(D(25, 12)), live }).hours, 2);
  t('while that first batch is the live one, it still counts to now', ST.weekSummary(S, { now: Date.parse(D(25, 12)), live: ST.liveOf([{ name: 'F-2', state: firstState }]) }).hours, 51);
}

// ---- the ledger: each interval's opening and closing is a stuck event, written first, once ----------------------
{
  const S = scratch('stuck-time-ledger-');
  const L = scratch('stuck-time-repo-');
  // As the pass writes it: under an id fixed by the interval.
  const ledger = (e) => ledgerAppend(L, [{ id: `stuck:${e.key}:${e.cause}:${e.start}:${e.end == null ? 'open' : 'close'}`, type: 'stuck', batch: 'b1', key: e.key, data: { cause: e.cause, start: e.start, end: e.end } }], { by: 'pass' });
  ST.stuckStep(S, { batch: 'b1', parked: [{ key: 'A', kind: 'person-step', since: D(24, 8) }], waits: [{ key: 'B', cause: 'test lock queue' }], ledger, now: D(24, 9) });
  t('an interval opening is a stuck event with its cause and start, and the fold has it open',
    j(fold(L).tickets.A.stuck), j({ 'park: person-step': D(24, 8) }));
  let failing = true;
  const flaky = (e) => { if (failing) throw new Error('disk full'); return ledger(e); };
  const said = ST.stuckStep(S, { batch: 'b1', parked: [], waits: [{ key: 'B', cause: 'test lock queue' }], ledger: flaky, now: D(24, 11) });
  t('a ledger write that fails records nothing, and says the next pass tries again', j([said.length, /next pass tries again/.test(said[0] ?? ''), intervals(S).filter((e) => e.end).length]), j([1, true, 0]));
  failing = false;
  ST.stuckStep(S, { batch: 'b1', parked: [], waits: [{ key: 'B', cause: 'test lock queue' }], ledger: flaky, now: D(24, 12) });
  t('the next pass closes it, in the ledger and the record', j([fold(L).tickets.A.stuck, intervals(S).find((e) => e.key === 'A' && e.end)?.end]), j([{}, D(24, 12)]));
  // A retry of an event already written (its record write lost) is folded once.
  ledger({ key: 'A', cause: 'park: person-step', start: D(24, 8), end: D(24, 12) });
  const events = readFileSync(join(L, 'ledger', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).filter((e) => e.key === 'A');
  t('a retried event keeps its id, so the fold takes it once', j([events.length, new Set(events.map((e) => e.id)).size, fold(L).seq >= 3]), j([3, 2, true]));
}

// ---- spawn holds name their cause -----------------------------------------------------------------------------
t('the spawn holds the pass counts name their cause', j([
  ST.spawnHoldCause({ why: 'usage', held: 'x' }), ST.spawnHoldCause({ why: 'memory', harm: 'VMMEM-HIGH' }), ST.spawnHoldCause({ why: 'memory' }), ST.spawnHoldCause({ why: 'lock' }),
  ST.spawnHoldCause({ held: 'the maintenance window holds every spawn' }), ST.spawnHoldCause({ held: 'the batch budget holds every spawn' }),
  ST.spawnHoldCause({ held: 'a failing health check (gh) holds every spawn' }), ST.spawnHoldCause({ held: 'config §3b "Check-in times" holds every spawn' }), ST.spawnHoldCause({}),
]), j(['usage', 'memory harm: VMMEM-HIGH', 'memory: low available', 'lock', 'maintenance', 'budget', 'health check', 'config', null]));

// ---- links, the line and the levers report --------------------------------------------------------------------
{
  const S = scratch('stuck-time-links-');
  const cwd = scratch('stuck-time-cwd-');
  const env = { ...process.env, DESK_AUTOPILOT_STATE: S, DESK_GH_REPO: 'acme/app', HOME: cwd };
  for (const k of Object.keys(env)) if (/^DESK_BATCH$/.test(k)) delete env[k];
  const cli = (...a) => spawnSync('node', [BIN, ...a], { encoding: 'utf8', env, cwd });
  writeFileSync(join(S, 'stuck-intervals.jsonl'), [
    { key: 'A', batch: null, cause: 'usage', start: D(23, 0), end: D(23, 10) },
    { key: 'B', batch: null, cause: 'usage', start: D(23, 0), end: D(23, 5) },
    { key: 'C', batch: null, cause: 'park: question', start: D(24, 0), end: D(24, 3) },
    { key: 'D', batch: null, cause: 'collision', start: D(24, 0), end: D(24, 1) },
    { key: 'E', batch: null, cause: 'lock', start: D(24, 0), end: D(24, 0, 30) },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const linked = cli('link', 'usage', '1377');
  const linked2 = cli('link', 'park: question', 'https://github.com/acme/app/issues/88');
  t('link sets a cause\'s tracking issue, from its number or its URL', j([linked.status, linked.stdout.trim(), linked2.status, links(S)['park: question']]),
    j([0, 'stuck-time: usage → #1377 (https://github.com/acme/app/issues/1377)', 0, { ref: '#88', url: 'https://github.com/acme/app/issues/88' }]));
  t('a target that is no issue is refused', cli('link', 'lock', 'soon').status, 2);
  const s = ST.weekSummary(S, { now: Date.parse(D(25, 12)) });
  t('the line names the week, its hours and tickets, and the top three causes with their tracking issues', ST.stuckLine(s),
    'time parked by cause, week 2026-W48: 20h over 5 tickets; top: usage 15h (2 tickets, #1377) · park: question 3.0h (1 ticket, #88) · collision 1.0h (1 ticket)');
  t('with nothing stuck that week there is no line', ST.stuckLine(ST.weekSummary(S, { now: Date.parse(D(25, 12)), weeksAgo: 2 })), null);
  t('the CLI prints this week\'s line and last week\'s', cli().stdout.split('\n')[1], 'time parked by cause, week 2026-W47: none recorded');
  const un = cli('unlink', 'usage');
  t('unlink drops a cause\'s link', j([un.status, 'usage' in links(S), cli('unlink', 'usage').status]), j([0, false, 1]));
  cli('link', 'usage', '#1377');

  const view = (repos) => ({ v: 1, generated_at: D(25, 12), tz: 'UTC', repos: [], baseline: null, line: { state: 'today' },
    panels: { status: {}, waiting: { items: [] }, cost: {}, guardrails: {}, board: { levers: [] }, changes: {}, overhead: {}, data_quality: {}, trends: { metrics: {} }, stuck_time: { repos } } });
  let page = '';
  try { page = renderPage(view([{ name: 'app', weeks: [ST.weekSummary(S, { now: Date.parse(D(25, 12)) }), ST.weekSummary(S, { now: Date.parse(D(25, 12)), weeksAgo: 1 })] }])); } catch (err) { page = `threw: ${err.message}`; }
  t('the levers report has a time-parked-by-cause table per repo and week, each cause linked to its tracking issue',
    j([/Time parked by cause/.test(page), /app · week 2026-W48 · 20h over 5 tickets/.test(page), /<th scope="row">usage<\/th><td>15h<\/td><td>2<\/td><td><a href="https:\/\/github.com\/acme\/app\/issues\/1377">#1377<\/a><\/td>/.test(page), /<th scope="row">lock<\/th><td>0.5h<\/td><td>1<\/td><td>—<\/td>/.test(page), /week 2026-W47/.test(page)]),
    j([true, true, true, true, false]));
  let bare = '';
  try { bare = renderPage(view([])); } catch (err) { bare = `threw: ${err.message}`; }
  t('with nothing stuck the report has no such section', /Time parked by cause/.test(bare) || /^threw/.test(bare), false);
}

// ---- the guardrail: parked hours per ticket is one, on every lever ------------------------------------------------
t('the registry lists parked hours per ticket as a guardrail of every lever, with a rate-ratio margin',
  j([GUARDRAILS['parked-hours'], Object.values(REGISTRY).every((l) => l.guardrails['parked-hours'] === GUARDRAILS['parked-hours'])]),
  j([{ metric: 'parked hours per ticket', margin: { max_rate_ratio: 1.25 } }, true]));
t('a revert on it has its reason worded', reasonWording('guardrail_parked_hours'), 'parked hours per ticket rose past their margin');

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
