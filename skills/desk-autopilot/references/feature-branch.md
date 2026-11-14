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

An epic's batch is the exception: `batch.mjs start` sets its base when it makes the batch, and the
standing batch's queue is not touched (*An epic as a batch*).

- It refuses a branch that is not on origin, and any production branch. Push the branch first.
- `pass.mjs`, `triage.sh` and `merge-driver.sh` export it as `DESK_DEFAULT_BRANCH`. Worktrees then
  branch from it, workers rebase onto it and open their PRs against it (their system prompt names
  it), and the merge driver merges only PRs based on it.
- Interactive sessions in the same repo never read the queue, so they keep §0 Default branch.
- `queue.mjs render` (an epic's batch: `queue.mjs render --batch <EPIC>`) shows `base <branch>`.
  Say it in the Stage 2 report.

**Check before the first spawn that CI runs on PRs into that branch.** A workflow filtered to
`branches: [<default>]` reports nothing on such a PR, so every required check reads "has not
reported" and nothing ever merges.

**`pass.mjs` keeps the base current; do not merge into it by hand.** Every pass makes sure the base
has its own worktree, `<§2 Worktrees directory>/base-<branch>` (a plain `git worktree add`, no
database or env files), on a detached HEAD at origin's base, so the primary checkout or another
worktree having the branch checked out is left as it is and blocks nothing. Before a pass that will spawn, and on every pass that finds the base behind
§0 Default branch whether it spawns or not, it merges §0 Default branch into the base there as a merge
commit (never a rebase, so running workers' bases stay valid) and pushes it, and the report says how
many commits came in. A park recorded as `base contains <§0 Default branch>` is checked after that
sync, so the pass that syncs the base requeues it (and lifts any not-now on it); one whose sync could
not run stays parked, its line under `clears-when:` saying why. A push refused as non-fast-forward (the merge
driver just merged into the base) is fetched, merged again and retried once. Pushing is config §3
`batch-base-push`: unset or `ask` is one approval per batch, so ask it at Stage 3 and run passes with
`AUTOPILOT_BASE_PUSH_APPROVED=1`. A sync that cannot run pushes nothing and goes under `WAITING ON
YOU` with its reason: a conflict (its files listed; resolve it in the base worktree and push with
`git push origin HEAD:refs/heads/<branch>`), a refused push, the row, or a base worktree that could
not be made (its path holds something else). In feature mode that pass spawns nothing; otherwise
spawning carries on from the base as it stands. Feature mode here is the decision `plan-batch`
recorded on the queue when it seeded (`feature`), not whatever `feature.json` names.

**A conflict goes to a conflict fix worker before it comes to you** (`base-fix.mjs`), where §3
`pr-conflict-unreviewed` is `yes`: the base is merged work no reviewer has read as one change. The
pass starts a task worker in the base worktree, under the id `base-<branch>` with its ticket file in
`$DESK_STATE/tickets/`, and it merges §0 Default branch in (a merge, never a rebase or a force push),
resolves the files git lists, verifies the merged tree and pushes the base under the same
`batch-base-push` grant. It takes a worker slot, within the batch's worker count and the machine
budget, and every batch counts it and its port as a running worker's. A session still live after its
worker parked or finished is stopped, as is one quiet for six passes (wedged); either ends the try.
One that reaches a usage limit is never stopped or failed for it: it is paused, and resumed in its
own session as the same try once the limit lifts (its reset passes or a probe call succeeds), as a
ticket's worker is. With more than one login, a session that ended at one login's limit benches that
login, and while another login can take new work the try (an epic PR review try too) carries on
there as a fresh session in the base worktree: the same try, starting its task again, its briefing
naming the uncommitted changes the worktree kept, and `base_fix` naming the login it moved to. With
no other login open it waits and resumes on its own login, as above. A preflight the limit refuses spends no try and holds the batch. The maintenance
window drains it, and stops it at its limit, as any worker, and it resumes as the same try once the
window is done; either resume waits while anything holds spawns. While it runs the pass leaves the base worktree
alone (no sync, no baseline, no base gate) and, in feature mode, still spawns nothing else. The next
pass that syncs the base clean says so and clears the tries, kept on the queue as `base_fix`. A base
gets two tries, one per head of the base, as a PR in conflict does: after two, or a try that left
the base where it was, or with the row not `yes` or no `batch-base-push` grant (a worker that could
not push would only park), the conflict goes under `WAITING ON YOU`, naming
its files and what the last try did (parked, finished, or no marker); resolve it in the base
worktree and push.

Where §4 Merged-tree check is set, the sync runs it after a clean merge and before the push. A failure
is handled as a conflict is: nothing is pushed and a base fix worker gets the check's output, briefed
to move the base's own changes (two migrations with one revision number, say) after the default
branch's. When its tries are spent, `WAITING ON YOU` quotes that output and says nothing was pushed.
A conflict fix worker runs the same check on its merged tree before it pushes, since the next sync
finds nothing to merge and never reaches it.

**Baseline checks (config §4 "Baseline checks" `on`).** Once the sync is done, and only when the
base has moved since the last record, the pass runs §4 Install, Typecheck and Lint in the base
worktree and records their errors in `<state>/baseline.json`. The report says
`baseline: recorded <base> at <sha>: typecheck <n> error(s) · lint <n> error(s)`, or names a check
whose output it could not read (workers run that one in full). Each worker's briefing then carries a
`Baseline checks` section telling it to check with `desk-env baseline typecheck|lint`, which fails
only on errors its branch adds. A base that cannot be recorded (a dirty base worktree, a failed
install) goes under `WAITING ON YOU` and leaves no baseline, so workers run the full checks. CI and
the pre-push hook do not read the baseline.
