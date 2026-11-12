// A batch base's own worktree, and the sync that keeps it current with the default branch.
//
// A batch base (queue.mjs set-batch base=<branch>) drifts from the default branch for as long as the
// batch runs. pass.mjs keeps one worktree for it under the worktrees directory, a plain
// `git worktree add` (setup-worktree.sh also makes a database and copies env files, which the base
// needs neither of), and, before any pass that spawns and on any pass that finds the base behind,
// merges the default branch into the base there and pushes it, so new workers start on a current tree
// and a park waiting on the base containing the default branch clears.
//
// The sync is a merge commit, never a rebase: running workers branched from the base, and a rewritten
// base would strand them. It is all or nothing: a conflict is aborted and a refused push is rolled
// back, so the worktree is never left holding a merge origin does not have. A feature-mode batch's
// promotion PR needs the base to hold a commit the default branch lacks, which openingCommit pushes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { baseFixKey, binDir, commandPrefix, configValues, isNone, parseCommandItem } from './desk-env.mjs';
import { runItem } from './baseline.mjs';

const git = (cwd, args) => {
  try { return { ok: true, out: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message }; }
};
const firstLine = (s) => String(s).split('\n').map((l) => l.trim()).find(Boolean) ?? '';

export const baseWorktreePath = (worktreesDir, base) => join(worktreesDir, baseFixKey(base));

