// Headroom admission for the test and light locks: whether a run that finds its pool's floor full
// is let in on the machine's live load, free memory and memory pressure. With the machine profile's
// lock-admission row shadow, a waiting run's would-admit or would-deny is logged in the lease log
// (leases.mjs) and nothing is granted; on, a run admitted takes a slot above the floor; off, or any
// admission row that does not read, logs nothing and grants the floors alone.
//
//   node admission.mjs judge <test|tsc|light> --pid <wrapper pid> [--last <outcome:reason>]
//   node admission.mjs watch <test|tsc|light> --pid <wrapper pid> --marker <its waiting marker>
//   node admission.mjs pool <test|tsc|light>
//   node admission.mjs grant <test|tsc|light> --pid <wrapper pid> [--last <key>] [--said <key> --said-at <epoch s>]
//
// `judge` judges the run once, with what the last judge printed: a line is logged only when the
// outcome or reason changes. It prints `<outcome>:<reason>`, nothing with admission off, and always
// exits 0. with-lock.sh starts `watch` in the background, which judges the run as it starts to wait
// and again while it waits (watch, below). Both are shadow's.
//
// `pool` prints the admission mode and the pool's floor and ceiling, `<mode> <floor> <ceiling>`, which
// is `off <floor> <floor>` unless the rows read. `grant` is on's (grant, below): it prints
// `<key>\t<say>\t<epoch s>\t<waiting line>`, nothing unless admission is on, and always exits 0.
//
// One rule for both pools on one reading (judge): a run above its floor is admitted only when
// load + admit-run-load x (recent admits + 1) <= admit-max-load, free memory less the run-GB of the
// recent admits and of this run >= admit-reserve-gb, and the pressure level < admit-max-pressure. A
// ceiling reached denies whatever the readings, and a reading that cannot be taken is no headroom.
// Recent means within admit-ramp-s, across both pools, from a ledger beside the lock files that a
// would-admit is added to, so shadow counts what on would have let in. The ledger is read, judged and
// written under an admission lock, so runs starting to wait in the same second see each other.
//
// Shadow grants nothing, so a run it would have let in still waits. Each such run, on its floor or on
// headroom, stays in the ledger while it waits and counts as holding a slot of its pool, so the floor
// and the ceiling are judged on what on would hold. A would-admit on the floor logs no line: on would
// grant it at once, as it does a free floor slot.
//
// On grants: a run let in is in the ledger as `admit` for as long as its pid runs, and its pool holds
// its floor plus those runs (the broker's current capacity, leases.mjs slotPools), so the ceiling is
// judged on what is really held. The floor itself is granted by the locks with no judge at all.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ledgerFile, ledgerText, lockWaitingDir as waitingDir, parseLedger } from './admit-ledger.mjs';
import { alive, lock, unlock, writeTextAtomic } from './dir-lock.mjs';
import { SLOTS, leaseDir, logEvent, sampleLoad } from './leases.mjs';
import { admissionRows, profileValue } from './machine.mjs';

export { ledgerFile, parseLedger };
// A lock class's pool (the broker's SLOTS), where admission judges it: heavy or light, else null.
const poolOf = (cls) => (SLOTS[cls] === 'heavy' || SLOTS[cls] === 'light' ? SLOTS[cls] : null);
const LOCK_WAIT_MS = 2000;
const LOCK_MAX_AGE_MS = 5000;
// A waiting run's line is printed again, on a new reason, no sooner than this after the last.
export const SAY_EVERY_S = 60;

const lockPath = (dir) => join(dir, 'desk-admit.lock');

