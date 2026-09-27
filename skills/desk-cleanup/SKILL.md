---
name: desk-cleanup
description: >-
  Use when tidying up after finishing a batch of tickets in the current repo — stale worktrees left
  over from merged PRs, local branches that have no worktree, tracker statuses that have drifted
  from GitHub, open PRs that have fallen behind the default branch, a leaked dev server eating
  memory, or a general "clean up my workspace" / "what can I get rid of".
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

## 1. Tracker sweep

**§4 Tracker `none`: skip this step**, and write `sweep: skipped — §4 Tracker none` in the plan.

Defined here so this skill stands alone. `desk-jira` owns the CLI, comment format and idempotency
markers — use it for the writes, not for the decision.

1. List issues assigned to the config §1 Jira account id in §4 Review state (with Review state
   `none`, in §4 In-progress state — the state a ticket rests in while its PR is open).
2. For each, search the key across **every** PR state, fetching title and head branch so the match
   can be checked:
   `gh pr list --repo <repo> --search "<TICKET>" --state all --json number,title,state,author,mergedAt,headRefName,baseRefName`.
3. **Keep only the PRs that carry the key as a whole id.** GitHub's search is fuzzy: it matches
   words, ignores case and punctuation, and returns `ABC-12` for a search on `ABC-123` or
   `ABC-1234`, and `BUG-119-5` for `BUG-119`. A PR counts only when its title or its head branch
   contains `<TICKET>` with no letter, digit or `-<digit>` continuing it on either side:

   ```bash
   gh pr list --repo <repo> --search "<TICKET>" --state all \
     --json number,title,state,author,mergedAt,headRefName,baseRefName \
     | jq --arg k "<TICKET>" '[.[] | select(
         ((.title + " " + .headRefName) | ascii_upcase)
         | test("(^|[^A-Z0-9])" + ($k | ascii_upcase) + "(?![0-9]|-[0-9])"))]'
   ```

   Match case-insensitively, since branches are often lower-case, but never loosen the bounds.
   Every Done proposal below is made from this filtered list only; a PR the search returned and the
   filter dropped is ignored, not counted as "a PR on the key".
4. Classify:

| Evidence | Proposal |
|---|---|
| a merged PR authored by the §1 handle, **and no PR on that key still open** | §4 Done state (§3 `jira-close-own-merged`), with a one-line comment naming the PR |
| any PR on the key still open | leave it — the open PR vetoes the transition |
| no PR found, or closed unmerged only | leave it; list as needing a decision |
| the merged PR is someone else's | leave it; report, propose nothing |

**A merged PR is not proof the ticket is finished.** A partial first fix often merges to unblock
something while a second PR carries the real work. **Why:** a merged-only match proposes closing a
ticket whose actual fix is still in review.

