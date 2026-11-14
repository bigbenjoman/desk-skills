// What a worktree is doing with the box-wide test lock (with-lock.sh test|tsc, which suites and
// typechecks share): running a command under it, waiting for it, or neither. Read from the process
// table, each process's working directory, and the holder files with-lock.sh leaves in the lock dir.
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
  const r = spawnSync('ps', ['-ww', '-axo', 'pid=,ppid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  PROCS = r.error || r.status !== 0 ? null : r.stdout.split('\n').flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }] : [];
  });
  return PROCS;
}

// The pids the test lock's holder files name: each mkdir slot's `pid` (the wrapper and its command)
// and each flock slot's `.pid` (the command with-lock.sh exec'd into).
export function lockHolders(dir) {
  const pids = new Set();
  let names = [];
  try { names = readdirSync(dir); } catch { return pids; }
  for (const n of names) {
    const file = /^desk-test\.lock(\.\d+)?\.d$/.test(n) ? join(dir, n, 'pid') : /^desk-test\.lock(\.\d+)?\.pid$/.test(n) ? join(dir, n) : null;
    if (!file) continue;
    try { for (const p of readFileSync(file, 'utf8').split(/\s+/)) if (/^\d+$/.test(p)) pids.add(Number(p)); } catch { /* released */ }
  }
  return pids;
}

// The process itself, by its first words: a worker's own command line quotes these commands in its
// prompt, and must not read as one.
const WRAPPER = /^(?:\S*\/)?(?:(?:ba|z)?sh\s+)?(?:\S*\/)?with-lock\.sh\s+(?:test|tsc)(?:\s|$)/;
const FLOCK = /^(?:\S*\/)?flock\s+(?:-\S+\s+)*\S*desk-test\.lock(?:\.\d+)?(?:\s|$)/;

// 'suite' when a process working in the worktree holds the test lock, 'lock' when one waits for it,
// else null. flock(1) runs its command as a child, so a single-slot flock with a child holds the lock.
// A holder file's pid counts only for a process still working in the worktree, so a stale file whose
// pid has been reused elsewhere names nothing here.
export function suiteWait(worktree, { procs, cwds, holders }) {
  if (!worktree || !procs || !cwds) return null;
  const here = new Set(dirUsers(worktree, [], cwds).map((c) => c.pid));
  let waiting = false;
  for (const p of procs) {
    if (!here.has(p.pid)) continue;
    if (holders.has(p.pid)) return 'suite';
    if (FLOCK.test(p.args)) {
      if (procs.some((c) => c.ppid === p.pid)) return 'suite';
      waiting = true;
    } else if (WRAPPER.test(p.args)) waiting = true;
  }
  return waiting ? 'lock' : null;
}

// What the pass says of each, in its quiet list and in a wedged park's reason.
export const SUITE_WAIT_TEXT = { suite: 'running its suite', lock: 'waiting on the test lock' };
