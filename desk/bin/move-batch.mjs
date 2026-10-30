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
// starts one again in the moved batch's folder. Only a batch the supervisor runs moves, and only while
// no worker runs: a live worker writes its park, handoff and resume files to the folder it was spawned
// with, which a pass of the moved batch never reads. A screenshot folder the queue records under the
// old folder is rewritten to the new one.
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
const lockPid = () => { try { return Number(readFileSync(join(queueLock, 'pid'), 'utf8').trim()) || null; } catch { return null; } };
process.on('exit', () => {
  if (lockPid() === process.pid) rmSync(queueLock, { recursive: true, force: true });
  try { if (JSON.parse(readFileSync(passLock, 'utf8')).pid === process.pid) unlinkSync(passLock); } catch { /* gone */ }
});

// queue.mjs's lock, taken the way it takes it: one mkdir, never over a lock that is there. A lock a
// dead writer left is cleared by queue.mjs's next write, under its own clearing lock.
try { mkdirSync(queueLock); } catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const pid = lockPid();
  refuse(`${pid && !alive(pid) ? `a queue write that has exited (pid ${pid}) left ${queueLock}: the next queue.mjs write clears it` : `a queue write holds ${queueLock}${pid ? ` (pid ${pid})` : ''}`}: run this again in a moment. Nothing was moved`);
}
writeFileSync(join(queueLock, 'pid'), `${process.pid}\n`);

// Read again under the locks: a pass may have spawned a worker since the first read.
const cur = readQueue(from.queue);
if (cur.supervised !== true) refuse(`the standing batch ${name} is run by a session, not the supervisor: that session's next pass would look for it in the standing slot. Hand it to the supervisor first (queue.mjs set-batch supervised=true, desk-autopilot Stage 4), then run this again. Nothing was moved`);
const running = [...Object.values(cur.tickets ?? {}).filter((t) => t?.state === 'running').map((t) => t.key), ...(cur.base_fix?.running ? ['the base fix'] : [])];
if (running.length) refuse(`${running.join(', ')} ${running.length === 1 ? 'is' : 'are'} running: a running worker writes its park, handoff and resume files to the standing slot it was spawned in. Run this again once no worker is running (each parks, hands off or finishes). Nothing was moved`);
const oldRoot = `${from.state}/`;
const images = Object.values(cur.tickets ?? {}).filter((t) => typeof t?.images_dir === 'string' && E.expandHome(t.images_dir).startsWith(oldRoot));
for (const t of images) t.images_dir = join(to.state, E.expandHome(t.images_dir).slice(oldRoot.length));

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
const sup = join(from.state, 'supervisor.json');
try {
  // The supervisor's next tick must run a pass, not read the batch as the idle one it was: only a
  // pass starts a merge driver. A driver this move stopped did not fail, so it counts no failed start.
  if (existsSync(sup)) {
    const s = JSON.parse(readFileSync(sup, 'utf8'));
    s.idle = null;
    if (driver && s.driver) s.driver.pid = null;
    writeFileSync(sup, `${JSON.stringify(s, null, 2)}\n`);
  }
  for (const f of readdirSync(from.state)) {
    if (STAYS.includes(f)) continue;
    renameSync(join(from.state, f), join(to.state, f));
    moved.push(f);
  }
  if (images.length) {
    const tmp = `${to.queue}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}\n`);
    renameSync(tmp, to.queue);
    unlinkSync(from.queue);
  } else renameSync(from.queue, to.queue);
} catch (e) {
  if (existsSync(from.queue)) rmSync(to.queue, { force: true });
  const stuck = moved.reverse().filter((f) => { try { renameSync(join(to.state, f), join(from.state, f)); return false; } catch { return true; } });
  try { rmdirSync(to.state); rmdirSync(dirname(to.queue)); } catch { /* not empty */ }
  refuse(`could not move the batch (${e.message})${stuck.length ? `; still in ${to.state}, to move back by hand: ${stuck.join(', ')}` : ': nothing was moved'}`);
}

const tickets = Object.keys(cur.tickets ?? {}).length;
console.log(`move-batch: moved batch ${name} (base ${cur.base}, ${tickets} ticket${tickets === 1 ? '' : 's'}, run by the supervisor) from the standing slot to batch ${epic}`);
console.log(`  queue: ${to.queue}`);
console.log(`  state: ${to.state}`);
if (images.length) console.log(`  screenshot folders now under it: ${images.map((t) => t.key).join(', ')}`);
if (driver) console.log(`  its merge driver (pid ${driver}) was stopped: the supervisor's next tick starts it again in batch ${epic}`);
console.log(`  the standing slot is free on ${E.configValue('default-branch') || 'the default branch'}: /desk-admit admits plain tickets there`);
