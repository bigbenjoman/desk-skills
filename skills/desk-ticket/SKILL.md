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

What `<TICKET>` can be (a tracker key, a work id, a GitHub issue or a plain description), and the
ticket file every non-tracker ticket gets, are in the Stage 0 file.

## Stages

Each stage's rules are in its own file under `references/`, beside this one. **At the start of each
stage, read that stage's file, and only that one**: the file opens with the stage's row of what
happens, then the detail. This file holds what every stage needs: the config, "Keep them posted",
the gates, the resume file, and the red flags, rationalizations and mistakes that are not one
stage's.

| # | Stage | Read at its start |
|---|---|---|
| 0 | Triage | `references/stage-0-triage.md` (and `references/design-canvas.md` when the ticket links a Claude Design artifact) |
| 1 | Branch | `references/stage-1-branch.md` |
| 2 | Understand | `references/stage-2-understand.md` |
| 3 | Implement | `references/stage-3-implement.md` |
| 4 | Verify | `references/stage-4-verify.md` |
| 4b | Self-review | `references/stage-4b-self-review.md` |
| 5 | Evidence | `references/stage-5-evidence.md` |
| 6 | Hygiene | `references/stage-6-hygiene.md` |
| 7 | PR | `references/stage-7-pr.md` |
| 8 | Jira | `references/stage-8-jira.md` |
| 9 | Cleanup | `references/stage-9-cleanup.md` |

**A stage file you cannot read stops the ticket.** If the file for the stage you are starting is
missing or empty, stop and name it by its full path; never work the stage from memory or from an
earlier copy of this skill. `/desk-update` reinstalls it.

**Repo facts live in the repo's own instructions.** The rules below that depend on a repo fact point
at the config row or the §5 instruction files that carry it, because this skill is the same in every
repo.

For lane predicates, costs, demotion triggers and how lanes C and D run: **read
`references/desk-ticket-routing.md`**.

`--tail` skips to Stage 4 using the resume file. Use it to pick up an interrupted run.

## Keep them posted

Report at **every stage boundary**: one or two lines, what finished, what's next. Say what you're
about to do before any step that takes more than a minute or two, and surface findings as you hit
them rather than saving them for the end. People run several sessions at once; going quiet is the
problem. Full rule in `references/desk-ticket-working-style.md`.

**Ask or take.** Before asking anything, sort it. Ask only in the five ask categories: money, legal
or regulatory, production data or credentials, customer copy where length means cost, and facts
only the user holds (gate 1's product data is one), or when you have no recommendation you can
defend. Everything else, a product, design, wording, review, engineering, scope or tracker call,
you take: do the recommended option without asking, say so in one line, and log it for the
check-in digest, with the PR once there is one:

```
node ~/.claude/desk/bin/decisions.mjs log <TICKET> '{"question": "…", "options": ["…", "…"], "chose": "…", "category": "review"}' [--pr <n>]
```

A category is one of `product`, `design`, `wording`, `review`, `engineering`, `scope` or `tracker`
(`desk-autopilot` *Ask or take* has the table); the CLI refuses an ask category. The PR body lists
each call under `Decisions taken` (`desk-pr`). Taking a call never widens §3: a write the config does
not grant is still asked first, and the gates below still hold.

**Decisions that stay questions go in a question carousel.** Ask with `AskUserQuestion`: one
question per decision, your pick first labelled `(Recommended)`, a one-line trade-off on each
option, rather than a prose list of defaults.

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

The `SELF-REVIEW` block (gate 7) and its rules are in the Stage 4b file; the `DIFF REVIEW` block
(gate 3) and the stray-commit check are in the Stage 7 file.

## Red flags — stop

Each stage file adds its own; these hold at every stage.

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
- Treating a user's "should we…?" as an instruction: it opens a discussion; answer with a proposal
- With Tracker `none`, about to comment on, label or close the GitHub issue

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
| Committing the lane at Stage 0 | A symptom patch plus a spec that codifies the wrong behaviour |
| Transitioning the ticket before Stage 2 | A crash leaves a claimed ticket with no branch |
| Reading another repo's config, or a config from memory | Every repo has its own; `desk-env where` is the only way to know which one applies here |
