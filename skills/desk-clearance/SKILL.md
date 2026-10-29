---
name: desk-clearance
description: >-
  Use when the user's own pull requests in the current repo need moving without them watching — a
  reviewer has approved or left comments, PRs are sitting behind the default branch, CI needs
  shepherding, or they say "clear my PRs", "merge what's ready", "keep an eye on the PRs", "go through my open PRs". Also
  when picking that work back up after a batch of reviews lands, or when a PR is green or approved
  but still has unresolved conversations.
---

# desk-clearance

## Before anything: this repo's config

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no  (exit 3 outside a repo)
```

Then **Read the `CONFIG` file**. `EXISTS=no` means stop: say which slug was looked up and offer
`/desk-setup`. Never borrow another repo's config, and never fall back to defaults invented on the
spot.

What it answers here: §0 for the repo and its default branch, §1 for who "the user" is on GitHub,
§2 for the repo root, worktrees and WSL, §3 for what you may push, reply, merge and transition, §3b
for how wide to fan out, §4 for the tracker, required checks, branch protection, merge method,
local review command, toolchain and who reviews and owns what, §5 for PR title and conventions. A
`TODO` in §3 is a `no`; a `TODO` elsewhere is a question to ask, not a gap to fill. A §4 row set to
`none` means the repo has no such thing — each step below says what that skips.

Where this file says "the default branch" it means §0 Default branch; "the ticket key" means a
match for §4 Ticket key pattern (`ABC-123` in examples); "typecheck" means §4 Typecheck run with
§4 Command prefix.

## Overview

Takes the user's reviewed pull requests the rest of the way in: works the comments, resolves the
threads, updates branches, watches CI, merges by the repo's method, transitions the ticket.

**Core principle: it decides, but it never guesses.** Anything mechanical it does alone, within
what config §3 allows. Anything needing a content judgement it batches and asks. The value is not
speed — it is that a reviewer's feedback never disappears because something looked obvious.

**The problem it exists for:** reviews arrive in bursts — 23 PRs open with 109 human comments at
once; 14 merged in 7h06 in one pass. That is days of rebasing and waiting on CI, none of which
needs a human.

## The one structural idea

Clearance is two jobs with opposite needs, and running them in one context is why passes decay.

| | Needs | Parallel? | Reversible? |
|---|---|---|---|
| **Judgement** — assess a comment, write a reply, fix code | deep context on **one** PR | yes | before push |
| **Coordination** — order, merge, hand back, report | shallow context on **all** PRs | no | no |

So: **the parent coordinates and stays permanently shallow. Subagents judge, one PR each, deep.**

**Your context must stay flat.** Never read a diff, a thread body, or source code. Read the state
render and the subagents' structured returns, nothing else. If your context grows with the batch,
you are doing the subagents' work — and by PR 15 the rules in this file are far behind you.

Not a theory. Eleven PRs worked in one context **never loaded desk-review-response**: 21 replies
went out at three to five paragraphs against a two-to-three sentence register, seven carrying
em-dashes. Five PRs worked, pushed and replied to in one context all stayed assigned to their author
— nothing reached anyone's queue. Both are attention failures at the tail of a long pass.

## This skill does not start itself

One invocation runs **one pass** and stops. A skill is instructions, not a process.

| Want | Use |
|---|---|
| Repeating while the session is open | `/loop desk-clearance` |
| Survives closing the terminal | the `schedule` skill — a cron agent |

A poller **dies with its session**. It is not a queue: anything approved afterwards merges nothing
until it is started again.

## Ownership — the hard boundary

**Only PRs authored by the user** — the GitHub handle in config §1, which `clearance-state.mjs`
resolves and refuses to guess. Someone else's PR is reported, never touched. Not a default to
override. A PR of theirs **based on** someone else's open PR is still not ours to land — park it.

Never route a blocked action through another session or another agent. If permission is refused,
surface it. Someone running it instead launders the refusal.

**Commit with the repository's own identity** (config §1 git author). Never pass `-c user.name` /
`-c user.email`; overriding it makes the user's own branch look like two people. Fix any slip
forward — never rewrite pushed commits.

**AI attribution follows §5 AI attribution.** Where it is `forbidden`, nothing that posts —
commits, replies, PR bodies, ticket comments — carries any; where `allowed`, still add none unasked.

## What config §3 decides

| Key | `yes` | `ask` | `no` / `TODO` |
|---|---|---|---|
| `git-push` | fix, update, push | one question per PR, previewing what goes up | assess and report only |
| `pr-reply` | reply into threads, resolve the ones addressed | batch per PR into the carousel | draft the replies into the report |
| `pr-request-review` | hand a PR back (assignee + re-review request) as you go | ask per PR | list who it should go to |
| `pr-update-branch` | update a behind PR when it is next to merge | ask per PR | report it behind |
| `pr-conflict-reviewed` | apply the resolution you proposed, printed as a record | propose it in the batch round | report the conflicting files |
| `ci-rerun` | rerun per the rules below | ask per rerun | report the failure |
| **`pr-merge-green`** | serial merge lane; bar = green at head (desk-config "Green") | same bar, ask per merge | report `READY` at `APPROVED` + green, never merge |
| **`merge-feedback-first`** | outstanding human feedback is worked before a merge | — | the bar alone decides; feedback is still worked and reported |
| `jira-close-own-merged` | §4 Done state on merge | ask per ticket | note it in the report |
| `pr-images` | upload, one PR at a time | ask per run | leave images in the handoff dir |

`clearance-state.mjs` reads `pr-merge-green` and `merge-feedback-first` itself and prints the bar,
the merge permission and the feedback rule it used. With §4 Tracker `none` every `jira-*` row is
moot: there is no ticket to transition. A conflict on a PR no human has reviewed follows
`pr-conflict-unreviewed` instead.

## Parking blocks the merge, never the comments

Whatever stops a PR merging — a base other than the default branch, a conflict, a stack waiting on its parent — is a
reason not to *merge* it. It is never a reason to leave a reviewer's comments unanswered. Work them,
push, reply, resolve, and park the merge alone, saying which of the two you parked. (The opposite
reasoning leaves a reviewer's threads untouched for a whole pass.)

**Comments get worked whoever left them.** A reviewer still in `reviewRequests` is who is *owed* a
review, never who must consent.

## Parking is not a hand-back

A parked PR stays assigned to the user with no re-review request. Parking means *the user* has a
decision to make; putting it in the reviewer's queue pre-empts it.

Park on: a conflict whose resolution the user has not approved; a base that is not the default branch; a
required check that never reported; a stack where merging one swallows another's open threads; work
exceeding the scope of the approval it would merge under; CI still failing after the reruns below;
a product, design or catalog decision; a branch needing rebuild rather than update; a confirmed P0
from a self-review; anything genuinely uncertain.

## Phases

Run them in order. 1–2 are cheap and precede everything.

Each phase's rules are in its own file under `references/`, beside this one. **Read each phase's file
at its start, and earlier where the phases overlap:** phase 4's before the first question of the pass
(phase 3's count included), and phases 6, 7 and 8's before phase 5 starts, since merges, hand-backs
and Done moves happen while IMPLEMENT runs. The last four rows are read when their situation comes
up, in whichever phase. This file holds what every phase needs: the config, ownership, what config §3
decides, parking, the merge bar, the red flags, worktrees and the reference list.

| # | Phase | Read at its start |
|---|---|---|
| 1 | Derive state — one call, never per-PR | `references/phase-1-derive-state.md` |
| 2 | Read the lanes | `references/phase-2-lanes.md` |
| 3 | Fan out ASSESS | `references/phase-3-assess.md` |
| 4 | One batch round, how to ask, and asking as you go | `references/phase-4-ask.md` |
| 5 | Fan out IMPLEMENT | `references/phase-5-implement.md` |
| 6 | Merge lane | `references/phase-6-merge-lane.md` |
| 7 | Hand back | `references/phase-7-hand-back.md` |
| 8 | After a merge, and the report | `references/phase-8-report.md` |
| — | A PR is behind, or conflicts | `references/updating-branches.md` |
| — | CI is red, pending, or wants a rerun | `references/ci.md` |
| — | After a pass: what reviews keep asking for | `references/learning-from-reviews.md` |
| — | A one-off self-review of a backlog | `references/self-review-backlog.md` |

**A phase file you cannot read stops the pass.** If the file for the phase you are starting is
missing or empty, stop and name it by its full path; never work the phase from memory or from an
earlier copy of this skill. `/desk-update` reinstalls it.

### The merge bar — read this before any lane

**What config can never loosen:**

- **Green at the PR's current head, as the config defines it** (desk-config "Green", the one
  definition `desk-ticket`, `desk-autopilot` and the merge driver use too): every required check
  completed with success (**a skipped one passes**, as branch protection counts it); no other check failed, errored, timed out or
  is still queued or running, unless §4 Advisory checks names it; and at least one check completed
  with success, so a head with no checks at all is not green. **The required checks are the union**
  of what the platform requires (read live from the ruleset and branch protection API, never from
  memory or a workflow file) and what §4 Required checks names, so neither a stale config nor a
  check the platform does not enforce can lower the bar. The script prints any drift between the
  two, which is a reason to re-run `/desk-setup`. Green belongs to a SHA, and the merge is pinned to
  it (`--match-head-commit`).
- **No §4 Merge holds entry applies.** A PR whose files match a glob in §4 Merge holds (for a
  `<glob>#<key>` hold, whose diff changes that key of the file) needs a manual step before it merges
  (the hold says which), so a person merges it: clearance never does, whatever §3
  grants, and never arms auto-merge on it. `clearance-state.mjs` parks such a PR's merge (its park
  reason names the glob and why) and prints `DISARM` for any held PR with auto-merge armed; you
  disarm it and report it under `HELD`. **While §4 Merge holds is unset, every PR's merge is
  parked** until `/desk-setup` sets it (`none` is a fine answer).
