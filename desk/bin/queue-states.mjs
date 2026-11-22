// A ticket's states in the queue, and the finished ones. A module of its own, importing nothing, so
// the ticket ledger can read them while the queue store, which appends to that ledger, is still loading.
export const STATES = ['queued', 'triaged', 'running', 'parked', 'done', 'failed'];
export const FINISHED = ['done', 'failed'];
// What a park waits on: a step only the person takes, a question, a blocker, a stop, a date, a failure.
export const PARK_KINDS = ['person-step', 'question', 'hold', 'stopped', 'date', 'failure'];
