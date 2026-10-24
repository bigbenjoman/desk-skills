# desk-cleanup step 2: Worktrees

Read at the start of step 2; step 3 runs this file's two-signal gate too. The config, ownership, the
order, the precondition, what is never touched, the confirmation and the red flags every step shares are in
`../SKILL.md`, already loaded.

## 2. Worktrees whose work has landed

Gated on config §3 **`worktree-remove`**: `yes` or `ask` → propose in the plan and wait (deliberate:
removal always shows the list first, even at `yes`); `no` or `TODO` → report candidates only.

**Start with `cleanup-scan.mjs worktrees`.** It fetches, refuses a shallow clone (exit 3), applies
the PR half of the ownership test, and checks process cwds by prefix. It prints one TSV row per
worktree (`verdict path branch ticket tip pr author reason untracked extras`):

| Verdict | Meaning | Next |
|---|---|---|
| `SAFE` | clean, no live process, the user's PR merged, and the tip is in the default branch, or is the head (or behind the head) of a PR that merged into the default branch | check the ticket column against the tracker half of the ownership test, then propose removal |
| `UNTRACKED` | as `SAFE`, but untracked files other than a resume file block `git worktree remove` | name every file in the plan (see below) |
| `CHECK` | the user's PR merged, but the local tip is not the PR's head (for example after a server-side `update-branch`), or the PR merged into a branch other than the default (a stacked PR) | run the method's check below; propose only if it confirms |
| `KEEP` | modified tracked files, a stash, a live process, a lock, an open or closed-unmerged PR, no PR, someone else's PR, no merge base | report it with the reason column |
| `PRUNE` | a registry entry whose directory is gone | `git worktree prune`, which costs nothing |
| `ORPHAN` | on disk in a worktrees directory, not registered to this repo | see Orphaned worktree directories |

A worktree with no PR is `KEEP` even when its tip is already in the default branch: with no PR there
is no merged signal and no author to apply the ownership test to.

The `extras` column lists **ignored** files that are not build output or installed dependencies:
`SPEC.md`, a plan directory, a resume file. `git status` does not show them, and `git worktree
remove` deletes them without a word, so name them in the plan too. What it leaves out, and so does
not back up, is what something puts back: `node_modules`, build and cache directories (`dist`,
`build`, `out`, `.next`, `.turbo`, `coverage`, `generated` and the like), `.DS_Store`, and `.env*`
files, which `copy-env.sh` restores from the main checkout and which should not pile up as copies of
secrets. A hand-made file under one of those names is lost on removal; if you know of one, copy it
out before approving.

After approval, pass exactly the approved paths to `cleanup-scan.mjs remove`. It re-reads each path
first, since state moves between the scan and the approval: still registered, not the main worktree,
no modified tracked files, no live process. It then copies resume files to `<backups dir>/resume/`
(overwriting), and every other extra and untracked file to `<backups dir>/worktree-extras/<run>/<worktree>/`,
listing each copy. It writes `restore.tsv` there (path, branch, tip), removes with no `--force`,
drops the watchman watch, and prints the `df` change. Untracked files other than a resume file make
a path `SKIP` unless `--allow-untracked` is given, which is for `UNTRACKED` rows whose files the user
approved: they are copied out, then deleted, never forced past. A `SKIP` or `FAIL` line is reported,
never retried.

**Two signals must agree before proposing removal:**

| Signal | Command | Safe value |
|---|---|---|
| PR merged | `gh pr list --head <branch> --state all --json state,mergedAt,author` | `MERGED`, authored by the §1 handle |
| Shares history with the default branch | `git merge-base <branch> origin/<default branch>` | exit 0 — exit 1 means no second signal, see below |
| No unique content | `git cherry origin/<default branch> <branch>` | depends on the merge method — see below |

**What "merged" looks like depends on §4 Merge method.** Confirm it live rather than trusting the
row: `gh api repos/<repo>/rules/branches/<default branch> --jq '.[] | select(.type=="pull_request") | .parameters.allowed_merge_methods'`
(a ruleset), else `gh api repos/<repo> --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge}'`.
The legacy `/branches/<default branch>/protection` endpoint 404s on a ruleset-guarded branch, and a
404 there means nothing.

| Merge method | Normal reading of a fully merged branch | Second signal in practice |
|---|---|---|
| `squash` | `MERGED` + `cherry N` (every commit reads unique) | the squash check below |
| `rebase` | `MERGED` + `cherry` lines all `-` (patch-equivalent), unless conflicts were resolved on rebase | `cherry` with no `+` lines; any `+` gets the squash-style file check |
| `merge` | `MERGED` + the branch tip an ancestor of the default branch | `git merge-base --is-ancestor <branch> origin/<default branch>` exits 0 |

