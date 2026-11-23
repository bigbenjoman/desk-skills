// The files desk leaves untracked in a worktree and never commits. desk-env.mjs's tree-status and
// tests/scope_sections.mjs (which tests/related.sh runs) both read them from here, so this module
// imports nothing.

// Each with the skill that writes it. `<TICKET>` stands for any one path segment.
export const KNOWN_UNTRACKED = Object.freeze([
  Object.freeze({ path: '.claude/desk-ticket-<TICKET>.json', by: 'desk-ticket', what: 'resume file' }),
]);
// The scratch files one desk-review run writes at the worktree root, `<run>` that run's id and `<seat>`
// a role.
const REVIEW_SCRATCH = Object.freeze(['desk-review-codex-brief-<run>.txt', 'desk-review-<seat>-brief-<run>.txt', 'desk-review-results-<run>.json', 'desk-review.md']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateRe = (t, fill) => new RegExp(`^${t.split(/(<[A-Za-z]+>)/).map((p) => (/^<[A-Za-z]+>$/.test(p) ? fill(p) : escapeRe(p))).join('')}$`);

// The lines of `git status --porcelain --untracked-files=all` output that are changes: every line but an
// untracked known file, or with `run`, an untracked scratch file of that review run.
export function treeStatus(porcelain, { run } = {}) {
  const known = KNOWN_UNTRACKED.map((k) => templateRe(k.path, () => '[^/]+'));
  if (run) known.push(...REVIEW_SCRATCH.map((s) => templateRe(s, (p) => (p === '<run>' ? escapeRe(run) : '[^/]+'))));
  return porcelain.split('\n').filter((l) => l && !(l.startsWith('?? ') && known.some((re) => re.test(l.slice(3)))));
}

// Whether a worktree-relative path is a file desk leaves untracked: a known untracked file, or a scratch
// file of any desk-review run.
export function deskUntracked(path) {
  return [...KNOWN_UNTRACKED.map((k) => k.path), ...REVIEW_SCRATCH].some((t) => templateRe(t, () => '[^/]+').test(path));
}
