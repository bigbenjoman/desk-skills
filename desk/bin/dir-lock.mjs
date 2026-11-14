// A lock that is a directory, because creating one is atomic, with its holder's pid inside. Shared by
// the queue (queue.mjs) and the lever log (lever-log.mjs), so a fix to stale detection or the clearing
// race lands once.
//
//   import { takeDirLock, releaseDirLock, withDirLock, lockPid, alive } from './dir-lock.mjs'
//   takeDirLock(dir, { waitMs, pollMs, timeoutError })   -> returns once held, or throws timeoutError(pid)
//   releaseDirLock(dir)                                  -> removes it only while this process holds it
//   withDirLock(dir, fn, opts)                           -> fn()'s result, the lock held around it
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const lockPid = (dir) => { try { return Number(readFileSync(join(dir, 'pid'), 'utf8').trim()) || null; } catch { return null; } };
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A holder that has exited never lets go. One with no pid yet is between its mkdir and its write,
// unless it has sat that way for a minute (with-lock.sh's rule).
function stale(dir) {
  const pid = lockPid(dir);
  try { return pid ? !alive(pid) : Date.now() - statSync(dir).mtimeMs > 60_000; } catch { return false; } // already gone
}

// Clear a stale lock. Writers that all saw the same stale lock must not each remove "the lock", or a
// slower one removes the fresh lock a faster one has just taken. So clearing takes its own lock and
// looks again under it: only a clearer can remove the lock while it exists, so a lock still stale
// under the clearing lock is the one that was seen. A clearing lock older than 5 seconds is a clearer
// that died mid-clear (clearing takes microseconds), and is removed for the next attempt.
function clearStale(dir) {
  const clearing = `${dir}.clearing`;
  try { mkdirSync(clearing); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - statSync(clearing).mtimeMs > 5_000) rmSync(clearing, { recursive: true, force: true }); } catch { /* gone */ }
    return false;
  }
  try { if (stale(dir)) rmSync(dir, { recursive: true, force: true }); }
  finally { rmSync(clearing, { recursive: true, force: true }); }
  return true;
}

const heldError = (dir, waitMs) => (pid) => new Error(`${dir} is held by pid ${pid ?? '? (no pid written yet)'} past the ${waitMs / 1000}s wait`);

export function takeDirLock(dir, { waitMs = 10_000, pollMs = 50, timeoutError = heldError(dir, waitMs) } = {}) {
  mkdirSync(dirname(dir), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), `${process.pid}\n`);
      return;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (stale(dir) && clearStale(dir)) continue; // another writer clearing it: wait like any other holder
    if (Date.now() >= until) throw timeoutError(lockPid(dir));
    sleep(pollMs);
  }
}

export function releaseDirLock(dir) {
  if (lockPid(dir) === process.pid) rmSync(dir, { recursive: true, force: true });
}

export function withDirLock(dir, fn, opts) {
  takeDirLock(dir, opts);
  try { return fn(); }
  finally { releaseDirLock(dir); }
}