**Under squash, `cherry 0` is the rare case, not the normal one.** A squash collapses N commits into
one new commit, so none of the N patch-ids survive and `cherry` reports every one as unique on a
branch that is **fully merged**. So **`MERGED` + `cherry N` is the expected reading**, and the squash
confirmation is the second signal:

```bash
gh pr view <n> --json mergeCommit -q .mergeCommit.oid   # then:
git log -1 --format='%h parents=%p %s' <sha>            # one parent + "(#n)" subject = squash
git show --stat --format='' <sha>                       # the files it actually touched
git diff --stat origin/<default branch> <branch> -- <those files>   # default branch ahead or equal = nothing missing
```

Scope the diff to the merge commit's own file list. A whole-tree diff against a branch a day or two
stale is dominated by everything else that has landed since. Branches reading `MERGED` + `cherry > 0`
have turned out to be squashes with the default branch holding strictly more of each branch's work,
and safe to remove.

**No merge base (after ruling out a shallow clone) means the PR state is the only signal.** That is
not two signals, so **do not propose removal** — report the branch and say why the second signal is
unavailable.

Under squash and rebase, `merge-base --is-ancestor` says "unmerged" for every merged branch, and
comparing local SHAs against the PR's says "unpushed work"; both are wrong for their own reasons.

If the signals disagree *after* the method's check, **stop and report it**. Disagreement is
interesting, not a rounding error: a PR closed unmerged *and* `git cherry` showing unique patches
is both signals correctly saying don't touch.

Then, before removing:

- **Record the branch tip** — `git rev-parse <branch>` — in the report. Removal destroys the
  per-worktree HEAD reflog at `.git/worktrees/<name>/logs/HEAD`, the only route back from a local
  amend or reset done there. The SHA replaces it.
- **Check for live processes by prefix**, not exact match (snippet in the reference). In a monorepo
  a dev server's cwd is typically a package subdirectory of the worktree. Check cwds, open files, and
  the owners of **the dev-server ports** (§3b Preferred dev-server port, and the range above it that
  autopilot workers take) **plus every port §4 Local services and §4 Dev server name** — component
  explorers, job runners and the like sit on their own ports. **Why:** one worktree can hold a dev
  server on one port *and* a component explorer on another, and only the cwd check sees the second.
  Record each process's RSS — it feeds step 5.
- **Check whether a Claude session was launched inside it** — does a project dir for that path exist
  under `~/.claude/projects/` (the path with `/` turned into `-`)? The dir is keyed by where `claude`
  was *launched*, not by the cwd of its Bash calls, so a session that merely `cd`s into a worktree is
  unaffected. Even when one was launched inside, removal loses nothing resumable:
  `claude -r <session-id>` finds a session from any cwd after its worktree is gone, and `~/.claude/projects` is never touched. Put the restore line in the report anyway —
  `git worktree add <path> <branch>` — for anyone who wants the tree back.
- **Never pass `--force`.** `git worktree remove` refuses on dirty tracked or untracked files, and
  that refusal is the strongest guard here. If git objects, report and stop.
- **Untracked files block removal, so deal with them explicitly — never with `--force`.** List every
  untracked file by name in the plan, then:

  | File | What happens |
  |---|---|
  | `.claude/desk-ticket-<TICKET>.json` | **copied** to `<backups dir>/resume/` (config §2), never deleted — overwriting whatever is there |
  | anything else (`devserver.log`, scratch files) | named in the plan, copied to `<backups dir>/worktree-extras/`, deleted only on approval |
  | an ignored file that is not build output (`SPEC.md`, the scan's `extras`) | named in the plan, copied to `<backups dir>/worktree-extras/` before the remove deletes it |

  Then a plain `git worktree remove` succeeds with no flag.

  **The copy overwrites unconditionally — the live file always wins.** A backup under that name
  usually exists and is usually stale: a live file can hold a dev-server port, a ticket transition, a
  PR and three `comments_posted` markers where the backup has one. Those markers
  are what `desk-jira` and `desk-ticket` read for idempotency, so a stale copy can cause a
  comment already on the ticket to be re-posted.

  Do not rely on git refusing as the safety net. Adding these files to `.git/info/exclude` makes them
  *ignored*, and `git worktree remove` deletes ignored files without complaint.

Removal deletes the whole directory including installed dependencies and build output, and the
branch survives, so it is re-addable.

### Orphaned worktree directories

**Diff the worktree parent directories against `git worktree list` every run.** A directory whose
registry entry was pruned is still on disk at full size and invisible to every check above — a
2.5 GB orphan has been the second-largest worktree on the box. List config §2's worktrees
directory and `<repo root>/.claude/worktrees/`; anything on disk and not registered is an orphan.

Removing one needs `rm -rf`, which has no dirty-tree guard, so rebuild the guard from evidence
(stranded diffs, untracked files checked against `origin/<default branch>`, resume file copied out)
and put it in the plan like any other removal. Commands in the reference.
