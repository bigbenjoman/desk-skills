// What a worktree is doing with the box-wide test lock (with-lock.sh test|tsc, which suites and
// typechecks share): running a command under it, waiting for it, or neither. Read from the process
// table, each process's working directory, the slot leases with-lock.sh takes from the lease broker,
// and the holder files it leaves in the lock dir.
import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { psRows } from './desk-env.mjs';
import { since } from './gate.mjs';
import { leaseDir, readStore, storeFile } from './leases.mjs';
import { tilde } from './logins.mjs';

// Every process's working directory, as [{pid, cmd, cwd}], read once: lsof, else Linux's /proc.
// Null when neither can be read.
let CWDS;
export function processCwds() {
  if (CWDS !== undefined) return CWDS;
  CWDS = null;
  const r = spawnSync('lsof', ['-n', '-w', '-d', 'cwd', '-Fpcn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!r.error) {
    // lsof exits 1 when it could not read some process, which still leaves the rest.
    CWDS = [];
    let cur = null;
    for (const l of (r.stdout ?? '').split('\n')) {
      if (l[0] === 'p') { cur = { pid: Number(l.slice(1)), cmd: '' }; } else if (l[0] === 'c' && cur) cur.cmd = l.slice(1);
      else if (l[0] === 'n' && cur) CWDS.push({ ...cur, cwd: l.slice(1) });
    }
    return CWDS;
  }
  try {
    CWDS = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).flatMap((d) => {
      try {
        let cmd = '';
        try { cmd = readFileSync(`/proc/${d}/comm`, 'utf8').trim(); } catch { /* unnamed */ }
        return [{ pid: Number(d), cmd, cwd: readlinkSync(`/proc/${d}/cwd`) }];
      } catch { return []; }
    });
  } catch { CWDS = null; }
  return CWDS;
}

// Whether a path is a directory or inside it, matched by the directory as given and by its real path.
export function insideOf(dir) {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* as given */ }
  return (p) => [dir, real].some((d) => p === d || p.startsWith(`${d}/`));
}

// The processes working in a directory, as [{pid, cmd, cwd}], leaving out the pids in skip. Null when
// no process's working directory can be read.
export function dirUsers(dir, skip = [], cwds = processCwds()) {
  if (!cwds) return null;
  const inDir = insideOf(dir);
  return cwds.filter((p) => !skip.includes(p.pid) && inDir(p.cwd));
}

// Each as `pid <n> (<command>)`, comma-separated.
export const usersText = (users) => users.map((p) => `pid ${p.pid}${p.cmd ? ` (${p.cmd})` : ''}`).join(', ');

// Every process as [{pid, ppid, args}], read once. Null when ps cannot be read.
let PROCS;
export function processList() {
  if (PROCS !== undefined) return PROCS;
  try { PROCS = psRows('pid=,ppid=,args=').filter((p) => Number.isInteger(p.pid) && Number.isInteger(p.ppid)); } catch { PROCS = null; }
  return PROCS;
}

// Which locks a reader asks about (`locks`): `test`, the test lock (test and tsc, the heavy slot pool);
// `light`, the light lock (§4 Suite weight light: with-lock.sh test runs as `light`); or `both`.
const POOLS = { test: ['slot:heavy'], light: ['slot:light'], both: ['slot:heavy', 'slot:light'] };
const LOCK_FILES = { test: 'desk-test', light: 'desk-light', both: '(?:desk-test|desk-light)' };

