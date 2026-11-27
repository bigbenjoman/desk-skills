#!/usr/bin/env node
// Ends a locked run once its caller exits, so a run whose worker died cannot keep the test lock.
// with-lock.sh starts it in the background as it grants a slot, then runs the command:
//
//   lock-caller-watch.mjs <run pid>
//
// The run is with-lock.sh's own pid (it execs into the command, or stays as the command's parent). Its
// callers are its parent and every `sh -c` or login shell above it, up to and with the first process
// that is not one (lock-orphans.mjs callersOf): the worker session, the pass, the merge driver, a
// terminal. Every 2 s it looks whether the run and each caller are still there. The run ending ends the
// watch. A caller ending ends the run: its whole process group, where nothing outside the run is in it,
// and its descendants (lock-orphans.mjs endTarget), with SIGTERM, then SIGKILL after 10 s. A run already
// re-parented, with no caller to watch, is left to the pass (lock-orphans.mjs orphanReason).
// It closes the lock's descriptor and its own output, so it never holds the lock or a reader's pipe.
import { callersOf, endTarget, readRows } from './lock-orphans.mjs';

const POLL_MS = Number(process.env.DESK_CALLER_WATCH_MS) || 2000;
const TERM_MS = 10_000;
const run = Number(process.argv[2]);
if (!Number.isInteger(run) || run <= 1) process.exit(2);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const rows0 = readRows();
const up = rows0 && callersOf(run, rows0);
if (!up?.callers.length || !up.owner) process.exit(0);
const callers = up.callers;

// A group signal reaches this watch too where it shares the run's group: it ends the run, not itself.
process.on('SIGTERM', () => {});
process.on('SIGHUP', () => {});

function end() {
  const rows = readRows();
  if (!rows) return;
  const target = endTarget(run, rows);
  const send = (sig, live) => {
    for (const g of target.groups) if (!live || live.some((r) => r.pgid === g)) { try { process.kill(-g, sig); } catch { /* gone */ } }
    for (const p of target.pids) if (!live || live.some((r) => r.pid === p)) { try { process.kill(p, sig); } catch { /* gone */ } }
  };
  // Each still alive by pid, never by group, once this watch may be in the group a SIGKILL would reach.
  const left = () => (readRows() ?? []).filter((r) => r.pid !== process.pid && (target.groups.includes(r.pgid) || target.pids.includes(r.pid)));
  send('SIGTERM');
  for (const until = Date.now() + TERM_MS; Date.now() < until;) {
    if (!left().length) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  for (const r of left()) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
}

const timer = setInterval(() => {
  if (!alive(run)) { clearInterval(timer); process.exit(0); }
  if (callers.some((p) => !alive(p))) { clearInterval(timer); end(); process.exit(0); }
}, POLL_MS);
