// A repo's batches: its standing batch, then one named batch per epic in `batches/<name>/` beside its
// queue. An archived batch sits under `batches/.done/` and is not listed. A ticket's key finds the one
// batch that holds it.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as E from './desk-env.mjs';
import { readQueue } from './batch-state.mjs';

// The named batches' folders under a standing batch's queue or state folder `dir`, sorted. A name that
// is not a safe id, `.done` included, is not a batch.
export function namedBatches(dir) {
  try {
    return readdirSync(join(dir, E.BATCHES_DIR), { withFileTypes: true })
      .filter((d) => d.isDirectory() && E.SAFE_ID.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch { return []; /* no named batches */ }
}

// -> [{ name: null | '<epic key>', queue, state }], the standing batch first, then named ones by name.
export function listBatches(slug = E.repoSlug()) {
  const standing = E.batchPaths(slug);
  const dir = dirname(standing.queue);
  const names = namedBatches(dir).filter((n) => existsSync(join(dir, E.BATCHES_DIR, n, 'queue.json')));
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
