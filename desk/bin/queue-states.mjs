// A ticket's states in the queue, and the finished ones. A module of its own, importing nothing, so
// the ticket ledger can read them while the queue store, which appends to that ledger, is still loading.
export const STATES = ['queued', 'triaged', 'running', 'parked', 'done', 'failed'];
export const FINISHED = ['done', 'failed'];