// The locks' slot leases, as [{pids, at}]: each slot lease's owner (the command with-lock.sh exec'd
// into, or ran as a child), with when it was taken (ms). Read from the store as it stands, without its
// lock: an owner that has exited names nobody here, as a stale holder file does not. [] when the store
// is missing or unreadable.
function slotLeases(locks = 'test') {
  let store;
  try { store = readStore(storeFile(leaseDir())); } catch { return []; }
  const pools = POOLS[locks];
  return store.leases.filter((l) => l.kind === 'slot' && pools.includes(l.pool) && l.owner)
    .map((l) => ({ pids: [l.owner.pid], at: Date.parse(l.acquired) }));
}
// The locks' holders, as [{pids, at}]: their slot leases (above), read first, then their holder files:
// each mkdir slot's `pid` (the wrapper and its command) and each flock slot's `.pid` (the command
// with-lock.sh exec'd into), with when each was written (ms). With the slot lease kind off, only the
// files name anyone; in shadow both name the same run.
function holderFiles(dir, locks = 'test') {
  const leases = slotLeases(locks);
  let names = [];
  try { names = readdirSync(dir); } catch { return leases; }
  const lock = LOCK_FILES[locks];
  const slotDir = new RegExp(`^${lock}\\.lock(\\.\\d+)?\\.d$`), slotPid = new RegExp(`^${lock}\\.lock(\\.\\d+)?\\.pid$`);
  return [...leases, ...names.flatMap((n) => {
    const file = slotDir.test(n) ? join(dir, n, 'pid') : slotPid.test(n) ? join(dir, n) : null;
    if (!file) return [];
    try {
      const pids = readFileSync(file, 'utf8').split(/\s+/).filter((p) => /^\d+$/.test(p)).map(Number);
      return [{ pids, at: statSync(file).mtimeMs }];
    } catch { return []; }
  })];
}
// The pids the locks' holder files and slot leases name.
export function lockHolders(dir, { locks = 'test' } = {}) {
  return new Set(holderFiles(dir, locks).flatMap((f) => f.pids));
}
// Each pid a holder file or slot lease names, with when its file was written or its lease taken (ms).
// A pid in both keeps the later time, which is when this run took the lock.
export function lockHolderStamps(dir, { locks = 'test' } = {}) {
  const out = new Map();
  for (const f of holderFiles(dir, locks)) for (const p of f.pids) out.set(p, Math.max(out.get(p) ?? -Infinity, f.at));
  return out;
}

// The process itself, by its first words: a worker's own command line quotes these commands in its
// prompt, and must not read as one.
// `names` is the lock names an alternation matches, e.g. 'test|tsc'.
export const wrapperOf = (names) => new RegExp(`^(?:\\S*\\/)?(?:(?:ba|z)?sh\\s+)?(?:\\S*\\/)?with-lock\\.sh\\s+(?:${names})(?:\\s|$)`);
const WRAPPER = wrapperOf('test|tsc');
const FLOCK = /^(?:\S*\/)?flock\s+(?:-\S+\s+)*\S*desk-test\.lock(?:\.\d+)?(?:\s|$)/;
// The same for the light lock, which a worker's suite takes in a repo whose §4 Suite weight is light.
const LIGHT_WRAPPER = wrapperOf('light');
const LIGHT_FLOCK = /^(?:\S*\/)?flock\s+(?:-\S+\s+)*\S*desk-light\.lock(?:\s|$)/;

// Whether a process is a flock(1) on one of the locks (`locks`, as holderFiles takes it).
const isFlock = (p, locks = 'both') => (locks !== 'light' && FLOCK.test(p.args)) || (locks !== 'test' && LIGHT_FLOCK.test(p.args));

// 'hold' when the process holds one of the locks, 'wait' when it waits for one, else null: a pid a
// holder file names holds; flock(1) runs its command as a child, so a single-slot flock with a child
// holds and one with none waits; a with-lock.sh wrapper no holder file names waits (a flock slot's
// wrapper has exec'd into its command by the time it holds). `holders` come from lockHolders with the
// same `locks`.
function lockRole(p, { procs, holders, locks = 'test' }) {
  if (holders.has(p.pid)) return 'hold';
  if (isFlock(p, locks)) return procs.some((c) => c.ppid === p.pid) ? 'hold' : 'wait';
  return (locks !== 'light' && WRAPPER.test(p.args)) || (locks !== 'test' && LIGHT_WRAPPER.test(p.args)) ? 'wait' : null;
}

