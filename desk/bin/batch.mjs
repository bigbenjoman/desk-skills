#!/usr/bin/env node
// A repo's feature batch: started for an epic on its feature branch, discarded when its plan is
// declined, and archived under `batches/.done/` once its work is promoted or abandoned. A repo runs one
// feature batch per epic, each on its own branch, beside the standing batch.
//   node batch.mjs start <EPIC> <branch>   a batch named <EPIC> in batches/<EPIC>/, its epic and base set,
//                                          not handed to the supervisor
//   node batch.mjs discard <EPIC>          removes a batch no ticket has started in and the supervisor does
//                                          not run: its queue and state folders, and its branch from origin
//                                          when that holds no commit the default branch lacks
//   node batch.mjs archive <EPIC>          the supervisor's archive check, once, now
// Every refusal exits 11 (show the person) and changes nothing.
//
// The supervisor runs the archive check for each named batch on every tick. A batch is archived once
// its last promotion PR is merged, or its promotion PR is closed, no ticket runs, no ticket PR is open, and no pass, merge driver
// or queue write holds it. A ticket PR still open then is the person's to merge or close, never desk's:
// it goes to the check-in digest, handed on as kind `archive` until it is merged or closed.
import { existsSync, mkdirSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { readQueue, EXIT, crashShowsPerson, describeCrash } from './batch-state.mjs';
import { listBatches, finished, prState, prMergedAt, lastPromotion, orchestratorHolder, supervisorHolder } from './batches.mjs';
import { readHanded, handItems, dropHanded } from './decider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DONE_DIR = '.done';

class BatchRefusal extends Error {}
const refuse = (msg) => { throw new BatchRefusal(msg); };

const git = (args) => execFileSync('git', ['-C', E.repoRoot(), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const firstLine = (e) => String(e?.stderr || e?.message || e).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const defaultBranch = () => E.configValue('default-branch') || 'main';
const onOrigin = (branch) => git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]) !== '';

const named = (slug, epic) => listBatches(slug).find((b) => b.name === epic);
const checkName = (epic) => {
  if (!epic || !E.SAFE_ID.test(epic) || epic.includes('..')) refuse(`"${epic ?? ''}" is not a batch name (an epic key: letters, digits, . _ - only)`);
};

// The queue.mjs commands a start runs, in the new batch only.
function queueCmd(epic, args) {
  const env = { ...process.env, DESK_BATCH: epic };
  for (const k of ['DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_DEFAULT_BRANCH']) delete env[k];
  const r = spawnSync(process.execPath, [join(HERE, 'queue.mjs'), ...args], { env, encoding: 'utf8' });
  return r.status === 0 ? null : `${r.stderr}${r.stdout}`.trim().replace(/^queue: /, '');
}

// -> lines saying what was made. The base's other rules (a valid name, never a production branch, on
// origin) are queue.mjs set-batch base='s; it clears the default branch rather than refusing it.
function start(epic, branch, slug = E.repoSlug()) {
  checkName(epic);
  if (!branch) refuse(`no batch started for ${epic}: no branch was given`);
  if (branch === defaultBranch()) refuse(`no batch started for ${epic}: ${branch} is the default branch, and a feature batch runs on the epic's own branch`);
  const all = listBatches(slug);
  const own = E.batchPaths(slug, epic);
  if (all.some((b) => b.name === epic) || existsSync(own.queue)) refuse(`batch ${epic} already exists (${own.queue}): no second batch started for it`);
  // The standing batch counts too: an older one may still run on a feature branch (move-batch.mjs).
  for (const b of all.filter((x) => x.name || existsSync(x.queue))) {
    let q;
    try { q = readQueue(b.queue); } catch (e) { refuse(`no batch started for ${epic}: ${b.name ? `batch ${b.name}'s` : 'the standing batch\'s'} queue cannot be read, so it may be live on ${branch} (${describeCrash(e)})`); }
    if (q.base === branch && !finished(q)) refuse(`no batch started for ${epic}: ${b.name ? `feature batch ${b.name}` : 'the standing batch'} is live on ${branch}, and each feature batch runs on its own branch`);
  }
  const failed = queueCmd(epic, ['init', epic]);
  if (failed) throw new Error(`queue.mjs init ${epic} failed: ${failed}`);
  const why = queueCmd(epic, ['set-batch', `epic=${epic}`, `base=${branch}`]);
  if (why) {
    rmSync(dirname(own.queue), { recursive: true, force: true });
    rmSync(own.state, { recursive: true, force: true });
    refuse(`no batch started for ${epic}: ${why}`);
  }
  return [`batch ${epic} started on ${branch}: ${own.queue}. It is not handed to the supervisor until Stage 4 runs queue.mjs --batch ${epic} set-batch supervised=true`];
}

// A ticket some worker has begun: spawned, past triage, or with a PR.
const startedTicket = (t) => t.spawned_at != null || ['running', 'done', 'failed'].includes(t.state) || t.result?.pr != null;

// -> lines saying what was removed and what became of the branch.
function discard(epic, slug = E.repoSlug()) {
  checkName(epic);
  const b = named(slug, epic);
  if (!b) refuse(`no batch ${epic} in this repo: nothing removed`);
  let q;
  try { q = readQueue(b.queue); } catch (e) { refuse(`batch ${epic}'s queue cannot be read, so whether a ticket started cannot be told: nothing removed (${describeCrash(e)})`); }
  if (q.supervised === true) refuse(`batch ${epic} is handed to the supervisor: nothing removed. A batch it runs is archived once its work is promoted or abandoned`);
  const begun = Object.values(q.tickets ?? {}).filter(startedTicket).map((t) => t.key);
  if (begun.length) refuse(`batch ${epic} has started tickets (${begun.join(', ')}): nothing removed`);
  rmSync(dirname(b.queue), { recursive: true, force: true });
  rmSync(b.state, { recursive: true, force: true });
  const lines = [`batch ${epic} discarded: removed ${dirname(b.queue)} and ${b.state}`];
  if (q.base) lines.push(branchFate(q.base));
  return lines;
}

// Deletes a discarded batch's branch from origin when the default branch already has all of it.
function branchFate(base) {
  const def = defaultBranch();
  try {
    if (!onOrigin(base)) return `${base} is not on origin: nothing to delete`;
    git(['fetch', '-q', 'origin', `+refs/heads/${def}:refs/remotes/origin/${def}`, `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    const ahead = Number(git(['rev-list', '--count', `origin/${def}..origin/${base}`]));
    if (ahead > 0) return `${base} kept on origin: it has ${ahead} commit(s) that are not on ${def}, so deleting it could lose work. Delete it by hand once it can go (git push origin --delete ${base})`;
    const grant = E.permission('git-push');
    if (grant !== 'yes') return `${base} kept on origin: it has no commits that are not on ${def}, but config §3 git-push is "${grant}". Delete it by hand (git push origin --delete ${base})`;
    git(['push', '-q', 'origin', '--delete', base]);
    return `${base} deleted from origin: it had no commits that are not on ${def}`;
  } catch (e) {
    return `${base} kept on origin: it could not be checked or deleted (${firstLine(e)})`;
  }
}

// What still holds a batch's folders: a pass, the supervisor's own run of it, its merge driver, or a
// queue write. A holder that has exited holds nothing.
function holder(b) {
  const pass = orchestratorHolder(b.state);
  if (pass) return `a pass (pid ${pass})`;
  const sup = supervisorHolder(b.state);
  if (sup) return `a supervisor run (pid ${sup})`;
  if (E.mergeDriverHolder(b.state)) return 'its merge driver';
  if (existsSync(`${b.queue}.lock`)) return 'a queue write';
  return null;
}

// `dir` moved into its parent's .done/ folder, under its own name, or that name and a time when an
// earlier batch of the same name was archived there. -> the new path, or null when there was no folder.
function moveDone(dir, at) {
  if (!existsSync(dir)) return null;
  const done = join(dirname(dir), DONE_DIR);
  mkdirSync(done, { recursive: true });
  let to = join(done, basename(dir));
  if (existsSync(to)) to = `${to}.${at.toISOString().replace(/[:.]/g, '-')}`;
  renameSync(dir, to);
  return to;
}

// The archive check for one named batch {name, queue, state}. -> {archived, lines, log}: `lines` go in
// the batch's own log, `log` in the standing batch's, since an archived batch's own log moves with it.
export function archiveCheck(b, { state = prState, mergedAt = prMergedAt, now = new Date() } = {}) {
  const none = { archived: false, lines: [], log: [] };
  if (!b?.name) return none;
  let q;
  try { q = readQueue(b.queue); } catch { return none; /* the tick says the queue is unreadable */ }
  const p = q.promotion?.pr;
  const ps = p != null ? state(p) : null;
  // A merged promotion ends the batch only when it was the last slice, as pass.mjs nextPromotion
  // decides; an earlier merged slice is followed by the next one. It is decided here too, since no
  // pass runs for a batch that went idle before its last promotion merged.
  const last = ps === 'MERGED' && lastPromotion(q.tickets, mergedAt(p));
  const shut = last || ps === 'CLOSED';
  // Only open ticket PRs of a shut promotion stay handed on: one merged or closed since goes.
  const rows = Object.values(q.tickets ?? {});
  const openPrs = shut ? rows.filter((t) => t.result?.pr != null && !['MERGED', 'CLOSED'].includes(state(t.result.pr))) : [];
  const items = openPrs.map((t) => ({ item: { id: `archive:${b.name}:${t.key}:${t.result.pr}`, ticket: t.key, kind: 'archive',
    text: `PR #${t.result.pr} into ${q.base ?? 'the feature branch'} is still open, and batch ${b.name}'s promotion PR #${p} is ${ps.toLowerCase()}: merge or close it, and the batch is archived once no ticket PR is open` },
  why: 'desk never closes an epic\'s ticket PRs', pr: t.result.pr }));
  const lines = dropArchiveItems(b.state, new Set(items.map((i) => i.item.id)));
  if (!shut || rows.some((t) => t.state === 'running')) return { ...none, lines };
  if (items.length) {
    const added = existsSync(b.state) ? handItems(b.state, items, now) : [];
    if (added.length) lines.push(`archive: batch ${b.name} waits on ${added.map((x) => `${x.item.ticket} (PR #${x.pr})`).join(', ')}, handed to the digest`);
    return { ...none, lines };
  }
  const busy = holder(b);
  if (busy) return { ...none, lines: [...lines, `archive: batch ${b.name} is ready to archive, but ${busy} holds it; the next tick tries again`] };
  const q2 = moveDone(dirname(b.queue), now);
  const s2 = moveDone(b.state, now);
  return { archived: true, lines: [], log: [`batch ${b.name} archived: its promotion PR #${p} is ${ps.toLowerCase()} and no ticket runs or has a PR open; moved ${dirname(b.queue)} to ${q2}${s2 ? ` and ${b.state} to ${s2}` : ''}`] };
}

// Drops this batch's archive items no longer open. -> report lines.
function dropArchiveItems(state, keep) {
  const gone = Object.values(readHanded(state)).filter((e) => e.kind === 'archive' && !keep.has(e.id));
  if (!gone.length) return [];
  dropHanded(state, gone.map((e) => e.id));
  return [`archive: ${gone.map((e) => e.ticket).join(', ')} no longer waits on the archive, so the digest no longer lists it`];
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  crashShowsPerson((e) => console.error(`batch: ${describeCrash(e)}`));
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    let lines;
    if (cmd === 'start' && rest.length === 2) lines = start(rest[0], rest[1]);
    else if (cmd === 'discard' && rest.length === 1) lines = discard(rest[0]);
    else if (cmd === 'archive' && rest.length === 1) {
      checkName(rest[0]);
      const b = named(E.repoSlug(), rest[0]);
      if (!b) refuse(`no batch ${rest[0]} in this repo`);
      const a = archiveCheck(b);
      lines = a.archived ? a.log : a.lines.length ? a.lines : [`batch ${rest[0]} is not archived: its promotion PR is not merged or closed, or a ticket still runs`];
    } else {
      console.error('usage: batch.mjs start <EPIC> <branch> | discard <EPIC> | archive <EPIC>');
      process.exit(EXIT.SHOW_PERSON);
    }
    console.log(lines.join('\n'));
  } catch (e) {
    console.error(`batch: ${e instanceof BatchRefusal ? e.message : describeCrash(e)}`);
    process.exit(EXIT.SHOW_PERSON);
  }
}
