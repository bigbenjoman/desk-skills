// Holders of the test or light lock whose worker session has ended: a run that outlived the worker that
// started it holds the lock, and every queued suite and suite-bound spawn behind it, with nobody to
// finish it. The pass names each (orphanHolders), and ends one held past the grace (endOrphan) itself.
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { claudeAncestor, isClaudeProcess } from './leases.mjs';
import { holdersText } from './suite-wait.mjs';
import { endProcs, runProcs } from './worker-stop.mjs';

// How long an orphaned holder has held the lock before the pass ends it, in seconds:
// AUTOPILOT_ORPHAN_GRACE_S, else ten minutes.
export const orphanGraceS = (env = process.env) => (/^\d+$/.test(env.AUTOPILOT_ORPHAN_GRACE_S ?? '') ? Number(env.AUTOPILOT_ORPHAN_GRACE_S) : 600);

// A per-user service manager, which adopts orphans in place of pid 1 where it is a subreaper.
const SUBREAPER = /^(?:\S*\/)?systemd\s+--user(?:\s|$)/;
// A desk script (the pass, a base gate, a spine check): a run under one has an owner that is not a worker.
const DESK_SCRIPT = /(?:^|[\s/])desk\/(?:releases\/[^/\s]+\/)?bin\/\S+\.(?:mjs|sh)(?:\s|$)/;

// The key of the ticket worktree a path is in, under `worktrees`, or null.
// The directory is matched as given and by its real path, as a process's working directory reads.
const worktreeKey = (cwd, worktrees) => {
  if (!cwd || !worktrees) return null;
  let real = worktrees;
  try { real = realpathSync(worktrees); } catch { /* as given */ }
  for (const d of [worktrees, real]) {
    const rel = relative(d, cwd);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('/')[0];
  }
  return null;
};

// Why lock holder `run` ({pid, cwd}, lockHolderRuns) is orphaned, or null while its worker may be alive.
// Never while a Claude session is above it. Orphaned when its parent has gone (it was re-parented to pid
// 1 or a subreaper), or when it works in a ticket worktree under `worktrees` whose ticket in `tickets`
// (the queue's) is not running, with no desk script above it either. `procs` is [{pid, ppid, args}].
export function orphanOf(run, { procs, worktrees, tickets }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const me = byPid.get(run.pid);
  if (!me || claudeAncestor(procs, run.pid) != null) return null;
  const parent = byPid.get(me.ppid);
  if (me.ppid === 1 || SUBREAPER.test(parent?.args ?? '')) return `its parent is gone (re-parented to pid ${me.ppid})`;
  const key = worktreeKey(run.cwd, worktrees);
  const t = key ? tickets?.[key] : null;
  if (!t || t.state === 'running') return null;
  for (let p = parent, seen = new Set(); p && !seen.has(p.pid); p = byPid.get(p.ppid)) {
    seen.add(p.pid);
    if (DESK_SCRIPT.test(p.args)) return null;
  }
  return `its worktree's ticket ${key} is no longer running (${t.state})`;
}

// The orphaned holders among `held` (lockHolderRuns), each with `why` (orphanOf) and `due`: held for at
// least `graceS` seconds. One whose hold time is unknown is never due.
export function orphanHolders(held, { procs, worktrees, tickets, graceS }) {
  if (!procs) return [];
  return held.flatMap((r) => {
    const why = orphanOf(r, { procs, worktrees, tickets });
    return why ? [{ ...r, why, due: r.seconds != null && r.seconds >= graceS }] : [];
  });
}

// What the pass says of orphan `o`: the holder, its age and why, then what it did or will do.
export function orphanLine(o, { graceS, ended = null, dry = false }) {
  const head = `orphaned lock holder ${holdersText([o])} (pid ${o.pid}), ${o.why}`;
  if (!o.due) return `${head}: ended once it has held the lock ${Math.round(graceS / 60)} minutes`;
  if (dry) return `${head} (dry run): would end its process group`;
  if (ended.gone) return `${head}: it had ended, or its pid runs something else now, so nothing was signalled`;
  if (ended.left.length) return `${head}: ended its process group, but pid(s) ${ended.left.join(', ')} are still alive`;
  return `${head}: ended its process group (${ended.ended.length} process(es)), freeing the lock`;
}

// Ends orphan `o`'s processes (worker-stop.mjs runProcs) as `rows` (processRows, read now) give them:
// SIGTERM, then SIGKILL after 5 s. Never the caller or its ancestors, and nothing at all unless `rows`
// still has `o.pid` running `o.args` with no Claude session above it, so a pid that ended or was reused
// since the holders were read is never signalled. -> endProcs's { ended, left }, plus `gone` when it
// signalled nothing for that reason.
export function endOrphan(o, { rows, self = process.pid, end = endProcs } = {}) {
  const now = rows.find((r) => r.pid === o.pid);
  if (!now || now.args !== o.args || claudeAncestor(rows, o.pid) != null) return { ended: [], left: [], gone: true };
  return end(runProcs(o.pid, rows, { self, isSession: isClaudeProcess }), { graceMs: 5000 });
}

// The pass's log of the orphans it ended, one JSON line each.
export const orphanLog = (stateDir) => join(stateDir, 'lock-orphans.jsonl');
export function logOrphan(stateDir, o, ended, at = new Date().toISOString()) {
  const file = orphanLog(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at, pid: o.pid, cwd: o.cwd, args: o.args, seconds: o.seconds, why: o.why, ended: ended.ended, left: ended.left })}\n`);
}
