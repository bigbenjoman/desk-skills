#!/usr/bin/env node
// The autopilot queue: the orchestrator's only piece of state.
//
// Lives outside any repo so worktree churn cannot take it. Written by the orchestrator's passes, the
// merge driver and desk-q, every one through this file, which locks each change (lock() below);
// workers never touch it — their state is derived from their own logs plus `claude agents --json`.
// Created on first use; never shipped.
// Exits 0, or 11 (show the person) on any refusal or error: EXIT in batch-state.mjs.
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isHeld, spinePark, waitingOnMerge, lanePark, EXIT, crashShowsPerson, readQueue, readTriage } from './batch-state.mjs';
import { ANSWER_HEAD } from './briefing.mjs';
import { spineMerger } from './spine-check.mjs';
import { LIVE_MS } from './borrow.mjs';
import { queueFile, stateDir, skillsDir, concurrencyLimits, SAFE_ID, BRANCH_NAME, PRODUCTION_BRANCH, configValue, repoRoot, rotateRound, sessionDefaultMode, DONTASK_WARNING,
  ghRepo, permission, permissionKey, memStatusLine } from './desk-env.mjs';

crashShowsPerson((e) => console.error(`queue: ${e?.message ?? e}`));

// The batch's base branch (see batchBase() in desk-env.mjs). Empty or `none` clears it. It must be a
// real branch on origin, never the config's default (that is no override) and never a production
// branch: a batch merges into its base, and production only ever takes promotion PRs.
function setBase(q, v) {
  if (!v || /^none$/i.test(v)) { delete q.base; return; }
  if (!BRANCH_NAME.test(v) || v.includes('..') || v.endsWith('.lock')) throw new Error(`base: "${v}" is not a valid branch name`);
  if (PRODUCTION_BRANCH.test(v)) throw new Error(`base: refusing "${v}" — a batch never merges into a production branch`);
  const def = configValue('default-branch');
  if (def && v === def) { delete q.base; return; }
  let found = '';
  try { found = execFileSync('git', ['-C', repoRoot(), 'ls-remote', '--heads', 'origin', `refs/heads/${v}`], { encoding: 'utf8' }).trim(); }
  catch (e) { throw new Error(`base: could not ask origin for ${v} (${e.message.split('\n')[0]})`); }
  if (!found) throw new Error(`base: ${v} does not exist on origin — push it first`);
  q.base = v;
}

const QUEUE = queueFile();
const STATES = ['queued', 'triaged', 'running', 'parked', 'done', 'failed'];

// The starting concurrency is config §3b "Autopilot worker concurrency" (`<default> / <cap>`); the
// orchestrator's ladder changes it per pass with set-batch, and pass.mjs never exceeds the cap. A
// count the user set carries `concurrency_by=user` (set-batch keeps their number as concurrency_user).
const empty = () => ({ version: 1, batch: null, concurrency: concurrencyLimits().def, tickets: {} });

function load() {
  if (!existsSync(QUEUE)) return empty();
  // A torn or hand-mangled queue must never read as "no tickets" — that would
  // silently re-spawn work that is already running.
  return readQueue(QUEUE);
}

