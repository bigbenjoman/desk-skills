// How long each test-lock hold usually runs, from the holds passes have seen finish. Each pass hands
// holdStep the holders it reads (suite-wait.mjs holderOf, with the repo each works in) and the step
// diffs them against those the last pass saw, kept in <state>/lock-holds-seen.json: a holder gone (or
// back with a shorter hold, so a new run under its pid) has finished, and is appended to the repo's
// <state>/lock-holds.jsonl as
//   { repo, cmd, seconds, end }
// seconds is the hold as the last pass to see it read it, so a hold ending between passes counts short
// by up to one pass interval, and one starting and ending between two passes is not seen at all. A
// holder is known by its pid and command, so one whose directory a pass could not read (repo null) is
// the same hold, under the repo an earlier pass read. The caller skips a pass that could not read the
// process table at all: its holders are unknown, not gone.
// expectedOf gives the median of the last RECENT holds of a repo's command, or null with none.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from './dir-lock.mjs';
import { quantile } from './quantile.mjs';

const holdsFile = (state) => join(state, 'lock-holds.jsonl');
const seenFile = (state) => join(state, 'lock-holds-seen.json');
const RECENT = 20;
const idOf = (h) => `${h.pid}\0${h.cmd}`;

// One pass's step: `holders` [{ pid, repo, cmd, heldS }] held the test lock at `now`. -> the report's
// lines, only what could not be written.
export function holdStep(state, holders, { now = new Date().toISOString() } = {}) {
  let seen = {};
  try { const v = JSON.parse(readFileSync(seenFile(state), 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) seen = v; } catch { /* none seen yet */ }
  const current = Object.fromEntries(holders.filter((h) => h?.pid != null && h.cmd).map((h) => [idOf(h), { repo: h.repo ?? seen[idOf(h)]?.repo ?? null, cmd: h.cmd, seconds: h.heldS ?? null, at: now }]));
  const still = (id, s) => id in current && !(Number.isFinite(current[id].seconds) && current[id].seconds < s.seconds);
  const done = Object.entries(seen).filter(([id, s]) => Number.isFinite(s?.seconds) && !still(id, s))
    .map(([, s]) => ({ repo: s.repo, cmd: s.cmd, seconds: s.seconds, end: s.at }));
  const lines = [];
  if (done.length) {
    try {
      mkdirSync(dirname(holdsFile(state)), { recursive: true });
      appendFileSync(holdsFile(state), done.map((d) => `${JSON.stringify(d)}\n`).join(''));
    } catch (e) { lines.push(`lock holds: ${done.length} finished test-lock hold(s) could not be recorded (${String(e?.message ?? e).split('\n')[0]})`); return lines; }
  }
  try { writeJsonAtomic(seenFile(state), current); } catch (e) { lines.push(`lock holds: the holders seen this pass could not be noted (${String(e?.message ?? e).split('\n')[0]})`); }
  return lines;
}

// The usual hold of a repo's command, in seconds, as a function of (repo, cmd): the median of its last
// RECENT finished holds, rounded, or null with none recorded. A line that does not read is skipped.
export function expectedOf(state) {
  const by = new Map();
  let text = '';
  try { text = readFileSync(holdsFile(state), 'utf8'); } catch { /* no history */ }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const h = JSON.parse(line);
      if (!h?.cmd || !Number.isFinite(h.seconds)) continue;
      const k = `${h.repo ?? ''}\0${h.cmd}`;
      by.set(k, [...(by.get(k) ?? []), h.seconds].slice(-RECENT));
    } catch { /* skipped */ }
  }
  return (repo, cmd) => { const m = quantile(by.get(`${repo ?? ''}\0${cmd}`) ?? [], 0.5); return m == null ? null : Math.round(m); };
}
