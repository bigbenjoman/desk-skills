// Ending one worker session's processes, for queue.mjs stop. spawn-worker.sh records no pid it can
// trust (setsid may fork), so the session id on the command line is the handle: the claude CLI and the
// wrapper spawn-worker.sh runs it under both carry `--session-id <sid>` or `--resume <sid>`.
import { psRows } from './desk-env.mjs';
import { sleepSync } from './dir-lock.mjs';

const COLUMNS = 'pid=,ppid=,pgid=,stat=,args=';

// Every live process as { pid, ppid, pgid, args }; a zombie is already gone. Throws when ps cannot be read.
export function processRows(read = () => psRows(COLUMNS)) {
  return read().map((r) => ({ pid: Number(r.pid), ppid: Number(r.ppid), pgid: Number(r.pgid), stat: String(r.stat ?? ''), args: String(r.args ?? '') }))
    .filter((r) => Number.isInteger(r.pid) && Number.isInteger(r.pgid) && !r.stat.startsWith('Z'));
}

// Whether command line `args` starts session `sid`: the flag and the id as two whole words.
export function startsSession(args, sid) {
  const words = String(args).split(/\s+/);
  return words.some((w, i) => (w === '--session-id' || w === '--resume') && words[i + 1] === sid)
    || words.includes(`--session-id=${sid}`) || words.includes(`--resume=${sid}`);
}

// What to end for session `sid`, from `rows` (processRows): { groups, pids }. Every process starting the
// session and every descendant of one is ended. `groups` are the process groups such a process leads
// (setsid makes the wrapper a leader; a detached child leads its own), signalled whole, so a child that
// outlived its parent still goes with its group; `pids` are the rest, outside any such group (no setsid:
// the group is the spawner's). Never `self`, its ancestors, or a group any of them is in.
export function workerProcs(sid, rows, self = process.pid) {
  return treeProcs(rows.filter((r) => startsSession(r.args, sid)), rows, self);
}

// What to end for the processes `roots` (rows) and every descendant of one, as workerProcs reads them.
function treeProcs(roots, rows, self, extra = () => false) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const mine = new Set();
  for (let p = byPid.get(self); p && !mine.has(p.pid); p = byPid.get(p.ppid)) mine.add(p.pid);
  const myGroups = new Set([...mine].map((p) => byPid.get(p)?.pgid));
  const tree = new Set();
  const walk = (r) => {
    if (mine.has(r.pid) || tree.has(r.pid)) return;
    tree.add(r.pid);
    for (const c of rows) if (c.ppid === r.pid) walk(c);
  };
  roots.forEach(walk);
  const procs = [...tree].map((p) => byPid.get(p));
  const groups = new Set(procs.filter((r) => (r.pgid === r.pid || extra(r.pgid)) && !myGroups.has(r.pgid)).map((r) => r.pgid));
  return { groups: [...groups], pids: procs.filter((r) => !groups.has(r.pgid)).map((r) => r.pid) };
}

// What to end for one run (a lock holder) at `pid`: it and every descendant, and its process group
// whole. A group it does not lead is ended whole only once its leader has exited and no Claude session
// (`isSession`, on args) is in it: the group of a dead caller, whose other members are the run's own
// processes re-parented away from it. { groups, pids }, empty when `pid` is not in `rows`.
export function runProcs(pid, rows, { self = process.pid, isSession = () => false } = {}) {
  const root = rows.find((r) => r.pid === pid);
  if (!root) return { groups: [], pids: [] };
  const orphanGroup = (g) => g === root.pgid && !rows.some((r) => r.pid === g)
    && !rows.some((r) => r.pgid === g && isSession(r.args));
  return treeProcs([root], rows, self, orphanGroup);
}

// The pids still alive of what `target` names, read from `rows`.
const left = (target, rows) => rows.filter((r) => target.groups.includes(r.pgid) || target.pids.includes(r.pid)).map((r) => r.pid);

// SIGTERM every group and pid `target` names, wait up to `graceMs` for them to go, then SIGKILL what is
// left and wait up to `killMs`. -> { ended: [pid], left: [pid] }: those that were signalled and went,
// and those still alive at the end.
export function endProcs(target, { graceMs = 10_000, killMs = 3_000, rows = processRows, kill = (p, s) => process.kill(p, s) } = {}) {
  const before = left(target, rows());
  // A SIGKILL goes only to what is still alive, so a pid freed since the SIGTERM is never signalled.
  const signal = (sig, alive = null) => {
    const live = alive && rows().filter((r) => alive.includes(r.pid));
    for (const g of target.groups) if (!live || live.some((r) => r.pgid === g)) { try { kill(-g, sig); } catch { /* already gone */ } }
    for (const p of target.pids) if (!alive || alive.includes(p)) { try { kill(p, sig); } catch { /* already gone */ } }
  };
  const waitGone = (ms) => {
    for (const until = Date.now() + ms; ;) {
      const now = left(target, rows());
      if (!now.length || Date.now() >= until) return now;
      sleepSync(100);
    }
  };
  signal('SIGTERM');
  let still = waitGone(graceMs);
  if (still.length) {
    signal('SIGKILL', still);
    still = waitGone(killMs);
  }
  return { ended: before.filter((p) => !still.includes(p)), left: still };
}
