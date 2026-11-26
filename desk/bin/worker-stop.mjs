// Ending one worker session's processes, for queue.mjs stop. spawn-worker.sh records no pid it can
// trust (setsid may fork), so the session id on the command line is the handle: the claude CLI and the
// wrapper spawn-worker.sh runs it under both carry `--session-id <sid>` or `--resume <sid>`.
import { sleepSync } from './dir-lock.mjs';
import { readRows, treeTarget } from './lock-orphans.mjs';

// Every live process as { pid, ppid, pgid, stat, tty, args } (lock-orphans.mjs readRows); a zombie is
// already gone. Throws when ps cannot be read.
export function processRows() {
  const rows = readRows();
  if (!rows) throw new Error('ps could not be read');
  return rows;
}

// Whether command line `args` starts session `sid`: the flag and the id as two whole words.
export function startsSession(args, sid) {
  const words = String(args).split(/\s+/);
  return words.some((w, i) => (w === '--session-id' || w === '--resume') && words[i + 1] === sid)
    || words.includes(`--session-id=${sid}`) || words.includes(`--resume=${sid}`);
}

// What to end for session `sid`, from `rows` (processRows): { groups, pids }. Every process starting the
// session and every descendant of one is ended (lock-orphans.mjs treeTarget): the groups such a process
// leads (setsid makes the wrapper a leader; a detached child leads its own) whole, the rest by pid (no
// setsid: the group is the spawner's). Never `self`, its ancestors, or a group any of them is in.
export function workerProcs(sid, rows, self = process.pid) {
  return treeTarget(rows.filter((r) => startsSession(r.args, sid)).map((r) => r.pid), rows, self);
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
