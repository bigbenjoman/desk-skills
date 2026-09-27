# Hazards, conventions, and running as a loop

Below, "the default branch" is config §0 Default branch, and §-references are to this repo's config
(`desk-env where`, then Read it).

## What keeps biting

**Multiple review rounds are normal.** A batch of cleared PRs routinely comes back overnight with
3-5 fresh comments each. Report a PR as *handed back*, never as *done*, unless it merged.

**A PR can go CONFLICTING without any update**, when the default branch moves under it. An observed
state, not an update failure. Whoever owns the open threads fixes it.

**The default branch moves from other people too.** Re-run the order check after *any* movement.

**PR descriptions go stale after review fixes.** If a fix materially changes behaviour or UI, update
the description via **desk-pr** — a before/after pair that no longer matches is worse than none.

**Correct the record with the reviewer.** If you told them the PR does something and it does not,
say so on the thread. Leaving it uncorrected is worse than the original mistake.

**Never act on a working tree you do not own.** Check `git status` and the branch first. **A hook
firing about changes you did not make is an ownership question first, not an instruction.**

**`git stash` is shared across every worktree.** Avoid it entirely when another session is active.

**A generated file must come from its generator**, never from hand-resolving conflict markers. A
generator that reads from a running dev server hits whoever holds the port — confirm the server is
running *this* tree.

## Merges that look clean and are not

"No conflict markers" only means the two diffs did not touch the same lines. After merging the
default branch into any branch, before pushing:

- **§4 Typecheck (with §4 Command prefix), always.** A marker-free merge routinely does not compile:
  one auto-took the default branch's destructure and dropped five params the branch still used; one
  kept importing a helper the default branch had deleted; one imported a component it had renamed.
  Zero markers on all three. Where §4 Typecheck is `none`, say the merge is unverified rather than
  calling it clean.
- **`git diff --stat <base-parent> HEAD` and `git diff --stat <base-parent>...HEAD`** — identical
  output proves the merge dropped nothing of the default branch's and added nothing beyond the branch.
- **Message-catalog keys are runtime, not types.** An i18n JSON file can auto-merge and silently drop
  a block the branch removed as dead while the default branch added a live use of it. For any merge
  touching a message catalog, audit every removed key against the source that reads it.
- **A branch that renamed a directory strands files the default branch *added*.** Git carries an
  edited file through a rename; an added one lands at the old path, no conflict. On a branch that
  moved a package's `prisma/` directory into a new package, merging the default branch brought a
  schema edit through and left its new migration at the old path. Typecheck, lint and unit tests were
  green — only a CI migration-drift check caught it. Check:

  ```bash
  git ls-files <old-path>/                                   # anything left behind?
  git diff -M -C --name-status origin/<default branch> HEAD -- <old-path> <new-path>   # every file R, none A at old
  ```

## Stacked PRs

**`DIRTY` is computed against the base branch**, which on a stacked PR is not the default branch.
Read `baseRefName` first; `merge-tree` against `origin/<default branch>` showing 0 conflicts and
GitHub saying dirty are answering different questions. When a child and its base each merge the
default branch separately, their two resolutions then conflict with each other. Merge the base branch
into the child afterwards; for files the base's own ticket owns, prefer the base's resolution.

**`mergeable` goes stale on a stacked PR**, and so does your ref. If GitHub says conflicts and local
git says clean, **`git fetch --prune` and re-read the parent tip before calling it a GitHub bug** — a
parent rebased between an `ls-remote` and a fetch leaves GitHub right and local git wrong. GitHub's
stack conflict panel lists files from the whole stack; diagnose with
`git merge-tree --write-tree --name-only <base> <head>` against each candidate base.

**The base can move mid-review.** Re-run `git merge-tree --write-tree <base> HEAD | grep -c
'^CONFLICT'` immediately before posting a review or verdict, not only at the start — a resolution
moves the head, and a verdict marker attests one exact SHA.

**When the parent squash-merges, the child breaks in three ways:**

1. **It conflicts with the default branch** though the content is identical — the child carries
   unsquashed commits the default branch has never seen. Taking the child's side is right only once
   proven: `git diff <merge>^2 <merge>` must be byte-identical to
   `git diff origin/<default branch>...HEAD`.
2. **It still tracks the parent's gitignored artifacts** (e.g. `.claude/desk-ticket-<TICKET>.json`),
   invisible in every review against the parent and visible only once retargeted to the default
   branch. Read `git diff --stat origin/<default branch>...HEAD` as a whole,
   `git ls-files | grep <ignored-pattern>`, and fix with `git rm --cached`.
3. **A clean auto-merge can still break the build** — the child removed an import the default branch
   added a new use of. Typecheck (above).

