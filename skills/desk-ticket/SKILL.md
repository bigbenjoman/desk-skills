---
name: desk-ticket
description: >-
  Use when working on a ticket in a repo set up for desk, at any point in it: starting one
  ("do ticket ABC-508", "fix this GitHub issue", "do this: <description>"), or mid-ticket when
  about to commit, push, open or update a PR, comment on or transition the ticket, reply to a
  review comment, take screenshots, or clean up a branch or worktree. The ticket is a key
  matching this repo's ticket key pattern, an id matching its other work id patterns (planning-tool
  or bug ids), or, where the repo has no tracker, a GitHub issue URL or a plain description. Also when resuming an interrupted session. Applies even when the
  request is only the single step ("just push it", "give me the PR body") rather than the whole
  ticket.
argument-hint: "<TICKET | work id | GitHub issue URL | \"description\"> [--tail]"
---

# desk-ticket

## Overview

One ticket, one entry point. This routes the work to the cheapest path that can actually solve
it, then runs the same tail every time so nothing gets forgotten.

**Core principle: the human decides anything that has consequences. Everything else is yours.**

## Read this repo's config first

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no  (exit 3 outside a repo)
```

Read the `CONFIG` file it prints, before anything else. **`EXISTS=no` means stop**: say which slug
was looked up and offer `/desk-setup`. Exit 3 means you are not inside a git repo; say so and stop.
A `TODO` in any row this skill needs is a question, not a default: stop, ask, and offer
`/desk-setup`. A row the file lacks is unset (a `no` in §3); name it and offer `/desk-setup`.

What each section is for here: §0 for the repo (`GitHub repo`, `Default branch`), §1 for the GitHub
handle and git identity, §2 for the primary repo root, worktrees and handoff directories, §4 for the
tracker, the checks, the toolchain, the services and the people, §5 for branch, title and PR
conventions and the repo's own instruction files, §3b for the caps, and §3 for what you may do
without asking. Anything in §3 that is not `yes` needs asking before each use: assigning
(`jira-assign-self`), transitioning (`jira-transition`), pushing (`git-push`), opening a PR
(`pr-open`), posting a review (`pr-self-review-comment`), undrafting and arming auto-merge
(`pr-ready`, `pr-auto-merge`). **The files §5 Repo instructions names are binding too** and win over
this skill on anything they cover.

Placeholders used below:

| Placeholder | Means |
|---|---|
| `<TICKET>` | the ticket's key (examples use `ABC-123`): a tracker key, a work id, or with no tracker `issue-<n>` or a slug (below) |
| `<default>` | `desk-env get default-branch`: §0 Default branch, or the batch's base when an autopilot batch sets one |
| `<repo>` | §0 GitHub repo (`owner/name`) |
| a §4 Toolchain row, e.g. "§4 Typecheck" | that command, with §4 Command prefix in front unless the prefix is `none` |

Then read `references/desk-ticket-working-style.md` before writing code. It carries the
standing conventions on minimal changes, comments, branch naming, diff hygiene, generated files
and evidence capture.

### What the ticket can be, and the ticket file

| Argument | `<TICKET>` | Text comes from |
|---|---|---|
| a key matching §4 Ticket key pattern (Tracker `jira`) | the key | Jira, via `desk-jira` |
| an id matching §4 Other work id patterns (any tracker), e.g. `P1-M14-FIX-1`, `BUG-119-5` | the id exactly as given, case kept | the planning file that defines it (`.belmont/`, or wherever §5 Repo instructions say work is planned), or the user |
| with Tracker `none`: a GitHub issue URL or `#<n>` | `issue-<n>` | the issue, `gh issue view <n> --repo <repo> --comments` (§3 `read-own-work` / `read-others`) |
| with Tracker `none`: a plain description | a kebab-case slug of it (two to five words, lowercase ASCII) that you state at Stage 0 | the user's words: anything they leave open is a question |

Anything else is not a ticket here: say which patterns it failed and ask. `<TICKET>` goes everywhere
a key would: the branch, the resume file, the handoff directory, the session name, the comment
marker. A work id is matched whole: `BUG-119` is not `BUG-119-5`.

**For every non-tracker `<TICKET>`, write the ticket file at Stage 0**, so a later session, an
autopilot batch and the merge driver all read the same text: `$DESK_STATE/tickets/<TICKET>.md`
(`desk-env paths` prints `DESK_STATE`), as

```markdown
# <TICKET>

Source: <one of: the user, in this conversation · GitHub issue <owner/name>#<n> · <planning file path>, entry <id>>

<the ticket text, verbatim: title, description, acceptance criteria>

## Comments
<for a GitHub issue, every comment in order with author and date; otherwise omit this section>
```

Copy, never summarise. For a planning id, find its entry in the planning file and copy the task
text and acceptance criteria with the path in `Source:`; no entry, or two, is a question. If the file
already exists, read it and say so rather than overwriting it. Never write one for a tracker key.

For every non-tracker ticket, these change, each said in one line when you reach it rather than
silently skipped:

- **The issue type** comes from the description, the issue's labels, or asking: bug, feature, or
  other. It picks the branch prefix exactly as a Jira type would.
