// suite: the pass's re-sort (unstarted tickets nobody placed, in spawn order on the live queue, every pass)
// layer: L1
// covers: desk/bin/spawn-order.mjs desk/bin/queue-writer.mjs
import { resortQueue, resortLine, chainName, placedMoves, projectedFinish, placedMoveText, movesPlaced, moveThresholdMin, FALLBACK_SLOT_HOURS } from '../desk/bin/spawn-order.mjs';
import { layOrder } from '../desk/bin/queue-writer.mjs';
import { blockersOf } from '../desk/bin/queue-states.mjs';

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
  const q = { tickets: Object.fromEntries(ts().map((x) => [x.key, moved.released.includes(x.key) ? { ...x, placed: false } : x])) };
  layOrder(q, moved.order);
  t('#1625 AC3 move-and-say: a placed ticket moves when the queue then finishes more than the threshold sooner', Object.keys(q.tickets).join(' '), 'H Y L1 L2 L3 X');
  t('#1625 AC4 the move is recorded with where it was, where it went and the gain',
    moved.placedMoved.map((m) => `${m.key} ${m.from}->${m.to} ${Math.round(m.gainH * 60)}m`).join(' | '), 'X 1->6 60m');
  t('#1625 AC4 and says so in words', placedMoveText(moved.placedMoved[0]), 'from 1 to 6, the queue finishes about 60m sooner');
  t('#1625 AC3 a second placed ticket whose move gains nothing more stays placed', `${moved.released.join(' ')} ${q.tickets.Y.placed}`, 'X true');

  const under = placedMoves(ts(), { ...opts, thresholdH: 60 / 60 });
  t('#1625 AC5 no move when the gain is not over the threshold', `${under.placedMoved.length} ${under.released.length} ${laid(ts(), under)}`, '0 0 X Y H L1 L2 L3');
}
t('#1625 a ticket sharing a file with one running waits for it, and a running ticket holds its slot',
  projectedFinish(['A', 'B'], { workers: 3, hoursOf: () => 2, scope: (k) => ({ R: ['f'], A: ['f'], B: ['b'] })[k] ?? [], blockers: () => [], running: [{ key: 'R', hours: 1 }] }), 3);
t('#1625 a size reads a fixed slot time when there is no history', `${FALLBACK_SLOT_HOURS.M} ${FALLBACK_SLOT_HOURS.unknown}`, '2 2');

t('#1623 a chain is named for the file, or its folder for a SKILL.md', `${chainName('desk/bin/pass.mjs')} ${chainName('skills/desk-ticket/SKILL.md')}`, 'pass.mjs desk-ticket');

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
