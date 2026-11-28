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
export const unstarted = (t) => ['queued', 'triaged', 'parked'].includes(t.state) && !t.spawned_at;
// A ticket the re-sort may move: unstarted, and nobody placed it.
export const resortable = (t) => unstarted(t) && !t.placed;
// With `rank(key)` (priorityRank: lower is higher priority) and `priority` strict or soft, a higher
// priority starts first within each kind's list, before SPAWN_ORDER_RULE: the per-person constraint on
// the throughput order (§3b "Queue order: priority"). At `off`, or without `rank`, priority is not read.
// `rank` is inherited through blocker links (inheritedRank) before it is read.
export function resortQueue(tickets, { scope, fileCount, cloud = () => false, rank: own = null, priority = 'off' }) {
  const rank = own && inheritedRank(tickets, own);
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
  const ranked = rank && priority !== 'off';
  const rankOf = (k) => (ranked ? rank(k) : 0);
  const throughput = bySpawnOrder(gates, (r) => fileCount(r.ticket), (r) => was.get(r.ticket));
  const kind = new Map(movable.map((t) => [t.key, !!cloud(t)]));
  const sortKind = (c) => {
    const list = movable.filter((t) => kind.get(t.key) === c).map((t) => ({ ticket: t.key }));
    const sorted = list.sort((a, b) => rankOf(a.ticket) - rankOf(b.ticket) || throughput(a, b));
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
    const why = passed.some((o) => rankOf(o) > rankOf(k)) ? 'higher priority' : tie ? `clears ${chainName(shared(k, tie)[0])} chain` : gates[k] > 0 ? `gates ${gates[k]}` : 'fills an idle slot';
    moved.push({ key: k, why });
  }
  return { order, gates, moved, changed: moved.length > 0 };
}

// Config §3b "Queue order: placed tickets": `move-and-say` lets the re-sort move a placed ticket;
// anything else is `keep`. "Queue order: move threshold" is in minutes; unset or not a whole number is 30.
const DEFAULT_MOVE_THRESHOLD_MIN = 30;
export const movesPlaced = (raw) => String(raw ?? '').trim().toLowerCase() === 'move-and-say';
export const moveThresholdMin = (raw) => (/^\d+$/.test(String(raw ?? '').trim()) ? Number(String(raw).trim()) : DEFAULT_MOVE_THRESHOLD_MIN);

// The hours a ticket of each size holds a worker slot, read when there is too little merge history.
export const FALLBACK_SLOT_HOURS = Object.freeze({ XS: 0.5, S: 1, M: 2, L: 4, XL: 8, unknown: 2 });

// When the last of `order`'s tickets would finish, in hours from now, with `workers` local slots and
// `cloudWorkers` cloud sessions filled in queue order: a ticket starts at the first free slot of its
// own kind (`cloud(key)`, as the spawn loop's startsInCloud picks) once every blocker of it in play has
// finished and none of its files is already held by as many tickets running then, of either kind, as
// `places(file)` allows (the pass's per-file budget, placesFor). `running` are [{ key, hours, cloud }]
// holding slots now, `hoursOf(key)` a ticket's slot time, `scope(key)` its files, `blockers(key)` the
// keys holding it. `held` are [{ key, hours, files }] filling places but no slot of this batch: the
// repo's other batches' tickets, running or handed off, as spawning counts them (budgetHolds).
// A ticket that can never start (a blocker cycle) is left out.
export function projectedFinish(order, { workers, cloudWorkers = 1, cloud = () => false, hoursOf, scope, blockers, running = [], held = [], places = () => 1 }) {
  const room = { false: Math.max(1, workers), true: Math.max(1, cloudWorkers) };
  const inPlay = new Set([...order, ...running.map((r) => r.key)]);
  const done = new Set();
  let active = running.map((r) => ({ key: r.key, inCloud: !!r.cloud, end: Math.max(0, r.hours), files: new Set(scope(r.key)) }));
  let holding = held.map((h) => ({ end: Math.max(0, h.hours), files: new Set(h.files) }));
  let at = 0;
  let last = Math.max(0, ...active.map((a) => a.end));
  const pending = [...order];
  while (pending.length) {
    active = active.filter((a) => (a.end <= at ? (done.add(a.key), false) : true));
    holding = holding.filter((h) => h.end > at);
    const free = (c) => active.filter((a) => a.inCloud === c).length < room[c];
    const i = pending.findIndex((k) => free(!!cloud(k)) && blockers(k).every((b) => !inPlay.has(b) || done.has(b))
      && scope(k).every((f) => [...active, ...holding].filter((a) => a.files.has(f)).length < Math.max(1, places(f))));
    if (i >= 0) {
      const [k] = pending.splice(i, 1);
      const end = at + Math.max(0, hoursOf(k));
      active.push({ key: k, inCloud: !!cloud(k), end, files: new Set(scope(k)) });
      last = Math.max(last, end);
      continue;
    }
    if (!active.length && !holding.length) break;
    at = Math.min(...[...active, ...holding].map((a) => a.end));
  }
  return last;
}