- **Every Jira step is skipped**: no assignment at Stage 0, no transition at Stage 2, no comment or
  transition at Stage 8, no move to a done state after merge. Nothing in §3 lets a skill comment on,
  label, assign or close a GitHub issue, so never do any of those; the PR body references the issue
  in the form §5 PR body uses, and adds a closing keyword only if that convention does.
- **"The ticket is done"** means the PR merged (and, for an issue, that it is closed).

## Stages

| # | Stage | What happens |
|---|---|---|
| 0 | Triage | Read the ticket fully: description, comments, linked issues, the design link if one is set, and, for context only, its parent epic or story (this ticket's own criteria are its scope). Note the issue type. Rename the session (below). Assign to the user if unassigned (Jira only). Pick a **provisional** lane and state it with its cost, **plus which skills own which stage** (below). Write the resume file. **Do not transition the ticket yet.** |
| 1 | Branch | Off up-to-date `<default>`, named per §5 Branch names with `<TICKET>` in it, prefix from the issue type. Record the exact branch in the resume file: the PR is opened from it and is found by it (the autopilot merge driver matches a ticket's PR by its exact head branch and base `<default>`), so never rename it later. Worktree if another session is live, or lane C/D. **A new worktree then runs §4 Project subagents sync**, see below. |
| 2 | Understand | Read the code paths, and **what the repo's own documentation says about them** before writing any code (below). Reproduce the bug. **Commit the lane now**: this is the first point it is knowable. Transition to §4 In-progress state (Jira only). Flag anything wrong in the ticket. |
| 3 | Implement | Per lane. A ticket that renders UI loads the design skills before any UI code (below). A change that is not mechanical gets its design from the area's expert first, and you write the code (below). Lane C stops for agreement before this stage; lane D hands the build to the project's design-build agent where it has one (routing reference). |
| 4 | Verify | `desk-dev` for the environment. §4 Typecheck, §4 Lint (its fixing form if the row gives one), §4 Unit tests and the knowledge check where the repo has one; a §4 Build only when the change needs one (below). Add a spec that guards the fix. A claim the knowledge check reports as changed gets written back in this branch (below). Then run the docs check from `desk-pr` §1 and **report** what it finds: a hit is sometimes a stale comment in the source rather than a page edit, and that is far cheaper to learn here than at Stage 7. Report only; rewriting a page is the user's call. |
| 4b | Self-review | Run §4 Local review command on the branch, **before** Stage 5, so a finding cannot invalidate screenshots already taken. With `none`, the stage is a stated skip (below). Two preconditions, each a silent false clean otherwise: where the command is a repo-local skill, the tree must contain it (rebase onto `<default>` rather than skipping), and an empty diff is a stated skip, never a clean run. **Fix what the review confirms, then report**; do not stop and ask first. Apply every confirmed P0 and P1, and any P2 whose fix is mechanical, as their own commit. Produce the `SELF-REVIEW` block as a record of what was done, with an outcome against every finding. Re-run after fixes, **at most three rounds**: each fix is itself unreviewed code, so only a round that finds nothing has reviewed everything. If the third round still finds something, stop: report what is left, do not open the PR, and let the user decide. **Three things also stop and wait**, because no refutation settles them: a finding whose fix changes product, design or catalog behaviour; **a fix that grows**: it needs a new file other than its own spec, or a file the ticket's diff does not already touch (Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call sites.); and any finding you could not confirm because the refutation pass did not run. |
| 5 | Evidence | **Only if the change alters what renders, or what a server route, webhook or job does at runtime.** For a rendered change, confirm the running server's HEAD matches your branch, capture before/after to `<handoff dir>/<TICKET>/` (config §2), and delete the Playwright artefacts. For a server or webhook fix, the evidence is the request or log that shows the fix running, not only a screenshot. If neither applies, skip the stage and say so in one line. |
| 6 | Hygiene | Diff review against the checklist in the working-style reference. |
| 7 | PR | **Invoke the `desk-pr` skill and follow it. Do not write the body from memory.** It owns the hygiene block, the permitted sections, the Testing-bullet standard and the before/after image table. Ends with `gh pr create --repo <repo> --draft --base <default> --body-file` (that flag order; see `desk-pr`), then the image upload. **Then post the Stage 4b report to the new PR**, then, where config §3 permits, **undraft it, arm auto-merge and shepherd it until it merges**. See "Merging" below. |
| 8 | Jira | A non-tracker ticket (a work id, or Tracker `none`): skip, and say so. Otherwise invoke `desk-jira`. Comment per §5 Ticket comment: root cause in one sentence, fix in one sentence, PR link. Nothing else; see "Jira comments" in the working-style reference. Transition to §4 Review state (skip if it is `none`) by reading the available transitions, never a hardcoded name. |
| 9 | Cleanup | `git status` clean, release the lock, report the PR link and whether it merged. |

**Skill routing goes in the plan, not a closing checklist (Stage 0).** State a short table of which
skill owns which stage: `desk-ticket` for this ticket, `desk-pr` at Stage 7, `desk-jira` for
Jira writes (or "none: no tracker"), `desk-review-response` for any reviewer comment, `desk-dev` for
the environment, `desk-autopilot` for a batch of tickets, and for a ticket that renders UI
`ux-designer`, `ui-designer` and `ux-copywriter` at Stage 3. Name any the user would expect that you
are **not** using, with the reason. A plan that buries the routing reads as improvised process.

**Read what the repo documents before writing code (Stage 2).** The files §5 Repo instructions names
are the repo's own rules, and Stage 4b's review reads the same material, so a documented rule
learnt there costs a round. Where those instructions describe a knowledge base with a check command
that maps a path to the documented claims about it (below, "the knowledge check"), run it for each
file in scope and read the claims it names, not whole domain files. Otherwise read the sections of
the instruction files that cover the paths. If nothing documents the path, say so in one line.

**Experts shape the design; you write the code (Stage 3).** The project's own subagents (in
`.claude/agents/`, linked into a worktree by §4 Project subagents sync) are for development as well
as review. When a change is not mechanical, ask the agent that owns its area for the approach before
writing it, routed by path: use the area table the repo gives them (the local review command's role
table where it has one, otherwise each agent's description), and the infra and security owner's
paths from §4 People for infra and auth. Brief it with the ticket, the repro and what you have read,
and ask for the design, not the code. Then write it in this session, which holds the ticket context
and can ask the user; splitting one change across agents by file type loses both. Mechanical changes
need no consult. A repo with no project subagents has no consult: put the design in the plan
yourself and say so. Lane D is the exception (routing reference).

**A ticket that renders UI loads the design skills before any UI code (Stage 3).** It renders UI
when autopilot triage says `renders: true`, when the ticket's Design section says anything other
than `No UI`, or when the change alters what a user sees. Nobody has to ask; load them in every lane,
before the first component, style or message-file edit:

- **`ux-designer`** for the flow and every state the UI can be in: empty, loading, error and
  success, plus any the ticket implies. A state the design or ticket does not show is designed here,
  not left to whatever the code falls into.
- **`ui-designer`** in its existing-system mode (Mode B), against the files §5 Design system names
  (`desk-env list design-system`): read them before designing. Every colour, type size, spacing value
  and radius comes from those tokens; a value they do not hold is labelled in the PR as a proposed
  extension (its Mode C), never added silently. With the row `none`, its own Step 0 detection decides
  the mode, and the PR says which it chose.
- **`ux-copywriter`** for any user-facing wording: labels, buttons, errors, empty states,
  confirmations. Copy the ticket or design states verbatim stays verbatim; this is for the wording
  nobody wrote.

Load each with the Skill tool. An autopilot worker has no skill registry and reads each one's
`SKILL.md` as a file instead (worker contract). A skill that is not installed is said in the plan,
with `/desk-update` as the fix, never skipped silently. Brief any design consult or design-build
agent (Suki, Muriel) with the same three skills and the Design system row.

**Build only when the change needs it (Stage 4).** CI builds every PR. Run §4 Build locally when the
change touches what typecheck, lint and unit tests cannot see: framework or bundler config,
dependencies, middleware or request proxies, route-level config (static generation, metadata
exports), or a client/server module boundary. A framework build usually runs its own type-check, so
take the `tsc` lock:

```bash
~/.claude/desk/bin/with-lock.sh tsc --cwd <DIR> -- <CMD>     # each DIR<TAB>CMD from `desk-env cmds build-cmd`
```

**Keep the knowledge base true (Stage 4).** Where the repo has a knowledge check, CI usually runs it
too. A reported claim whose code changed is the trigger to write back: update the claim in this
branch, the way the repo's instructions say to, so the update ships in the same diff and Stage 4b
reviews it. A domain whose shape changed needs a larger rewrite; propose that rather than doing it.

**Running the suites (Stage 4).** A parallel test runner (Jest, Vitest and most others) sizes
itself at `cpus - 1` workers by default, with no awareness of any other run. A large suite at that
width holds several GB resident, so two at once oversubscribe both RAM and CPU and each finishes
slower than if you had simply waited.

**Cap it and lock it, every time** (the cap is config §3b "Test worker cap under the test lock").
§4 Unit tests holds one backtick span per suite, and a suite may name its directory
(`` `apps/api: uv run pytest` ``); `desk-env cmds test-cmd` prints each as `DIR<TAB>CMD` (`DIR` is
`.` at the root). Run each in its directory with `--cwd`, never as `cd <dir> && …`, and append the
cap as `--maxWorkers=<cap>` **only to a Jest or Vitest command**, in the form §4 Unit tests gives for
passing arguments; pytest and other runners reject the flag:

```bash
~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD> --maxWorkers=<cap>   # Jest / Vitest
~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD>                       # pytest and others
```

`with-lock.sh` (installed by `install.sh`) serialises you against every other session and every
autopilot worker on the machine, in every repo: they take the same `test` lock under `DESK_LOCK_DIR`
(default `/tmp`), and it releases on exit, including on a crash. It blocks rather than fails, and
that wait is the feature. **Do not add a timeout, and do not run two at a percentage cap instead.**
It uses `flock` where it exists (macOS: `brew install flock`) and otherwise a `mkdir` lock that
takes over from a dead holder. Do not hand-roll a lock of your own.

A typecheck is often a single multi-GB process; take the same lock for it
(`with-lock.sh tsc --cwd <DIR> -- <CMD>` for each item of `desk-env cmds typecheck-cmd`) rather than running typecheck and a suite together. Screenshot
and Playwright capture uses a separate lock, `with-lock.sh browser …`, so it does not queue behind a
suite it was never competing with. To see what is holding things:

```bash
desk-env heavy       # suites, typechecks, dev servers actually running (never pgrep -f)
desk-env mem avail   # room to start something, in GiB; under ~4, wait
```

If config §2 "Running on WSL?" is `yes`, the practical ceiling is lower than the guest reports:
the Windows host runs out of RAM for VmmemWSL around config §3b "Memory ceiling for parallel work
(GB)" whatever `free` says, which is why the cap is a fixed worker count rather than a percentage.

**Repo facts live in the repo's own instructions.** The rules below that depend on a repo fact point
at the config row or the §5 instruction files that carry it, because this skill is the same in every
repo.

**Database-backed suites: never two at once against the same database.** Suites that isolate by
per-worker schema tear down each other's schemas. Which suites touch a database is in §4 Unit tests,
§4 E2E tests and §4 Local database; with §4 Local database `none`, this does not arise. The test lock
does not cover every runner reliably, so check for another worktree's run first (match the runner's
binary in `ps -eo args`, e.g. `grep -E '[.]bin/vitest run'`) and follow config §3 `tests-shared-db`.

**Self-review (Stage 4b).** §4 Local review command is the repo's own review: often a repo-local
skill that reviews the branch against the house bar (§4 What review here consistently asks for) in
one or more read-only finder subagents, then refutes the findings. Where it is a repo-local skill, it
only resolves in a tree that contains it, so a checkout branched before it landed has to be rebased
first. If it still does not resolve after the rebase, the skill list was read when the session
started: restart rather than working around it. The command failing to resolve is never a reason to
skip the stage.

**§4 Local review command `none`** means this repo has no local review. Stage 4b is then a stated
skip, never an improvised review: the `SELF-REVIEW` block says `skipped: §4 Local review command is
none`, nothing is posted at Stage 7, and the PR's Testing section says the branch had no local
review. Everything else about the stage (the three-round cap, the stop conditions) has nothing to
act on.

Skills load from the **main checkout** at session start, so a main checkout behind
`origin/<default>` can serve a stale copy of a repo-local review skill, one that lacks a marker or a
rule a required check now reads. Where the review is a repo-local skill, compare the loaded copy with
`git show origin/<default>:<its SKILL.md path>` and take the contract from `origin/<default>` if the
loaded copy lacks it.

Where the review refutes its findings with `codex` (a cross-vendor pass), whether codex answers is
config §4 "Codex answers a real call?", and sending it diffs at all is §3 `codex-review`. Check it
rather than assuming it, because a logged-out or out-of-usage CLI fails the same way an absent one
does:

```bash
codex exec --sandbox read-only "Reply with exactly: CODEX_OK"
```

**Not `codex login status`**: it reports logged in on a seat that is out of usage, so it passes
while every refutation fails. Only making codex answer tells you anything.

Exit 0 means usable. Anything else (an error naming a usage reset date, a capacity error, or no
output at all) means stop and say so; `codex login` is interactive and the user's to run. If they
say run it anyway, the refutation falls back to the review's same-vendor refuter, and the
`(same-vendor)` tag has to survive into the gate block and into the PR body. Dropping it claims
cross-vendor verification that did not happen.

**Finders must stay read-only.** They inherit Edit and Write, and one will sometimes implement a fix
mid-round, even in a file the PR did not touch, so the review attests a tree nobody pushed. Check
`git status --porcelain` after every round; a dirty tree is an aborted round: save the stray diff,
restore, re-run, and say in the review that a round was discarded.

**Three rounds, then stop.** Review, fix, re-review has no natural end: every fix is new code a
finder can find something in. After the third round, stop whatever it found, report what is left,
and let the user decide whether a fourth runs. The count belongs to one loop; a later loop, for
reviewer feedback or after merging `<default>`, starts again at one.

**Posting the self-review (Stage 7).** Local reviews are posted to the PR so the code reviewer
(config §4 People) can merge faster. So, where config §3 `pr-self-review-comment` allows, the Stage 4b
report goes onto the PR as one `COMMENTED` review, immediately after `gh pr create --draft`:

```bash
gh pr review <n> --repo <repo> --comment --body-file <report>
```

Plain `gh`, authenticated as §1 GitHub handle (`gh auth status` shows the active account; switch
with `gh auth switch` if it is another). Never a `GH_TOKEN=…` prefix: no harness rule matches a
`VAR=value` form, and autopilot workers are refused it outright.

Where the review command defines markers, use them exactly. Open the body with its **local-review
marker**: that is what lets a later sweep tell a real review from the empty `COMMENTED` artefact
GitHub records every time you reply to an inline comment. The **second line is its verdict marker**
(the head SHA it reviewed and its counts), which a required check may read at the PR's current head.
**A later "fixed in `<sha>`" reply carries the command's reply marker instead, and no verdict**: it
posts at the new head, so giving it the review marker claims that head was reviewed when it was not.
**Never `--approve` or `--request-changes`.** A clean run posts too: absence of a review must mean
*not reviewed*, not *reviewed and clean*.

Stage 4b still runs **before** the PR exists, so this is a post of the report you already have: one
review pass per ticket, not two. The SHA and any `(same-vendor)` tag carry into the posted body
unchanged. If the head moved between 4b and the push (you fixed a finding, or rebased), re-run at
the pushed head rather than posting a report about a different commit. Never re-point an existing
marker's SHA at a new head.

**Counts never change at the same commit without a new run.** Never post a second verdict at a
SHA that already has one with different counts, and never edit the counts of one already posted.
A gate reads the last verdict at head, so a re-post that relabels findings is indistinguishable
from editing the result until it passes: a re-post that zeroes the deferred count with no code
change can clear a known P0. If a count is wrong, re-run the review at that head and post that run.

**Declining a confirmed finding is a deferral, and a deferral does not read as clean.** It keeps the
verdict off §4 Clean review verdict, and where a required check reads the verdict, the gate blocks
the merge. Cost the fix before deferring: "beyond scope" is usually a guess made without opening the
file. A fix that stays inside the ticket's files goes in this PR: a split buys nothing but a second
PR, review and merge. **A fix that grows stops and asks**: one that needs a new file other than its
own spec, or a file the diff does not already touch, is the "while I'm in here" red flag arriving
through a finding. The user chooses between widening this PR and splitting the finding to its own
ticket. Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them
all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call
sites.

**Merging (Stage 7).** A draft cannot merge, so a PR left drafted is a merge silently deferred. If
config §3 `pr-ready` and `pr-auto-merge` are both `yes` (auto-merge merges on green by itself, so it
also needs `pr-merge-green`), and §4 Repo merge settings allow auto-merge, right after the Stage 4b
post:

```bash
gh pr ready <n> && gh pr merge <n> --auto --<§4 Merge method> --match-head-commit <headRefOid>
```

Where the repo does not allow auto-merge, undrafting is the same and the merge is yours to make on
green under `pr-merge-green`, always pinned: `gh pr merge <n> --<§4 Merge method>
--match-head-commit <the head SHA whose checks you read>`. **A PR that touches a glob in §4 Merge
holds is never merged or armed by you**, whatever §3 grants: report it ready with the hold's reason
(the manual step the repo needs first) and let the user merge it. Then **shepherd it until it merges** rather than handing back at
"armed": the same rules the autopilot's merge driver follows, for one PR. If either row is `ask`,
ask; otherwise stop at the draft and report the link. Once it merges, and it was the last open PR on
the key, move the ticket to §4 Done state via `desk-jira` under §3 `jira-close-own-merged` (a
non-tracker ticket: nothing to move).

- **Green is the config's one definition** (desk-config "Green", the same in `desk-autopilot`,
  `desk-clearance` and the merge driver): on the exact head commit being merged, every §4 Required
  checks entry completed with success (skipped does not count); no other check failed, errored, timed out
  or is still queued or running, unless §4 Advisory checks names it; and at least one check
  completed with success. Then merge pinned to that commit with `--match-head-commit`. With §4
  Branch protection `none`, nothing on GitHub stops a red merge, so the check is entirely yours.
  Read check state with `gh pr checks <n> --json name,state,bucket`, or `awk -F'\t'` on the plain
  output: it is tab-separated, and a check name carrying an emoji breaks whitespace splitting.
