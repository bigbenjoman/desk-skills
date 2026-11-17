// The queue commands that change one ticket's fields or the batch's (set, set-batch, park, front), as
// functions on a queue in memory, and the writer a pass records its changes through.
//
// queue.mjs runs each command against the file, one process and one write per command. A pass makes
// dozens, so it applies them here instead, to its own copy, and writes them in one go (flush): one hold
// of the queue lock, one write, one version number higher than the file it replaces. Changes another
// writer made since the pass read the file stay; where both changed one field, the other writer's
// value stays and the field is named.
import { readFileSync } from 'node:fs';
import { lock, unlock } from './dir-lock.mjs';
import { parkClass } from './failure-class.mjs';
import { versionOf, writeQueueFile, mergeQueue, archiveDone, attachArchive, same } from './queue-store.mjs';

export const STATES = ['queued', 'triaged', 'running', 'parked', 'done', 'failed'];

// Keys a ticket carries under `result`, never at the top: `set <KEY> pr=12` would write a top-level pr
// that release and STUCK never read (they read result.pr), so set refuses it and names the right one.
// A refusal list rather than a list of allowed keys, because pass.mjs writes many fields through set.
const RESULT_KEYS = ['pr'];

export function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (node[part] == null || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

// A value opening with { or [ is JSON: stored as a string, a later `result.pr=…` would replace it with
// an empty object and lose the rest. Invalid JSON is an error rather than that string.
export function coerce(v) {
  if (/^\s*[[{]/.test(v)) {
    try { return JSON.parse(v); } catch (e) { throw new Error(`not valid JSON: ${v} (${e.message})`); }
  }
  return v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v;
}

// A new park, with its failure class (failure-class.mjs parkClass) whether or not the lever is on.
export const newPark = (question, since = new Date().toISOString()) => ({ question, since, ...parkClass(question) });

// pass.mjs spawns eligible tickets in `.tickets` key order. A ticket's place in that order is its
// position among the unfinished tickets; done and failed ones keep their slots and are never counted.
export const FINISHED = ['done', 'failed'];
export const unfinished = (q) => Object.keys(q.tickets).filter((k) => !FINISHED.includes(q.tickets[k].state));
export const position = (q, key) => unfinished(q).indexOf(key) + 1;

// The front of the spawn order, unless the user placed the ticket (queue.mjs move): then it stays
// where they put it, and the returned text says so.
export function toFront(q, key) {
  if (q.tickets[key].placed) return `stays at position ${position(q, key)} of the spawn order, where the user placed it`;
  q.tickets = Object.setPrototypeOf({ [key]: q.tickets[key], ...Object.fromEntries(Object.entries(q.tickets).filter(([k]) => k !== key)) },
    Object.getPrototypeOf(q.tickets));
  return 'moved to the front of the spawn order';
}

const pairsOf = (pairs) => pairs.map((p) => {
  const i = p.indexOf('=');
  if (i < 0) throw new Error(`expected key=value, got: ${p}`);
  return [p.slice(0, i), p.slice(i + 1)];
});

// `set <KEY> k=v …` on ticket `t`: every pair is checked before any is written.
export function applySet(t, pairs, now = new Date().toISOString()) {
  const sets = pairsOf(pairs).map(([k, raw]) => {
    const v = coerce(raw);
    if (k === 'state' && !STATES.includes(v)) throw new Error(`bad state "${v}" (want: ${STATES.join('|')})`);
    if (RESULT_KEYS.includes(k.split('.')[0])) throw new Error(`no ticket carries a top-level "${k}", so nothing would read it: did you mean result.${k}=${raw}? Nothing written.`);
    return [k, v];
  });
  for (const [k, v] of sets) setPath(t, k, v);
  t.updated_at = now;
}

// `set-batch k=v …` on queue `q`. `setBase(q, v)` sets the batch base, which asks origin.
export function applySetBatch(q, pairs, setBase) {
  for (const [k, raw] of pairsOf(pairs)) {
    const v = raw.trim();
    if (k === 'base') { setBase(q, v); continue; }
    setPath(q, k, coerce(v));
  }
  // A count the user set is kept as theirs: the ladder may lower `concurrency` on memory and leaves
  // `concurrency_by` alone, so `concurrency_user` is the number it raises back to.
  if (q.concurrency_by === 'user') {
    if (pairs.some((p) => p.startsWith('concurrency_by=')) || q.concurrency_user == null) q.concurrency_user = q.concurrency;
  } else delete q.concurrency_user;
}

// How long a queue write waits for the lock: 10 seconds; DESK_QUEUE_LOCK_WAIT_MS shortens it for
// tests, and anything but a positive number of milliseconds there is ignored rather than turning the
// wait into forever or nothing.
export const LOCK_WAIT_MS = Number(process.env.DESK_QUEUE_LOCK_WAIT_MS) > 0 ? Number(process.env.DESK_QUEUE_LOCK_WAIT_MS) : 10_000;

// The writer for queue `file`, read now. `waitMs` is how long a flush waits for the queue lock.
//   view()       the queue as it stands: the file now, with this writer's changes not yet written on top
//   apply(args)  one queue.mjs command, in memory: { ok, out } | { ok: false, why } | { direct: true }
//                for one it does not apply here (any other command, the batch base, a claim, or a
//                ticket not live in this queue), which the caller runs as queue.mjs
//   flush({ archive })  writes every change applied since the last flush, under the queue lock, and
//                with `archive` (a pass's last write, once it has handled every ticket) moves done
//                tickets whose PR merged or closed to the archive:
//                { ok: true, wrote, version, conflicts, archived, archiveError, ops }, or, when the lock
//                is not taken within its wait, { ok: false, why, lost } with nothing written
export function queueWriter(file, { waitMs = LOCK_WAIT_MS } = {}) {
  // The file's text as last read or written, so an unchanged file costs one read and no parse.
  let baseText = readFileSync(file, 'utf8');
  let base = JSON.parse(baseText);
  let mine = structuredClone(base);
  let ops = [];
  let conflicts = [];

  // Takes in what other writers have written since: their changes stay, and where one changed a field
  // this writer changed too, theirs stays and the field is named at the next flush.
  function rebase() {
    const text = readFileSync(file, 'utf8');
    if (text === baseText) return;
    const disk = JSON.parse(text);
    baseText = text;
    if (same(disk, base)) { base = disk; return; }
    if (!ops.length) { base = disk; mine = structuredClone(disk); return; }
    const m = mergeQueue(base, mine, disk);
    for (const c of m.conflicts) if (!conflicts.some((x) => x.ticket === c.ticket && x.field === c.field)) conflicts.push(c);
    base = disk;
    mine = m.result;
  }

  const view = () => { rebase(); return attachArchive(structuredClone(mine), file); };

  function apply(args) {
    const [cmd, ...rest] = args;
    if (cmd === 'set-batch') {
      if (rest.some((p) => p.startsWith('base='))) return { direct: true };
      rebase();
      try { applySetBatch(mine, rest, () => {}); } catch (e) { return { ok: false, why: e.message }; }
      ops.push(args);
      return { ok: true, out: `batch: ${rest.join(' ')}` };
    }
    if (!['set', 'park', 'front'].includes(cmd) || (cmd === 'park' && rest.includes('--claimed-by'))) return { direct: true };
    const [key, ...more] = rest;
    rebase();
    if (!key || !Object.hasOwn(mine.tickets ?? {}, key)) return { direct: true };
    const t = mine.tickets[key];
    let out;
    try {
      if (cmd === 'set') { applySet(t, more); out = `${key}: ${more.join(' ')}`; }
      else if (cmd === 'park') { t.state = 'parked'; t.park = newPark(more.join(' ')); out = `${key} parked`; }
      else out = `${key} ${toFront(mine, key)}`;
    } catch (e) { return { ok: false, why: e.message }; }
    ops.push(args);
    return { ok: true, out };
  }

  function flush({ archive = false } = {}) {
    if (!ops.length) return { ok: true, wrote: false, version: versionOf(base), conflicts: [], archived: [], archiveError: null, ops: [] };
    const dir = `${file}.lock`;
    try {
      lock(dir, { waitMs, timeout: (pid) => new Error(`the queue is locked by pid ${pid ?? '? (no pid written yet)'}, which has held it past the ${waitMs / 1000}s wait`) });
    } catch (e) {
      const lost = ops;
      ops = []; conflicts = []; mine = structuredClone(base);
      return { ok: false, why: e.message, lost };
    }
    try {
      rebase();
      const out = structuredClone(mine);
      let archived = []; let archiveError = null;
      if (archive) { try { archived = archiveDone(file, out); } catch (e) { archiveError = e.message; } }
      out.version = versionOf(base);
      const version = writeQueueFile(file, out);
      const r = { ok: true, wrote: true, version, conflicts, archived, archiveError, ops };
      base = out; baseText = readFileSync(file, 'utf8'); mine = structuredClone(out); ops = []; conflicts = [];
      return r;
    } finally { unlock(dir); }
  }

  return { view, apply, flush, pending: () => ops.length };
}