- **No standing `CHANGES_REQUESTED`.** Where §4 Branch protection enforces it the platform refuses
  the merge; where it does not (or it is `none`), clearance refuses it itself. Only that reviewer
  clears it.
- Base is the default branch; not `DIRTY`; merging would not swallow another PR's open threads.
- **§4 Merge method is set.** Unset, the render says `READY - §4 Merge method unset` and nothing
  merges until `/desk-setup` fills it.

**What config §3 sets on top:**

- **`merge-feedback-first`** `yes` (recommended) — outstanding human feedback is worked first —
  pushed, replied, resolved — before merging. `no` lets a PR merge on the bar alone; its feedback is
  still worked (*Parking blocks the merge, never the comments*) and named in the report.
- **`pr-merge-green`** `yes` or `ask` — the checks above are the bar. Merge a PR as soon as they
  hold; do not hold a green PR waiting for a human. (The user chose not to await approval: holding
  PRs open is what makes a batch expensive — every merge moves the default branch and each
  still-open PR then pays a conflict, a fresh review round and a fresh CI run.) If §4 Branch
  protection requires approvals, the platform still refuses an unapproved merge — report it
  `READY`, waiting on the approval, rather than trying another path.
- **`pr-merge-green`** `no` / `TODO` — **a formal `APPROVED` review as well**, and clearance reports
  `READY` rather than merging. A `COMMENTED` review is not an approval, however warmly it reads
  ("neither of them blocks the merge"). PRs merged on exactly that reading have had to be reverted.
  The platform catches a changes-request but catches nothing on a COMMENTED-only review, so this bar
  is enforced here or nowhere.