// Linux's memory pressure reading is /proc/pressure/memory's `some avg10` %, not a level: read as
// macOS's levels, 1 normal under 10 %, 2 warn under 40 %, 4 critical from there.
export function pressureLevel(sample, platform = process.platform) {
  const p = sample?.mem_pressure;
  if (p == null || !Number.isFinite(Number(p))) return null;
  if (platform !== 'linux') return Number(p);
  return p < 10 ? 1 : p < 40 ? 2 : 4;
}

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
// `dir`, adds a would-admit to the ledger, and logs the line unless `last` (`<outcome>:<reason>`)
// says the same or it is a would-admit on the floor. `env` gives machineValue (raw profile values)
// and testLockSlots (desk-env's), `held` the real slots its pool holds; the ledger's runs of its pool
// still waiting (a marker in `waitingDir`) are added to them. A run already in the ledger keeps its
// would-admit and is not judged again: on would be running it. Dead pids are dropped, and an entry
// older than admit-ramp-s once its run no longer waits. -> the `<outcome>:<reason>` key, or null with
// admission off.
export function admit({ cls, pid, last = null, env, dir, held, logDir, sample = null, platform = process.platform, now = Date.now, isAlive = alive,
  isWaiting = (e) => existsSync(join(waitingDir(e.pool === 'heavy' ? 'test' : 'light', dir), String(e.pid))) }) {
  const pool = poolOf(cls);
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
      const entries = parseLedger(text);
      const mine = entries.find((e) => e.pid === pid);
      const others = entries.filter((e) => e.pid !== pid && isAlive(e.pid));
      const waiting = others.filter((e) => isWaiting(e));
      // A run on let in (left from before the row was set to shadow) holds its slot while it runs.
      const kept = others.filter((e) => at - e.at < ramp || waiting.includes(e) || e.reason === 'admit');
      if (mine) d = { outcome: 'would-admit', reason: mine.reason, fields: { pool, held } };
      else {
        const holding = waiting.filter((e) => e.pool === pool).length;
        const recent = others.filter((e) => (e.reason === 'headroom' || e.reason === 'admit') && at - e.at < ramp);
        d = judge({ pool, held: held + holding, sample, level, recent, rows });
        d.fields.shadow_held = holding;
      }
      const added = !mine && d.outcome === 'would-admit' ? [{ at, pool, pid, gb: d.fields.run_gb, load: d.fields.load_1m, reason: d.reason }] : [];
      const keep = [...kept, ...(mine ? [mine] : added)];
      if (ledgerText(keep) !== text) writeTextAtomic(ledgerFile(dir), ledgerText(keep));
    } finally { unlock(lockPath(dir)); }
  }
  const key = `${d.outcome}:${d.reason}`;
  if (key !== last && key !== 'would-admit:floor') logEvent({ event: d.outcome, kind: 'slot', key: cls, mode, reason: d.reason, pid, ...d.fields }, { dir: logDir });
  return key;
}

// A pool's admission mode, floor and ceiling from the rows (admissionRows): the floors as the locks
// grant them, and with the rows not reading, mode off. -> { mode, floor, ceiling }.
export function poolRows(pool, { rows, mode }) {
  if (mode !== 'on') {
    const floor = pool === 'heavy' ? rows['test-lock-slots'] : 1;
    return { mode, floor, ceiling: floor };
  }
  return pool === 'heavy' ? { mode, floor: rows['test-lock-slots'], ceiling: rows['test-lock-max'] }
    : { mode, floor: rows['light-lock-slots'], ceiling: rows['light-lock-max'] };
}

const LEVELS = { 1: 'normal', 2: 'warn', 4: 'critical' };
const levelName = (l) => (l == null ? 'unread' : LEVELS[l] ?? String(l));
const one = (n) => Math.round(n * 10) / 10;
// The line a run waiting for headroom prints, from its decision's fields: the pool, the slots held of
// its floor and ceiling, and why there is no room, with the numbers it was judged on.
export function waitText(cls, reason, f) {
  const why = {
    ceiling: 'at its ceiling',
    load: `no headroom: load ${one(f.load_1m)} + ${one(f.projected_load - f.load_1m)} > ${f.max_load}`,
    memory: `no headroom: ${Math.round(f.mem_free_gb)} GB free - ${one(f.recent_gb + f.run_gb)} < ${f.reserve_gb} GB reserve`,
    pressure: `no headroom: pressure ${levelName(f.mem_pressure)}, at or over ${levelName(f.max_pressure)}`,
    'load-unreadable': 'no headroom: the load could not be read',
    'memory-unreadable': 'no headroom: free memory could not be read',
    'pressure-unreadable': 'no headroom: memory pressure could not be read',
    'admission-lock': 'no headroom: the admission lock is busy',
  }[reason] ?? `no headroom: ${reason}`;
  const free = f.mem_free_gb == null ? 'unread' : Math.round(f.mem_free_gb);
  return `waiting for ${cls} lock: ${f.held} of ${f.floor}..${f.ceiling} held; ${why} (pressure ${levelName(f.mem_pressure)}, ${free} GB free, ${f.run_gb} GB/run)`;
}

// Whether a waiting run prints its line now: the first time, and after that only for a new reason,
// and no sooner than `every` seconds after the last line. `said` is the key last printed, `saidAt`
// when (epoch s), `at` now.
export const sayNow = ({ key, said, saidAt, at, every = SAY_EVERY_S }) => said == null || (key !== said && at - saidAt >= every);

