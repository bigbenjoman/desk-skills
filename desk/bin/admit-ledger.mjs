// Headroom admission's ledger, beside the lock files: one line per run admission let in, or in shadow
// would have, `<epoch s> <pool> <pid> <gb> <load> <reason> [<start>]`. admission.mjs reads and writes it
// under its admission lock; the lease broker (leases.mjs) reads it to size the heavy and light pools. A
// module of its own so the broker reads it without importing admission.mjs, which imports the broker.
//
// Reasons: `admit`, a run granted a slot above its pool's floor with admission on, held while its pid
// runs; `headroom` and `floor`, shadow's would-admits above and on the floor; `express`, a small run
// granted the light lock's express lane, which holds no pool slot but counts as a recent admit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive } from './dir-lock.mjs';

export const LEDGER_REASONS = Object.freeze(['admit', 'headroom', 'floor', 'express']);
// The reasons a judge counts as recent admits within admit-ramp-s: runs let in, or that shadow would
// have let in, above a floor, and express-lane grants, whose load and memory are not yet in the readings.
export const RECENT_REASONS = Object.freeze(['admit', 'headroom', 'express']);
export const ledgerFile = (dir) => join(dir, 'desk-admit.ledger');
// The waiting-marker directory of lock class `cls`'s lock in lock directory `dir` (slot-lease.mjs
// waitingDir, which defaults the directory): here so admission.mjs need not import slot-lease.mjs,
// which imports it.
export const LOCK_OF = Object.freeze({ test: 'test', tsc: 'test', lint: 'test', light: 'light', browser: 'browser' });
export const lockWaitingDir = (cls, dir) => join(dir, `desk-${LOCK_OF[cls] ?? cls}.waiting`);

// The ledger's lines as [{ at, pool, pid, gb, load, reason, start }]; a line that does not read is
// dropped. `start` is an `admit`'s run's process start time (startStamp), the line's seventh field, so
// a pid that a later process has taken does not keep the admit's slot; null on a line without it.
export function parseLedger(text) {
  return String(text ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 6 || f.length === 7)
    .map(([at, pool, pid, gb, load, reason, start]) => ({ at: Number(at), pool, pid: Number(pid), gb: Number(gb), load: Number(load), reason, start: start ?? null }))
    .filter((e) => Number.isFinite(e.at) && Number.isInteger(e.pid) && e.pid > 0 && Number.isFinite(e.gb) && LEDGER_REASONS.includes(e.reason));
}
export const ledgerText = (entries) => entries.map((e) => `${e.at} ${e.pool} ${e.pid} ${e.gb} ${e.load ?? '-'} ${e.reason}${e.start ? ` ${e.start}` : ''}\n`).join('');
// A process start time (leases.mjs startTimes) as one ledger field, or null.
export const startStamp = (s) => (s == null ? null : String(s).trim().replace(/\s+/g, '_') || null);

// The ledger in lock directory `dir` as it stands, read without the admission lock (it is written
// atomically): [] when there is none or it cannot be read.
export function readLedger(dir) {
  try { return parseLedger(readFileSync(ledgerFile(dir), 'utf8')); } catch { return []; }
}

// The entries whose run still runs: its pid alive and, where the entry and `starts` (a Map pid ->
// startStamp, or null to skip the check) both have one, the same process start time.
export function liveEntries(entries, { isAlive = alive, starts = null } = {}) {
  return entries.filter((e) => isAlive(e.pid) && (!e.start || !starts || starts.get(e.pid) === e.start));
}

// How many runs admission has let in above each pool's floor that still run: { heavy, light }.
export function liveAdmits(entries, opts = {}) {
  const out = { heavy: 0, light: 0 };
  for (const e of liveEntries(entries, opts)) if (e.reason === 'admit' && e.pool in out) out[e.pool]++;
  return out;
}

// A pool's admission mode, floor and ceiling from the rows (machine.mjs admissionRows): the floors as
// the locks grant them, and with the rows not reading, mode off. -> { mode, floor, ceiling }.
export function poolRows(pool, { rows, mode }) {
  if (mode !== 'on') {
    const floor = rows[pool === 'heavy' ? 'test-lock-slots' : 'light-lock-slots'] ?? 1;
    return { mode, floor, ceiling: floor };
  }
  return pool === 'heavy' ? { mode, floor: rows['test-lock-slots'], ceiling: rows['test-lock-max'] }
    : { mode, floor: rows['light-lock-slots'], ceiling: rows['light-lock-max'] };
}