- **A review gate can fail on a fresh PR's first run when the review posts late.** Where a required
  check reads the posted verdict: CI typically runs only on open, reopen and push, so posting a review
  starts nothing. If the gate polls for the verdict briefly after the run starts, a review posted
  inside that window passes the same run. If the post missed it, wait for the whole run to reach
  `completed`, confirm the verdict's SHA is the head, then rerun it.
- **Red check: read why before acting.** Retrigger only a run that has reached `completed`, found by
  head SHA (`gh run rerun <id> --failed`, under §3 `ci-rerun`). Rerunning one in flight cancels it,
  and a fast loop starves the PR forever.
- **A red preview-deploy check is often the host's builder running out of memory** (exit 137), not
  the code. Where §4 Vercel is set and §3 `read-vercel` allows,
  `vercel inspect --logs <url> --scope <team slug from §4 Vercel>` first. One preview build at a time.
- **`DIRTY` merges nothing.** Merge `origin/<default>`, typecheck, then re-run Stage 4b at the new
  head and post it: a gate that matches the verdict against the exact head SHA reads nothing older.
- **Human review feedback lands while armed** and §3 `merge-feedback-first` is `yes`:
  `gh pr merge <n> --disable-auto`, work it via `desk-review-response`, then re-arm.
- **Never `--admin`.** Any code change while shepherding gets the same diff record and self-review.