// The queue's keys once `order` is laid over the places its tickets hold now, as the pass lays it.
const laidKeys = (tickets, order) => laidOrder({ tickets: Object.fromEntries(tickets.map((t) => [t.key, t])) }, order).order;

// The re-sort at §3b "Queue order: placed tickets" `move-and-say`. Each placed unstarted ticket, in
// queue order, is let go to the re-sort when that cuts the projected finish of the whole queue
// (`finish(keys)`, the unstarted keys in their new order, in hours) by more than `thresholdH` beyond
// the moves already taken. -> resortQueue's result for the queue with those tickets let go, plus
// `placedMoved`: [{ key, from, to, gainH }], `from` and `to` its
// 1-based place among the unfinished tickets before and after, `gainH` the hours its own move saved.
// `cloud`, `rank` and `priority` are resortQueue's, so a placed ticket let go moves only among the places
// of its own kind, and lands behind every higher priority as an unplaced one does.
export function placedMoves(tickets, { scope, fileCount, cloud, rank = null, priority = 'off', finish, thresholdH, finished = () => false }) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const openKeys = (ts, order) => laidKeys(ts, order).filter((k) => unstarted(byKey.get(k)));
  const as = (released) => tickets.map((t) => (released.has(t.key) ? { ...t, placed: false } : t));
  let released = new Set();
  let best = resortQueue(tickets, { scope, fileCount, cloud, rank, priority });
  let bestH = finish(openKeys(tickets, best.order));
  const gains = [];
  for (const t of tickets.filter((x) => unstarted(x) && x.placed)) {
    const trial = new Set([...released, t.key]);
    const view = as(trial);
    const r = resortQueue(view, { scope, fileCount, cloud, rank, priority });
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
  return { ...best, changed: best.changed || placedMoved.length > 0, placedMoved };
}

// A gain in minutes as the digest and desk-q show it: "45m", or "2.5h" from two hours.
export const gainText = (min) => (min >= 120 ? `${Math.round(min / 6) / 10}h` : `${min}m`);
// How a placed ticket's move reads in the pass report and the digest: "from 2 to 5, the queue
// finishes about 45m sooner".
export const placedMoveText = (m) => `from ${m.from} to ${m.to}, the queue finishes about ${gainText(Math.round(m.gainH * 60))} sooner`;
// How the pass records a placed ticket's move: `set` the queue.mjs set pairs for its ticket before the
// order is laid (placed cleared so the order moves it, placed_move for desk-q), `replace` those after it
// (placed again at its new place, so only another move past the threshold, said as this one is, moves
// it again), `line` its entry in the pass's metrics line `queue_moves`, which the check-in digest reads
// (pass-metrics.mjs readQueueMoves).
export function placedMoveRecord(m) {
  const move = { from: m.from, to: m.to, gain_min: Math.round(m.gainH * 60) };
  return { set: ['placed=null', `placed_move=${JSON.stringify(move)}`], replace: ['placed=true'], line: { key: m.key, ...move, text: placedMoveText(m) } };
}

// Which placed tickets' moves reached queue.json, from the write that carried them (queue-writer.mjs
// flush's result): a move whose write was refused, or whose order or own fields another writer's
// value kept, was not made. -> { said: the moves made, unnote: keys of moves not made whose
// placed_move landed, to take off again so desk-q marks no move }.
export function placedLanded(moves, w) {
  if (!w.ok) return { said: [], unnote: [] };
  const theirs = (k, fields) => w.conflicts.some((c) => c.ticket === k && fields.includes(c.field));
  const orderKept = w.conflicts.some((c) => c.field === 'order');
  const made = (m) => !orderKept && !theirs(m.key, ['*', 'placed', 'placed_move']);
  return { said: moves.filter(made), unnote: moves.filter((m) => !made(m) && !theirs(m.key, ['*', 'placed_move'])).map((m) => m.key) };
}

// The pass's report line for a re-sort, or null when the order did not change.
export const resortLine = (r) => (r.changed
  ? `spawn order re-sorted for throughput: ${r.order.join(', ')} (${r.moved.map((m) => `${m.key} ${m.why}`).join('; ')})`
  : null);

// ---- priority: §3b "Queue order: priority" ----------------------------------------------------------
export const PRIORITY_MODES = ['strict', 'soft', 'off'];
// The row as read: `strict`, `soft` or `off`. Unset (missing, blank, TODO) is `soft`, the template's
// default; anything else is said and read as `soft`. -> { mode, bad: null | message }
export function priorityMode(raw, row = 'Queue order: priority') {
  const v = String(raw ?? '').trim().replace(/^`|`$/g, '').toLowerCase();
  if (PRIORITY_MODES.includes(v)) return { mode: v, bad: null };
  if (v === '' || /^todo\b/.test(v)) return { mode: 'soft', bad: null };
  return { mode: 'soft', bad: `config §3b "${row}" is "${raw}" — want \`strict\`, \`soft\` or \`off\`; read as soft` };
}

