#!/usr/bin/env node
// The autopilot queue: the orchestrator's only piece of state.
//
// Lives outside any repo so worktree churn cannot take it. Written by the orchestrator's passes, the
// merge driver and desk-q, every one through this file, which locks each change (lock() below);
// workers never touch it — their state is derived from their own logs plus `claude agents --json`.
// Created on first use; never shipped.
// Exits 0, or 11 (show the person) on any refusal or error: EXIT in batch-state.mjs.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isHeld, STOPPED_PREFIX, stoppedHold, bareHold, bareHoldText, heldBehindOf, holdsAmong, dateHeld, badLabelText, spinePark, planPark, childDone, leftPark, LEFT_PREFIX, waitingOnMerge, waitingOnPark, lanePark, designPark, sizePark, triagePark, labelPark, personStepPark, personInputPark, blockerHold, triageGate, needsSession, neverStep, EXIT, crashShowsPerson, readQueue, readTriage, openQuestion, prStatusOf, checksRerun, failedWhy, ownPr, shippedSet, keyPattern, doneOnPr, mergedCurrent } from './batch-state.mjs';
import { saveAnswer, collectAnswers } from './briefing.mjs';
import { handoffTarget, openPrOf, fetchPrHead, repointToPr, writeHandback } from './handoff.mjs';
import { prNames } from './recoveries.mjs';
import { spineMerger } from './spine-check.mjs';
import { isSpineOf, ownsSpecsOf } from './pass/shared.mjs';
import { parseClearsWhen, describeCond, CLEARS_WHEN_FORMS, runCheck, ownDraftWhy, withQuestion, personClears } from './clears-when.mjs';
import { recordMerge, recordEstimateMerge, ghMergedPrs, describe as describeHistory, sizeOf } from './desk-q-eta.mjs';
import { LIVE_MS, beatFile, parseNext } from './borrow.mjs';
import { markRearmed } from './loop-tick.mjs';
import { appendOnlyFrom, sharedFiles } from './scope-report.mjs';
import { queueFile, stateDir, wakeMergeDriver, skillsDir, concurrencyLimits, SAFE_ID, BRANCH_NAME, PRODUCTION_BRANCH, configValue, configValues, repoRoot, rotateRound, sessionDefaultMode, DONTASK_WARNING,
  ghRepo, githubHandle, ticketKind, permission, permissionKey, memStatusLine, repoSlug, worktreesDir, personStepLabels, personInputLabels, workerLocation, cloudEnvironment, isBaseRedKey, recordStop } from './desk-env.mjs';
import { placement, featureRole, runsText, handOver } from './cloud-worker.mjs';
import { lock as takeDirLock, unlock, alive, sleepSync, tryLockFile } from './dir-lock.mjs';
import { processRows, workerProcs, endProcs, targetPids } from './worker-stop.mjs';
import { writeQueueFile, versionOf, archivePath, isArchived, archivedOf, keepPrs, recordedPr } from './queue-store.mjs';
import { repoOfPr } from './pass/pr-status.mjs';
import { blockersOf } from './queue-states.mjs';
import { LEDGER_BY_ENV, queueDifference } from './queue-ledger.mjs';
import { isSha } from './ticket-ledger.mjs';
import { newPark, parkArgs, FINISHED, unfinished, toFront, layOrder, applySet, applySetBatch, LOCK_WAIT_MS } from './queue-writer.mjs';
import { followOnPending, postMergeUnmade, workerMarkers, lastStage, logStage, settleSteps, unreadableFollowOn } from './harvest.mjs';
import { workerCalls, appendDecisions, noteLine, appendNotes } from './decisions.mjs';
import { SESSION_ID, transcriptOf, claimQuestion } from './claims.mjs';
import { projectsDirs, readRegistry } from './claude-logins.mjs';
import { belongsElsewhere, useTicketBatch, listBatches, finished, otherRunningBatches, ownRows } from './batches.mjs';
import { assignPin } from './levers-auto.mjs';
import { leverOnFor } from './lever-pin.mjs';
import { QUEUE_COMMANDS, unknownQueueCommand } from './queue-commands.mjs';

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

// clears-when --check "<condition>": whether a pass reads it (clears-when.mjs runCheck, which a worker
// runs as clears-when.mjs --check). Reads no queue. Exit 0 naming what it reads as, or 1 listing the forms.
if (process.argv[2] === 'clears-when' && process.argv[3] === '--check') await runCheck(process.argv.slice(4));
const hereRepo = () => { try { return ghRepo(); } catch { return null; } };

// A command about one ticket already in a batch acts on the batch holding it (useTicketBatch). add and
// admit put a ticket in this batch, so they are not looked up.
const TICKET_CMDS = ['hold', 'set', 'local', 'park', 'clears-when', 'requeue', 'handback', 'step-done', 'follow-ran', 'approve', 'reject', 'front', 'move', 'merged', 'drop', 'drop-worktree', 'get', 'transfer', 'stop', 'finish', 'withdraw'];
{
  const [, , c, ...a] = process.argv;
  const at = a.indexOf('--claimed-by');
  if (TICKET_CMDS.includes(c)) useTicketBatch(a.filter((_, i) => at < 0 || (i !== at && i !== at + 1))[0]);
}
const QUEUE = queueFile();
// The park a hold writes (queue.mjs hold, admit --hold): released once every blocker's PR merges.
const heldPark = (blockers) => newPark(`held by orchestrator: blocked by ${blockers.join(', ')} — starts once their PRs merge`, undefined, 'hold');
// A ticket's levers pin as it enters the queue (levers-auto.mjs), saying why when its repo could not
// be assigned trial arms.
const admissionPin = (key, size) => {
  const { pin, warning } = assignPin(key, { size });
  if (warning) console.error(warning);
  return pin;
};

// The starting concurrency is config §3b "Autopilot worker concurrency" (`<default> / <cap>`); the
// orchestrator's ladder changes it per pass with set-batch, and pass.mjs never exceeds the cap. A
// count the user set carries `concurrency_by=user` (set-batch keeps their number as concurrency_user).
// Version 0: its first save writes version 1 (queue-store.mjs).
const empty = () => ({ version: 0, batch: null, concurrency: concurrencyLimits().def, tickets: {} });

function load() {
  if (!existsSync(QUEUE)) return empty();
  // A torn or hand-mangled queue must never read as "no tickets" — that would
  // silently re-spawn work that is already running.
  return readQueue(QUEUE);
}

// A command that changes the queue holds this lock from its read to its save: two read-change-writes
// that overlap would otherwise each save their own copy, and the first one's change is lost with no
// error. A directory, because creating one is atomic, with the holder's pid inside. Reads take no
// lock: save() renames atomically, so a reader always sees one whole version. transfer also holds the
// other batch's queue lock, taken the same way; save() releases every lock held.
const LOCK = `${QUEUE}.lock`;
// A positive number of milliseconds from env `name`, else `def`: anything else would turn a wait into
// forever or nothing.
const msEnv = (name, def) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : def);
// The wait is LOCK_WAIT_MS (queue-writer.mjs). The lock itself, its stale clearing and its release on exit are dir-lock.mjs's.
function lock(dir = LOCK) {
  takeDirLock(dir, { waitMs: LOCK_WAIT_MS, timeout: (pid) => new Error(`the queue is locked by pid ${pid ?? '? (no pid written yet)'}, which has held it past the ${LOCK_WAIT_MS / 1000}s wait: nothing was changed. Run this again once that process finishes; if it is stuck, stop it and the next write clears its lock (${dir})`) });
}

// Every command saves at most once, so the lock goes with the save: approve's gh call after it, or
// reject's briefing write, never keeps another writer waiting. Each save is one version higher than
// the queue it read (queue-store.mjs), and the ticket ledger names this command as its writer, or the
// process it runs for (queue-ledger.mjs LEDGER_BY_ENV: the pass).
const writeQueue = (file, q) => writeQueueFile(file, q, { by: process.env[LEDGER_BY_ENV] || `queue.mjs ${cmd}` });
function save(q) {
  writeQueue(QUEUE, q);
  unlock();
}

// A live ticket, to change. An archived one is done with its PR merged or closed: nothing about it
// changes, and admitting it again starts it over.
function ticket(q, key) {
  if (isArchived(q, key)) throw new Error(`${key} is done and archived (its PR merged or closed), so there is nothing of it to change: admit it again to start it over`);
  const t = Object.hasOwn(q.tickets, key) ? q.tickets[key] : null;
  if (!t) throw new Error(`no such ticket in the queue: ${key}`);
  return t;
}
// A ticket to read, live or archived.
function found(q, key) {
  const t = q.tickets[key];
  if (!t) throw new Error(`no such ticket in the queue: ${key}`);
  return t;
}