// One waiting run's headroom admission with lock-admission on: the run found its pool's floor full.
// Judged under the admission lock against the ledger in `dir`, its pool holding its floor and the runs
// already let in above it that still run; one let in is added to the ledger as `admit` in the same
// hold, so two runs cannot both take the last room, and holds that place for as long as its pid runs.
// A run already let in is not judged again. A line is logged in the lease log, `admit` or `deny`, when
// the key changes from `last`. `env` is admit()'s. -> null unless admission is on, else { key
// ('admit:headroom' or 'deny:<reason>'), at, say (sayNow, for a deny), text (waitText) }.
export function grant({ cls, pid, last = null, said = null, saidAt = null, env, dir, logDir, sample = null, platform = process.platform, now = Date.now, isAlive = alive }) {
  const pool = poolOf(cls);
  if (!pool) return null;
  const admission = admissionRows((k) => env.machineValue(k), { testSlots: env.testLockSlots() });
  const { mode, floor, ceiling } = poolRows(pool, admission);
  if (mode !== 'on') return null;
  const { rows } = admission;
  sample ??= sampleLoad();
  const level = pressureLevel(sample, platform);
  const at = Math.floor(now() / 1000);
  const ramp = rows['admit-ramp-s'];
  let d;
  try {
    lock(lockPath(dir), { waitMs: LOCK_WAIT_MS, maxAgeMs: LOCK_MAX_AGE_MS });
  } catch {
    d = { ...judge({ pool, held: floor, sample, level, recent: [], rows }), outcome: 'would-deny', reason: 'admission-lock' };
  }
  if (!d) {
    try {
      let text = '';
      try { text = readFileSync(ledgerFile(dir), 'utf8'); } catch { /* no ledger yet */ }
      const live = parseLedger(text).filter((e) => isAlive(e.pid));
      const admitted = (e) => e.reason === 'admit' && e.pool === pool;
      const mine = live.find((e) => e.pid === pid && admitted(e));
      const others = live.filter((e) => e.pid !== pid);
      const held = Math.min(ceiling, floor + others.filter(admitted).length);
      const recent = others.filter((e) => (e.reason === 'admit' || e.reason === 'headroom') && at - e.at < ramp);
      d = judge({ pool, held, sample, level, recent, rows });
      if (mine) d = { ...d, outcome: 'would-admit', reason: 'headroom' };
      // Shadow's would-admits are kept as shadow keeps them, so a row set back to shadow finds them.
      const kept = live.filter((e) => e.pid !== pid || e.reason !== 'admit')
        .filter((e) => e.reason === 'admit' || at - e.at < ramp || existsSync(join(waitingDir(e.pool === 'heavy' ? 'test' : 'light', dir), String(e.pid))));
      const added = mine ? [mine] : d.outcome === 'would-admit' ? [{ at, pool, pid, gb: d.fields.run_gb, load: d.fields.load_1m, reason: 'admit' }] : [];
      const keep = [...kept, ...added];
      if (ledgerText(keep) !== text) writeTextAtomic(ledgerFile(dir), ledgerText(keep));
    } finally { unlock(lockPath(dir)); }
  }
  d.fields.floor = floor; d.fields.ceiling = ceiling;
  const outcome = d.outcome === 'would-admit' ? 'admit' : 'deny';
  const key = `${outcome}:${d.reason}`;
  if (key !== last) logEvent({ event: outcome, kind: 'slot', key: cls, mode, reason: d.reason, pid, ...d.fields }, { dir: logDir });
  return { key, at, say: outcome === 'deny' && sayNow({ key, said, saidAt, at }), text: waitText(cls, d.reason, d.fields) };
}

// A fixture's readings, for a test: DESK_ADMIT_SAMPLE holds sampleLoad's fields as JSON, or `@<file>`
// names a file holding them, read afresh at each judge so a test can change them while a run waits.
const fixtureSample = () => {
  const v = process.env.DESK_ADMIT_SAMPLE;
  try { return v ? JSON.parse(v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v) : null; } catch { return null; }
};

async function judgeCli(cls, pid, last) {
  const E = await import('./desk-env.mjs');
  const { leaseDir } = await import('./leases.mjs');
  // Every run that waits found its pool's real slots full: today's grants, heavy test-lock-slots, light 1.
  const held = poolOf(cls) === 'heavy' ? E.testLockSlots() : 1;
  // The rows as the profile holds them, as machine detect's check reads them: a TODO is a row that
  // does not read, not one left unset.
  const env = { machineValue: (k) => profileValue(E.machineProfile(), k), testLockSlots: E.testLockSlots };
  const key = admit({ cls, pid, last, env, dir: E.lockDir(), held, logDir: leaseDir(), ...(fixtureSample() ? { sample: fixtureSample() } : {}) });
  if (key) console.log(key);
}

