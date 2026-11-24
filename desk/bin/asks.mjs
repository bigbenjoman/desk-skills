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
// `until` in the result is what is kept, so a caller says what a pass will act on. `settles: 'admit'`
// marks an ask its tickets' admission settles too (intake.mjs admit's ask to start a session), which
// settleAdmitted drops. `settles: 'drift'` with `rows` marks one naming config rows a release added
// that the config lacks (drift-asks.mjs), which settleDrift drops.
export function addAsk(stateDir, text, now = Date.now(), { until = [], settles = null, rows = null } = {}) {
  const keys = [...new Set(until)];
  return update(stateDir, (f) => {
    const same = f.asks.find((a) => a.text === text);
    if (same) {
      if (keys.length) same.until = keys;
      if (keys.length && settles) same.settles = settles;
      return { id: same.id, added: false, until: same.until ?? [] };
    }
    const id = f.next ?? Math.max(0, ...f.asks.map((a) => a.id)) + 1;
    const drift = settles === 'drift' && rows?.length ? { settles, rows: [...rows] } : null;
    f.asks.push({ id, text, at: new Date(now).toISOString(), ...(keys.length ? { until: keys, ...(settles ? { settles } : {}) } : drift ?? {}) });
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
export const pruneAsks = (stateDir, { known, finished }) =>
  dropAsks(stateDir, (a) => Array.isArray(a.until) && a.until.length && a.until.every((k) => known(k) && finished(k)));

// Drops each ask its tickets' admission settles (`settles: 'admit'`) whose every `until` ticket is
// `placed` in a batch now: no session needs starting for them.
//   -> the asks dropped, each { id, text, keys }
export const settleAdmitted = (stateDir, placed) =>
  dropAsks(stateDir, (a) => a.settles === 'admit' && Array.isArray(a.until) && a.until.length && a.until.every((k) => placed(k)));

// Drops each config-drift ask (`settles: 'drift'`) `gone(ask)` holds for.
//   -> the asks dropped, each { id, text, keys } (keys: the rows it named)
export const settleDrift = (stateDir, gone) =>
  dropAsks(stateDir, (a) => a.settles === 'drift' && Array.isArray(a.rows) && gone(a));

// Drops each ask `gone(ask)` holds for. The unlocked read only spares a write when none does: what is
// dropped is decided again under the lock, so an ask asked again meanwhile is judged as it now is.
function dropAsks(stateDir, gone) {
  if (!readAsks(stateDir).some(gone)) return [];
  return update(stateDir, (f) => {
    const out = f.asks.filter(gone);
    f.asks = f.asks.filter((a) => !gone(a));
    return out.map(({ id, text, until, rows }) => ({ id, text, keys: until ?? rows }));
  });
}
