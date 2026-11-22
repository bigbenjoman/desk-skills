// Headroom admission for the test and light locks: whether a run that finds its pool's floor full
// would be let in on the machine's live load, free memory and memory pressure. With the machine
// profile's lock-admission row shadow, a waiting run's would-admit or would-deny is logged in the lease
// log (leases.mjs) and nothing is granted; off, or any admission row that does not read, logs nothing.
//
//   node admission.mjs judge <test|tsc|light> --pid <wrapper pid> [--last <outcome:reason>]
//
// with-lock.sh runs `judge` as a run starts to wait and again while it waits, with what the last one
// printed: a line is logged only when the outcome or reason changes. It prints `<outcome>:<reason>`,
// nothing with admission off, and always exits 0.
//
// One rule for both pools on one reading (judge): a run above its floor is admitted only when
// load + admit-run-load x (recent admits + 1) <= admit-max-load, free memory less the run-GB of the
// recent admits and of this run >= admit-reserve-gb, and the pressure level < admit-max-pressure. A
// ceiling reached denies whatever the readings, and a reading that cannot be taken is no headroom.
// Recent means within admit-ramp-s, across both pools, from a ledger beside the lock files that a
// would-admit is added to, so shadow counts what on would have let in. The ledger is read, judged and
// written under an admission lock, so runs starting to wait in the same second see each other.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive, lock, unlock, writeTextAtomic } from './dir-lock.mjs';
import { logEvent, sampleLoad } from './leases.mjs';
import { admissionRows } from './machine.mjs';

export const POOL_OF = Object.freeze({ test: 'heavy', tsc: 'heavy', lint: 'heavy', light: 'light' });
const LOCK_WAIT_MS = 2000;
const LOCK_MAX_AGE_MS = 5000;

export const ledgerFile = (dir) => join(dir, 'desk-admit.ledger');
const lockPath = (dir) => join(dir, 'desk-admit.lock');

// Linux's memory pressure reading is /proc/pressure/memory's `some avg10` %, not a level: read as
// macOS's levels, 1 normal under 10 %, 2 warn under 40 %, 4 critical from there.
export function pressureLevel(sample, platform = process.platform) {
  const p = sample?.mem_pressure;
  if (p == null || !Number.isFinite(Number(p))) return null;
  if (platform !== 'linux') return Number(p);
  return p < 10 ? 1 : p < 40 ? 2 : 4;
}

// The ledger's lines, `<epoch s> <pool> <pid> <gb> <load>`, as [{ at, pool, pid, gb, load }]; a line
// that does not read is dropped.
export function parseLedger(text) {
  return String(text ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 5)
    .map(([at, pool, pid, gb, load]) => ({ at: Number(at), pool, pid: Number(pid), gb: Number(gb), load: Number(load) }))
    .filter((e) => Number.isFinite(e.at) && Number.isInteger(e.pid) && e.pid > 0 && Number.isFinite(e.gb));
}
const ledgerText = (entries) => entries.map((e) => `${e.at} ${e.pool} ${e.pid} ${e.gb} ${e.load ?? '-'}\n`).join('');

// The decision for a run of pool `pool` ('heavy' or 'light') that finds `held` of its slots held.
// `sample` is sampleLoad's, `level` its pressure level (pressureLevel), `recent` the admits within
// admit-ramp-s from other runs, `rows` admissionRows'. Pure. -> { outcome: 'would-admit' |
// 'would-deny', reason, fields } where fields are the readings and projections the line records.
export function judge({ pool, held, sample, level, recent, rows }) {
  const floor = rows[pool === 'heavy' ? 'test-lock-slots' : 'light-lock-slots'];
  const ceiling = rows[pool === 'heavy' ? 'test-lock-max' : 'light-lock-max'];
  const runGb = rows[pool === 'heavy' ? 'heavy-run-gb' : 'light-run-gb'];
  const load = sample?.load_1m ?? null;
  const freeGb = sample?.mem_free_pct == null || sample?.mem_total_gb == null ? null
    : Math.round(sample.mem_free_pct / 100 * sample.mem_total_gb * 100) / 100;
  const recentGb = recent.reduce((n, e) => n + e.gb, 0);
  const projectedLoad = load == null ? null : Math.round((load + rows['admit-run-load'] * (recent.length + 1)) * 100) / 100;
  const projectedFree = freeGb == null ? null : Math.round((freeGb - recentGb - runGb) * 100) / 100;
  const fields = {
    pool, held, floor, ceiling, load_1m: load, mem_free_gb: freeGb, mem_pressure: level, compressed_gb: sample?.compressed_gb ?? null,
    recent_admits: recent.length, recent_gb: recentGb, run_gb: runGb, projected_load: projectedLoad, projected_free_gb: projectedFree,
    max_load: rows['admit-max-load'], reserve_gb: rows['admit-reserve-gb'], max_pressure: rows['admit-max-pressure'],
  };
  const deny = (reason) => ({ outcome: 'would-deny', reason, fields });
  if (held < floor) return { outcome: 'would-admit', reason: 'floor', fields };
  if (held >= ceiling) return deny('ceiling');
  if (load == null) return deny('load-unreadable');
  if (freeGb == null) return deny('memory-unreadable');
  if (level == null) return deny('pressure-unreadable');
  if (projectedLoad > rows['admit-max-load']) return deny('load');
  if (projectedFree < rows['admit-reserve-gb']) return deny('memory');
  if (level >= rows['admit-max-pressure']) return deny('pressure');
  return { outcome: 'would-admit', reason: 'headroom', fields };
}

