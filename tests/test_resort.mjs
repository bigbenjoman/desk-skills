// suite: the pass's re-sort (unstarted tickets nobody placed, in spawn order on the live queue, every pass)
// layer: L1
// covers: desk/bin/spawn-order.mjs desk/bin/queue-writer.mjs desk/bin/config-schema.mjs desk/bin/pass/shared.mjs
import { resortQueue, resortLine, chainName, placedMoves, projectedFinish, placedMoveText, placedMoveRecord, placedLanded, movesPlaced, moveThresholdMin, FALLBACK_SLOT_HOURS,
  priorityMode, priorityRank, priorityHold, priorityHoldLine, inheritedRank, deferringOrder } from '../desk/bin/spawn-order.mjs';
import { ROWS } from '../desk/bin/config-schema.mjs';
import { readFileSync } from 'node:fs';
import { layOrder, laidOrder, applySet } from '../desk/bin/queue-writer.mjs';
import { blockersOf } from '../desk/bin/queue-states.mjs';
import { priorityPool } from '../desk/bin/pass/shared.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

// run(tickets, files): the re-sort of tickets queued in the order given, `files[key]` each one's planned files.
const tk = (key, more = {}) => ({ key, state: 'triaged', ...more });
const run = (tickets, files) => resortQueue(tickets, { scope: (k) => files[k] ?? [], fileCount: (k) => (files[k] ?? []).length });
const laid = (tickets, r) => {
  const q = { tickets: Object.fromEntries(tickets.map((x) => [x.key, x])) };
  layOrder(q, r.order);
  return Object.keys(q.tickets).join(' ');
};
const why = (r) => r.moved.map((m) => `${m.key}: ${m.why}`).join(' | ');

