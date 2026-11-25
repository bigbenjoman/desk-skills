#!/usr/bin/env node
// A batch a session runs through /loop (§3b Batches run by `session`) moves only while that session
// keeps scheduling the loop's next tick. hooks/desk-handoff.py asks this script, from inside the
// session, whether a batch whose last pass it ran has lost that tick. Run it from inside the repo.
//   node loop-tick.mjs check <session> stop   at a turn's end: {key, text} when a batch the session
//                                            runs has a ticket a pass could move and no next pass
//                                            recorded still to come, the text asking it to schedule
//                                            one before the turn ends; nothing otherwise
//   node loop-tick.mjs check <session> turn   as the session works: {key, text} when such a batch has
//                                            had no pass for twice its interval, the text telling it
//                                            to re-arm the loop. The re-arm is logged (TICK_FILE) for
//                                            needs-you's stalled item
//   node loop-tick.mjs could-not <why...>     the session could not re-arm this batch's loop (--batch
//                                            <name> for a named one): needs-you's item says why
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { LIVE_MS, lastBeat } from './borrow.mjs';
import { loadRepos, movable } from './desk-q.mjs';

// Each batch's last re-arm, in its state folder: { pass, session, rearmed_at, why }.
export const TICK_FILE = 'loop-tick.json';

// The interval the loop keeps: from its last pass to the next it recorded; with none recorded, half
// of LIVE_MS, so a batch's loop reads lost when desk-q reads its passes stopped.
export const loopInterval = (r) => (r.next != null && r.last != null && r.next > r.last ? r.next - r.last : LIVE_MS / 2);
// A batch a session runs, that has run a pass and has a ticket a pass could move, with no next pass
// recorded still to come.
export const unscheduled = (r, now = Date.now()) => !!r.q && r.run?.by === 'session' && r.last != null && movable(r)
  && (r.next == null || r.next <= now);
// When an unscheduled batch's loop reads lost: twice its interval after its last pass.
export const lostAt = (r) => r.last + 2 * loopInterval(r);
export const loopLost = (r, now = Date.now()) => unscheduled(r, now) && now >= lostAt(r);

// The re-arm logged for the batch's last pass `last`, or null.
export function readRearm(stateDir, last) {
  try {
    const x = JSON.parse(readFileSync(join(stateDir, TICK_FILE), 'utf8'));
    return x && Date.parse(x.pass) === last ? x : null;
  } catch { return null; }
}
function writeRearm(stateDir, rec) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, TICK_FILE), JSON.stringify(rec));
}

const clock = (t) => `${new Date(t).toISOString().slice(11, 16)} UTC`;
const batchArg = (r) => (r.batch ? ` --batch ${r.batch}` : '');

// The batches in this repo whose last pass ran in `session`.
const ownBatches = (session, now) => loadRepos(now, E.repoSlug()).filter((r) => r.slug === E.repoSlug() && r.session === session && !r.error);

//   -> { key, text } or null
export function check(session, mode, now = Date.now()) {
  const own = ownBatches(session, now).filter((r) => (mode === 'stop' ? unscheduled(r, now) : loopLost(r, now)));
  if (!own.length) return null;
  const key = own.map((r) => `${r.id}@${r.last}`).join(' ');
  if (mode === 'stop') {
    return { key, text: `desk loop: this session runs ${own.map((r) => `${r.name} (last pass ${clock(r.last)})`).join(' and ')} through /loop, and no next pass is scheduled. `
      + 'Before ending the turn, schedule the loop\'s next tick, whatever the last pass printed or however it ended, and record it: '
      + `${own.map((r) => `node ~/.claude/desk/bin/queue.mjs next-pass +<seconds>${batchArg(r)}`).join('; ')}. If a tick is already scheduled, record it all the same.` };
  }
  for (const r of own) writeRearm(r.stateDir, { pass: new Date(r.last).toISOString(), session, rearmed_at: new Date(now).toISOString() });
  return { key, text: own.map((r) => `desk loop: ${r.name}'s loop lost its next tick: no pass has run since ${clock(r.last)}, twice its ${Math.round(loopInterval(r) / 60000)}-minute interval, and none is scheduled. `
    + `Once the step you are on is done, re-arm it: run a pass (node ~/.claude/desk/bin/pass.mjs --json${batchArg(r)}), act on it as the loop does, schedule the loop's next tick and record it (node ~/.claude/desk/bin/queue.mjs next-pass +<seconds>${batchArg(r)}). `
    + `This re-arm is logged, and needs-you says so. If you cannot re-arm it, record why: node ~/.claude/desk/bin/loop-tick.mjs could-not "<why>"${batchArg(r)}`).join('\n') };
}

const isMain = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'check' && args[0] && ['stop', 'turn'].includes(args[1])) {
      const out = check(args[0], args[1]);
      if (out) console.log(JSON.stringify(out));
    } else if (cmd === 'could-not' && args.join(' ').trim()) {
      const beat = lastBeat(E.stateDir(), E.queueFile());
      if (beat?.pass == null) throw new Error('no pass has run on this batch yet');
      const was = readRearm(E.stateDir(), beat.pass) ?? { pass: new Date(beat.pass).toISOString(), session: beat.session };
      writeRearm(E.stateDir(), { ...was, why: args.join(' ').trim() });
      console.log(`recorded: the loop could not be re-armed: ${args.join(' ').trim()}`);
    } else {
      console.error('usage: loop-tick.mjs check <session> <stop|turn> | could-not <why...>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`loop-tick: ${e.message}`);
    process.exit(1);
  }
}
