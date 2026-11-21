#!/usr/bin/env node
// Wait on one background run (a suite, a typecheck, a lint) in a single blocking call, in place of a
// worker polling ps, tail and TaskStop turn after turn. The Bash tool moves any call over its timeout
// to the background; this is the call the worker makes next, with the Bash tool's timeout at 600000.
//
//   desk-wait.mjs <task output file | pid> [--max <seconds>]
//
// The run is named by the output file the Bash tool printed ("Output is being written to: <file>",
// a `tasks/<id>.output`), resolved to the processes holding it open (lsof, else /proc, as
// hooks/desk-worker-stop.py reads it), or by a pid. Either must belong to this session: a descendant of
// the nearest `claude` process above this script, else of its parent. It is the same run while those
// processes are: a pid counts only while its start time is the one it had when the wait began. It
// blocks up to --max seconds (540, at most 570) and prints one of
//
//   done <rc>                 the run has ended; then the output's last 30 lines. <rc> is `?`: a run
//                             that is not this script's child leaves it no exit status, so read it in
//                             the task's completion notice or the tail
//   started <pid>             the command is running (it holds its lock slot, or takes none); call again
//   waiting (<holder>) <min>  with-lock.sh has not started it for <min> minutes; call again
//
// At 20 minutes waiting on the test or light lock it stops the queued run itself, its with-lock.sh and
// that wrapper's flock, sleep or lease child and nothing else, and prints after the waiting line the
// line the worker records:
//
//   not run locally: test lock busy (<holder>); CI's required tests cover it
//
// A run queued on the browser lock is never stopped: CI does not cover a screenshot.
// It never detaches or re-parents anything: the run stays a child of the worker's session, so the
// session ending kills it as before and no lock slot outlives the worker.
// Exits 0 with one of those, 2 on a usage error or a run it cannot read.
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockDir, psRows } from './desk-env.mjs';
import { etimeSeconds, holdersNow, holdersText, wrapperOf } from './suite-wait.mjs';

export const MAX_DEFAULT = 540;
export const MAX_CEILING = 570;
export const SKIP_AFTER = 20 * 60;
export const TAIL_LINES = 30;
export const recordLine = (holder) => `not run locally: test lock busy (${holder}); CI's required tests cover it`;

// with-lock.sh itself, on a lock a run may be skipped on, and on the browser lock, which it never is.
const WRAPPER = wrapperOf('test|tsc|light');
const BROWSER = wrapperOf('browser');
const LIGHT = wrapperOf('light');
// What with-lock.sh runs while it waits for a slot, besides itself: the lock, the pause between rounds,
// the lease broker and config reads, and the file and git steps it takes on the way.
const HELPER = /^(?:\S*\/)?(?:flock|sleep|cat|mkdir|find|mv|rm|git|dirname|pwd|lsof)(?:\s|$)/;
const NODE_HELPER = /^(?:\S*\/)?node\s+\S*(?:slot-lease|desk-env)\.mjs(?:\s|$)/;
// A Bash tool background task's output file.
const TASK_OUTPUT = /\/tasks\/[^/]+\.output$/;
const CLAUDE = /(?:^|[\s/])claude(?:\s|$)|claude-code\//;

// Whether a process is part of a wait for the lock rather than the command it runs: with-lock.sh, the
// shell the Bash tool started it from (whose command line names it), or one of its helpers.
export const isWaiter = (args) => /with-lock\.sh/.test(args) || HELPER.test(args) || NODE_HELPER.test(args);

// The pids and every descendant of them, in `procs` ([{pid, ppid}]).
export function treeOf(pids, procs) {
  const out = new Set(pids);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (!out.has(p.pid) && out.has(p.ppid)) { out.add(p.pid); grew = true; }
  }
  return out;
}

// Where the run stands, from its processes ([{pid, ppid, etime, args}]): 'done' with none left;
// 'waiting' while a with-lock.sh wrapper and its helpers are all there is, timed from the oldest
// wrapper, with the wrappers to stop and whether it waits on the light or the browser lock; else
// 'started' with the topmost process that is not a waiter (the command), or the topmost of all where
// only the shell is left between steps.
export function standing(run) {
  if (!run.length) return { state: 'done' };
  const top = (ps) => ps.find((p) => !ps.some((q) => q.pid === p.ppid)) ?? ps[0];
  const cmd = run.filter((p) => !isWaiter(p.args));
  if (cmd.length) return { state: 'started', pid: top(cmd).pid };
  const wrappers = run.filter((p) => WRAPPER.test(p.args) || BROWSER.test(p.args));
  if (!wrappers.length) return { state: 'started', pid: top(run).pid };
  const seconds = Math.max(0, ...wrappers.map((p) => etimeSeconds(p.etime) ?? 0));
  return { state: 'waiting', seconds, wrappers: wrappers.map((p) => p.pid), light: wrappers.some((p) => LIGHT.test(p.args)), browser: wrappers.some((p) => BROWSER.test(p.args)) };
}

// The pids holding a file open: lsof, else /proc. Null when neither can be read.
export function fileHolders(path) {
  const r = spawnSync('lsof', ['-w', '-t', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!r.error) {
    const pids = (r.stdout ?? '').split(/\s+/).filter((p) => /^\d+$/.test(p)).map(Number);
    // lsof exits 1 both for "no process" and for an error; an error writes to stderr.
    if (pids.length || (r.status === 1 && !`${r.stderr ?? ''}`.trim())) return pids;
  }
  try {
    const target = realpathSync(path);
    return readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
      try { return readdirSync(`/proc/${d}/fd`).some((fd) => { try { return realpathSync(readlinkSync(`/proc/${d}/fd/${fd}`)) === target; } catch { return false; } }); } catch { return false; }
    }).map(Number);
  } catch { return null; }
}

