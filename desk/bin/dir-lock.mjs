// A lock that is a directory holding its holder's pid, shared by queue.mjs and upload-queue.mjs.
// Creating a directory is atomic, so the mkdir that succeeds holds it. A holder that has exited never
// lets go, so its lock is cleared; every lock this process still holds goes when it exits.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const held = new Set();
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const lockPid = (dir) => { try { return Number(readFileSync(join(dir, 'pid'), 'utf8').trim()) || null; } catch { return null; } };
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// One with no pid yet is between its mkdir and its write, unless it has sat that way for a minute
// (with-lock.sh's rule). With maxAgeMs, one older than that is stale whatever its pid, for a lock no
// holder keeps that long, whose dead holder's pid may since belong to another process.
function stale(dir, pidOf = lockPid, unwrittenMs = 60_000, maxAgeMs = 0) {
  const pid = pidOf(dir);
  try {
    const age = Date.now() - statSync(dir).mtimeMs;
    if (maxAgeMs && age > maxAgeMs) return true;
    return pid ? !alive(pid) : age > unwrittenMs;
  } catch { return false; } // already gone
}

// Clear a stale lock. Takers that all saw the same stale lock must not each remove "the lock", or a
// slower one removes the fresh lock a faster one has just taken. So clearing takes its own lock and
// looks again under it: only a clearer can remove the lock while it exists, so a lock still stale
// under the clearing lock is the one that was seen. A clearing lock older than 5 seconds is a clearer
// that died mid-clear (clearing takes microseconds), and is removed for the next attempt.
function clearStale(dir, isStale = () => stale(dir)) {
  const clearing = `${dir}.clearing`;
  try { mkdirSync(clearing); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - statSync(clearing).mtimeMs > 5_000) rmSync(clearing, { recursive: true, force: true }); } catch { /* gone */ }
    return false;
  }
  try { if (isStale()) rmSync(dir, { recursive: true, force: true }); }
  finally { rmSync(clearing, { recursive: true, force: true }); }
  return true;
}

// Takes `dir` without waiting: true once taken, else the holder's pid (null when it has written none
// yet). A stale lock is cleared and taken; one another taker is clearing counts as held. maxAgeMs as
// for stale.
export function tryLock(dir, { maxAgeMs = 0 } = {}) {
  mkdirSync(dirname(dir), { recursive: true });
  const isStale = () => stale(dir, lockPid, 60_000, maxAgeMs);
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), `${process.pid}\n`);
      held.add(dir);
      return true;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!(isStale() && clearStale(dir, isStale))) return lockPid(dir);
  }
}

// Takes `dir`, waiting up to waitMs; past it, throws timeout(pid) (pid null when none is written yet).
export function lock(dir, { waitMs = 10_000, maxAgeMs = 0, timeout = (pid) => new Error(`${dir} is locked by pid ${pid ?? '?'} past the ${waitMs / 1000}s wait`) } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    const got = tryLock(dir, { maxAgeMs });
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

// A lock that is a file of JSON { pid, since, ... }: pass.mjs's orchestrator.lock, which queue.mjs stop
// takes too. Created exclusively, so of two takers only one holds it, and a stale one (a dead holder,
// or unreadable for longer than its write takes) is cleared as a stale directory lock is. -> true once
// taken, else the holder's pid (null while unreadable). Let go on exit while it still names this process.
const heldFiles = new Set();
export const filePid = (file) => { try { return Number(JSON.parse(readFileSync(file, 'utf8')).pid) || null; } catch { return null; } };
export function tryLockFile(file, fields = {}) {
  mkdirSync(dirname(file), { recursive: true });
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString(), ...fields }), { flag: 'wx' });
      heldFiles.add(file);
      return true;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const isStale = () => stale(file, filePid, 5_000);
    if (!(isStale() && clearStale(file, isStale))) return filePid(file);
  }
}
// Lets go of `file`, or with none every file lock this process holds; never one another process holds.
export function unlockFile(file) {
  for (const f of file ? [file] : [...heldFiles]) {
    try { if (filePid(f) === process.pid) rmSync(f, { force: true }); } catch { /* gone */ }
    heldFiles.delete(f);
  }
}
process.on('exit', () => unlockFile());

// Writes `obj` as JSON to `file` through a temporary file and a rename, so a reader that takes no
// lock always sees one whole version.
export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, file); // atomic within the same filesystem
}