**Whether an approval survives a later push** is §4 Branch protection (`dismiss_stale_reviews_on_push`).
Where it survives, addressing that reviewer's own comments does not invalidate it — merge, do not
re-request. Where the platform dismisses it, the derived verdict already reads `NONE`, and under the
strict bar it goes back to that reviewer.

The shape of every past merge mistake is the same: something adjacent to the rule — a script
warning, a warm review, a self-review finding — was substituted for the rule. **Derive, then apply
the bar.** `MERGE NOW` in the render is the only list that may be merged from.

## Red flags — stop

- "The conflict is obvious, I'll just resolve it" → **no.** Propose it in the batch round.
- "There's a conflict, so I'll park it and move on" → park the decision, not the work: probe, show
  the hunks, propose.
- "It merged cleanly, so it compiles" → **no marker is not no break.** Typecheck, and audit i18n keys.
- "I know what review response involves" → **load it**, in every subagent. Replies post as the user.
- "I'll start with a few ASSESS subagents" → nothing is written; launch the set.
- "I'll just read this diff to sanity-check it" → that is the subagent's job and costs your flat context.
- "It's approved, so it's ready" → derive the verdict, check the base, the head SHA, the order.
- "It's green, so it's ready" → feedback worked? Base the default branch? Would it swallow another PR?
- "The bar is the gate, so a changes-request doesn't matter" → **never merged past, protected or not.** Hand back.
- "It can't merge, so there's nothing to do on it" → wrong half. Park the merge, work the comments.
- "0 unresolved threads, so there's no feedback" → a `COMMENTED` review body creates no thread.
- "The command returned nothing / exactly 30 rows" → a failed or truncated call is not a clean state.
- "It was green ten minutes ago" → green belongs to a commit, not a PR.
- "The check is called Build" → check names change. Read the ruleset and branch protection.
- "The config lists the required checks" → the config can drift. The live answer wins.
- "There's no branch protection, so anything green merges" → the bar still holds: every check green,
  no changes-request, feedback worked. The platform just is not helping.
