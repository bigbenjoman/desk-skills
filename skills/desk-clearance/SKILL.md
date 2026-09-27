---
name: desk-clearance
description: >-
  Use when the user's own studia-web pull requests need moving without them watching — a reviewer
  has approved or left comments, PRs are sitting behind main, CI needs shepherding, or they say
  "clear my PRs", "merge what's ready", "keep an eye on the PRs", "go through my open PRs". Also
  when picking that work back up after a batch of reviews lands, or when a PR is green or approved
  but still has unresolved conversations.
---

# desk-clearance

## Overview

Takes the user's reviewed pull requests the rest of the way in: works the comments, resolves the
threads, updates branches, watches CI, squash-merges, transitions the ticket.

**Core principle: it decides, but it never guesses.** Anything mechanical it does alone, within
what config §3 allows. Anything needing a content judgement it batches and asks. The value is not
speed — it is that a reviewer's feedback never disappears because something looked obvious.

**The problem it exists for:** reviews arrive in bursts — 23 PRs open with 109 human comments at
once; 14 merged in 7h06 in one pass. That is days of rebasing and waiting on CI, none of which
needs a human.

**Read `~/.claude/desk-config.md` first.** §1 for who "the user" is on GitHub, §2 for the repo
root, worktrees and WSL, §3 for what you may push, reply, merge and transition, §3b for how wide
to fan out, §4 for who reviews and who owns what. A `TODO` in §3 is a `no`. If the file is missing,
say so and offer `/desk-setup` — never fall back to defaults invented on the spot.

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

**No AI attribution** (config §5).

## What config §3 decides

| Key | `yes` | `ask` | `no` / `TODO` |
|---|---|---|---|
| `git-push` | fix, update, push | one question per PR, previewing what goes up | assess and report only |
| `pr-reply` | reply into threads, resolve the ones addressed | batch per PR into the carousel | draft the replies into the report |
| `pr-request-review` | hand a PR back (assignee + re-review request) as you go | ask per PR | list who it should go to |
| `pr-update-branch` | update a behind PR when it is next to merge | ask per PR | report it behind |
| `pr-conflict-reviewed` | apply the resolution you proposed, printed as a record | propose it in the batch round | report the conflicting files |
| `ci-rerun` | rerun per the rules below | ask per rerun | report the failure |
| **`pr-merge-green`** | serial merge lane; bar = required checks green | same bar, ask per merge | report `READY` at `APPROVED` + green, never merge |
| **`merge-feedback-first`** | outstanding human feedback is worked before a merge | — | the bar alone decides; feedback is still worked and reported |
| `jira-close-own-merged` | `Done` on merge | ask per ticket | note it in the report |
| `pr-images` | upload, one PR at a time | ask per run | leave images in the handoff dir |

`clearance-state.mjs` reads `pr-merge-green` and `merge-feedback-first` itself and prints the bar,
the merge permission and the feedback rule it used. A conflict on a PR no human has reviewed follows
`pr-conflict-unreviewed` instead.

## Phases

Run them in order. 1–2 are cheap and precede everything.

### 1. Derive state — one call, never per-PR

```bash
node ~/.agents/skills/desk-clearance/bin/clearance-state.mjs derive
```

~8s for the whole set. It writes `~/.desk-clearance/state.json` and renders a table: lane per PR,
verdict, human feedback counts, required-check state, behind-count, park reasons, stack and
auto-merge flags, file overlap, merge order. Author comes from `--author` → `DESK_GH_HANDLE` →
config §1 → `gh api user`; repo from `--repo` → config §2. It dies rather than default either.

**The traps live in that script, not in your head** — verdict derived ignoring `COMMENTED`, bots
filtered out, required checks read from the ruleset and asserted positively, a non-`main` base
flagged, a foreign-authored base named, truncated lists refused. It exits non-zero on any failed
query. **A failed query is never a clean answer**: fix it or park. Never fall back to hand-rolled
`gh` calls with `2>/dev/null`, which is how an expired token becomes "no reviews found". A hand
call that disagrees with the script is wrong until proven otherwise (`gh api` stops at 30 rows
without saying so; always `--paginate`).

