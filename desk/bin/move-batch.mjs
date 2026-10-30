#!/usr/bin/env node
// Moves a standing batch that runs on a base (an epic's feature branch) into that epic's own batch slot,
// `batches/<epic>/` (batches.mjs), so the standing slot is free on the default branch again and plain
// tickets can be admitted there. Run it from inside the repo:
//   node move-batch.mjs        move it, or say why not
// The epic is the queue's `epic` (queue.mjs set-batch epic=<KEY>). The queue moves whole, so its
// tickets, parks, base and supervised flag stay as they were, and so does every file in the batch's
// state folder except those that belong to the slot (STAYS). A standing batch on the default branch, or
// none, is left alone.
// While it moves it holds the batch's pass lock and queue lock, so no pass, supervisor tick or queue
// write runs halfway through, and it stops the batch's merge driver first: the supervisor's next tick
// starts one again in the moved batch's folder. A running worker keeps writing to its log, which
// moves with the folder.
// Exits 0 (moved, or nothing to move) or 11 (refused, with nothing moved).
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as E from './desk-env.mjs';
import { readQueue, crashShowsPerson, describeCrash, Refusal } from './batch-state.mjs';

crashShowsPerson((e) => console.error(`move-batch: ${describeCrash(e)}`));

// What stays with the standing slot: its named batches, the locks this move holds, the supervisor
// agent's own log (launchd writes it for the repo) and intake's register (intake admits into the slot).
const STAYS = [E.BATCHES_DIR, 'orchestrator.lock', 'supervisor.lock', 'supervisor.agent.log', 'intake.json'];
// How long a stopped merge driver has to let go of its lock.
const DRIVER_WAIT_MS = Number(process.env.DESK_MOVE_DRIVER_WAIT_MS) > 0 ? Number(process.env.DESK_MOVE_DRIVER_WAIT_MS) : 30_000;

const refuse = (msg) => { throw new Refusal(msg); };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
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
if (!q.epic) refuse(`the standing batch ${name} runs on base ${q.base}, but its queue names no epic, so it has no slot to move to: set it with queue.mjs set-batch epic=<KEY>, then run this again. Nothing was moved`);
if (!E.SAFE_ID.test(String(q.epic)) || String(q.epic).includes('..')) refuse(`the standing batch ${name}'s epic "${q.epic}" is not a batch name (letters, digits, . _ - only; no ..). Nothing was moved`);
const epic = String(q.epic);
const to = E.batchPaths(slug, epic);
const taken = [to.queue, to.state].filter((p) => existsSync(p));
if (taken.length) refuse(`batch ${epic} already has ${taken.join(' and ')}: a repo holds one batch per epic. Nothing was moved`);

mkdirSync(from.state, { recursive: true });
const passLock = join(from.state, 'orchestrator.lock');
const queueLock = `${from.queue}.lock`;
const busy = holder(passLock) ?? holder(join(from.state, 'supervisor.lock'));
if (busy) refuse(`a pass is running in the standing batch (pid ${busy}): run this again once it finishes. Nothing was moved`);
writeFileSync(passLock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
let queueLocked = false;
process.on('exit', () => {
  if (queueLocked) rmSync(queueLock, { recursive: true, force: true });
  try { if (JSON.parse(readFileSync(passLock, 'utf8')).pid === process.pid) unlinkSync(passLock); } catch { /* gone */ }
});

// queue.mjs's lock: a directory holding its writer's pid. A dead writer's lock is taken over.
try { mkdirSync(queueLock); } catch (e) {
  if (e.code !== 'EEXIST') throw e;
  let pid = null;
  try { pid = Number(readFileSync(join(queueLock, 'pid'), 'utf8').trim()) || null; } catch { /* none written yet */ }
  if (!pid || alive(pid)) refuse(`a queue write holds ${queueLock}${pid ? ` (pid ${pid})` : ''}: run this again in a moment. Nothing was moved`);
}
writeFileSync(join(queueLock, 'pid'), `${process.pid}\n`);
queueLocked = true;

const driver = E.mergeDriverHolder(from.state);
if (driver === 'starting') refuse('the merge driver is starting: run this again in a minute. Nothing was moved');
if (driver) {
  try { process.kill(driver, 'SIGTERM'); } catch { /* already gone */ }
  const until = Date.now() + DRIVER_WAIT_MS;
  while (E.mergeDriverHolder(from.state) && Date.now() < until) sleep(200);
  if (E.mergeDriverHolder(from.state)) refuse(`the merge driver (pid ${driver}) was asked to stop and is still running after ${DRIVER_WAIT_MS / 1000}s: stop it, then run this again. Nothing was moved`);
}

// Everything moves, or nothing does: a failed rename puts back what went before it.
mkdirSync(to.state, { recursive: true });
mkdirSync(dirname(to.queue), { recursive: true });
const moved = [];
try {
  for (const f of readdirSync(from.state)) {
    if (STAYS.includes(f)) continue;
    renameSync(join(from.state, f), join(to.state, f));
    moved.push(f);
  }
  renameSync(from.queue, to.queue);
} catch (e) {
  const stuck = moved.reverse().filter((f) => { try { renameSync(join(to.state, f), join(from.state, f)); return false; } catch { return true; } });
  try { rmdirSync(to.state); rmdirSync(dirname(to.queue)); } catch { /* not empty */ }
  refuse(`could not move the batch (${e.message})${stuck.length ? `; still in ${to.state}, to move back by hand: ${stuck.join(', ')}` : ': nothing was moved'}`);
}

const tickets = Object.keys(q.tickets ?? {}).length;
console.log(`move-batch: moved batch ${name} (base ${q.base}, ${tickets} ticket${tickets === 1 ? '' : 's'}${q.supervised === true ? ', handed to the supervisor' : ''}) from the standing slot to batch ${epic}`);
console.log(`  queue: ${to.queue}`);
console.log(`  state: ${to.state}`);
if (driver) console.log(`  its merge driver (pid ${driver}) was stopped: the supervisor's next tick starts it again in batch ${epic}`);
console.log(`  the standing slot is free on ${E.configValue('default-branch') || 'the default branch'}: /desk-admit admits plain tickets there`);
