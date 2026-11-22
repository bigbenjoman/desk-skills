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
import { STATES, FINISHED, PARK_KINDS } from './queue-states.mjs';
import { parkKindOf } from './batch-state.mjs';

export { STATES, FINISHED };

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

// A new park, with its kind (`kind` where the writer names one, else the one its question opens as) and
// its failure class (failure-class.mjs parkClass) whether or not the lever is on.
export const newPark = (question, since = new Date().toISOString(), kind = null) => ({ question, since,
  kind: PARK_KINDS.includes(kind) ? kind : parkKindOf(question), ...parkClass(question) });

// `park <KEY> [--kind <kind>] <question…>`'s arguments after the key: { question, kind }. A kind that is
// not one of PARK_KINDS is refused.
export function parkArgs(args) {
  const at = args.indexOf('--kind');
  if (at < 0) return { question: args.join(' '), kind: null };
  const kind = args[at + 1];
  if (!PARK_KINDS.includes(kind)) throw new Error(`bad park kind "${kind ?? ''}" (want: ${PARK_KINDS.join('|')})`);
  return { question: args.filter((_, i) => i !== at && i !== at + 1).join(' '), kind };
}

// pass.mjs spawns eligible tickets in `.tickets` key order. A ticket's place in that order is its
// position among the unfinished tickets; done and failed ones keep their slots and are never counted.
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

// The writer for queue `file`, read now. `waitMs` is how long a flush waits for the queue lock. The
// ticket ledger names the pass as the writer of its writes.
//   view()       the queue as it stands: the file now, with this writer's changes not yet written on top
//   apply(args)  one queue.mjs command, in memory: { ok, out } | { ok: false, why } | { direct: true }
//                for one it does not apply here (any other command, the batch base, a claim, or a
//                ticket not live in this queue), which the caller runs as queue.mjs
//   apply(['set', key, …], { when })  that set, only while `when(ticket)` holds, now and when written;
//                { ok: true, skipped: true } when it does not hold now
//   flush({ archive })  writes every change applied since the last flush, under the queue lock, and
//                with `archive` (a pass's last write, once it has handled every ticket) moves done
//                tickets whose PR merged or closed to the archive:
//                { ok: true, wrote, version, conflicts, skipped, archived, archiveError, ops, ledgerMissed },
//                `skipped` naming the tickets whose conditional set no longer held, `ledgerMissed` why
//                the ledger lever's append for the write was missed (else null), or, when the lock
//                is not taken within its wait, { ok: false, why, lost } with nothing written
export function queueWriter(file, { waitMs = LOCK_WAIT_MS } = {}) {
  // The file's text as last read or written, so an unchanged file costs one read and no parse.
  let baseText = readFileSync(file, 'utf8');
  let base = JSON.parse(baseText);
  let mine = structuredClone(base);
  let ops = [];
  let conflicts = [];
  // The `set`s applied on a condition, { key, fields, when }, checked again under the lock at flush.
  let guards = [];

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

  function apply(args, { when } = {}) {
    const [cmd, ...rest] = args;
    if (when) return applyIf(args, when);
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
      else if (cmd === 'park') { const p = parkArgs(more); t.state = 'parked'; t.park = newPark(p.question, undefined, p.kind); out = `${key} parked`; }
      else out = `${key} ${toFront(mine, key)}`;
    } catch (e) { return { ok: false, why: e.message }; }
    ops.push(args);
    return { ok: true, out };
  }

  // A `set` made only while `when(ticket)` holds: now, and again under the lock when it is written. A
  // ticket it no longer holds for, or not live in this queue, is left as it is: { ok, skipped: true }.
  function applyIf(args, when) {
    const [cmd, key, ...pairs] = args;
    if (cmd !== 'set') throw new Error(`a condition applies only to set, not ${cmd}`);
    rebase();
    const t = Object.hasOwn(mine.tickets ?? {}, key) ? mine.tickets[key] : null;
    if (!t || !when(t)) return { ok: true, skipped: true, out: `${key}: not written, it changed since it was read` };
    try { applySet(t, pairs); } catch (e) { return { ok: false, why: e.message }; }
    ops.push(args);
    guards.push({ key, fields: pairs.map((p) => p.split('=')[0].split('.')[0]), when });
    return { ok: true, out: `${key}: ${pairs.join(' ')}` };
  }

  // Under the lock, after the rebase: each conditional `set` whose ticket no longer meets its condition
  // takes back the fields it wrote, as the file has them. -> [{ key, fields }] taken back.
  function undoUnmet() {
    const undone = [];
    for (const g of guards) {
      const t = Object.hasOwn(mine.tickets ?? {}, g.key) ? mine.tickets[g.key] : null;
      if (!t || g.when(t)) continue;
      const disk = base.tickets?.[g.key] ?? {};
      for (const f of g.fields) { if (Object.hasOwn(disk, f)) t[f] = structuredClone(disk[f]); else delete t[f]; }
      undone.push(g);
    }
    return undone;
  }

  // With `archive`, done tickets move to the archive even when nothing else is pending; with neither,
  // nothing is written.
  function flush({ archive = false } = {}) {
    const none = () => ({ ok: true, wrote: false, version: versionOf(base), conflicts: [], skipped: [], archived: [], archiveError: null, ops: [], ledgerMissed: null });
    if (!ops.length && !archive) return none();
    const dir = `${file}.lock`;
    try {
      lock(dir, { waitMs, timeout: (pid) => new Error(`the queue is locked by pid ${pid ?? '? (no pid written yet)'}, which has held it past the ${waitMs / 1000}s wait`) });
    } catch (e) {
      const lost = ops;
      ops = []; conflicts = []; guards = []; mine = structuredClone(base);
      return { ok: false, why: e.message, lost };
    }
    try {
      rebase();
      const skipped = undoUnmet();
      // A field a skipped set took back is not one this writer lost to another.
      const kept = conflicts.filter((c) => !skipped.some((s) => s.key === c.ticket && s.fields.includes(c.field)));
      const out = structuredClone(mine);
      let archived = []; let archiveError = null;
      const live = { ...out.tickets };
      if (archive) { try { archived = archiveDone(file, out); } catch (e) { archiveError = e.message; } }
      if (!ops.length && !archived.length) return { ...none(), archiveError };
      out.version = versionOf(base);
      let ledger = null;
      const version = writeQueueFile(file, out, { by: 'pass', archived: Object.fromEntries(archived.map((k) => [k, live[k]])), onLedger: (l) => { ledger = l; } });
      const r = { ok: true, wrote: true, version, conflicts: kept, skipped: skipped.map((s) => s.key), archived, archiveError, ops, ledgerMissed: ledger?.missed ? ledger.why : null };
      base = out; baseText = readFileSync(file, 'utf8'); mine = structuredClone(out); ops = []; conflicts = []; guards = [];
      return r;
    } finally { unlock(dir); }
  }

  return { view, apply, flush, pending: () => ops.length };
}
