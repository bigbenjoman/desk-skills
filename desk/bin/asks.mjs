// What a session handed the person to do, in its own words (needs-you.mjs ask): one file per repo, in
// its standing batch's state folder, so needs-you lists each one and desk-q counts it until the person
// says done, whether or not the repo has a batch.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lock, unlock, writeJsonAtomic } from './dir-lock.mjs';

const asksPath = (stateDir) => join(stateDir, 'asks.json');

// The file's asks, [] when there is none. An unreadable file reads as none here; changing it refuses.
export function readAsks(stateDir) {
  try { return JSON.parse(readFileSync(asksPath(stateDir), 'utf8')).asks ?? []; } catch { return []; }
}

// Reads, changes and writes the file under its lock. `change(file)` mutates { next, asks } and returns
// the result.
function update(stateDir, change) {
  const file = asksPath(stateDir), held = `${file}.lock`;
  lock(held);
  try {
    let f = { next: 1, asks: [] };
    if (existsSync(file)) {
      try { f = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} cannot be read (${e.message}); fix or remove it first`); }
    }
    const out = change(f);
    writeJsonAtomic(file, f);
    return out;
  } finally { unlock(held); }
}

// Adds `text`, or finds it already there: { id, added }. Ids never repeat, so a put-off one stays its own.
export function addAsk(stateDir, text, now = Date.now()) {
  return update(stateDir, (f) => {
    const same = f.asks.find((a) => a.text === text);
    if (same) return { id: same.id, added: false };
    const id = f.next ?? Math.max(0, ...f.asks.map((a) => a.id)) + 1;
    f.asks.push({ id, text, at: new Date(now).toISOString() });
    f.next = id + 1;
    return { id, added: true };
  });
}

// Removes ask `id`; whether it was there.
export function removeAsk(stateDir, id) {
  return update(stateDir, (f) => {
    const n = f.asks.length;
    f.asks = f.asks.filter((a) => a.id !== id);
    return f.asks.length < n;
  });
}
