// suite: merged branch (a merged ticket's local branches deleted where §3 branch-delete allows)
// layer: L2
// merged-branch.mjs's tidy against a real scratch repo: a branch whose tip is the merged head, one
// squash-merged (no ancestry), a backup branch, one holding work the base lacks, a PR not merged, and
// each §3 branch-delete value. desk-env's reading of `merged`, which only branch-delete takes.
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tidy } from '../desk/bin/merged-branch.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const T = scratch('merged-branch-');
const R = join(T, 'repo');
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(T, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (...a) => { const r = spawnSync('git', ['-C', R, ...a], { encoding: 'utf8', env }); return r.stdout.trim(); };
const has = (b) => spawnSync('git', ['-C', R, 'rev-parse', '--verify', '-q', `refs/heads/${b}`], { env }).status === 0;
writeFileSync(join(T, 'gitconfig'), '');
spawnSync('git', ['init', '-q', '-b', 'main', R], { env });
const commit = (file, text, msg) => { writeFileSync(join(R, file), text); git('add', file); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
commit('a.txt', 'a\n', 'init');

// feat: two commits, squash-merged onto main as one; feat-backup: a copy saved before a rebase.
git('checkout', '-q', '-b', 'feat');
commit('b.txt', 'b1\n', 'b1');
const head = commit('b.txt', 'b2\n', 'b2');
git('branch', 'feat-backup', head);
git('checkout', '-q', 'main');
commit('b.txt', 'b2\n', 'squash of feat');
// exact: a branch whose tip is the PR's merged head; extra: one with work main lacks.
git('branch', 'exact', head);
git('checkout', '-q', '-b', 'extra', head);
commit('c.txt', 'c\n', 'more');
git('checkout', '-q', 'main');

const pr = { number: 7, state: 'MERGED', headRefOid: head, baseRefName: 'main' };
// A PR whose merged head is not the local tip (pushed again after the branch was copied): only the
// base test can clear the branch.
const squash = { ...pr, headRefOid: '0'.repeat(40) };
const run = (perm, branches, p = pr) => tidy({ pr: p, branches, perm, base: 'main', cwd: R });

let out = run('no', ['feat', 'extra'], squash);
t('no: a squash-merged branch is left, naming the row', out[0], 'left feat (merging it into main changes nothing): config §3 branch-delete is no');
t('no: nothing is deleted', has('feat') && has('extra'), true);
out = run('ask', ['feat'], squash);
t('ask: it is named with the command to run once agreed, pinned to the tip checked', out[0], `ready to delete feat (merging it into main changes nothing), config §3 branch-delete is ask: git update-ref --no-deref -d refs/heads/feat ${head}`);
t('ask: and not deleted', has('feat'), true);
// The pinned command refuses once the branch has moved, so an approval given for one tip never
// deletes another.
git('branch', 'moved', head);
const asked = run('ask', ['moved'], squash)[0].split(': git ')[1].split(' ');
git('checkout', '-q', 'moved'); commit('d.txt', 'd\n', 'later'); git('checkout', '-q', 'main');
spawnSync('git', ['-C', R, ...asked], { env });
t('ask: its command deletes nothing once the branch moved', has('moved'), true);
// A branch a worktree has checked out is left.
git('branch', 'inwt', head);
git('worktree', 'add', '-q', join(T, 'wt'), 'inwt');
out = run('merged', ['inwt'], squash);
t('a branch checked out in a worktree is left, naming it', out[0].startsWith('left inwt (merging it into main changes nothing): it is checked out in ') && has('inwt'), true);
out = [...run('merged', ['exact']), ...run('merged', ['feat', 'feat-backup', 'extra', 'gone'], squash)];
t('merged: a branch at the merged head is deleted, its tip printed to restore it', out[0], `deleted exact (its tip is the head PR #7 merged; restore: git branch exact ${head})`);
t('merged: a squash-merged branch is deleted though git branch -d would refuse it', out[1], `deleted feat (merging it into main changes nothing; restore: git branch feat ${head})`);
t('merged: so is a backup branch the base holds', out[2].startsWith('deleted feat-backup (merging it into main changes nothing'), true);
t('merged: a branch with work the base lacks is left, as a question', out[3].startsWith('left extra (') && out[3].endsWith('): it holds work main lacks, so deleting it is a question'), true);
t('merged: a branch that does not exist is said so', out[4], 'no local branch gone');
t('merged: the merged ones are gone, the other kept', `${has('exact')} ${has('feat')} ${has('feat-backup')} ${has('extra')}`, 'false false false true');
git('branch', 'feat', head);
out = run('yes', ['feat'], { ...pr, state: 'OPEN' });
t('a PR not merged deletes nothing, at any value', `${out[0]} ${has('feat')}`, 'left feat: PR #7 is open, not merged true');

// A symbolic branch ref is deleted itself, never the branch it points at.
git('symbolic-ref', 'refs/heads/sym', 'refs/heads/main');
out = run('merged', ['sym'], squash);
t('a symbolic branch ref is deleted, not the branch it names', `${out[0].startsWith('deleted sym (')} ${has('sym')} ${has('main')}`, 'true false true');

// desk-env reads `merged` for branch-delete only: on any other row it is not a value, so a `no`.
const cfg = join(T, 'config.md');
writeFileSync(cfg, '## 3. Permissions\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n| `branch-delete` | d | `merged` | `merged` |\n| `worktree-remove` | w | `yes` | `merged` |\n');
const perm = (id) => spawnSync('node', [join(import.meta.dirname, '..', 'desk', 'bin', 'desk-env.mjs'), 'perm', id], { encoding: 'utf8', env: { ...env, DESK_CONFIG: cfg } }).stdout.trim();
t('desk-env reads branch-delete merged', perm('branch-delete'), 'merged');
t('and merged on another row reads as no', perm('worktree-remove'), 'no');

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'merged branch: all checks passed');
process.exit(fails ? 1 : 0);
