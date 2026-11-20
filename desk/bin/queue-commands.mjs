// The commands queue.mjs handles, each with the flags it reads. queue.mjs refuses any other command
// and prints its usage from this list; tests/test_queue_commands.mjs holds its switch equal to it.
// Imported without side effects (queue.mjs runs its command on import, so the list lives here).
export const QUEUE_COMMANDS = Object.freeze({
  init: ['--standing', '--if-batch'],
  add: [],
  adopt: ['--filed'],
  admit: ['--by', '--hold', '--hold-outside', '--hold-merge', '--hold-spine'],
  hold: [],
  'backfill-holds': ['--dry-run'],
  set: [],
  'set-batch': [],
  park: ['--claimed-by'],
  'clears-when': ['--check'],
  requeue: [],
  stop: [],
  handback: [],
  'step-done': [],
  'follow-ran': [],
  approve: [],
  reject: [],
  front: [],
  move: [],
  transfer: [],
  running: [],
  drop: [],
  merged: [],
  'next-pass': [],
  get: [],
  list: [],
  render: [],
  watch: ['--interval', '--stages'],
});

export const queueUsage = () => `usage: queue.mjs ${Object.entries(QUEUE_COMMANDS)
  .map(([c, flags]) => [c, ...flags.map((f) => `[${f}]`)].join(' ')).join('|')}`;

// The refusal for a command not in the list (or none), naming every command it does handle.
export const unknownQueueCommand = (cmd) => `${cmd ? `unknown command "${cmd}"` : 'no command'}. ${queueUsage()}`;
