// How a merged PR landed on its base branch, read from its merge commit's first-parent chain: the one
// rule for the blind audit's range (pass.mjs auditMergeCommit) and the benchmark's base (bench-build.mjs).

// The format `git log --first-parent --format=<it> <merge commit>` is read with: parents, author date,
// subject, tab-separated.
export const LANDED_FORMAT = '%P%x09%aI%x09%s';

// That log's output, newest first: each commit's parent count, author date and subject.
export const landedOf = (stdout) => String(stdout ?? '').split('\n').filter(Boolean).map((l) => {
  const [parents, at, ...subject] = l.split('\t');
  return { parents: parents.split(' ').filter(Boolean).length, at, subject: subject.join('\t') };
});

// How a PR merged, from `landed` (landedOf, its first the merge commit) and `commits`, the PR's own
// commits oldest first as gh pr view gives them ({ authoredDate, messageHeadline }). Two parents is a
// merge commit. A rebase lands each of the PR's commits on one parent with the author date and subject it
// had, so the chain's last commits are the PR's; a single-parent commit where they are not is a squash.
//   -> 'merge' | 'rebase' | 'squash' | null when unread
export function mergeMethodOf({ landed, commits }) {
  const top = Array.isArray(landed) ? landed[0] : null;
  if (!top || !Array.isArray(commits)) return null;
  if (top.parents > 1) return 'merge';
  if (top.parents !== 1) return null;
  // GitHub's headline is the subject's first line, cut with … when long; git's subject joins its first
  // paragraph's lines.
  const same = (c, l) => l?.parents === 1 && Date.parse(c.authoredDate) === Date.parse(l.at)
    && String(l.subject ?? '').startsWith(String(c.messageHeadline ?? '').replace(/…$/, ''));
  const mine = [...commits].reverse();
  return mine.length > 0 && landed.length >= mine.length && mine.every((c, k) => same(c, landed[k])) ? 'rebase' : 'squash';
}
