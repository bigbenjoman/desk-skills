// Which files a finished worker changed outside its triaged scope. Report only: nothing parks or
// holds a merge on it. The counts it gives are what a repo needs before it enforces scope.
//
// A changed file is in scope when it is one of the triage record's `files_in_scope` (an entry ending
// `/` covers that directory), a test file, or an incidental path (config §4 Incidental paths, the
// repo's lockfiles when that row is unset). Everything else is reported against the ticket.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { globToRegExp } from './gate.mjs';
import { LOCKFILES } from './test-scope.mjs';

// Always incidental, whatever the row says.
export const TEST_GLOBS = Object.freeze(['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**']);

// The row's items (configValues: null when unset, ['none'] for none) -> the incidental globs. Unset
// is the lockfiles, which a dependency bump rewrites; a name with no `/` matches at any depth.
export function incidentalGlobs(items) {
  if (items == null) return [...LOCKFILES];
  if (items.length === 1 && /^none$/i.test(String(items[0]).trim())) return [];
  return items.map(String);
}

// §4 Append-only paths: files tickets only add to (a locale file each ticket adds strings to), which
// two tickets may share without colliding. The row's items -> { globs, bad }. Unset and `none` name no
// globs. A row that is not a list of path globs (an item with a space, an absolute path, a `..`) reads
// as none, with `bad` naming the row, so the collision check runs as it would with no row.
export const APPEND_ONLY_ROW = 'config §4 "Append-only paths"';
export function appendOnlyGlobs(items) {
  if (items == null || (items.length === 1 && /^none$/i.test(String(items[0]).trim()))) return { globs: [], bad: null };
  const globs = items.map((s) => String(s).trim());
  const wrong = globs.filter((g) => !g || /\s/.test(g) || g.startsWith('/') || g.split('/').includes('..'));
  if (!globs.length || wrong.length) return { globs: [], bad: `${APPEND_ONLY_ROW} is not a list of path globs (${wrong.join(' | ') || 'no items'})` };
  return { globs, bad: null };
}
// The row read by `read` (configValues, which throws on a row mixing `none` with other items) -> the
// same { globs, bad }, a throw read as a bad row.
export function appendOnlyFrom(read) {
  try { return appendOnlyGlobs(read()); } catch (e) { return { globs: [], bad: `${APPEND_ONLY_ROW}: ${e.message}` }; }
}
// The files both lists name that no append-only glob covers: what two tickets collide on.
export function sharedFiles(a, b, globs = []) {
  const mine = new Set(a ?? []);
  const res = globs.map(globToRegExp);
  return [...new Set(b ?? [])].filter((f) => mine.has(f) && !res.some((re) => re.test(String(f).replace(/^\.\//, ''))));
}

// The changed files no scope entry, test glob or incidental glob covers, in diff order.
export function outOfScope(changed, inScope, incidental) {
  const scope = (inScope ?? []).map((s) => String(s).trim().replace(/^\.\//, '')).filter(Boolean);
  const res = [...TEST_GLOBS, ...incidental].map(globToRegExp);
  const covered = (f) => scope.some((s) => (s.endsWith('/') ? f.startsWith(s) : f === s)) || res.some((re) => re.test(f));
  return [...new Set(changed)].filter((f) => f && !covered(f));
}

// The triage record's files_in_scope, or null when there is no readable record (nothing to compare).
export function triagedScope(stateDir, key) {
  try {
    const s = JSON.parse(readFileSync(join(stateDir, 'triage', `${key}.json`), 'utf8')).files_in_scope;
    return Array.isArray(s) ? s : null;
  } catch { return null; }
}

// What the branch changes against the base, both sides of a rename, or null when git cannot say.
export function changedFiles(worktree, base) {
  try {
    const out = execFileSync('git', ['-C', worktree, 'diff', '--name-only', '--no-renames', `${base}...HEAD`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return null; }
}

// The batch total from the queue's `out_of_scope` arrays (null: never checked): the tickets checked,
// those with any out-of-scope file, and how many such files in all.
export function batchScopeTotals(tickets) {
  const checked = tickets.filter((t) => Array.isArray(t.out_of_scope));
  const lists = checked.map((t) => t.out_of_scope).filter((l) => l.length);
  return { checked: checked.length, tickets: lists.length, files: lists.reduce((n, l) => n + l.length, 0) };
}
