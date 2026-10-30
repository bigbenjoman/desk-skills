// A repo's batches: its standing batch, then one named batch per epic in `batches/<name>/` beside its
// queue. An archived batch sits under `batches/.done/` and is not listed. A ticket's key finds the one
// batch that holds it.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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

// Whether the environment already pins one batch: a batch named (--batch, DESK_BATCH), or an explicit
// queue or state path.
export const batchPinned = (env = process.env) => Boolean(env.DESK_BATCH || env.DESK_QUEUE || env.DESK_AUTOPILOT_STATE);

// Points a command about one ticket, and every child it starts, at the batch holding `key` by setting
// DESK_BATCH. A batch already pinned wins, and the key is not looked up. A key in the standing batch
// or in none changes nothing, and a key in two batches throws, naming both, before the command writes
// anything. -> the batch name, or null.
export function useTicketBatch(key, env = process.env) {
  if (!key || batchPinned(env)) return null;
  let slug;
  try { slug = E.repoSlug(); } catch { return null; /* outside a repo there are no batches */ }
  const b = batchHolding(key, slug);
  if (!b?.name) return null;
  env.DESK_BATCH = b.name;
  return b.name;
}

// A PR whose state cannot be read counts as open. A merged or closed one stays so, and is not asked again.
const shut = new Set();
export function prOpen(n) {
  if (shut.has(String(n))) return false;
  let repo;
  try { repo = E.ghRepo(); } catch { return true; }
  const r = spawnSync('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'state', '--jq', '.state'], { encoding: 'utf8' });
  const open = !(r.status === 0 && ['MERGED', 'CLOSED'].includes(r.stdout.trim()));
  if (!open) shut.add(String(n));
  return open;
}
// Finished: every ticket done with no PR still open. A failed ticket waits on the person, a queue with no
// tickets is a session's between `queue.mjs init` and its plan, and a batch on a base still has its gate
// and promotion to come: none of those is finished. Only a batch on a base is archived (batch.mjs), so a
// finished batch's queue stays listed, and must not keep its keys or its epic's children out of every
// other batch.
export function finished(q) {
  const rows = Object.values(q.tickets ?? {});
  return !q.base && rows.length > 0 && rows.every((t) => t.state === 'done') && !rows.some((t) => t.result?.pr != null && prOpen(t.result.pr));
}
const peek = (b) => { try { return { q: readQueue(b.queue) }; } catch (e) { return { unreadable: e.message }; } };
const where = (b) => (b.name ? `batch ${b.name}` : 'the standing batch');

// Whether the named batch `name` is listed, readable and not finished.
export function liveBatch(name) {
  let b;
  try { b = listBatches().find((x) => x.name === name); } catch { return false; }
  const { q } = b ? peek(b) : {};
  return !!q && !finished(q);
}

// Why `key` may not join the batch whose queue is `own`, or null: another unfinished batch holds it, or
// its triage record `rec` names an epic whose feature batch is unfinished. -> {batch, why},
// with `unreadable` set when another batch's queue cannot be read, so the key cannot be checked. Never
// throws: callers check one key of many. Outside a repo there are no batches to list.
export function belongsElsewhere(key, rec = null, own = E.queueFile()) {
  let others;
  try { others = listBatches().filter((b) => resolve(b.queue) !== resolve(own) && existsSync(b.queue)); } catch { return null; }
  const read = others.map((b) => ({ b, ...peek(b) }));
  const bad = read.find((x) => x.unreadable);
  if (bad) return { batch: label(bad.b), unreadable: true, why: `${key} cannot be checked against ${where(bad.b)}, whose queue cannot be read (${bad.unreadable})` };
  const live = read.filter((x) => !finished(x.q));
  const held = live.find((x) => x.q.tickets?.[key]);
  if (held) return { batch: label(held.b), why: `${key} is in ${where(held.b)}: a ticket is in one batch at most` };
  const epic = rec?.epic?.key;
  const feature = epic && live.find((x) => x.b.name === epic);
  if (feature) return { batch: epic, why: `${key} is a child of epic ${epic}, whose feature batch ${epic} is running: it joins that batch, never another` };
  return null;
}