{
  // H holds three tickets by blocker link; A and B gate nothing and sit ahead of it.
  const ts = [tk('A'), tk('B'), tk('H'), ...['L1', 'L2', 'L3'].map((k) => tk(k, { state: 'parked', held_by: 'H' }))];
  const files = { A: ['a'], B: ['b'], H: ['h'], L1: ['l1'], L2: ['l2'], L3: ['l3'] };
  const r = run(ts, files);
  t('#1623 AC5 a hub gating three by blocker links overtakes two tickets gating none', laid(ts, r), 'H A B L1 L2 L3');
  t('#1623 AC4 and it is marked with its gates', why(r), 'H: gates 3');
  const q = { tickets: Object.fromEntries(ts.map((x) => [x.key, x])) };
  t('#1625 laidOrder gives the order layOrder lays, and leaves the queue as it was', `${laidOrder(q, r.order).order.join(' ')} | ${Object.keys(q.tickets).join(' ')}`, 'H A B L1 L2 L3 | A B H L1 L2 L3');
}
{
  // H shares a file with each of L1-L3, which share none with each other.
  const ts = [tk('A'), tk('B'), tk('L1'), tk('H'), tk('L2'), tk('L3')];
  const files = { A: ['a'], B: ['b'], H: ['x/one.mjs', 'x/two.mjs', 'x/three.mjs'], L1: ['x/one.mjs'], L2: ['x/two.mjs'], L3: ['x/three.mjs'] };
  const r = run(ts, files);
  t('#1623 AC1 a ticket sharing planned files with three others gates them, and starts before them', laid(ts, r), 'H L1 L2 L3 A B');
  t('#1623 AC1 a ticket sharing one file gates only the ticket it shares it with', `${r.gates.H} ${r.gates.L1} ${r.gates.A}`, '3 1 0');
}
{
  // P shares f with Q and g with S; Q and S share nothing with each other.
  const ts = [tk('Q'), tk('S'), tk('P')];
  const files = { Q: ['f'], S: ['g'], P: ['f', 'g'] };
  const r = run(ts, files);
  t('#1623 AC5 of tickets sharing a file, the one gating the most others starts first', laid(ts, r), 'P Q S');
  t('#1623 AC4 marked with its gates', why(r), 'P: gates 2');
}
{
  const ts = [tk('X'), tk('Y')];
  const files = { X: ['skills/desk-checkout/SKILL.md', 'b', 'c'], Y: ['skills/desk-checkout/SKILL.md'] };
  const r = run(ts, files);
  t('#1623 AC5 a colliding pair gating each other alike starts the one with fewer planned files first', laid(ts, r), 'Y X');
  t('#1623 AC4 marked as clearing the chain it shares', why(r), 'Y: clears desk-checkout chain');
}
{
  const ts = [tk('A'), tk('B', { placed: true }), tk('C'), tk('H')];
  const files = { A: ['a', 'a2', 'a3'], B: ['b', 'b2', 'b3', 'b4'], C: ['c'], H: ['h'], D: ['d'] };
  ts.push(tk('D', { state: 'parked', held_by: 'H' }));
  const r = run(ts, files);
  t('#1623 AC5 a placed ticket keeps its place while the rest are re-sorted around it', laid(ts, r), 'H B C D A');
  t('#1623 AC4 a ticket gating none moved ahead fills an idle slot', why(r), 'H: gates 1 | C: fills an idle slot | D: fills an idle slot');
}
{
  const ts = [tk('R', { state: 'running', spawned_at: '2026-11-27T10:00:00Z' }), tk('A', { spawned_at: '2026-11-27T09:00:00Z', state: 'parked' }), tk('B'), tk('C')];
  const files = { R: ['f'], A: ['a', 'a2'], B: ['b', 'b2'], C: ['f'] };
  const r = run(ts, files);
  t('#1623 a running ticket, or one whose worker has started, keeps its place and is not moved', `${r.order.join(' ')} | ${laid(ts, r)}`, 'C B | R A C B');
  t('#1623 a running ticket is not one an unstarted ticket gates', r.gates.C, 0);
}
{
  const ts = [tk('A'), tk('B'), tk('H')];
  const files = { A: ['a'], B: ['b'], H: ['h'], D: ['d'] };
  ts.push(tk('D', { state: 'parked', held_by: 'H' }));
  const first = run(ts, files);
  t('#1623 AC1 a re-sort that changed the order has a log line', /^spawn order re-sorted for throughput: H, A, B, D \(H gates 1\)$/.test(resortLine(first) ?? ''), true);
  const sorted = first.order.map((k) => ts.find((x) => x.key === k));
  const again = run(sorted, files);
  t('#1623 AC5 the next pass on the re-sorted queue changes nothing, and logs no line', `${again.changed} ${resortLine(again)}`, 'false null');
}
{
  const ts = [tk('B'), tk('A')];
  const r = run(ts, { A: ['a'], B: ['b'] });
  t('#1623 a tie on gates and files keeps the queue\'s order', `${r.changed} ${r.order.join(' ')}`, 'false B A');
}
// #1626: cloud and local tickets are sorted as two lists, each in the places its own kind holds now.
const cloudRun = (tickets, files) => resortQueue(tickets, { scope: (k) => files[k] ?? [], fileCount: (k) => (files[k] ?? []).length, cloud: (x) => x.location === 'cloud' });
{
  // Local A and B gate nothing; cloud H holds two local tickets by blocker link; cloud C gates nothing.
  const ts = [tk('A'), tk('C', { location: 'cloud' }), tk('B'), tk('H', { location: 'cloud' }),
    tk('L1', { state: 'parked', held_by: 'H' }), tk('L2', { state: 'parked', held_by: 'H' })];
  const files = { A: ['a'], B: ['b'], C: ['c'], H: ['h'], L1: ['l1'], L2: ['l2'] };
  const r = cloudRun(ts, files);
  t('#1626 AC1 a cloud hub overtakes only cloud tickets: the local ones keep the places they hold', laid(ts, r), 'A H B C L1 L2');
  t('#1626 AC1 and it is marked as moved ahead with its gates, counted over the local tickets it holds', why(r), 'H: gates 2');
  const one = run(ts, files);
  t('#1626 without the cloud split the same hub would overtake the local tickets too', laid(ts, one), 'H A C B L1 L2');
}
{
  // Local H shares a file with cloud X and local Y: its gates count both lists.
  const ts = [tk('Y'), tk('X', { location: 'cloud' }), tk('H')];
  const files = { H: ['f', 'g', 'h'], X: ['f'], Y: ['g'] };
  const r = cloudRun(ts, files);
  t('#1626 AC2 a ticket sharing files with a cloud ticket and a local one gates both', `${r.gates.H} ${r.gates.X} ${r.gates.Y}`, '2 1 1');
  t('#1626 AC2 and it starts before the local ticket it gates', laid(ts, r), 'H X Y');
}
{
  const ts = [tk('A', { location: 'cloud' }), tk('B'), tk('D', { location: 'cloud', state: 'parked', held_by: 'B' })];
  const r = cloudRun(ts, { A: ['a'], B: ['b'], D: ['d'] });
  t('#1626 a blocker in the other list does not reorder this list', `${r.changed} ${r.order.join(' ')}`, 'false A B D');
}
// #1625: placed tickets under §3b "Queue order: placed tickets". X and Y are placed at the front and
// gate nothing; H holds L1-L3 by blocker link. Two workers, X, Y and H take 1h each and the Ls 3h.
{
  const hours = { X: 1, Y: 1, H: 1, L1: 3, L2: 3, L3: 3 };
  const files = { X: ['x', 'x2', 'x3'], Y: ['y', 'y2', 'y3'], H: ['h'], L1: ['l1'], L2: ['l2'], L3: ['l3'] };
  const ts = () => [tk('X', { placed: true }), tk('Y', { placed: true }), tk('H'), ...['L1', 'L2', 'L3'].map((k) => tk(k, { state: 'parked', held_by: 'H' }))];
  const byKey = Object.fromEntries(ts().map((x) => [x.key, x]));
  const opts = {
    scope: (k) => files[k] ?? [], fileCount: (k) => (files[k] ?? []).length,
    finish: (keys) => projectedFinish(keys, { workers: 2, hoursOf: (k) => hours[k], scope: (k) => files[k] ?? [], blockers: (k) => blockersOf(byKey[k]) }),
  };
  t('#1625 the projection fills two slots in queue order, holding the Ls behind H', opts.finish(['X', 'Y', 'H', 'L1', 'L2', 'L3']), 8);

  t('#1625 AC1 the row reads keep unless it says move-and-say', `${movesPlaced('keep')} ${movesPlaced(null)} ${movesPlaced('TODO')} ${movesPlaced(' Move-and-say ')}`, 'false false false true');
  t('#1625 AC3 the move threshold is a whole number of minutes, 30 when unset', `${moveThresholdMin('45')} ${moveThresholdMin(null)} ${moveThresholdMin('soon')}`, '45 30 30');

  const keep = run(ts(), files);
  t('#1625 AC2 keep: the placed tickets stay where they were put', laid(ts(), keep), 'X Y H L1 L2 L3');

  const moved = placedMoves(ts(), { ...opts, thresholdH: 30 / 60 });
  const movedKeys = moved.placedMoved.map((m) => m.key);
  const q = { tickets: Object.fromEntries(ts().map((x) => [x.key, movedKeys.includes(x.key) ? { ...x, placed: false } : x])) };
  layOrder(q, moved.order);
  t('#1625 AC3 move-and-say: a placed ticket moves when the queue then finishes more than the threshold sooner', Object.keys(q.tickets).join(' '), 'H Y L1 L2 L3 X');
  t('#1625 AC4 the move is recorded with where it was, where it went and the gain',
    moved.placedMoved.map((m) => `${m.key} ${m.from}->${m.to} ${Math.round(m.gainH * 60)}m`).join(' | '), 'X 1->6 60m');
  t('#1625 AC4 and says so in words', placedMoveText(moved.placedMoved[0]), 'from 1 to 6, the queue finishes about 60m sooner');
  // The record the pass writes for it: the queue.mjs set pairs, applied as queue.mjs applies them,
  // clear placed for the order and leave placed_move for desk-q, then place it again where it went;
  // the metrics entry carries the same for the digest.
  const rec = placedMoveRecord(moved.placedMoved[0]);
  const x = tk('X', { placed: true });
  applySet(x, rec.set);
  t('#1625 AC4/AC5 the move is recorded on the ticket: placed cleared for the order, placed_move from, to and the gain',
    `${x.placed} ${JSON.stringify(x.placed_move)}`, 'null {"from":1,"to":6,"gain_min":60}');
  applySet(x, rec.replace);
  t('#1625 AC3 and once laid it is placed again where it went', `${x.placed} ${JSON.stringify(x.placed_move)}`, 'true {"from":1,"to":6,"gain_min":60}');
  // So the next pass's re-sort leaves it there: only another move past the threshold, said as this
  // one was, could shift it.
  const next = Object.values(q.tickets).map((y) => (y.key === 'X' ? x : y));
  const again = placedMoves(next, { ...opts, thresholdH: 30 / 60 });
  t('#1625 AC3 the next pass leaves the moved ticket where it went, unsaid moves none', `${again.placedMoved.length} ${laid(next, again)}`, '0 H Y L1 L2 L3 X');
  t('#1625 AC3 and the plain re-sort does not move it either', laid(next, run(next, files)), 'H Y L1 L2 L3 X');
  t('#1625 AC4/AC5 and on the pass\'s metrics line for the check-in digest', JSON.stringify(rec.line),
    '{"key":"X","from":1,"to":6,"gain_min":60,"text":"from 1 to 6, the queue finishes about 60m sooner"}');
  t('#1625 AC3 a second placed ticket whose move gains nothing more stays placed', `${movedKeys.join(' ')} ${q.tickets.Y.placed}`, 'X true');

  const under = placedMoves(ts(), { ...opts, thresholdH: 60 / 60 });
  t('#1625 AC5 no move when the gain is not over the threshold', `${under.placedMoved.length} ${laid(ts(), under)}`, '0 X Y H L1 L2 L3');

  // #1626's split holds for a placed ticket let go: X starting in the cloud, with no other cloud
  // ticket, has no place of its own kind to move to, so it stays first; local Y moves instead.
  const cloudTs = () => ts().map((y) => (y.key === 'X' ? { ...y, location: 'cloud' } : y));
  const split = placedMoves(cloudTs(), { ...opts, cloud: (y) => y.location === 'cloud', thresholdH: 30 / 60 });
  t('#1625 a placed cloud ticket let go moves only among cloud places, so a local one moves instead',
    split.placedMoved.map((m) => `${m.key} ${m.from}->${m.to}`).join(' | '), 'Y 2->6');

  // #1624: priority bounds the move too. X is the highest priority, so let go it still sorts first:
  // its move gains nothing and it stays where it was placed.
  const ranked = placedMoves(ts(), { ...opts, rank: (k) => (k === 'X' ? 0 : 1), priority: 'soft', thresholdH: 30 / 60 });
  t('#1624 with #1625 a placed ticket let go lands behind no lower priority, so the highest stays first',
    `${ranked.placedMoved.some((m) => m.key === 'X')} ${laid(ts(), ranked).split(' ')[0]}`, 'false X');
}
t('#1625 a ticket sharing a file with one running waits for it, and a running ticket holds its slot',
  projectedFinish(['A', 'B'], { workers: 3, hoursOf: () => 2, scope: (k) => ({ R: ['f'], A: ['f'], B: ['b'] })[k] ?? [], blockers: () => [], running: [{ key: 'R', hours: 1 }] }), 3);
