---
name: desk-cleanup
description: >-
  Use when tidying up after finishing a batch of tickets in the current repo — stale worktrees left
  over from merged PRs, local branches that have no worktree, tracker statuses that have drifted
  from GitHub, open PRs that have fallen behind the default branch, a leaked dev server or a bloated
  watchman eating memory, or a general "clean up my workspace" / "what can I get rid of".
---

# desk-cleanup

## Before anything: this repo's config

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no  (exit 3 outside a repo)
```

Then **Read the `CONFIG` file**. `EXISTS=no` means stop: say which slug was looked up and offer
`/desk-setup`. Never borrow another repo's config.

What it answers here: §0 for the GitHub repo and its default branch, §1 for the GitHub handle and
Jira account the ownership test depends on, §2 for the repo root, worktrees, handoff and backups
directories, §3 for which of the write steps below are permitted at all, §3b for the dev-server
port and fan-out, §4 for the tracker and its states, merge method, branch protection, toolchain,
local database and services, §5 for branch names. **If §1 GitHub handle is still `TODO`, stop —
and so if §1 Jira display name is `TODO` while §4 Tracker is `jira`.** Without them there is no
ownership test, and the whole safety model of this skill is the ownership test.

Below, "the default branch" is §0 Default branch, `<repo>` is §0 GitHub repo, and `<TICKET>` is a
match for §4 Ticket key pattern (with §4 Tracker `none`, the branch's slug). A §4 row set to `none`
means the repo has no such thing; each step says what that skips.

## Overview

Removes finished state and reports the rest. Almost everything here is reversible or read-only;
the parts that aren't are gated behind two independent signals agreeing.

**Core principle: two signals, then ask. Never one signal, never silently.**

Portable shell for every check below (macOS and Linux/WSL) is in
[`references/portable-checks.md`](references/portable-checks.md). Use those forms — `/proc`,
`ss`, `pstree -p`, `ps --sort` and `du --one-file-system` do not exist on macOS.

Steps 1, 2 and 5 are scripted in `bin/cleanup-scan.mjs`, so they read the same every run. Run it
rather than re-deriving each check by hand across dozens of worktrees. `worktrees`, `memory` and
`key-filter` only read; `remove` acts only on the paths it is given:

| Command (`node ~/.agents/skills/desk-cleanup/bin/cleanup-scan.mjs …`) | Does |
|---|---|
| `key-filter <TICKET>` | keeps the whole-key matches from `gh pr list --json` on stdin (step 1) |
| `worktrees --repo <root> --author <§1 GitHub handle> --default <default branch> --worktrees-dir <§2 Worktrees directory> --key-pattern '<§4 Ticket key pattern>'` | classifies every worktree of one repo (step 2) |
| `remove --repo <root> --backups <§2 Backups directory> [--allow-untracked] <path>…` | removes approved worktrees only, backing up first (step 2) |
| `memory --repo <root> --worktrees-dir <§2 Worktrees directory> --ports <dev-server ports>` | prices RAM, dev servers, sessions, test runs, watchman, Docker and caches (steps 5 and 6) |

The rules below are what the script implements, with two exceptions it leaves to you: it checks
live processes by **cwd** only, so open files and the owners of the dev-server ports (step 2,
"Check for live processes") are still checked by hand before a `SAFE` row is proposed, and it does
not run the merge method's confirmation for a `CHECK` row. Read the rules before overriding a
verdict.

## Ownership — the hard boundary

**Only ever acts on tickets assigned to the config §1 Jira account id and PRs authored by the config
§1 GitHub handle.** Both, every time. With §4 Tracker `none` there are no tickets: the PR author,
and a worktree whose branch is one of those PRs' heads, are the whole test.

- Someone else's ticket: never touched, however stale it looks.
- The user's ticket, someone else's PR: never touched — that PR is theirs to speak for.
- Someone else's ticket, the user's PR: never touched.

A worktree or branch for a ticket that isn't the user's is **reported, never acted on**. This is
not a default to override; there is no flag for it.

## Order, and why it matters

1. Tracker sweep · 2. Worktrees · 3. Branches (report) · 4. Open PRs · 5. Memory · 6. Report-only

The sweep runs **first** because everything below keys off ticket state, and a PR can be merged
while the tracker still says §4 Review state — that drift is exactly what the sweep fixes.

Only two steps change anything on disk: the sweep (the tracker) and worktrees. Memory (5) changes no
disk state but can stop or restart a live process, so it is approval-gated the same way. Everything
else reports.

## Every step runs once per repo

**Every command below is repo-scoped.** `git worktree list`, `git cherry` and `git rev-parse`
answer only for the repo you run them in. The config is per repo too, so one run covers **this**
repo: §2 Primary repo root and every worktree registered to it. Say which root you are covering.
Other repos the user works in have their own config; run desk-cleanup from inside each. A repo you
did not cover is a line in the report, not an omission.

**A merged-away repo is still a repo.** When a codebase has been folded into another (a standalone
app that now lives as a directory of this monorepo), an old standalone checkout still holds
worktrees, local branches and `.claude/desk-ticket-<TICKET>.json` files of its own. Treat it as
wind-down: run desk-cleanup from inside that checkout (it resolves its own config, or needs
`/desk-setup` there), and check its branches against **its** default branch, since they merged
through the old repo.

## Precondition — `origin/<default branch>` must be current and not shallow

Every content check below compares against `origin/<default branch>`. **A stale ref makes merged
work look unmerged**, which turns the whole run into a no-op — or worse, makes a disagreement
between the two signals look like a real finding when it is just a stale ref.

Verify before anything else:

```bash
gh api repos/<repo>/commits/<default branch> --jq .sha
git -C <repo root> rev-parse origin/<default branch>
git -C <repo root> rev-parse --is-shallow-repository   # must print false
```

If the SHAs differ, `git -C <repo root> fetch origin` and check again; still different, stop and say
so.

**If the clone is shallow, fix that before reading any history signal.** A shallow clone whose
`.git/shallow` lists branch tips makes `git merge-base` exit 1, makes `git cherry` report
1,000-2,600 "unique" commits, and makes `git merge origin/<default branch>` fail with "refusing to
merge unrelated histories". **Why:** that reads as "the default branch's history is orphaned" when
it is not; `git fetch origin --unshallow` restores the full ancestry and every merge-base. The
`.git` directory is shared, so one unshallow fixes every worktree.

## Steps

Each step's rules are in its own file under `references/`, beside this one. **At the start of each
step, read that step's file.** Steps run in order, so a later step leans on a file already read:
step 3 runs step 2's two-signal gate. This file holds what every step needs: the config,
ownership, the order, the precondition, what is never touched, the confirmation, and the red flags
and mistakes. "The reference" in a step file is `references/portable-checks.md`, read for the
commands that step names.

| # | Step | Read at its start |
|---|---|---|
| 1 | Tracker sweep | `references/step-1-tracker-sweep.md` |
| 2 | Worktrees whose work has landed, and orphaned worktree directories | `references/step-2-worktrees.md` |
| 3 | Local branches with no worktree (report) | `references/step-3-branches.md` |
| 4 | Open PRs, and the ready-to-merge report | `references/step-4-open-prs.md` |
| 5 | Memory | `references/step-5-memory.md` |
| 6 | Report only | `references/step-6-report-only.md` |

**A step file you cannot read stops the run.** If the file for the step you are starting is missing
or empty, stop and name it by its full path; never work the step from memory or from an earlier copy
of this skill. `/desk-update` reinstalls it.

## Never touched

| Thing | Why |
|---|---|
| `~/.claude/projects` | session transcripts — `claude -r` resumes from them, and they outlive every worktree |
| `<backups dir>` (config §2) | rollback artefacts for staging writes and resume-file copies |
| the database images §4 Local database uses (e.g. `postgres:<version>`) | the dump tooling `desk-dev` needs; `docker system df` calls them reclaimable and they are not |
| Docker containers | small, and needed the moment work starts |
| Swap itself | report only (see 5) |
| A dev server for a ticket still in flight | see §5 — in-flight beats PR state; `pkill node` is never the way |
| §4 Local database's development database, and per-ticket copies of it | report the copies only; never dropped here |
| Any worktree with a live process, a lock, or modified tracked files | in use |
| Anything belonging to anyone else | see Ownership |

## The confirmation

One table, everything proposed, then wait:

```
CLEANUP PLAN — awaiting approval
repo       : <repo> at <repo root> (origin/<default branch> <sha>, not shallow)
sweep      : <TICKET> · PR #<n> MERGED · no open PR on key   [<Done state> + comment | posted at jira-close-own-merged yes]  (or: skipped — §4 Tracker none)
worktrees  : <path> · <branch> · PR #<n> MERGED · <squash|rebase|merge> confirmed · tip <sha>   [remove]
             untracked: <files> · ignored extras: <SPEC.md, …> · copied to <backups dir> first
             restore `git worktree add <path> <branch>`