**A new worktree can have no agents until you sync it (Stage 1).** Where the repo gitignores its
generated `.claude/agents/*.md`, a fresh worktree starts with that directory empty and every named
agent silently resolves to `general-purpose`: every review finder, and the same-vendor refuter the
review falls back to when codex is unavailable. Nothing warns you. First commands in a new worktree:

```bash
<§4 Project subagents sync>          # skip when it is `none`; then `ls .claude/agents/` is not empty
~/.claude/desk/bin/copy-env.sh       # §4 Env files from the main checkout; skip when that row is `none`
```

Env files go in before §4 Install, which can fail without them. If a review did run without the
agents, say so in the report header rather than letting it pass as a full fleet run.

For lane predicates, costs, demotion triggers and how lanes C and D run: **read
`references/desk-ticket-routing.md`**.

`--tail` skips to Stage 4 using the resume file. Use it to pick up an interrupted run.

## Keep them posted

Report at **every stage boundary**: one or two lines, what finished, what's next. Say what you're
about to do before any step that takes more than a minute or two, and surface findings as you hit
them rather than saving them for the end. People run several sessions at once; going quiet is the
problem. Full rule in `references/desk-ticket-working-style.md`.

**Decisions go in a question carousel.** When a ticket turns up choices the user must make, ask with
`AskUserQuestion`: one question per decision, your pick first labelled `(Recommended)`, a one-line
trade-off on each option, rather than a prose list of defaults.