t('#1625 a file with two places lets a ticket start beside the one running on it, as the per-file budget does',
  projectedFinish(['A', 'B'], { workers: 3, hoursOf: () => 2, scope: (k) => ({ R: ['f'], A: ['f'], B: ['f'] })[k] ?? [], blockers: () => [], running: [{ key: 'R', hours: 1 }], places: () => 2 }), 3);
{
  const mv = [{ key: 'X', from: 1, to: 4, gainH: 1 }, { key: 'Y', from: 2, to: 5, gainH: 1 }];
  const show = (r) => `${r.said.map((m) => m.key).join(',') || '-'} ${r.unnote.join(',') || '-'}`;
  t('#1625 AC4 a move written to the queue is said', show(placedLanded(mv, { ok: true, conflicts: [] })), 'X,Y -');
  t('#1625 AC4 a refused write says no move, and has no note to take off', show(placedLanded(mv, { ok: false, conflicts: [] })), '- -');
  t('#1625 AC4 another writer\'s order kept says no move, and takes off the notes that landed',
    show(placedLanded(mv, { ok: true, conflicts: [{ ticket: null, field: 'order' }, { ticket: 'Y', field: 'placed_move' }] })), '- X');
  t('#1625 AC4 a ticket another writer placed meanwhile is not said moved; the rest are',
    show(placedLanded(mv, { ok: true, conflicts: [{ ticket: 'X', field: 'placed' }] })), 'Y X');
}
t('#1625 another batch\'s ticket on a file holds it as spawning does, and holds no slot of this batch',
  `${projectedFinish(['A'], { workers: 1, hoursOf: () => 2, scope: () => ['f'], blockers: () => [], held: [{ key: 'O', hours: 1.5, files: ['f'] }] })} ${projectedFinish(['A'], { workers: 1, hoursOf: () => 2, scope: () => ['b'], blockers: () => [], held: [{ key: 'O', hours: 1.5, files: ['f'] }] })}`, '3.5 2');
{
  // Local slots and cloud sessions fill apart: a cloud ticket waits for a cloud session, not a local
  // slot, and a cloud ticket running holds no local slot.
  const two = { hoursOf: () => 2, scope: (k) => [k], blockers: () => [] };
  const inCloud = (k) => k.startsWith('C');
  t('#1625 one local slot and one cloud session run a local and a cloud ticket side by side',
    `${projectedFinish(['L', 'C'], { ...two, workers: 1, cloudWorkers: 1, cloud: inCloud })} ${projectedFinish(['L', 'C'], { ...two, workers: 1 })}`, '2 4');
  t('#1625 two cloud tickets queue for the one cloud session while the local slots stay free',
    projectedFinish(['C1', 'C2'], { ...two, workers: 2, cloudWorkers: 1, cloud: inCloud }), 4);
  t('#1625 a cloud ticket running holds no local slot',
    projectedFinish(['L'], { ...two, workers: 1, cloudWorkers: 1, cloud: inCloud, running: [{ key: 'R', hours: 1, cloud: true }] }), 2);
}
t('#1625 a size reads a fixed slot time when there is no history', `${FALLBACK_SLOT_HOURS.M} ${FALLBACK_SLOT_HOURS.unknown}`, '2 2');

