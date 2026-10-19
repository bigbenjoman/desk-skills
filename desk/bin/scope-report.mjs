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
