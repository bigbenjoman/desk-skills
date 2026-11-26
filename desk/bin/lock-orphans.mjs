// Test and light lock holders whose caller is gone: what the pass names and reclaims (pass.mjs), and
// what with-lock.sh's caller watch (lock-caller-watch.mjs) ends once the run's caller exits. Node's own
// modules only, so the watch each locked run starts stays small.
//
// `rows` everywhere is the process table as [{ pid, ppid, pgid, stat, tty, args }] (readRows below,
// which worker-stop.mjs processRows reads with).
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

// The process the kernel re-parents an orphan to: pid 1, or a Linux user manager acting as subreaper.
const INIT = /^(?:\S*\/)?(?:launchd|init|systemd)(?:\s|$)/;
// A shell running a command string (`zsh -c …`, how a tool call or a hook starts a command) or a login
// shell: it stands for whoever started it, so the caller a run answers to is above it.
const SHELL_C = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-[A-Za-z]*c(?:\s|$)/;
const LOGIN = /^-\S*sh(?:\s|$)/;
export const passThrough = (args) => SHELL_C.test(String(args ?? '')) || LOGIN.test(String(args ?? ''));
const isInit = (r) => r.pid === 1 || INIT.test(r.args);
// A node process, or a script desk runs from its bin: something that started the run on purpose and
// waits for it (the pass, the merge driver, a base gate).
const DRIVER = /^(?:\S*\/)?node(?:js)?(?:\s|$)|\/desk\/(?:bin|releases\/[^/\s]+\/bin)\//;

// The process table, read once per call: [{ pid, ppid, pgid, stat, tty, args }], zombies left out. `tty`
// is the controlling terminal, null for none. Null when ps cannot be read.
export function readRows() {
  const r = spawnSync('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,tty=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s?(.*)$/.exec(l);
    return m && !m[4].startsWith('Z') ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], tty: /^[?-]+$/.test(m[5]) ? null : m[5], args: m[6] }] : [];
  });
}

// Who process `pid` answers to: its parent and every pass-through shell above it, up to and with the
// first process that is not one (the owner). `owner` is null where that walk reaches init: the run's
// caller has exited and it was re-parented. -> { callers: [pid], owner: row | null } or null when `pid`
// or a parent on the way is not in `rows` (read mid-exit: nothing is judged on it).
export function callersOf(pid, rows) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const callers = [];
  const seen = new Set([pid]);
  for (let p = byPid.get(pid)?.ppid; ; ) {
    const r = byPid.get(p);
    if (p == null || !r || seen.has(p)) return null;
    if (isInit(r)) return { callers, owner: null };
    callers.push(r.pid);
    if (!passThrough(r.args)) return { callers, owner: r };
    seen.add(p);
    p = r.ppid;
  }
}

// The ticket key whose worktree `cwd` is in: the first part of its path under `worktrees`, as given or
// by its real path (a process's working directory reads as the real one), or null.
export function worktreeKey(cwd, worktrees) {
  if (!cwd || !worktrees) return null;
  let real = worktrees;
  try { real = realpathSync(worktrees); } catch { /* as given */ }
  for (const d of new Set([worktrees, real].map((w) => w.replace(/\/+$/, '')))) {
    if (cwd.startsWith(`${d}/`)) return cwd.slice(d.length + 1).split('/')[0] || null;
  }
  return null;
}

// Why lock holder `run` ({ pid, cwd }, suite-wait.mjs lockHolderRuns) is orphaned, or null when it is
// not. `tickets` maps a ticket key to its queue state (any batch of the repo); `claudeAbove(pid)` says
// whether a Claude Code session is above a pid. A holder in the worktree of a running ticket is that
// worker's, alive however long it runs, and never orphaned. Otherwise it is orphaned when
//   - its caller exited and it was re-parented to init (callersOf finds no owner), or
//   - it works in the worktree of a ticket that is not running, with no controlling terminal (a
//     person's run in a terminal has one; a detached worker's has none), no Claude session and no
//     driver (DRIVER) above it: the worker that started it has ended.
export function orphanReason(run, { rows, tickets = new Map(), worktrees = null, claudeAbove = () => false }) {
  const key = worktreeKey(run.cwd, worktrees);
  const state = key ? tickets.get(key) ?? null : null;
  if (state === 'running') return null;
  const up = callersOf(run.pid, rows);
  if (!up) return null;
  const ended = state ? `; its worktree's ticket ${key} is ${state}, not running` : '';
  if (!up.owner) return `its caller exited and it was re-parented to init${ended}`;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  if (!state || byPid.get(run.pid)?.tty || claudeAbove(run.pid)) return null;
  for (let p = byPid.get(run.pid)?.ppid, seen = new Set(); p > 1 && !seen.has(p); p = byPid.get(p)?.ppid) {
    seen.add(p);
    if (DRIVER.test(byPid.get(p)?.args ?? '')) return null;
  }
  return `its worktree's ticket ${key} is ${state}, not running, and no worker session is above it`;
}

