// A lock that is a directory holding its holder's pid, shared by queue.mjs, upload-queue.mjs and the
// lever log (lever-log.mjs), so a fix to stale detection or the clearing race lands once.
// Creating a directory is atomic, so the mkdir that succeeds holds it. A holder that has exited never
// lets go, so its lock is cleared; every lock this process still holds goes when it exits.
//
//   import { tryLock, lock, unlock, takeDirLock, releaseDirLock, withDirLock, lockPid, alive } from './dir-lock.mjs'
//   tryLock(dir)                                         -> true once taken, else the holder's pid (or null)
//   lock(dir, { waitMs, timeout })                       -> returns once held, or throws timeout(pid)
//   unlock(dir?)                                         -> lets go of dir, or of every lock this process holds
//   takeDirLock(dir, { waitMs, pollMs, timeoutError })   -> returns once held, or throws timeoutError(pid)
//   releaseDirLock(dir)                                  -> removes it only while this process holds it
//   withDirLock(dir, fn, opts)                           -> fn()'s result, the lock held around it
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const held = new Set();
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const lockPid = (dir) => { try { return Number(readFileSync(join(dir, 'pid'), 'utf8').trim()) || null; } catch { return null; } };
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// One with no pid yet is between its mkdir and its write, unless it has sat that way for a minute
// (with-lock.sh's rule).
function stale(dir) {
  const pid = lockPid(dir);
  try { return pid ? !alive(pid) : Date.now() - statSync(dir).mtimeMs > 60_000; } catch { return false; } // already gone
}

// Clear a stale lock. Takers that all saw the same stale lock must not each remove "the lock", or a
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

// Takes `dir` without waiting: true once taken, else the holder's pid (null when it has written none
// yet). A stale lock is cleared and taken; one another taker is clearing counts as held.
export function tryLock(dir) {
  mkdirSync(dirname(dir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), `${process.pid}\n`);
      held.add(dir);
      return true;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!(stale(dir) && clearStale(dir))) return lockPid(dir);
  }
}

// Takes `dir`, waiting up to waitMs; past it, throws timeout(pid) (pid null when none is written yet).
export function lock(dir, { waitMs = 10_000, timeout = (pid) => new Error(`${dir} is locked by pid ${pid ?? '?'} past the ${waitMs / 1000}s wait`) } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    const got = tryLock(dir);
    if (got === true) return;
    if (Date.now() >= until) throw timeout(got);
    sleepSync(50);
  }
}

// Lets go of `dir`, or with none every lock this process holds; never one another process holds.
export function unlock(dir) {
  for (const d of dir ? [dir] : [...held].reverse()) {
    if (lockPid(d) === process.pid) rmSync(d, { recursive: true, force: true });
    held.delete(d);
  }
}
process.on('exit', () => unlock());

const heldError = (dir, waitMs) => (pid) => new Error(`${dir} is held by pid ${pid ?? '? (no pid written yet)'} past the ${waitMs / 1000}s wait`);

// The lever log's form of lock(): its own poll interval and timeout error.
export function takeDirLock(dir, { waitMs = 10_000, pollMs = 50, timeoutError = heldError(dir, waitMs) } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    const got = tryLock(dir);
    if (got === true) return;
    if (Date.now() >= until) throw timeoutError(got);
    sleepSync(pollMs);
  }
}

export const releaseDirLock = (dir) => unlock(dir);

export function withDirLock(dir, fn, opts) {
  takeDirLock(dir, opts);
  try { return fn(); }
  finally { releaseDirLock(dir); }
}

// Writes `obj` as JSON to `file` through a temporary file and a rename, so a reader that takes no
// lock always sees one whole version.
export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, file); // atomic within the same filesystem
}
