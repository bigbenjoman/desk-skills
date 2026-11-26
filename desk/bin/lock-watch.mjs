#!/usr/bin/env node
// Ties a with-lock.sh run to the process that called with-lock.sh, so the run cannot outlive it and keep
// the lock: once the caller has exited, the run and its process group are ended.
//   node lock-watch.mjs start <run pid> <caller pid>   # what with-lock.sh runs just before the command
//   node lock-watch.mjs watch <run pid> <caller pid> <run start>
// `start` reads the run's start time and leaves a `watch` running detached, in a session of its own, so
// a signal to the caller's process group does not end the watch before it has ended the run. The watch
// is never a child of the run: a command that waits for every child would wait for it.
// `watch` looks every DESK_LOCK_WATCH_S seconds (2). It exits once the run has (its pid gone, or reused:
// the start time differs), and once the run's parent is no longer the caller, the caller has exited and
// the run been re-parented: it ends the run's processes (worker-stop.mjs runProcs), SIGTERM then SIGKILL,
// and exits. A caller of pid 1 or less is no caller to watch.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { psRows } from './desk-env.mjs';
import { sleepSync } from './dir-lock.mjs';
import { isClaudeProcess, procStats } from './leases.mjs';
import { endProcs, processRows, runProcs } from './worker-stop.mjs';

// { ppid, start } for `pid` (leases.mjs procStats), or null once it has gone or cannot be read.
const procOf = (pid) => { try { return procStats([pid], psRows).get(pid); } catch { return null; } };

// Whether the watch should end the run now: 'gone' when the run has, 'orphaned' when its parent is no
// longer the caller, else null.
export function verdict(now, caller, start) {
  if (!now || now.start !== start) return 'gone';
  return now.ppid !== caller ? 'orphaned' : null;
}

const whole = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null);

const isMain = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  const [cmd, runArg, callerArg, start] = process.argv.slice(2);
  const run = whole(runArg), caller = whole(callerArg);
  if (!['start', 'watch'].includes(cmd) || !run || caller == null) {
    console.error('usage: lock-watch.mjs start <run pid> <caller pid>');
    process.exit(2);
  }
  if (caller <= 1) process.exit(0);
  if (cmd === 'start') {
    const p = procOf(run);
    if (!p) process.exit(0);
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch', String(run), String(caller), p.start], { detached: true, stdio: 'ignore' }).unref();
    process.exit(0);
  }
  const every = (whole(process.env.DESK_LOCK_WATCH_S) || 2) * 1000;
  for (;;) {
    const v = verdict(procOf(run), caller, start);
    if (v === 'gone') process.exit(0);
    if (v === 'orphaned') {
      let rows;
      try { rows = processRows(); } catch { process.exit(1); }
      // Read again from the rows the target comes from, so a pid reused meanwhile is never signalled.
      if (verdict(procOf(run), caller, start) !== 'orphaned') process.exit(0);
      endProcs(runProcs(run, rows, { isSession: isClaudeProcess }), { graceMs: 5000 });
      process.exit(0);
    }
    sleepSync(every);
  }
}