orphans    : <dir> · no registry entry · diff clean · untracked superseded  [rm -rf]
branches   : <branch> · PR #<n> MERGED · <method> confirmed · tip <sha>      [report only]
update     : PR #<n> · behind <n> · <state>          [update-branch | DIRTY: to clearance]
ready      : PR #<n> · required checks green (<names>) · no CHANGES_REQUESTED · CLEAN     [not merged here]
memory     : <proc> <rss> · port <n> · <TICKET> · in-flight? <signal> · session <pid>  [stop | restart on <port>]
report only: <ports+RSS, swap, sessions, caches, handoff folders — no action>
skipped    : <thing> · <the signal, config §3 row, or §4 none that said no>
```

The `skipped` line matters as much as the rest — it is how a wrong guard becomes visible.

## Red flags — stop

- About to pass `--force` to anything
- Reaching for `git branch -D` because `-d` refused — report the branch instead (see 3)
- Acting on a ticket or PR that isn't the user's
- Acting on a step whose config §3 row is `no` or `TODO`
- Running the tracker sweep when §4 Tracker is `none`, or inventing a Done state the row does not name
- One signal says safe and the other hasn't been checked
- Quoting a cherry count or a missing merge-base without checking for a shallow clone
- `rm -rf` on an orphan before its diff and untracked files were read
- Rebasing locally, force-pushing, or resolving a conflict here
- Reaching for `pkill node` — stop the specific pids, whatever the verdict
- Stopping a server for a ticket still in flight: a dirty tree, an unpushed commit, a live session in
  the worktree, or a resume file not at `stage: complete`
- Stopping or restarting any server without approval — an open PR does not protect it, but silence
  still is not agreement
- Proposing `swapoff` as a memory win
- Merging a PR — never this skill's job

## Common mistakes

| Mistake | Fix |
|---|---|
| Using `merge-base --is-ancestor` to decide "merged" under squash or rebase | Those rewrite SHAs; the PR state from `gh` plus the method's check is the signal |
| Reporting `MERGED` + `cherry N` as a finding on a squash-merge repo | The *expected* reading under squash. Confirm via the merge commit |
| Quoting a cherry count of 1,000+ as unique work | Check `git rev-parse --is-shallow-repository` first; unshallow, then re-read |
| Trusting `allow_rebase_merge` or a 404 from the branch-protection endpoint | A ruleset is the authority where one exists — read `rules/branches/<default branch>` |
| Trusting §4 Merge method or Required checks without looking | The config records what setup saw; the platform says what is true now |
| Diffing the whole tree to test a squash | Scope it to the merge commit's own file list |
| Trusting `git worktree list` to find every worktree | Diff the parent directories against it; orphans are invisible to git |
| Exact-match cwd check for live processes | Dev servers sit in a subdirectory; match by prefix |
| Removing a worktree, then wanting its reflog | Record the tip SHA in the report first |
| Rebasing every PR that's behind | Behind blocks only where §4 Branch protection requires up-to-date; otherwise only where DIRTY or CI-stale |
| Treating `APPROVED` as current, or absent reviews as complete | Check whether stale approvals are dismissed; paginate reviews and distrust exactly 30 rows |
| Rebasing a PR whose stacked parent squash-merged | It conflicts on identical content and may carry ignored files — hand to `desk-clearance` |
| Keeping a finished worktree because a log file blocks removal | List the untracked files, copy out the resume file, delete the rest on approval |
| Proposing to delete landed local branches | Report them and stop — `-d` refusing is not a reason to escalate to `-D` |
| Skipping the resume-file copy because that name already exists | It is usually stale; overwrite, live wins |
| Scanning only the dev-server port range for live processes | §4 Local services and other dev tools sit on their own ports |
| Calling a running Jest suite a leak, or trusting `pgrep -f` to say one is running | Match the `node` executable, re-measure once it clears |
| Quoting a per-worktree `du` size as reclaimable | Measure the containing directory once; ~1 GB marginal, not the per-tree figure |
| Reporting ports without RSS | `3007 · next-server` hid ~6 GB; report the cost |
| Treating an open PR as a reason to keep a server | Judge by whether the ticket is in flight |
| Chasing a process for full swap | On a tmpfs `/tmp`, compare summed `VmSwap` to swap used first |
| Assuming worktree removal costs a session its resumability | `claude -r <id>` resumes from any cwd; transcripts are never deleted |
| Running the tracker sweep on merged PRs alone | Any open PR on the key vetoes Done |
| Treating a clean `git status` as nothing to lose | Ignored files (`SPEC.md`, a plan directory) do not show, and removal deletes them; read the scan's `extras` column |
| Hunting dev servers for a memory hog and finding none | Check watchman: it belongs to no worktree and no session |
