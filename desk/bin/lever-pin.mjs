#!/usr/bin/env node
// A ticket's levers pin: the Phase 0 levers it runs with for its whole life, fixed when it enters the
// queue as the queue ticket's `levers: { set, arms, trial_ids, fp, at }`. spawn-worker.sh exports the
// pin's set as DESK_LEVERS, which desk-env's levers() reads before the row, so every worker for the
// ticket (its first start, fix and review tries, their preflights, subagents and hooks) runs with
// it. An empty set is every lever off; only a ticket with no pin reads the row.
//
//   import { pinAtAdmission, pinnedSet, envValue } from './lever-pin.mjs'
//   node lever-pin.mjs env <TICKET>   the pin's set as DESK_LEVERS takes it (`none` when empty);
//                                     exit 3 when the ticket has no pin or is not in the queue,
//                                     1 when the queue or the pin cannot be read
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { levers, queueFile } from './desk-env.mjs';
import { readQueue } from './batch-state.mjs';

// The pin a ticket is admitted with: the row's levers now, whatever DESK_LEVERS the admitting process
// carries. Trial arms are drawn elsewhere.
export const pinAtAdmission = (l = levers({}), now = new Date()) => ({ set: [...l.on], at: now.toISOString() });

// The levers ticket `t` is pinned to, or null when it has no pin. Throws on a pin that
// is not { set: [name...] }, so a mangled pin never reads as the row.
export function pinnedSet(t) {
  const l = t?.levers;
  if (l == null) return null;
  if (typeof l !== 'object' || Array.isArray(l) || !Array.isArray(l.set) || l.set.some((x) => typeof x !== 'string')) {
    throw new Error(`${t.key ?? 'the ticket'}'s levers pin is not { set: [lever, ...] }: ${JSON.stringify(l)}`);
  }
  return l.set;
}

export const envValue = (set) => (set.length ? set.join(' ') : 'none');

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const [cmd, key] = process.argv.slice(2);
  if (cmd !== 'env' || !key) { console.error('usage: lever-pin.mjs env <TICKET>'); process.exit(2); }
  try {
    const qf = queueFile();
    const t = existsSync(qf) ? readQueue(qf).tickets?.[key] : null;
    const set = pinnedSet(t);
    if (set == null) process.exit(3);
    console.log(envValue(set));
  } catch (e) {
    console.error(`lever-pin: ${e.message ?? e}`);
    process.exit(1);
  }
}