// Whether a pid a holder file or slot lease names is that holder still: its process started before the
// file was written or the lease taken (`stamps`, lockHolderStamps), so a stale file whose pid was reused
// names nobody. A flock(1) is named by no file, and a pid with no stamp has nothing to check against.
function currentHolder(p, { ages, stamps, now }) {
  if (!stamps?.has(p.pid) || isFlock(p)) return true;
  const a = ages?.get(p.pid) ?? null;
  return a != null && now - a * 1000 <= stamps.get(p.pid) + 2000;
}

// Whether a process already runs inside a slot of the test or light lock: a holder file or slot lease
// names it and is current (above), or its parent is a flock(1) on either lock, which runs its command as
// a child and names it nowhere. How tests/related.sh, called through a with-lock.sh that does not
// export DESK_LOCK_HELD, knows not to wait for a second slot behind its own. `holders` and `stamps` from
// lockHolders and lockHolderStamps with `both`.
export function inSlot(pid, { procs, holders, ages, stamps, now = Date.now() }) {
  const me = procs?.find((p) => p.pid === pid);
  if (!me) return false;
  if (holders.has(pid) && currentHolder(me, { ages, stamps, now })) return true;
  const parent = procs.find((p) => p.pid === me.ppid);
  return !!parent && isFlock(parent);
}

// 'suite' when a process working in the worktree holds the test lock or the light lock (`holders` from
// lockHolders with `both`), 'lock' when one waits for either,
// else null. A holder file's pid counts only for a process still working in the worktree, so a stale
// file whose pid has been reused elsewhere names nothing here. 'unknown' when ps cannot be read: no
// list is not an empty one, so the pass holds the worker as it would a suite, up to the same ceiling.
export function suiteWait(worktree, { procs, cwds, holders }) {
  if (!worktree || !cwds) return null;
  if (!procs) return 'unknown';
  const here = new Set(dirUsers(worktree, [], cwds).map((c) => c.pid));
  let waiting = false;
  for (const p of procs) {
    if (!here.has(p.pid)) continue;
    const role = lockRole(p, { procs, holders, locks: 'both' });
    if (role === 'hold') return 'suite';
    if (role === 'wait') waiting = true;
  }
  return waiting ? 'lock' : null;
}

// How many runs wait on the test lock machine-wide, any worktree or session. Null when ps cannot be read.
export function lockWaiters({ procs, holders }) {
  if (!procs) return null;
  return procs.filter((p) => lockRole(p, { procs, holders }) === 'wait').length;
}

// How many of the runs waiting on or holding the test lock work inside one of `dirs` (a repo's main
// checkout and worktrees directory), as {waiting, held}: `held` from lockHolderRuns. Null when ps or the
// processes' working directories cannot be read, so whose the queue is is unknown.
export function lockRunsIn(dirs, { procs, holders, cwds, held = [] }) {
  if (!procs || !cwds) return null;
  const ins = dirs.filter(Boolean).map(insideOf);
  const inside = (cwd) => !!cwd && ins.some((f) => f(cwd));
  const cwdOf = (pid) => cwds.find((c) => c.pid === pid)?.cwd ?? null;
  return {
    waiting: procs.filter((p) => lockRole(p, { procs, holders }) === 'wait' && inside(cwdOf(p.pid))).length,
    held: held.filter((r) => inside(r.cwd)).length,
  };
}

