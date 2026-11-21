// One build of a desk-q view asks each outside question once. Inside oneBuild, runOnce answers a
// command it has already run in that build (same program, arguments and added environment) with the
// first run's result, a failure included, rather than starting it again. The memo lasts for that
// build only, so the next build reads git, launchctl and ps afresh. Outside a build every call runs.
import { spawnSync } from 'node:child_process';

let memo = null;

// fn() run inside a build: the one already open, else one of its own.
export const oneBuild = (fn) => (memo ? fn() : newBuild(fn));

// fn() run with a memo of its own, for a read after a change: it starts empty and restores the outer one.
export function newBuild(fn) {
  const outer = memo;
  memo = new Map();
  try { return fn(); } finally { memo = outer; }
}

// spawnSync's result for `bin args`, its output as text. `env` adds to this process's environment.
export function runOnce(bin, args = [], { env = null, maxBuffer } = {}) {
  const run = () => spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env: { ...process.env, ...env } } : {}), ...(maxBuffer ? { maxBuffer } : {}) });
  if (!memo) return run();
  const key = JSON.stringify([bin, args, env]);
  if (!memo.has(key)) memo.set(key, run());
  return memo.get(key);
}

// stdout trimmed, or null when the command could not start or exited non-zero.
export const outOrNull = (r) => (r.error || r.status !== 0 ? null : String(r.stdout ?? '').trim());