**Merge stacks bottom-up**, via `merge-async` with §4 Merge method (repo-facts). Merging a child into
its parent's branch moves the parent's head and voids the parent's verdict.

## What a pass actually costs

One hand-derived run, measured from its transcript: **2h51m**, **311 Bash calls in the parent**, 11
subagents, 1 merge. Roughly 200 of those calls were per-PR state derivation, all landing in the
parent's context. `clearance-state.mjs derive` is one call and ~8s for the same information — a
quality change before it is a speed one: the parent that made 311 calls is the parent that stopped
following the skill somewhere around PR 15.

## How wide to fan out

**Fan out as wide as the work is**, within config §3b "Subagents that may run without asking". A
narrow fan-out is not safer — it is the same pass taking four times as long, with a parent whose
context degrades across every extra hour. Do not carry numbers from this file. Ask the box:

```bash
node ~/.agents/skills/desk-clearance/bin/clearance-state.mjs capacity
```

- **ASSESS** — the count of PRs with outstanding comments. No worktree, port or local compute.
- **IMPLEMENT** — `min(budget / ~3G, spare cores / 2)`. §4 Typecheck plus lint and tests.
- **Dev servers** — budget again, plus whatever ports are already bound.

Memory is read as `MemAvailable` on Linux and `vm_stat` free+inactive+speculative on macOS. It is
budgeted against config §3b "Memory ceiling for parallel work (GB)" on every platform. On WSL the
guest's `free` "used" column excludes page cache that VmmemWSL still holds on the Windows side: `free`
can say 2.5Gi used while VmmemWSL sits past 16GB.

Three limits are fixed regardless of the box:

- **One image upload at a time** — a single shared Chromium profile, and the parent does it.
- **One merge at a time** — each moves the default branch, and where §4 Staging deploys on merge,
  fires a release and its migrations.
- **Two subagents never hold PRs that share a source file.**

Subagents draw on the same account usage limits as the user's other sessions, so a wide fan-out
during their working day is not free to them even when the box is idle. Say how wide you are going.

## Running as a loop

- Poll every ~5 minutes. Cost is negligible (~10 of 5000 GraphQL points/hour); wake-up noise is the
  real constraint.
- **Trigger only on a change in the derived verdict or the human feedback count.** Never on
  `mergeable` — it flaps to `UNKNOWN` on every push to the default branch. A poll is
  `clearance-state.mjs diff`.
- **Never an automatic CI retry faster than the slowest job** — a rerun cancels the run in flight
  where the workflow cancels in progress. The cooldown per PR is longer than this repo's slowest job
  (repo-facts, CI).
- **A watcher dies with its session. It is not a queue.** If it must outlive the session, schedule it.
- **Idle** = every open PR is merged, parked with a reason, or waiting on a human. Say so and stop.
- **Report** after each merge and each park: merge SHA, what is blocked and on whom, what needs the user.

## If a parallel review session is running

Protocol that worked: **push → reply → resolve**, so the last resolve always follows the final push.
Zero unresolved therefore means "finished, it's yours". Claim a shared branch explicitly before
acting, and say which worktree you are in. One session with subagents is preferred: the two-session
split cost a near-collision on a force-push and an argument over whose job an update was.

## Conventions worth not relearning

- **The house review pattern is §4 "What review here consistently asks for".** Run it before
  pushing; `reviewer-patterns.md` says how it is kept.
- **Routing is config §4 People:** the code reviewer for engineering calls; the product owner for
  product and destination questions (but use judgement rather than routing every copy call); the
  designer for design (with `none`, design goes to the product owner); the infra and security owner
  for env vars and hosting, added to security-touching PRs and told when a PR touches the paths that
  row names as infra. A row that is `you` means the user decides; `none` means nobody holds it — say
  so, never invent someone. Telling someone is not waiting for them.
- **Slack is drafted, never sent**, whatever the message (`slack-send` is `never`), and only for a
  channel §4 Slack channels names.
- Copy you draft follows config §5 "User-facing copy you write" and "Messages to colleagues"; copy
  supplied by design or product ships verbatim.
- PR bodies: config §5 PR body. No title in the body.
- Code comments: config §5 Code comments.
- **A failing PR-title check is not cleared by retitling alone** (repo-facts). Retitle, then push.
- Toolchain: §4 Package manager and §4 Command prefix, and nothing else — where the row names
  forbidden package managers, never reach for them. Run lint and tests the way §4 Lint and §4 Unit
  tests say (a monorepo often forbids running a linter from the root).
- Whatever §5 Repo instructions names (`CLAUDE.md`, `AGENTS.md` and the like) wins over this file on
  anything it covers: check scripts to run when a directory is touched, generated files a test run
  restamps and that must be reverted before staging.
