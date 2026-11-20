#!/usr/bin/env node
// Deletes a ticket's local branches once its PR has merged, where config §3 branch-delete allows it:
// the ticket's own branch and any backup branch it made (while rebasing, say). A branch qualifies only
// when the PR has merged and the branch holds nothing the base lacks: its tip is the head that merged,
// or merging it into the base changes nothing (a squash or rebase merge leaves no ancestry, so
// `git branch -d` would refuse it), and no worktree has it checked out. At branch-delete `merged` or
// `yes` each one that qualifies is deleted, pinned to the tip that was checked (`git update-ref -d`
// refuses if the branch moved since), with that tip printed so `git branch <name> <sha>` restores it;
// at `ask` each is named with that same pinned command to run once the person agrees; at `no` nothing
// is deleted. One that does not qualify is left, saying why.
//
//   merged-branch.mjs <PR> <branch>... [--repo <owner/name>]   (the repo defaults to §0 GitHub repo)
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: String(r.stderr || r.error?.message || '').trim() };
};
const lastLine = (r) => r.err.split('\n').pop() || r.out.split('\n').pop() || 'no output';

// Why <branch> holds nothing <base> lacks, given merged PR <pr>, or null when it may hold work.
export function heldInBase(branch, { pr, base, cwd }) {
  const git = (...a) => sh('git', a, cwd);
  const tip = git('rev-parse', '--verify', '-q', `refs/heads/${branch}`);
  if (!tip.ok) return { missing: true };
  if (tip.out === pr.headRefOid) return { tip: tip.out, why: `its tip is the head PR #${pr.number} merged` };
  if (E.baseHolds(git, base, tip.out)) return { tip: tip.out, why: `merging it into ${base} changes nothing` };
  return { tip: tip.out, why: null };
}
// The worktree that has <branch> checked out, or null.
const checkedOut = (branch, cwd) => {
  const list = sh('git', ['worktree', 'list', '--porcelain'], cwd).out.split('\n\n');
  const wt = list.find((w) => w.split('\n').includes(`branch refs/heads/${branch}`));
  return wt ? wt.split('\n')[0].replace(/^worktree /, '') : null;
};

// One line per branch: deleted, ready to delete (ask), or left with the reason.
export function tidy({ pr, branches, perm, base, cwd }) {
  return branches.map((b) => {
    if (pr.state !== 'MERGED') return `left ${b}: PR #${pr.number} is ${String(pr.state).toLowerCase()}, not merged`;
    const h = heldInBase(b, { pr, base, cwd });
    if (h.missing) return `no local branch ${b}`;
    if (!h.why) return `left ${b} (${h.tip}): it holds work ${base} lacks, so deleting it is a question`;
    const wt = checkedOut(b, cwd);
    if (wt) return `left ${b} (${h.why}): it is checked out in ${wt}`;
    // --no-deref: a symbolic branch ref is deleted itself, never the branch it points at.
    const del = ['update-ref', '--no-deref', '-d', `refs/heads/${b}`, h.tip];
    if (perm === 'merged' || perm === 'yes') {
      const d = sh('git', del, cwd);
      return d.ok ? `deleted ${b} (${h.why}; restore: git branch ${b} ${h.tip})` : `left ${b}: it could not be deleted at ${h.tip} (${lastLine(d)})`;
    }
    if (perm === 'ask') return `ready to delete ${b} (${h.why}), config §3 branch-delete is ask: git ${del.join(' ')}`;
    return `left ${b} (${h.why}): config §3 branch-delete is ${perm}`;
  });
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--repo');
  const repo = at < 0 ? E.ghRepo() : args.splice(at, 2)[1];
  const [n, ...branches] = args;
  if (!/^\d+$/.test(n ?? '') || !branches.length || !/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')
      || branches.some((b) => b.startsWith('-') || !/^[\w./-]+$/.test(b))) {
    console.error('usage: merged-branch.mjs <PR> <branch>... [--repo <owner/name>]'); process.exit(2);
  }
  const view = sh('gh', ['pr', 'view', n, '--repo', repo, '--json', 'number,state,headRefOid,baseRefName']);
  let pr;
  try { pr = JSON.parse(view.out); } catch { /* below */ }
  if (!view.ok || !pr) { console.error(`merged-branch: PR #${n} could not be read (${lastLine(view)}): nothing deleted`); process.exit(1); }
  const fetched = sh('git', ['fetch', '-q', 'origin', pr.baseRefName]);
  if (!fetched.ok) { console.error(`merged-branch: origin/${pr.baseRefName} could not be fetched (${lastLine(fetched)}): nothing deleted`); process.exit(1); }
  for (const line of tidy({ pr, branches, perm: E.permission('branch-delete'), base: `origin/${pr.baseRefName}` })) console.log(line);
}
