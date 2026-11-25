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
// `light`, the light lock (§4 Suite weight light: with-lock.sh test runs as `light`); or `both`. The
// job tokens (job-token.mjs, slot:job) count with the light lock: with the job-tokens row on, a light run
// holds them in place of a light slot.
const POOLS = { test: ['slot:heavy'], light: ['slot:light', 'slot:job'], both: ['slot:heavy', 'slot:light', 'slot:job'] };
// Each slot pool's lock files, by the name with-lock.sh gives them. The job pool has none.
const POOL_LOCK = { 'slot:heavy': 'desk-test', 'slot:light': 'desk-light', 'slot:browser': 'desk-browser' };
const LOCK_FILES = Object.fromEntries(Object.entries(POOLS).map(([k, all]) => {
  const ps = all.filter((p) => POOL_LOCK[p]);
  return [k, ps.length > 1 ? `(?:${ps.map((p) => POOL_LOCK[p]).join('|')})` : POOL_LOCK[ps[0]]];
}));

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
// with-lock.sh exec'd into), with when each was written (ms), the light lock's express lane
// (`desk-light.lock.express`) among them. With the slot lease kind off, only the files name anyone; in
// shadow both name the same run.
function holderFiles(dir, locks = 'test') {
  return [...slotLeases(locks), ...slotFiles(dir, LOCK_FILES[locks]).filter((f) => f.at != null)];
}
// The slot files of lock `lock` (a name, or an alternation of names) in `dir`, as [{ file, pids, at }]:
// each mkdir slot (`<slot>.d`, its `pid` naming the wrapper and its command) and each flock slot's holder
// file (`<slot>.pid`, the command with-lock.sh exec'd into), with the pids it names and when it was
// written (ms); `at` null where it does not read. `express` keeps the light lock's express lane among
// them. [] when the dir cannot be read.
function slotFiles(dir, lock, { express = true } = {}) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const slot = new RegExp(`^${lock}\\.lock(\\.\\d+${express ? '|\\.express' : ''})?\\.(d|pid)$`);
  return names.filter((n) => slot.test(n)).map((n) => {
    const file = join(dir, n), pidFile = n.endsWith('.d') ? join(file, 'pid') : file;
    try {
      return { file, pids: readFileSync(pidFile, 'utf8').split(/\s+/).filter((p) => /^\d+$/.test(p)).map(Number), at: statSync(pidFile).mtimeMs };
    } catch { return { file, pids: [], at: null }; }
  });
}
// Whether a process that started at `start` (ms) is the one a holder file written at `at` (ms) names:
// it started no later than the file was written, with 2 s for ps's whole-second ages.
const startedBy = (start, at) => start <= at + 2000;
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

// The lock files of slot pool `pool` that a live run holds, as [{ file, pids, pid }] (slotFiles, the
// light lock's express lane left out: it sits outside the pool). A file holds while a pid it names runs,
// is not a zombie and started by when the file was written (`pid` is that one), so a holder that has
// exited, or whose pid was reused since, holds nothing. A mkdir slot naming no pid, its pid file not yet
// written or empty, holds for its first minute (`pid` null), as with-lock.sh's own take() reads it; a
// flock holder file naming none holds nothing. `rows` gives psRows('pid=,stat=,etime='), read afresh
// and only where a file names a pid. [] when the lock dir cannot be read.
export function lockFileHolders(dir, pool, { rows = () => psRows('pid=,stat=,etime='), now = Date.now() } = {}) {
  const young = (file) => { try { return now - statSync(file).mtimeMs < 60_000; } catch { return false; } };
  const files = (POOL_LOCK[pool] ? slotFiles(dir, POOL_LOCK[pool], { express: false }) : [])
    .filter((f) => f.pids.length || (f.file.endsWith('.d') && young(f.file)));
  if (!files.some((f) => f.pids.length)) return files.map(({ file, pids }) => ({ file, pids, pid: null }));
  // A live pid whose age ps does not give holds: a slot a run may hold is never granted on a guess.
  const start = new Map(rows().filter((r) => !/^Z/.test(r.stat ?? '')).map((r) => { const s = etimeSeconds(r.etime); return [r.pid, s == null ? -Infinity : now - s * 1000]; }));
  return files.flatMap(({ file, pids, at }) => {
    if (!pids.length) return [{ file, pids, pid: null }];
    const pid = pids.find((p) => start.has(p) && startedBy(start.get(p), at));
    return pid == null ? [] : [{ file, pids, pid }];
  });
}

