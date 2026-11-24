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
// that the config lacks (drift-asks.mjs), which settleDrift drops; `settles: 'reviewer'` with `login` one
// saying that gate reviewer is down (gate-reviewer.mjs), which settleReviewer drops; asked again for that
// login with other text, it takes that text under its own id.
// `choice` ({ options, recommended, apply_by, never_default }) makes it a choice between `options` (each
// one word), its `recommended` one applied by itself at `apply_by` unless `never_default` says why it
// never is (ask-defaults.mjs; a pass answers it once due, dueAsks); asked again with one, that choice replaces the one kept.
export function addAsk(stateDir, text, now = Date.now(), { until = [], settles = null, rows = null, login = null, choice = null } = {}) {
  const keys = [...new Set(until)];
  const pick = choice?.options?.length >= 2 ? Object.fromEntries(Object.entries({ options: [...choice.options], recommended: choice.recommended ?? null,
    apply_by: choice.apply_by ?? null, never_default: choice.never_default ?? null }).filter(([, v]) => v != null)) : null;
  return update(stateDir, (f) => {
    const same = f.asks.find((a) => a.text === text);
    if (same) {
      if (keys.length) same.until = keys;
      if (keys.length && settles) same.settles = settles;
      if (pick) { for (const k of ['options', 'recommended', 'apply_by', 'never_default']) delete same[k]; Object.assign(same, pick); }
      return { id: same.id, added: false, until: same.until ?? [], ask: { ...same } };
    }
    // A reviewer's ask kept up to date takes the new text and keeps its id, so a not-now on it holds.
    const kept = settles === 'reviewer' && login ? f.asks.find((a) => a.settles === 'reviewer' && a.login === login) : null;
    if (kept) { kept.text = text; return { id: kept.id, added: false, until: [], ask: { ...kept } }; }
    const id = f.next ?? Math.max(0, ...f.asks.map((a) => a.id)) + 1;
    const drift = settles === 'drift' && rows?.length ? { settles, rows: [...rows] } : settles === 'reviewer' && login ? { settles, login } : null;
    const a = { id, text, at: new Date(now).toISOString(), ...(keys.length ? { until: keys, ...(settles ? { settles } : {}) } : drift ?? {}), ...(pick ?? {}) };
    f.asks.push(a);
    f.next = id + 1;
    return { id, added: true, until: keys, ask: { ...a } };
  });
}

// Records ask `id` answered with `chose` (one of its options) `by` the person or by default, and takes it
// off the list. The answer is kept in the file's `answered` (the last ANSWERS_KEPT), so the session that
// asked reads it (needs-you.mjs ask-status). `due`: only where it is still unanswered and due at `now`,
// decided under the lock. -> the ask as answered, or null where it is not there (or not due)
const ANSWERS_KEPT = 50;
export function answerAsk(stateDir, id, { chose, by = 'person', at = Date.now(), due = false } = {}) {
  return update(stateDir, (f) => {
    const a = f.asks.find((x) => x.id === id);
    if (!a || (due && !isDue(a, at))) return null;
    f.asks = f.asks.filter((x) => x.id !== id);
    // One applied by default is `logged: false` until its decision is in the log (markLogged), so a pass
    // whose log write failed retries it (unlogged).
    const answered = { ...a, chose, by, answered_at: new Date(at).toISOString(), ...(by === 'default' ? { logged: false } : {}) };
    // The last ANSWERS_KEPT are kept, and every default not yet logged besides, so none is lost unlogged.
    const all = [...(f.answered ?? []), answered];
    const kept = new Set(all.filter((x) => x.logged !== false).slice(-ANSWERS_KEPT));
    f.answered = all.filter((x) => x.logged === false || kept.has(x));
    return answered;
  });
}
// Whether ask `a` applies its recommendation by itself at `now`.
export const isDue = (a, now = Date.now()) => !!a.recommended && !a.never_default && !!a.apply_by && Date.parse(a.apply_by) <= now;
// The asks due at `now`.
export const dueAsks = (stateDir, now = Date.now()) => readAsks(stateDir).filter((a) => isDue(a, now));
// An answered ask, by id, or null.
export function answerOf(stateDir, id) {
  try { return (JSON.parse(readFileSync(asksPath(stateDir), 'utf8')).answered ?? []).filter((a) => a.id === id).at(-1) ?? null; } catch { return null; }
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

// Drops each gate-reviewer-down ask (`settles: 'reviewer'`, its `login`) `gone(ask)` holds for.
//   -> the asks dropped, each { id, text, keys }
export const settleReviewer = (stateDir, gone) => dropAsks(stateDir, (a) => a.settles === 'reviewer' && gone(a));

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

// The asks applied by default whose decision is not yet logged.
export function unlogged(stateDir) {
  try { return (JSON.parse(readFileSync(asksPath(stateDir), 'utf8')).answered ?? []).filter((a) => a.logged === false); } catch { return []; }
}
// Marks the default answer to ask `id` logged.
export function markLogged(stateDir, id) {
  update(stateDir, (f) => { for (const a of f.answered ?? []) if (a.id === id && a.logged === false) a.logged = true; });
}