// What ending the processes `roots` and every descendant of one ends, from `rows`: { groups, pids }.
// `groups` are the process groups a process in that tree leads (a setsid wrapper, a detached child),
// signalled whole, so a child that outlived its parent still goes with its group; `pids` are the rest.
// Never `self`, its ancestors, or a group any of them is in. With `run` (one of the roots), the walk up
// from `self` stops at it: `self` inside the run (the caller watch, the run's own child) is then ended
// with it, and leaves its group to the run, which is taken whole when every live process in it is in
// the tree (the usual case once a run's caller has gone: the group is the caller's, emptied).
// Used by worker-stop.mjs workerProcs and by endTarget below.
export function treeTarget(roots, rows, self = process.pid, { run = null } = {}) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const above = new Set();
  let p = byPid.get(self);
  for (; p && p.pid !== run && !above.has(p.pid); p = byPid.get(p.ppid)) above.add(p.pid);
  const within = run != null && p?.pid === run;
  const myGroups = new Set([...above].filter((q) => !within || q !== self).map((q) => byPid.get(q)?.pgid));
  const tree = new Set();
  const walk = (q) => {
    if (above.has(q) || tree.has(q)) return;
    tree.add(q);
    for (const c of rows) if (c.ppid === q) walk(c.pid);
  };
  for (const q of roots) if (byPid.has(q)) walk(q);
  const groups = new Set([...tree].map((q) => byPid.get(q)).filter((r) => r.pgid === r.pid && !myGroups.has(r.pgid)).map((r) => r.pgid));
  const own = run != null ? byPid.get(run)?.pgid : null;
  if (own != null && !myGroups.has(own) && rows.every((r) => r.pgid !== own || tree.has(r.pid) || (within && r.pid === self))) groups.add(own);
  return { groups: [...groups], pids: [...tree].filter((q) => !groups.has(byPid.get(q).pgid)) };
}

// What ending run `pid` ends, from `rows`: treeTarget with the run's own group, never `self` or above.
export const endTarget = (pid, rows, self = process.pid) => treeTarget([pid], rows, self, { run: pid });

// Whether path `p` is directory `dir` or inside it, by `dir` as given or by its real path.
function inside(dir, p) {
  if (!dir || !p) return false;
  let real = dir;
  try { real = realpathSync(dir); } catch { /* as given */ }
  return [dir, real].some((d) => p === d || p.startsWith(`${d.replace(/\/+$/, '')}/`));
}

// One pass over the lock holders `held` (suite-wait.mjs lockHolderRuns): each orphaned one (orphanReason)
// is named with its age and why (`text(run)` gives where it runs, what, and for how long), and one
// working in `main` or `worktrees` that passes have found orphaned for `graceMs` is ended with `end`
// (endTarget's { groups, pids } -> { left }) where `reclaim` is `yes`, or said to be with `dry`.
// `seen` and the result's `seen` are orphanActs'. -> { seen, lines }
export function reclaimOrphans({ held, rows, tickets, main, worktrees, reclaim, seen = {}, now = Date.now(), graceMs, dry = false, claudeAbove, text, end }) {
  const orphans = held.flatMap((run) => {
    const reason = orphanReason(run, { rows, tickets, worktrees, claudeAbove });
    return reason ? [{ run, reason, ours: inside(main, run.cwd) || inside(worktrees, run.cwd) }] : [];
  });
  const { seen: next, acts } = orphanActs({ orphans, seen, now, graceMs, reclaim });
  const lines = acts.map((a) => {
    const who = `orphaned lock holder pid ${a.run.pid} (${text(a.run)}): ${a.reason}`;
    if (a.act === 'not-ours') return `${who}; it works outside this repo, so its own repo's pass ends it`;
    if (a.act === 'not-granted') return `${who}; left running, as config §3 autopilot-reclaim is ${reclaim ?? 'unset'}: end its process group to free the lock`;
    if (a.act === 'grace') return `${who}; ended once it has been orphaned ${graceMs / 60000}m, in about ${Math.ceil(a.left / 60000)}m`;
    if (dry) return `${who}; would end it and its process group (dry run)`;
    // A failure ending one (ps unreadable mid-kill) is named and the orphan kept at its first sighting,
    // so the next pass ends it again and the rest are still judged this pass.
    let r;
    try { r = end(endTarget(a.run.pid, rows)); } catch (e) {
      return `${who}; ending it failed (${String(e?.message ?? e).split('\n')[0]}), so the next pass tries again`;
    }
    delete next[orphanKey(a.run)];
    return `${who}; ended it and its process group under config §3 autopilot-reclaim, freeing its lock${r?.left?.length ? `, though pid(s) ${r.left.join(', ')} outlived SIGKILL` : ''}`;
  });
  return { seen: next, lines };
}

// The pass's ruling on each orphaned holder this pass, from `orphans` ([{ run, reason, ours }], `ours`
// when it works in this repo's checkout or worktrees), `seen` (each orphan's key -> when a pass first
// found it orphaned, ms), `now`, `graceMs` and `reclaim` (config §3 autopilot-reclaim). -> { seen, acts }:
// the orphans still seen, each kept at its first sighting, and per orphan { run, reason, act, left }
// where act is 'end' (past the grace, ours, reclaim yes), 'grace' (ms `left` until it is), 'not-ours'
// or 'not-granted'.
export const orphanKey = (run) => `${run.pid} ${run.args}`;
export function orphanActs({ orphans, seen = {}, now = Date.now(), graceMs, reclaim }) {
  const next = {};
  const acts = orphans.map(({ run, reason, ours }) => {
    const k = orphanKey(run);
    const first = Number.isFinite(seen[k]) ? seen[k] : now;
    next[k] = first;
    if (!ours) return { run, reason, act: 'not-ours' };
    if (reclaim !== 'yes') return { run, reason, act: 'not-granted' };
    const left = first + graceMs - now;
    return left > 0 ? { run, reason, act: 'grace', left } : { run, reason, act: 'end' };
  });
  return { seen: next, acts };
}