- GitHub PR image uploads insert an `<img>` tag, not `![alt](url)`, and race on the placeholder —
  wait for that file's own `<img alt=...>` before clearing the box. One PR uploading at a time.

## Failure modes that look like success

`bin/clearance-state.mjs` encodes these. They are written out because the day someone bypasses the
script with a hand-rolled `gh` call is the day they come back.

- **An errored API call reading as a clean state.** `2>/dev/null` plus a `// "NONE"` fallback turns
  auth expiry, a 403 or a rate limit into "no reviews found". Check exit status; retry once, then park.
- **A truncated result read as the whole list.** `gh api` returns **30 per page** and warns about
  nothing. Always `--paginate`; distrust any result of *exactly* 30 rows.
- **A bot counted as a reviewer.** `github-actions` wrote 86 of 87 issue comments on one open set.
- **An empty `reviewDecision` read as "not changes-requested".** It is also what an approval looks like.
- **Green belonging to an older commit.** Re-read the head immediately before merging, and pin the merge to it (`--match-head-commit`).
- **A required check you named from memory — or from the config.** Check names change. Read the
  ruleset and branch protection; the config row is a record, not the authority.
- **An empty result set satisfying a universal test.** `all`, `every`, `none` are vacuously true over
  nothing. Assert something positive exists — on an unprotected repo, a PR with no checks at all is
  not green.
- **`CLEAN` where nothing ever ran.** It means no *required* context is pending or failing.
- **A cancelled run** — not a pass, and often cancelled by your own rerun.
- **A clean worktree read as "no work was done".** `git status` clean and `rev-list --left-right
  --count` at `0 0` is what a finished, pushed PR looks like. **Verify against GitHub** — head SHA,
  thread states, last comment — never worktree cleanliness.
- **A squash merge read as "the branch is now in the default branch".** Squash creates a new commit;
  the branch commits never become ancestors. After a revert, re-raise the branch as an ordinary PR —
  no revert-of-revert. Where the branch is deleted on merge (§4 Repo merge settings), push it back
  first.
- **Clearing a gate that was the last thing holding an armed auto-merge.** Check `autoMergeRequest`.

## Backlog self-review

One-off, for the user's open PRs that predate desk-ticket's local review (§4 Local review command).
**With that row `none`, this section does not apply.** Posting a review to a PR is config §3
`pr-self-review-comment`; never `--approve`, never `--request-changes`, and ask before posting to
more than three PRs whatever the tool's own guard does.

**Scope the sweep to the user.** A review tool's sweep mode may query every open PR, selecting
`author { login }` without ever filtering on it. Read its queue query, and add, with the config §1
GitHub handle:

```
| map(select(.author.login == "<handle>"))
```

**Skip on the marker, never on "reviewed by me at head".** Replying to an inline comment makes GitHub
record an empty-bodied `COMMENTED` review by the user, and push → reply → resolve manufactures those
by the dozen: on one measured sweep, 15 of 22 PRs read as "already reviewed" on reply artefacts alone.
Local review tools usually open a posted review body with a fixed HTML-comment marker, and a fix-up
reply with a *different* one (a reply posts at the new head and must not claim that head was
reviewed). Find the markers §4 Local review command writes — in its docs, or in a review it has
already posted — and match the review marker with `startswith`, never a regex (a body that quotes the
marker matches a regex):

```
| select(.author.login==$me and (.body // "" | startswith("<review marker>")) and .commit.oid==$pr.headRefOid)
```

If the tool writes no marker, there is no reliable "already reviewed at head" test: list the PRs and
ask the user which to cover.

**Size it from the box.** Each PR draws 1-3 finder subagents plus a refutation pass. Batch with
`--limit`, highest tier first, and re-check capacity between batches.

**Check codex once, before the batch** (only where config §3 `codex-review` is `yes` or `ask`, and §4
"Codex answers a real call?" is not `no`):

```bash
codex exec --sandbox read-only "Reply with exactly: CODEX_OK"
```

Not `codex login status` — it reports logged in on a seat that is out of usage. Exit 0 and the batch
refutes cross-vendor. Anything else: stop and say so; `codex login` is interactive and the user's to
run. Only if they say run it anyway does it fall back to a same-vendor refuter, every finding tagged
`(same-vendor)`.

**A finding is a park, never an amendment to the merge bar.** A confirmed P0 parks the merge with its
`file:line`, and the user decides. Name every PR covered and its head SHA in the pass report.

## Two instances of desk-clearance

Do not run two. They will both update and both merge. If another instance or session may be active,
claim the queue explicitly before acting, exactly as with a parallel review session.
