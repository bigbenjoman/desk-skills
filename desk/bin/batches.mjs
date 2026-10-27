// A repo's batches: its standing batch, then one named batch per epic in `batches/<name>/` beside its
// queue. An archived batch sits under `batches/.done/` and is not listed. A ticket's key finds the one
// batch that holds it.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const [cmd, key] = process.argv.slice(2);
  try {
    if (cmd === 'list') for (const b of listBatches()) console.log(`${b.name ?? '-'}\t${b.queue}\t${b.state}`);
    else if (cmd === 'holding' && key) {
      const b = batchHolding(key);
      if (!b) process.exit(3);
      console.log(b.name ?? '-');
    } else {
      console.error('usage: batches.mjs list | holding <KEY>');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(e instanceof E.DeskConfigError ? 4 : 1);
  }
}
