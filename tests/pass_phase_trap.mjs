// The no-I/O trap a pass phase's unit suite runs its decision under: every process start and file
// write throws and is recorded, so a suite proves its code starts no process, calls no git, gh or
// Jira (each a child process), and writes nothing, the queue included (queue-writer.mjs writes through
// these fs calls). One list for every phase suite, so none proves less than another.
import { createRequire, syncBuiltinESMExports } from 'node:module';

// The built-in modules' own objects: patched, and synced, every ES import of them sees the patch.
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const fs = require('node:fs');
export const PROCESS_CALLS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
export const WRITE_CALLS = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'openSync', 'unlinkSync', 'rmSync', 'writeFile', 'appendFile'];

// Runs fn with the trap set, and restores every call after. -> { out: fn's result, threw: the error's
// stack or null, calls: each trapped name called, in order }
export function withNoIo(fn) {
  const calls = [];
  const trap = (mod, names) => names.filter((n) => typeof mod[n] === 'function').map((n) => {
    const orig = mod[n];
    mod[n] = () => { calls.push(n); throw new Error(`${n} called`); };
    return () => { mod[n] = orig; };
  });
  const undo = [...trap(cp, PROCESS_CALLS), ...trap(fs, WRITE_CALLS)];
  syncBuiltinESMExports();
  let out;
  let threw = null;
  try { out = fn(); } catch (e) { threw = e.stack ?? e.message; } finally {
    for (const u of undo) u();
    syncBuiltinESMExports();
  }
  return { out, threw, calls };
}