// Where a triage record's tracker priority (`priority`, ticket-facts.mjs) sits in `order`, §4 Priority's
// values in lower case, highest first: lower is higher priority. A value unset or not listed, and a
// ticket with no tracker priority (no tracker, or not a tracker ticket), ranks after every listed one,
// so with no tracker every ticket ranks the same.
export function priorityRank(rec, order) {
  const v = String(rec?.priority ?? '').trim().toLowerCase();
  const i = v ? order.indexOf(v) : -1;
  return i < 0 ? order.length : i;
}

// Priority inheritance: `rank` (key -> priorityRank) with each ticket ranked as high as the highest
// unstarted ticket it holds, directly or through any chain of blocker links, among `tickets` (the
// queue's). A low ticket blocking a high one is then never held behind a ticket between them, which
// would hold the high one for ever. Memoised: -> key -> rank
export function inheritedRank(tickets, rank) {
  const succ = {};
  for (const t of tickets) if (unstarted(t)) for (const p of blockersOf(t)) (succ[p] ??= []).push(t.key);
  const memo = new Map();
  return (k) => {
    if (!memo.has(k)) memo.set(k, Math.min(rank(k), ...[...reach(k, succ[k] ?? [], succ)].map(rank)));
    return memo.get(k);
  };
}

// What holds unstarted ticket `key` from starting now for a higher-priority one, or null.
//   mode     strict, soft or off
//   rank     key -> priorityRank (lower is higher priority), inherited through blocker links
//            (inheritedRank)
//   waiting  the keys of the unstarted tickets not started yet: each higher than `key` may hold it
//   pending  those of them that may still start this pass (spawnable, not yet tried); the rest are held
//            anyway (a file collision, a blocker, the test lock, an open question)
//   free     the slots this pass has left, `key`'s own included
//   files    key -> the files its work collides on
//   blocks   (a, b) -> true where a holds b through blocker links: a higher ticket `key` itself holds
//            never holds it, or neither would start
// strict: any higher ticket waiting holds it. soft: one only where it would lose time, so `key` may
// take a slot that would otherwise sit idle: the higher ones that may still start this pass hold it only
// when they would need its slot, and one held anyway only where `key` shares a file with it. A hold for
// a slot is `defer`: a higher ticket counted as pending may still be refused at spawn without taking a
// slot, so the caller tries `key` again once every pending one has been tried (its pending then empty).
// -> { key: the higher ticket, why, defer? } or null
export function priorityHold(key, { mode, rank, waiting, pending = new Set(), free = 1, files, blocks = () => false }) {
  if (mode === 'off') return null;
  const higher = [...waiting].filter((h) => h !== key && rank(h) < rank(key) && !blocks(key, h));
  if (!higher.length) return null;
  if (mode === 'strict') return { key: higher[0], why: 'strict: a lower priority never starts first' };
  const before = higher.filter((h) => pending.has(h));
  if (before.length && before.length >= free) return { key: before[0], why: 'it may start this pass, and needs the slot', defer: true };
  const mine = new Set(files(key));
  for (const h of higher) {
    if (pending.has(h)) continue;
    const f = files(h).find((x) => mine.has(x));
    if (f) return { key: h, why: `it is held, and shares ${f}` };
  }
  return null;
}

// The pass's spawn loop order: `list`, with each entry deferred while it is read pushed onto the end
// and read again there. Yields { item, ahead, deferred, defer } per entry: `ahead` the entries not
// reached yet, deferred retries included (so a deferred ticket still counts as pending for one behind
// it); `deferred` whether this entry was deferred before; `defer()` pushes it onto the end, true, or
// false once its key has been deferred `cap` times. With priorityHold a ticket defers only while a
// higher one is ahead of it, and the highest left never does, so the order ends; the cap holds it anyway.
export function* deferringOrder(list, keyOf = (x) => x, cap = list.length) {
  const order = [...list];
  const count = new Map();
  for (let at = 0; at < order.length; at += 1) {
    const item = order[at];
    const key = keyOf(item);
    const defer = () => {
      const n = count.get(key) ?? 0;
      if (n >= cap) return false;
      count.set(key, n + 1);
      order.push(item);
      return true;
    };
    yield { item, ahead: order.slice(at + 1), deferred: count.has(key), defer };
  }
}

// The pass's line for a ticket priorityHold holds.
export const priorityHoldLine = (key, hold, mode, row = 'Queue order: priority') =>
  `${key}: waits for ${hold.key}, a higher priority (§3b "${row}" ${mode}: ${hold.why})`;