// A running worker as it is now, read from its log rather than the queue, which a pass updates only
// when it runs: its last stage marker since this spawn (harvest.mjs logStage, as desk-q's table reads
// it) and when the log last grew (its heartbeat). A worker spawned and silent since has the log and no
// stage; one with no log has not started.
//   -> { log, stage, said_at, heartbeat_at } (each null where there is none)
function liveOf(t) {
  const log = join(stateDir(), 'logs', `${t.key}.log`);
  let st;
  try { st = statSync(log); } catch { return { log: null, stage: null, said_at: null, heartbeat_at: null }; }
  const s = logStage(log);
  return { log, stage: s?.stage ?? null, said_at: s?.at ? new Date(s.at).toISOString() : null, heartbeat_at: new Date(st.mtimeMs).toISOString() };
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

// Lay `order` (every unfinished key, in their new order) over the unfinished slots.
function reorder(q, order) {
  const next = order[Symbol.iterator]();
  const keys = Object.keys(q.tickets).map((k) => (FINISHED.includes(q.tickets[k].state) ? k : next.next().value));
  q.tickets = Object.setPrototypeOf(Object.fromEntries(keys.map((k) => [k, q.tickets[k]])), Object.getPrototypeOf(q.tickets));
}

// A triaged ticket with triage questions open is never spawned (pass.mjs and borrow.mjs skip it), so
// every place that shows it as ready says why it is not: the table's row, front, and through front the
// merge driver's release line. The wording matches the pass report's BLOCKED ON ANSWERS.
const questionsOpen = (t) => t.open_questions ?? 0;
const answerWith = (t) => `answer with answer.mjs ${t.key} "<answer>"`;

// Send a ticket back for another worker: every field a requeue needs, not one of them left to a hand
// edit that fails silently. The last round's log, park record and mailbox move aside to one
// `.round<n>`, so pass.mjs neither refuses it as finished nor reports an old question as the new
// worker's. The branch is kept: the merge driver finds the ticket's PR by it.
// A ticket the archive check left in a finished feature batch (leftPark) runs there never again: the
// person moves it to the standing batch or drops it, whatever park it carried before.
function refuseLeft(t, key, what) {
  if (!leftPark(t)) return;
  const name = String(t.park.question).slice(LEFT_PREFIX.length).split(/\s/)[0];
  throw new Error(`${key} was left in finished batch ${name} (${t.park.question}), so it is not ${what} there: move it (node queue.mjs --batch ${name} transfer ${key} standing) or drop it`);
}

// Whether running ticket `t` is paused at a usage limit with no worker left: a session recorded, no live
// recorded pid, and no process running that session (workerProcs, the test stop uses). A ps that cannot be
// read is never taken as the worker being gone.
function pausedGone(t) {
  if (!t.usage_paused || !t.session_id || t.location === 'cloud') return false;
  if (t.pid != null && alive(Number(t.pid))) return false;
  try {
    const target = workerProcs(t.session_id, processRows());
    return !target.groups.length && !target.pids.length;
  } catch { return false; }
}

// A ticket still recorded running whose worker has exited on a park, before a pass harvested it:
// { question, since, stage, markers, notes } from its log, or null. Its worker is gone when a recorded
// pid is dead and the agent registry, read across every login, lacks its session; a registry that
// cannot be read, or a ticket with neither, is never taken as gone. Its park is the last ending marker
// the worker said after the log's last `desk_spawn` line, so a park an earlier session answered is not
// it; a log with no such line is never read as one. Its calls, notes and link requests are read from
// the whole log, as the pass reads them: a session resumed after a kill or a usage limit appends to
// the same log, and nothing harvested what it printed before. A log that asked for issue links, or a
// pass running now (its lock unreadable included), is left to the pass, which makes the links and
// would otherwise park it again behind this requeue.
function exitedOnPark(t) {
  if (t.pid == null && !t.session_id) return null;
  if (t.pid != null && alive(Number(t.pid))) return null;
  if (t.session_id) {
    const reg = readRegistry();
    if (!reg.ok || reg.live.some((a) => a.sessionId === t.session_id)) return null;
  }
  const log = join(stateDir(), 'logs', `${t.key}.log`);
  const stamp = logStamp(log);
  let text;
  try { text = readFileSync(log, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const spawned = lines.findLastIndex((l) => l.startsWith('{"type":"desk_spawn"'));
  if (spawned < 0) return null;
  const round = lines.slice(spawned + 1).join('\n');
  const end = workerMarkers(round).findLast(([k]) => ['AUTOPILOT_PARK', 'AUTOPILOT_DONE', 'AUTOPILOT_HANDOFF', 'AUTOPILOT_REBOOT'].includes(k));
  const markers = workerMarkers(text);
  if (end?.[0] !== 'AUTOPILOT_PARK' || !end[1].trim() || markers.some(([k]) => k === 'AUTOPILOT_LINK')) return null;
  if (passRunning()) return null;
  const notes = markers.filter(([k, v]) => k === 'AUTOPILOT_NOTE' && v.trim()).map(([, v]) => noteLine(t.key, v));
  return { question: end[1].trim(), since: statSync(log).mtime.toISOString(), stage: lastStage(round)?.stage ?? t.stage ?? null, markers, notes, log, logStamp: stamp };
}

const logStamp = (log) => { try { const s = statSync(log); return `${s.size}:${s.mtimeMs}`; } catch { return null; } };
function passRunning() {
  const passLock = join(stateDir(), 'orchestrator.lock');
  if (!existsSync(passLock)) return false;
  try {
    const { pid } = JSON.parse(readFileSync(passLock, 'utf8'));
    return pid !== process.ppid && alive(pid);
  } catch { return true; }
}

// Read before the queue lock (the registry read can outlast another writer's wait for it), for the
// ticket `requeue` names on the command line, as { key, session, park }.
let exitedPark = null;
// Read before the queue lock too, for the ticket `handback` or a requeue names: { key, worktree, branch, recordedPr,
// pr, fetchError }, its own open PR (handoff.mjs openPrOf), whether its head could be fetched, and the
// queue fields that chose it, checked again under the lock.
let prePr = null;
// Read before the queue lock as well, for `finish`: the PR it names, as GitHub shows it, or { error }.
let finishPr = null;

// finish <TICKET> --pr <n>: the orchestrator finished a parked ticket's last step itself (recovery's
// "a single remaining step" row), so the ticket is recorded done on its PR as the pass records one whose
// draft PR it opened: state done, the park cleared, result.pr and a summary, draft_pr while it is a draft.
// Refused unless the ticket is parked and the PR is open or merged, from this repo, on the ticket's
// branch, into the batch's base: the merge driver merges by that branch. A hold, a spine or epic plan
// park (the person's approval, never a step to finish), a park an interactive session claimed, and a
// feature spine or a child owning criteria (whose specs the pass checks only as it records it done,
// pass.mjs recordDone) are refused too.
function finish(q, key, n, pr) {
  const t = ticket(q, key);
  if (t.state === 'running') throw new Error(`${key} has a live worker (it is running), so its park is not finished yet: let it end, or stop it (queue.mjs stop ${key}): nothing recorded`);
  if (t.state !== 'parked') throw new Error(`${key} is ${t.state ?? 'in no state'}, not parked: finish records done only a parked ticket whose last step you finished`);
  if (isHeld(t)) throw new Error(`${key} is held (${t.park?.question}), not parked on a step of its own: nothing recorded`);
  if (spinePark(t) || planPark(t)) throw new Error(`${key} waits on the person's answer (${t.park.question}), not on a step to finish, so only that answer moves it on: nothing recorded`);
  if (t.park?.claim?.session) throw new Error(`${key} is claimed by interactive session ${t.park.claim.session}, which is working it: leave it to that session: nothing recorded`);
  if (isSpineOf(q, t) || ownsSpecsOf(q, t)) throw new Error(`${key} is ${isSpineOf(q, t) ? "its feature batch's spine" : 'a feature child that owns criteria'}, whose specs the pass checks when it records it done: requeue it to finish (queue.mjs requeue ${key}): nothing recorded`);
  refuseLeft(t, key, 'recorded done');
  if (pr.error) throw new Error(`gh could not read PR #${n} on ${hereRepo() ?? 'this repo'} (${pr.error})`);
  if (pr.isCrossRepository) throw new Error(`PR #${n} is from a fork, not this repo: nothing recorded`);
  if (!['OPEN', 'MERGED'].includes(pr.state)) throw new Error(`PR #${n} is ${String(pr.state).toLowerCase()}, not open or merged: nothing recorded`);
  if (t.branch && pr.headRefName !== t.branch) throw new Error(`PR #${n} is from ${pr.headRefName}, not ${key}'s branch ${t.branch}: nothing recorded`);
  const base = baseOf(q);
  if (pr.baseRefName !== base) throw new Error(`PR #${n} is into ${pr.baseRefName}, not this batch's base ${base}: nothing recorded`);
  const was = String(t.park?.question ?? '').split('\n')[0].slice(0, 120);
  applySet(t, [...doneOnPr(n, { draft: pr.isDraft, summary: `PR #${n}: its last step finished by the orchestrator, after the worker parked${was ? ` (${was})` : ''}` }),
    ...(t.branch ? [] : [`branch=${pr.headRefName}`])]);
  save(q);
  return `${key} recorded done on PR #${n} (${pr.isDraft ? 'a draft' : pr.state.toLowerCase()}, ${pr.headRefName} into ${base}): no longer parked`;
}

// withdraw <TICKET> "<why>": a fix try the pass queued (its `fix`, the ticket triaged for it) that no
// worker has started, taken back, because what it was for is settled outside a worker (a gap the
// orchestrating session closed, say). The ticket goes back to done on its PR and `fix` is cleared. The
// try stays in `fix_tries`, marked `withdrawn` with why, so it counts against none of the PR's tries
// (fix-tries.mjs ownCount); a withdrawn review try also holds its head (withdrawnAt), so no review try
// is drafted there again until a push, a clean review or the person's fix moves it. Refused for a running worker (stop it first), for
// a ticket with no queued fix try, and while a pass runs, which may be spawning it.
function withdraw(q, key, why) {
  const t = ticket(q, key);
  if (t.state === 'running') throw new Error(`${key} is running: its fix try has started. Stop it (queue.mjs stop ${key}) if it is no longer wanted: nothing withdrawn`);
  if (t.state !== 'triaged' || !t.fix || t.fix.finished) throw new Error(`${key} is ${t.state ?? 'in no state'}${t.fix ? '' : ' with no fix try'}, so no queued fix try is there to withdraw: nothing withdrawn`);
  const pr = t.fix.pr ?? t.result?.pr ?? null;
  if (pr == null) throw new Error(`${key}'s fix try names no PR to go back to: nothing withdrawn`);
  // A pass under way may already have picked the try to spawn. Its state=running write refuses a
  // ticket done since (set --unless state=done), so none starts; this says so before anything is changed.
  if (passRunning()) throw new Error(`a pass is running, and may be spawning ${key}'s fix try: run queue.mjs withdraw ${key} again once it ends (a try it spawns meanwhile is stopped with queue.mjs stop ${key}): nothing withdrawn`);
  const f = t.fix;
  const at = new Date().toISOString();
  const mark = { withdrawn: at, withdrawn_why: why };
  // The entry the pass wrote for this try, as unrunFields (fix-tries.mjs) finds it.
  const own = (x) => x.at === f.at && x.kind === f.kind && !x.finished;
  const tries = t.fix_tries ?? [];
  const kept = tries.some(own) ? tries.map((x) => (own(x) ? { ...x, ...mark } : x))
    : [...tries, { try: f.try ?? null, head: f.head ?? null, kind: f.kind, what: f.what, at: f.at ?? at, ...mark }];
  Object.assign(t, { state: 'done', fix: null, fix_tries: kept, updated_at: at });
  save(q);
  return `${key}: its queued fix try${f.try ? ` ${f.try}` : ''} on PR #${pr} (${f.what ?? f.kind ?? 'fix'}) withdrawn: no worker is spawned for it, it counts against none of the PR's tries${f.kind === 'review' ? `, and no review try is drafted again at its head ${String(f.head ?? '?').slice(0, 12)}` : ''}: ${why}`;
}

// A requeued ticket whose recorded PR is open on another branch goes back on that branch, so its worker
// is spawned on, and may push, the PR's head: the worktree moves onto it and the queued branch is kept
// as a backup ref, unless that branch holds commits the PR's head lacks. The PR was read and fetched
// before the queue lock (prePr). Returns the clause the requeue line adds.
function repointRequeued(t, key) {
  const pre = prePr?.key === key ? prePr : null;
  if (!pre?.pr?.recorded) return '';
  if (pre.worktree !== t.worktree || pre.branch !== t.branch || pre.recordedPr !== ownPr(t)) {
    return `; its worktree, branch or recorded PR changed while its PR #${pre.pr.number} was being read, so its branch ${t.branch} was left as it was`;
  }
  const moved = repointToPr({ worktree: t.worktree, branch: t.branch, pr: pre.pr, fetchError: pre.fetchError });
  if (moved?.why) return `; left on its branch ${t.branch}: ${moved.why}`;
  if (!moved?.branch) return '';
  const was = t.branch;
  t.branch = moved.branch;
  return `; its branch ${was} re-pointed to its open PR #${pre.pr.number}'s ${moved.branch}${moved.backup ? `, the old one kept as ${moved.backup}` : ''}`;
}

// A ticket requeued after its PR merged keeps that PR as merged_pr from the requeue on, as its spawn does
// (keepPrs, queue-store.mjs; pass.mjs keepMergedPr folds it in again by repo), so the merge driver holds
// what waits on it until its next PR merges whatever happens before a worker spawns: a park, a failed spawn.
const keepRequeuedPr = (t) => {
  const kept = keepPrs(t);
  return kept ? { merged_pr: kept } : {};
};

// Which of `keys`, ticket t's blockers, still hold it: one in the batch whose current work has not merged,
// as the merge driver reads it (batch-state.mjs mergedCurrent), or one in no batch that its held_outside names.
const unmergedBlockers = (q, t, keys) => {
  const outside = String(t.held_outside ?? '').split('|');
  return keys.filter((p) => (q.tickets[p] ? !mergedCurrent(q.tickets, p) : outside.includes(p)));
};

function requeue(q, key, { handedBack = false } = {}) {
  const t = ticket(q, key);
  // Recorded parked as a pass's harvest records it, with the round a fresh spawn may resume and the
  // calls and notes the worker logged, before the requeue moves its log aside.
  let harvested = '';
  let calls = null;
  let p = null;
  let pausedWip = null;
  if (t.state === 'running') {
    // Read again under the lock: a resume of the same session since appends to the log, and a pass
    // started since would harvest it too.
    p = exitedPark?.key === key && exitedPark.session === (t.session_id ?? null) ? exitedPark.park : null;
    if (p && (logStamp(p.log) !== p.logStamp || passRunning())) p = null;
    if (!p && t.location === 'cloud' && t.cloud && !t.session_id) throw new Error(`${key} is running in a cloud session: queue.mjs stop ${key} first, which records the session abandoned, or it gets a second one`);
    // A worker paused at a usage limit whose process is gone: no pass records how it ended, as it waits to
    // resume on its own login, and stop finds nothing to end. The person sends it to a fresh worker on
    // whichever login the next spawn picks, its worktree committed first as stop commits it.
    if (!p && pausedGone(t)) {
      // The pass lock, held until this process exits (after the save), so no pass starts meanwhile and
      // resumes the old session over this requeue. Never waited for under the queue lock, which a pass
      // may be waiting on: a pass running now refuses it. One that ran this requeue itself holds it.
      const holder = tryLockFile(join(stateDir(), 'orchestrator.lock'), { by: `queue.mjs requeue ${key}` });
      if (holder !== true && holder !== process.ppid) throw new Error(`${key} is paused at a usage limit with no worker process, but a pass is running now and may resume it: requeue it again once the pass has finished`);
      pausedWip = commitStopped(t.worktree ?? join(worktreesDir(), key), key, t.branch, 'its worker, paused at a usage limit, was gone and queue.mjs requeue sent it to a new one');
    } else if (!p && t.usage_paused && t.session_id && t.location !== 'cloud') {
      throw new Error(`${key} is paused at a usage limit, but its worker is still live (a process runs its session ${t.session_id}, or none could be checked): stop it first (queue.mjs stop ${key}), or it gets a second one`);
    } else if (!p) throw new Error(`${key} is running: stop its worker first, or it gets a second one`);
  }
  if (t.state === 'running' && p) {
    calls = workerCalls(p.markers, { ticket: key, run: t.session_id, repo: ghRepo(), pr: null });
    Object.assign(t, { state: 'parked', park: newPark(p.question, p.since), last_round: { stage: p.stage, question: p.question, at: p.since } });
    harvested = `; its worker had exited on a park no pass had recorded yet, kept as prev_park: ${p.question}`
      + `${calls.unreadable.map((u) => `; unreadable ${u.what} (${u.why}), nothing logged: ${u.raw}`).join('')}`;
  }
  // A cloud ticket stopped by queue.mjs stop has no worker or worktree here: a requeue is the person
  // letting it start again with a new session, as needs-you's start does (stopCloud).
  // Pinned local after the stop (location=local, issue-1689), it starts again in a local worker, and
  // unpinned (location=auto) placement at start decides: only stopCloud writes cloud.abandoned_at.
  const cloudStopped = t.cloud?.abandoned_at && stoppedHold(t);
  if (bareHold(t)) throw new Error(`${key} is ${bareHoldText(key)}, rather than requeue it`);
  if (isHeld(t) && !cloudStopped) throw new Error(`${key} is held behind ${blockersOf(t).join(', ') || '?'}: release it rather than requeue it`);
  refuseLeft(t, key, 'requeued');
  // pass.mjs spawns any triaged ticket with no open questions and never reads the lane, so this is
  // the one place an untriaged ticket, unanswered triage questions, a triage park (size, a
  // dependency cycle), a lane C, or a lane D parked on its design would slip by. A worker's own park never has open questions:
  // it spawned only once they reached 0.
  if (t.state === 'queued') throw new Error(`${key} has not been triaged: triage it and \`queue.mjs admit\` it`);
  if ((t.open_questions ?? 0) > 0) throw new Error(`${key} has ${t.open_questions} triage question(s) open: answer them first`);
  if (t.state === 'parked' && /^(size |dependency cycle:)/.test(String(t.park?.question ?? ''))) throw new Error(`${key} was parked at triage (${t.park.question}): split it or fix the links, not requeue it`);
  if (personStepPark(t)) throw new Error(`${key} is the person's own step (${t.park.question}): no worker takes it. Once the step is taken, mark it Done and \`queue.mjs drop ${key}\``);
  if (t.state === 'parked' && t.park?.session_step) throw new Error(`${key} waits on a step the person approved that no worker can run (${t.park.session_step.step}): do it in an interactive session, then \`queue.mjs step-done ${key}\` sends it back to a worker`);
  // A lane D ticket handed back (handback) had its session step done by the person, so its design park
  // no longer keeps it from a worker. A lane C one is moved to lane B first.
  if (!handedBack && t.lane === 'D' && needsSession(t)) throw new Error(`${key} was parked at triage on its design (${t.park.question}): once its canvas is saved on the base, run triage.sh ${key} again and re-plan (plan-batch.mjs)`);
  // An adopted PR (queue.mjs adopt) has no worktree or ticket for a worker: what holds it is the PR's own.
  if (t.adopted) throw new Error(`${key} is PR #${t.result?.pr ?? '?'}, adopted with no ticket, so no worker takes it: undraft it, review it or fix its checks on the PR itself, and the merge driver merges it once it is green`);
  if (!['A', 'B', 'D', 'E'].includes(t.lane)) throw new Error(`${key} is lane ${t.lane ?? '?'}, and only lanes A, B and E, and D with its canvas saved, go to a headless worker. Only if the user rules the lane wrong: queue.mjs set ${key} lane=<A, B or E>, then requeue`);
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
  // After the round's files move, which can throw: from here only the queue write can fail, and a requeue
  // run again after it finds the worktree on the PR's branch and records it.
  const repointed = handedBack ? '' : repointRequeued(t, key);
  // A ticket whose sessions handed off starts again at the stage the last handoff named, in its
  // worktree, rather than at Stage 0 (pass.mjs spawnHandoff). `handoff_stage=null` first starts it over.
  const fromStage = t.handoff_stage ?? null;
  // The park this requeue clears, and which park in a row it was, so the decider can tell when the
  // next worker parks the same way again (decider.mjs deciderItems). A requeue that clears no park (a
  // fix try, a failed worker) ends the run: the next park is not asking again. So does one that clears
  // a stall: the pass parked it, the worker asked nothing.
  const prevPark = t.state === 'parked' && t.park?.question && !wedged
    ?{ question: String(t.park.question), since: t.park.since ?? null, requeued_at: new Date().toISOString(), round: (t.prev_park?.round ?? 0) + 1 }
    : null;
  // A ticket admitted parked on its design kept its blockers in held_by (admit): it goes back behind the
  // ones not yet merged, never straight to a worker. A released hold clears held_by, so nothing else
  // leaves one on a ticket that is not held.
  // Blockers in no batch (held_outside) stay until pass.mjs lifts them.
  const outside = String(t.held_outside ?? '').split('|').filter((p) => p && !q.tickets[p]);
  // A blocker merged once and gone round again since has not merged its current work: it holds this ticket still.
  const pending = unmergedBlockers(q, t, blockersOf(t));
  // Done by another's PR, its merged_at was that PR's merge: sent back for work of its own, it has none
  // yet, or the merge driver and the holds above would read the work as merged.
  const byOther = t.done_by?.pr != null;
  // A fresh session, so a killed worker waiting to resume no longer does.
  Object.assign(t, keepRequeuedPr(t), { prev_park: prevPark, ...(byOther ? { merged_at: null } : {}), state: pending.length ? 'parked' : 'triaged', open_questions: 0, park: pending.length ? heldPark(pending) : null, held_by: pending.join('|') || null, ...(t.held_outside ? { held_outside: outside.join('|') || null } : {}), session_id: null, pid: null, idle_passes: 0, log_bytes: 0, resume: null, resume_why: null, usage_paused: null, login_move: null, failed: null,
    handoff: fromStage ? 'pending' : null,
    // Done by another's PR no longer, once sent back for work of its own.
    spine_check: null, spec_check: null, approved: null, approved_at: null, done_by: null,
    // A red-base repair the pass closed as needless is owed its own work again, so what it commits next is pushed.
    ...(t.closed_superseded ? { closed_superseded: null } : {}),
    // A cloud ticket with no PR from its session starts a new one: the old session, abandoned when it was
    // stopped, is on the finished-session list (stopCloud), not this ticket.
    ...(t.location === 'cloud' && t.cloud && t.cloud.pr_at == null && t.result?.pr == null ? { cloud: null } : {}),
    // When it came back: desk-q's no-progress clock counts this ticket from here, not from added_at.
    requeued_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const placed = toFront(q, key);
  if (calls?.entries.length) appendDecisions(calls.entries, stateDir());
  if (p?.notes.length) appendNotes(p.notes, stateDir());
  save(q);
  if (pausedWip?.error) process.exitCode = EXIT.SHOW_PERSON;
  const wip = !pausedWip ? '' : `; its worker, paused at a usage limit, was gone: its work so far is ${keptText(pausedWip)}, and a new worker starts on whichever login the next spawn picks`;
  return `${key} requeued: ${placed}${wip}${harvested}${repointed}${pending.length ? `; held behind ${pending.join(', ')} until they merge` : ''}${fromStage ? `; it starts again at Stage ${fromStage}, where its last session was handed off` : ''}${bumped}${moved.length ? `; moved aside: ${moved.join(', ')}` : ''}${undrafted}`;
}

// A lane C or D park whose step the person has done (desk-needs-you's resume on a session item), handed
// back to a worker: it starts at Stage 4b in its worktree, on its branch, with what the person did in
// its handoff briefing and, as a binding answer, in its briefing. Only the lane guards of requeue are
// skipped: the person's step was the one a worker could not take.
function handback(q, key, note) {
  const t = ticket(q, key);
  if (t.state !== 'parked' || isHeld(t) || spinePark(t) || planPark(t)) throw new Error(`${key} is not parked on a step of its own (state ${t.state}), so there is nothing to hand back`);
  if (!needsSession(t)) throw new Error(`${key}'s park is not one only a session takes (${t.park?.question ?? '?'}): requeue it instead`);
  // A worker parked mid-build on a step no worker is allowed: a session starting at self-review would
  // skip the rest of its build.
  const never = neverStep(String(t.park?.question ?? ''));
  if (never) throw new Error(`${key} parked mid-build on ${never}, which no worker is allowed, so a worker starting at self-review would skip the rest of its build. Finish it in an interactive session: /desk-ticket ${key}`);
  let missing = handoffTarget({ worktree: t.worktree, branch: t.branch });
  // Its own open PR on another branch is where its work is: the worktree moves onto that branch, the
  // queued one kept as a backup, unless the queued one holds commits the PR does not. The PR was read
  // and fetched before the queue lock (prePr).
  let repointed = '';
  const pre = prePr?.key === key ? prePr : null;
  if (pre && (pre.worktree !== t.worktree || pre.branch !== t.branch || pre.recordedPr !== ownPr(t))) {
    throw new Error(`${key}'s worktree, branch or recorded PR changed while its PR was being read, so nothing was handed back: run this again`);
  }
  // With the queued branch in place, a PR none recorded is taken only when its head branch names the
  // ticket: a title can mention another ticket's key.
  const found = pre?.pr ?? null;
  const pr = found && (found.recorded || missing || prNames(key)({ headRefName: found.head })) ? found : null;
  const moved = repointToPr({ worktree: t.worktree, branch: t.branch, pr, fetchError: pre?.fetchError });
  // A PR found only by naming the ticket does not outrank a queued branch that is in place with work of
  // its own: that one is handed back as before.
  const unrecordedOverWork = moved?.ahead && !missing && !pr.recorded;
  if (moved?.why && !unrecordedOverWork) throw new Error(`${key}: ${moved.why}. Finish it in an interactive session: /desk-ticket ${key}`);
  if (moved?.branch) {
    repointed = `; its branch ${t.branch} re-pointed to its open PR #${pr.number}'s ${moved.branch}${moved.backup ? `, the old one kept as ${moved.backup}` : ''}`;
    t.branch = moved.branch;
    missing = handoffTarget({ worktree: t.worktree, branch: t.branch });
  }
  if (missing) throw new Error(`${key}: ${missing}, so no worker can start it at Stage 4b. Finish it in an interactive session: /desk-ticket ${key}`);
  const at = new Date().toISOString();
  const was = { handoff_stage: t.handoff_stage, lane: t.lane };
  // A lane C ticket goes on as lane B, or every later requeue (a fix, an answered park) would refuse
  // it on its lane and its parks would read as session items again. A lane D one leaves its design
  // park behind with the requeue, so it needs no change.
  Object.assign(t, { handoff_stage: '4b', ...(t.lane === 'C' ? { lane: 'B' } : {}) });
  let msg;
  try { msg = requeue(q, key, { handedBack: true }); } catch (e) {
    Object.assign(t, was);
    // The worktree has already moved, so the queue records where it now is even though nothing is requeued.
    if (repointed) { save(q); e.message += `. Not requeued, but${repointed.slice(1)}, and the queue records it`; }
    throw e;
  }
  // After the requeue, so a refused one leaves an earlier handoff briefing as it was.
  const path = writeHandback(stateDir(), { key, lane: was.lane, note, at });
  saveAnswer(stateDir(), key, `The person did the step this ticket parked for an interactive session on, and handed it back: ${note}`, at);
  return `${key} handed back to a worker that starts at Stage 4b (self-review), with the note in ${path} and its briefing${was.lane === 'C' ? '; lane C → B, since its session step is done' : ''}${repointed}; ${msg.replace(/; it starts again at Stage 4b, where its last session was handed off/, '')}`;
}

// queue.mjs stop: one running ticket's worker ended, what its worktree holds committed on its branch,
// and the ticket held behind no blocker, so nothing starts it until the person lets it (needs-you's
// start, which sets it triaged): its next worker then starts in the same worktree on the same branch, at
// the stage this one reached. It holds the pass's own lock from its first read to its save, waiting for
// a pass running now: a pass that read the ticket as running would record the ended worker as killed and
// resume it over the hold. The wait has no limit unless DESK_STOP_PASS_WAIT_MS sets one; a dead holder
// frees it.
const STOP_PASS_WAIT_MS = msEnv('DESK_STOP_PASS_WAIT_MS', Infinity);
const STOP_GRACE_MS = msEnv('DESK_STOP_GRACE_MS', 10_000);

// Takes orchestrator.lock the way pass.mjs claim() does (tryLockFile), so a pass starting meanwhile
// refuses; it goes when this process exits.
function claimPassLock(key) {
  const file = join(stateDir(), 'orchestrator.lock');
  for (const until = Date.now() + STOP_PASS_WAIT_MS; ;) {
    const pid = tryLockFile(file, { by: `queue.mjs stop ${key}` });
    if (pid === true) return;
    if (pid === process.ppid) throw new Error(`queue.mjs stop ${key} was run by the pass holding the pass lock (pid ${pid}), which it would wait on forever: run it outside a pass. Nothing was changed`);
    if (Date.now() >= until) throw new Error(`a pass is running (pid ${pid ?? '?'}) and did not finish within ${STOP_PASS_WAIT_MS / 1000}s, so nothing was stopped: run queue.mjs stop ${key} again once it has`);
    sleepSync(500);
  }
}

// Exit 2 for a key the queue does not hold, as the command line's own mistake rather than a refusal.
class NoTicket extends Error { exit = 2; }

// Commit everything in worktree `wt` but desk's own `.claude/` files (setup-worktree.sh leaves agent links
// and a disabled settings file there); ignored files stay out, as git add leaves them.
// -> { sha } | { nothing: why } | { error: why }
function commitStopped(wt, key, branch, why = 'queue.mjs stop ended its worker') {
  if (!wt || !existsSync(wt)) return { nothing: `it has no worktree${wt ? ` at ${wt}` : ''}` };
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const status = git('status', '--porcelain');
    if (!status) return { nothing: 'its worktree was clean' };
    const mid = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].find((p) => existsSync(resolve(wt, git('rev-parse', '--git-path', p))));
    if (mid || /^(DD|AU|UD|UA|DU|AA|UU) /m.test(status)) return { error: `its worktree ${wt} is mid ${mid ? mid.replace(/_HEAD$|-.*$/, '').toLowerCase() : 'merge'} with conflicts or an operation in progress, so nothing was committed: its changes are left in place` };
    git('add', '-A', '--', '.', ':(exclude).claude');
    try { git('diff', '--cached', '--quiet'); return { nothing: 'its worktree held only desk\'s own .claude files' }; } catch { /* staged changes to commit */ }
    git('commit', '--no-verify', '-q', '-m', `wip(${key}): work in progress when ${why}`);
    return { sha: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') || branch };
  } catch (e) {
    return { error: `committing in ${wt} failed (${String(e.stderr || e.message).trim().split('\n').pop()}): its changes are left in place` };
  }
}

// What commitStopped's result `c` kept, for the line that reports it.
const keptText = (c) => (c.sha ? `committed as ${c.sha.slice(0, 12)} on ${c.branch}` : c.nothing ? `nothing to commit (${c.nothing})` : `not committed: ${c.error}`);

function stop(key) {
  claimPassLock(key);
  // Read without the queue lock, as every reader does; it is taken only for the write, so ending the
  // worker never keeps another writer waiting past its own wait.
  const t = load().tickets[key];
  if (!t) throw new NoTicket(`no such ticket in the queue: ${key}. Nothing was changed`);
  if (t.state !== 'running') throw new Error(`${key} has no running worker (it is ${t.state}): nothing was changed`);
  if (t.location === 'cloud' && t.cloud && !t.session_id) return stopCloud(key, t);
  if (!t.session_id) throw new Error(`${key} has no running worker that can be found: it records no session id. Nothing was changed`);
  const target = workerProcs(t.session_id, processRows());
  if (!target.groups.length && !target.pids.length) throw new Error(`${key} has no running worker: no process runs its session ${t.session_id}, so the next pass records how it ended. Nothing was changed`);
  const log = join(stateDir(), 'logs', `${key}.log`);
  let round = '';
  try {
    const lines = readFileSync(log, 'utf8').split('\n');
    round = lines.slice(lines.findLastIndex((l) => l.startsWith('{"type":"desk_spawn"')) + 1).join('\n');
  } catch { /* no log: the stage recorded on the ticket */ }
  if (workerMarkers(round).some(([k]) => k === 'AUTOPILOT_DONE')) throw new Error(`${key}'s worker has already printed AUTOPILOT_DONE, so the next pass records it done and stops its session: nothing was changed`);
  // Recorded before any signal goes, so the memory watch never reads the exit 137 its SIGKILL leaves in
  // the worker's log as an OOM kill (desk-env.mjs harmStep); a record that cannot be written stops nothing.
  const pids = targetPids(target, processRows());
  try { recordStop(stateDir(), { key, at: Date.now(), pids }); } catch (e) { console.error(`queue.mjs stop ${key}: the stop could not be recorded for the memory watch (${e.message}), so it may read the stopped worker as killed for memory and hold spawns for 10m`); }
  const ended = endProcs(target, { graceMs: STOP_GRACE_MS });
  if (ended.left.length) throw new Error(`${key}'s worker did not end: pid ${ended.left.join(', ')} still alive after SIGTERM and SIGKILL. Nothing in the queue was changed`);
  const wt = t.worktree ?? join(worktreesDir(), key);
  const c = commitStopped(wt, key, t.branch);
  const at = new Date().toISOString();
  const kept = keptText(c);
  const stage = lastStage(round)?.stage ?? t.stage ?? null;
  // The worker is gone and no pass can start, so the hold must land: wait for the queue lock as long as
  // its holder lives (dir-lock clears a dead one's).
  takeDirLock(LOCK, { waitMs: Infinity });
  const q = load();
  const now = q.tickets[key];
  if (now?.state !== 'running' || now.session_id !== t.session_id) {
    unlock();
    throw new Error(`${key}'s worker (pid ${ended.ended.join(', ')}) ended and its work so far is ${kept}, but the queue changed meanwhile (${key} is now ${now?.state ?? 'not in the queue'}), so its record was left as it is`);
  }
  Object.assign(now, { state: 'parked', park: newPark(`${STOPPED_PREFIX} at ${at}; its work so far is ${kept}. Starts again only once you let it`, at, 'stopped'),
    // held_outside a release left behind would let pass.mjs's outside-hold lift release the stop.
    held_by: null, held_outside: null, last_round: stage ? { stage, question: `stopped by queue.mjs stop; its work so far is ${kept}`, at } : now.last_round ?? null,
    session_id: null, pid: null, resume: null, resume_why: null, usage_paused: null, idle_passes: 0, updated_at: at });
  save(q);
  if (c.error) process.exitCode = EXIT.SHOW_PERSON;
  return `${key} stopped: its worker (pid ${ended.ended.join(', ')}) ended; ${kept}; ${key} is held, and starts again only once you let it (needs-you: start)`;
}

// A ticket worked in a cloud session has no process here to end: nothing on this computer can end or
// archive a cloud session either (cloud-worker.mjs), so its session is recorded abandoned
// (`cloud.abandoned_at`) and handed to the repo's finished-session list (handOver), where needs-you asks
// the person to archive it, and the ticket is held as a stopped local worker is. A requeue then starts it
// with a new session (requeue). Whatever the session pushes after this is on its branch for that one.
function stopCloud(key, t) {
  const c = t.cloud ?? {};
  const where = c.url ?? c.session ?? '(its session URL was not recorded)';
  takeDirLock(LOCK, { waitMs: Infinity });
  const q = load();
  const now = q.tickets[key];
  if (now?.state !== 'running' || now.location !== 'cloud' || now.session_id || JSON.stringify(now.cloud ?? null) !== JSON.stringify(t.cloud)) {
    unlock();
    throw new Error(`${key} changed while it was being stopped (it is now ${now?.state ?? 'not in the queue'}), so its record was left as it is. Nothing was changed`);
  }
  const at = new Date().toISOString();
  Object.assign(now, { state: 'parked', park: newPark(`${STOPPED_PREFIX} at ${at}; its cloud session ${where} is recorded abandoned (nothing here can end a cloud session: archive it in claude.ai/code). Starts again only once you let it`, at, 'stopped'),
    cloud: { ...c, abandoned_at: at }, held_by: null, held_outside: null,
    last_round: { stage: now.stage ?? 'cloud', question: `stopped by queue.mjs stop; its cloud session ${where} recorded abandoned`, at },
    resume: null, resume_why: null, usage_paused: null, idle_passes: 0, updated_at: at });
  save(q);
  let listed = '';
  if (c.session && c.url) {
    try { handOver(stateDir(), [{ key, session: c.session, name: c.name ?? null, url: c.url, at }]); listed = '; needs-you asks you to archive it'; } catch (e) { listed = `; it could not be put on needs-you's archive list (${e.message})`; process.exitCode = EXIT.SHOW_PERSON; }
  }
  return `${key} stopped: its cloud session ${where} is recorded abandoned, as nothing here can end one${listed}; ${key} is held, and starts again only once you let it (needs-you: start), with a new session`;
}

// A step the person approved that no worker can run (park.session_step, answer.mjs), done by them:
// the ticket goes back to a worker as a requeue sends it, with the step in its briefing as done.
function stepDone(q, key) {
  const t = ticket(q, key);
  const s = t.park?.session_step;
  if (t.state !== 'parked' || !s?.step) throw new Error(`${key} is not waiting on an approved step no worker can run, so there is no step to record done`);
  delete t.park.session_step;
  let msg;
  try { msg = requeue(q, key); } catch (e) { t.park.session_step = s; throw e; }
  saveAnswer(stateDir(), key, `The person ran the step you approved and no worker can run, and it is done: ${s.step}. Do not run it again or park for it; carry on from there.`, new Date().toISOString());
  return `${key}: the approved step is recorded done (${s.step}); ${msg}`;
}


// What a ticket joining feature batch `q` waits for, as plan-batch holds every child it seeds: its epic
// while that is parked on its drafted plan (epic-plan.mjs), and its spine until that is done.
const spineHolds = (q, key) => [
  ...(q.batch && q.batch !== key && planPark(q.tickets[q.batch]) ? [q.batch] : []),
  ...(q.feature === true && q.spine && q.spine !== key && q.tickets[q.spine] && q.tickets[q.spine].state !== 'done' ? [q.spine] : []),
];

// Put triaged ticket `key` into queue `q` from its triage record `r`, the way plan-batch seeds one, and
// say how it stands. `state` holds the triage records of q's tickets. `holds` (its blockers in q) gains
// q's spine and plan holds when `holdSpine` is set. `outside`, its blockers in no batch, are held too
// and recorded as held_outside: pass.mjs lifts each once it is Done and on the batch's base. `mergeAfter`, the person's steps in no
// batch, hold nothing until its PR is ready: recorded as merge_after, they hold only its merge.
// `pin` is its levers pin (lever-pin.mjs), drawn as it is admitted (levers-auto.mjs) unless it carries
// one already.
function admitInto(q, key, r, { state, by = null, holds = [], outside = [], mergeAfter = [], holdSpine = false, pin }) {
  if (holdSpine) holds.unshift(...spineHolds(q, key).filter((k) => !holds.includes(k)));
  const size = String(r.size ?? '').toUpperCase();
  // A ticket labelled as the person's step is theirs whatever its lane or size: no worker takes it.
  const stepPark = labelPark(r, personStepLabels(), personInputLabels());
  const park = stepPark ?? lanePark(r) ?? designPark(r) ?? sizePark(size);
  const unknowns = (r.unknowns ?? []).length + (r.facts_error ? 1 : 0);
  // The collision check plan-batch makes, against every ticket still to finish, recorded both ways for
  // the plan and desk-q. It holds nothing: pass.mjs works out the per-file budget at spawn time from
  // the triage records of the tickets running then. The person's step runs on no worker, so it
  // collides with nothing. A file §4 Append-only paths covers is only added to, so sharing it is no
  // collision.
  const mine = stepPark ? [] : r.files_in_scope ?? [];
  const { globs: appendOnly } = appendOnlyFrom(() => configValues('append-only-paths'));
  const collides = [];
  for (const [k, other] of Object.entries(q.tickets)) {
    if (['done', 'failed'].includes(other.state) || personStepPark(other)) continue;
    if (!existsSync(join(state, 'triage', `${k}.json`))) continue;
    const files = readTriage(state, k).files_in_scope ?? [];
    if (sharedFiles(mine, files, appendOnly).length) {
      collides.push(k);
      other.collides_with = [...new Set([...String(other.collides_with ?? '').split('|').filter(Boolean), key])].join('|');
    }
  }
  for (const k of outside) if (!holds.includes(k)) holds.push(k);
  // Config §3b "Worker location", applied as plan-batch applies it to each ticket it seeds, the effort
  // lever read from the ticket's pin (the row where it has none), as plan-batch reads it. The row is
  // read before the pin is drawn, so a bad row refuses the admit before any trial arm is drawn.
  const location = workerLocation();
  // §3b "Cloud environment" likewise: what it provides no longer keeps a ticket local.
  const cloudEnv = location === 'cloud' ? cloudEnvironment() : null;
  if (pin === undefined) pin = admissionPin(key, r.size);
  const placed = placement(r, location, {
    feature: featureRole(q.feature === true ? { spine: q.spine, owners: q.owners } : null, key),
    effort: location === 'cloud' && leverOnFor('effort', { key, levers: pin }),
    env: cloudEnv,
  });
  // A held park would let a release send a ticket parked for its own reason to a worker. A lane, size,
  // design or person's-step park keeps its holds in held_by beside it instead, unreleased, and requeue
  // holds it behind the open ones once its own park is settled.
  q.tickets[key] = {
    key, type: r.type ?? 'Bug', lane: r.lane, state: park || holds.length ? 'parked' : 'triaged',
    worktree: null, branch: r.branch ?? null, database: null, port: null,
    session_id: null, pid: null, base_sha: null, stage: null,
    park: park ? newPark(park) : holds.length ? heldPark(holds) : null, log: null, result: null,
    collides_with: collides.join('|') || null, open_questions: unknowns, held_by: holds.join('|') || null,
    ...(outside.length ? { held_outside: outside.join('|') } : {}),
    ...(mergeAfter.length ? { merge_after: mergeAfter.join('|') } : {}),
    ...(by ? { admitted_by: by } : {}),
    ...(pin ? { levers: pin } : {}),
    // Whether it can run in a cloud session; where it does is decided when it starts (pass/shared.mjs placeAtStart).
    ...(placed.where === 'cloud' ? { cloud_ok: true } : {}),
    added_at: new Date().toISOString(),
  };
  const merges = mergeAfter.length ? `; merges only once ${mergeAfter.join(', ')} ${mergeAfter.length === 1 ? 'is' : 'are'} Done` : '';
  const runs = location === 'cloud' ? `; ${runsText(placed)}` : '';
  return `${park && holds.length ? `${park}; then held behind ${holds.join(', ')}` : holds.length ? `held behind ${holds.join(', ')}` : park ?? `triaged${unknowns ? `, ${unknowns} question(s) open` : ''}`}${merges}${runs}`;
}

// The holds each lane, size or design park in `q` with no held_by should carry beside its park: its
// triage record's blockers held as intake holds a ticket it admits (holdsFor, passed in), less those in
// the batch already finished (merged, or done with no PR), which nothing would release. One that failed
// in the batch is named and not held, for the same reason. One already waiting behind the park, counting
// the holds this run adds to the parks before it, is left out, as a hold on it would be a cycle.
// -> [{ key, holds, outside, cycles, failed, park }], one per park that gains a hold or skips one.
function missingHolds(q, holdsFor) {
  const view = structuredClone(q);
  const found = [];
  for (const t of Object.values(q.tickets)) {
    if (!triagePark(t) || personStepPark(t) || blockersOf(t).length) continue;
    if (!existsSync(join(stateDir(), 'triage', `${t.key}.json`))) continue;
    const h = holdsFor(readTriage(stateDir(), t.key), q.tickets, baseOf(q));
    const { holds, cycles, outside } = holdsAmong(t.key, [...h.held, ...h.outside], q.tickets, heldBehindOf(view, t.key, { merges: true }));
    if (holds.length) view.tickets[t.key].held_by = holds.join('|');
    if (holds.length || cycles.length || h.failed.length) found.push({ key: t.key, holds, outside, cycles, failed: h.failed, park: t.park.question });
  }
  return found;
}

const batchWord = (b) => (b.name ? `batch ${b.name}` : 'the standing batch');
const baseOf = (bq) => bq.base ?? configValue('default-branch') ?? 'main';
const otherRunning = () => otherRunningBatches(repoSlug(), QUEUE, () => baseOf({}));

// The worktree `wt`: removed with its local branch when `held` finds no work in it. `held` gets its
// uncommitted or untracked paths (`dirty`), its `branch` (`HEAD` when detached) and a `lines` reader of
// git output in it, and returns what it holds. -> the path removed, or null when there is none. Throws
// `refusal(holds)`, removing nothing, when it holds work or git cannot read it.
function removeWorktree(wt, held, refusal) {
  if (!existsSync(wt)) return null;
  const lines = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
  const holds = [];
  let branch = 'HEAD';
  try {
    const dirty = lines('status', '--porcelain').map((l) => l.slice(3));
    branch = lines('rev-parse', '--abbrev-ref', 'HEAD')[0];
    holds.push(...held({ dirty, branch, lines }));
  } catch (e) { holds.push(`git cannot read it (${String(e.stderr || e.message).trim().split('\n')[0]})`); }
  if (holds.length) throw new Error(refusal(holds));
  execFileSync('git', ['-C', repoRoot(), 'worktree', 'remove', '--force', wt], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (branch !== 'HEAD') { try { execFileSync('git', ['-C', repoRoot(), 'branch', '-D', branch], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* already gone */ } }
  return wt;
}

// The worktree a worker of `key` was given, cut from `cut`: removed with its local branch when it holds
// no work of its own, so the next worker's is cut from its new base. -> the path removed, or null when
// there is none. Throws, removing nothing, when it holds work.
function dropStaleWorktree(key, cut) {
  const wt = join(worktreesDir(), key);
  return removeWorktree(wt, ({ dirty, branch, lines }) => {
    const holds = dirty.length ? ['uncommitted changes or untracked files'] : [];
    const own = Number(lines('rev-list', '--count', `origin/${cut}..HEAD`)[0]);
    if (own > 0) holds.push(`${own} commit(s) not on origin/${cut}`);
    if (branch !== 'HEAD') {
      try { lines('show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`); holds.push(`its branch ${branch} pushed to origin`); } catch { /* not pushed */ }
    }
    return holds;
  }, (holds) => `${key}'s worktree ${wt} holds work cut from ${cut} (${holds.join(', ')}), which a worker on another base would start from: move that work by hand or discard it, remove the worktree, then move ${key} again. Nothing was moved`);
}

// The worktree a dropped ticket `t` was given: removed with its local branch when nothing in it is
// missing from origin. -> the path removed, or null when there is none. Throws, removing nothing,
// naming the worktree and what it holds, when it has uncommitted files or commits no origin ref has.
function dropWorktree(key, t) {
  const wt = t.worktree || join(worktreesDir(), key);
  const listed = (ls) => `${ls.slice(0, 5).join('; ')}${ls.length > 5 ? `; and ${ls.length - 5} more` : ''}`;
  return removeWorktree(wt, ({ dirty, lines }) => {
    const holds = dirty.length ? [`uncommitted or untracked files: ${listed(dirty)}`] : [];
    const unpushed = lines('log', '--format=%h %s', 'HEAD', '--not', '--remotes=origin');
    if (unpushed.length) holds.push(`${unpushed.length} commit(s) not pushed: ${listed(unpushed)}`);
    return holds;
  }, (holds) => `${key}'s worktree ${wt} holds work origin does not have (${holds.join('; ')}): push or discard it, then drop ${key} again. Nothing was dropped`);
}

// The answers `key` was given here, carried to the batch whose state directory is `to`: its briefing
// (that batch's pass keeps only the answer sections when it writes its own) and an answer file no
// worker has read yet. A briefing already there gains the answers it lacks.
function carryAnswers(key, to) {
  const brief = join(stateDir(), 'briefings', `${key}.md`);
  if (existsSync(brief)) {
    const there = join(to, 'briefings', `${key}.md`);
    mkdirSync(dirname(there), { recursive: true });
    if (!existsSync(there)) copyFileSync(brief, there);
    else {
      const answers = collectAnswers(readFileSync(brief, 'utf8'));
      if (answers && !readFileSync(there, 'utf8').includes(answers)) appendFileSync(there, `\n${answers}\n`);
    }
  }
  const file = join(stateDir(), 'answers', `${key}.txt`);
  const fileThere = join(to, 'answers', `${key}.txt`);
  if (existsSync(file) && !existsSync(fileThere)) {
    mkdirSync(dirname(fileThere), { recursive: true });
    copyFileSync(file, fileThere);
  }
}

// Move `key` from this queue `q` (whose lock is held) to the running batch `to` (`standing` for the
// standing batch), under that batch's queue lock too. It joins from this batch's triage record with its
// answers, held behind its blockers there, the unfinished tickets it collides with and the holds it had
// here, and its next worker is cut from that batch's base.
function transfer(q, key, to) {
  const t = ticket(q, key);
  if (t.state === 'running') throw new Error(`${key} is running: stop its worker first. Nothing was moved`);
  if (t.result?.pr != null && t.pr_status?.state !== 'CLOSED') throw new Error(`${key} has PR #${t.result.pr} against this batch's base: close it first. Nothing was moved`);
  const behind = Object.values(q.tickets).filter((o) => o.key !== key && blockersOf(o).includes(key)).map((o) => o.key);
  if (behind.length) throw new Error(`${behind.join(', ')} ${behind.length === 1 ? 'is' : 'are'} held behind ${key} in this batch: release ${behind.length === 1 ? 'it' : 'them'} first. Nothing was moved`);
  const name = /^standing$/i.test(to) ? null : to;
  if (name != null && (!SAFE_ID.test(name) || name.includes('..'))) throw new Error(`"${to}" is not a batch name. Nothing was moved`);
  const running = otherRunning();
  const dest = running.find((b) => b.name === name);
  if (!dest) {
    const here = listBatches(repoSlug()).some((b) => b.name === name && resolve(b.queue) === resolve(QUEUE));
    throw new Error(here ? `${key} is already in ${batchWord({ name })}. Nothing was moved`
      : `${name ? `batch ${name}` : 'the standing batch'} is not running: ${running.length ? `the batches running are ${running.map((b) => `${batchWord(b)} (on ${b.base})`).join(', ')}` : 'no other batch is running'}. Nothing was moved`);
  }
  const recFile = join(stateDir(), 'triage', `${key}.json`);
  if (!existsSync(recFile)) throw new Error(`no triage record for ${key}: run triage.sh ${key} first. Nothing was moved`);
  const r = readTriage(stateDir(), key);
  const epic = r.epic?.key;
  if (epic && epic !== name && running.some((b) => b.name === epic)) throw new Error(`${key} is a child of epic ${epic}, whose feature batch ${epic} is running: it joins that batch, never another. Nothing was moved`);
  lock(`${dest.queue}.lock`);
  const tq = readQueue(dest.queue);
  if (finished(tq)) throw new Error(`${batchWord(dest)} finished meanwhile. Nothing was moved`);
  if (tq.tickets && Object.hasOwn(tq.tickets, key)) throw new Error(`${key} is already in ${batchWord(dest)} (${tq.tickets[key].state}). Nothing was moved`);
  tq.tickets ??= {};
  // Admitted in memory first, so a refusal from either step leaves the worktree and both queues as they were.
  // Its merge holds on the person's steps go with it; a blocker in that batch is held behind there instead,
  // unless it is parked there as the person's step (labelPark), which nothing builds: it merges after that.
  // A step parked on a Person-input label makes what its build reads, so it stays a hold, as does one
  // triage called needed to build (blockerHold), as intake and plan-batch hold it.
  // A merge gate triage set on another ticket's code (triageGate) is lifted by that batch's pass only once
  // Done and landed, so it stays a gate there too while it is not held behind: Done in Jira, not yet merged.
  const own = (k) => (Array.isArray(r.blockers) ? r.blockers : []).find((x) => x?.key === k);
  const builds = (k) => !!own(k) && blockerHold(own(k), r, personStepLabels(), personInputLabels())?.needs === 'build';
  const gate = (k) => !!own(k) && triageGate(own(k), r, personStepLabels(), personInputLabels());
  const stepThere = (k) => personStepPark(tq.tickets[k]) && !personInputPark(tq.tickets[k]) && !builds(k);
  const there = (Array.isArray(r.blockers) ? r.blockers : []).filter((b) => b.category !== 'done' && tq.tickets[b.key]).map((b) => b.key);
  const holds = there.filter((k) => !stepThere(k));
  const mergeAfter = [...new Set([...String(t.merge_after ?? '').split('|').filter((p) => p && (!tq.tickets[p] || stepThere(p) || (gate(p) && !holds.includes(p)))), ...there.filter(stepThere)])];
  // Its holds go with it. One on a ticket in that batch is held behind there until it merges. A blocker
  // parked there as the person's step is a merge_after step already (above), or holds nothing once Done;
  // a hold on such a step that is no blocker stays a hold, since pass.mjs lifts an unlinked merge_after
  // step at once. A blocker left in this batch, or one in no batch, is held outside it, lifted by that batch's pass once Done in
  // Jira and on its base (a key its triage record does not list as a blocker, Done or not, is lifted at
  // once, so only those go). A hold on this batch's own files or spine means nothing there and stays
  // behind, as does one on a ticket here already finished. Any other hold is the person's, a key no
  // longer in any batch included, and refuses the move. Only held_by holds: a release clears it and
  // leaves held_outside behind, so held_outside only says which of its keys were outside.
  const blocking = new Set((Array.isArray(r.blockers) ? r.blockers : []).map((b) => b.key));
  const local = new Set([...String(t.collides_with ?? '').split('|'), q.spine, q.batch, q.epic].filter(Boolean));
  const wasOutside = String(t.held_outside ?? '').split('|').filter(Boolean);
  const outside = [];
  const stays = [];
  const theirs = [];
  for (const p of blockersOf(t)) {
    if (!p || p === key || [holds, outside, stays, theirs, mergeAfter].some((l) => l.includes(p))) continue;
    if (tq.tickets[p]) { if (!(stepThere(p) && blocking.has(p)) && !childDone(tq.tickets[p])) holds.push(p); }
    else if (wasOutside.includes(p) || blocking.has(p)) outside.push(p);
    else if (q.tickets[p] && childDone(q.tickets[p])) continue;
    else (local.has(p) ? stays : theirs).push(p);
  }
  if (theirs.length) throw new Error(`${key} is held behind ${theirs.join(', ')}, which ${theirs.length === 1 ? 'is not a blocker' : 'are not blockers'} of it in Jira, so ${batchWord(dest)} could not keep the hold: release it first. Nothing was moved`);
  const said = admitInto(tq, key, r, { state: dest.state, by: t.admitted_by ?? null, holds, outside, mergeAfter, holdSpine: true, pin: t.levers ?? null });
  // A ticket here merge-ordered behind it (merge_order) no longer orders its merge on a shared file, which
  // this batch's base no longer shares. One whose Jira blocker it is still merges only once that lands:
  // Done in Jira and on the base (merge_after), as a blocker in no batch holds it at plan-batch. Worked out
  // in memory before anything is written, so a triage record that cannot be read refuses the move whole.
  const ordered = [];
  for (const o of Object.values(q.tickets)) {
    const left = String(o.collides_with ?? '').split('|').filter((k) => k && k !== key);
    if (o.collides_with) o.collides_with = left.join('|') || null;
    const order = String(o.merge_order ?? '').split('|').filter(Boolean);
    if (o.key === key || !order.includes(key)) continue;
    o.merge_order = order.filter((k) => k !== key).join('|') || null;
    const rec = existsSync(join(stateDir(), 'triage', `${o.key}.json`)) ? readTriage(stateDir(), o.key) : null;
    if (!(Array.isArray(rec?.blockers) ? rec.blockers : []).some((b) => b?.key === key && b.category !== 'done')) continue;
    o.merge_after = [...new Set([...String(o.merge_after ?? '').split('|').filter(Boolean), key])].join('|');
    ordered.push(o.key);
  }
  const removed = dropStaleWorktree(key, baseOf(q));
  // Its triage record goes with it: admit and every pass read a ticket's record from their own batch.
  mkdirSync(join(dest.state, 'triage'), { recursive: true });
  copyFileSync(recFile, join(dest.state, 'triage', `${key}.json`));
  carryAnswers(key, dest.state);
  const from = listBatches(repoSlug()).find((b) => resolve(b.queue) === resolve(QUEUE)) ?? { name: q.batch };
  tq.tickets[key].moved_from = { batch: from.name ?? null, base: baseOf(q), at: new Date().toISOString() };
  // In both queues for an instant rather than in neither: a crash between the writes leaves it in two,
  // which batchHolding refuses naming both.
  writeQueue(dest.queue, tq);
  delete q.tickets[key];
  save(q);
  return `${key} moved from ${batchWord(from)} to ${batchWord(dest)}: ${said}${stays.length ? ` (its hold on ${stays.join(', ')}, for this batch's files, spine or epic, stays here)` : ''}${ordered.length ? `; ${ordered.join(', ')} still ${ordered.length === 1 ? 'merges' : 'merge'} only once ${key} is Done and landed` : ''}; its next worker starts on ${dest.base}${removed ? `. Its worktree ${removed}, cut from ${baseOf(q)} with no work of its own, was removed` : ''}`;
}

const [, , cmd, ...args] = process.argv;

const WRITES = ['init', 'add', 'adopt', 'admit', 'hold', 'set', 'local', 'set-batch', 'park', 'clears-when', 'requeue', 'handback', 'step-done', 'follow-ran', 'approve', 'reject', 'front', 'move', 'order', 'drop', 'merged', 'transfer', 'finish', 'withdraw'];

try {
if (!Object.hasOwn(QUEUE_COMMANDS, cmd ?? '')) throw new Error(unknownQueueCommand(cmd));
if (cmd === 'requeue' && args[0] && existsSync(QUEUE)) {
  const t = readQueue(QUEUE).tickets?.[args[0]];
  if (t?.state === 'running') exitedPark = { key: args[0], session: t.session_id ?? null, park: exitedOnPark(t) };
}
// handback's gh read and git fetch can outlast another writer's wait for the queue lock, so they run
// first. So do those of a requeue (and the commands that requeue) of a ticket with a recorded PR.
if (['handback', 'requeue', 'step-done', 'reject'].includes(cmd) && args[0] && existsSync(QUEUE)) {
  const t = readQueue(QUEUE).tickets?.[args[0]];
  if (t?.worktree && existsSync(t.worktree) && (cmd === 'handback' || ownPr(t) != null)) {
    // A requeue moves only to its recorded PR: one found by naming the ticket may be another's.
    const pr = openPrOf({ key: args[0], pr: ownPr(t), repo: hereRepo(), worktree: t.worktree, naming: cmd === 'handback' });
    prePr = { key: args[0], worktree: t.worktree, branch: t.branch, recordedPr: ownPr(t), pr, fetchError: fetchPrHead({ worktree: t.worktree, pr }) };
  }
}
// finish's gh read, like handback's, runs before the lock.
const finishAt = cmd === 'finish' ? args.indexOf('--pr') : -1;
if (cmd === 'finish') {
  const at = finishAt;
  const n = at < 0 ? '' : String(args[at + 1] ?? '');
  if (!args[0] || args[0].startsWith('--') || !/^[1-9][0-9]*$/.test(n)) throw new Error('usage: queue.mjs finish <TICKET> --pr <PR number>');
  try {
    finishPr = JSON.parse(execFileSync('gh', ['pr', 'view', n, ...(hereRepo() ? ['--repo', hereRepo()] : []), '--json', 'number,state,isDraft,headRefName,baseRefName,isCrossRepository'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) { finishPr = { error: String(e.stderr ?? e.message ?? e).trim().split('\n').pop() }; }
  finishPr.n = n;
}
if (WRITES.includes(cmd) || (cmd === 'backfill-holds' && !args.includes('--dry-run'))) lock();
// init must be able to repair a corrupt queue, and rebuild reads its own batch's queue (under its lock),
// so a corrupt current one must not stop it rebuilding another batch.
const q = cmd === 'init' ? empty() : cmd === 'rebuild' ? null : load();

switch (cmd) {
  case 'init': {
    // Stage 0 is the last point before triage: an orchestrator that cannot ask or run its monitors
    // would triage, then stall at Stage 3. A standing batch (intake.mjs) has no orchestrator to stall.
    // --standing --if-batch <name|none>, for intake: replace only the batch intake found finished, still
    // named so with every ticket done (or no queue for `none`), checked under this lock, and hand the new
    // batch to the supervisor in the same write, so a session's own init is never replaced or handed over.
    const standing = args.includes('--standing');
    const ifAt = args.indexOf('--if-batch');
    const name = args.find((a, i) => !a.startsWith('--') && (ifAt < 0 || i !== ifAt + 1));
    if (standing) {
      if (ifAt < 0) throw new Error('init --standing wants --if-batch <the batch it replaces, or none>');
      let cur = null;
      try { cur = existsSync(QUEUE) ? readQueue(QUEUE) : null; } catch { cur = { batch: null, tickets: {} }; }
      const rows = ownRows(cur);
      const any = rows.length > 0 || Object.keys(archivedOf(cur)).length > 0;
      const same = cur ? String(cur.batch) === args[ifAt + 1] && any && rows.every((t) => t.state === 'done') && !cur.base : args[ifAt + 1] === 'none';
      if (!same) throw new Error(`init --standing: the queue is batch ${cur?.batch ?? 'none'} now, not the finished ${args[ifAt + 1]}: left as it is`);
    }
    const dm = standing ? {} : sessionDefaultMode();
    if (dm.mode === 'dontAsk') {
      throw new Error(`${DONTASK_WARNING}. Set in ${dm.file}; remove it (run /desk-setup, which backs the file up first), restart the session, then init again`);
    }
    const fresh = empty();
    fresh.batch = name ?? new Date().toISOString().slice(0, 16);
    if (standing) fresh.supervised = true;
    // A merged ticket whose follow-on steps the person has not run yet (needs-you lists them from the
    // queue) moves into the new batch, so replacing the old one never drops them from the list. Marked
    // carried_from, it is no ticket of this batch: a queue holding only those is one not yet planned.
    let prev = null;
    try { prev = existsSync(QUEUE) ? readQueue(QUEUE) : null; } catch { prev = null; }
    // So does one whose post-merge criteria the pass has not made those steps yet (postMergeUnmade), from
    // a batch with no base: a base's child is gated on the base's promotion, which the new batch lacks.
    fresh.tickets = Object.fromEntries(Object.entries(prev?.tickets ?? {}).filter(([, t]) => followOnPending(t) || (!prev.base && postMergeUnmade(t)))
      .map(([k, t]) => [k, { ...t, carried_from: t.carried_from ?? prev.batch ?? null }]));
    fresh.version = versionOf(prev);
    // The old batch's archive goes aside with it, so the new batch finds none of its tickets by key.
    const archive = archivePath(QUEUE);
    if (existsSync(archive)) renameSync(archive, `${archive}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
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
    if (Object.hasOwn(q.tickets, key)) { console.log(`${key} already in the queue (${q.tickets[key].state}) — not re-adding`); break; }
    const elsewhere = belongsElsewhere(key);
    if (elsewhere) throw new Error(elsewhere.why);
    q.tickets[key] = {
      key, type, lane, state: 'queued',
      worktree: null, branch: null, database: null, port: null,
      session_id: null, pid: null, base_sha: null, stage: null,
      park: null, log: null, result: null, levers: admissionPin(key, sizeOf(stateDir(), key)),
      added_at: new Date().toISOString(),
    };
    save(q);
    console.log(`added ${key}`);
    break;
  }

  // A PR opened in the batch with no ticket (a fix for a flaky test it kept hitting, say) taken in as a
  // done ticket on that PR, so the merge driver merges it with the batch's tickets (by its branch), and
  // the pass and desk-q list it while it waits. The key is checked as a merge driver --tickets entry is.
  case 'adopt': {
    const filed = args.includes('--filed');
    const [key, prArg] = args.filter((a) => a !== '--filed');
    if (!key || !/^[1-9][0-9]*$/.test(String(prArg ?? ''))) throw new Error('usage: queue.mjs adopt <TICKET> <PR number> [--filed]');
    const kind = ticketKind(key);
    if (!kind.ok) throw new Error(kind.error);
    // A key in the tracker's pattern is a real ticket, which the merge driver moves to Done when the PR
    // merges: only the ticket filed for this PR, said so with --filed. A made-up one would close another.
    if (kind.kind === 'tracker' && !filed) throw new Error(`${key} is a tracker key, and the merge driver moves that ticket to Done when PR #${prArg} merges: give the PR an id from §4 Other work id patterns, or, if ${key} is the ticket filed for this PR, say so with --filed`);
    if (Object.hasOwn(q.tickets, key)) throw new Error(`${key} is already in the queue (${q.tickets[key].state}): adopt takes a key no ticket has`);
    const elsewhere = belongsElsewhere(key);
    if (elsewhere) throw new Error(elsewhere.why);
    const repo = ghRepo();
    let pr;
    try {
      pr = JSON.parse(execFileSync('gh', ['pr', 'view', prArg, '--repo', repo, '--json', 'number,state,headRefName,baseRefName,title,author'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) { throw new Error(`gh could not read PR #${prArg} on ${repo} (${String(e.stderr ?? e.message).trim().split('\n').pop()}): nothing adopted`); }
    if (pr.state !== 'OPEN') throw new Error(`PR #${prArg} is ${String(pr.state).toLowerCase()}, not open: nothing adopted`);
    const base = baseOf(q);
    if (pr.baseRefName !== base) throw new Error(`PR #${prArg} is on ${pr.baseRefName}, not this batch's base ${base}: the merge driver would not merge it, so nothing adopted`);
    // The merge driver lists only PRs by §1 GitHub handle.
    let handle = null;
    try { handle = githubHandle(); } catch { /* unset: the driver refuses to start, so it is not checked here */ }
    if (handle && pr.author?.login && pr.author.login.toLowerCase() !== handle.toLowerCase()) throw new Error(`PR #${prArg} is by ${pr.author.login}, and the merge driver merges only PRs by ${handle}: nothing adopted`);
    const owner = Object.values(q.tickets).find((t) => t.branch === pr.headRefName);
    // A red-base repair recorded done (closed on a green read, say) whose branch holds the fix PR gives
    // the branch up: the fix is this PR now, and the done entry has nothing left to merge.
    const takeOver = owner && owner.state === 'done' && isBaseRedKey(owner.key, base);
    if (owner && !takeOver) throw new Error(`PR #${prArg}'s branch ${pr.headRefName} is already ${owner.key}'s: nothing adopted`);
    if (takeOver) { owner.branch = null; owner.updated_at = new Date().toISOString(); }
    const now = new Date().toISOString();
    q.tickets[key] = {
      key, type: 'Task', lane: '?', state: 'done',
      worktree: null, branch: pr.headRefName, database: null, port: null,
      session_id: null, pid: null, base_sha: null, stage: null,
      park: null, log: null, result: { pr: String(pr.number), summary: `adopted: ${pr.title}` }, adopted: true,
      added_at: now, updated_at: now,
    };
    save(q);
    if (takeOver) console.log(`${owner.key} is a done red-base repair, so it gave up its branch ${pr.headRefName}`);
    console.log(`${key} adopted PR #${pr.number} (${pr.headRefName} into ${base}): the merge driver merges it with the batch's tickets, and the pass and desk-q list it until it does`);
    break;
  }

  // Hold a ticket behind blockers (a dependency added mid-batch, or a collision chain), recorded so
  // pass.mjs keeps the batch alive and the merge driver releases it once every blocker has merged.
  case 'hold': {
    const [key, ...blockers] = args;
    const preds = blockers.flatMap((b) => b.split(/[,|]/)).filter(Boolean);
    if (!key || !preds.length) throw new Error('usage: queue.mjs hold <TICKET> <BLOCKER> [<BLOCKER> ...]');
    const t = ticket(q, key);
    // An archived blocker is found as done, and the merge driver releases a hold on it as on any merged one.
    for (const p of preds) { found(q, p); if (p === key) throw new Error(`${key} cannot be held behind itself`); }
    // A triage park (lane, size, design, the person's step) keeps its park, its holds in held_by beside
    // it, so no release can send it to a worker. Any other park of its own would lose its question.
    const keeps = !isHeld(t) && triagePark(t);
    if (t.state === 'parked' && !isHeld(t) && !keeps) throw new Error(`${key} is parked for its own reason (${t.park?.question ?? '?'}): a hold would let a release send it to a worker`);
    if (['running', 'done', 'failed'].includes(t.state)) throw new Error(`${key} is ${t.state}: too late to hold it`);
    // A release sets state=triaged, so only a ticket that is triaged (or already held) may be held.
    if (t.state === 'queued') throw new Error(`${key} has not been triaged: triage it and \`queue.mjs admit\` it before holding it`);
    // A date hold waits behind its blockers: once they release it, the pass reads its label again.
    if (dateHeld(t)) t.held_label = null;
    const all = [...new Set([...blockersOf(t), ...preds])];
    t.held_by = all.join('|');
    t.state = 'parked';
    if (!keeps) t.park = heldPark(all);
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(keeps ? `${key} held behind ${all.join(', ')}, beside its own park (${t.park.question})` : `${key} held behind ${all.join(', ')}`);
    break;
  }

  // Add one triaged ticket mid-batch, from its triage record, the way plan-batch seeds one: a blocker
  // the user asked to add, a split-off child. Never re-run plan-batch with AUTOPILOT_WRITE_QUEUE for
  // this: it resets every ticket's state.
  case 'admit': {
    // --by names who admitted it, where that is not the orchestrator: `intake` for standing intake.
    // --hold holds it behind blockers in this batch in the same write, so no pass sees it runnable first.
    // Sharing a file holds nothing here: pass.mjs's per-file budget decides at spawn time.
    // --hold-spine holds it behind this feature batch's spine until done, and its epic while that waits on its plan. --hold-outside holds
    // it behind blockers in no batch, which pass.mjs lifts once each is Done and on the batch's base.
    // --hold-merge records blockers in no batch that are the person's steps as merge_after: it is built
    // as any other ticket, and the merge driver holds its PR until pass.mjs reads each step Done.
    const [key] = args;
    const by = args.includes('--by') ? args[args.indexOf('--by') + 1] : null;
    if (!key || !SAFE_ID.test(key) || key.includes('..') || (args.includes('--by') && !SAFE_ID.test(by ?? ''))) throw new Error('usage: queue.mjs admit <TICKET> [--by <who>] [--hold <BLOCKER>[,<BLOCKER>...]] [--hold-outside <BLOCKER>[,<BLOCKER>...]] [--hold-merge <STEP>[,<STEP>...]] [--hold-spine]   (after triage.sh <TICKET>)');
    const listArg = (flag) => (args.includes(flag) ? String(args[args.indexOf(flag) + 1] ?? '').split(/[,|]/).filter(Boolean) : []);
    const holds = listArg('--hold');
    if (args.includes('--hold') && !holds.length) throw new Error('admit --hold wants the blockers, comma-separated');
    for (const p of holds) { found(q, p); if (p === key) throw new Error(`${key} cannot be held behind itself`); }
    const outside = listArg('--hold-outside');
    if (args.includes('--hold-outside') && !outside.length) throw new Error('admit --hold-outside wants the blockers, comma-separated');
    for (const p of outside) {
      if (!SAFE_ID.test(p) || p === key) throw new Error(`admit --hold-outside: ${p} is not a blocker of ${key}`);
      if (q.tickets[p]) throw new Error(`${p} is in this batch: hold ${key} behind it with --hold`);
    }
    const mergeAfter = listArg('--hold-merge');
    if (args.includes('--hold-merge') && !mergeAfter.length) throw new Error('admit --hold-merge wants the steps, comma-separated');
    for (const p of mergeAfter) {
      if (!SAFE_ID.test(p) || p === key || outside.includes(p) || holds.includes(p)) throw new Error(`admit --hold-merge: ${p} is not a step ${key} merges after`);
      // One in this batch is a step only once it is parked as the person's (labelPark): nothing builds it.
      // One parked on a Person-input label makes what the build reads: it holds the build instead.
      if (q.tickets[p] && (!personStepPark(q.tickets[p]) || personInputPark(q.tickets[p]))) throw new Error(`${p} is in this batch: hold ${key} behind it with --hold`);
    }
    if (Object.hasOwn(q.tickets, key)) throw new Error(`${key} is already in the queue (${q.tickets[key].state})`);
    const recPath = join(stateDir(), 'triage', `${key}.json`);
    if (!existsSync(recPath)) throw new Error(`no triage record for ${key}: run triage.sh ${key} first`);
    const r = readTriage(stateDir(), key);
    const elsewhere = belongsElsewhere(key, r, QUEUE);
    if (elsewhere) throw new Error(elsewhere.why);
    const asked = holds.length + outside.length + mergeAfter.length;
    const said = admitInto(q, key, r, { state: stateDir(), by, holds, outside, mergeAfter, holdSpine: args.includes('--hold-spine') });
    save(q);
    console.log(`admitted ${key}${by ? ` by ${by}` : ''}: ${said}${r.blockers?.length && !asked ? ` — its own Jira blockers (${r.blockers.map((b) => b.key).join(', ')}) are not applied: hold it with queue.mjs hold if they are in this batch` : ''}`);
    break;
  }

  // Run by hand, once, on a queue whose lane, size and design parks carry no held_by: each gains the
  // holds its blockers give it (missingHolds), beside a park left as it is. --dry-run prints them and
  // writes nothing. A park that already has held_by is never touched, so a rerun changes nothing.
  case 'backfill-holds': {
    const dry = args.includes('--dry-run');
    if (args.some((a) => a !== '--dry-run')) throw new Error('usage: queue.mjs backfill-holds [--dry-run]');
    // Loaded here alone: intake.mjs pulls in modules no other queue.mjs command needs.
    const { holdsFor } = await import('./intake.mjs');
    const found = missingHolds(q, holdsFor);
    const lines = [];
    for (const { key, holds, outside, cycles, failed, park } of found) {
      const skipped = `${cycles.length ? ` (not behind ${cycles.join(', ')}, which ${cycles.length === 1 ? 'waits' : 'wait'} behind it)` : ''}${failed.length ? ` (not behind ${failed.join(', ')}, which failed in the batch, so nothing would release the hold: requeue or drop ${failed.length === 1 ? 'it' : 'them'}, then hold ${key} with queue.mjs hold if it still needs ${failed.length === 1 ? 'it' : 'them'})` : ''}`;
      if (!holds.length) { lines.push(`${key}: no hold to add${skipped}`); continue; }
      const out = outside.length ? ` (${outside.join(', ')} outside the batch)` : '';
      lines.push(`${key}: ${dry ? 'would hold' : 'held'} behind ${holds.join(', ')}${out}, beside its own park (${park})${skipped}`);
      if (dry) continue;
      const t = q.tickets[key];
      t.held_by = holds.join('|');
      if (outside.length) t.held_outside = [...new Set([...String(t.held_outside ?? '').split('|').filter(Boolean), ...outside])].join('|');
      t.updated_at = new Date().toISOString();
    }
    // Every save is a new version, so a run that adds nothing writes nothing.
    if (!dry && found.some((f) => f.holds.length)) save(q);
    console.log(lines.length ? lines.join('\n') : `no lane, size or design park is missing a hold${dry ? '' : ': nothing changed'}`);
    if (dry && found.some((f) => f.holds.length)) console.log('dry run: nothing changed. Run it again without --dry-run to add these holds');
    break;
  }

  // Move one ticket from this batch to another running batch in the repo (one admitted to the wrong
  // base), holding both queue locks: out of this queue, and into that one from its triage record.
  case 'transfer': {
    const [key, to] = args;
    if (!key || !to) throw new Error('usage: queue.mjs transfer <TICKET> <batch | standing>');
    console.log(transfer(q, key, to));
    break;
  }

  // The batches a ticket here could be moved into, as transfer judges them: JSON [{name, base}], the
  // standing batch's name null.
  case 'running': {
    console.log(JSON.stringify(otherRunning().map((b) => ({ name: b.name ?? null, base: b.base }))));
    break;
  }

  // --unless <field>=<value>: written only while the ticket's field, read under the lock, is not that
  // value. The pass's state=running write passes --unless state=done, so a try withdrawn (withdraw) after
  // the pass read it as waiting is never marked running, and no worker starts.
  // --merged: the caller has confirmed every blocker it clears merged (the merge driver's release reads
  // GitHub's merged PRs, which the queue can trail), so the warning about unmerged ones is not printed.
  case 'set': {
    const [key, ...rest] = args;
    const unless = [], pairs = [];
    let confirmed = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--unless') { unless.push(String(rest[++i] ?? '')); continue; }
      if (rest[i] === '--merged') { confirmed = true; continue; }
      pairs.push(rest[i]);
    }
    const t = ticket(q, key);
    for (const u of unless) {
      const eq = u.indexOf('=');
      if (eq < 1) throw new Error(`set --unless wants <field>=<value>, not "${u}"`);
      const field = u.slice(0, eq), value = u.slice(eq + 1);
      if (String(t[field] ?? '') === value) throw new Error(`${key}'s ${field} is ${value} now, so it is not written (--unless ${u}): ${pairs.join(' ')}`);
    }
    const held = unmergedBlockers(q, t, blockersOf(t));
    const freed = applySet(t, pairs);
    save(q);
    console.log(`${key}: ${pairs.join(' ')}${freed}`);
    // A release still goes ahead past blockers that have not merged; it names them.
    const open = confirmed ? [] : held.filter((p) => !blockersOf(t).includes(p));
    if (open.length) console.error(`warning: ${key} is no longer held behind ${open.join(', ')}, which ${open.length === 1 ? 'has' : 'have'} not merged yet`);
    break;
  }

  // `local <KEY>`: `set <KEY> location=local`, which pins it to this computer until `location=auto`
  // (queue-writer.mjs LOCATIONS).
  case 'local': {
    const [key] = args;
    if (!key) throw new Error('usage: queue.mjs local <TICKET>');
    applySet(ticket(q, key), ['location=local']);
    save(q);
    console.log(`${key}: location=local (pinned to this computer; queue.mjs set ${key} location=auto clears it)`);
    break;
  }

  // --claimed-by <session id>: an interactive session works the ticket. Each pass releases it to a worker
  // once that session has been idle past config §3b "Release idle claims after (hours)" (claims.mjs).
  case 'park': {
    const at = args.indexOf('--claimed-by');
    const session = at < 0 ? null : args[at + 1];
    const [key, ...more] = at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
    if (at >= 0 && !SESSION_ID.test(session ?? '')) throw new Error('usage: queue.mjs park <TICKET> --claimed-by <session id> [<question>]');
    const { question, kind } = parkArgs(more);
    const rest = question ? [question] : [];
    // A session name, or a session from another computer, has no transcript to read idleness from.
    if (session && !transcriptOf(session)) throw new Error(`no transcript for session ${session} under ${projectsDirs().join(' or ')}: --claimed-by wants the session id of a session on this computer`);
    const t = ticket(q, key);
    const now = new Date().toISOString();
    if (session && (isHeld(t) || spinePark(t))) throw new Error(`${key} is parked by the orchestrator (${t.park.question}): only its release or approval settles it, so it cannot be claimed`);
    // A park already there keeps its question, which the requeue guards read (a lane D design, a size,
    // a dependency cycle), so an idle release can never send it to a worker those guards would refuse.
    if (session && t.state === 'parked' && rest.length) throw new Error(`${key} is already parked (${t.park?.question ?? '?'}): claim it with no question, which keeps that one`);
    const kept = session && t.state === 'parked' && t.park ? t.park : null;
    t.state = 'parked';
    t.park = kept ? { ...kept, claim: { session, at: now } }
      : { ...newPark(question || (session ? claimQuestion(session) : ''), now, kind), ...(session ? { claim: { session, at: now } } : {}) };
    save(q);
    console.log(session ? `${key} parked, claimed by session ${session}` : `${key} parked`);
    break;
  }

  // What clears a parked ticket's park (clears-when.mjs), so a pass can settle it without a model.
  case 'clears-when': {
    const [key, ...rest] = args;
    if (!key || !rest.length) throw new Error(`usage: queue.mjs clears-when <TICKET> <${CLEARS_WHEN_FORMS}>, or clears-when --check "<condition>"`);
    const t = ticket(q, key);
    if (t.state !== 'parked' || isHeld(t)) throw new Error(`${key} is not parked for its own reason (state ${t.state}), so it has no park to clear`);
    refuseLeft(t, key, 'given a condition to clear on');
    const p = parseClearsWhen(rest.join(' '), { here: hereRepo() });
    if (!p.ok) throw new Error(p.why);
    const circular = ownDraftWhy(p.cond, { ...t, key });
    if (circular) throw new Error(`${circular}. Nothing was recorded`);
    const w = withQuestion(p.cond, t.park?.question, { state: stateDir() });
    if (!w.ok) throw new Error(`${w.why}. Nothing was recorded`);
    t.park.clears_when = w.cond;
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(`${key}: its park clears when ${describeCond(w.cond)}${personClears(w.cond, t.park?.question) ? ', which the person makes, so the park is still put to them' : ''}`);
    break;
  }

  case 'requeue': {
    const [key] = args;
    if (!key) throw new Error('usage: queue.mjs requeue <TICKET>');
    console.log(requeue(q, key));
    break;
  }

  case 'stop': {
    const [key] = args;
    if (!key) throw new Error('usage: queue.mjs stop <TICKET>');
    console.log(stop(key));
    break;
  }

  case 'handback': {
    const [key, ...rest] = args;
    const note = rest.join(' ').trim();
    if (!key || !note) throw new Error('usage: queue.mjs handback <TICKET> "<what the person did>"');
    console.log(handback(q, key, note));
    break;
  }

  case 'finish': {
    console.log(finish(q, args[0], finishPr.n, finishPr));
    break;
  }

  case 'withdraw': {
    const [key, ...rest] = args;
    const why = rest.join(' ').trim();
    if (!key || !why) throw new Error('usage: queue.mjs withdraw <TICKET> "<why: what settled it, and where>"');
    console.log(withdraw(q, key, why));
    break;
  }

  case 'step-done': {
    const [key] = args;
    if (!key) throw new Error('usage: queue.mjs step-done <TICKET>');
    console.log(stepDone(q, key));
    break;
  }

  // The follow-on steps the person settled, by running them or on the PR's own evidence (needs-you's done on a follow item), each by its text and gate
  // (`after`, none for the merge): each leaves follow_on, read here under the lock so a step written since
  // needs-you read it is kept, and with none left the item is recorded settled (follow_on_done=<at>).
  case 'follow-ran': {
    const [key, json, at] = args;
    let ran;
    try { ran = JSON.parse(json ?? ''); } catch { ran = null; }
    if (!key || !Array.isArray(ran) || !ran.length || ran.some((s) => typeof s?.step !== 'string') || !at) throw new Error('usage: queue.mjs follow-ran <TICKET> <JSON array of {step, after}> <ISO time>');
    const t = ticket(q, key);
    const { left, fields } = settleSteps(t.follow_on, ran, at);
    if (fields.length) applySet(t, fields);
    save(q);
    console.log(`${key}: ${ran.length} follow-on ${ran.length === 1 ? 'step' : 'steps'} recorded done${left.length ? `, ${left.length} kept` : ''}`);
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
    const held = Object.values(q.tickets).filter((x) => isHeld(x) && blockersOf(x).includes(key)).map((x) => x.key);
    const after = held.length ? `${held.join(', ')} ${held.length > 1 ? 'are' : 'is'} released once it merges` : 'nothing is held behind it';
    const repo = ghRepo();
    const lines = [`${key} approved: the spine is done`];
    let needsPerson = false;
    if (permission('pr-ready') === 'yes') {
      try {
        execFileSync('gh', ['pr', 'ready', String(pr), '--repo', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
        wakeMergeDriver(stateDir());
        lines.push(`PR #${pr} is ready for review`);
      } catch (e) {
        needsPerson = true;
        lines.push(`PR #${pr} could not leave draft (${String(e.stderr ?? e.message).trim().split('\n').pop()}): gh pr ready ${pr} --repo ${repo}`);
      }
    } else {
      needsPerson = true;
      lines.push(`config §3 ${permissionKey('pr-ready')} is "${permission('pr-ready')}": undraft PR #${pr} yourself (gh pr ready ${pr} --repo ${repo})`);
    }
    const merger = spineMerger(q);
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
    // After the requeue, which may re-point the ticket to its PR's branch: the note names the one its worker is on.
    const msg = requeue(q, key);
    const text = `The person sent this spine's acceptance specs back: ${note}` +
      (pr != null ? `\nYour PR #${pr} on ${t.branch} stays open and in draft: fix the specs on that branch and push, rather than opening another PR.` : '');
    saveAnswer(stateDir(), key, text, new Date().toISOString());
    console.log(`${key} sent back with the note in its briefing; ${msg}`);
    break;
  }

  case 'set-batch': {
    applySetBatch(q, args, setBase);
    save(q);
    console.log(`batch: ${args.join(' ')}`);
    break;
  }

  // pass.mjs spawns eligible tickets in `.tickets` key order, so a released chain head has to move
  // to the front or it waits behind every independent ticket. A ticket the user placed stays put. With
  // --placed (the user's own --front) it is placed from then on, so the pass's re-sort leaves it there.
  case 'front': {
    const key = args.find((a) => a !== '--placed');
    const t = ticket(q, key);
    const msg = toFront(q, key);
    // Placed by the user, it no longer carries the pass's note of moving it (pass.mjs placed_move).
    if (args.includes('--placed') && t.state !== 'running' && !FINISHED.includes(t.state)) { t.placed = true; delete t.placed_move; }
    save(q);
    const open = questionsOpen(t);
    console.log(`${key} ${msg}${open > 0 ? `; it still has ${open} question(s) open and will not spawn until they are answered: ${answerWith(t)}` : ''}`);
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
    delete t.placed_move;
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(`${key} moved to position ${n} of ${order.length} in the spawn order and marked placed: front and requeue leave it there`);
    break;
  }

  // plan-batch's spawn order, laid over the slots these tickets already hold: an epic's children are
  // admitted before its plan seeds them, and add leaves a queued ticket where it is. Every other
  // ticket keeps its slot, and so does one running, finished or placed by the user (move). With
  // --placed (plan-batch --keep-order: the user named the order) each ticket laid is placed from then
  // on, so the pass's re-sort keeps the order named.
  case 'order': {
    const keys = layOrder(q, args.filter((a) => a !== '--placed'));
    if (args.includes('--placed')) for (const k of keys) { q.tickets[k].placed = true; delete q.tickets[k].placed_move; }
    save(q);
    console.log(`spawn order: ${keys.join(' ') || 'nothing to reorder'}`);
    break;
  }

  // The merge driver, once a ticket's PR has merged: the first merge time is kept on the ticket, the
  // repo's eta history gains its line, and its saved first estimate gains the merge time beside it
  // (desk-q-eta.mjs), after the queue lock is released. With --pr and --head, the PR that merged and its
  // branch: a ticket that records no PR of its own (one built outside its worker) and has no worker
  // running is recorded done on it, as a pass records one shipped outside its worker, where the branch is
  // the ticket's or names its key. A title is not enough: another ticket's PR often names this key in it.
  // The merge is kept on the ticket as `merge`: who recorded it (--by), the PR, the head commit it merged
  // at (--head-sha) and the base it merged onto (--base), and when, which the ticket ledger records as one
  // merged event (queue-ledger.mjs) and desk-q shows. A merge given no PR, from an older caller, is still
  // recorded, with its PR missing, which the pass reports (pass/report.mjs mergeGapLine).
  case 'merged': {
    const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : { i, v: args[i + 1] ?? '' }; };
    const got = Object.fromEntries(QUEUE_COMMANDS.merged.map((f) => [f, flag(f)]));
    const pr = got['--pr']?.v ?? null;
    const head = got['--head']?.v ?? null;
    const sha = got['--head-sha']?.v ?? null;
    const [key, time] = args.filter((_, i) => !Object.values(got).some((f) => f != null && (i === f.i || i === f.i + 1)));
    if (!key || (pr != null && !/^\d+$/.test(pr)) || [head, got['--base']?.v, got['--by']?.v].some((v) => v === '' || v?.startsWith('--'))
      || (sha != null && !isSha(sha))) {
      throw new Error('usage: queue.mjs merged <TICKET> [<ISO time>] [--pr <n> [--head <branch>] [--head-sha <sha>] [--base <branch>]] [--by <who>]');
    }
    const t = ticket(q, key);
    const when = time ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(when))) throw new Error(`merged: "${when}" is not a time`);
    const itsBranch = head != null && (head === t.branch || new RegExp(keyPattern(key)).test(head));
    if (pr != null && itsBranch && t.result?.pr == null && t.draft_pr == null && t.state !== 'running') {
      // shipped_pr keeps it live until a pass reads that PR's review (harvest.mjs postMergeUnmade). A kept
      // status naming another repo's PR of this number (needs-you's elsewhereDone, kept through a requeue
      // and a spawn) is not this PR's: it is dropped, as the pass's shippedElsewhere drops one, so it is
      // never marked merged in this PR's place and the pass reads this PR and its review afresh. With no
      // repo to judge by, any status with a url is dropped: a read costs less than a foreign one kept. The
      // repo is judged as the pass judges it (pass/pr-status.mjs repoOfPr).
      const here = hereRepo(), { url } = recordedPr(t, pr);
      const foreign = !!url && (!here || repoOfPr(url) !== repoOfPr(`https://github.com/${here}/pull/`));
      applySet(t, [...shippedSet(foreign ? { ...t, pr_status: null } : t, `PR #${pr} merged by the merge driver`, Number(pr), new Date(when).toISOString()).slice(2),
        ...(foreign ? ['pr_status=null'] : []), `shipped_pr=${pr}`]);
    }
    t.merged_at ??= new Date(when).toISOString();
    // A call naming no PR (the pass's own, finding the PR merged) never replaces a merge already recorded:
    // it would wipe who merged which PR at which head, as merged_at keeps the first merge time.
    if (pr != null || t.merge == null) {
      t.merge = { by: got['--by']?.v ?? null, pr: pr == null ? null : Number(pr), head_sha: sha, base: got['--base']?.v ?? null, at: new Date(when).toISOString() };
    }
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(`${key} merged at ${t.merged_at}`);
    if (pr == null && t.merge.pr == null) console.log(`${key}'s merge is recorded with its PR missing: no --pr was given`);
    console.log(describeHistory(recordMerge({ state: stateDir(), queue: q, key, mergedPrs: () => ghMergedPrs(ghRepo()) })));
    const est = recordEstimateMerge(stateDir(), key, t.merged_at);
    if (est) console.log(`first estimate kept with its merge: could run to ${est.could_run_to}, merged ${Date.parse(est.merged_at) < Date.parse(est.could_run_to) ? 'before' : 'after'} it`);
    break;
  }

  // The orchestrator, once it has scheduled its next pass: the last pass's heartbeat records when, so
  // desk-q counts the batch live through a wait longer than LIVE_MS. Same as pass.mjs --next.
  case 'next-pass': {
    const at = parseNext(args[0]);
    if (at == null) throw new Error('usage: queue.mjs next-pass <+seconds | ISO time>');
    const file = beatFile(stateDir(), QUEUE);
    if (!existsSync(file)) throw new Error('no pass has run on this queue yet: run pass.mjs --next instead');
    const hb = JSON.parse(readFileSync(file, 'utf8'));
    delete hb.tick;
    delete hb.tick_pass;
    // The session that records the next pass is the one whose /loop runs the batch (loop-tick.mjs).
    // The next pass recorded replaces a tick a pass run by hand carried (borrow.mjs loopTick).
    const loop = process.env.CLAUDE_CODE_SESSION_ID || hb.loop;
    writeFileSync(file, JSON.stringify({ ...hb, next: new Date(at).toISOString(), ...(loop ? { loop } : {}) }));
    console.log(`next pass ${new Date(at).toISOString()}`);
    if (markRearmed(stateDir(), Date.parse(hb.pass ?? hb.at))) console.log('the loop that lost its next tick is re-armed, and needs-you says so');
    break;
  }

  // A ticket recorded done with no worker (pass.mjs, done by another's PR): its worktree removed with its
  // local branch when nothing in it is missing from origin. It stays in the batch.
  case 'drop-worktree': {
    const key = args[0];
    const t = ticket(q, key);
    if (t.state === 'running') throw new Error(`${key} is running: its worktree is left`);
    const removed = dropWorktree(key, t);
    if (removed) console.log(`its worktree ${removed}, holding nothing origin lacks, was removed`);
    break;
  }

  case 'drop': {
    const key = args[0];
    const t = ticket(q, key);
    // A running ticket's worker is in its worktree, so that is left where it is.
    const running = t.state === 'running';
    const removed = running ? null : dropWorktree(key, t);
    delete q.tickets[key];
    // The person's step never merges, so a hold behind it here would never release. Dropped, it is held
    // outside instead, which pass.mjs lifts once Jira has it Done (a step has no code to land).
    const outside = [];
    if (personStepPark(t)) for (const o of Object.values(q.tickets)) {
      if (!blockersOf(o).includes(key)) continue;
      const was = String(o.held_outside ?? '').split('|').filter(Boolean);
      if (!was.includes(key)) o.held_outside = [...was, key].join('|');
      outside.push(o.key);
    }
    save(q);
    console.log(`dropped ${key} from the batch${outside.length ? `; ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} held behind it outside the batch until it is Done in Jira` : ''}${removed ? `; its worktree ${removed}, holding nothing origin lacks, was removed` : running && t.worktree ? `; its worker was running, so its worktree ${t.worktree} was left` : ''}`);
    break;
  }

  case 'get': {
    const t = found(q, args[0]);
    console.log(JSON.stringify(t.state === 'running' && t.location !== 'cloud' ? { ...t, live: liveOf(t) } : t, null, 2));
    break;
  }

  case 'list':
    console.log(JSON.stringify(q, null, 2));
    break;

  case 'render':
    console.log(render(q));
    break;

  // rebuild [<batch | standing>]: the batch's queue rebuilt from the ticket ledger, written to
  // queue.rebuilt.json beside its queue.json, and each ticket field where queue.json differs from it.
  // queue.json and the log are left as they are. Without a batch, this queue's.
  case 'rebuild': {
    const [name] = args;
    let file = QUEUE;
    if (name) {
      const want = /^standing$/i.test(name) ? null : name;
      const b = listBatches(repoSlug()).find((x) => x.name === want);
      if (!b) throw new Error(`no batch ${name} in this repo: its batches are ${listBatches(repoSlug()).map((x) => x.name ?? 'standing').join(', ')}`);
      file = b.queue;
    }
    const { rebuilt, diffs } = queueDifference(file, { waitMs: LOCK_WAIT_MS });
    const out = join(dirname(file), 'queue.rebuilt.json');
    writeFileSync(out, `${JSON.stringify(rebuilt, null, 2)}\n`);
    for (const d of diffs) console.log(`${d.path}: queue.json ${d.queue ?? '(absent)'}, rebuilt ${d.rebuilt ?? '(absent)'}`);
    console.log(`wrote ${out}: ${diffs.length} field(s) differ from ${file}`);
    break;
  }

  // The orchestrator's status monitor, run under Monitor: one plain command, so starting it never
  // prompts. Prints the table and the memory line once, then again only when a ticket's state or
  // question changes (with `--stages`, a stage step too); memory figures moving on their own print
  // nothing. Runs until killed, like `desk-env mem watch`.
  // At config §3b "Orchestrator status table" `quiet`, every print after the first is one line per
  // ticket that changed, not the whole table.
  case 'watch': {
    if (!existsSync(QUEUE)) throw new Error(`no queue at ${QUEUE}: start a batch (queue.mjs init) before watching it`);
    const i = args.indexOf('--interval');
    const intervalMs = (i >= 0 && Number(args[i + 1]) > 0 ? Number(args[i + 1]) : 90) * 1000;
    const mode = statusTableSetting();
    if (mode.bad) console.log(mode.bad);
    if (mode.value === 'quiet') console.log('status table quiet: after this table, one line per ticket that changed; queue.mjs render prints the whole table\n');
    // A queue that cannot be read (gone, or hand-mangled) is shown once as its error, rather than
    // ending the monitor: the next good read prints the table again (quiet: what changed since the
    // last good read).
    const read = () => { try { return { q: existsSync(QUEUE) ? readQueue(QUEUE) : empty() }; } catch (e) { return { err: `queue: ${e.message}` }; } };
    // A stage step alone wakes nobody: desk-q shows it. `--stages` compares stages too.
    const stages = args.includes('--stages');
    // Each running worker waiting on an unanswered question.
    let state = null;
    try { state = stateDir(); } catch { /* no state directory to read questions from */ }
    const asks = (q) => {
      const out = {};
      for (const t of state ? Object.values(q.tickets) : []) {
        const asked = t.state === 'running' && openQuestion(state, t.key);
        if (asked) out[t.key] = asked;
      }
      return out;
    };
    let last = null;
    let good = null;
    for (;;) {
      const { q: now, err } = read();
      const opts = err ? null : { stages, asks: asks(now) };
      const table = err ?? render(now, opts);
      if (table !== last) {
        const changes = err || !good || mode.value !== 'quiet' ? null : tableChanges(good, tableRows(now, opts));
        const text = changes ? changes.join('\n') : err ?? render(now, { asks: opts.asks });
        if (text) console.log(`${text}\n${memStatusLine()}\n`);
      }
      last = table;
      if (!err) good = tableRows(now, opts);
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  default:
    throw new Error(unknownQueueCommand(cmd));
}
} catch (e) {
  console.error(`queue: ${e.message}`);
  process.exit(e.exit ?? EXIT.SHOW_PERSON);
}

// The status table, as one string.
function render(q, opts) {
  const { head, rows, parked } = tableRows(q, opts);
  if (!rows.length) return 'queue is empty';
  const out = [`${head}\n`, ...rows.map((r) => `  ${r.label.padEnd(8)} ${r.key.padEnd(9)} ${r.tail}`)];
  if (parked) out.push(`\n${parked} ticket(s) waiting on you.`);
  return out.join('\n');
}

// Config §3b "Orchestrator status table": `full` or `quiet`, unset meaning full. Anything else is
// said and read as full.
function statusTableSetting(raw = configValue('status-table')) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'full' || v === 'quiet' || v === '') return { value: v || 'full', bad: null };
  return { value: 'full', bad: `config §3b "Orchestrator status table" is "${raw}" — want \`full\` or \`quiet\`; read as full` };
}

// What changed between two reads of the table, one line per ticket (key, then old → new), plus a
// line for the batch's own heading when that changed. Empty when nothing shown changed.
function tableChanges(before, after) {
  const line = (r) => `${r.label} ${r.tail}`.trim();
  const was = new Map(before.rows.map((r) => [r.key, r]));
  const now = new Map(after.rows.map((r) => [r.key, r]));
  const out = before.head === after.head ? [] : [`batch     ${before.head} → ${after.head}`];
  for (const r of after.rows) {
    const o = was.get(r.key);
    if (!o) out.push(`${r.key.padEnd(9)} added → ${line(r)}`);
    else if (line(o) !== line(r)) out.push(`${r.key.padEnd(9)} ${line(o)} → ${line(r)}`);
  }
  for (const o of before.rows) if (!now.has(o.key)) out.push(`${o.key.padEnd(9)} ${line(o)} → dropped`);
  return out;
}

// A done ticket is DONE only once its PR has merged, or it finished with no PR: one whose PR is still
// open is PR OPEN, and one whose PR was closed unmerged CLOSED. One whose draft's checks are re-run
// once, as their failed logs name no file it changes (checksRerun), is ON CHECKS until they finish.
function doneLabel(t) {
  if (t.result?.pr == null || t.merged_at) return 'DONE';
  const ps = prStatusOf(t)?.state ?? null;
  return ps === 'MERGED' ? 'DONE' : ps === 'CLOSED' ? 'CLOSED' : checksRerun(t) ? 'ON CHECKS' : 'PR OPEN';
}

// The table's parts: the batch heading, one row per ticket in shown order, and how many wait on you.
// `stages: false` leaves a running ticket's stage out, so a stage step alone changes nothing;
// `asks` maps a running ticket to the question it is waiting on, shown on its row.
function tableRows(q, { stages = true, asks = {} } = {}) {
  const rows = Object.values(q.tickets);
  const order = { parked: 0, running: 1, triaged: 2, queued: 3, failed: 4, done: 5 };
  // A ticket handed off between sessions (handoff pending, pass.mjs) is triaged until its next session
  // starts, which a preflight can take minutes over: it reads as a handoff beside the running rows,
  // not as a fresh ticket.
  const handingOff = (t) => t.state === 'triaged' && t.handoff === 'pending' && !isHeld(t) && !(questionsOpen(t) > 0);
  const rank = (t) => (handingOff(t) ? order.running : order[t.state] ?? 9);
  rows.sort((a, b) => rank(a) - rank(b));
  const head = `batch ${q.batch ?? '-'}   concurrency ${q.concurrency}${q.epic ? `   epic ${q.epic}` : ''}${q.base ? `   base ${q.base}` : ''}`;
  const out = [];
  for (const t of rows) {
    const parks = isHeld(t) ? waitingOnPark(q, t) : null;
    const day = dateHeld(t);
    // A bare hold (bareHold) is released by the next pass, so it is held, not stuck.
    const bare = bareHold(t);
    const stuck = !day && !bare && isHeld(t) && !parks && !waitingOnMerge(q, t);
    const label = stuck ? 'STUCK' : isHeld(t) ? 'HELD' : t.state === 'done' ? doneLabel(t) : handingOff(t) ? 'HANDOFF' : t.state.toUpperCase();
    const by = blockersOf(t);
    const byText = by.join(', ') || '?';
    const spines = by.filter((p) => spinePark(q.tickets[p]));
    const tail = day?.bad ? badLabelText(day.label)
      : day ? `until ${day.until} (label ${day.label})`
      : bare ? bareHoldText(t.key)
      : stuck && stoppedHold(t) ? 'its worker was stopped (queue.mjs stop): it starts once you let it (needs-you: start)'
      : stuck ? `held behind ${byText}, which will not merge on its own (no PR, a closed PR, or not in the batch): decide what happens to it`
      : parks ? `waiting on the answer to ${parks.join(', ')} (failed or parked), then until ${byText} merge`
      : isHeld(t) && spines.length ? `waiting on approval of spine ${spines.join(', ')}, then until ${byText} merge`
      : isHeld(t) ? `until ${byText} merge${(t.open_questions ?? 0) > 0 ? ` · ${t.open_questions} question(s) open` : ''}`
      : t.state === 'parked' ? t.park?.question ?? ''
      : t.state === 'failed' ? failedWhy(t)
      : t.state === 'running' ? `${stages ? `stage ${t.stage ?? '?'}  ` : ''}port ${t.port ?? '-'}${t.model ? `  model ${t.model}` : ''}${t.draft_pr ? `  PR #${t.draft_pr}` : ''}${asks[t.key] ? `  asks: ${asks[t.key]}` : ''}`
      : t.state === 'done' && label === 'ON CHECKS' ? `PR #${t.result.pr} draft, waiting on checks: re-run once as their failed logs name no file it changes`
      : t.state === 'done' ? (t.result?.pr ? `PR #${t.result.pr}${t.merged_at ? ' merged' : ''}` : '')
      : t.state === 'triaged' && questionsOpen(t) > 0 ? `blocked: ${questionsOpen(t)} question(s) open, ${answerWith(t)}`
      : handingOff(t) ? `starting Stage ${t.handoff_stage ?? '?'}`
      : '';
    // A tier raised by a requeue shows until the ticket finishes, so the change is visible.
    const modelNote = t.model_note && ['triaged', 'running'].includes(t.state) ? `  (${t.model_note})` : '';
    const followNote = t.follow_on_unreadable ? `  ${unreadableFollowOn(t.follow_on_unreadable.raw)}` : '';
    out.push({ key: t.key, label, tail: `${tail}${modelNote}${followNote}` });
  }
  const parked = rows.filter((t) => t.state === 'parked' && !(isHeld(t) && (waitingOnMerge(q, t) || waitingOnPark(q, t)))).length;
  return { head, rows: out, parked };
}