// One waiting run's admission, in shadow: judges it under the admission lock against the ledger in
// `dir` (dead pids and admits older than admit-ramp-s dropped), adds a would-admit to the ledger, and
// logs the line unless `last` (`<outcome>:<reason>`) says the same. `env` gives machineValue and
// testLockSlots (desk-env's), `held` the slots its pool holds. -> the `<outcome>:<reason>` key, or
// null with admission off.
export function admit({ cls, pid, last = null, env, dir, held, logDir, sample = null, platform = process.platform, now = Date.now, isAlive = alive }) {
  const pool = POOL_OF[cls];
  if (!pool) return null;
  const { rows, mode } = admissionRows((k) => env.machineValue(k), { testSlots: env.testLockSlots() });
  if (mode !== 'shadow') return null;
  sample ??= sampleLoad();
  const level = pressureLevel(sample, platform);
  const at = Math.floor(now() / 1000);
  const ramp = rows['admit-ramp-s'];
  let d;
  try {
    lock(lockPath(dir), { waitMs: LOCK_WAIT_MS, maxAgeMs: LOCK_MAX_AGE_MS });
  } catch {
    d = { outcome: 'would-deny', reason: 'admission-lock', fields: { pool, held } };
  }
  if (!d) {
    try {
      let text = '';
      try { text = readFileSync(ledgerFile(dir), 'utf8'); } catch { /* no ledger yet */ }
      const fresh = parseLedger(text).filter((e) => at - e.at < ramp);
      const kept = fresh.filter((e) => e.pid !== pid && isAlive(e.pid));
      d = judge({ pool, held, sample, level, recent: kept, rows });
      // This run's own admit stands for its ramp, whatever a later look at it says: on would have
      // let it in then. A would-admit adds one where it has none.
      const mine = fresh.find((e) => e.pid === pid);
      const admitted = d.outcome === 'would-admit' && d.reason === 'headroom';
      const keep = mine ? [...kept, mine] : admitted ? [...kept, { at, pool, pid, gb: d.fields.run_gb, load: d.fields.load_1m }] : kept;
      if (ledgerText(keep) !== text) writeTextAtomic(ledgerFile(dir), ledgerText(keep));
    } finally { unlock(lockPath(dir)); }
  }
  const key = `${d.outcome}:${d.reason}`;
  if (key !== last) logEvent({ event: d.outcome, kind: 'slot', key: cls, mode, reason: d.reason, pid, ...d.fields }, { dir: logDir });
  return key;
}

// A fixture's readings, for a test: DESK_ADMIT_SAMPLE holds sampleLoad's fields as JSON.
const fixtureSample = () => {
  try { return process.env.DESK_ADMIT_SAMPLE ? JSON.parse(process.env.DESK_ADMIT_SAMPLE) : null; } catch { return null; }
};

async function cli(argv) {
  const [sub, cls, ...rest] = argv;
  const opt = (n) => { const i = rest.indexOf(`--${n}`); return i < 0 ? null : rest[i + 1]; };
  const pid = Number(opt('pid'));
  if (sub !== 'judge' || !POOL_OF[cls] || !Number.isInteger(pid) || pid <= 0) {
    console.error('usage: admission.mjs judge <test|tsc|light> --pid <wrapper pid> [--last <outcome:reason>]');
    return 2;
  }
  try {
    const E = await import('./desk-env.mjs');
    const { leaseDir } = await import('./leases.mjs');
    // Every run that waits found its pool's real slots full: today's grants, heavy test-lock-slots, light 1.
    const held = POOL_OF[cls] === 'heavy' ? E.testLockSlots() : 1;
    const key = admit({ cls, pid, last: opt('last'), env: E, dir: E.lockDir(), held, logDir: leaseDir(), ...(fixtureSample() ? { sample: fixtureSample() } : {}) });
    if (key) console.log(key);
  } catch { /* a measurement: it never holds a run up */ }
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(await cli(process.argv.slice(2)));
