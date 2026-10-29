# desk-autopilot: a batch that targets a feature branch

Part of desk-autopilot, read at Stage 0 when the batch targets a feature branch (`set-batch base=`,
or the queue shows a `base`). It binds exactly as the core `SKILL.md` does. Where it says "above" or
"below" of something this file does not hold, or cites a section in *italics* it does not hold, that
is in the core or in the file the core's reference table names.

## A batch that targets a feature branch

Some work ships as one merge from a long-lived branch (a release with no feature flag), so its PRs
must base on that branch, not on §0 Default branch. Set it once per batch, **after `init` and before
triage**:

```bash
node ~/.claude/desk/bin/queue.mjs set-batch base=feat/<branch>   # base= clears it; init clears it too
```

- It refuses a branch that is not on origin, and any production branch. Push the branch first.
- `pass.mjs`, `triage.sh` and `merge-driver.sh` export it as `DESK_DEFAULT_BRANCH`. Worktrees then
  branch from it, workers rebase onto it and open their PRs against it (their system prompt names
  it), and the merge driver merges only PRs based on it.
- Interactive sessions in the same repo never read the queue, so they keep §0 Default branch.
- `queue.mjs render` shows `base <branch>`. Say it in the Stage 2 report.

**Check before the first spawn that CI runs on PRs into that branch.** A workflow filtered to
`branches: [<default>]` reports nothing on such a PR, so every required check reads "has not
reported" and nothing ever merges.

**`pass.mjs` keeps the base current; do not merge into it by hand.** Every pass makes sure the base
has its own worktree, `<§2 Worktrees directory>/base-<branch>` (a plain `git worktree add`, no
database or env files). Before a pass that will spawn, and only then, it merges §0 Default branch into
the base there as a merge commit (never a rebase, so running workers' bases stay valid) and pushes
it, and the report says how many commits came in. A push refused as non-fast-forward (the merge
driver just merged into the base) is fetched, merged again and retried once. Pushing is config §3
`batch-base-push`: unset or `ask` is one approval per batch, so ask it at Stage 3 and run passes with
`AUTOPILOT_BASE_PUSH_APPROVED=1`. A sync that cannot run pushes nothing and goes under `WAITING ON
YOU` with its reason: a conflict (its files listed; resolve it in the base worktree and push), a
refused push, the row, or the primary checkout having the base checked out (switch it off that
branch; no base worktree is made until then). In feature mode that pass spawns nothing; otherwise
spawning carries on from the base as it stands. Feature mode here is the decision `plan-batch`
recorded on the queue when it seeded (`feature`), not whatever `feature.json` names.

**A conflict goes to a conflict fix worker before it comes to you** (`base-fix.mjs`), where §3
`pr-conflict-unreviewed` is `yes`: the base is merged work no reviewer has read as one change. The
pass starts a task worker in the base worktree, under the id `base-<branch>` with its ticket file in
`$DESK_STATE/tickets/`, and it merges §0 Default branch in (a merge, never a rebase or a force push),
resolves the files git lists, verifies the merged tree and pushes the base under the same
`batch-base-push` grant. It takes a worker slot, and while it runs the pass leaves the base worktree
alone (no sync, no baseline, no base gate) and, in feature mode, still spawns nothing else. The next
pass that syncs the base clean says so and clears the tries, kept on the queue as `base_fix`. A base
gets two tries, one per head of the base, as a PR in conflict does: after two, or a try that left
the base where it was, or with the row not `yes`, the conflict goes under `WAITING ON YOU`, naming
its files and what the last try did (parked, finished, or no marker); resolve it in the base
worktree and push.

**Baseline checks (config §4 "Baseline checks" `on`).** Once the sync is done, and only when the
base has moved since the last record, the pass runs §4 Install, Typecheck and Lint in the base
worktree and records their errors in `<state>/baseline.json`. The report says
`baseline: recorded <base> at <sha>: typecheck <n> error(s) · lint <n> error(s)`, or names a check
whose output it could not read (workers run that one in full). Each worker's briefing then carries a
`Baseline checks` section telling it to check with `desk-env baseline typecheck|lint`, which fails
only on errors its branch adds. A base that cannot be recorded (a dirty base worktree, a failed
install) goes under `WAITING ON YOU` and leaves no baseline, so workers run the full checks. CI and
the pre-push hook are unchanged.
