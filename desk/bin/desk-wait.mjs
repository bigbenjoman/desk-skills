#!/usr/bin/env node
// Wait on one background run (a suite, a typecheck, a lint) in a single blocking call, in place of a
// worker polling ps, tail and TaskStop turn after turn. The Bash tool moves any call over its timeout
// to the background; this is the call the worker makes next, with the Bash tool's timeout at 600000.
//
//   desk-wait.mjs <task output file | pid> [--max <seconds>]
//
// The run is named by the output file the Bash tool printed ("Output is being written to: <file>"),
// resolved to the processes holding it open (lsof, else /proc, as hooks/desk-worker-stop.py reads it),
// or by a pid. It is the same run while those processes are: a pid counts only while its start time is
// the one it had when the wait began. It blocks up to --max seconds (540, at most 570) and prints one of
//
//   done <rc>                 the run has ended; then the output's last 30 lines. <rc> is `?`: a run
//                             that is not this script's child leaves it no exit status, so read it in
//                             the task's completion notice or the tail
//   started <pid>             the command is running (it holds its lock slot, or takes none); call again
//   waiting (<holder>) <min>  with-lock.sh has not started it for <min> minutes; call again
//
// At 20 minutes waiting (DS-587's threshold) it stops the queued run itself, its with-lock.sh and that
// wrapper's flock, sleep or lease child and nothing else, and prints after the waiting line the line
// the worker records:
//
//   not run locally: test lock busy (<holder>); CI's required tests cover it
//
// It never detaches or re-parents anything: the run stays a child of the worker's session, so the
// session ending kills it as before and no lock slot outlives the worker.
// Exits 0 with one of those, 2 on a usage error or a run it cannot read.
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { psRows } from './desk-env.mjs';
import { etimeSeconds, holdersText, lockHolderRuns, lockHolderStamps, lockHolders, processCwds } from './suite-wait.mjs';

export const MAX_DEFAULT = 540;
export const MAX_CEILING = 570;
export const SKIP_AFTER = 20 * 60;
export const TAIL_LINES = 30;
export const recordLine = (holder) => `not run locally: test lock busy (${holder}); CI's required tests cover it`;

// with-lock.sh itself, by its first words (suite-wait.mjs's WRAPPER, any lock that queues).
const WRAPPER = /^(?:\S*\/)?(?:(?:ba|z)?sh\s+)?(?:\S*\/)?with-lock\.sh\s+(?:test|tsc|light|browser)(?:\s|$)/;
// What with-lock.sh runs while it waits for a slot, besides itself: the lock, the pause between rounds,
// the lease broker and config reads, and the file and git steps it takes on the way.
const HELPER = /^(?:\S*\/)?(?:flock|sleep|cat|mkdir|find|mv|rm|git|dirname|pwd|lsof)(?:\s|$)/;
const NODE_HELPER = /^(?:\S*\/)?node\s+\S*(?:slot-lease|desk-env)\.mjs(?:\s|$)/;

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
// 'started' with the topmost one that is not a waiter (the command); else 'waiting' with how long its
// oldest with-lock.sh has waited (seconds) and the wrappers to stop.
export function standing(run) {
  if (!run.length) return { state: 'done' };
  const pids = new Set(run.map((p) => p.pid));
  const cmd = run.filter((p) => !isWaiter(p.args));
  if (cmd.length) {
    const top = cmd.find((p) => !cmd.some((q) => q.pid === p.ppid)) ?? cmd[0];
    return { state: 'started', pid: top.pid };
  }
  const wrappers = run.filter((p) => WRAPPER.test(p.args));
  const seconds = Math.max(0, ...run.filter((p) => /with-lock\.sh/.test(p.args)).map((p) => etimeSeconds(p.etime) ?? 0));
  const light = wrappers.some((p) => /with-lock\.sh\s+light(?:\s|$)/.test(p.args));
  return { state: 'waiting', seconds, wrappers: wrappers.map((p) => p.pid), pids: [...pids], light };
}

// The pids holding a file open: lsof, else /proc. Null when neither can be read.
export function fileHolders(path) {
  const r = spawnSync('lsof', ['-t', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

// This script and its ancestors (the shell the Bash tool started, the session): never part of the run.
function ancestors(procs) {
  const out = new Set();
  for (let pid = process.pid; pid && !out.has(pid);) {
    out.add(pid);
    pid = procs.find((p) => p.pid === pid)?.ppid;
  }
  return out;
}

const startOf = (p, now) => now - (etimeSeconds(p.etime) ?? 0) * 1000;

// Who holds the lock the run waits on, as with-lock.sh names them: the test lock's holders, or the light
// lock's where the run waits on that (a repo whose §4 Suite weight is light).
function holderNow(light) {
  const dir = process.env.DESK_LOCK_DIR || '/tmp';
  const locks = light ? 'light' : 'test';
  try {
    const procs = psRows('pid=,ppid=,args=');
    const ages = new Map(psRows('pid=,etime=').map((p) => [p.pid, etimeSeconds(p.etime)]));
    const runs = lockHolderRuns({ procs, holders: lockHolders(dir, { locks }), cwds: processCwds(), ages, stamps: lockHolderStamps(dir, { locks }), locks });
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
  if (a.file && !existsSync(a.file)) { err(`desk-wait: no such output file: ${a.file}`); return 2; }
  const poll = Number(process.env.DESK_WAIT_POLL_MS) || 2000;
  const skipAfter = Number(process.env.DESK_WAIT_SKIP_AFTER) || SKIP_AFTER;
  const deadline = Date.now() + a.max * 1000;
  let started = null; // a pid's start (ms), so a reused pid is not the run
  let last = null;
  for (;;) {
    let procs;
    // A zombie (state Z) has exited and only waits for its parent to reap it: it is not the run.
    try { procs = psRows('pid=,ppid=,stat=,etime=,args=').filter((p) => !/^Z/.test(p.stat)); } catch (e) { err(`desk-wait: ${e.message}`); return 2; }
    const now = Date.now();
    let roots;
    if (a.pid != null) {
      const me = procs.find((p) => p.pid === a.pid);
      if (me && started == null) started = startOf(me, now);
      roots = me && Math.abs(startOf(me, now) - started) <= 2000 ? [a.pid] : [];
    } else {
      roots = fileHolders(a.file);
      if (roots == null) { err('desk-wait: neither lsof nor /proc can say which processes hold the output file'); return 2; }
    }
    const mine = ancestors(procs);
    const tree = treeOf(roots.filter((p) => !mine.has(p)), procs);
    last = standing(procs.filter((p) => tree.has(p.pid) && !mine.has(p.pid)));
    if (last.state === 'done') {
      out('done ?');
      if (a.file) { const t = tail(a.file); if (t) out(t); }
      return 0;
    }
    if (last.state === 'waiting' && last.seconds >= skipAfter) {
      const holder = holderNow(last.light);
      const stop = treeOf(last.wrappers, procs);
      for (const pid of stop) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      out(`waiting (${holder}) ${Math.floor(last.seconds / 60)}`);
      out(recordLine(holder));
      out(`stopped the queued run (pid ${[...stop].join(', ') || 'none'}): it never started, so nothing it ran is lost`);
      return 0;
    }
    if (Date.now() + poll > deadline) break;
    sleep(poll);
  }
  if (last.state === 'started') out(`started ${last.pid}`);
  else out(`waiting (${holderNow(last.light)}) ${Math.floor(last.seconds / 60)}`);
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exit(main());