// ps's elapsed time, [[dd-]hh:]mm:ss, in whole seconds; null when it does not read as one.
export function etimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? '').trim());
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}
// Every process's age in seconds, as a Map by pid, read once. Null when ps cannot be read.
let AGES;
export function processAges() {
  if (AGES !== undefined) return AGES;
  try { AGES = new Map(psRows('pid=,etime=').map((p) => [p.pid, etimeSeconds(p.etime)])); } catch { AGES = null; }
  return AGES;
}
// Who holds the test lock (or with `locks`, the light lock or both), any repo or session, as
// [{pid, cwd, args, seconds}]: each holding process whose parent does not hold it too (a mkdir slot's
// file names the wrapper and its command). seconds is how long it has held the lock: from its holder
// file, written as the lock is taken, else (a single-slot flock(1), which forks its command once it
// holds) from that command's age; null where unknown. cwd is null where it cannot be read. A pid only a
// holder file names counts only while it is that holder still (currentHolder). `holders` and `stamps`
// from lockHolders and lockHolderStamps with the same `locks`. [] when ps cannot be read.
export function lockHolderRuns({ procs, holders, cwds, ages, stamps, locks = 'test', now = Date.now() }) {
  if (!procs) return [];
  const age = (pid) => ages?.get(pid) ?? null;
  const holding = procs.filter((p) => lockRole(p, { procs, holders, locks }) === 'hold' && currentHolder(p, { ages, stamps, now }));
  const pids = new Set(holding.map((p) => p.pid));
  const held = (p) => {
    if (stamps?.has(p.pid) && !isFlock(p)) return Math.max(0, Math.floor((now - stamps.get(p.pid)) / 1000));
    const child = isFlock(p) ? procs.find((c) => c.ppid === p.pid) : null;
    return age(child ? child.pid : p.pid);
  };
  return holding.filter((p) => !pids.has(p.ppid)).map((p) => ({ pid: p.pid, cwd: cwds?.find((c) => c.pid === p.pid)?.cwd ?? null, args: p.args, seconds: held(p) }));
}
// Who holds the test lock (or `locks`) in lock dir `dir` now, read from the process table, cwds and
// holder files as lockHolderRuns takes them.
export const holdersNow = (dir, locks = 'test') => lockHolderRuns({ procs: processList(), holders: lockHolders(dir, { locks }), cwds: processCwds(), ages: processAges(), stamps: lockHolderStamps(dir, { locks }), locks });

// Each holder as `<where>: <command>, held <age>`, the command cut to 80 characters, `; `-separated.
export function holdersText(runs) {
  return runs.map((r) => {
    const cmd = r.args.length > 80 ? `${r.args.slice(0, 79)}…` : r.args;
    return `${r.cwd ? tilde(r.cwd) : `pid ${r.pid}`}: ${cmd}, ${r.seconds == null ? 'held for an unknown time' : `held ${since(r.seconds * 1000)}`}`;
  }).join('; ');
}

// Whether the test lock's queue is deep enough to hold new work: `waiting` runs at or over `slots` x
// `factor`. `waiting` null is a queue not read, which holds nothing. `held` (lockHolderRuns) names who
// holds the lock, so a batch held behind it shows what it waits on. `mine` (lockRunsIn) is the reading
// repo's own share: a deep queue `holds` that repo only while one of its runs waits on or holds the
// lock, so another repo's queue never stalls it. `mine` null (unread) or left out holds on depth alone.
export function lockQueue({ waiting, slots, factor, held = [], mine }) {
  const at = slots * factor;
  if (waiting == null) return { deep: false, holds: false, unread: true, waiting: null, at, line: 'test lock queue: not read (ps could not be read), so workers start as they would without it' };
  const deep = waiting >= at;
  const holds = deep && (mine == null || mine.waiting + mine.held > 0);
  const own = mine === undefined ? '' : mine === null ? ", whose runs they are unknown (working directories could not be read)" : `, ${mine.waiting} of them this repo's`;
  const by = held.length ? `; held by ${holdersText(held)}` : '';
  return { deep, holds, unread: false, waiting, at, line: `test lock queue: ${waiting} run(s) waiting on its ${slots} slot(s), ${deep ? 'at or over' : 'under'} the hold at ${slots} x ${factor} = ${at}${own}${by}` };
}

// What the pass says of each, in its quiet list and in a wedged park's reason.
export const SUITE_WAIT_TEXT = { suite: 'running its suite', lock: 'waiting on the test lock', unknown: 'ps could not be read, so whether it is running its suite is unknown' };
