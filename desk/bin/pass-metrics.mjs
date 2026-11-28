// One JSON line per pass in <state>/passes.jsonl: how busy the batch was and why tickets waited, so
// it reads as a time series rather than only the queue's latest `pass` record. A line also carries
// the collision warning on the pass that gives it, which the check-in digest lists.
//
// The warning: STREAK_PASSES passes in a row, each holding at least one ticket on a collision while
// fewer workers run than IDLE_SHARE of the batch's concurrency. It is given once per streak; the
// streak and whether it was warned live on the queue's `pass` record (collision_streak,
// collision_warned), and a pass where the condition does not hold resets both.
//
// A line also carries `setup`: one entry per worktree setup-worktree.sh finished this pass, with the
// seconds each step took. `node pass-metrics.mjs setup-medians [<state dir> ...]` reports each repo's
// median per step over its new worktrees: every repo under ~/.desk-autopilot when none is named, each
// one's standing batch and named batches together, else each named state dir on its own.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { namedBatches } from './batches.mjs';
import { quantile } from './quantile.mjs';

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

// Each line of the batch's metrics file that holds the field `field`, parsed. A torn line is skipped.
function linesWith(state, field) {
  const path = metricsPath(state);
  if (!existsSync(path)) return [];
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l.includes(`"${field}"`)) continue;
    try { const e = JSON.parse(l); if (e && typeof e === 'object') out.push(e); } catch { /* a torn line */ }
  }
  return out;
}

// Every warning the batch's metrics file holds: [{at, text}], `at` the time it was written.
export function readWarnings(state) {
  return linesWith(state, 'warning').flatMap((e) => { const at = e.warned_at ?? e.at; return at && e.warning ? [{ at, text: e.warning }] : []; });
}

// Every placed ticket a pass moved (§3b "Queue order: placed tickets" `move-and-say`), as the metrics
// file holds them: [{at, key, from, to, gain_min, text}].
export function readQueueMoves(state) {
  return linesWith(state, 'queue_moves').flatMap((e) => (e.moved_at && Array.isArray(e.queue_moves) ? e.queue_moves.map((m) => ({ at: e.moved_at, ...m })) : []));
}

// setup-worktree.sh's `steps=` line as {step: seconds}, in the order run; null when the output has none.
export function parseSetupSteps(out) {
  const m = [...String(out ?? '').matchAll(/\[setup-worktree\] steps=(\S*)/g)].pop();
  if (!m) return null;
  const steps = {};
  for (const part of m[1].split(',')) {
    const [name, secs] = part.split(':');
    if (name && /^\d+$/.test(secs ?? '')) steps[name] = (steps[name] ?? 0) + Number(secs);
  }
  return steps;
}

const median = (xs) => quantile(xs, 0.5);

// Each repo's state dirs under `root`, its standing batch first, then its named batches, then its
// archived ones, keeping only those with a metrics file: [{ slug, states }]. A batch pass logs under
// `batches/<name>/`, and batch.mjs moves that folder to `batches/.done/<name>/` when it archives it.
export function repoStates(root = join(E.HOME, '.desk-autopilot')) {
  let slugs = [];
  try { slugs = readdirSync(root).sort(); } catch { /* no autopilot state yet */ }
  const subdirs = (d) => { try { return readdirSync(d).sort().map((n) => join(d, n)); } catch { return []; } };
  return slugs
    .map((slug) => {
      const dir = join(root, slug);
      const named = namedBatches(dir).map((b) => join(dir, E.BATCHES_DIR, b));
      const archived = subdirs(join(dir, E.BATCHES_DIR, '.done'));
      const states = [dir, ...named, ...archived].filter((d) => existsSync(metricsPath(d)));
      return { slug, states };
    })
    .filter((r) => r.states.length);
}

// A repo's setup durations from the metrics files of one state dir or several (its batches). Medians
// are over new worktrees only: a kept one skips the install.
// { new, kept, from, to, total, steps: {step: {median, max, n}} }; a torn line is skipped.
export function setupMedians(states) {
  const runs = [];
  let kept = 0;
  for (const state of [states].flat()) {
    let raw = '';
    try { raw = readFileSync(metricsPath(state), 'utf8'); } catch { /* no metrics yet */ }
    for (const l of raw.split('\n')) {
      if (!l.includes('"setup"')) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      for (const s of e?.setup ?? []) {
        if (!s?.steps) continue;
        if (s.kept) { kept += 1; continue; }
        runs.push({ at: e.at, steps: s.steps });
      }
    }
  }
  runs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const by = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.steps)) (by[k] ??= []).push(v);
  const steps = Object.fromEntries(Object.entries(by).map(([k, xs]) => [k, { median: median(xs), max: Math.max(...xs), n: xs.length }]));
  const totals = runs.map((r) => Object.values(r.steps).reduce((a, b) => a + b, 0));
  return { new: runs.length, kept, from: runs[0]?.at ?? null, to: runs.at(-1)?.at ?? null, total: median(totals), steps };
}

export function setupMediansText(slug, m) {
  if (!m.new) return `${slug}: no new worktree setups recorded${m.kept ? ` (${m.kept} kept)` : ''}`;
  const rows = Object.entries(m.steps).map(([k, s]) => `  ${k.padEnd(10)} median ${String(s.median).padStart(5)}s  max ${String(s.max).padStart(5)}s  n=${s.n}`);
  return [`${slug}: ${m.new} new worktree setups, ${m.from.slice(0, 10)} to ${m.to.slice(0, 10)}, median total ${m.total}s${m.kept ? ` (${m.kept} kept, not counted)` : ''}`, ...rows].join('\n');
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const [cmd, ...dirs] = process.argv.slice(2);
  if (cmd !== 'setup-medians') { console.error('usage: pass-metrics.mjs setup-medians [<state dir> ...]'); process.exit(2); }
  const root = join(E.HOME, '.desk-autopilot');
  const repos = dirs.length ? dirs.map((d) => ({ slug: basename(d), states: [d] })) : repoStates(root);
  if (!repos.length) { console.log(`no passes.jsonl under ${root}`); process.exit(0); }
  console.log(repos.map((r) => setupMediansText(r.slug, setupMedians(r.states))).join('\n\n'));
}
