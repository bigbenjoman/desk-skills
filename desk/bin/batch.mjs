#!/usr/bin/env node
// A repo's feature batch: started for an epic on its feature branch, discarded when its plan is
// declined, and archived under `batches/.done/` once its work is promoted or abandoned. A repo runs one
// feature batch at a time.
//   node batch.mjs start <EPIC> <branch>   a batch named <EPIC> in batches/<EPIC>/, its epic and base set,
//                                          not handed to the supervisor
//   node batch.mjs discard <EPIC>          removes a batch no ticket has started in and the supervisor does
//                                          not run: its queue and state folders, and its branch from origin
//                                          when that holds no commit the default branch lacks
//   node batch.mjs archive <EPIC>          the supervisor's archive check, once, now
// Every refusal exits 11 (show the person) and changes nothing.
//
// The supervisor runs the archive check for each named batch on every tick. A batch is archived once
// its promotion PR is merged or closed, no ticket runs, no ticket PR is open, and no pass, merge driver
// or queue write holds it. A ticket PR still open then is the person's to merge or close, never desk's:
// it goes to the check-in digest, handed on as kind `archive` until it is merged or closed.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { readQueue, EXIT, crashShowsPerson, describeCrash } from './batch-state.mjs';
import { listBatches, finished } from './batches.mjs';
import { readHanded, handItems, dropHanded } from './decider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DONE_DIR = '.done';

export class BatchRefusal extends Error {}
const refuse = (msg) => { throw new BatchRefusal(msg); };

const git = (args) => execFileSync('git', ['-C', E.repoRoot(), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const firstLine = (e) => String(e?.stderr || e?.message || e).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const defaultBranch = () => E.configValue('default-branch') || 'main';
const onOrigin = (branch) => git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]) !== '';

// Why `branch` cannot be a feature batch's base, or null.
export function baseRefusal(branch) {
  if (!branch) return 'no branch was given';
  if (!E.BRANCH_NAME.test(branch) || branch.includes('..') || branch.endsWith('.lock')) return `"${branch}" is not a valid branch name`;
  if (branch === defaultBranch()) return `${branch} is the default branch, and a feature batch runs on the epic's own branch`;
  if (E.PRODUCTION_BRANCH.test(branch)) return `${branch} is a production branch, which only ever takes promotion PRs`;
  let found;
  try { found = onOrigin(branch); } catch (e) { return `origin could not be asked for ${branch} (${firstLine(e)})`; }
  return found ? null : `${branch} is not on origin: push it first`;
}

const named = (slug, epic) => listBatches(slug).find((b) => b.name === epic);
const checkName = (epic) => {
  if (!epic || !E.SAFE_ID.test(epic) || epic.includes('..')) refuse(`"${epic ?? ''}" is not a batch name (an epic key: letters, digits, . _ - only)`);
};

// The queue.mjs commands a start runs, in the new batch only.
function queueCmd(epic, args) {
  const env = { ...process.env, DESK_BATCH: epic };
  for (const k of ['DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_DEFAULT_BRANCH']) delete env[k];
  const r = spawnSync(process.execPath, [join(HERE, 'queue.mjs'), ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`queue.mjs ${args.join(' ')} failed: ${`${r.stderr}${r.stdout}`.trim()}`);
}

// -> lines saying what was made.
export function start(epic, branch, slug = E.repoSlug()) {
  checkName(epic);
  const why = baseRefusal(branch);
  if (why) refuse(`no batch started for ${epic}: ${why}`);
  const all = listBatches(slug);
  const own = E.batchPaths(slug, epic);
  if (all.some((b) => b.name === epic) || existsSync(own.queue)) refuse(`batch ${epic} already exists (${own.queue}): no second batch started for it`);
  for (const b of all.filter((x) => x.name)) {
    let q;
    try { q = readQueue(b.queue); } catch (e) { refuse(`no batch started for ${epic}: batch ${b.name}'s queue cannot be read, so it may be a live feature batch (${describeCrash(e)})`); }
    if (!finished(q)) refuse(`no batch started for ${epic}: feature batch ${b.name} is live in this repo, and a repo runs one feature batch at a time`);
  }
  queueCmd(epic, ['init', epic]);
  queueCmd(epic, ['set-batch', `epic=${epic}`, `base=${branch}`]);
  return [`batch ${epic} started on ${branch}: ${own.queue}. It is not handed to the supervisor until Stage 4 runs queue.mjs --batch ${epic} set-batch supervised=true`];
}

// A ticket some worker has begun: spawned, past triage, or with a PR.
const startedTicket = (t) => t.spawned_at != null || ['running', 'done', 'failed'].includes(t.state) || t.result?.pr != null;

// -> lines saying what was removed and what became of the branch.
export function discard(epic, slug = E.repoSlug()) {
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

// A PR's state: OPEN, MERGED or CLOSED, or null when it cannot be read.
export function prState(n) {
  let repo;
  try { repo = E.ghRepo(); } catch { return null; }
  const r = spawnSync('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'state', '--jq', '.state'], { encoding: 'utf8' });
  const s = r.status === 0 ? r.stdout.trim() : '';
  return ['OPEN', 'MERGED', 'CLOSED'].includes(s) ? s : null;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lockPid = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')).pid ?? null; } catch { return null; } };
// What still holds a batch's folders: a pass, the supervisor's own run of it, its merge driver, or a
// queue write. A holder that has exited holds nothing.
function holder(b) {
  const pass = lockPid(join(b.state, 'orchestrator.lock'));
  if (pass && alive(pass)) return `a pass (pid ${pass})`;
  const sup = lockPid(join(b.state, 'supervisor.lock'));
  if (sup && sup !== process.pid && alive(sup)) return `a supervisor run (pid ${sup})`;
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
export function archiveCheck(b, { state = prState, now = new Date() } = {}) {
  const none = { archived: false, lines: [], log: [] };
  if (!b?.name) return none;
  let q;
  try { q = readQueue(b.queue); } catch { return none; /* the tick says the queue is unreadable */ }
  const p = q.promotion?.pr;
  const ps = p != null ? state(p) : null;
  const shut = ps === 'MERGED' || ps === 'CLOSED';
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