## Session rename (Stage 0)

Sessions want naming for the ticket so parallel ones are tellable apart:

```
<TICKET>-<type>        ABC-448-bug   ABC-473-task   ABC-440-story   issue-81-bug   fix-login-redirect-bug
```

`<type>` is the literal Jira issue type, lowercased (`bug`, `task`, `story`), or with no tracker
the type Stage 0 settled (`bug`, `feature`, `chore`).

**You cannot do this yourself.** `/rename` is a built-in command and only the user can type it.
Writing the `name` field in `~/.claude/sessions/<pid>.json` does change the stored value, but the
running process owns that file and the displayed title does not pick the change up mid-session, so
it looks like nothing happened.

So at Stage 0, ask for it in one line and move on. Don't wait for it, and don't edit the file:

> Worth renaming this session: `/rename ABC-612-bug`

If the ticket type isn't obvious yet, say the name once you know it rather than guessing.

## The eight gates

Each one stops and waits for the user unless config §3 grants it. Silence is not agreement.

1. **Never invent product data.** Catalog entries, names, levels, prices, business rules: if the
   real value isn't in the ticket, the sheet, or the database, ask. Prefer an authoritative source,
   or "only what's real", over a plausible list. The call is the product owner's (§4 People); design
   questions go to the designer, or the product owner where Designer is `none`.