Re-derive after every merge, and at the start of every pass. Each derive keeps the last, so a loop
asks what moved:

```bash
node ~/.agents/skills/desk-clearance/bin/clearance-state.mjs diff
```

A change in verdict, feedback or threads is worth a pass. A lone gate or head change usually is
not, and `mergeable` never is — it flaps to `UNKNOWN` every time main moves.

### The merge bar — read this before any lane

**What config can never loosen:**

- **Every required check green at the PR's current head.** The required context is read from the
  ruleset API (`🏁 CI gate`), never from memory or `ci.yml`. Green belongs to a SHA.
- **No standing `CHANGES_REQUESTED`.** The ruleset refuses it; only that reviewer clears it.
- Base is `main`; not `DIRTY`; merging would not swallow another PR's open threads.

**What config §3 sets on top:**

- **`merge-feedback-first`** `yes` (recommended) — outstanding human feedback is worked first —
  pushed, replied, resolved — before merging. `no` lets a PR merge on the bar alone; its feedback is
  still worked (*Parking blocks the merge, never the comments*) and named in the report.
- **`pr-merge-green`** `yes` or `ask` — the checks above are the bar. Merge a PR as soon as they
  hold; do not hold a green PR waiting for a human. (Team practice is not to await approval: holding
  PRs open is what makes a batch expensive — every merge moves `main` and each still-open PR then
  pays a conflict, a fresh review round and a fresh CI run.)
- **`pr-merge-green`** `no` / `TODO` — **a formal `APPROVED` review as well**, and clearance reports
  `READY` rather than merging. A `COMMENTED` review is not an approval, however warmly it reads
  ("neither of them blocks the merge"). PRs merged on exactly that reading have had to be reverted.
  The platform catches a changes-request but catches nothing on a COMMENTED-only review, so this bar
  is enforced here or nowhere.

Either way, **an approval survives a later push** (`dismiss_stale_reviews_on_push: false`):
addressing that reviewer's own comments does not invalidate it — merge, do not re-request.

The shape of every past merge mistake is the same: something adjacent to the rule — a script
warning, a warm review, a self-review finding — was substituted for the rule. **Derive, then apply
the bar.** `MERGE NOW` in the render is the only list that may be merged from.

### 2. Read the lanes

The axis is **outstanding reviewer feedback**, never whether Request changes was clicked. A
reviewer who comments without a verdict still has to be answered. Outstanding means an unresolved
thread, or a review body or comment newer than the author's last reply or push.

| | Approved | Not approved |
|---|---|---|
| **Feedback outstanding** | **3A — interrupt, highest priority** | **3B — work it, then merge or hand back** |
| **Nothing outstanding** | 3C — merge lane | 3D — merge lane if the bar is the gate; else leave it |

3A first: no human is left in its path, so threads closed means merged in ~15 minutes. Under the
strict bar, 3B waits on the reviewer after hand-back; under the gate bar, 3B merges once worked
unless a `CHANGES_REQUESTED` stands, which goes back to that reviewer.

Do not chase a PR nobody has reviewed; under the strict bar, do not touch it.

### 3. Fan out ASSESS — read-only, all of them at once

One subagent per PR in the `WORK COMMENTS` list, brief from `references/subagent-briefs.md`.
Nothing is written and no local resource is held, so **launch the whole set in one go**, within
config §3b "Subagents that may run without asking" — above that, ask once for the pass, stating
the count. Trickling them out is not caution, it is the same pass taking hours longer.

**Every subagent loads desk-review-response and follows it, including `references/voice.md`.**
Not "works in its spirit" — loads it. Every reply posts publicly as the user. This is the single
most-skipped instruction in the skill: ignored across a whole pass because a pointer reads as a cross-reference rather than an order. It is an order.

They return a fixed schema: every comment tiered GREEN / AMBER / RED with evidence.

### 4. One batch round for what you already know

Collect every AMBER across every PR and put them to the user. GREEN proceeds unattended (within
§3); RED parks. At twenty-two PRs, a per-PR "assess, then stop" is twenty-two blocking gates, which
is why it got skipped wholesale rather than honoured.

**This batches the questions you have now. It is not a lid on asking later.**

### How to ask — always the carousel, never prose

