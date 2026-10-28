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

// Why `key` may not join the batch whose queue is `own`, or null: another batch holds it, or its triage
// record `rec` names an epic whose feature batch is live (listed, so not archived). -> {batch, why}.
// Outside a repo there are no batches to list, so nothing is refused.
export function belongsElsewhere(key, rec = null, own = E.queueFile()) {
  let slug;
  try { slug = E.repoSlug(); } catch { return null; }
  const mine = (b) => resolve(b.queue) === resolve(own);
  const held = batchHolding(key, slug);
  if (held && !mine(held)) return { batch: label(held), why: `${key} is in ${held.name ? `batch ${held.name}` : 'the standing batch'}: a ticket is in one batch at most` };
  const epic = rec?.epic?.key;
  const feature = epic && listBatches(slug).find((b) => b.name === epic);
  if (feature && !mine(feature)) return { batch: epic, why: `${key} is a child of epic ${epic}, whose feature batch ${epic} is running: it joins that batch, never another` };
  return null;
}