// This script and its ancestors (the shell the Bash tool started, the session), nearest first.
function ancestors(procs) {
  const out = [];
  for (let pid = process.pid; pid && !out.includes(pid);) {
    out.push(pid);
    pid = procs.find((p) => p.pid === pid)?.ppid;
  }
  return out;
}

// The session's processes: the nearest `claude` above this script and all below it, else its parent's.
export function sessionTree(procs, chain = ancestors(procs)) {
  const root = chain.slice(1).find((pid) => CLAUDE.test(procs.find((p) => p.pid === pid)?.args ?? '')) ?? chain[1];
  return root ? treeOf([root], procs) : new Set();
}

const startOf = (p, now) => now - (etimeSeconds(p.etime) ?? 0) * 1000;

// Who holds the lock the run waits on, as with-lock.sh names them.
function holderNow(w) {
  if (w.browser) return 'browser lock';
  try {
    const runs = holdersNow(lockDir(), w.light ? 'light' : 'test');
    return runs.length ? holdersText(runs) : 'holder unknown';
  } catch { return 'holder unknown'; }
}

function tail(file, n = TAIL_LINES) {
  try { return readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').slice(-n).join('\n'); } catch { return ''; }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function parseArgs(argv) {
  let target = null, max = MAX_DEFAULT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max') {
      max = Number(argv[++i]);
      if (!Number.isInteger(max) || max < 1 || max > MAX_CEILING) return { error: `--max takes whole seconds from 1 to ${MAX_CEILING}, inside the Bash tool's 600 s` };
    } else if (target == null) target = argv[i];
    else return { error: `unexpected argument ${argv[i]}` };
  }
  if (!target) return { error: 'usage: desk-wait.mjs <task output file | pid> [--max <seconds>]' };
  return /^\d+$/.test(target) ? { pid: Number(target), max } : { file: target, max };
}

export function main(argv = process.argv.slice(2), { out = console.log, err = console.error } = {}) {
  const a = parseArgs(argv);
  if (a.error) { err(`desk-wait: ${a.error}`); return 2; }
  if (a.file) {
    let real = null;
    try { real = realpathSync(a.file); } catch { /* missing */ }
    if (!real || !existsSync(real)) { err(`desk-wait: no such output file: ${a.file}`); return 2; }
    if (!TASK_OUTPUT.test(real)) { err(`desk-wait: not a background task's output file (…/tasks/<id>.output): ${a.file}`); return 2; }
    a.file = real;
  }
  const poll = Number(process.env.DESK_WAIT_POLL_MS) || 2000;
  const skipAfter = Number(process.env.DESK_WAIT_SKIP_AFTER) || SKIP_AFTER;
  const deadline = Date.now() + a.max * 1000;
  let started = null; // a pid's start (ms), so a reused pid is not the run
  // The run as it stands now, from a fresh read of the process table; null when ps cannot be read.
  const read = () => {
    let procs;
    // A zombie (state Z) has exited and only waits for its parent to reap it: it is not the run.
    try { procs = psRows('pid=,ppid=,stat=,etime=,args=').filter((p) => !/^Z/.test(p.stat)); } catch (e) { err(`desk-wait: ${e.message}`); return null; }
    const now = Date.now();
    let roots;
    if (a.pid != null) {
      const me = procs.find((p) => p.pid === a.pid);
      if (me && started == null) started = startOf(me, now);
      roots = me && Math.abs(startOf(me, now) - started) <= 2000 ? [a.pid] : [];
    } else {
      roots = fileHolders(a.file);
      if (roots == null) { err('desk-wait: neither lsof nor /proc can say which processes hold the output file'); return null; }
    }
    const chain = ancestors(procs);
    const session = sessionTree(procs, chain);
    const run = treeOf(roots.filter((p) => session.has(p) && !chain.includes(p)), procs);
    if (a.pid != null && roots.length && !session.has(a.pid)) return { foreign: true };
    return { procs, state: standing(procs.filter((p) => run.has(p.pid) && !chain.includes(p.pid))) };
  };
  let last = null;
  for (;;) {
    const now = read();
    if (!now) return 2;
    if (now.foreign) { err(`desk-wait: pid ${a.pid} is not a process of this session`); return 2; }
    last = now.state;
    if (last.state === 'done') {
      out('done ?');
      if (a.file) { const t = tail(a.file); if (t) out(t); }
      return 0;
    }
    if (last.state === 'waiting' && !last.browser && last.seconds >= skipAfter) {
      const holder = holderNow(last);
      // The holder lookup takes a moment, in which the lock may have started the run: read it again,
      // and stop it only while it still waits, on the same wrappers.
      const again = read();
      if (!again) return 2;
      const s = again.state;
      if (s.state === 'waiting' && s.wrappers.join() === last.wrappers.join()) {
        const stop = treeOf(s.wrappers, again.procs);
        for (const pid of stop) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
        out(`waiting (${holder}) ${Math.floor(s.seconds / 60)}`);
        out(recordLine(holder));
        out(`stopped the queued run (pid ${[...stop].join(', ')}): it never started, so nothing it ran is lost`);
        return 0;
      }
      continue;
    }
    if (Date.now() + poll > deadline) break;
    sleep(poll);
  }
  if (last.state === 'started') out(`started ${last.pid}`);
  else out(`waiting (${holderNow(last)}) ${Math.floor(last.seconds / 60)}`);
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exit(main());