**Every question goes through `AskUserQuestion`.** A question written as prose gets skimmed past; a
question with options gets answered in a click.

1. **Lead with a recommendation.** First option, `(Recommended)` in the label, chosen on your own
   reading of the code — not the safest-sounding one. Say why in the description.
2. **Options are real, distinct courses of action** with the consequence stated: *make the
   change* / *reply pushing back* / *ask the reviewer (config §4)*. Never a bare yes/no where a
   real choice exists, never an option you would not carry out.
3. **Detail goes in `preview`** — a drafted reply, two competing hunks. Previews render side by
   side, so the user compares artefacts instead of parsing a description.
4. **`header` is 12 characters**: `#724 auth` — the PR number is what people navigate by.

**Group by decision, not by comment.** Four PRs asking the same thing is one question. Page four at
a time, **highest-stakes first**, and send the next page as soon as the last is answered.

### Asking as you go

**After the batch round, ask the moment you hit something.** Holding a question to the end costs
the hours the user was available, and buries it in a long report.

Subagents reach you by `SendMessage` to `"main"`, which lands while they are still running. **They
send drafted options; you put it straight to the user as a carousel question.** Relay each as it
arrives — never accumulate them into a prose digest. Nothing travels back mid-run, so a subagent
that truly cannot continue returns `BLOCKED_ON` and you resume it with the answer.

**Ask, carry on, then park — never block, never wait forever.** Carry on with every other PR while
you wait. Park that one item once the user has gone quiet for config §3b "Park an unanswered
question after (minutes)" — but read the room: an answer two minutes ago means they are at their
desk. Say in the report that you asked and got no reply, and **re-surface anything unanswered** at
the end. AMBER is never decided for them.

### 5. Fan out IMPLEMENT — as many as the box allows

One subagent per PR, each in its own worktree (config §2 worktrees directory), doing only the GREEN
items plus the approved AMBER ones. They fix, verify, update if behind, push, reply, resolve. **Each
one loads desk-review-response too.**

**Do not use a number from this file.** `clearance-state.mjs capacity` derives it from available
memory, cores and load; `derive` prints it too. The binding constraint is `tsc` and specs. If it
says 2, something else is using the box and that is worth knowing first.

**Its figure is a snapshot.** Subtract agents already running at their real cost: build ~3G,
Chromium upload ~1G, an agent told to skip the build ~0.3G. Overshooting does not queue — it takes
the box down with every running agent; one overshoot lost five mid-flight.

**Make agents cheap when they can be.** One that only replies and resolves, reports on a diff, or
uploads images needs no `tsc`. Say **"do not run typecheck, lint or the spec suite"** in its brief;
left to its own judgement it runs the suite to be safe.

**The ceiling is config §3b "Memory ceiling for parallel work (GB)" on every platform** (unset: 16 on
WSL, physical RAM minus 8 elsewhere), budgeted against available memory, never `free`'s "used". On
WSL the guest cannot see what Windows lets VmmemWSL grow to.

**Never run two subagents on PRs that share a source file.** The render lists every overlapping
pair. Two branches editing one spec concurrently manufacture a conflict.

You share the box with autopilot workers and interactive sessions: put every Jest, Vitest or
Playwright run behind `~/.claude/desk/bin/with-lock.sh test …` with Jest at config §3b's cap (`4`),
and browser work behind `with-lock.sh browser …` — the same locks autopilot takes. It uses `flock`
where it exists (macOS: `brew install flock`) and a crash-safe `mkdir` lock otherwise.

Screenshots: subagents capture and print `CLEARANCE_IMAGES:`; **you** upload, one PR at a time —
the shared Chromium profile cannot be used concurrently.

### 6. Merge lane — serial, parent only, never delegated

Only if config §3 `pr-merge-green` is `yes` (or `ask`, answered). May run alongside phase 5.
Before each merge, from freshly derived state:

1. **Order.** Computed by the render, not eyeballed. A base relationship is not the only way one PR
   swallows another: a branch can contain another PR's commits while being based on a third. Anything
   under **DO NOT MERGE** would close another PR with open threads: **stop and ask.** The contained PR's code lands **and GitHub auto-closes it**, orphaning
   the reviewer's threads where nobody will answer them.