// The process itself, by its first words: a worker's own command line quotes these commands in its
// prompt, and must not read as one.
// `names` is the lock names an alternation matches, e.g. 'test|tsc'.
export const wrapperOf = (names) => new RegExp(`^(?:\\S*\\/)?(?:(?:ba|z)?sh\\s+)?(?:\\S*\\/)?with-lock\\.sh\\s+(?:${names})(?:\\s|$)`);
const WRAPPER = wrapperOf('test|tsc');
const FLOCK = /^(?:\S*\/)?flock\s+(?:-\S+\s+)*\S*desk-test\.lock(?:\.\d+)?(?:\s|$)/;
// The same for the light lock, which a worker's suite takes in a repo whose §4 Suite weight is light.
const LIGHT_WRAPPER = wrapperOf('light');
const LIGHT_FLOCK = /^(?:\S*\/)?flock\s+(?:-\S+\s+)*\S*desk-light\.lock(?:\.\d+)?(?:\s|$)/;
// A run.sh suite, or a with-lock.sh light command, waiting for a job token: the take exits once granted.
const JOB_TAKE = /^(?:\S*\/)?node\s+(?:\S*\/)?job-token\.mjs\s+take(?:\s|$)/;

// Whether a process is a flock(1) on one of the locks (`locks`, as holderFiles takes it).
const isFlock = (p, locks = 'both') => (locks !== 'light' && FLOCK.test(p.args)) || (locks !== 'test' && LIGHT_FLOCK.test(p.args));

// 'hold' when the process holds one of the locks, 'wait' when it waits for one, else null: a pid a
// holder file or lease names holds; flock(1) runs its command as a child, so a single-slot flock with a
// child holds and one with none waits; a with-lock.sh wrapper no holder file names waits (a flock slot's
// wrapper has exec'd into its command by the time it holds), and so, with the light lock, does a job
// token's take. `holders` come from lockHolders with the same `locks`.
function lockRole(p, { procs, holders, locks = 'test' }) {
  if (holders.has(p.pid)) return 'hold';
  if (isFlock(p, locks)) return procs.some((c) => c.ppid === p.pid) ? 'hold' : 'wait';
  return (locks !== 'light' && WRAPPER.test(p.args)) || (locks !== 'test' && (LIGHT_WRAPPER.test(p.args) || JOB_TAKE.test(p.args))) ? 'wait' : null;
}

// The run a holding or waiting process is part of, by pid: a job token's take stands for the process
// that started it, and a subshell (a forked shell keeps its parent's command line) for its parent, so a
// run.sh whose suites each hold or wait for a token is one run, as is a wrapper and its subshells.
function runOf(p, procs) {
  const byPid = (pid) => procs.find((c) => c.pid === pid);
  let cur = JOB_TAKE.test(p.args) ? byPid(p.ppid) ?? p : p;
  for (let up = byPid(cur.ppid); up && up.pid !== cur.pid && up.args === cur.args; up = byPid(cur.ppid)) cur = up;
  return cur;
}

