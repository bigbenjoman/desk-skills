# desk-ticket Stage 9: Cleanup

Read at the start of Stage 9, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded.

| # | Stage | What happens |
|---|---|---|
| 9 | Cleanup | `git status` clean, release the lock, report the PR link and whether it merged. |

**Once the PR has merged, tidy its local branches** with `node ~/.claude/desk/bin/merged-branch.mjs
<PR> <branch> [<backup branch>...]`: the ticket's branch and every backup branch this ticket made (one
saved before a rebase, say), the worktree removed first. At §3 `branch-delete` (`desk-env perm
branch-delete`) `merged` or `yes` it deletes each that holds nothing the base lacks, printing its tip
to restore it; at `ask` it names each with the command, which you ask before running; at `no` it
deletes nothing. Relay what it prints. A branch it leaves because it holds work the base lacks is a
question at any value.
