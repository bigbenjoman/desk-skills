#!/usr/bin/env node
// A batch a session runs through /loop (§3b Batches run by `session`) moves only while that session
// keeps scheduling the loop's next tick. hooks/desk-handoff.py asks this script, from inside the
// session, whether a batch whose loop it runs has lost that tick. Run it from inside the repo.
//   node loop-tick.mjs check <session> stop   at a turn's end: {text} when a batch whose loop the
//                                            session runs has a ticket a pass could move and no next
//                                            pass recorded still to come, the text asking it to
//                                            schedule one before the turn ends; else {recheck: null}
//   node loop-tick.mjs check <session> turn   as the session works: {text} when such a batch's loop
//                                            reads lost (lostAt), the text telling it to re-arm the
//                                            loop now, logged (TICK_FILE) for needs-you's stalled
//                                            item; else {recheck}, when to ask again (epoch ms, or null)
//   node loop-tick.mjs could-not <why...>     the session could not re-arm this batch's loop (--batch
//                                            <name> for a named one): needs-you's item says why
// queue.mjs next-pass logs the re-arm made (markRearmed) once the session records its next pass.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { LIVE_MS, lastBeat } from './borrow.mjs';

// Each batch's lost tick, in its state folder: { pass, session, told_at, rearmed_at, why }.
export const TICK_FILE = 'loop-tick.json';

// The interval the loop keeps: from its last pass to the next it recorded; with none recorded, half
// of LIVE_MS.
export const loopInterval = (r) => (r.next != null && r.last != null && r.next > r.last ? r.next - r.last : LIVE_MS / 2);
// When a batch with no next pass to come reads its loop lost: twice its interval after its last pass,
// or sooner where desk-q reads its passes stopped before that (r.stoppedAt), so needs-you's stalled
// item never shows a loop its session has not yet been told to re-arm.
export const lostAt = (r) => Math.min(r.last + 2 * loopInterval(r), r.stoppedAt ?? Infinity);
// The session whose /loop runs the batch: the one that recorded its next pass, else the one its last
// pass ran in (borrow.mjs loopCarried).
export const loopSession = (r) => r.loop ?? r.session;
// A batch a session runs, that has run a pass, with no next pass recorded still to come.
export const unscheduled = (r, now = Date.now()) => !!r.q && r.run?.by === 'session' && r.last != null
  && (r.next == null || r.next <= now);

const readTick = (stateDir) => { try { return JSON.parse(readFileSync(join(stateDir, TICK_FILE), 'utf8')) || null; } catch { return null; } };
// The record for the batch's last pass `last`, or null.
export function readRearm(stateDir, last) {
  const x = readTick(stateDir);
  return x && Date.parse(x.pass) === last ? x : null;
}
function writeRearm(stateDir, rec) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, TICK_FILE), JSON.stringify(rec));
}
const iso = (t) => new Date(t).toISOString();

// queue.mjs next-pass, once it has recorded the next pass after `pass`: a re-arm the session was told
// to make, for that pass or an earlier one (re-arming runs a pass first), is made, and logged against
// `pass`, so the stalled item says so if this pass's loop is lost too. -> whether it was
export function markRearmed(stateDir, pass, now = Date.now()) {
  const rec = readTick(stateDir);
  if (pass == null || !rec?.told_at || rec.rearmed_at || !(Date.parse(rec.pass) <= pass)) return false;
  writeRearm(stateDir, { ...rec, pass: iso(pass), rearmed_at: iso(now) });
  return true;
}

const clock = (t) => `${iso(t).slice(11, 16)} UTC`;
const batchArg = (r) => (r.batch ? ` --batch ${r.batch}` : '');
const NEXT_PASS = (r) => `node ~/.claude/desk/bin/queue.mjs next-pass +<seconds>${batchArg(r)}`;

//   -> { text } or { recheck }
export async function check(session, mode, now = Date.now()) {
  // Loaded here: queue.mjs imports markRearmed, and has no use for desk-q.
  const { loadRepos, movable } = await import('./desk-q.mjs');
  const slug = E.repoSlug();
  const own = loadRepos(now, slug).filter((r) => r.slug === slug && !r.error && loopSession(r) === session && unscheduled(r, now) && movable(r));
  if (mode === 'stop') {
    if (!own.length) return { recheck: null };
    return { text: `desk loop: this session runs ${own.map((r) => `${r.name} (last pass ${clock(r.last)})`).join(' and ')} through /loop, and no next pass is scheduled. `
      + 'Before ending the turn, schedule the loop\'s next tick, whatever the last pass printed or however it ended, and record it: '
      + `${own.map(NEXT_PASS).join('; ')}. If a tick is already scheduled, record it all the same.` };
  }
  const lost = own.filter((r) => now >= lostAt(r));
  if (!lost.length) return { recheck: own.length ? Math.min(...own.map(lostAt)) : null };
  for (const r of lost) {
    // Told once per lost pass; a re-arm that was lost again is told afresh.
    const was = readRearm(r.stateDir, r.last);
    if (!was?.told_at || was.rearmed_at) writeRearm(r.stateDir, { pass: iso(r.last), session, told_at: iso(now) });
  }
  return { text: lost.map((r) => `desk loop: ${r.name}'s loop lost its next tick: no pass has run since ${clock(r.last)}, and none is scheduled. `
    + `Re-arm it now, before you carry on: run a pass (node ~/.claude/desk/bin/pass.mjs --json${batchArg(r)}), act on it as the loop does, then schedule the loop's next tick and record it (${NEXT_PASS(r)}). `
    + `Recording it logs the re-arm, and needs-you says so. If you cannot re-arm it, record why: node ~/.claude/desk/bin/loop-tick.mjs could-not "<why>"${batchArg(r)}`).join('\n') };
}

const isMain = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
const fail = (e) => { console.error(`loop-tick: ${e.message}`); process.exit(1); };
if (isMain()) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    // Not a top-level await: desk-q's imports reach this module again, which would wait on itself.
    if (cmd === 'check' && args[0] && ['stop', 'turn'].includes(args[1])) {
      check(args[0], args[1]).then((out) => console.log(JSON.stringify(out)), fail);
    } else if (cmd === 'could-not' && args.join(' ').trim()) {
      const beat = lastBeat(E.stateDir(), E.queueFile());
      if (beat?.pass == null) throw new Error('no pass has run on this batch yet');
      const was = readRearm(E.stateDir(), beat.pass) ?? { pass: iso(beat.pass), session: beat.loop ?? beat.session };
      writeRearm(E.stateDir(), { ...was, why: args.join(' ').trim() });
      console.log(`recorded: the loop could not be re-armed: ${args.join(' ').trim()}`);
    } else {
      console.error('usage: loop-tick.mjs check <session> <stop|turn> | could-not <why...>');
      process.exit(2);
    }
  } catch (e) { fail(e); }
}
