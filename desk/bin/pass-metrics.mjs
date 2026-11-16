// One JSON line per pass in <state>/passes.jsonl: how busy the batch was and why tickets waited, so
// it reads as a time series rather than only the queue's latest `pass` record. A line also carries
// the collision warning on the pass that gives it, which the check-in digest lists.
//
// The warning: STREAK_PASSES passes in a row, each holding at least one ticket on a collision while
// fewer workers run than IDLE_SHARE of the batch's concurrency. It is given once per streak; the
// streak and whether it was warned live on the queue's `pass` record (collision_streak,
// collision_warned), and a pass where the condition does not hold resets both.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STREAK_PASSES = 10;
export const IDLE_SHARE = 0.25;
export const HOLD_REASONS = ['collision', 'memory', 'lock', 'usage'];

export const metricsPath = (state) => join(state, 'passes.jsonl');

// Tickets held this pass, by reason: `collision` the triaged tickets a running one collides with, and
// the eligible tickets left unspawned counted under the one hold that kept them (`why`, one of memory,
// lock or usage, or null when slots or another hold did).
export function heldCounts({ collision = 0, unspawned = 0, why = null }) {
  const held = Object.fromEntries(HOLD_REASONS.map((r) => [r, 0]));
  held.collision = collision;
  if (why && why !== 'collision' && HOLD_REASONS.includes(why)) held[why] += unspawned;
  return held;
}

// Does this line meet the warning's condition?
export function collisionIdle(line) {
  const conc = Number(line?.concurrency) || 0;
  return (Number(line?.held?.collision) || 0) > 0 && conc > 0 && (Number(line?.running) || 0) < IDLE_SHARE * conc;
}

// The streak after `line`, from the last pass's ({streak, warned}): `warn` is true on the pass that
// gives the warning. A warning not delivered (the line not written) is given again on the next pass.
export function collisionStep(prev, line) {
  if (!collisionIdle(line)) return { streak: 0, warned: false, warn: false };
  const streak = (Number(prev?.streak) || 0) + 1;
  const warn = streak >= STREAK_PASSES && !prev?.warned;
  return { streak, warned: !!prev?.warned || warn, warn };
}

// The warning's text: the held tickets, and the running tickets and files holding each.
export function warningText(line, streak) {
  const held = (line.collisions ?? []).map((c) => `${c.key} (behind ${(c.with ?? []).join(', ') || 'a running ticket'}${c.files?.length ? ` on ${c.files.join(', ')}` : ', files not recorded'})`);
  return `${streak} passes in a row held tickets on a collision while ${line.running} of ${line.concurrency} worker slots ran: ${held.join('; ') || `${line.held.collision} ticket(s)`}`;
}

// Appends one line: {ok} or {ok: false, why}.
export function appendMetrics(state, line) {
  try {
    mkdirSync(state, { recursive: true });
    appendFileSync(metricsPath(state), `${JSON.stringify(line)}\n`);
    return { ok: true };
  } catch (e) { return { ok: false, why: e.message }; }
}

// Every warning the batch's metrics file holds: [{at, text}], `at` the time it was written. A torn
// line is skipped.
export function readWarnings(state) {
  const path = metricsPath(state);
  if (!existsSync(path)) return [];
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l.includes('"warning"')) continue;
    try { const e = JSON.parse(l); const at = e?.warned_at ?? e?.at; if (at && e.warning) out.push({ at, text: e.warning }); } catch { /* a torn line */ }
  }
  return out;
}
