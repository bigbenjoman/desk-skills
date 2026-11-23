#!/usr/bin/env node
// Moves a standing batch that runs on a base (an epic's feature branch) into its own batch slot,
// `batches/<name>/` (batches.mjs), so the standing slot is free on the default branch again and plain
// tickets can be admitted there. Run it from inside the repo:
//   node move-batch.mjs        move it, or say why not
// The slot is named after the queue's `epic` (queue.mjs set-batch epic=<KEY>), or, where it names none
// because the batch spans several epics, after its base branch (batches.mjs slotFor). The queue moves whole, so its
// tickets, parks, base and supervised flag stay as they were, and so does every file in the batch's
// state folder except those that belong to the slot (STAYS). A standing batch on the default branch, or
// none, is left alone.
// While it moves it holds the batch's pass lock and queue lock, so no pass, supervisor tick or queue
// write runs halfway through, and it stops the batch's merge driver first: the supervisor's next tick
// starts one again in the moved batch's folder. Only a batch the supervisor runs moves, and only while
// no worker runs: a live worker writes its park, handoff and resume files to the folder it was spawned
// with, which a pass of the moved batch never reads. A batch with workers running drains instead: its
// new spawns pause (worker count 0, kept as the user's) while those workers carry on to a park, a
// handoff or a PR and the merge driver keeps merging, so a window to move always comes; run this again
// then, and the move sets the count back. A screenshot folder the queue records under the old folder
// is rewritten to the new one.
// Exits 0 (moved, or nothing to move), 11 (refused, with nothing moved) or 12 (draining: spawns paused,
// nothing moved yet).
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as E from './desk-env.mjs';
import { readQueue, crashShowsPerson, describeCrash, Refusal } from './batch-state.mjs';
import { readCloseouts } from './closeout.mjs';
import { slotFor, onlyKeptTriage } from './batches.mjs';
import { lockPid, unlock, alive, tryLockFile } from './dir-lock.mjs';
import { writeQueueFile, archivePath, readQueueAt, reportMissed } from './queue-store.mjs';
import { auditsIn } from './levers-audit.mjs';
import { ledgerOn, ledgerTarget, recordWrite } from './queue-ledger.mjs';

crashShowsPerson((e) => console.error(`move-batch: ${describeCrash(e)}`));

// What stays with the standing slot: its named batches, the locks this move holds, the supervisor
// agent's own log (launchd writes it for the repo), intake's register (intake admits into the slot),
// the repo's asks (asks.mjs), the refused config rows already pushed (supervisor.mjs), the exits folder
// the supervisor watches with its tick lock and wake record (every batch's workers write there), and the
// levers' repo-level records with their locks: the lever log (lever-log.mjs), the blind audits and their
// queue (levers-audit.mjs) and the evaluations with their evidence (levers-evaluate.mjs). Each is kept
// once per repo, not per batch, and read from this folder. The ticket ledger is not here: it sits beside
// the queue under repos/<slug>, which a move leaves alone.
const STAYS = [E.BATCHES_DIR, 'ref', 'orchestrator.lock', 'supervisor.lock', 'supervisor.agent.log', 'intake.json', 'asks.json',
  'config-pushed.json', 'exits', 'supervisor.tick.lock', 'supervisor.wake'];
const REPO_LEVEL = ['cloud-archived.json', 'levers.jsonl', 'audit.jsonl', 'audit-queue.json', 'lever-evals.jsonl', 'levers-evidence'];
// A repo-level file's lock and its write in progress (dir-lock.mjs writeTextAtomic's .tmp.<pid>) stay too.
const stays = (f) => STAYS.includes(f) || REPO_LEVEL.some((n) => f === n || f.startsWith(`${n}.lock`) || f.startsWith(`${n}.tmp.`));
// How long a stopped merge driver has to let go of its lock.
const DRIVER_WAIT_MS = Number(process.env.DESK_MOVE_DRIVER_WAIT_MS) > 0 ? Number(process.env.DESK_MOVE_DRIVER_WAIT_MS) : 30_000;

