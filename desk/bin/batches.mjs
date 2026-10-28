// A repo's batches: its standing batch, then one named batch per epic in `batches/<name>/` beside its
// queue. An archived batch sits under `batches/.done/` and is not listed. A ticket's key finds the one
// batch that holds it.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as E from './desk-env.mjs';
import { readQueue } from './batch-state.mjs';

// -> [{ name: null | '<epic key>', queue, state }], the standing batch first, then named ones by name.
export function listBatches(slug = E.repoSlug()) {
  const standing = E.batchPaths(slug);
  const dir = join(dirname(standing.queue), E.BATCHES_DIR);
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && E.SAFE_ID.test(d.name) && existsSync(join(dir, d.name, 'queue.json')))
      .map((d) => d.name)
      .sort();
  } catch { /* no named batches */ }
  return [{ name: null, ...standing }, ...names.map((name) => ({ name, ...E.batchPaths(slug, name) }))];
}

// The batch whose queue holds `key`: its entry from listBatches, or null when none does. A key in two
// batches is a broken invariant, and refused naming both rather than picking one.
export function batchHolding(key, slug = E.repoSlug()) {
  const holding = listBatches(slug).filter((b) => existsSync(b.queue) && readQueue(b.queue).tickets?.[key]);
  if (holding.length > 1) {
    throw new E.DeskConfigError(`desk: ${key} is in more than one batch (${holding.map(label).join(', ')}). A ticket belongs to one batch; remove it from the others.`);
  }
  return holding[0] ?? null;
}

export const label = (b) => b.name ?? 'the standing batch';

// A batch is finished once every ticket in its queue is done. Nothing archives a finished batch, so its
// queue stays listed, and must not keep its keys or its epic's children out of every other batch. A queue
// with no tickets is a session's between `queue.mjs init` and its plan: not finished.
const finished = (q) => { const rows = Object.values(q.tickets ?? {}); return rows.length > 0 && rows.every((t) => t.state === 'done'); };
const peek = (b) => { try { return { q: readQueue(b.queue) }; } catch (e) { return { unreadable: e.message }; } };
const where = (b) => (b.name ? `batch ${b.name}` : 'the standing batch');

// Whether the named batch `name` is listed, readable and not finished.
export function liveBatch(name) {
  let b;
  try { b = listBatches().find((x) => x.name === name); } catch { return false; }
  const { q } = b ? peek(b) : {};
  return !!q && !finished(q);
}

// Why `key` may not join the batch whose queue is `own`, or null: another batch holds it and has not
// finished it, or its triage record `rec` names an epic whose feature batch is live. -> {batch, why},
// with `unreadable` set when another batch's queue cannot be read, so the key cannot be checked. Never
// throws: callers check one key of many. Outside a repo there are no batches to list.
export function belongsElsewhere(key, rec = null, own = E.queueFile()) {
  let others;
  try { others = listBatches().filter((b) => resolve(b.queue) !== resolve(own) && existsSync(b.queue)); } catch { return null; }
  const read = others.map((b) => ({ b, ...peek(b) }));
  const bad = read.find((x) => x.unreadable);
  if (bad) return { batch: label(bad.b), unreadable: true, why: `${key} cannot be checked against ${where(bad.b)}, whose queue cannot be read (${bad.unreadable})` };
  const held = read.find((x) => x.q.tickets?.[key] && x.q.tickets[key].state !== 'done');
  if (held) return { batch: label(held.b), why: `${key} is in ${where(held.b)}: a ticket is in one batch at most` };
  const epic = rec?.epic?.key;
  const feature = epic && read.find((x) => x.b.name === epic && !finished(x.q));
  if (feature) return { batch: epic, why: `${key} is a child of epic ${epic}, whose feature batch ${epic} is running: it joins that batch, never another` };
  return null;
}
