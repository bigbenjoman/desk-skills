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

// Adds `text`, or finds it already there: { id, added, until }. Ids never repeat, so a put-off one stays its own.
// `until`: the tickets the ask waits on, when it is a wait on them (needs-you.mjs ask --until), which
// pruneAsks drops once every one is finished; an ask with none stays until the person says done. Asked
// again with an `until`, that list replaces the one kept; asked again with none, the kept one stands.
// `until` in the result is what is kept, so a caller says what a pass will act on.
export function addAsk(stateDir, text, now = Date.now(), { until = [] } = {}) {
  const keys = [...new Set(until)];
  return update(stateDir, (f) => {
    const same = f.asks.find((a) => a.text === text);
    if (same) {
      if (keys.length) same.until = keys;
      return { id: same.id, added: false, until: same.until ?? [] };
    }
    const id = f.next ?? Math.max(0, ...f.asks.map((a) => a.id)) + 1;
    f.asks.push({ id, text, at: new Date(now).toISOString(), ...(keys.length ? { until: keys } : {}) });
    f.next = id + 1;
    return { id, added: true, until: keys };
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

// Drops each ask recorded as a wait on tickets (its `until`), every one of them `known` to the queue and
// `finished` (merged, or done with no PR): what it waited on has happened, so it waits on nothing. An
// ask with no `until` is a step the person owes whatever the tickets do, and stays until they say done.
//   -> the asks dropped, each { id, text, keys }
// The unlocked read only spares a write when nothing is stale: what is dropped is decided again under
// the lock, so an ask asked again with open tickets meanwhile is kept.
export function pruneAsks(stateDir, { known, finished }) {
  const spent = (a) => Array.isArray(a.until) && a.until.length && a.until.every((k) => known(k) && finished(k));
  if (!readAsks(stateDir).some(spent)) return [];
  return update(stateDir, (f) => {
    const stale = f.asks.filter(spent);
    f.asks = f.asks.filter((a) => !spent(a));
    return stale.map(({ id, text, until }) => ({ id, text, keys: until }));
  });
}