const refuse = (msg) => { throw new Refusal(msg); };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The live process other than this one holding a `{pid}` lock file, or null.
const holder = (file) => {
  try { const { pid } = JSON.parse(readFileSync(file, 'utf8')); return pid && pid !== process.pid && alive(pid) ? pid : null; } catch { return null; }
};

const slug = E.repoSlug();
const from = E.batchPaths(slug);
if (!existsSync(from.queue)) {
  console.log('move-batch: there is no standing batch: nothing to move');
  process.exit(0);
}
const q = readQueue(from.queue);
const name = q.batch ?? '?';
if (!q.base) {
  console.log(`move-batch: the standing batch ${name} runs on the default branch: nothing to move`);
  process.exit(0);
}
const slot = slotFor(q);
if (slot.why) refuse(`the standing batch ${name} runs on base ${q.base}, but ${slot.why}, so it has no slot to move to: set its epic with queue.mjs set-batch epic=<KEY>, then run this again. Nothing was moved`);
const epic = slot.name;
const to = E.batchPaths(slug, epic);
// A slot holding only an earlier epic start's kept triage records is free: they go just before the move.
const leftover = onlyKeptTriage(to);
const taken = [to.queue, ...(leftover ? [] : [to.state])].filter((p) => existsSync(p));
if (taken.length) refuse(`batch ${epic} already has ${taken.join(' and ')}: a repo holds one batch per ${slot.by}. Nothing was moved`);

mkdirSync(from.state, { recursive: true });
const passLock = join(from.state, 'orchestrator.lock');
const queueLock = `${from.queue}.lock`;
// The pass lock is taken exclusively, as pass.mjs claim() and queue.mjs stop take it (tryLockFile), so
// this never writes over one they hold; it goes when this process exits. A supervisor tick is looked
// for once it is held.
const passHolder = tryLockFile(passLock, { by: 'move-batch.mjs' });
const busy = passHolder === true ? holder(join(from.state, 'supervisor.lock')) : (passHolder ?? '?');
if (busy) refuse(`a pass is running in the standing batch (pid ${busy}): run this again once it finishes. Nothing was moved`);
process.on('exit', () => unlock(queueLock));

// queue.mjs's lock (dir-lock.mjs), taken with the same mkdir but refused at once rather than waited
// for, and never over a lock that is there. A lock a dead writer left is cleared by queue.mjs's next
// write, under dir-lock.mjs's clearing lock.
try { mkdirSync(queueLock); } catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const pid = lockPid(queueLock);
  refuse(`${pid && !alive(pid) ? `a queue write that has exited (pid ${pid}) left ${queueLock}: the next queue.mjs write clears it` : `a queue write holds ${queueLock}${pid ? ` (pid ${pid})` : ''}`}: run this again in a moment. Nothing was moved`);
}
writeFileSync(join(queueLock, 'pid'), `${process.pid}\n`);