// The rows as the profile holds them, as judgeCli reads them, for pool and grant.
async function profileEnv() {
  const E = await import('./desk-env.mjs');
  return { E, env: { machineValue: (k) => profileValue(E.machineProfile(), k), testLockSlots: E.testLockSlots } };
}
async function poolCli(cls) {
  const { env } = await profileEnv();
  const p = poolRows(poolOf(cls), admissionRows(env.machineValue, { testSlots: env.testLockSlots() }));
  console.log(`${p.mode} ${p.floor} ${p.ceiling}`);
}
// grant() for a real run, with desk-env's exports `E`: the profile's rows, the lock directory, the lease
// log, and the fixture readings where a test sets them.
export const grantRun = (E, { cls, pid, last = null, said = null, saidAt = null }) => grant({ cls, pid, last, said, saidAt,
  env: { machineValue: (k) => profileValue(E.machineProfile(), k), testLockSlots: E.testLockSlots },
  dir: E.lockDir(), logDir: leaseDir(), ...(fixtureSample() ? { sample: fixtureSample() } : {}) });
async function grantCli(cls, pid, { last, said, saidAt }) {
  const { E } = await profileEnv();
  const r = grantRun(E, { cls, pid, last, said, saidAt: saidAt == null || saidAt === '' ? null : Number(saidAt) });
  if (r) console.log([r.key, r.say ? 1 : 0, r.at, r.text].join('\t'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// with-lock.sh's look at its run while it waits, as a process of its own: a forked shell would carry the
// wrapper's command line, and suite-wait.mjs would count it as a second run waiting on the lock. Once
// the run's marker (the wrapper's own path to it) exists, looked for every 0.2 s since a lease's wait can
// be its 2 s poll and no longer, the run is judged, then again every DESK_ADMIT_RECHECK_S seconds (30).
// Each judge is a fresh process, so it reads the profile as it stands then. It ends when the marker
// goes, when the wrapper does, or at once when a judge prints nothing (admission off).
async function watch(cls, pid, marker) {
  const every = /^[1-9]\d*$/.test(process.env.DESK_ADMIT_RECHECK_S ?? '') ? Number(process.env.DESK_ADMIT_RECHECK_S) : 30;
  const judgeNow = (last) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'judge', cls, '--pid', String(pid), ...(last ? ['--last', last] : [])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout?.trim() || null;
  let key = null; let seen = false; let n = 0;
  while (alive(pid)) {
    if (existsSync(marker)) {
      if (!seen || n >= every) {
        key = judgeNow(key);
        if (!key) return;
        seen = true; n = 0;
      }
    } else if (seen) return;
    await sleep(seen ? 1000 : 200);
    if (seen) n++;
  }
}

async function cli(argv) {
  const [sub, cls, ...rest] = argv;
  const opt = (n) => { const i = rest.indexOf(`--${n}`); return i < 0 ? null : rest[i + 1]; };
  const pid = Number(opt('pid'));
  if (!['judge', 'watch', 'pool', 'grant'].includes(sub) || !poolOf(cls) || (sub !== 'pool' && (!Number.isInteger(pid) || pid <= 0)) || (sub === 'watch' && !opt('marker'))) {
    console.error('usage: admission.mjs judge <test|tsc|light> --pid <wrapper pid> [--last <outcome:reason>]\n       admission.mjs watch <test|tsc|light> --pid <wrapper pid> --marker <its waiting marker>'
      + '\n       admission.mjs pool <test|tsc|light>\n       admission.mjs grant <test|tsc|light> --pid <wrapper pid> [--last <key>] [--said <key> --said-at <epoch s>]');
    return 2;
  }
  // Nothing here holds a run up: a failure prints nothing, which the wrapper reads as admission off
  // (pool) or no room (grant), and its floor is granted as before.
  try {
    if (sub === 'watch') await watch(cls, pid, opt('marker'));
    else if (sub === 'pool') await poolCli(cls);
    else if (sub === 'grant') await grantCli(cls, pid, { last: opt('last'), said: opt('said'), saidAt: opt('said-at') });
    else await judgeCli(cls, pid, opt('last'));
  } catch { /* as above */ }
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(await cli(process.argv.slice(2)));