2. **Show Jira text.** (A non-tracker ticket: there is none to show.) Whether it blocks depends on config
   §3 `jira-comment`, `jira-create` and `jira-edit`: at `yes`, comments, new tickets and description
   edits post without blocking, provided the exact text is printed as it goes, so the user reads
   what *was* posted; at `ask`, print it and wait. Three are decisions rather than records, and wait:
   **closing a ticket** any way other than the §4 Done state after the user's own last PR merges
   (§3 `jira-close`; that move is `jira-close-own-merged`), anything **routed to another person**
   (§3 `jira-route`), and anything asserting a **product or catalog fact** gate 1 covers, which waits
   whatever §3 says. Read every write back afterwards: `desk-jira edit` can report the ticket
   `updated` even when it wrote nothing useful, and a select custom field (§4 Priority or §4 Other
   fields name any) passed as a bare string 400s where `'{"value":"<option>"}'` succeeds.
3. **Show the diff before pushing.** At config §3 `git-push` `yes`, print the `DIFF REVIEW`
   block as a record and push; at `ask`, print it and wait. The stray-commit check below hard-stops
   either way, and so does a failing pre-push check: every push, fix-ups included, runs
   `desk-pr` §4 "Before every push" first.
4. **Leave the dev server running** on the port recorded in the resume file so the user can test
   it themselves. Never `pkill node`.
5. **A reviewer's comment gets validated before any code changes.** Say whether it's correct
   and why, first, via `desk-review-response`, loaded rather than approximated.
6. **Any shared-state mutation stops first**: rebuilding a shared local index or cache (§4 Local
   services, §3 `local-reindex`), a concurrent database-backed test run another session may collide
   with (§3 `tests-shared-db`), or any write to real staging (§3 `staging-write`).
7. **Self-review findings are acted on before the PR exists.** Stage 4b fixes what it
   confirms rather than asking permission per finding, and its block reports the outcome
   against every one: fixed (with the commit), declined (with the reason), or escalated
   under one of Stage 4b's stop conditions. The gate is that the block exists and
   accounts for every finding, not that the fixes waited.
8. **Legal and compliance content is findings-first.** A change to legal documents or policy
   copy goes to the ticket as a findings comment (with no tracker: to the user, as findings in the
   conversation), with implementation split into a follow-up that waits for team sign-off, even
   when the fix is tested locally. A standing grant in config §3 does not cover it (`legal-content`
   is `stop`). When a legal change does ship, any last-updated stamp the repo keeps for that
   document moves in the same commit.

### Gates 2, 3 and 7 are slots, not intentions