For a long list, fan out one read-only agent per ticket (within config §3b "Subagents that may run
without asking"). **No agent transitions or comments.** Collect the results and show the proposed
transitions as one list. The Done rows then follow config §3 `jira-close-own-merged`: `yes` applies
them with that list as the record, `ask` waits for agreement, `no` or `TODO` reports the drift and
changes nothing. The comment posts under §3 `jira-comment`, following §5 Ticket comment. Any other
close is `jira-close`, a decision, and is never proposed from a sweep.

## 2. Worktrees whose work has landed

Gated on config §3 **`worktree-remove`**: `yes` or `ask` → propose in the plan and wait (deliberate:
removal always shows the list first, even at `yes`); `no` or `TODO` → report candidates only.

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
  | anything else (`devserver.log`, scratch files) | named in the plan, deleted only on approval |

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

## 4. Open PRs — the user's only

**Update a branch only where it is actually needed.** Read §4 Branch protection, and verify it live
with the calls in desk-clearance's `references/repo-facts.md`: where the default branch does not
require branches to be up to date, being behind never blocks a merge.

Update when the PR is **behind the default branch** *and* either conflicting (`mergeStateStatus:
DIRTY`), or its CI last ran against a default branch that has since changed files it touches, or the
branch must be up to date and the PR is otherwise ready. Otherwise report and leave alone.

When updating, **never rebase locally and force-push.** Use server-side `gh pr update-branch
--rebase <n>` under §3 `pr-update-branch` (a branch touching `.github/workflows/**` needs the
`workflow` token scope). A `DIRTY` PR goes to `desk-clearance`, whose `pr-conflict-*` rows apply.
- **Run §4 Typecheck after any update**, even a clean one — a hunk that auto-merges can still
  reference a symbol the other side removed. §4 Typecheck `none`: say the update is unverified.
- **A PR stacked on a branch that has since squash-merged is not a rebase job.** It conflicts with
  the default branch even where content is identical, and it may still track the parent's gitignored
  files (`git ls-files -ci --exclude-standard`), which only surface once the base is retargeted.
  Report it and hand it to `desk-clearance`.

### Ready-to-merge report

For each open PR of the user's: required check state · standing `CHANGES_REQUESTED`? · behind by N ·
`mergeStateStatus` · ready.

**Report readiness; never merge** — that is `desk-clearance`'s job, under config §3. Read the bar
from the platform, not memory or the config row:

- The required contexts are whatever the ruleset's `required_status_checks` and the branch's
  classic protection list (`gh api repos/<repo>/rules/branches/<default branch>` and
  `gh api repos/<repo>/branches/<default branch> --jq .protection`). §4 Required checks records
  them; if it disagrees, say so and suggest `/desk-setup`. Nothing required and the row `none`:
  every check on the PR must be green, and a PR with no checks is not green.
- Required approvals and `dismiss_stale_reviews_on_push` come from the same places (§4 Branch
  protection). Where no approval is required, an `APPROVED` review is not needed; where stale
  approvals are not dismissed, it is not evidence it covers the current head. Whether this user
  merges without one is config §3 `pr-merge-green`.
- A standing `CHANGES_REQUESTED` blocks where the platform enforces it (`mergeStateStatus:
  BLOCKED`), and is reported as not ready everywhere, protected or not.
- Fetch reviews with `gh api --paginate`. Without it `gh api` returns 30 rows silently, which
  can hide a PR's 35th review — the approval — behind a stale `CHANGES_REQUESTED`. Treat
  any result of exactly 30 as truncated.

## 5. Memory — usually the largest reclaimable thing on the box

The disk win is worktrees. The RAM win is almost always **one leaked dev server**, and the report
has to price it or a full run ends with the machine still several GB down. Measure with the
reference's memory table, process list and `docker stats`.

Baselines, measured on one machine running a large Next.js monorepo — re-measure for this repo's
§4 Dev server and test runners before treating any figure as a threshold:

| Process | Normal | Leak signal |
|---|---|---|
| a `next dev` server | ~1.5 GB | **>2.5 GB**, or sustained CPU with nobody driving it |
| a component explorer dev server | ~700 MB | >1.5 GB |
| one `claude` session | 350-450 MB | — |
| its MCP servers | ~300 MB per session | — |
| Docker (§4 Local database and §4 Local services containers) | ~140 MB total for a database, a search index and a mail catcher | never the problem |
| a Jest full suite | one worker per core, ~6.5 GB, gone in **~30 s** | transient — never a leak |
| a Vitest full suite | ~4.5 GB peak, gone in **~85 s** | transient |

**A test suite in flight looks exactly like a leak — measure twice before naming one.** 11 GiB used
can be the Jest suite, exiting 40 seconds later. Check for a run in flight with the
reference's `node`-executable match, **not** a bare `pgrep -f` count — even the bracketed
`pgrep -f '[j]est-worker'` self-matches inside Claude Code's `bash -c` wrapper — and re-read memory
after it clears. Report the delta, not the RSS sum.

**A hung Vitest is the inverse tell, and the one genuinely worth stopping.** It collapses to a
*single* node process pinned at 100% CPU whose heap climbs ~6 MB/s without bound. Many workers,
large, brief → a suite doing its job. One process, 100% CPU, monotonic growth → the hang. Confirm
nobody is mid-measurement, then propose stopping it.

A dev server at **~6 GB after an hour** of HMR is a leak, not a workload. And each concurrent session
costs ~300 MB in duplicate MCP servers before it does any work, so "close a session" is occasionally
the honest answer.

**Trace the owner before proposing anything** — walk the parent chain (reference) from the server up
to the owning `claude` pid.

**The test is whether the ticket is still being worked on — not whether its PR is open.** An open PR
is the normal resting state of finished work, so treating it as protection means no server is ever
reclaimable. A server comes back with one §4 Dev server command; a session mid-flight does not.

| Signal in the worktree | Reading |
|---|---|
| modified tracked files, or a stash | **in flight** — leave it |
| a live `claude` process with its cwd inside the worktree (autopilot workers included) | **in flight** — leave it |
| resume-file `stage` not `complete`, or a `pendingGate` set | **in flight** — leave it |
| commits not pushed to `origin/<branch>` | **in flight** — leave it |
| clean tree, pushed, resume `stage: complete`, PR open | **finished** — stopping is fine |
| ticket in §4 Done state, or PR merged/closed | **finished** — stopping is fine |

Any "in flight" row wins over any "finished" row. When nothing distinguishes them, ask.

Then:

- **Stop by pid, never `pkill node`.** `pkill` is indiscriminate and takes a session's own tooling
  with it. `SIGTERM` the specific pids; escalate to `-9` only if one survives.
- **Where the work is in flight and the server has genuinely leaked, restart on the recorded port**
  (`dev_server_port` in the resume file). If the port can't be reused, update it there and say so.
- **It goes in the plan awaiting approval** in either case (config §3 `server-stop`; `no` means report
  it only). A server inside a worktree being removed
  dies with it, and approving the removal covers that.
- **Say what is lost** — a warm server, back with §4 Dev server in that worktree. Once.

**Swap is a signal, not a target.** Heavy swap alongside plenty of free RAM means something leaked
earlier, or — on Linux/WSL with a tmpfs `/tmp` — regenerable caches (test-runner and Node compile
caches) whose swapped pages belong to no process. The reference shows how to tell the two apart;
the caches may go in the plan as `[delete]`. Never propose `swapoff`: it needs root and forces cold
pages back into RAM for nothing.

## 6. Report only — never acted on

Ports in use, what is serving them **and its RSS** (a bare `3007 · next-server` line reads as "busy,
leave alone" while hiding 6 GB) · live session count and their MCP overhead · swap · local branches
with no worktree (see 3) · caches · stale `<handoff dir>/<TICKET>` folders (config §2) for merged
tickets · anything odd, like two worktree naming conventions coexisting.

**Never quote a per-worktree `du` figure.** Package managers that link `node_modules` from a global
store (§4 Package manager; the reference says which do) make `du` over one worktree overcharge it and
`du` over several undercharge all but the first. Measure the containing directory once, expect ~1 GB
marginal per worktree rather than the full per-tree figure, and on macOS quote the `df` change
instead. Detail and cache sizes in the reference — caches are only worth touching when `df` shows
under ~15% free.

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
             untracked: <files> · resume copied to <backups dir>/resume/
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
