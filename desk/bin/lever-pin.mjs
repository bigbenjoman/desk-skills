#!/usr/bin/env node
// A ticket's levers pin: the Phase 0 levers it runs with for its whole life, fixed when it enters the
// queue as the queue ticket's `levers: { set, arms, trial_ids, fp, at }`, and `values` where it
// carries a lever with more than two arms (lever-registry.mjs `values`). spawn-worker.sh exports the
// pin's set as DESK_LEVERS, which desk-env's levers() reads before the row, and its values as
// DESK_LEVER_VALUES, which `desk-env levers <lever>` prints, so every worker for the ticket (its first
// start, fix and review tries, their preflights, subagents and hooks) runs with it. An empty set is
// every lever off; only a ticket with no pin reads the row.
//
//   import { pinAtAdmission, pinnedSet, envValue } from './lever-pin.mjs'
//   node lever-pin.mjs env <TICKET>   the pin's set as DESK_LEVERS takes it (`none` when empty, and
//                                     always for a blind audit, levers-audit.mjs, which runs with
//                                     every lever off); exit 3 when the ticket has no pin or is not
//                                     in the queue, 1 when the queue or the pin cannot be read
//   node lever-pin.mjs values <TICKET>  the pin's values as DESK_LEVER_VALUES takes them
//                                     (`<lever>=<value>`, space-separated; an empty line with none, and
//                                     always for a blind audit); exits as `env` does
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { levers, queueFile, ticketKind } from './desk-env.mjs';
import { readQueue } from './batch-state.mjs';

// The pin a ticket is admitted with: the row's levers now, whatever DESK_LEVERS the admitting process
// carries. Trial arms are drawn in levers-auto.mjs.
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

// Whether lever `name` is on for ticket `t`, as the supervisor reads it: from the ticket's pin where it
// has one, else from `row` (levers() as the row gives it), so a ticket with no pin reads as before
// pins. Throws on a mangled pin, as pinnedSet does.
export const leverOnFor = (name, t, row = levers()) => (pinnedSet(t) ?? row.on).includes(name);

// Whether a start's recorded levers differ from the pin's set, as sets: false with no pin or no
// recorded levers.
export function pinDisagrees(set, started) {
  if (!Array.isArray(set) || !Array.isArray(started)) return false;
  const pin = new Set(set);
  const ran = new Set(started);
  return pin.size !== ran.size || [...ran].some((x) => !pin.has(x));
}

export const envValue = (set) => (set.length ? set.join(' ') : 'none');

// The value each lever with more than two arms runs on for ticket `t` ({} with none), or null when it
// has no pin. Throws on values that are not { <lever>: <value> }, so a mangled pin never reads as the
// baseline.
function pinnedValues(t) {
  if (pinnedSet(t) == null) return null;
  const v = t.levers.values;
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v) || Object.entries(v).some(([k, x]) => typeof x !== 'string' || /[\s=]/.test(k) || /[\s=]/.test(x) || !x)) {
    throw new Error(`${t.key ?? 'the ticket'}'s levers pin has values that are not { lever: value }: ${JSON.stringify(v)}`);
  }
  return v;
}
// Values as DESK_LEVER_VALUES carries them: `<lever>=<value>`, space-separated.
const valuesEnv = (values) => Object.entries(values ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const [cmd, key] = process.argv.slice(2);
  if (!['env', 'values'].includes(cmd) || !key) { console.error('usage: lever-pin.mjs env|values <TICKET>'); process.exit(2); }
  try {
    if (ticketKind(key).kind === 'audit') { console.log(cmd === 'env' ? envValue([]) : ''); process.exit(0); }
    const qf = queueFile();
    const t = existsSync(qf) ? readQueue(qf).tickets?.[key] : null;
    const set = pinnedSet(t);
    if (set == null) process.exit(3);
    console.log(cmd === 'env' ? envValue(set) : valuesEnv(pinnedValues(t)));
  } catch (e) {
    console.error(`lever-pin: ${e.message ?? e}`);
    process.exit(1);
  }
}