Produce these blocks. A stage that should have one and doesn't is incomplete:

```
JIRA <TICKET | COMMENT | EDIT | TRANSITION> — <posted | awaiting approval>
target : <ABC-123, or "new ticket in <§4 Jira project>">
fields : type · assignee · labels · priority (§4 Priority) · any §4 Other fields set
---
<the exact body, verbatim>
```

Print it with `posted` at the moment it goes when §3 grants it. It is `awaiting approval` for the
three exceptions in gate 2, when §3 says `ask`, and for anything you are unsure sits inside the
grant: an unnecessary pause costs a message, whereas a wrongly-posted product claim or a ticket
landed on a colleague costs a retraction.

```
SELF-REVIEW
reviewed  : <branch> → <default> at <sha> · <n> files · <tier> tier · <k> finders
refuted   : <codex, or "<same-vendor refuter> (same-vendor)" and why codex was unavailable,
             or "did not run" and what confirmed the findings instead>
domains   : <what the knowledge check or the repo's instructions named, or "none — nothing documents these paths">
P0 (n)      <file:line — one line each>
P1 (n)
P2 (n)
REQ GAPS (n)  <TICKET — the criterion>
caveats   : <any check the run could not perform, or "none">
outcome   : <per finding: fixed in <sha> · declined, and why · escalated, and which
             stop condition it hit>
rounds    : <n> of 3 in this loop
re-review : <result at the new head, or "not needed — nothing was changed">
```

With §4 Local review command `none`, the block is one line: `SELF-REVIEW skipped: §4 Local review
command is none`.

**Every finding gets an outcome line, including the ones you fixed.** The block is a record rather
than a request, so it is the only place a reader can see that a P0 existed at all: a finding that
is silently fixed and never reported reads afterwards as a review that found nothing.

**"No P0, P1 or P2 across n files" is a result and still gets the block.** An absent block is
indistinguishable from never having run it, which is the one thing this gate exists to rule out.

**The `caveats` line is the one that earns the gate.** A clean report where a check silently did
not run is worth less than a report with a finding, and the difference is invisible unless it is
written down. Two that have happened: the knowledge check named **no** owning domain for a changed
file, so no domain file reached the finders and the review's documented-exception filter never
applied; and the finders read the specs statically rather than executing them. Neither changes the
verdict. Both change how much the verdict is worth, so both go in the slot.

```
DIFF REVIEW — <recorded | awaiting approval>
files changed : <n>   (<list>)
commits ahead : <output of git log --oneline origin/<default>..HEAD>
artefacts     : <git status --porcelain, or "clean">
```

**Before any push, `git log --oneline origin/<default>..HEAD` must contain only your own commits for
this ticket.** If it contains anything else, do not push: report the stray SHAs and offer to
move your commits onto a clean branch off `origin/<default>`. This has happened: another session's
work went up attached to an unrelated ticket.

## Red flags — stop

- About to write a value you can't point to a source for
- "It's probably called X" / "the label is likely Y"
- Concluding "this helper does not exist" from a local grep rather than `origin/<default>`
- About to `git push` without having shown `origin/<default>..HEAD`
- Editing code in response to review feedback you haven't yet assessed
- "While I'm in here": new behaviour this ticket does not require. Moving sibling sites onto a
  helper this PR creates or fixes is finishing the fix, not this
- Adding a test nobody asked for, or hardcoding the ticket's example into one
- A one-off script in the diff
- Committing a legal or policy edit rather than posting findings
- Escalating to lane C or D without naming the signal that justified it
- Writing code in a documented area without having read what the repo documents about its files
- Handing an expert subagent the implementation rather than asking it for the design
- About to open a PR without having run Stage 4b (or stated its skip, where the command is `none`)
- Starting a fourth review round without the user
- About to post a verdict at a commit that already has one, with different counts
- Treating the local review command not resolving in this tree as a reason to skip it rather than to rebase
- Dispatching finders in a worktree without having run §4 Project subagents sync: they are all
  `general-purpose` and the report will not say so
- Posting a review whose header does not state which agents actually ran, what refuted the
  findings, or that drops the SHA