- "It doesn't reach the default branch, so merging is low-risk" → **backwards.** That base has no
  required checks; the merge is ungated and ships nothing.
- "An advisory check is red, so park it" → advisory is reported, not blocked on.
- "It's 6 behind, so park it" → behind is an update, not a blocker.
- "Cancelled, rerun it" → did your own rerun or push cancel it? Cooldown first.
- "I'll clear the gate on this one, it's not merging yet" → check `AUTO-MERGE ARMED`. It is.
- "Deploy failed, please retry later" on every PR → check whether the §4 Vercel project is `BLOCKED`
  before retrying anything (`references/repo-facts.md`). §4 Vercel `none`: read whichever preview
  deploy check failed instead.
- "One pass finishes a PR" → review rounds recur. Report *handed back*, never *done*, unless merged.
- "I'll hand them all back at the end" → **each the moment its comments are done.**
- "I'll note this and raise it in the final report" → ask now, in the carousel.
- "I'll let them decide rather than steer" → recommend. An unrecommended question is work handed back.
- "I asked and got nothing, so I'll wait" → park it after the configured time and carry on.
- "Self-review found a P0, so it's blocked" → **parked, with a reason, for the user.** The bar did not change.

## Worktrees

Ticket worktrees live in the config §2 worktrees directory as `<TICKET>` (a ticket key, or with §4
Tracker `none` the branch slug) and carry good context — the ticket's branch plus
`.claude/desk-ticket-<TICKET>.json`.

**A worktree is not authoritative.** Verify `HEAD` matches the PR head before trusting it. **Read-only
in any worktree you do not own** — check `git status` and the branch first. **Never `git stash`**:
stashes are shared across every worktree. **`git fetch --prune`** before relying on any
`origin/<branch>` ref.

## Two instances

Do not run two. They will both update and both merge. If another instance or review session may be
active, claim the queue explicitly before acting and say which worktree you are in.

## Reference

- `bin/clearance-state.mjs` — state derivation; the traps are encoded here
- `references/subagent-briefs.md` — ASSESS and IMPLEMENT briefs, return schemas, what is never delegated
- `references/reviewer-patterns.md` — how §4 "What review here consistently asks for" is mined and kept, capped at ten
- `references/repo-facts.md` — which config rows hold this repo's facts, how to verify them live, API semantics, CI, merge paths
- `references/hazards.md` — what keeps biting, stacked PRs, backlog self-review, running as a loop