// -> { ok: true, path, made } | { ok: false, path, why }
export function ensureBaseWorktree({ main, worktrees, base }) {
  const path = baseWorktreePath(worktrees, base);
  // A branch can be checked out in one worktree only, so a primary checkout on the base leaves
  // nowhere to sync it but the person's own tree. Never touch theirs.
  const head = git(main, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (head.ok && head.out === base) {
    return { ok: false, path, why: `the primary checkout ${main} has ${base} checked out, so no base worktree was made and the base was not synced: switch the primary checkout off ${base} (git -C ${main} switch <another branch>)` };
  }
  const list = git(main, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return { ok: false, path, why: `could not list worktrees: ${firstLine(list.out)}` };
  const holder = list.out.split('\n\n').map((b) => ({
    dir: /^worktree (.+)$/m.exec(b)?.[1],
    branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1],
  })).find((w) => w.branch === base);
  // git lists the real path (/private/var on macOS for a /var path), so compare real paths.
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  if (holder && real(holder.dir) === real(path)) return { ok: true, path, made: false };
  if (holder) return { ok: false, path, why: `${base} is checked out in ${holder.dir}, so no base worktree was made and the base was not synced: switch that worktree off ${base}` };
  if (existsSync(path)) return { ok: false, path, why: `${path} exists but does not have ${base} checked out: move it aside so the base worktree can be made` };
  const fetched = git(main, ['fetch', '-q', 'origin', `refs/heads/${base}:refs/remotes/origin/${base}`]);
  if (!fetched.ok) return { ok: false, path, why: `could not fetch ${base} from origin: ${firstLine(fetched.out)}` };
  const local = git(main, ['rev-parse', '--verify', '-q', `refs/heads/${base}`]).ok;
  const add = git(main, local ? ['worktree', 'add', '-q', path, base] : ['worktree', 'add', '-q', '--track', '-b', base, path, `origin/${base}`]);
  if (!add.ok) return { ok: false, path, why: `git worktree add for ${base} failed: ${firstLine(add.out)}` };
  return { ok: true, path, made: true };
}

// A plain `[rejected]` is git refusing a non-fast-forward; a hook or branch protection says
// `[remote rejected]`, which a retry cannot fix.
const nonFastForward = (out) => /non-fast-forward|fetch first|\[rejected\]/i.test(out);

// Merges origin/<branch> into <base> in the base worktree and pushes. `push` is false when the
// permission row does not allow it, and `dry` only probes: neither changes anything.
//   -> { ok: true, merged: <commits that came in>, pushed, retried }
//    | { ok: false, reason: 'conflict', files, merged } | { ok: false, reason: 'push', why }
//    | { ok: false, reason: 'permission', merged } | { ok: false, reason: 'error', why }
// Bring the base worktree to origin's base, with origin's <branch> fetched beside it: a reason it could
// not, or null. Anything of its own the worktree holds is not this script's to push.
function catchUp(path, base, branch) {
  const f = git(path, ['fetch', '-q', 'origin', `refs/heads/${base}:refs/remotes/origin/${base}`, `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (!f.ok) return `could not fetch ${base} and ${branch} from origin: ${firstLine(f.out)}`;
  const dirty = git(path, ['status', '--porcelain']);
  if (!dirty.ok || dirty.out) return `the base worktree ${path} has uncommitted changes: commit or discard them there`;
  const ahead = git(path, ['rev-list', '--count', `origin/${base}..HEAD`]);
  if (ahead.out !== '0') return `the base worktree ${path} holds ${ahead.out} commit(s) origin's ${base} does not: push or drop them there`;
  const ff = git(path, ['merge', '-q', '--ff-only', `origin/${base}`]);
  return ff.ok ? null : `could not fast-forward ${path} to origin/${base}: ${firstLine(ff.out)}`;
}

const CHECK_TIMEOUT_MS = 300_000;
// The end of a check's output, short enough to quote in a report line or keep on the queue.
const checkQuote = (out) => String(out ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-10).join('\n').slice(-800);

// §4 Merged-tree check as a function of a worktree: null while it passes, else { command, output }.
// null with the row unset or `none`.
export function mergedTreeCheck() {
  const row = configValues('merged-tree-check-cmd');
  if (!row || isNone(row)) return null;
  const items = row.map(parseCommandItem);
  const prefix = commandPrefix();
  // `stopped`: it timed out or never started, so the failure says nothing about the tree.
  const check = (root) => {
    for (const { dir, cmd } of items) {
      const r = runItem({ bin: binDir(), root, dir, cmd, lock: 'nolock', prefix, timeout: CHECK_TIMEOUT_MS });
      if (r.code !== 0 || r.stopped) {
        return { command: dir === '.' ? cmd : `${dir}: ${cmd}`, output: r.stopped ? `it did not finish in ${CHECK_TIMEOUT_MS / 1000}s` : checkQuote(r.out) || `it exited ${r.code} and printed nothing`, ...(r.stopped ? { stopped: true } : {}) };
      }
    }
    return null;
  };
  check.row = row.join('\n');
  return check;
}

// §4 Merged-tree check on PR <pr> as it would land: its <head> merged into origin's <base>, in a
// detached checkout at <dir> that is removed after. GitHub reports no conflict or BEHIND for two PRs
// that each add the next migration where the base need not be up to date, so only this sees it.
// A result is kept in <cache> per head, base commit and §4 row, so a held PR is not checked every loop
// and a changed row checks it again. A check that timed out or never started is an error, never kept.
//   -> { result: 'none' } | { result: 'pass' | 'fail', base_sha, check? } | { result: 'error', why }
export function prTreeCheck({ repo, cache, dir, base, pr, head, check = mergedTreeCheck() }) {
  if (!check) return { result: 'none' };
  const f = git(repo, ['fetch', '-q', 'origin', `refs/heads/${base}:refs/remotes/origin/${base}`]);
  if (!f.ok) return { result: 'error', why: `could not fetch ${base} from origin: ${firstLine(f.out)}` };
  if (!git(repo, ['cat-file', '-e', `${head}^{commit}`]).ok && !git(repo, ['fetch', '-q', 'origin', `pull/${pr}/head`]).ok) {
    return { result: 'error', why: `its head ${String(head).slice(0, 9)} could not be fetched` };
  }
  const baseSha = git(repo, ['rev-parse', `origin/${base}`]).out;
  const row = createHash('sha1').update(String(check.row ?? '')).digest('hex').slice(0, 12);
  const kept = join(cache, `tree-${pr}-${head}-${baseSha}-${row}.json`);
  try { return JSON.parse(readFileSync(kept, 'utf8')); } catch { /* not checked at these commits yet */ }
  const drop = () => { git(repo, ['worktree', 'remove', '--force', dir]); rmSync(dir, { recursive: true, force: true }); git(repo, ['worktree', 'prune']); };
  drop();
  const add = git(repo, ['worktree', 'add', '-q', '--detach', dir, baseSha]);
  if (!add.ok) return { result: 'error', why: `no checkout of ${base} could be made at ${dir}: ${firstLine(add.out)}` };
  let r;
  const m = git(dir, ['-c', 'user.name=desk', '-c', 'user.email=desk@localhost', 'merge', '-q', '--no-ff', '--no-edit', head]);
  if (!m.ok) r = { result: 'error', why: `merging its head into ${base} at ${baseSha.slice(0, 9)} fails here: ${firstLine(m.out)}` };
  else {
    const failed = check(dir);
    if (failed?.stopped) r = { result: 'error', why: `\`${failed.command}\` ${failed.output}` };
    else r = failed ? { result: 'fail', base_sha: baseSha, check: failed } : { result: 'pass', base_sha: baseSha };
  }
  drop();
  if (r.result !== 'error') { try { writeFileSync(kept, JSON.stringify(r)); } catch { /* checked again next time */ } }
  return r;
}

// Puts the base worktree back at origin's base, for a fix try that ended without pushing what it merged.
export function dropUnpushed({ path, base }) {
  git(path, ['reset', '-q', '--hard', `origin/${base}`]);
  git(path, ['clean', '-fdq']);
}

// `check` is a mergedTreeCheck function, run on each clean merge before its push; one it fails is
// undone and comes back as { ok: false, reason: 'check', files: [], check: { command, output }, merged }.
export function syncBase({ path, base, branch, push = true, dry = false, check = null }) {
  const fail = (why) => ({ ok: false, reason: 'error', why });
  const behind = () => Number(git(path, ['rev-list', '--count', `HEAD..origin/${branch}`]).out) || 0;

  const stuck = catchUp(path, base, branch);
  if (stuck) return fail(stuck);
  let merged = behind();
  if (!merged) return { ok: true, merged: 0, pushed: false, retried: false };
  if (dry || !push) {
    const probe = git(path, ['merge-tree', '--write-tree', '--name-only', 'HEAD', `origin/${branch}`]);
    // With --name-only, a conflict prints the tree, then one conflicted path per line up to a blank line.
    if (!probe.ok) {
      const [, ...rest] = probe.out.split('\n');
      const end = rest.findIndex((l) => !l.trim());
      const files = [...new Set(end < 0 ? rest : rest.slice(0, end))].filter(Boolean);
      return files.length ? { ok: false, reason: 'conflict', files, merged } : fail(`could not probe merging ${branch} into ${base}: ${firstLine(probe.out)}`);
    }
    return dry ? { ok: true, merged, pushed: false, retried: false, dry: true } : { ok: false, reason: 'permission', merged };
  }

  for (let attempt = 0; ; attempt += 1) {
    const before = git(path, ['rev-parse', 'HEAD']).out;
    const m = git(path, ['merge', '-q', '--no-ff', '--no-edit', '-m', `Merge ${branch} into ${base}`, `origin/${branch}`]);
    if (!m.ok) {
      const files = git(path, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
      git(path, ['merge', '--abort']);
      git(path, ['reset', '-q', '--hard', before]);
      return files.length ? { ok: false, reason: 'conflict', files, merged } : fail(`merging ${branch} into ${base} failed: ${firstLine(m.out)}`);
    }
    if (check) {
      const failed = check(path);
      // Whatever it wrote goes, or the next sync refuses a dirty worktree.
      git(path, ['reset', '-q', '--hard', failed ? before : 'HEAD']);
      git(path, ['clean', '-fdq']);
      if (failed) return { ok: false, reason: 'check', files: [], check: failed, merged };
    }
    const p = git(path, ['push', '-q', 'origin', `HEAD:refs/heads/${base}`]);
    if (p.ok) return { ok: true, merged, pushed: true, retried: attempt > 0 };
    // Never leave a merge origin does not have: the next sync starts from origin's base again.
    git(path, ['reset', '-q', '--hard', before]);
    // The merge driver can merge a PR into the base between our fetch and our push. Once only.
    if (attempt === 0 && nonFastForward(p.out)) {
      const again = catchUp(path, base, branch);
      if (again) return fail(again);
      merged = behind();
      if (!merged) return { ok: true, merged: 0, pushed: false, retried: true };
      continue;
    }
    return { ok: false, reason: 'push', why: `the push to ${base} was refused${attempt ? ' (after one fetch and retry)' : ''}: ${firstLine(p.out.replace(/^To .*$/m, ''))}` };
  }
}

// GitHub opens no PR between two branches with nothing between them, so a promotion PR from a base
// with no commits beyond <branch> needs one: an empty commit, pushed to the base. Refused, it is rolled
// back like a refused sync.
//   -> { ok: true, ahead: <commits the base has beyond branch>, pushed }
//    | { ok: false, reason: 'permission' | 'push' | 'error', why }
export function openingCommit({ path, base, branch, push = true, message }) {
  const stuck = catchUp(path, base, branch);
  if (stuck) return { ok: false, reason: 'error', why: stuck };
  const ahead = Number(git(path, ['rev-list', '--count', `origin/${branch}..HEAD`]).out) || 0;
  if (ahead) return { ok: true, ahead, pushed: false };
  if (!push) return { ok: false, reason: 'permission', why: `${base} has no commits beyond ${branch}, and pushing the empty commit a PR needs is not granted` };
  const before = git(path, ['rev-parse', 'HEAD']).out;
  const c = git(path, ['commit', '-q', '--allow-empty', '-m', message]);
  if (!c.ok) return { ok: false, reason: 'error', why: `could not make the empty commit in ${path}: ${firstLine(c.out)}` };
  const p = git(path, ['push', '-q', 'origin', `HEAD:refs/heads/${base}`]);
  if (p.ok) return { ok: true, ahead: 1, pushed: true };
  git(path, ['reset', '-q', '--hard', before]);
  return { ok: false, reason: 'push', why: `the push of an empty commit to ${base} was refused: ${firstLine(p.out.replace(/^To .*$/m, ''))}` };
}
