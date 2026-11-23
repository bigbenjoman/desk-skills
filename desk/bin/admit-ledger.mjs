// Headroom admission's ledger, beside the lock files: one line per run admission let in, or in shadow
// would have, `<epoch s> <pool> <pid> <gb> <load> <reason>`. admission.mjs reads and writes it under its
// admission lock; the lease broker (leases.mjs) reads it to size the heavy and light pools. A module of
// its own so the broker reads it without importing admission.mjs, which imports the broker.
//
// Reasons: `admit`, a run granted a slot above its pool's floor with admission on, held while its pid
// runs; `headroom` and `floor`, shadow's would-admits above and on the floor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive } from './dir-lock.mjs';

export const LEDGER_REASONS = Object.freeze(['admit', 'headroom', 'floor']);
export const ledgerFile = (dir) => join(dir, 'desk-admit.ledger');
// The waiting-marker directory of lock class `cls`'s lock in lock directory `dir` (slot-lease.mjs
// waitingDir, which defaults the directory): here so admission.mjs need not import slot-lease.mjs,
// which imports it.
export const LOCK_OF = Object.freeze({ test: 'test', tsc: 'test', lint: 'test', light: 'light', browser: 'browser' });
export const lockWaitingDir = (cls, dir) => join(dir, `desk-${LOCK_OF[cls] ?? cls}.waiting`);

// The ledger's lines as [{ at, pool, pid, gb, load, reason }]; a line that does not read is dropped.
export function parseLedger(text) {
  return String(text ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 6)
    .map(([at, pool, pid, gb, load, reason]) => ({ at: Number(at), pool, pid: Number(pid), gb: Number(gb), load: Number(load), reason }))
    .filter((e) => Number.isFinite(e.at) && Number.isInteger(e.pid) && e.pid > 0 && Number.isFinite(e.gb) && LEDGER_REASONS.includes(e.reason));
}
export const ledgerText = (entries) => entries.map((e) => `${e.at} ${e.pool} ${e.pid} ${e.gb} ${e.load ?? '-'} ${e.reason}\n`).join('');

// The ledger in lock directory `dir` as it stands, read without the admission lock (it is written
// atomically): [] when there is none or it cannot be read.
export function readLedger(dir) {
  try { return parseLedger(readFileSync(ledgerFile(dir), 'utf8')); } catch { return []; }
}

// How many runs admission has let in above each pool's floor that still run: { heavy, light }.
export function liveAdmits(entries, isAlive = alive) {
  const out = { heavy: 0, light: 0 };
  for (const e of entries) if (e.reason === 'admit' && e.pool in out && isAlive(e.pid)) out[e.pool]++;
  return out;
}
