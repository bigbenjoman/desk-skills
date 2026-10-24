# desk-clearance: updating branches and conflicts

Read when a PR is behind the default branch or conflicts, in whichever phase that comes up (an
IMPLEMENT brief, the merge lane's update). The config, ownership, what config §3 decides, the merge
bar, parking and the red flags every phase shares are in `../SKILL.md`, already loaded.

## Updating branches and conflicts

**Update only if actually behind, and only when next to merge** — it burns CI, moves the head (which
voids a §4 Clean review verdict recorded at the old SHA) and re-pings reviewers. Whether being behind
blocks a merge is §4 Branch protection ("branch must be up to date", `strict` in the API): where it
does not, behind is never a reason to wait; where it does, update the PR that is next to merge, and
only that one. Use `gh pr update-branch --rebase <n>`: server-side,
no local force-push, no half-rebased worktree. **A branch touching `.github/workflows/**` refuses
both update methods** without the `workflow` token scope — ask the user to run
`gh auth refresh -h github.com -s workflow`; do not route around it with a local push.

**On conflict: probe, show, then ask — never resolve one silently, and never park it bare.** At
§3 `pr-conflict-reviewed` `yes` the approved-in-advance resolution is still printed as a record. A
silent resolution can revert another ticket's fix — restoring a raw `<a>` where the design system
requires its own link component — with nothing failing. A one-line park is a handoff back to the user.
So, without touching any working tree:

```bash
git fetch --prune origin
git merge-tree --write-tree --name-only origin/<default branch> origin/<branch>
```

Put in the batch round: the conflicting files, the competing hunks, and **the resolution you propose
and why**. The user approves in a glance and a subagent applies it.

**After any merge of the default branch into a branch — conflicted or not — the subagent runs §4
Typecheck.** A marker-free merge routinely does not compile (deleted params, a removed export, a
renamed component). §4 Typecheck `none` is not a pass: say the merge is unverified. Typecheck is not
enough for message catalogs (i18n JSON and the like): audit every removed key against the source
that reads it. And on a branch that **renamed a directory**, files the default branch *added* land
at the old path with no conflict — list the old path and
compare counts (`references/hazards.md`).

**Never rebuild a branch** — no `reset --hard`, no cherry-pick reconstruction, no force-push.

**Stacked PRs** have their own traps — `DIRTY` is about the base, not the default branch, a parent's squash makes
the child conflict and exposes the parent's ignored files, a parent rebase makes your ref stale.
Read `references/hazards.md#stacked-prs` before touching one.