// A command that changes the queue holds this lock from its read to its save: two read-change-writes
// that overlap would otherwise each save their own copy, and the first one's change is lost with no
// error. A directory, because creating one is atomic, with the holder's pid inside. Reads take no
// lock: save() renames atomically, so a reader always sees one whole version.
const LOCK = `${QUEUE}.lock`;
// The wait is 10 seconds; DESK_QUEUE_LOCK_WAIT_MS shortens it for tests, and anything but a positive
// number of milliseconds there is ignored rather than turning the wait into forever or nothing.
const LOCK_WAIT_MS = Number(process.env.DESK_QUEUE_LOCK_WAIT_MS) > 0 ? Number(process.env.DESK_QUEUE_LOCK_WAIT_MS) : 10_000;
let locked = false;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lockPid = (dir) => { try { return Number(readFileSync(join(dir, 'pid'), 'utf8').trim()) || null; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A holder that has exited never lets go. One with no pid yet is between its mkdir and its write,
// unless it has sat that way for a minute (with-lock.sh's rule).
function stale() {
  const pid = lockPid(LOCK);
  try { return pid ? !alive(pid) : Date.now() - statSync(LOCK).mtimeMs > 60_000; } catch { return false; } // already gone
}

// Clear a stale lock. Writers that all saw the same stale lock must not each remove "the lock", or a
// slower one removes the fresh lock a faster one has just taken. So clearing takes its own lock and
// looks again under it: only a clearer can remove the queue lock while it exists, so a lock still
// stale under the clearing lock is the one that was seen. A clearing lock older than 5 seconds is a
// clearer that died mid-clear (clearing takes microseconds), and is removed for the next attempt.
function clearStale() {
  const clearing = `${LOCK}.clearing`;
  try { mkdirSync(clearing); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - statSync(clearing).mtimeMs > 5_000) rmSync(clearing, { recursive: true, force: true }); } catch { /* gone */ }
    return false;
  }
  try { if (stale()) rmSync(LOCK, { recursive: true, force: true }); }
  finally { rmSync(clearing, { recursive: true, force: true }); }
  return true;
}

function lock() {
  mkdirSync(dirname(QUEUE), { recursive: true });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'pid'), `${process.pid}\n`);
      locked = true;
      return;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (stale() && clearStale()) continue; // another writer clearing it: wait like any other holder
    const pid = lockPid(LOCK);
    if (Date.now() >= until) {
      throw new Error(`the queue is locked by pid ${pid ?? '? (no pid written yet)'}, which has held it past the ${LOCK_WAIT_MS / 1000}s wait: nothing was changed. Run this again once that process finishes; if it is stuck, stop it and the next write clears its lock (${LOCK})`);
    }
    sleep(50);
  }
}

function unlock() {
  if (!locked) return;
  locked = false;
  if (lockPid(LOCK) === process.pid) rmSync(LOCK, { recursive: true, force: true });
}
process.on('exit', unlock);

// Every command saves at most once, so the lock goes with the save: approve's gh call after it, or
// reject's briefing write, never keeps another writer waiting.
function save(q) {
  mkdirSync(dirname(QUEUE), { recursive: true });
  const tmp = `${QUEUE}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(q, null, 2)}\n`);
  renameSync(tmp, QUEUE); // atomic within the same filesystem
  unlock();
}

function ticket(q, key) {
  const t = q.tickets[key];
  if (!t) throw new Error(`no such ticket in the queue: ${key}`);
  return t;
}

