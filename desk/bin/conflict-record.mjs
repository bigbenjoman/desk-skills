// The merge-time conflict record, and the per-file budget it lowers.
//
// pass.mjs records one entry per conflicting file each time it meets a merge-time conflict: a ready
// PR the merge driver finds in conflict with its base, or a batch base whose sync from the default
// branch stops on one. The record is JSONL in the repo's own state folder, shared by every batch,
// since its window outlives any one batch. An entry is
//   { file, ticket, pr, head, source?, at }
// with `pr` null for a base sync, `head` the PR's head (or the base's commit) and `source` the
// default branch's commit a base sync merged. The same conflict met again at the same commits on a
// later pass is not recorded twice.
//
// Only ticket-PR conflicts count toward the budget: a base sync's entries are kept but lower nothing
// (fromBaseSync). A file with CONFLICTS_TO_LOWER conflicts within CONFLICT_WINDOW_MS runs one ticket fewer than its
// configured places (config §3b "Per-file collision budget"), and one more again after each window
// with none, never above its configured places nor below 1.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoStateOf } from './desk-env.mjs';

export const CONFLICT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CONFLICTS_TO_LOWER = 3;

export const conflictsPath = (state) => join(repoStateOf(state), 'conflicts.jsonl');

const validEntry = (e) => !!e && typeof e === 'object' && typeof e.file === 'string' && e.file !== ''
  && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at));

// -> { entries, bad }. A missing record is an empty one. `bad` says why the record does not read:
// it could not be read, or a line is not an entry. `entries` still holds the lines that read, so a
// write does not repeat them, but the budget reads none of a record that is `bad`.
export function readConflicts(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { entries: [], bad: null } : { entries: [], bad: `${file} could not be read (${e.code ?? e.message})` }; }
  const entries = [];
  let bad = null;
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let e = null;
    try { e = JSON.parse(line); } catch { /* not JSON */ }
    if (validEntry(e)) entries.push(e);
    else bad ??= `${file} line ${i + 1} is not a conflict entry`;
  });
  return { entries, bad };
}

const entryKey = (e) => [e.ticket ?? '', e.pr ?? '', e.head ?? '', e.source ?? '', e.file].join('\u0000');

// Appends one entry per file of `files` not already recorded for this ticket, PR and commits.
//   -> { recorded: [file], error: string | null }
export function recordConflicts(file, { files, ticket, pr = null, head = null, source = null, at }) {
  const seen = new Set(readConflicts(file).entries.map(entryKey));
  const add = [...new Set(files ?? [])].filter(Boolean)
    .map((f) => ({ file: f, ticket, pr, head, ...(source ? { source } : {}), at }))
    .filter((e) => !seen.has(entryKey(e)));
  if (!add.length) return { recorded: [], error: null };
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, add.map((e) => `${JSON.stringify(e)}\n`).join(''));
  } catch (e) { return { recorded: [], error: `${file} could not be written (${e.code ?? e.message})` }; }
  return { recorded: add.map((e) => e.file), error: null };
}

// How many places below its configured k a file runs, from its conflicts' times (ms) as of `now`.
// Each CONFLICTS_TO_LOWER conflicts within one window lower it by one, the conflicts that did so then
// counting no further; each window since its last conflict or last raise with none raises it by one.
// It is never lowered by more than k - 1, so the file keeps one place. A conflict dated after `now` is not read.
export function loweredBy(times, k, now) {
  const cap = Math.max(0, k - 1);
  let drop = 0, quietFrom = -Infinity, recent = [];
  const settle = (t) => { while (drop > 0 && t - quietFrom >= CONFLICT_WINDOW_MS) { drop -= 1; quietFrom += CONFLICT_WINDOW_MS; } };
  for (const at of times.filter((x) => x <= now).sort((a, b) => a - b)) {
    settle(at);
    recent = recent.filter((x) => at - x < CONFLICT_WINDOW_MS);
    recent.push(at);
    if (recent.length >= CONFLICTS_TO_LOWER) { drop = Math.min(cap, drop + 1); recent = []; }
    quietFrom = at;
  }
  settle(now);
  return drop;
}

// An entry a batch base's sync from the default branch recorded (its ticket `base-<branch>`, no PR).
// A stale base meets the same conflict again on every default-branch commit, so these say the base
// is out of sync, which its own report line says, and nothing about tickets colliding on the file.
const fromBaseSync = (e) => e.pr == null && typeof e.ticket === 'string' && e.ticket.startsWith('base-');

// The record's ticket-PR conflicts by file: Map file -> [ms]. Base syncs lower no file's places.
export function conflictTimes(entries) {
  const by = new Map();
  for (const e of entries) {
    if (fromBaseSync(e)) continue;
    if (!by.has(e.file)) by.set(e.file, []);
    by.get(e.file).push(Date.parse(e.at));
  }
  return by;
}

// The conflicts on a file within the window ending at `now`.
export const recentCount = (times, now) => times.filter((x) => x <= now && now - x < CONFLICT_WINDOW_MS).length;