2. **Overlap.** If anything sharing a file merged since this PR's checks ran, update and get a fresh
   green first.
3. **Re-verify.** `OPEN`, not `DIRTY`, verdict unchanged, feedback still 0 (under `merge-feedback-first`), and **re-read the head
   SHA** — the required checks must be green on that SHA.
4. **Title and body.** The squash message is the PR title and body, so a stale description becomes
   permanent history. The title must be `type(scope): SV-123 description` — it is what Jira parses.
5. **Squash — the only method the ruleset allows.** Unstacked: `gh pr merge <n> --squash` (or leave
   armed auto-merge to fire). **Stacked** (the render says `STACKED`): every ordinary path refuses,
   including `--auto`; use `gh api -X PUT repos/Sophos-Education/studia-web/pulls/<n>/merge-async -f
   merge_method=squash`, which only *enqueues* — poll `.merged`. Merge stacks bottom-up.
6. **Confirm** `state == MERGED` and record the squash SHA.

**Armed auto-merge merges without you.** If the render says `AUTO-MERGE ARMED`, anything that turns
the gate green — a clean pullbot verdict, a rerun — merges the PR seconds later, unless it is
`DIRTY`. Treat clearing the gate on such a PR as the merge itself: apply the bar first.

**Merging deploys.** Every push to main fires a staging release running `db:migrate`, so a PR
carrying a migration *executes* it on merge, and back-to-back merges stack concurrent migrations —
the `P1002` advisory-lock flake. **Space merges out.**

**Never pile onto a broken main.** If main is red, stop merging and report. If a merge breaks main,
stop and report — a revert is a judgement call.

### 7. Hand back — as you go, then asserted at the end

Hand-back is for a PR that still needs a reviewer's action: a standing `CHANGES_REQUESTED` whose
comments you worked, and under the strict bar every worked 3B PR. **Do it the moment its comments
are addressed**, never batched: set the assignee to the reviewer, remove the user, request the
re-review. A queue that fills as the pass runs lets the reviewer start while the rest moves.

Identify the reviewer from **who has actually reviewed it**, never from `reviewRequests` — that list
is empty at exactly this moment, because submitting a review removes them. Add the Vercel, infra
and security owner (config §4) as reviewer on security-touching PRs, and tell them when a PR touches
infra (CDK, `packages/{chat,crm,moderation,shared-infrastructure*}`, `.github/workflows/**`) — a
drafted message, never a sent one. **GitHub only, never Jira.**

A PR that is merging is not handed back, it is merged. A PR parked on something that is nobody's
review to give stays with the user — see **Parking is not a hand-back**.

**At the end of the pass, re-query and assert it happened** for every PR worked: assignee is the
reviewer, the user removed, re-review requested. As a per-PR step alone this gets dropped, because
pushing and replying feel like completion. Both, not either.

### 8. After a merge, and the report

**A merged PR's ticket goes to `Done`** via **desk-jira**, as soon as the merge is confirmed —
subject to config §3 `jira-close-own-merged`; any other close is `jira-close` and waits. Merge and Done are one action in two systems;
splitting them is how a board ends up with ~20 merged tickets parked in `Review/QA`.
Two exceptions only: **a multi-part ticket whose other part is still open** (comment what landed,
transition on the last part), and **no SV ticket at all**.

**Report** stale worktrees and branches, never delete them: a worktree carries
`.claude/desk-ticket-SV-*.json`, which desk-ticket resumes from. **desk-cleanup** removes them.

### The report — one per pass, fixed shape

Reports that left the queue out made the user reconstruct it by hand — "why did you stop?", "so
nothing needed me, and all comments are closed?", counting who was waiting on whom — all of which
the state render already knows. So the report is a fixed shape, not a summary you compose:

```
CLEARANCE PASS <time> - <n> open PRs - bar: <gate|approved>
MERGED       #<n> SV-XXX <squash sha>
READY        #<n> SV-XXX  (only when §3 pr-merge-green is no or TODO)
HANDED BACK  #<n> SV-XXX -> <reviewer>            (re-review requested)
WORKED, NOT HANDED BACK  #<n> - <why>
PARKED       #<n> - <reason, and whether it is the merge or the comments that are parked>
WAITING ON   <person>: #<n> #<n>
NEEDS YOU    <one line each, or the exact words "nothing needed from you">
CI           <as of <sha>: PRs with a required check pending, or an advisory check red>
```

