# desk-autopilot: what workers may run

Part of desk-autopilot, read when a worker parks on a step its settings refused, and before changing
what a worker may run. It binds exactly as the core `SKILL.md` does. Where it says "above" or
"below" of something this file does not hold, or cites a section in *italics* it does not hold, that
is in the core or in the file the core's reference table names (the §3 table "below" is the core's,
under *Read the config first*).

**Workers cannot ask, so §3 decides up front what they may do.** `worker-settings.mjs` (run by
`spawn-worker.sh`) turns every worker row below that is not `yes` into deny rules (by bare name, by
the absolute path `command -v` resolves, and in `git -C <dir> …` form) and tells the worker which
keys, as `CONFIG_DENIED: <key> (<setting>)`, so it parks with the exact payload instead of attempting.
Enforcement is the rule, not the wording: see the contract §2.

**A worker's settings are an allow-list** (`worker-settings.mjs`, written to
`$DESK_STATE/workers/<TICKET>.settings.json`; a triage pass gets
`$DESK_STATE/workers/<TICKET>.triage.settings.json`, read-only). Both live outside the repo, and
`pass.mjs` creates worker worktrees with `setup-worktree.sh --for-worker`, so the worker gets **no
copy of your `.claude/settings.local.json`** and none of your own allows reach it. Whatever §3 says,
a worker cannot:

- push anything but the exact commands `git push [-u|--set-upstream] origin <its branch>` (and
  `git push --force-with-lease origin <its branch>` where §3 `git-force-with-lease` is `yes`); bare
  `git push` is refused;
- rebase onto the base a branch already on origin, unless it may force-push it afterwards: it takes
  `git merge origin/<base>` instead;
- run `git config`, `git -c …`, `git -C` on anything but its own worktree (and there only the
  reads), git aliases or `git stash`;
- run `gh api` in any form, `gh alias`, `gh pr merge`, `gh pr ready`, or approve or request changes;
  so it cannot resolve review threads (it replies with `gh pr comment` under §3 `pr-reply`) and
  opens PRs only with a command beginning `gh pr create --draft` or
  `gh pr create --repo <§0 GitHub repo> --draft`;
- run `gh workflow` beyond the exact §4 Worker workflows dispatches on its own branch where §3
  `worker-workflow-dispatch` is `yes`: no other workflow, input or ref, none in a dry run, and
  never `gh workflow enable` or `disable`;
- run the package manager beyond `install` with no arguments and the configured rows (no `add`,
  no `exec`/`dlx`/`x`, no `npx`/`bunx`/`uvx`), or the §4 Command prefix on its own;
- run `sed`, `awk`, `cp`, `mv`, `sort`, `uniq`, `xargs` or `tee`; `codex` other than
  `codex exec --sandbox read-only …` / `codex --version`; `psql` other than
  `docker exec <container> psql [-U postgres] -d <its database>`;
- run migrations or seeds (§4 Database migrate, Seed) unless it was given its own per-ticket database;
- write outside its worktree, except `$DESK_STATE/parks/<TICKET>.json`,
  `$DESK_STATE/handoffs/<TICKET>.json` and `$DESK_STATE/images/<TICKET>/**`. It cannot write or delete `answers/`: you clear a ticket's
  answer file once it has been read.

It may also write its resume file, `$DESK_STATE/resume/<TICKET>.json`: the harness write-protects its
worktree's `.claude/`, where `desk-ticket` keeps one interactively.

**An approved force-push is a one-off grant.** Where §3 `git-force-with-lease` is not `yes` and a
worker parks asking to force-push its branch, an answer that approves it (one opening with a yes and
saying no no, not or wait, or `answer.mjs <TICKET> --approve "…"`) is recorded as the ticket's
`grant`: its branch and the SHA origin held, from the park's `lease` input or the worktree's
`origin/<branch>`. The requeued worker's settings then allow exactly
`git push --force-with-lease=<branch>:<sha> origin <branch>`, and its prompt names it. Once origin's
branch has moved off that SHA the grant is spent: git refuses the same push, and the next worker's
settings leave it out. An answer that approves nothing records no grant.

**No grant unlocks the fixed refusals.** A write under the worktree's `.claude/`, a write allowed only
by a `Write(...)` rule, anything in your own settings, and `gh api` are refused by the harness or the
launcher whatever §3 or a worker's settings say (the Stage 3 worker contract lists them), and no
worker settings ever allow `aws`, `ssm`, `curl` or `wget`. A park on
one is answered by opening an interactive `/desk-ticket` session, never by adding an allow rule and
requeueing: the worker would only park again. desk-needs-you offers such a park as a session item,
and the pass never requeues it. Triage puts a change that writes under `.claude/` in
lane C for the same reason.

It may run `desk-env …` and the §4 toolchain rows, a directory item as
`~/.claude/desk/bin/with-lock.sh <test|tsc|browser|nolock> --cwd <dir> -- <cmd>`. **Database
variables**: in each worker's worktree every §4 Database URL variable is repointed at its own
per-ticket database or, when none was provisioned (§4 Local database `none`, or §3 `db-per-ticket`
not `yes`), **blanked**, so a worker never reaches a shared, staging or production database. A
worktree whose setup failed at any step is removed and the ticket parked with the setup log's
reason; a worker never runs in a half-made worktree.

**These rules catch mistakes, not every deliberate workaround.** Git accepts abbreviated flags that
no pattern can list, and the configured toolchain commands run code. The contract is what keeps a worker in
bounds, so never widen a worker's grants on the strength of the deny list.
