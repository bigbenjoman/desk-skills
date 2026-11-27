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

// How many planned files a triage record names.
export const plannedFiles = (rec) => (Array.isArray(rec?.files_in_scope) ? rec.files_in_scope.length : 0);

// Every key reached from `from` through `succ` (key -> the keys it holds), `from` itself left out.
export const reach = (key, from, succ) => {
  const seen = new Set(); const stack = [...from];
  while (stack.length) { const k = stack.pop(); if (seen.has(k) || k === key) continue; seen.add(k); stack.push(...(succ[k] ?? [])); }
  return seen;
};

// `list` with blockers before what they block, otherwise in the order given: `blockers(item)` the keys
// holding an item, `keyOf(item)` its own. A cycle falls back to its first item.
export const blockersFirst = (list, blockers, keyOf = (x) => x) => {
  const out = []; const done = new Set(); const pending = [...list];
  while (pending.length) {
    const i = pending.findIndex((x) => blockers(x).every((p) => done.has(p)));
    const [x] = pending.splice(i < 0 ? 0 : i, 1);
    out.push(x); done.add(keyOf(x));
  }
  return out;
};

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
// `cloud(ticket)` is whether it starts in a cloud session (pass/shared.mjs startsInCloud): the cloud
// tickets and the local ones are sorted as two lists, each laid over the places its own kind holds now,
// so neither kind's order waits on the other's slots. Gates and shared files are still counted across
// both, so a cloud ticket and a local one sharing a file stay sequenced by the per-file budget.
// -> { order: those tickets' keys in their new order, gates, moved: [{ key, why }] for each that overtook
//    another, changed }
const unstarted = (t) => ['queued', 'triaged', 'parked'].includes(t.state) && !t.spawned_at;
// A ticket the re-sort may move: unstarted, and nobody placed it.
export const resortable = (t) => unstarted(t) && !t.placed;
export function resortQueue(tickets, { scope, fileCount, cloud = () => false }) {
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
    const from = [...(succ[t.key] ?? []), ...open.filter((o) => o.key !== t.key && shared(t.key, o.key).length).map((o) => o.key)];
    gates[t.key] = [...reach(t.key, from, succ)].filter((k) => openKeys.has(k)).length;
  }
  const was = new Map(movable.map((t, i) => [t.key, i]));
  const kind = new Map(movable.map((t) => [t.key, !!cloud(t)]));
  const sortKind = (c) => {
    const list = movable.filter((t) => kind.get(t.key) === c).map((t) => ({ ticket: t.key }));
    const sorted = list.sort(bySpawnOrder(gates, (r) => fileCount(r.ticket), (r) => was.get(r.ticket)));
    return blockersFirst(sorted.map((r) => r.ticket), (k) => blockersOf(byKey[k]).filter((p) => kind.get(p) === c));
  };
  const lists = { true: sortKind(true), false: sortKind(false) };
  const order = movable.map((t) => lists[kind.get(t.key)].shift());
  const now = new Map(order.map((k, i) => [k, i]));
  const moved = [];
  for (const k of order) {
    const passed = order.filter((o) => kind.get(o) === kind.get(k) && was.get(o) < was.get(k) && now.get(o) > now.get(k));
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