- **"Nothing needed from you" is said explicitly** when true. Its absence reads as an omission.
- **Never report a PR green while a required check is pending.** Give CI as of a named SHA, and
  **name every red advisory check** — the GitHub UI draws a red cross for those, so silence reads
  as a miss.

## Parking blocks the merge, never the comments

Whatever stops a PR merging — a non-`main` base, a conflict, a stack waiting on its parent — is a
reason not to *merge* it. It is never a reason to leave a reviewer's comments unanswered. Work them,
push, reply, resolve, and park the merge alone, saying which of the two you parked. (The opposite
reasoning leaves a reviewer's threads untouched for a whole pass.)

**Comments get worked whoever left them.** A reviewer still in `reviewRequests` is who is *owed* a
review, never who must consent.

## Parking is not a hand-back

A parked PR stays assigned to the user with no re-review request. Parking means *the user* has a
decision to make; putting it in the reviewer's queue pre-empts it.

Park on: a conflict whose resolution the user has not approved; a base that is not `main`; a
required check that never reported; a stack where merging one swallows another's open threads; work
exceeding the scope of the approval it would merge under; CI still failing after the reruns below;
a product, design or catalog decision; a branch needing rebuild rather than update; a confirmed P0
from a self-review; anything genuinely uncertain.

## Updating branches and conflicts

**Update only if actually behind, and only when next to merge** — it burns CI, moves the head (which
voids a pullbot verdict at the old SHA) and re-pings reviewers. Being behind never blocks a merge
(`strict_required_status_checks_policy: false`). Use `gh pr update-branch --rebase <n>`: server-side,
no local force-push, no half-rebased worktree. **A branch touching `.github/workflows/**` refuses
both update methods** without the `workflow` token scope — ask the user to run
`gh auth refresh -h github.com -s workflow`; do not route around it with a local push.

**On conflict: probe, show, then ask — never resolve one silently, and never park it bare.** At
§3 `pr-conflict-reviewed` `yes` the approved-in-advance resolution is still printed as a record. A
silent resolution can revert another ticket's fix — restoring a raw `<a>` where the design system
requires `StudiaLink` — with nothing failing. A one-line park is a handoff back to the user.
So, without touching any working tree:

```bash
git fetch --prune origin
git merge-tree --write-tree --name-only origin/main origin/<branch>
```

Put in the batch round: the conflicting files, the competing hunks, and **the resolution you propose
and why**. The user approves in a glance and a subagent applies it.

**After any merge of main into a branch — conflicted or not — the subagent runs `bun run
typecheck`.** A marker-free merge routinely does not compile (deleted params, a removed export, a
renamed component). Typecheck is not enough for i18n: audit every removed key under `src/i18n/messages/**` against `src/`. And on a branch that **renamed a
directory**, files main *added* land at the old path with no conflict — list the old path and
compare counts (`references/hazards.md`).

**Never rebuild a branch** — no `reset --hard`, no cherry-pick reconstruction, no force-push.

**Stacked PRs** have their own traps — `DIRTY` is about the base not `main`, a parent's squash makes
the child conflict and exposes the parent's ignored files, a parent rebase makes your ref stale.
Read `references/hazards.md#stacked-prs` before touching one.

## CI

**Green means every required context from the ruleset, asserted positively at the head SHA** — the
script does this. That gate's `needs:` carries every real job, including `🏷️ PR title` and `🌿 Local
Adversarial Code Review` (a clean pullbot verdict marker at *this* head), so a red gate means read
which upstream job failed. On failure, read it before rerunning. `references/repo-facts.md#ci`
covers the flakes worth a rerun, and the three ways a rerun makes things worse:

- **A rerun cancels the run in flight** (per-PR `cancel-in-progress`). Never retry faster than the
  slowest job — a 20-minute cooldown per PR.
- **Pick the run by head SHA and workflow name**, never list position — rerunning a stale head's run
  cancels the live one.
- **`gh run rerun` replays the original merge commit.** After main is fixed, close and reopen the PR
  for a fresh merge ref (head SHA unchanged, verdict still valid) — but first check the branch's own
  tree does not carry the break.

Advisory checks are reported, never blocked on. **e2e never gates a PR.**

## Learning from reviews

`references/reviewer-patterns.md` holds what reviews here ask for again and again, as pre-emptive
checks IMPLEMENT subagents run against their own diffs. Refresh after a pass, never after one PR:

```bash
node ~/.agents/skills/desk-clearance/bin/clearance-state.mjs corpus
```

**Promote at three distinct PRs. Cap at ten rows. A new row displaces the weakest.** Those three
rules are the whole defence against an append-only file nobody reads.

## Self-reviewing a backlog — one-off, not part of a pass

desk-ticket runs a local `/pullbot` review before a PR opens. This section is only for the user's
PRs that predate that, and only once. Everything is in `references/hazards.md#backlog-self-review`;
the two rules that matter:

- **`/pullbot --sweep` reviews everyone's open PRs.** Scope the queue to the config §1 handle, or
  the first command crosses the ownership boundary (on one sweep, 24 of 46 were other people's).
- **A finding is a park, never an amendment to the merge bar.** A confirmed P0 parks the merge with
  its `file:line`, and the user decides.

## Red flags — stop

- "The conflict is obvious, I'll just resolve it" → **no.** Propose it in the batch round.
- "There's a conflict, so I'll park it and move on" → park the decision, not the work: probe, show
  the hunks, propose.
- "It merged cleanly, so it compiles" → **no marker is not no break.** Typecheck, and audit i18n keys.
- "I know what review response involves" → **load it**, in every subagent. Replies post as the user.
- "I'll start with a few ASSESS subagents" → nothing is written; launch the set.
- "I'll just read this diff to sanity-check it" → that is the subagent's job and costs your flat context.
- "It's approved, so it's ready" → derive the verdict, check the base, the head SHA, the order.
- "It's green, so it's ready" → feedback worked? Base `main`? Would it swallow another PR?
- "The bar is the gate, so a changes-request doesn't matter" → **the ruleset refuses it.** Hand back.
- "It can't merge, so there's nothing to do on it" → wrong half. Park the merge, work the comments.
- "0 unresolved threads, so there's no feedback" → a `COMMENTED` review body creates no thread.
- "The command returned nothing / exactly 30 rows" → a failed or truncated call is not a clean state.
- "It was green ten minutes ago" → green belongs to a commit, not a PR.
- "The check is called Build" → check names change. Read the ruleset.
- "It doesn't reach `main`, so merging is low-risk" → **backwards.** That base has no ruleset; the
  merge is ungated and ships nothing.
- "An advisory check is red, so park it" → advisory is reported, not blocked on.
- "It's 6 behind main, so park it" → behind is an update, not a blocker.
- "Cancelled, rerun it" → did your own rerun or push cancel it? Cooldown first.
- "I'll clear the gate on this one, it's not merging yet" → check `AUTO-MERGE ARMED`. It is.
- "Deploy failed, please retry later" on every PR → check whether the Vercel project is `BLOCKED`
  before retrying anything (`references/repo-facts.md`).
- "One pass finishes a PR" → review rounds recur. Report *handed back*, never *done*, unless merged.
- "I'll hand them all back at the end" → **each the moment its comments are done.**
- "I'll note this and raise it in the final report" → ask now, in the carousel.
- "I'll let them decide rather than steer" → recommend. An unrecommended question is work handed back.
- "I asked and got nothing, so I'll wait" → park it after the configured time and carry on.
- "Self-review found a P0, so it's blocked" → **parked, with a reason, for the user.** The bar did not change.

## Worktrees

Ticket worktrees live in the config §2 worktrees directory as `SV-XXX` and carry good context — the
ticket's branch plus `.claude/desk-ticket-SV-*.json`.

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
- `references/reviewer-patterns.md` — what reviews keep asking for, capped at ten
- `references/repo-facts.md` — ruleset, API semantics, CI reality, merge paths
- `references/hazards.md` — what keeps biting, stacked PRs, backlog self-review, running as a loop
