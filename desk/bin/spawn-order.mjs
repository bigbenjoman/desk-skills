// The order a batch's tickets start in, and the sentences that state it. plan-batch seeds the queue in
// this order and prints the rule above it; the skills' generated text (tests/prose_facts.mjs) reads the
// same sentences from here, so the rule is written once, beside the comparator that applies it.
import { blockersOf } from './queue-states.mjs';
import { laidOrder } from './queue-writer.mjs';

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

// Config §3b "Queue order: placed tickets": `move-and-say` lets the re-sort move a placed ticket;
// anything else is `keep`. "Queue order: move threshold" is in minutes; unset or not a whole number is 30.
export const DEFAULT_MOVE_THRESHOLD_MIN = 30;
export const movesPlaced = (raw) => String(raw ?? '').trim().toLowerCase() === 'move-and-say';
export const moveThresholdMin = (raw) => (/^\d+$/.test(String(raw ?? '').trim()) ? Number(String(raw).trim()) : DEFAULT_MOVE_THRESHOLD_MIN);

// The hours a ticket of each size holds a worker slot, read when there is too little merge history.
export const FALLBACK_SLOT_HOURS = Object.freeze({ XS: 0.5, S: 1, M: 2, L: 4, XL: 8, unknown: 2 });

// When the last of `order`'s tickets would finish, in hours from now, with `workers` slots filled in
// queue order: a ticket starts at the first free slot once every blocker of it in play has finished
// and none of its files is already held by as many tickets running then as `places(file)` allows (the
// pass's per-file budget, placesFor). `running` are [{ key, hours }] holding slots now, `hoursOf(key)`
// a ticket's slot time, `scope(key)` its files, `blockers(key)` the keys holding it.
// A ticket that can never start (a blocker cycle) is left out.
export function projectedFinish(order, { workers, hoursOf, scope, blockers, running = [], places = () => 1 }) {
  const n = Math.max(1, workers);
  const inPlay = new Set([...order, ...running.map((r) => r.key)]);
  const done = new Set();
  let active = running.map((r) => ({ key: r.key, end: Math.max(0, r.hours), files: new Set(scope(r.key)) }));
  let at = 0;
  let last = Math.max(0, ...active.map((a) => a.end));
  const pending = [...order];
  while (pending.length) {
    active = active.filter((a) => (a.end <= at ? (done.add(a.key), false) : true));
    if (active.length < n) {
      const i = pending.findIndex((k) => blockers(k).every((b) => !inPlay.has(b) || done.has(b))
        && scope(k).every((f) => active.filter((a) => a.files.has(f)).length < Math.max(1, places(f))));
      if (i >= 0) {
        const [k] = pending.splice(i, 1);
        const end = at + Math.max(0, hoursOf(k));
        active.push({ key: k, end, files: new Set(scope(k)) });
        last = Math.max(last, end);
        continue;
      }
    }
    if (!active.length) break;
    at = Math.min(...active.map((a) => a.end));
  }
  return last;
}

// The queue's keys once `order` is laid over the places its tickets hold now, as the pass lays it.
const laidKeys = (tickets, order) => laidOrder({ tickets: Object.fromEntries(tickets.map((t) => [t.key, t])) }, order).order;

// The re-sort at §3b "Queue order: placed tickets" `move-and-say`. Each placed unstarted ticket, in
// queue order, is let go to the re-sort when that cuts the projected finish of the whole queue
// (`finish(keys)`, the unstarted keys in their new order, in hours) by more than `thresholdH` beyond
// the moves already taken. -> resortQueue's result for the queue with those tickets let go, plus
// `released` (their keys) and `placedMoved`: [{ key, from, to, gainH }], `from` and `to` its
// 1-based place among the unfinished tickets before and after, `gainH` the hours its own move saved.
export function placedMoves(tickets, { scope, fileCount, finish, thresholdH, finished = () => false }) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const openKeys = (ts, order) => laidKeys(ts, order).filter((k) => unstarted(byKey.get(k)));
  const as = (released) => tickets.map((t) => (released.has(t.key) ? { ...t, placed: false } : t));
  let released = new Set();
  let best = resortQueue(tickets, { scope, fileCount });
  let bestH = finish(openKeys(tickets, best.order));
  const gains = [];
  for (const t of tickets.filter((x) => unstarted(x) && x.placed)) {
    const trial = new Set([...released, t.key]);
    const view = as(trial);
    const r = resortQueue(view, { scope, fileCount });
    const h = finish(openKeys(view, r.order));
    if (bestH - h > thresholdH) {
      gains.push({ key: t.key, gainH: bestH - h });
      released = trial; best = r; bestH = h;
    }
  }
  const before = tickets.filter((t) => !finished(t)).map((t) => t.key);
  const after = laidKeys(as(released), best.order).filter((k) => !finished(byKey.get(k)));
  const placedMoved = gains
    .map((g) => ({ key: g.key, from: before.indexOf(g.key) + 1, to: after.indexOf(g.key) + 1, gainH: g.gainH }))
    .filter((m) => m.from !== m.to);
  return { ...best, changed: best.changed || placedMoved.length > 0, released: [...released], placedMoved };
}

// A gain in minutes as the digest and desk-q show it: "45m", or "2.5h" from two hours.
export const gainText = (min) => (min >= 120 ? `${Math.round(min / 6) / 10}h` : `${min}m`);
// How a placed ticket's move reads in the pass report and the digest: "from 2 to 5, the queue
// finishes about 45m sooner".
export const placedMoveText = (m) => `from ${m.from} to ${m.to}, the queue finishes about ${gainText(Math.round(m.gainH * 60))} sooner`;
// How the pass records a placed ticket's move: `set` the queue.mjs set pairs for its ticket (placed
// cleared, placed_move for desk-q), `line` its entry in the pass's metrics line `queue_moves`, which
// the check-in digest reads (pass-metrics.mjs readQueueMoves).
export function placedMoveRecord(m) {
  const move = { from: m.from, to: m.to, gain_min: Math.round(m.gainH * 60) };
  return { set: ['placed=null', `placed_move=${JSON.stringify(move)}`], line: { key: m.key, ...move, text: placedMoveText(m) } };
}

// The pass's report line for a re-sort, or null when the order did not change.
export const resortLine = (r) => (r.changed
  ? `spawn order re-sorted for throughput: ${r.order.join(', ')} (${r.moved.map((m) => `${m.key} ${m.why}`).join('; ')})`
  : null);