t('#1623 a chain is named for the file, or its folder for a SKILL.md', `${chainName('desk/bin/pass.mjs')} ${chainName('skills/desk-ticket/SKILL.md')}`, 'pass.mjs desk-ticket');

// ---- #1624 §3b "Queue order: priority" ----
{
  const order = ['p0', 'p1', 'p2', 'p3'];
  const recs = { HI: { priority: 'P2' }, LO: { priority: 'P3' }, X: { priority: 'P9' }, N: { priority: null }, G: {} };
  const rank = (k) => priorityRank(recs[k], order);
  t('#1624 AC4 a tracker priority ranks by §4 Priority; unlisted, unset and no tracker priority rank last alike', ['HI', 'LO', 'X', 'N', 'G'].map(rank).join(' '), '2 3 4 4 4');
  t('#1624 AC4 with no tracker every ticket ranks the same', priorityRank({}, order) === priorityRank({ priority: undefined }, order), true);

  const files = { HI: ['f'], LO: ['g'], LOF: ['f'], R: ['f'] };
  recs.LOF = { priority: 'P3' };
  const hold = (key, mode, more) => priorityHold(key, { mode, rank, files: (k) => files[k] ?? [], waiting: ['HI', key], ...more });
  // The P2 is held anyway (it collides with a running ticket on f), one slot is free: a P3 on g would leave it idle.
  t('#1624 AC3 AC5 soft: a P3 fills an idle slot while the P2 is held anyway and they share no file', hold('LO', 'soft', { pending: new Set(), free: 1 }), null);
  t('#1624 AC3 AC5 soft: a P3 sharing a file with the held P2 does not start, so it cannot delay it', hold('LOF', 'soft', { pending: new Set(), free: 1 })?.key, 'HI');
  t('#1624 AC3 AC5 soft: a P3 does not take the one slot a P2 that can start this pass needs', hold('LO', 'soft', { pending: new Set(['HI']), free: 1 })?.key, 'HI');
  t('#1624 AC3 soft: with a slot for each, the P3 starts beside the P2', hold('LO', 'soft', { pending: new Set(['HI']), free: 2 }), null);
  t('#1624 AC2 AC5 strict: the P3 waits for the held P2 even with a slot idle', hold('LO', 'strict', { pending: new Set(), free: 3 })?.key, 'HI');
  t('#1624 AC4 AC5 off: priority holds nothing', [hold('LOF', 'off', { pending: new Set() }), hold('LO', 'off', { pending: new Set(['HI']), free: 1 })].join(','), ',');
  t('#1624 a higher priority holds nothing of its own, nor one of the same priority', priorityHold('HI', { mode: 'strict', rank, files: () => [], waiting: ['HI', 'LO', 'X'] }), null);
  t('#1624 a ticket that blocks a higher one is never held by it, even at strict', hold('LO', 'strict', { blocks: (a, b) => a === 'LO' && b === 'HI' }), null);
  t('#1624 the held ticket\'s line names the higher one and the row', priorityHoldLine('LOF', hold('LOF', 'soft', { pending: new Set() }), 'soft'), 'LOF: waits for HI, a higher priority (§3b "Queue order: priority" soft: it is held, and shares f)');
}
{
  t('#1624 AC1 AC5 the row reads strict, soft and off', ['strict', 'soft', 'off', '`Strict`'].map((v) => priorityMode(v).mode).join(' '), 'strict soft off strict');
  t('#1624 AC5 a missing or TODO row is soft, said nowhere', [undefined, null, '', 'TODO'].map((v) => `${priorityMode(v).mode}/${priorityMode(v).bad}`).join(' '), 'soft/null soft/null soft/null soft/null');
  const bad = priorityMode('high');
  t('#1624 AC5 an invalid row is read as soft, and said', `${bad.mode} ${bad.bad}`, 'soft config §3b "Queue order: priority" is "high" — want `strict`, `soft` or `off`; read as soft');
  const row = ROWS.find((e) => e.id === 'queue-priority');
  t('#1624 AC1 the schema has the §3b row, default soft', `${row?.section} ${row?.label} ${row?.default}`, '3b Queue order: priority soft');
  const tmpl = readFileSync(new URL('../desk-config.md', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('| Queue order: priority |'));
  t('#1624 AC1 the template\'s row recommends soft', tmpl?.split('|')[2].trim(), '`soft`');
}
{
  // A P1 gating nothing behind a P3 hub gating one: priority sorts first at soft and strict, throughput alone at off.
  const ts = [tk('LO'), tk('HI'), tk('D', { state: 'parked', held_by: 'LO' })];
  const files = { LO: ['a'], HI: ['b'], D: ['d'] };
  const pr = { LO: 3, HI: 1, D: 3 };
  const go = (priority) => resortQueue(ts, { scope: (k) => files[k] ?? [], fileCount: (k) => (files[k] ?? []).length, rank: (k) => pr[k], priority });
  t('#1624 AC3 soft: a higher priority sorts ahead of a hub gating more', `${go('soft').order.join(' ')} | ${why(go('soft'))}`, 'HI LO D | HI: higher priority');
  t('#1624 AC2 strict sorts the same', go('strict').order.join(' '), 'HI LO D');
  t('#1624 AC4 off: the throughput order alone', go('off').order.join(' '), 'LO HI D');
  // H (rank 0) blocked by J (rank 2), K (rank 1) unrelated: J inherits H's rank, so it is never held behind K.
  const tri = [tk('K'), tk('J'), tk('H', { state: 'parked', held_by: 'J' })];
  const tr = { H: 0, K: 1, J: 2 };
  const inh = inheritedRank(tri, (k) => tr[k]);
  t('#1624 a blocker of a higher ticket ranks as that ticket does; the rest keep their own', ['H', 'K', 'J'].map(inh).join(' '), '0 1 0');
  const triHold = (key, mode, files) => priorityHold(key, { mode, rank: inh, files: (k) => files[k] ?? [], waiting: ['H', 'J', 'K'], pending: new Set(), free: 1 });
  t('#1624 strict: a low ticket blocking a high one is not held by a ticket between them, so all three start in turn',
    `${triHold('J', 'strict', {})} ${triHold('K', 'strict', {})?.key}`, 'null H');
  t('#1624 soft: the same three sharing a file do not hold one another in a cycle',
    `${triHold('J', 'soft', { H: ['f'], J: ['f'], K: ['f'] })} ${triHold('K', 'soft', { H: ['f'], J: ['f'], K: ['f'] })?.key}`, 'null H');
  const resorted = (priority) => resortQueue(tri, { scope: () => [], fileCount: () => 0, rank: (k) => tr[k], priority }).order.join(' ');
  t('#1624 strict and soft re-sort the low blocker of a high ticket ahead of the ticket between them', `${resorted('strict')} | ${resorted('soft')}`, 'J H K | J H K');
  t('#1624 a ticket the queue has started passes on no rank', inheritedRank([tk('K'), tk('J'), tk('H', { state: 'running', spawned_at: 'x', held_by: 'J' })], (k) => tr[k])('J'), 2);
  t('#1624 soft: a hold for a slot is deferred, one for a shared file is not',
    `${triHold('K', 'soft', {}) === null} ${priorityHold('K', { mode: 'soft', rank: inh, files: () => [], waiting: ['H', 'K'], pending: new Set(['H']), free: 1 })?.defer} ${triHold('K', 'soft', { H: ['f'], K: ['f'] })?.defer}`, 'true true undefined');
  // The pass's spawn loop at soft, as pass.mjs runs it: placed K (rank 1), then H (rank 0), then L (rank 2),
  // `slots` free, no files shared; `refused` are refused at spawn without taking a slot (a busy worktree).
  const loop = (list, slots, refused = []) => {
    const lr = { K: 1, H: 0, L: 2, D: 1 };
    const started = [];
    for (const step of deferringOrder(list)) {
      const free = slots - started.length;
      const waiting = list.filter((k) => !started.includes(k));
      const hold = free <= 0 ? null : priorityHold(step.item, { mode: 'soft', rank: (k) => lr[k], waiting, pending: new Set(step.ahead.filter((k) => k !== step.item)), free, files: () => [] });
      if (hold?.defer && step.defer()) continue;
      if (hold || refused.includes(step.item) || free <= 0) continue;
      started.push(step.item);
    }
    return started.join(' ');
  };
  t('#1624 soft: a ticket deferred for a higher one refused at spawn takes the slot, not a lower one behind it', loop(['K', 'H', 'L'], 1, ['H']), 'K');
  t('#1624 soft: the higher one takes the slot when it can start', loop(['K', 'H', 'L'], 1), 'H');
  t('#1624 soft: with a slot each, nothing defers', loop(['K', 'H', 'L'], 3), 'K H L');
  t('#1624 soft: deferred tickets start in priority order once the higher one is refused', loop(['L', 'K', 'H'], 1, ['H']), 'K');
  t('#1624 deferringOrder reads a deferred entry again after the rest, and caps its deferrals',
    (() => { const seen = []; for (const s of deferringOrder(['a', 'b'], (x) => x, 2)) { seen.push(`${s.item}${s.deferred ? '*' : ''}:${s.ahead.join('')}`); if (s.item === 'a') s.defer(); } return seen.join(' '); })(),
    'a:b b:a a*: a*:');
  // The slot a priority hold weighs: a cloud-able ticket with the cloud full may fall back to a local slot.
  const CL = { key: 'CL', cloud_ok: true };
  const HL = { key: 'HL' };
  const HC = { key: 'HC', cloud_ok: true };
  const pr2 = { CL: 2, HL: 0, HC: 0 };
  const pool = (ahead, o) => priorityPool(CL, ahead, { local: 1, cloud: 0, localSpare: true, ...o });
  const held = (p, mode, waiting) => p && priorityHold('CL', { mode, rank: (k) => pr2[k], waiting, pending: p.pending, free: p.free, files: () => [] });
  t('#1624 a cloud-able ticket with the cloud full weighs the local slot it falls back to', `${pool([]).where} ${pool([]).free}`, 'local 1');
  t('#1624 strict: a lower cloud-able ticket falling back to a local slot waits for a held higher one', held(pool([]), 'strict', ['CL', 'HL'])?.key, 'HL');
  t('#1624 soft: it defers for a higher cloud-able ticket still to come that may fall back to that slot', held(pool([HC]), 'soft', ['CL', 'HC'])?.defer, true);
  t('#1624 a local-only ticket still to come keeps its slot from the fallback (placeAtStart reserve)', pool([HL]), null);
  t('#1624 with the cloud full and no spare local slot it starts nowhere, so priority holds nothing', pool([], { localSpare: false }), null);
  t('#1624 a ticket the person is using the computer for goes only to the cloud: nowhere when it is full', pool([], { personUse: true }), null);
  const inCloud = priorityPool(CL, [HL, HC], { local: 1, cloud: 1, localSpare: true });
  t('#1624 a cloud start weighs the cloud sessions, and only the cloud-able tickets still to come', `${inCloud.where} ${inCloud.free} ${[...inCloud.pending].join(',')}`, 'cloud 1 HC');
  const kinds = [tk('LO'), tk('HI'), tk('CC', { cloud_ok: true }), tk('CH', { cloud_ok: true })];
  const kr = { LO: 3, HI: 1, CC: 3, CH: 0 };
  t('#1624 priority sorts within each kind\'s list, each laid over its own kind\'s places',
    resortQueue(kinds, { scope: () => [], fileCount: () => 0, cloud: (x) => x.cloud_ok === true, rank: (k) => kr[k], priority: 'soft' }).order.join(' '), 'HI LO CH CC');
  const fallback = pool([HL, HC], { local: 2 });
  t('#1624 a local fallback counts every fresh ticket still to come, as a cloud-able one may fall back too', [...fallback.pending].join(','), 'HL,HC');
  t('#1624 a blocker still starts before what it blocks, whatever its priority', resortQueue([tk('LO'), tk('HI', { state: 'parked', held_by: 'LO' })], { scope: () => [], fileCount: () => 0, rank: (k) => (k === 'HI' ? 0 : 3), priority: 'strict' }).order.join(' '), 'LO HI');
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
