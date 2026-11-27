// suite: the pass's re-sort (unstarted tickets nobody placed, in spawn order on the live queue, every pass)
// layer: L1
// covers: desk/bin/spawn-order.mjs desk/bin/queue-writer.mjs
import { resortQueue, resortLine, chainName } from '../desk/bin/spawn-order.mjs';
import { layOrder } from '../desk/bin/queue-writer.mjs';

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
t('#1623 a chain is named for the file, or its folder for a SKILL.md', `${chainName('desk/bin/pass.mjs')} ${chainName('skills/desk-ticket/SKILL.md')}`, 'pass.mjs desk-ticket');

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
