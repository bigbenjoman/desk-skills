// A base that renumbers a migration leaves a child branch opening the old filename, and the child's
// tests fail with ENOENT once the base is merged in. pass.mjs asks childRenames about every open child
// on every pass, so a rename a sibling merged into the base is caught as well as one a base sync brought.
// git: (args) -> { ok, out }, run in a checkout holding `head` and `base`.

const MIGRATION_DIR = /(^|\/)(?:migrations?|migrate|alembic)\//i;

// A renumbering, from `git diff --name-status` lines: one path component changed in place, holding a
// digit, under a migrations directory. { from, to, old, new }, old and new being what a reference names.
export function renumberings(nameStatus) {
  const found = [];
  for (const line of String(nameStatus ?? '').split('\n')) {
    const [status, from, to] = line.split('\t');
    if (!/^R\d*$/.test(status ?? '') || !from || !to || !MIGRATION_DIR.test(from)) continue;
    const a = from.split('/'), b = to.split('/');
    const at = a.flatMap((x, i) => (x === b[i] ? [] : [i]));
    if (a.length === b.length && at.length === 1 && /\d/.test(a[at[0]])) found.push({ from, to, old: a[at[0]], new: b[at[0]] });
  }
  return found;
}

// Where the child first left the base: the parent of the oldest commit on its own line. Past a merge of
// the base into the child the merge base is ahead of the rename, and this is not.
function forkPoint({ head, base, git }) {
  const own = git(['rev-list', '--first-parent', '--reverse', `${base}..${head}`]);
  const first = own.ok ? own.out.split('\n')[0] : '';
  const fork = first ? git(['rev-parse', '--verify', '-q', `${first}^`]) : null;
  return fork?.ok ? fork.out : null;
}

// The migrations the base has renumbered since the child left it that the child's own changes still
// name by their old filename, each with the files naming it. Files the child did not change are the
// base's, and the base's rename updated those. -> [{ from, to, old, new, files }]; none when git cannot say.
export function childRenames({ head, base, git }) {
  const fork = forkPoint({ head, base, git });
  const moved = fork ? git(['diff', '-M', '--diff-filter=R', '--name-status', fork, base]) : null;
  const renames = moved?.ok ? renumberings(moved.out) : [];
  if (!renames.length) return [];
  const mergeBase = git(['merge-base', head, base]);
  const changed = mergeBase.ok ? git(['diff', '--name-only', mergeBase.out, head]) : null;
  const own = changed?.ok ? changed.out.split('\n').filter(Boolean) : [];
  return renames.flatMap((r) => {
    const paths = own.filter((f) => f !== r.from);
    if (!paths.length) return [];
    const hit = git(['--literal-pathspecs', 'grep', '-l', '-F', '-e', r.old, head, '--', ...paths]);
    const files = hit.ok ? hit.out.split('\n').filter(Boolean).map((l) => l.replace(`${head}:`, '')) : [];
    return files.length ? [{ ...r, files }] : [];
  });
}