// Read again under the locks: a pass may have spawned a worker since the first read.
const cur = readQueue(from.queue);
if (cur.supervised !== true) refuse(`the standing batch ${name} is run by a session, not the supervisor: that session's next pass would look for it in the standing slot. Hand it to the supervisor first (queue.mjs set-batch supervised=true, desk-autopilot Stage 4), then run this again. Nothing was moved`);
const running = [...Object.values(cur.tickets ?? {}).filter((t) => t?.state === 'running').map((t) => t.key), ...(cur.base_fix?.running ? ['the base fix'] : [])];
const DRAIN = ['concurrency', 'concurrency_by', 'concurrency_user'];
const BY = 'move-batch.mjs';
const writeQueue = (file, q, opts = {}) => writeQueueFile(file, q, { by: BY, ...opts });
// The queue as it stands in the standing slot, which the ledger compares the moved one with.
const before = ledgerOn() ? readQueueAt(from.queue) : null;
if (running.length) {
  // A worker count of 0 is a pause pass.mjs and borrowing both honour, resumes and the base fix
  // included. The count it replaces is kept, unless this batch is already draining: a count the
  // person has set since then is theirs, and replaces it.
  if (!cur.move_drain || cur.concurrency !== 0) {
    cur.move_drain = { epic, at: new Date().toISOString(), ...Object.fromEntries(DRAIN.map((k) => [k, cur[k] ?? null])) };
    Object.assign(cur, { concurrency: 0, concurrency_by: 'user', concurrency_user: 0 });
    writeQueue(from.queue, cur);
  }
  console.log(`move-batch: ${running.join(', ')} ${running.length === 1 ? 'is' : 'are'} running, and a running worker writes its park, handoff and resume files to the standing slot it was spawned in, so batch ${name} drains first. Its new spawns are paused (worker count 0) since ${cur.move_drain.at}; ${running.length === 1 ? 'that worker carries' : 'those workers carry'} on, and its merge driver keeps merging. Run this again once none is running (each parks, hands off or finishes): the move sets the worker count back. Nothing was moved yet`);
  process.exit(12);
}
// The move sets back the worker count the drain paused, unless the person has set one since.
const drained = !!cur.move_drain;
if (drained) {
  if (cur.concurrency === 0) for (const k of DRAIN) { if (cur.move_drain[k] == null) delete cur[k]; else cur[k] = cur.move_drain[k]; }
  delete cur.move_drain;
}
// The supervisor's decider session (decider.mjs) writes into the folder it was started with, too.
const sup = join(from.state, 'supervisor.json');
const s = existsSync(sup) ? JSON.parse(readFileSync(sup, 'utf8')) : null;
if (s?.decider?.pid && alive(s.decider.pid)) refuse(`the supervisor's decider session (pid ${s.decider.pid}) is running: it writes to the standing slot it was started in. Run this again once it ends. Nothing was moved`);
const oldRoot = `${from.state}/`;
const images = Object.values(cur.tickets ?? {}).filter((t) => typeof t?.images_dir === 'string' && E.expandHome(t.images_dir).startsWith(oldRoot));
for (const t of images) t.images_dir = join(to.state, E.expandHome(t.images_dir).slice(oldRoot.length));
// A close-out note names the queue it was written for, and a pass applies only its own queue's.
const notes = readCloseouts(from.state).filter((n) => n.queue === from.queue).map((n) => ({ file: n.file, was: readFileSync(n.file, 'utf8') }));

// A blind audit spawned from this folder reads its log and exit record from it, and the repo's audit
// queue stays here while its logs and workers move: one running or not yet recorded would be recorded
// with no findings. Only this batch's pass spawns one into this folder, and its lock is held, so none
// starts after the check.
const inAudit = auditsIn(slug, from.state);
if (!inAudit) refuse(`the repo's audit queue (${join(from.state, 'audit-queue.json')}) does not read, so a blind audit reading its log from the standing slot cannot be ruled out: run this again once a pass has rewritten it. Nothing was moved`);
const audits = inAudit.map((i) => i.ticket);
if (audits.length) refuse(`the blind audit of ${audits.join(', ')} is running or not yet recorded, and its log is read from the standing slot: run this again once a pass has recorded it. Nothing was moved`);

// The batch's own driver, and the repo's one driver, whose lock lives in this folder too: both stop
// before anything moves, and the supervisor's next tick starts the repo's again in the standing slot.
let driver = null;
for (const lock of [undefined, E.REPO_DRIVER_LOCK]) {
  const pid = E.mergeDriverHolder(from.state, lock);
  if (pid === 'starting') refuse('the merge driver is starting: run this again in a minute. Nothing was moved');
  if (!pid) continue;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  const until = Date.now() + DRIVER_WAIT_MS;
  while (E.mergeDriverHolder(from.state, lock) && Date.now() < until) sleep(200);
  if (E.mergeDriverHolder(from.state, lock)) refuse(`the merge driver (pid ${pid}) was asked to stop and is still running after ${DRIVER_WAIT_MS / 1000}s: stop it, then run this again. Nothing was moved`);
  driver ??= pid;
}

