# desk-cleanup step 3: Branches

Read at the start of step 3. The two-signal gate it runs is step 2's, already read. The config,
ownership, the order, the precondition, what is never touched, the confirmation and the red flags every step shares are in
`../SKILL.md`, already loaded.

## 3. Local branches with no worktree — report, don't delete

**Reported and left alone.** Deleting them was tried and dropped; the reasoning is
here so it isn't relitigated every run.

Still run the two-signal gate and record each tip SHA — the report says which branches have fully
landed. Then stop.

Why not delete:

- **`git branch -d` refuses most of them.** Its "fully merged" test is ancestry against HEAD and the
  upstream, and a squash or rebase merge leaves no ancestry. Most honest reports read "PR MERGED,
  squash confirmed" or "PR MERGED, second signal unavailable".
- **The only route past that is `git branch -D`**, which overrides a git refusal. See Red flags.
- **There is nothing to reclaim.** A branch is a ref holding one SHA; the disk win is worktrees.
- **Leaving them is riskless and useful.** After a squash they are the only place the individual
  commits still exist.
- **They mislead nothing.** They follow §5 Branch names, and where §4 Repo merge settings has
  `delete_branch_on_merge` on, GitHub already deleted the remotes, so they never show in
  `git branch -r`.

If the user explicitly asks for them gone, that is their call **only if config §3 `branch-delete`
is `yes` or `ask`** — then `git branch -D <branch>`, with the tip SHAs already in the report
so `git branch <name> <sha>` restores any of them. `no` or `TODO` means say it is disabled and offer
`/desk-setup`.
