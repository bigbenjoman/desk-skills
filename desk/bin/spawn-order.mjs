// The order a batch's tickets start in, and the sentences that state it. plan-batch seeds the queue in
// this order and prints the rule above it; the skills' generated text (tests/prose_facts.mjs) reads the
// same sentences from here, so the rule is written once, beside the comparator that applies it.
import { blockersOf } from './queue-states.mjs';

export const SPAWN_ORDER_RULE = 'Blockers start first, then the tickets that gate the most others (directly or through any chain of holds), then the fewest planned files, then the order named.';
export const KEEP_ORDER_RULE = 'With --keep-order, tickets start in the order named, blockers still first.';

// SPAWN_ORDER_RULE's comparator, before blockers are put first: gates[ticket] is how many tickets it
// holds, filesOf its planned files, named its place in the order named. A late hub never leaves worker
// slots idle while its dependents wait.
export const bySpawnOrder = (gates, filesOf, named) => (a, b) => gates[b.ticket] - gates[a.ticket]
  || filesOf(a) - filesOf(b) || named(a) - named(b);

// What a chain of tickets sharing file `f` is called: the file, or its folder for a skill's SKILL.md,
// a README or an index file.
export const chainName = (f) => {
  const parts = String(f).split('/');
  return parts.length > 1 && /^(SKILL|README|index)\./i.test(parts.at(-1)) ? parts.at(-2) : parts.at(-1);
};

// The pass's re-sort of the live queue. `tickets` are the queue's tickets in its order; `scope(key)` the
// files a ticket's work collides on, and `fileCount(key)` its planned files. The unstarted tickets nobody
// placed are laid over the places they hold now in SPAWN_ORDER_RULE's order, the order named being the
// queue's. A ticket gates the other unstarted tickets that share a file with it, and every ticket blocked
// by it or by one of those, through any chain of blocker links. A running ticket shares files too, but
// no unstarted ticket holds it: the per-file budget holds the unstarted one at spawn instead.
// -> { order: those tickets' keys in their new order, gates, moved: [{ key, why }] for each that overtook
//    another, changed }
const unstarted = (t) => ['queued', 'triaged', 'parked'].includes(t.state) && !t.spawned_at;
// A ticket the re-sort may move: unstarted, and nobody placed it.
export const resortable = (t) => unstarted(t) && !t.placed;
export function resortQueue(tickets, { scope, fileCount }) {
  const open = tickets.filter(unstarted);
  const movable = open.filter(resortable);
  const openKeys = new Set(open.map((t) => t.key));
  const byKey = Object.fromEntries(tickets.map((t) => [t.key, t]));
  const succ = {};
  for (const t of tickets) for (const p of blockersOf(t)) (succ[p] ??= []).push(t.key);
  const files = new Map(tickets.map((t) => [t.key, new Set(scope(t.key))]));
  const shared = (a, b) => [...files.get(a)].filter((f) => files.get(b).has(f));
  const gates = {};
  for (const t of movable) {
    const seen = new Set();
    const stack = [...(succ[t.key] ?? []), ...open.filter((o) => o.key !== t.key && shared(t.key, o.key).length).map((o) => o.key)];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k) || k === t.key) continue;
      seen.add(k);
      stack.push(...(succ[k] ?? []));
    }
    gates[t.key] = [...seen].filter((k) => openKeys.has(k)).length;
  }
  const was = new Map(movable.map((t, i) => [t.key, i]));
  const sorted = movable.map((t) => ({ ticket: t.key })).sort(bySpawnOrder(gates, (r) => fileCount(r.ticket), (r) => was.get(r.ticket)));
  // Blockers before what they block, as plan-batch's topo puts them.
  const pending = sorted.map((r) => r.ticket);
  const order = [];
  const done = new Set();
  while (pending.length) {
    const i = pending.findIndex((k) => blockersOf(byKey[k]).every((p) => !was.has(p) || done.has(p)));
    const [k] = pending.splice(i < 0 ? 0 : i, 1);
    order.push(k);
    done.add(k);
  }
  const now = new Map(order.map((k, i) => [k, i]));
  const moved = [];
  for (const k of order) {
    const passed = order.filter((o) => was.get(o) < was.get(k) && now.get(o) > now.get(k));
    if (!passed.length) continue;
    const tie = passed.find((o) => gates[o] === gates[k] && shared(k, o).length);
    const why = tie ? `clears ${chainName(shared(k, tie)[0])} chain` : gates[k] > 0 ? `gates ${gates[k]}` : 'fills an idle slot';
    moved.push({ key: k, why });
  }
  return { order, gates, moved, changed: moved.length > 0 };
}

// The pass's report line for a re-sort, or null when the order did not change.
export const resortLine = (r) => (r.changed
  ? `spawn order re-sorted for throughput: ${r.order.join(', ')} (${r.moved.map((m) => `${m.key} ${m.why}`).join('; ')})`
  : null);
