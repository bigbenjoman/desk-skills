// A repo's batches: its standing batch, then one named batch per epic in `batches/<name>/` beside its
// queue. An archived batch sits under `batches/.done/` and is not listed. A ticket's key finds the one
// batch that holds it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as E from './desk-env.mjs';
import { readQueue, prStatusOf } from './batch-state.mjs';
import { archivedOf, everyTicket } from './queue-store.mjs';

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

// The archived named batches: batch.mjs moves a batch's queue folder and its state folder into
// batches/.done/ under the same name, so a batch archived inside the window still counts.
export function archivedBatches({ queueRoot, stateRoot }) {
  const qdone = join(queueRoot, E.BATCHES_DIR, '.done');
  let names = [];
  try { names = readdirSync(qdone, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
  return names.filter((n) => existsSync(join(qdone, n, 'queue.json')))
    .map((n) => ({ name: `${n} (archived)`, queue: join(qdone, n, 'queue.json'), state: join(stateRoot, E.BATCHES_DIR, '.done', n) }));
}
// Every batch of the repo, archived named ones last.
export const allBatches = (slug) => {
  const standing = E.batchPaths(slug);
  return [...listBatches(slug), ...archivedBatches({ queueRoot: dirname(standing.queue), stateRoot: standing.state })];
};

// Every queue ticket of the repo's batches, archived ones included (a pass archives every done ticket
// whose PR merged, queue-store.mjs archiveDone), each with its key.
export function repoTickets(slug, batches = allBatches(slug)) {
  return batches.flatMap((b) => {
    try { return Object.entries(everyTicket(readQueue(b.queue))).map(([key, t]) => ({ ...t, key: t?.key ?? key })); } catch { return []; }
  });
}

// The batch whose queue holds `key`: its entry from listBatches, or null when none does. A key in two
// batches is a broken invariant, and refused naming both rather than picking one.
// A batch holding it live wins over one holding it archived (queue-store.mjs), done there before.
export function batchHolding(key, slug = E.repoSlug()) {
  const read = listBatches(slug).filter((b) => existsSync(b.queue)).map((b) => ({ b, q: readQueue(b.queue) }));
  const live = read.filter(({ q }) => q.tickets && Object.hasOwn(q.tickets, key));
  const holding = (live.length ? live : read.filter(({ q }) => q.tickets?.[key])).map(({ b }) => b);
  if (holding.length > 1) {
    throw new E.DeskConfigError(`desk: ${key} is in more than one batch (${holding.map(label).join(', ')}). A ticket belongs to one batch; remove it from the others.`);
  }
  return holding[0] ?? null;
}

export const label = (b) => b.name ?? 'the standing batch';

// The named slot a standing batch on a base moves to (move-batch.mjs): its epic's, or, where its queue
// names no epic (its tickets come from several), one named after its base branch, with each run of
// characters a batch name cannot hold made a '-'. -> {name, by: 'epic' | 'branch'} or {why}.
export function slotFor(q) {
  if (q.epic != null && q.epic !== '') {
    const epic = String(q.epic);
    return E.SAFE_ID.test(epic) && !epic.includes('..') ? { name: epic, by: 'epic' } : { why: `its epic "${epic}" is not a batch name (letters, digits, . _ - only; no ..)` };
  }
  const name = String(q.base ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').slice(0, 100).replace(/^[^A-Za-z0-9]+|[-.]+$/g, '');
  return E.SAFE_ID.test(name) ? { name, by: 'branch' } : { why: `its queue names no epic, and its base "${q.base}" makes no batch name` };
}

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

// A PR's state: OPEN, MERGED or CLOSED, or null when it cannot be read. A merged or closed one stays so,
// and is not asked again.
const shut = new Map();
// One field of PR `n`, or '' when it cannot be read.
function prField(n, field) {
  let repo;
  try { repo = E.ghRepo(); } catch { return ''; }
  const r = spawnSync('gh', ['pr', 'view', String(n), '--repo', repo, '--json', field, '--jq', `.${field}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
export function prState(n) {
  if (shut.has(String(n))) return shut.get(String(n));
  const s = prField(n, 'state');
  if (s === 'MERGED' || s === 'CLOSED') shut.set(String(n), s);
  return ['OPEN', 'MERGED', 'CLOSED'].includes(s) ? s : null;
}
// A PR whose state cannot be read counts as open.
export const prOpen = (n) => !['MERGED', 'CLOSED'].includes(prState(n));
// When PR `n` merged, or null.
export const prMergedAt = (n) => prField(n, 'mergedAt') || null;

// Whether a promotion PR that merged at `mergedAt` was a feature batch's last: every ticket had merged
// into the base before it. A child merged after it still has to be promoted.
export function lastPromotion(tickets, mergedAt) {
  const at = mergedAt ? Date.parse(mergedAt) : null;
  return Object.values(tickets ?? {}).every((t) => t.merged_at && at != null && Date.parse(t.merged_at) <= at);
}

// Whether a feature batch's last promotion PR has merged, so it takes no more tickets: as a pass
// recorded it (pass/promotion-pr.mjs nextPromotion), or with every ticket merged before it. GitHub is asked only
// when no pass has recorded it.
export const lastPromotionRecorded = (q) => q?.promotion?.pr != null && (q.promotion.merged ?? []).some((m) => String(m.pr) === String(q.promotion.pr));
function promoted(q) {
  const p = q?.promotion?.pr;
  if (p == null) return false;
  return lastPromotionRecorded(q) || (prState(p) === 'MERGED' && lastPromotion(q.tickets, prMergedAt(p)));
}

// The environment that points queue.mjs and triage.sh at named batch `b` (listBatches), whatever this
// one pins: the batch's base comes from its queue, never this process's default branch.
export const batchEnv = (b) => {
  const { DESK_DEFAULT_BRANCH: _pinned, ...env } = process.env;
  return { ...env, DESK_BATCH: b.name, DESK_QUEUE: b.queue, DESK_AUTOPILOT_STATE: b.state };
};

// The pid holding a batch's pass lock, or its supervisor lock other than this process's own, or null.
// A holder that has exited holds nothing.
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lockPid = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')).pid ?? null; } catch { return null; } };
export function orchestratorHolder(state) {
  const pid = lockPid(join(state, 'orchestrator.lock'));
  return pid && alive(pid) ? pid : null;
}
export function supervisorHolder(state) {
  const pid = lockPid(join(state, 'supervisor.lock'));
  return pid && pid !== process.pid && alive(pid) ? pid : null;
}
// Finished: every ticket done with no PR still open. A failed ticket waits on the person, a queue with no
// tickets is a session's between `queue.mjs init` and its plan, and a batch on a base still has its gate
// and promotion to come: none of those is finished. Only a batch on a base is archived (batch.mjs), so a
// finished batch's queue stays listed, and must not keep its keys or its epic's children out of every
// other batch. A ticket carried in from an earlier batch for its follow-on (queue.mjs init) is not one of
// this batch's.
export const ownRows = (q) => Object.values(q?.tickets ?? {}).filter((t) => !('carried_from' in t));
// Its archived tickets (queue-store.mjs) are done with their PRs merged or closed, so they count as rows.
const finishedBy = (q, open) => {
  const rows = ownRows(q);
  const any = rows.length > 0 || Object.keys(archivedOf(q)).length > 0;
  return !q.base && any && rows.every((t) => t.state === 'done') && !rows.some((t) => t.result?.pr != null && open(t));
};
export const finished = (q) => finishedBy(q, (t) => prOpen(t.result.pr));
// finished as the queue records it, asking GitHub nothing, for a caller that runs on every refresh: a PR
// the queue does not record as merged or closed counts as open.
export const finishedOnRecord = (q) => finishedBy(q, (t) => !t.merged_at && !['MERGED', 'CLOSED'].includes(prStatusOf(t)?.state));

// The repo's batches other than the one whose queue is `own` that are running: listed, readable and not
// finished, as `isFinished` judges. `defaultBase()` names the base of a batch that sets none.
export function otherRunningBatches(slug, own, defaultBase, isFinished = finished) {
  return listBatches(slug).filter((b) => resolve(b.queue) !== resolve(own) && existsSync(b.queue)).flatMap((b) => {
    try { const q = readQueue(b.queue); return isFinished(q) ? [] : [{ ...b, base: q.base ?? defaultBase() }]; } catch { return []; }
  });
}
const peek = (b) => { try { return { q: readQueue(b.queue) }; } catch (e) { return { unreadable: e.message }; } };
const where = (b) => (b.name ? `batch ${b.name}` : 'the standing batch');

// The tracker a repo's keys name tickets in: its §4 Jira site, where §4 Tracker is jira, else null. A
// key is one ticket across repos only on the same site; an issue number or slug is the repo's own.
// Read again only once the config file changes.
// `get` reads a config row by id: this repo's, or another's by its slug.
function siteFrom(get) {
  try {
    const s = String(get('jira-site') ?? '').trim().toLowerCase();
    return get('tracker') === 'jira' && s ? s : null;
  } catch { return null; /* an unreadable config names no tracker */ }
}
const sites = new Map();
function siteOf(slug) {
  const path = join(E.deskConfigRoot(), 'repos', slug, 'config.md');
  let at;
  try { at = statSync(path).mtimeMs; } catch { return null; /* no config: no tracker */ }
  if (sites.get(path)?.at === at) return sites.get(path).site;
  const site = siteFrom((id) => E.repoConfigValue(slug, id));
  sites.set(path, { at, site });
  return site;
}

// Every configured repo's copy of each ticket queued and not done, read from its batches' queues on
// disk: key -> [{ slug, ghRepo, site, name, queue, state, q, t }], at most one copy per repo, from repos
// on a Jira site only. A batch finished on its record, or whose queue cannot be read, holds none. Read
// again only once a queue file changes.
let copiesSeen = null;
export function queuedCopies() {
  const batches = E.configuredRepos().flatMap((r) => {
    const site = siteOf(r.slug);
    if (!site) return [];
    try { return listBatches(r.slug).map((b) => ({ ...b, slug: r.slug, ghRepo: r.ghRepo, site })); } catch { return []; }
  });
  const stamp = batches.map((b) => { try { const s = statSync(b.queue); return `${b.site}:${b.queue}:${s.mtimeMs}:${s.size}`; } catch { return ''; } }).join('\n');
  if (copiesSeen?.stamp === stamp) return copiesSeen.copies;
  const copies = new Map();
  for (const b of batches) {
    const { q } = existsSync(b.queue) ? peek(b) : {};
    if (!q || finishedOnRecord(q)) continue;
    for (const t of ownRows(q)) {
      if (t.state === 'done' || t.merged_at) continue;
      const had = copies.get(t.key) ?? [];
      if (!had.some((c) => c.slug === b.slug)) copies.set(t.key, [...had, { ...b, q, t }]);
    }
  }
  copiesSeen = { stamp, copies };
  return copies;
}
// The copies of `key` queued in configured repos other than `slug`, on its Jira site `site`.
export function copiesElsewhere(key, slug, copies = queuedCopies(), site = slug ? siteOf(slug) : null) {
  return site ? (copies.get(key) ?? []).filter((c) => c.slug !== slug && c.site === site) : [];
}
export const copyWhere = (c) => (c.name ? `batch ${c.name} of ${c.ghRepo}` : `${c.ghRepo}'s standing batch`);

// Whether the named batch `name` is listed, readable, not finished, and not past its last promotion.
export function liveBatch(name) {
  let b;
  try { b = listBatches().find((x) => x.name === name); } catch { return false; }
  const { q } = b ? peek(b) : {};
  return !!q && !finished(q) && !promoted(q);
}

// The feature batch of the epic that triage record `rec` names, when it is listed but its last
// promotion has merged: {batch, pr}, or null. Its children go to the standing batch.
export function promotedEpicBatch(rec) {
  const epic = rec?.epic?.key;
  if (!epic) return null;
  let b;
  try { b = listBatches().find((x) => x.name === epic); } catch { return null; }
  const { q } = b ? peek(b) : {};
  return q && promoted(q) ? { batch: epic, pr: q.promotion.pr } : null;
}

// Why `key` may not join the batch whose queue is `own`, or null: another unfinished batch holds it
// (`held` then names that batch, its state directory and the ticket's state there), a batch of another
// configured repo has it queued (`repo` then names that repo), or its triage record `rec` names an epic whose feature batch is unfinished and not past its last
// promotion. -> {batch, why},
// with `epic` set to that epic for its child, and `unreadable` set when another batch's queue cannot be
// read, so the key cannot be checked. Never
// throws: callers check one key of many. Outside a repo there are no batches to list.
export function belongsElsewhere(key, rec = null, own = E.queueFile()) {
  let others;
  try { others = listBatches().filter((b) => resolve(b.queue) !== resolve(own) && existsSync(b.queue)); } catch { return null; }
  const read = others.map((b) => ({ b, ...peek(b) }));
  const bad = read.find((x) => x.unreadable);
  if (bad) return { batch: label(bad.b), unreadable: true, why: `${key} cannot be checked against ${where(bad.b)}, whose queue cannot be read (${bad.unreadable})` };
  const live = read.filter((x) => !finished(x.q));
  const held = live.find((x) => x.q.tickets?.[key]);
  if (held) {
    const move = `if it belongs elsewhere, move it from /desk-needs-you once it is parked or stopped (move "<batch>")`;
    return { batch: label(held.b), held: { name: held.b.name, state: held.b.state, ticket: held.q.tickets[key].state },
      why: `${key} is in ${where(held.b)}: a ticket is in one batch at most; ${move}` };
  }
  // A ticket is queued in one repo at most. The repo handing it here (DESK_ADMIT_FROM, admitInRepo)
  // drops its own copy once this admit is made.
  let slug = null;
  try { slug = E.repoSlug(); } catch { /* outside a repo: no Jira site to match a key on */ }
  const there = slug && copiesElsewhere(key, slug, queuedCopies(), siteFrom(E.configValue)).find((c) => c.slug !== process.env.DESK_ADMIT_FROM);
  if (there) {
    return { batch: `${there.ghRepo}:${label(there)}`, repo: there.ghRepo,
      why: `${key} is already queued in ${copyWhere(there)} (${there.t.state}): a ticket is queued in one repo at most; if it belongs here, drop it there first (queue.mjs drop ${key}, in ${there.ghRepo}'s checkout)` };
  }
  const epic = rec?.epic?.key;
  const feature = epic && live.find((x) => x.b.name === epic && !promoted(x.q));
  if (feature) return { batch: epic, epic, why: `${key} is a child of epic ${epic}, whose feature batch ${epic} is running: it joins that batch, never another` };
  return null;
}