- Claiming a codex refutation on a run where codex was never made to answer
- Treating a user's "should we…?" as an instruction: it opens a discussion; answer with a proposal
- With Tracker `none`, about to comment on, label or close the GitHub issue
- About to work a non-tracker ticket without having written its ticket file
- About to merge without `--match-head-commit`, or a PR under a §4 Merge holds glob

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "The data is obviously missing, I'll fill it in" | Inventing catalog entries that didn't exist has cost a full revert and a restart. Missing data is a question, not a gap to close. |
| "It's a one-line change, I'll just also tidy this" | The most frequent review complaint is unnecessary files in the diff. Unrelated tidying is that; migrating the sibling sites of a helper this PR creates or fixes is not, so migrate them or list each under *Not migrated*. |
| "They said push it, they're in a hurry" | Urgency is a reason to show the diff, not to skip it. A contaminated push costs far more than 20 seconds. |
| "The reviewer is senior, just make the change" | Two of a senior reviewer's comments have turned out not to apply. Answering first is faster than changing twice. |
| "A spec would make this more robust" | Unasked-for tests have been removed from three PRs. Ask. |
| "The ticket seems big, I'll stop for a plan" | A ticket that looks big can be a one-line deletion. Name the signal or take lane A. |
| "I'll reindex quickly to check" | A shared local index is every other session's index. |
| "I'll tell them once it's all done" | They want to test it themselves before the PR exists. |
| "The design has placeholder copy, so the ticket is blocked" | Build with the placeholders in as real copy keys and raise **one** spin-off ticket for all of them. |
| "Self-review found nothing, so there is no block to show" | The empty result is the finding. Show it. |
| "I should ask before fixing this finding" | Stage 4b fixes what it confirms. Only the stop conditions wait: product/design/catalog behaviour, a fix that grows, a finding the refutation pass never confirmed, or a third round still finding things. |
| "The P0 is fixed, so the block can just report clean" | Then nobody ever learns a P0 existed. Fixed findings still get an outcome line naming the commit. |
| "One-line change, self-review is overkill" | A one-line diff gets the cheapest tier of review. Cheapness is why it is a gate and not a ceremony. |
| "I'll defer this P2, it's out of scope" | A deferral keeps the verdict off clean, and a review gate blocks on it. Cost the fix first. Inside the ticket's files, fix it; needing a new file or one outside the diff, stop and ask. Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call sites. |
| "One more round will get it clean" | Three is the cap. Stop and report what is left. |
| "The deferred count was wrong, I'll re-post it corrected" | Changed counts need a new run. A re-post can clear a known P0 with no code change. |
| "No branch protection here, so a red check doesn't matter" | Protection `none` moves the rule from GitHub to you. Never merge red. |
| "It's green, the hold is just a formality" | A §4 Merge holds entry is a manual step the repo needs before merging. Report it; the user merges. |

## Resume file

Written at Stage 0, appended at **every stage and gate boundary**: sessions are lost to network
drops regularly, and a file written once is useless for that.

**Path: `.claude/desk-ticket-<TICKET>.json`, in the working tree where the work is happening**:
inside the worktree when using one, otherwise the main checkout. Untracked.

**Exactly one file per ticket.** Before resuming, look for it across the main checkout *and* every
worktree (config §2 Primary repo root and Worktrees directory):

```bash
find <primary repo root> <worktrees dir> -maxdepth 3 -name 'desk-ticket-<TICKET>.json'
```

If more than one turns up, **stop and ask which is authoritative**: do not guess, and do not merge
them. Two files for one ticket means two sessions were working it, and picking the wrong one
resumes the wrong state.

**A resume file whose ticket is already done is stale: never resume from it.** Check the ticket's
status before trusting the file (§4 Done state; for a non-tracker ticket, the PR merged or the issue
closed). If it is done, say the file is spent, offer to delete it, and start fresh rather than
replaying finished work.

The file is removed when the ticket reaches §4 Done state (for a non-tracker ticket, when the PR merges), not
when the PR opens: `--tail` still needs it while the ticket sits in §4 Review state.

Records: ticket and type (or, for a non-tracker ticket, the key, its ticket file and what it was made from) · provisional vs committed lane,
with the Stage-2 evidence · worktree path · branch · base `<default>` SHA · dev-server port · locks
held · **the pending gate, the exact payload already shown, and which answer is awaited** · Jira
mutations already made (assignment, transition, comment marker) · the Stage-4b review: the head SHA
reviewed, its findings, the outcome and fixing commit against each, and the re-review result · PR
number and merge state · screenshot directory state.

On invocation, if the file exists, resume from it, and re-verify external state before trusting
it: does the branch still exist, is the ticket still in §4 In-progress state, are there new
comments, has the PR merged?

Jira writes must be idempotent across a resume. Put a stable `<TICKET>/desk-ticket` marker in
comments and search for it before posting, or a resumed run double-posts.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Writing the PR body from memory instead of invoking `desk-pr` | The PR can ship with no before/after table and a section the convention forbids. The sibling skills own their stages: `desk-pr` for Stage 7, `desk-jira` for Stage 8, `desk-review-response` for review replies. Recalling the gist of one is not following it: working 72 review comments "in its spirit" dropped the assess-first table and the reply voice. |
| Committing the lane at Stage 0 | A symptom patch plus a spec that codifies the wrong behaviour |
| Transitioning the ticket before Stage 2 | A crash leaves a claimed ticket with no branch |
| Handing the implementation to an expert subagent | It has none of the ticket, repro or code reading this session built, and cannot ask the user. Ask it for the design; write the code here |
| Assuming the §3b dev-server port is yours | Another session may own it; screenshots may be of another branch's code |
| Capturing evidence before Stage 4b | A confirmed finding means a code change, and every screenshot is then of the old build |
| `git stash` to stage the "before" shot after committing | It no-ops with nothing to stash, and stashes are shared across worktrees, so the "before" can be the fixed code. Use `git checkout HEAD~1 -- <path>` |
| Leaving a PR in draft once review is clean | A draft cannot merge; the merge is silently deferred |
| Reading another repo's config, or a config from memory | Every repo has its own; `desk-env where` is the only way to know which one applies here |