function setPath(obj, path, value) {
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
function coerce(v) {
  if (/^\s*[[{]/.test(v)) {
    try { return JSON.parse(v); } catch (e) { throw new Error(`not valid JSON: ${v} (${e.message})`); }
  }
  return v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v;
}

// Is another orchestrator (a second batch) live right now? Its per-batch notes must survive our init.
// The pass lock only covers the seconds a pass runs, so also read the heartbeats pass.mjs writes per
// queue file: one for a different queue, fresher than 15 minutes (LIVE_MS), is a live batch between passes.
function liveOrchestrator() {
  try {
    const { pid } = JSON.parse(readFileSync(join(stateDir(), 'orchestrator.lock'), 'utf8'));
    if (pid !== process.pid) { process.kill(pid, 0); return `pid ${pid}`; }
  } catch { /* no live pass right now */ }
  try {
    const dir = join(stateDir(), 'orchestrators');
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      const hb = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (hb.queue !== QUEUE && Date.now() - Date.parse(hb.at) < LIVE_MS) return `batch ${hb.batch ?? '?'} on ${hb.queue}, last pass ${hb.at}`;
    }
  } catch { /* advisory */ }
  return null;
}

// pass.mjs spawns eligible tickets in `.tickets` key order. A ticket's place in that order is its
// position among the unfinished tickets; done and failed ones keep their slots and are never counted.
const FINISHED = ['done', 'failed'];
const unfinished = (q) => Object.keys(q.tickets).filter((k) => !FINISHED.includes(q.tickets[k].state));
const position = (q, key) => unfinished(q).indexOf(key) + 1;

// Lay `order` (every unfinished key, in their new order) over the unfinished slots.
function reorder(q, order) {
  const next = order[Symbol.iterator]();
  const keys = Object.keys(q.tickets).map((k) => (FINISHED.includes(q.tickets[k].state) ? k : next.next().value));
  q.tickets = Object.fromEntries(keys.map((k) => [k, q.tickets[k]]));
}

// The front of the spawn order, unless the user placed the ticket (queue.mjs move): then it stays
// where they put it, and the returned text says so.
function toFront(q, key) {
  if (q.tickets[key].placed) return `stays at position ${position(q, key)} of the spawn order, where the user placed it`;
  q.tickets = { [key]: q.tickets[key], ...Object.fromEntries(Object.entries(q.tickets).filter(([k]) => k !== key)) };
  return 'moved to the front of the spawn order';
}

// Send a ticket back for another worker: every field a requeue needs, not one of them left to a hand
// edit that fails silently. The last round's log, park record and mailbox move aside to one
// `.round<n>`, so pass.mjs neither refuses it as finished nor reports an old question as the new
// worker's. The branch is kept: the merge driver finds the ticket's PR by it.
function requeue(q, key) {
  const t = ticket(q, key);
  if (t.state === 'running') throw new Error(`${key} is running: stop its worker first, or it gets a second one`);
  if (isHeld(t)) throw new Error(`${key} is held behind ${String(t.held_by ?? '?').split('|').join(', ')}: release it rather than requeue it`);
  // pass.mjs spawns any triaged ticket with no open questions and never reads the lane, so this is
  // the one place an untriaged ticket, unanswered triage questions, a triage park (size, a
  // dependency cycle) or a lane C or D would slip by. A worker's own park never has open questions:
  // it spawned only once they reached 0.
  if (t.state === 'queued') throw new Error(`${key} has not been triaged: triage it and \`queue.mjs admit\` it`);
  if ((t.open_questions ?? 0) > 0) throw new Error(`${key} has ${t.open_questions} triage question(s) open: answer them first`);
  if (t.state === 'parked' && /^(size |dependency cycle:)/.test(String(t.park?.question ?? ''))) throw new Error(`${key} was parked at triage (${t.park.question}): split it or fix the links, not requeue it`);
  if (!['A', 'B', 'E'].includes(t.lane)) throw new Error(`${key} is lane ${t.lane ?? '?'}, and only lanes A, B and E go to a headless worker. Only if the user rules the lane wrong: queue.mjs set ${key} lane=<A, B or E>, then requeue`);
  // A standard-model worker that failed, or was stopped as stalled, comes back one step stronger
  // (config §3b Worker models). A park with a question keeps its model, and so does a ticket whose
  // worker never ran (a failed preflight or spawn): that was not the model falling short.
  const wedged = t.state === 'parked' && /^wedged\b/.test(String(t.park?.question ?? ''));
  const workerFailed = t.state === 'failed' && !t.spawn_failed;
  let bumped = '';
  if (t.model_tier === 'standard' && (wedged || workerFailed)) {
    t.model_tier = 'high';
    t.model_note = `standard → high after a ${wedged ? 'stalled' : 'failed'} worker`;
    bumped = `; its next worker runs on the high model (${t.model_note})`;
  }
  // A spine's approval is for the specs it was given on: a requeued spine needs a fresh one, and its
  // PR, out of draft since, would otherwise be merged by the driver before anyone approved the rework.
  const undrafted = t.approved === true && t.result?.pr != null
    ? `; PR #${t.result.pr} left draft when it was approved: put it back (gh pr ready ${t.result.pr} --repo ${ghRepo()} --undo) before the merge driver merges it`
    : '';
  const moved = rotateRound(key, { answers: true });
  Object.assign(t, { state: 'triaged', open_questions: 0, park: null, session_id: null, pid: null, idle_passes: 0, log_bytes: 0,
    spine_check: null, spec_check: null, approved: null, approved_at: null, updated_at: new Date().toISOString() });
  const placed = toFront(q, key);
  save(q);
  return `${key} requeued: ${placed}${bumped}${moved.length ? `; moved aside: ${moved.join(', ')}` : ''}${undrafted}`;
}

const [, , cmd, ...args] = process.argv;

const WRITES = ['init', 'add', 'admit', 'hold', 'set', 'set-batch', 'park', 'requeue', 'approve', 'reject', 'front', 'move', 'drop'];

try {
if (WRITES.includes(cmd)) lock();
const q = cmd === 'init' ? empty() : load(); // init must be able to repair a corrupt queue

switch (cmd) {
  case 'init': {
    // Stage 0 is the last point before triage: an orchestrator that cannot ask or run its monitors
    // would triage, then stall at Stage 3.
    const dm = sessionDefaultMode();
    if (dm.mode === 'dontAsk') {
      throw new Error(`${DONTASK_WARNING}. Set in ${dm.file}; remove it (run /desk-setup, which backs the file up first), restart the session, then init again`);
    }
    const fresh = empty();
    fresh.batch = args[0] ?? new Date().toISOString().slice(0, 16);
    save(fresh);
    // Batch notes record what workers learnt about *this* configuration. Carrying them
    // across batches propagates claims that a config change has since made false.
    //
    // But the resource rules are NOT a per-batch finding, and blanking them here is how a batch
    // ends up with workers that never learnt about the Jest cap or the test lock — pass.mjs folds
    // this file into every briefing, so a wipe is silent and total, and an uncapped worker can
    // take the VM to 18GB through that gap. So: back up, reset, then re-seed the
    // canonical header from the skill, which is version-controlled and edited in one place.
    // And never truncate under a live second batch: its workers still read this file.
    try {
      const state = stateDir();
      mkdirSync(state, { recursive: true });
      const notes = join(state, 'batch-notes.md');
      const header = join(skillsDir(), 'desk-autopilot', 'references', 'batch-notes-header.md');
      const seed = existsSync(header) ? `\n${readFileSync(header, 'utf8').trimEnd()}\n` : '';
      if (!seed) console.error(`WARNING: batch-notes header not found at ${header} — workers will not inherit the memory rules`);
      const other = liveOrchestrator();
      if (existsSync(notes) && other) {
        const cur = readFileSync(notes, 'utf8');
        if (seed && !cur.includes('## MEMORY')) writeFileSync(notes, `${cur.trimEnd()}\n${seed}`);
        console.error(`NOTE: another orchestrator (${other}) is live — batch-notes.md kept, not reset`);
      } else {
        if (existsSync(notes) && readFileSync(notes, 'utf8').trim()) {
          const bak = `${notes}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          copyFileSync(notes, bak);
          console.log(`batch notes backed up to ${bak}`);
        }
        writeFileSync(notes, `# Batch notes\n${seed}\n`);
      }
    } catch { /* notes are advisory; never fail init over them */ }
    console.log(`queue initialised at ${QUEUE}`);
    break;
  }

  case 'add': {
    const [key, type = 'Bug', lane = '?'] = args;
    if (!key) throw new Error('usage: queue.mjs add <TICKET> [type] [lane]');
    // The key names files (logs, parks, briefings, worker settings): never a path.
    if (!SAFE_ID.test(key) || key.includes('..')) throw new Error(`'${key}' is not usable as a ticket id (letters, digits, . _ - only; no ..)`);
    if (q.tickets[key]) { console.log(`${key} already in the queue (${q.tickets[key].state}) — not re-adding`); break; }
    q.tickets[key] = {
      key, type, lane, state: 'queued',
      worktree: null, branch: null, database: null, port: null,
      session_id: null, pid: null, base_sha: null, stage: null,
      park: null, log: null, result: null,
      added_at: new Date().toISOString(),
    };
    save(q);
    console.log(`added ${key}`);
    break;
  }

  // Hold a ticket behind blockers (a dependency added mid-batch, or a collision chain), recorded so
  // pass.mjs keeps the batch alive and the merge driver releases it once every blocker has merged.
  case 'hold': {
    const [key, ...blockers] = args;
    const preds = blockers.flatMap((b) => b.split(/[,|]/)).filter(Boolean);
    if (!key || !preds.length) throw new Error('usage: queue.mjs hold <TICKET> <BLOCKER> [<BLOCKER> ...]');
    const t = ticket(q, key);
    for (const p of preds) { ticket(q, p); if (p === key) throw new Error(`${key} cannot be held behind itself`); }
    if (t.state === 'parked' && !isHeld(t)) throw new Error(`${key} is parked for its own reason (${t.park?.question ?? '?'}): a hold would let a release send it to a worker`);
    if (['running', 'done', 'failed'].includes(t.state)) throw new Error(`${key} is ${t.state}: too late to hold it`);
    // A release sets state=triaged, so only a ticket that is triaged (or already held) may be held.
    if (t.state === 'queued') throw new Error(`${key} has not been triaged: triage it and \`queue.mjs admit\` it before holding it`);
    const all = [...new Set([...String(t.held_by ?? '').split('|').filter(Boolean), ...preds])];
    t.held_by = all.join('|');
    t.state = 'parked';
    t.park = { question: `held by orchestrator: blocked by ${all.join(', ')} — starts once their PRs merge`, since: new Date().toISOString() };
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(`${key} held behind ${all.join(', ')}`);
    break;
  }

  // Add one triaged ticket mid-batch, from its triage record, the way plan-batch seeds one: a blocker
  // the user asked to add, a split-off child. Never re-run plan-batch with AUTOPILOT_WRITE_QUEUE for
  // this: it resets every ticket's state.
  case 'admit': {
    const [key] = args;
    if (!key || !SAFE_ID.test(key) || key.includes('..')) throw new Error('usage: queue.mjs admit <TICKET>   (after triage.sh <TICKET>)');
    if (q.tickets[key]) throw new Error(`${key} is already in the queue (${q.tickets[key].state})`);
    const recPath = join(stateDir(), 'triage', `${key}.json`);
    if (!existsSync(recPath)) throw new Error(`no triage record for ${key}: run triage.sh ${key} first`);
    const r = readTriage(stateDir(), key);
    const size = String(r.size ?? '').toUpperCase();
    const park = lanePark(r) ?? (['L', 'XL'].includes(size) ? `size ${size} — split it before batching` : null);
    const unknowns = (r.unknowns ?? []).length + (r.facts_error ? 1 : 0);
    // The collision check plan-batch makes, against every ticket still to finish: two tickets that
    // touch one file never run at once.
    const mine = new Set(r.files_in_scope ?? []);
    const collides = [];
    for (const [k, other] of Object.entries(q.tickets)) {
      if (['done', 'failed'].includes(other.state)) continue;
      const op = join(stateDir(), 'triage', `${k}.json`);
      if (!existsSync(op)) continue;
      const files = readTriage(stateDir(), k).files_in_scope ?? [];
      if (files.some((f) => mine.has(f))) {
        collides.push(k);
        other.collides_with = [...new Set([...String(other.collides_with ?? '').split('|').filter(Boolean), key])].join('|');
      }
    }
    q.tickets[key] = {
      key, type: r.type ?? 'Bug', lane: r.lane, state: park ? 'parked' : 'triaged',
      worktree: null, branch: r.branch ?? null, database: null, port: null,
      session_id: null, pid: null, base_sha: null, stage: null,
      park: park ? { question: park, since: new Date().toISOString() } : null, log: null, result: null,
      collides_with: collides.join('|') || null, open_questions: unknowns, held_by: null,
      added_at: new Date().toISOString(),
    };
    save(q);
    console.log(`admitted ${key}: ${park ?? `triaged${unknowns ? `, ${unknowns} question(s) open` : ''}`}${r.blockers?.length ? ` — its own Jira blockers (${r.blockers.map((b) => b.key).join(', ')}) are not applied: hold it with queue.mjs hold if they are in this batch` : ''}`);
    break;
  }

  case 'set': {
    const [key, ...pairs] = args;
    const t = ticket(q, key);
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i < 0) throw new Error(`expected key=value, got: ${p}`);
      const k = p.slice(0, i);
      const v = coerce(p.slice(i + 1));
      if (k === 'state' && !STATES.includes(v)) throw new Error(`bad state "${v}" (want: ${STATES.join('|')})`);
      setPath(t, k, v);
    }
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(`${key}: ${pairs.join(' ')}`);
    break;
  }

  case 'park': {
    const [key, ...rest] = args;
    const t = ticket(q, key);
    t.state = 'parked';
    t.park = { question: rest.join(' '), since: new Date().toISOString() };
    save(q);
    console.log(`${key} parked`);
    break;
  }

  case 'requeue': {
    const [key] = args;
    if (!key) throw new Error('usage: queue.mjs requeue <TICKET>');
    console.log(requeue(q, key));
    break;
  }

  // A finished feature spine whose specs passed pass.mjs's check, approved by the person: the spine is
  // done, its PR leaves draft (§3 pr-ready), and it merges under the batch's merge rules, after which
  // what is held behind it is released. answer.mjs never un-parks; this is the orchestrator's decision.
  case 'approve': {
    const [key] = args;
    if (!key) throw new Error('usage: queue.mjs approve <SPINE>');
    const t = ticket(q, key);
    const sp = spinePark(t);
    if (sp === 'specs') throw new Error(`${key}'s specs failed the check (${(t.spine_check?.problems ?? []).join('; ')}): no approval. Send it back: queue.mjs reject ${key} "<what to fix>"`);
    if (sp !== 'approval' || t.spine_check?.ok !== true) throw new Error(`${key} is not a feature spine waiting for approval (state ${t.state}${t.park?.question ? `: ${t.park.question}` : ''})`);
    const pr = t.result?.pr;
    if (pr == null) throw new Error(`${key} records no PR to approve`);
    Object.assign(t, { state: 'done', park: null, approved: true, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    save(q);
    const held = Object.values(q.tickets).filter((x) => isHeld(x) && String(x.held_by ?? '').split('|').includes(key)).map((x) => x.key);
    const after = held.length ? `${held.join(', ')} ${held.length > 1 ? 'are' : 'is'} released once it merges` : 'nothing is held behind it';
    const repo = ghRepo();
    const lines = [`${key} approved: the spine is done`];
    let needsPerson = false;
    if (permission('pr-ready') === 'yes') {
      try {
        execFileSync('gh', ['pr', 'ready', String(pr), '--repo', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
        lines.push(`PR #${pr} is ready for review`);
      } catch (e) {
        needsPerson = true;
        lines.push(`PR #${pr} could not leave draft (${String(e.stderr ?? e.message).trim().split('\n').pop()}): gh pr ready ${pr} --repo ${repo}`);
      }
    } else {
      needsPerson = true;
      lines.push(`config §3 ${permissionKey('pr-ready')} is "${permission('pr-ready')}": undraft PR #${pr} yourself (gh pr ready ${pr} --repo ${repo})`);
    }
    const merger = spineMerger();
    if (merger.driver) {
      lines.push(`the merge driver merges PR #${pr} once it is green; ${after}`);
    } else {
      needsPerson = true;
      lines.push(`${merger.rows}: merge PR #${pr} yourself once it is green, pinned to its head (gh pr merge ${pr} --repo ${repo} --match-head-commit <sha>); ${after}`);
    }
    console.log(lines.join('\n'));
    if (needsPerson) process.exitCode = EXIT.SHOW_PERSON;
    break;
  }

  // The person rejects the spine's specs, or a spine whose specs failed the check is sent back: the note
  // goes into its briefing as a binding answer and the spine is requeued for a new worker. Nothing held
  // behind it is released.
  case 'reject': {
    const [key, ...rest] = args;
    const note = rest.join(' ').trim();
    if (!key || !note) throw new Error('usage: queue.mjs reject <SPINE> "<the note>"');
    const t = ticket(q, key);
    if (!spinePark(t)) throw new Error(`${key} is not a feature spine parked for approval (state ${t.state})`);
    const pr = t.result?.pr;
    const dir = join(stateDir(), 'briefings');
    mkdirSync(dir, { recursive: true });
    const brief = join(dir, `${key}.md`);
    const entry = `\n${ANSWER_HEAD} (${new Date().toISOString()})\n\nThe person sent this spine's acceptance specs back: ${note}\n` +
      (pr != null ? `Your PR #${pr} on ${t.branch} stays open and in draft: fix the specs on that branch and push, rather than opening another PR.\n` : '');
    const msg = requeue(q, key);
    if (existsSync(brief)) appendFileSync(brief, entry);
    else writeFileSync(brief, `# Briefing for ${key}\n${entry}`);
    console.log(`${key} sent back with the note in its briefing; ${msg}`);
    break;
  }

  case 'set-batch': {
    for (const pair of args) {
      const i = pair.indexOf('=');
      if (i < 0) throw new Error(`expected key=value, got: ${pair}`);
      const k = pair.slice(0, i); const v = pair.slice(i + 1).trim();
      if (k === 'base') { setBase(q, v); continue; }
      setPath(q, k, coerce(v));
    }
    // A count the user set is kept as theirs: the ladder may lower `concurrency` on memory and leaves
    // `concurrency_by` alone, so `concurrency_user` is the number it raises back to.
    if (q.concurrency_by === 'user') {
      if (args.some((p) => p.startsWith('concurrency_by=')) || q.concurrency_user == null) q.concurrency_user = q.concurrency;
    } else delete q.concurrency_user;
    save(q);
    console.log(`batch: ${args.join(' ')}`);
    break;
  }

  // pass.mjs spawns eligible tickets in `.tickets` key order, so a released chain head has to move
  // to the front or it waits behind every independent ticket. A ticket the user placed stays put.
  case 'front': {
    const key = args[0];
    ticket(q, key);
    const msg = toFront(q, key);
    save(q);
    console.log(`${key} ${msg}`);
    break;
  }

  // The user's own order: put an unfinished ticket at a position among the unfinished tickets (1 is
  // spawned first), and mark it placed so a later front or requeue leaves it there.
  case 'move': {
    const [key, to] = args;
    if (!key || !to) throw new Error('usage: queue.mjs move <TICKET> <position|last>   (1 is spawned first)');
    const t = ticket(q, key);
    if (t.state === 'running') throw new Error(`${key} is running: its worker has started, so it has no place left in the spawn order`);
    if (FINISHED.includes(t.state)) throw new Error(`${key} is ${t.state}: only unfinished tickets have a place in the spawn order`);
    const order = unfinished(q);
    const n = to === 'last' ? order.length : /^\d+$/.test(to) ? Number(to) : NaN;
    if (!(n >= 1 && n <= order.length)) throw new Error(`position ${to} is out of range: give 1 to ${order.length} (the unfinished tickets), or last`);
    const rest = order.filter((k) => k !== key);
    reorder(q, [...rest.slice(0, n - 1), key, ...rest.slice(n - 1)]);
    t.placed = true;
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(`${key} moved to position ${n} of ${order.length} in the spawn order and marked placed: front and requeue leave it there`);
    break;
  }

  case 'drop': {
    const key = args[0];
    ticket(q, key);
    delete q.tickets[key];
    save(q);
    console.log(`dropped ${key} from the batch`);
    break;
  }

  case 'get':
    console.log(JSON.stringify(ticket(q, args[0]), null, 2));
    break;

  case 'list':
    console.log(JSON.stringify(q, null, 2));
    break;

  case 'render':
    console.log(render(q));
    break;

  // The orchestrator's status monitor, run under Monitor: one plain command, so starting it never
  // prompts. Prints the table and the memory line once, then again only when the table changes;
  // memory figures moving on their own print nothing. Runs until killed, like `desk-env mem watch`.
  case 'watch': {
    if (!existsSync(QUEUE)) throw new Error(`no queue at ${QUEUE}: start a batch (queue.mjs init) before watching it`);
    const i = args.indexOf('--interval');
    const intervalMs = (i >= 0 && Number(args[i + 1]) > 0 ? Number(args[i + 1]) : 90) * 1000;
    // A queue that cannot be read (gone, or hand-mangled) is shown once as its error, rather than
    // ending the monitor: the next good read prints the table again.
    const snapshot = () => { try { return render(existsSync(QUEUE) ? readQueue(QUEUE) : empty()); } catch (e) { return `queue: ${e.message}`; } };
    let last = null;
    for (;;) {
      const table = snapshot();
      if (table !== last) console.log(`${table}\n${memStatusLine()}\n`);
      last = table;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  default:
    throw new Error(`${cmd ? `unknown command "${cmd}"` : 'no command'}. usage: queue.mjs init|add|admit|hold|set|set-batch|park|requeue|approve|reject|front|move|drop|get|list|render|watch [--interval s]`);
}
} catch (e) {
  console.error(`queue: ${e.message}`);
  process.exit(EXIT.SHOW_PERSON);
}

// The status table, as one string.
function render(q) {
  const rows = Object.values(q.tickets);
  if (!rows.length) return 'queue is empty';
  const out = [];
  const order = { parked: 0, running: 1, triaged: 2, queued: 3, failed: 4, done: 5 };
  rows.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
  out.push(`batch ${q.batch ?? '-'}   concurrency ${q.concurrency}${q.epic ? `   epic ${q.epic}` : ''}${q.base ? `   base ${q.base}` : ''}\n`);
  for (const t of rows) {
    const stuck = isHeld(t) && !waitingOnMerge(q, t);
    const label = stuck ? 'STUCK' : isHeld(t) ? 'HELD' : t.state.toUpperCase();
    const spines = String(t.held_by ?? '').split('|').filter((p) => spinePark(q.tickets[p]));
    const tail = stuck ? `held behind ${String(t.held_by ?? '?').split('|').join(', ')}, which will not merge on its own (failed or parked): decide what happens to it`
      : isHeld(t) && spines.length ? `waiting on approval of spine ${spines.join(', ')}, then until ${String(t.held_by).split('|').join(', ')} merge`
      : isHeld(t) ? `until ${String(t.held_by ?? '?').split('|').join(', ')} merge${(t.open_questions ?? 0) > 0 ? ` · ${t.open_questions} question(s) open` : ''}`
      : t.state === 'parked' ? t.park?.question ?? ''
      : t.state === 'running' ? `stage ${t.stage ?? '?'}  port ${t.port ?? '-'}${t.model ? `  model ${t.model}` : ''}`
      : t.state === 'done' ? (t.result?.pr ? `PR #${t.result.pr}` : '')
      : '';
    // A tier raised by a requeue shows until the ticket finishes, so the change is visible.
    const modelNote = t.model_note && ['triaged', 'running'].includes(t.state) ? `  (${t.model_note})` : '';
    out.push(`  ${label.padEnd(8)} ${t.key.padEnd(9)} ${tail}${modelNote}`);
  }
  const parked = rows.filter((t) => t.state === 'parked' && !(isHeld(t) && waitingOnMerge(q, t))).length;
  if (parked) out.push(`\n${parked} ticket(s) waiting on you.`);
  return out.join('\n');
}
