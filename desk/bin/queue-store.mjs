// A queue file's version number, its archive, and the merge of two writers' changes to it.
//
// Every write of a queue file goes through writeQueueFile, which numbers it one past the version it
// replaces. A file written before versions existed has none and reads as version 0.
//
// A done ticket whose PR has merged or closed moves to a sibling archive (queue.json beside
// queue.archive.json), under the queue lock, when a pass records its changes (queue-writer.mjs). A
// queue read still finds an archived ticket by key: attachArchive puts the archived tickets behind the
// live ones as their prototype, so `q.tickets[key]` and `key in q.tickets` find one, while
// Object.keys, Object.values, Object.entries and JSON.stringify see only the live tickets.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeJsonAtomic } from './dir-lock.mjs';
import { followOnPending, postMergeUnmade } from './harvest.mjs';

export const versionOf = (q) => {
  const n = Number(q?.version);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

// Writes queue `q` to `file` as the version after the one it was read as. -> the version written.
export function writeQueueFile(file, q) {
  q.version = versionOf(q) + 1;
  writeJsonAtomic(file, q);
  return q.version;
}

export const archivePath = (file) => join(dirname(file), `${basename(file).replace(/\.json$/, '')}.archive.json`);

// The archive of queue `file` as { tickets }, or { tickets: {} } when there is none. Throws when one
// exists and cannot be read, so a writer never replaces it with only what it adds.
export function readArchive(file) {
  const path = archivePath(file);
  if (!existsSync(path)) return { tickets: {} };
  const a = JSON.parse(readFileSync(path, 'utf8'));
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(`${path} is not an archive`);
  a.tickets = a.tickets && typeof a.tickets === 'object' ? a.tickets : {};
  return a;
}

const ARCHIVED = Symbol('archived');

// Queue `q`, read from `file`, with its archived tickets found by key behind its live ones. The archive
// is read on the first key the live tickets lack; an unreadable one finds nothing.
export function attachArchive(q, file) {
  if (!q || typeof q.tickets !== 'object' || q.tickets === null || Array.isArray(q.tickets)) return q;
  let got = null;
  const archived = () => {
    if (got) return got;
    try { got = readArchive(file).tickets; } catch { got = {}; }
    return got;
  };
  const own = (k) => typeof k === 'string' && Object.hasOwn(archived(), k);
  Object.setPrototypeOf(q.tickets, new Proxy(Object.prototype, {
    get: (target, k, recv) => (!(k in target) && own(k) ? archived()[k] : Reflect.get(target, k, recv)),
    has: (target, k) => k in target || own(k),
  }));
  Object.defineProperty(q, ARCHIVED, { value: archived });
  return q;
}

// The archived tickets behind queue `q`, by key ({} for a queue read without them).
export const archivedOf = (q) => (q?.[ARCHIVED] ? q[ARCHIVED]() : {});
// Whether `key` is archived and not live in queue `q`.
export const isArchived = (q, key) => !!q?.tickets && !Object.hasOwn(q.tickets, key) && Object.hasOwn(archivedOf(q), key);

const HOLD_FIELDS = ['held_by', 'held_outside', 'merge_after'];
const keys = (v) => String(v ?? '').split('|').filter(Boolean);

// Whether ticket `key` of queue `q` moves to the archive: done, with its PR merged (recorded by
// `queue.mjs merged`) or closed, no follow-on steps waiting on the person or owed by the pass, and nothing live still
// pointing at it (another ticket's hold or merge gate, or the batch's own key, spine or epic). A batch
// with a base, an epic or feature mode counts its finished children, so it archives nothing.
export function archivable(q, key) {
  if (q.base || q.epic || q.feature === true) return false;
  const t = q.tickets[key];
  if (t?.state !== 'done' || t.result?.pr == null || followOnPending(t)) return false;
  const closed = Number(t.pr_status?.pr) === Number(t.result.pr) && t.pr_status?.state === 'CLOSED';
  if (!t.merged_at && !closed) return false;
  // A merged PR's criteria its review left for after the merge that the pass has not made follow-on
  // steps yet: an append it skipped is owed to the next pass, so the ticket stays.
  if (!closed && postMergeUnmade(t)) return false;
  if ([q.batch, q.spine, q.epic].includes(key)) return false;
  return !Object.values(q.tickets).some((o) => o?.key !== key && HOLD_FIELDS.some((f) => keys(o?.[f]).includes(key)));
}

// Moves every archivable ticket of `q` (read from `file`, its lock held) into the archive, which is
// written first, so a crash between the two writes leaves a ticket in both, never in neither.
// -> the keys moved. Throws, moving nothing, when the archive cannot be read or written.
export function archiveDone(file, q, now = new Date().toISOString()) {
  const moving = Object.keys(q.tickets ?? {}).filter((k) => archivable(q, k));
  if (!moving.length) return [];
  const a = readArchive(file);
  // A ticket archived before, admitted again and finished, keeps when it was first admitted
  // (first_added_at), so the batch's worker cost still counts that first admission's rounds.
  for (const k of moving) {
    const was = a.tickets[k];
    const first = [was?.first_added_at, was?.added_at, q.tickets[k].first_added_at].filter(Boolean).sort()[0];
    a.tickets[k] = { ...q.tickets[k], ...(first && first !== q.tickets[k].added_at ? { first_added_at: first } : {}), archived_at: now };
  }
  writeJsonAtomic(archivePath(file), a);
  for (const k of moving) delete q.tickets[k];
  return moving;
}

// JSON with object keys sorted, so two reads of one value compare equal whatever order they were written in.
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const same = (a, b) => canon(a) === canon(b);

// Every writer stamps a ticket's updated_at, so two writers both changing it is no conflict: the later wins.
const LATEST = ['updated_at'];

// Lays the fields `mine` changed from `base` onto `out` (a copy of `theirs`), one field at a time. A
// field `theirs` also changed, to another value, keeps theirs and is listed in `conflicts`.
function mergeFields(base, mine, theirs, out, ticket, conflicts) {
  for (const f of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    if (same(base[f], mine[f])) continue;
    if (!same(base[f], theirs[f]) && !same(mine[f], theirs[f])) {
      if (LATEST.includes(f)) { if (String(mine[f] ?? '') > String(theirs[f] ?? '')) out[f] = mine[f]; continue; }
      conflicts.push({ ticket, field: f });
      continue;
    }
    if (mine[f] === undefined) delete out[f]; else out[f] = mine[f];
  }
}

const batchFields = (q) => Object.fromEntries(Object.entries(q ?? {}).filter(([k]) => k !== 'tickets' && k !== 'version'));

// The queue that holds both writers' changes: `theirs` (the file as another writer left it) with what
// `mine` changed since `base` (the file as this writer read it) laid on top, field by field. Where both
// changed one field of a ticket, or of the batch, theirs stays: { ticket (null for the batch), field }
// in `conflicts`. A ticket another writer removed takes none of mine's changes, each listed. The spawn
// order mine set is kept unless theirs reordered too. -> { result, conflicts }. Plain objects only.
export function mergeQueue(base, mine, theirs) {
  const result = structuredClone(theirs);
  result.tickets ??= {};
  const conflicts = [];
  mergeFields(batchFields(base), batchFields(mine), batchFields(theirs), result, null, conflicts);
  const bt = base.tickets ?? {}; const mt = mine.tickets ?? {}; const tt = theirs.tickets ?? {};
  for (const key of new Set([...Object.keys(bt), ...Object.keys(mt)])) {
    const b = bt[key]; const m = mt[key]; const t = tt[key];
    if (same(b, m)) continue;
    if (m === undefined) {
      if (t !== undefined && same(t, b)) delete result.tickets[key];
      else if (t !== undefined) conflicts.push({ ticket: key, field: '*' });
      continue;
    }
    if (b === undefined) {
      if (t === undefined || same(t, m)) result.tickets[key] = m;
      else conflicts.push({ ticket: key, field: '*' });
      continue;
    }
    if (t === undefined) {
      for (const f of new Set([...Object.keys(b), ...Object.keys(m)])) if (!same(b[f], m[f]) && !LATEST.includes(f)) conflicts.push({ ticket: key, field: f, gone: true });
      continue;
    }
    mergeFields(b, m, t, result.tickets[key], key, conflicts);
  }
  const among = (o, set) => Object.keys(o).filter((k) => set.has(k)).join('\n');
  const kept = new Set(Object.keys(bt).filter((k) => k in mt));
  if (among(bt, kept) !== among(mt, kept)) {
    const there = new Set([...kept].filter((k) => k in tt));
    if (among(bt, there) === among(tt, there)) {
      const order = Object.keys(mt).filter((k) => k in result.tickets);
      const rest = Object.keys(result.tickets).filter((k) => !order.includes(k));
      result.tickets = Object.fromEntries([...order, ...rest].map((k) => [k, result.tickets[k]]));
    } else if (among(mt, there) !== among(tt, there)) conflicts.push({ ticket: null, field: 'order' });
  }
  return { result, conflicts };
}