// Whether a pid a holder file or slot lease names is that holder still: its process started before the
// file was written or the lease taken (`stamps`, lockHolderStamps), so a stale file whose pid was reused
// names nobody. A flock(1) is named by no file, and a pid with no stamp has nothing to check against.
function currentHolder(p, { ages, stamps, now }) {
  if (!stamps?.has(p.pid) || isFlock(p)) return true;
  const a = ages?.get(p.pid) ?? null;
  return a != null && startedBy(now - a * 1000, stamps.get(p.pid));
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

// How many runs wait on the test lock (or with `locks`, the light lock) machine-wide, any worktree or
// session, each run once (runOf). `holders` from lockHolders with the same `locks`. Null when ps cannot
// be read.
const waitingRuns = (procs, holders, locks) => [...new Map(procs.filter((p) => lockRole(p, { procs, holders, locks }) === 'wait')
  .map((p) => runOf(p, procs)).map((r) => [r.pid, r])).values()];
export function lockWaiters({ procs, holders, locks = 'test' }) {
  if (!procs) return null;
  return waitingRuns(procs, holders, locks).length;
}

// The runs holding or waiting on the test lock (or `locks`), counted by the repo each works in, as a Map
// of name to count: `repos` is [{name, dirs}] (each repo's main checkout and worktrees directory), and a
// run in none of them counts under `other`. `held` from lockHolderRuns. Null when ps or the processes'
// working directories cannot be read, so whose runs they are is unknown.
export function lockRunsByRepo(repos, { procs, holders, cwds, held = [], locks = 'test' }) {
  if (!procs || !cwds) return null;
  const ins = repos.map((r) => ({ name: r.name, in: r.dirs.filter(Boolean).map(insideOf) }));
  const repoOf = (cwd) => (cwd && ins.find((r) => r.in.some((f) => f(cwd)))?.name) || 'other';
  // Each run once: a run.sh with one suite holding a job token and another waiting for one both holds
  // and waits, under the same pid (runOf), and is one of its repo's runs, not two.
  const runs = new Map(held.map((r) => [r.pid, r.cwd]));
  for (const p of waitingRuns(procs, holders, locks)) if (!runs.has(p.pid)) runs.set(p.pid, cwds.find((c) => c.pid === p.pid)?.cwd ?? null);
  const counts = new Map();
  for (const cwd of runs.values()) { const n = repoOf(cwd); counts.set(n, (counts.get(n) ?? 0) + 1); }
  return counts;
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
  // A run.sh's suites each holding a job token are one run, held for as long as its longest-held token.
  const runs = new Map();
  for (const p of holding.filter((h) => !pids.has(h.ppid))) {
    const r = runOf(p, procs), s = held(p), was = runs.get(r.pid);
    if (!was) runs.set(r.pid, { pid: r.pid, cwd: cwds?.find((c) => c.pid === r.pid)?.cwd ?? cwds?.find((c) => c.pid === p.pid)?.cwd ?? null, args: r.args, seconds: s });
    else if (s != null && (was.seconds == null || s > was.seconds)) was.seconds = s;
  }
  return [...runs.values()];
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

// How many suite-bound workers repo `self` may start this pass on the test lock (`room`), and whether
// it is held (`holds`, no room). The hold point `at` is `slots` x `factor`; the queue is `deep` with
// `waiting` runs at or over it. Deep, each active repo (one with a run holding or waiting on the lock,
// `self` always counted) gets share = ceil(at / active) runs, and `self` may start share - own, own its
// runs in `counts` (lockRunsByRepo). Below the hold, at - waiting may start, so a pass cannot overshoot
// it. `counts` null (unread) gives no room while deep. `waiting` null is a queue not read, which holds
// nothing. `held` (lockHolderRuns) names who holds the lock, so a batch held behind it shows what it
// waits on. `lock` is the lock the reading is of, `test` or `light`, as its line names it.
export function lockQueue({ waiting, slots, factor, held = [], counts, self, lock = 'test' }) {
  const at = slots * factor;
  if (waiting == null) return { lock, deep: false, holds: false, room: Infinity, unread: true, waiting: null, at, line: `${lock} lock queue: not read (ps could not be read), so workers start as they would without it` };
  const deep = waiting >= at;
  let room = Math.max(0, at - waiting), share = null, own = null, byRepo = '';
  if (counts == null) {
    if (deep) room = 0;
    byRepo = '; whose runs they are is unknown (working directories could not be read)';
  } else {
    own = counts.get(self) ?? 0;
    const active = new Set([...counts.keys(), self]).size;
    share = Math.ceil(at / active);
    if (deep) room = Math.max(0, share - own);
    const each = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([n, c]) => `${n} ${c}`).join(', ');
    byRepo = `; runs by repo: ${each || 'none'}`;
    if (deep) byRepo += `; this repo's share ceil(${at} / ${active}) = ${share}, ${own} its own`;
  }
  const by = held.length ? `; held by ${holdersText(held)}` : '';
  return { lock, deep, holds: room <= 0, room, share, own, unread: false, waiting, at, line: `${lock} lock queue: ${waiting} run(s) waiting on its ${slots} slot(s), ${deep ? 'at or over' : 'under'} the hold at ${slots} x ${factor} = ${at}${byRepo}${by}` };
}

// The gate over the lock queues a repo's suite-bound workers would join (lockQueue readings; a null is
// left out), or null with none: its room is the least any leaves, it holds when any holds, and its line
// is each holding queue's, else the tightest's. `queues` keeps every reading, so one not read is said.
export function lockGate(queues) {
  const read = queues.filter(Boolean);
  if (!read.length) return null;
  const tight = read.reduce((a, b) => (b.room < a.room ? b : a));
  const holding = read.filter((q) => q.holds);
  return { ...tight, holds: holding.length > 0, line: holding.length ? holding.map((q) => q.line).join('; and ') : tight.line, queues: read };
}

// What the pass says of each, in its quiet list and in a wedged park's reason.
export const SUITE_WAIT_TEXT = { suite: 'running its suite', lock: 'waiting on the test lock', unknown: 'ps could not be read, so whether it is running its suite is unknown' };
