// The order a batch's tickets start in, and the sentences that state it. plan-batch seeds the queue in
// this order and prints the rule above it; the skills' generated text (tests/prose_facts.mjs) reads the
// same sentences from here, so the rule is written once, beside the comparator that applies it.
export const SPAWN_ORDER_RULE = 'Blockers start first, then the tickets that gate the most others (directly or through any chain of holds), then, among tickets that gate none, the fewest planned files, then the order named.';
export const KEEP_ORDER_RULE = 'With --keep-order, tickets start in the order named, blockers still first.';

// SPAWN_ORDER_RULE's comparator, before blockers are put first: gates[ticket] is how many tickets it
// holds, filesOf its planned files, named its place in the order named. A late hub never leaves worker
// slots idle while its dependents wait.
export const bySpawnOrder = (gates, filesOf, named) => (a, b) => gates[b.ticket] - gates[a.ticket]
  || (gates[a.ticket] === 0 && gates[b.ticket] === 0 ? filesOf(a) - filesOf(b) : 0) || named(a) - named(b);