// Everything moves, or nothing does: a failed rename puts back what went before it.
if (leftover) rmSync(to.state, { recursive: true, force: true });
mkdirSync(to.state, { recursive: true });
mkdirSync(dirname(to.queue), { recursive: true });
const moved = [];
try {
  // The supervisor's next tick must run a pass, not read the batch as the idle one it was: only a
  // pass starts a merge driver. A driver this move stopped did not fail, so it counts no failed start.
  // An ended decider's result is read on that tick, from where it now is.
  if (s) {
    s.idle = null;
    if (driver && s.driver) s.driver.pid = null;
    if (typeof s.decider?.out === 'string' && s.decider.out.startsWith(oldRoot)) s.decider.out = join(to.state, s.decider.out.slice(oldRoot.length));
    writeFileSync(sup, `${JSON.stringify(s, null, 2)}\n`);
  }
  for (const n of notes) writeFileSync(n.file, `${JSON.stringify({ ...JSON.parse(n.was), queue: to.queue })}\n`);
  for (const f of readdirSync(from.state)) {
    if (stays(f)) continue;
    renameSync(join(from.state, f), join(to.state, f));
    moved.push(f);
  }
  if (images.length || drained) {
    writeQueue(to.queue, cur, { record: false });
    unlinkSync(from.queue);
  } else renameSync(from.queue, to.queue);
  if (existsSync(archivePath(from.queue))) renameSync(archivePath(from.queue), archivePath(to.queue));
} catch (e) {
  if (existsSync(from.queue)) rmSync(to.queue, { force: true });
  const stuck = moved.reverse().filter((f) => { try { renameSync(join(to.state, f), join(from.state, f)); return false; } catch { return true; } });
  for (const n of notes) { try { if (existsSync(n.file)) writeFileSync(n.file, n.was); } catch { /* left naming the new queue */ } }
  try { rmdirSync(to.state); rmdirSync(dirname(to.queue)); } catch { /* not empty */ }
  refuse(`could not move the batch (${e.message})${stuck.length ? `; still in ${to.state}, to move back by hand: ${stuck.join(', ')}` : ': nothing was moved'}`);
}
// The ledger records the move once it has happened: a moved event per ticket naming both batches.
if (before) reportMissed(to.queue)(recordWrite(to.queue, before, readQueueAt(to.queue), { by: BY, from: ledgerTarget(from.queue).batch }));

const tickets = Object.keys(cur.tickets ?? {}).length;
console.log(`move-batch: moved batch ${name} (base ${cur.base}, ${tickets} ticket${tickets === 1 ? '' : 's'}, run by the supervisor) from the standing slot to batch ${epic}`);
console.log(`  queue: ${to.queue}`);
console.log(`  state: ${to.state}`);
if (images.length) console.log(`  screenshot folders now under it: ${images.map((t) => t.key).join(', ')}`);
if (drained) console.log(`  its worker count, paused while it drained, is ${cur.concurrency ?? 'the §3b default'} again`);
if (driver) console.log(`  its merge driver (pid ${driver}) was stopped: the supervisor's next tick starts it again in batch ${epic}`);
if (notes.length) console.log(`  close-out notes now name its queue: ${notes.length}`);
const onDefault = E.configValue('default-branch') || 'the default branch';
const workers = E.permission('autopilot-workers');
console.log(workers === 'yes'
  ? `  the standing slot is free on ${onDefault}: /desk-admit admits plain tickets there`
  : `  the standing slot is free on ${onDefault}, with no batch in it: /desk-admit starts one only where config §3 ${E.permissionKey('autopilot-workers')} is "yes" (it is "${workers}"), so plan one with /desk-autopilot <TICKET>...`);
