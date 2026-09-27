---
name: desk-autopilot
description: >-
  Use when the user hands over a batch of Studia tickets to work unattended — "run SV-1005
  SV-1008 SV-763", "work through these tickets", "do these while I'm out", "pick the batch back
  up". Drives each ticket in its own worktree in a detached headless worker and, where config
  allows, merges each PR as soon as it is green, parking anything that needs a human rather than
  guessing. Also when checking on a running batch, answering a parked question, or resuming after a park.
argument-hint: "SV-XXX [SV-YYY ...]"
---

# desk-autopilot

## Overview

Runs a **batch of tickets the user names**, each in its own worktree, each in a detached
`claude -p` worker running `desk-ticket`. Terminal state per ticket is a **merged PR** where config
§3 grants merging, otherwise a green, undrafted PR handed to the user — see *Merge each PR the
moment it goes green*. `desk-clearance` owns what outlives the batch.

This skill adds **no opinions about how a ticket is done**. `desk-ticket` decides that, and the
workers get the memory index and every `studia-*` skill exactly as an interactive session does.
What this adds is the batch: isolation, ordering, one round of questions up front, and a place for
parked work to wait. Workers see two deltas: `references/autopilot-worker-contract.md`, and the
resource rules seeded into `batch-notes.md` from `references/batch-notes-header.md`. Both are
deltas — where one and a skill disagree, the skill wins.

**A worker never waits and never guesses.** Anything needing a human is asked once, and parked if
unanswered. `references/orchestrator-recovery.md` covers what happens after a park.

## Read the config first

**Read `~/.claude/desk-config.md` before Stage 0.** The scripts read it too and fail loudly on a
missing identity or path rather than guessing; say which value is missing and offer `/desk-setup`.

| Config | Used for |
|---|---|
| §1 "GitHub handle", "Jira display name" | the merge driver's `--author`; `plan-batch`'s "unassigned or yours" test |
| §2 "Primary repo root", "Worktrees directory", "Running on WSL?", "Signed-in browser profile" | where worktrees go; which memory guidance applies; the image uploader |
| §3b "Autopilot worker concurrency", "Memory ceiling for parallel work (GB)", "Autopilot per-worker budget (USD)", "Autopilot batch budget (USD)", "Preferred dev-server port" | the ladder, spend guards, and the port workers must never take |

The scripts look §3 up by its **key** and §1, §2, §3b by exact row name, through one map in
`desk-env.mjs`. A missing row, a blank or a `TODO` is `no`, never a neighbouring row's value.
`node ~/.claude/desk/bin/desk-env.mjs ids` prints every lookup and what it resolved to — run it at
Stage 0 when a script refuses. The budgets must be a positive number of USD or `none`/`off`/`no cap`;
anything else ("25 USD") refuses to spawn rather than reading as no cap.

**Workers cannot ask, so §3 decides up front what they may do.** `worker-settings.mjs` (run by
`spawn-worker.sh`) turns every worker row below that is not `yes` into deny rules — by bare name, by
the absolute path `command -v` resolves, and in `git -C <dir> …` form — and tells the worker which
keys, as `CONFIG_DENIED: <key> (<setting>)`, so it parks with the exact payload instead of attempting.
Enforcement is the rule, not the wording — see the contract §2.

**These rules catch mistakes, not a deliberate workaround.** Git accepts bundled and abbreviated
flags (`-qf`, `--force-w`, `--delet`), which no pattern can list, and workers may run `node`,
`python3` and `bun`. A stray `--force` or a push through `git -C` is stopped; a worker set on getting
round the rules is not. The contract is what keeps a worker in bounds, so never widen a worker's
grants on the strength of the deny list.

| §3 key | `yes` | anything else |
|---|---|---|
| `autopilot-workers` | `pass.mjs` spawns workers; `triage.sh` runs | `ask`: `triage.sh` still runs (read-only, foreground); confirm the batch at Stage 3, then run passes with `AUTOPILOT_USER_APPROVED=1`. `no`: neither runs; say so |
| `git-push`, `pr-open`, `pr-edit` | worker pushes / opens the draft / edits the body | worker parks at that step with the branch or PR body; you ask, then do it |
| `pr-self-review-comment` | worker posts the `/pullbot` review (`gh pr review`, `gh pr comment`) | worker parks with the report; you ask, then post it |
| `pr-reply` | worker may write through `gh api` (explicit methods, graphql mutations, REST fields) | those `gh api` forms are denied |
| `pr-update-branch`, `ci-rerun` | worker may `gh pr update-branch` / `gh run rerun`; the merge driver reruns completed red runs | denied to the worker; the driver logs the red run and leaves it for you |
| `jira-comment`, `jira-transition`, `jira-create`, `jira-edit` | worker posts / moves / creates / edits (`edit`, `labels`, `attach`) itself | worker parks with `desk-jira`'s block; relay it verbatim (Stage 6c) |
| `codex-review` | workers get `codex`; the preflight asserts `CODEX=OK` (fails if codex is missing, unless `AUTOPILOT_ALLOW_NO_CODEX=1`) | `codex` is denied and the preflight asserts `CODEX=BLOCKED`; reviews are same-vendor and cannot pass the CI gate — say so |
| `pr-images` | `pass.mjs` uploads automatically | `pass.mjs` reports the directory; ask, then run the uploader with `DESK_UPLOAD_APPROVED=1` |
| `read-figma` | workers get the Figma read tools | a ticket needing the frame parks |
| `pr-ready`, `pr-auto-merge` | you undraft (and arm auto-merge) once the checks in Stage 7 hold | report the PR as ready to undraft |
| `autopilot-merge` **and** `pr-merge-green` | the merge driver merges on green (it arms `--auto` only where `pr-auto-merge` is `yes`) | the driver refuses to start (exit 1); report green PRs to the user |
| `merge-feedback-first` | the driver skips a PR with `CHANGES_REQUESTED` or an unresolved thread, and disarms its auto-merge | the gate alone decides; feedback is still worked and reported |

Never widen a row because the batch would go faster. Offer `/desk-setup` instead.

## Your context must stay flat

You are a reader. Each pass re-derives state from disk and forgets it.

- Never read ticket code, a worker's transcript, or more than a log tail on failure.
- Never carry "SV-940 needs X, SV-1009 hit Y" between passes — that is the queue's job.
- If your context grows with the batch, you are doing the workers' work.

## Stages

| # | Stage | What happens |
|---|---|---|
| 0 | Claim | `queue.mjs init`. `pass.mjs` takes an exclusive lock at `~/.desk-autopilot/orchestrator.lock` and refuses to run if a live orchestrator holds it; a lock from a dead process is taken over automatically. Each pass also writes a heartbeat under `~/.desk-autopilot/orchestrators/`, so another batch's `init` sees this one between passes (fresh = under 15 minutes). `init` backs up and re-seeds `batch-notes.md` — **check the `## MEMORY` heading is there**. See *Sharing the machine*. |
| 0b | Share the machine | `ListAgents`, handshake every live session, start the memory monitors. Before any worker spawns, not after. See *Sharing the machine*. |
| 1 | Triage | `triage.sh` per ticket: read-only, no worktree. Returns lane, files, unknowns, `renders`, and `prior_art` — any branch already touching those files, which changes the shape of a ticket more than its description does. |
| 1b | Challenge | Only for a ticket triage put in **C or D**. A second read-only pass re-derives the lane and either confirms it or downgrades to A, B or E. It can never upgrade, and a missing or malformed verdict leaves the first pass untouched. `AUTOPILOT_SKIP_CHALLENGE=1` turns it off. See *Why C and D get a second look*. |
| 2 | Plan | `plan-batch.mjs`: ownership, admission, collisions, and the question batch. Then **set the merge order yourself** — see *Order the batch by blast radius*. Admit only work the batch can finish whole: a ticket that is doable except for a design, copy or product call is a question, not a partial run. |
| 3 | Ask once | Every unknown across every ticket, in **one** round, **always via `AskUserQuestion`** — never as prose in the report. Include any §3 `ask` the batch will hit (headless workers, upload, merge). Wait. This is the whole promise. See *Asking*. |
| 4 | Run | `pass.mjs`, self-paced via `/loop`. It preflights, spawns, harvests, reports. **Re-read the ladder at the top of every pass** — concurrency is a per-pass decision, not a batch setting. Start the merge driver now, before the first worker finishes. |
| 5 | Answer | `answer.mjs SV-XXX "..."` records the answer in the briefing. **It does not resume a parked ticket** — `pass.mjs` only spawns `triaged`, and the worker has already exited. Finish the parked step yourself or requeue per `references/orchestrator-recovery.md`. For a *running* worker, `SendMessage` it. |
| 6 | Images | Where config §3 `pr-images` is `yes`, `pass.mjs` runs `upload-images.mjs` when a worker prints `AUTOPILOT_IMAGES:` — serialised, one PR at a time, never a worker. There is **one signed-in browser profile machine-wide**, so claim it from peer sessions by message first and release it the moment you are done. Only `0 placeholder(s) left` counts as uploaded. Placeholders left (uploader exit 4) or none matched (exit 3) sets `images_uploaded=partial`, saves the output to `~/.desk-autopilot/images/SV-XXX.upload.log` and reports it under `WAITING ON YOU`: fix the body's `_drag <file>_` cells from the saved tags, do not re-upload (the assets already exist). |
| 6b | Notify | When a pass reports `WAITING ON YOU` or `PARKED`, send **one** `PushNotification` covering everything that pass surfaced. Never one per park — they are coalesced deliberately. Say the ticket and the question in one line each. |
| 6c | Relay a gate | When a worker parks on a write config §3 did not grant — most often the Jira comment — reproduce `desk-jira`'s block **verbatim**: `JIRA COMMENT — awaiting approval` (or `JIRA TICKET`/`EDIT`/`TRANSITION`), target, fields, then the exact body. Never paraphrase it. The user must read the exact string that is about to be public; a summary defeats the gate while looking like it honoured it. |
| 7 | Merge | The moment a PR's gate is green, **merge it** (where granted) — do not collect PRs and merge at the end. See *Merge each PR the moment it goes green*. |
| 8 | Report | What is merged, what is parked and on whom, what is still running. **Emit the status table on every stage change** — see *The status table*. |

Idle = every ticket merged, parked or failed. Say so and stop. Do not invent work. **Never
transition a ticket to Done**, and never treat a triage "already fixed" as grounds to close one: a
per-criterion check once overturned four of six such verdicts.

## Order the batch by blast radius

`plan-batch` finds collisions; it does not decide sequence. **You do, at Stage 2, from the
`files_in_scope` triage already gave you** — and the order is a merge order, not just a spawn order.

**Largest blast radius first.** A ticket that *moves, renames or deletes* files must land before any
ticket that *edits* them. Rank by how much of the tree a ticket disturbs:

1. moves, renames, deletions of whole directories, and new shared packages
2. schema and migration changes
3. shared components, design-system primitives and i18n
4. ordinary single-surface work

The reason is asymmetric: a rename landing after an edit conflicts badly and git will not follow an
*added* file across it, so the edit's new files strand at the old path. The same two tickets in the
other order usually merge cleanly.

A relocation merged mid-batch re-breaks every remaining ticket that touches what it moved — a
conflict resolution and a re-review each, severed migrations, deleted files silently resurrected.
Merged first, it costs none of that.

**Say the order and why in the Stage 2 report**, and put it in the status table's Notes so a reader
can see a queue position was chosen rather than arbitrary. Where two tickets genuinely cannot be
ordered — each edits what the other moves — say so and merge the smaller one first, so only one of
them pays.

**Start the gates first, and hold a ticket back only for a real collision.** Count how many tickets
each one gates, directly and through other tickets. The biggest gate spawns in the first pass
alongside every independent ticket. Hold a ticket back only behind the predecessor it actually
shares files with; if it collides with two, hold it until the later of the two merges. A ticket with
no shared files is never held back, whatever order it was named in. **The user's named order is
spawn priority, not a merge chain**: if following it literally would idle a gate, say what that
costs and ask, because a named order built as a literal chain starts a gate late and idles every
ticket waiting on it.

`pass.mjs` spawns in `queue.json` key order, so pass gates to `plan-batch` first, and when a held
ticket is released move it to the front with `queue.mjs front <KEY>`, or it waits behind every
independent ticket. A released ticket's `collides_with` still blocks it while that worker runs, so
clear the entry too if you release it early.

**Colliding tickets are serial to the merge, not to the worker**: as soon as a PR is done it gets
merged, and then work starts on the next ticket. `pass.mjs` only holds a
collider back while the other one's *worker* is running. So chain them yourself: park each successor
with a `held by orchestrator: … starts once SV-XXX's PR merges` reason, and pass the chain to the
merge driver as `--deps`, which releases it (`state=triaged`, moved to the front) once that PR has
merged. Tickets that share no files run in parallel lanes up to the concurrency cap, and each lane
stays serial.

## Merge each PR the moment it goes green

**An open PR is not a finished ticket, and holding several open is what makes a batch expensive.**
Every merge moves `main`, and every PR still open has to absorb that move: a conflict to resolve, a
new head SHA, and — because the CI gate matches the pullbot verdict against the *exact* head — a
whole fresh review and CI run. The cost is quadratic in how many you hold: the last of a batch
carried to all-open-before-any-merged pays a conflict resolution and a re-review for each PR ahead
of it, none of which exist had each merged when it first went green.

**This section applies as written where config §3 `autopilot-merge` and `pr-merge-green` are both
`yes`.** Where they are not, do everything below except the merge itself: undraft (if `pr-ready` allows), keep
the gate green, and put each green PR in front of the user the moment it flips — the cost of holding
PRs open is the same, so say so rather than letting them queue.

**Start the merge driver at Stage 4, before the first worker finishes — do not merge off your own
turn cadence.** Merging tied to when a monitor happens to wake you is how a PR sits green and
unmerged: nothing undrafts, arms or retriggers it until the orchestrator's next turn.

```bash
nohup ~/.claude/desk/bin/merge-driver.sh --tickets "SV-1 SV-2 SV-3" --deps "SV-3:SV-1" \
  >> ~/.desk-autopilot/merge-driver.log 2>&1 &
```

It loops every ~2 minutes over the batch's **ready** (non-draft) PRs by config §1's handle, **one at
a time**: skips (and disarms) a PR with outstanding review feedback where `merge-feedback-first` is
`yes`, arms `--auto --squash` where `pr-auto-merge` is `yes`, merges outright when `🏁 CI gate` is
green, skips a `DIRTY` PR, and, where `ci-rerun` is `yes`, retriggers `gh run rerun <id> --failed`
only once that run has reached `completed`. It never undrafts. `--tickets` takes whitespace- or
comma-separated keys and refuses (exit 2) anything that is not `SV-<digits>`, and `--deps` anything
not `SV-3:SV-1,SV-2`. Only one driver runs at a time (`~/.desk-autopilot/merge-driver.lock.d`); a
second exits 1 naming the holder's pid. Two things it must get right or it makes the problem worse: **never retrigger a run that is
not `completed`** — per-PR `cancel-in-progress` kills the run in flight, and a loop that re-reads
too soon after a rerun sees the stale `completed` and fires again, starving the PR forever — and
**only one PR may be building at a time** (see the preview-build cap below).

- **Merge on the gate, not on the checks you like.** The ruleset's sole required context is
  `🏁 CI gate`; other red checks are advisory. Read it with `awk -F'\t'` — `gh pr checks` is
  tab-separated and the name column carries an emoji, so splitting on whitespace silently yields
  `CI` instead of the verdict and nothing ever merges.
- **Never bypass it.** `--admin` is not yours to use.
- **The review gate fails on a PR's first CI run when the review posts late.** Opening the PR
  triggers CI seconds before the worker posts its review. `🌿 Local Adversarial Code Review` polls
  for the verdict for about a minute, so a review posted inside that window passes the same run.
  Posting starts no run of its own: CI runs only on open, reopen and push. Otherwise confirm the
  verdict's `sha=` equals `headRefOid` and re-run the whole failed set once the run is `completed`.
  With auto-merge armed, clearing the gate is the merge.
- **A PR that has gone `DIRTY` merges nothing.** Resolve it, then expect the re-review — that is the
  cost this stage exists to avoid paying seven more times. A conflict in a generated docs page
  (`{/* GENERATED by`) is resolved by taking main's version and re-running only that generator.
- **Undraft only once the PR is done and reviewed with no findings**, and only where config §3
  `pr-ready` is `yes` (arm auto-merge only where `pr-auto-merge` is too), then do whatever is needed
  to merge it immediately. Done and reviewed means the pullbot verdict on the PR's **current**
  `headRefOid` reads `p0=0 p1=0 p2=0 deferred=0 gaps=0`, the screenshots are uploaded (or the body
  says nothing renders differently), and `mergeStateStatus` is not `DIRTY`. The CI review gate passes
  with gaps open, so a `gaps` count above 0 is a question for the user, not a merge — keep it draft,
  since the driver merges any ready PR that goes green. A clean verdict on a
  conflicted head is spent the moment the conflict is resolved. Workers are denied
  `gh pr ready`, so check these facts yourself, then `gh pr ready` and `gh pr merge --squash --auto`
  in the same breath. Undrafting earlier pings the reviewer before the evidence is in.
- **One preview build at a time. Two is already too many.** Vercel's builder OOMs them against each
  other — seven triggered together gave one `Ready` and six `Error` (exit 137), and **two**
  studia-web PRs opening a minute apart have killed *both* builds. Each
  studia-web PR triggers app, docs, portal and Storybook previews, so two PRs is four-plus concurrent
  builds. Stagger PR creation and serialise every retrigger. This, not review or CI, caps how fast a
  batch can merge — and it is what a red `🚀 Preview build` almost always means. Where config §3
  allows reading Vercel logs, read the build log before treating it as broken code:
  `vercel inspect --logs <url> --scope sophos-education-27386abb`, looking for exit 137 or
  "Out of Memory".

**Act, do not watch.** The failure this stage exists to prevent is a green PR sitting unmerged while
the orchestrator reports on it. If a PR can be merged, merge it before writing the next status
table; if a build is red and nothing is in flight, retrigger it. When asked why a batch is slow,
answer with the specific thing being waited on and what is already in flight against it.

## The status table

**Every stage change gets a table, not a sentence**, so the user can see each ticket and its state
at every stage. A prose line about the one ticket that moved makes the reader reconstruct the
other six from memory, and silence between spawn and PR reads as nothing happening.

Emit it whenever the status monitor fires with a real change — a stage advance, a spawn, a park, an
unpark, a PR landing. Not on memory jitter, and not on a pass that changed nothing.

| Ticket | State | Stage | Port | Notes |
|---|---|---|---|---|
| SV-1200 | 🟢 Running | 5/9 | 3001 | one line — the gate, blocker or decision that matters |
| SV-1208 | ⏳ Queued | — | — | its position when the order was set deliberately |
| SV-1166 | 🅿️ Parked | — | — | what unparks it |
| SV-1181 | ✅ PR #NNN | — | — | the PR number once it exists |

- **Every ticket in the batch, every time** — parked and queued rows included.
- **Mark what changed** (an arrow, a bold cell) so the delta is findable without diffing.
- **Carry `vmmem=` and `avail=`** with it, since the ladder decision is read from those two numbers.
- **Notes stay to one line.** The full park reason lives in the queue.

## Why C and D get a second look

Triage is one `claude -p` pass forming one opinion, and for A, B and E that is fine: the worker
commits its own lane at `desk-ticket` Stage 2 and demotes if it was wrong, so a bad guess costs
minutes. **C and D are different, because they are terminal here** — `plan-batch` parks them, no
worker ever runs, and the ticket sits until the user reads a question. A wrongly parked ticket
costs a whole batch cycle and looks exactly like a correctly parked one. So here
**C-or-D-when-really-A** is the expensive direction, and the challenge only ever runs downhill.

The over-escalations that have actually happened, all named in the challenge prompt:

- **A Figma frame read as lane D on its own.** Nearly every Studia UI ticket has one. A ticket
  triaged D on that basis can sit through a batch and turn out to be three files and one i18n key.
- **An unanswered question read as complexity.** Missing information belongs in `unknowns`.
- **`spans more than one sitting` (lane C) sized from the description rather than the code.** The most common
  one. Triage researches `prior_art` and then sizes the ticket as though it had found nothing. Where
  a ticket defines sequenced, independently-mergeable stages, only the first stage is what runs.

The challenge confirms unless it can name the trigger that does not fire, and doubt confirms. **The
one exception is a park on size alone**, where "describe it file by file" would make the trigger
unfalsifiable; there the test is whether the work is mechanical and bounded.

**A confirmed park can still be wrong, because both passes can share one over-estimate.** A park on
size CONFIRMED by counting new things to build can be lane A in a handful of files when every one has
an existing pattern on origin/main to copy. Before reporting any park on size,
check each thing the challenge calls "new" against origin/main and say what you found — report the
doubt, not the verdict. **Read the challenge line**: `plan-batch` prints `challenge CONFIRMED`, or
`! challenge did not run` — a single unreviewed opinion that must not be reported as settled.

**A lane is a proposal.** When the user says a park is wrong, re-lane with
`queue.mjs set <KEY> lane=A state=triaged` and, where the ticket is genuinely big, scope it in the
briefing so what runs really is one sitting.

## Asking

Every question — a Stage 3 unknown, a mid-run park, a lane C or D ticket, a §3 `ask` — goes to the user
as an **`AskUserQuestion` carousel**, never as a numbered list in the report. One question per
decision, up to four per call; run another call for more, or hold the rest for the next round.

Each question carries a **recommended option first, labelled `(Recommended)`**, chosen by your own
judgement of the code you already have in hand. The remaining options are real alternatives. In each
`description` say what that choice costs — the migration it adds, the contract it touches, the
follow-up ticket it spawns. Defaults that need no real judgement can share one "accept these?"
question.

This does not soften *Never answer a parked question yourself*. The recommendation is a proposal the
user accepts or overrides; a park stays parked until they have chosen. A question you would have felt
able to answer alone should have been settled at triage, not asked here.

Two have no recommendation to give: a value only the user holds (a Figma URL, an asset, a
credential) — offer the routes to it rather than inventing one; and a call that belongs to someone
else — name whose it is from config §4 (product decisions: the product owner; engineering and
review: the reviewer).

## Task mode — a batch that is not "implement these tickets"

`spawn-worker.sh` takes **`AUTOPILOT_TASK`**: a prompt for a *fresh* worker that replaces the default
"work the ticket with desk-ticket" instruction. `$TICKET`, `$WT` and `$PORT` are substituted into
it, so one task string serves the whole batch. `AUTOPILOT_RESUME` takes precedence, but it does not
work through `pass.mjs` — see `references/orchestrator-recovery.md`. Set `AUTOPILOT_TASK` once in
`pass.mjs`'s environment and every worker gets it; the worker contract's section 0 says a task
overrides the ticket-implementation stages.

Use it when the unit of work is not a ticket — a PR review sweep across open PRs is the worked
example: the queue comes from `gh pr list` rather than triage, and **Stages 1, 1b and 2 are skipped
entirely** because `plan-batch` would simply park everything. Stage 4 onward is unchanged:
`pass.mjs` is still the only spawner, and the ladder, the locks and the handshake all still apply.
It is also how a dead worker's half-finished worktree is picked up.

Raise `AUTOPILOT_BUDGET_USD` above the per-worker default when a task is longer than one ticket — a
review loop runs its finders several times, and the default exists to stop a runaway.

**A review sweep ends with a posted comment on every PR, and you verify it — the worker's word is
not evidence.** The loop is "review, fix, re-review until no P0/P1/P2, capped at 3 rounds", then
`/pullbot <n> --comment` **unconditionally**: a clean review still gets posted, because the
`<!-- pullbot:local -->` marker at the PR's current head is the only record the PR was reviewed. The
only exemptions are a PR that had already merged and a dry run. Do not take `posted=yes` from a
worker's `AUTOPILOT_DONE` line; re-derive it from GitHub every pass and re-queue any PR whose marker
is missing from its current head.

## Rules that are yours, not the workers'

- **One orchestrator.** Enforced by the lock. If it refuses and you are certain the holder is dead, delete the lock file — do not work around it.
- **Only tickets the user named**, and only ones unassigned or theirs (config §1 "Jira display name")
  — `plan-batch` enforces it, but a ticket can be reassigned mid-run.
- **Never answer a parked question yourself.** Recommending is not answering — see *Asking*.
- **Never spawn a worker by hand.** Every time that has been done, a bug the scripts already fix was
  reintroduced — a stale port, a missing permission. `pass.mjs` is the only spawner.
- **Never edit a running worker's worktree**, and never patch a spawn-path script mid-batch.
- **Never widen config §3** to unblock a worker. Park, ask, and let the user decide.

## Stalls and spend

Spend follows config §3b. Where "Autopilot batch budget (USD)" is `none`, leave `budget_usd` unset so
`pass.mjs` never stops spawning, and do not surface a running total as a finding. Where a cap is set,
`pass.mjs` stops spawning at it and says so. The per-worker budget is a runaway guard, not a cap on
asked-for work. Precedence: batch — the queue's `budget_usd`, `AUTOPILOT_BATCH_BUDGET_USD`, config,
`none`; per worker — `AUTOPILOT_BUDGET_USD`, config, `25`. A malformed value holds spawns (batch, under
`STALLED`) or fails the preflight (per worker); fix the value, never strip it.

A worker whose log has not grown for 6 passes is **stopped and parked**, freeing its slot. Log growth
alone can lie — a hung `codex exec` heartbeats into the log for hours — so on a batch that has gone
quiet, check the log tail's newest `tool_progress` `elapsed_time_seconds` too. Recovery for both is
in `references/orchestrator-recovery.md`.

## Concurrency and memory

Default **2**, cap **3** (config §3b "Autopilot worker concurrency" can change either), and it is
**re-decided every pass, not set once**. RAM binds before CPU, and the 5-hour and 7-day usage limits
are account-level, shared with the user's own sessions. Worker ports start **one above** config §3b
"Preferred dev-server port" (`AUTOPILOT_PORT_FLOOR` overrides), skipping any port another ticket holds
or anything bound. Each ticket gets its own database; Typesense cannot be isolated, so workers park
rather than reindex.

Count a worker at ~0.5GB idle and ~3GB in its heavy stages — `tsc`, lint and specs in its own
worktree, plus a dev server if it takes screenshots — and an uncapped Jest fan-out at ~10GB. Budget
against config §3b "Memory ceiling for parallel work (GB)", never against what the OS advertises.

**Two numbers, two questions. Using the wrong one has thrown a batch in both directions:**

| Question | Read |
|---|---|
| How big has the footprint grown? | `vmmem` — Linux `MemTotal - MemFree`; macOS total minus free pages |
| Is there room to start something? | `avail` — Linux `MemAvailable`; macOS free + inactive + purgeable |

`node ~/.claude/desk/bin/desk-env.mjs mem status` prints both plus total process RSS. They
diverge badly — by several GiB at the same instant — so **gate a spawn on `avail`
and judge health on `vmmem`**, using RSS to tell live work from page cache. `free`'s `used` column is
a third number, wrong for both: it excludes page cache.

**Spikes are fine. Sustained is the problem.** A Jest fan-out at the ceiling for ninety seconds is
the system working; the ceiling held five minutes or more with no suite or `tsc` running to explain
it is what destabilises the machine. Do not throttle on a spike — over-caution that slows the batch
is a failure too.

**The ladder, read at the top of every pass:**

| `avail` | Do |
|---|---|
| > 8 GiB | concurrency 2; go to 3 only if a slot sat idle a whole pass |
| 4–8 GiB | hold — finish what is running, spawn nothing new this pass |
| < 4 GiB | drop to 1; a worker mid-suite will drain, so wait a pass before touching anything |
| < 2 GiB **and** sustained | reclaim: kill an orphaned `next-server` or a stale `tsc` first, never a worker mid-commit, never a process another session owns |

Lowering is silent but **reported** — say which number caused it. Raising back needs the same
evidence. The ladder is what the "machine looks idle" red flag guards: a fan-out sized from the
guest figure can take the whole VM down and kill every agent mid-flight.
An OOM leaves a worker's worktree, database and port behind.

**Run the watch yourself — do not hand it back to the user.** Two `Monitor`s for the life of the
batch: the pass report (90s, change-only, carrying `vmmem=` and `avail=`), and a sustained-high watch
that fires only on the ceiling held 5 minutes with nothing heavy running to explain it. Killing a
runaway process is a call to make from the monitor, not a park.

**Jest ignores the cap unless it is on the command line**, so seed `--maxWorkers` into
`batch-notes.md` (the header does) and `SendMessage` any worker seen over it.

### On WSL (config §2 "Running on WSL?" = yes)

`free -h` and the guest's `MemTotal` report the `.wslconfig` grant, but VmmemWSL can only grow as far
as **Windows has free RAM**, and nothing in the guest can see that. On a 31.7GB host with ~13GB held
by Windows and a 24GB grant, the working ceiling was ~16GB, ~19GB on swap, and concurrency 4 tripped
host exhaustion within 15 minutes while guest `avail` still read 7.4GB, so the ladder alone said only
"hold". Run a third
`Monitor` on the host figure — Windows free under 3GB for 2 minutes:

```bash
powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB"
```

Before acting on an alert, split it: a large `Cached` with low `AnonPages` in `/proc/meminfo` is page
cache WSL returns lazily (`autoMemoryReclaim=gradual` in `.wslconfig` helps). If the host is low while
VmmemWSL is under the ceiling, the pressure is on the Windows side and lowering concurrency will not
fix it.

## Sharing the machine

Assume you are never alone: the user runs interactive sessions alongside you and often a second
batch, so coordinate, and do not run out of memory on spikes such as Jest runs or the PR image
upload. Four resources are contended machine-wide and each has cost a
run.

**Handshake at Stage 0b, before any worker spawns.** `ListAgents`, then one `SendMessage` per live
session stating your batch, worktrees, port range, the files your tickets touch, and your test-lock
and Jest cap — and asking the same four back. Re-send when a new session appears. What a peer says it
holds beats anything you can measure, and a peer's heads-up ("full suite in five minutes") is the
only warning before a 10GB spike.

| Resource | Protocol |
|---|---|
| **Test suites** | One at a time machine-wide, via `~/.claude/desk/bin/with-lock.sh test …` (Jest, Vitest, Playwright) and `with-lock.sh tsc …` (same lock). No timeout, no bypass; waiting is the feature. Two Vitest integration runs also collide on their per-worker schemas for the whole run, so announce integration runs to peers. |
| **GitHub PR image upload** | One signed-in browser profile, so it is exclusive. `pass.mjs` serialises it *within* your batch; across sessions claim it by message before `upload-images.mjs` runs and release it by message immediately after. Screenshot *capture* uses Playwright's own browser and `with-lock.sh browser`, and is safely concurrent — do not serialise the wrong one. Never delete the profile's `SingletonLock`. |
| **Ports** | Yours start above the user's dev port. Publish your range, treat a peer's as claimed, and never kill a server you did not start however idle it looks. |
| **Files** | Exchange diff surfaces at handshake. `plan-batch` finds collisions inside your batch only; the cross-batch one can only come from the peer. |

**Probe the lock, do not trust it.** Test it once at Stage 0 with
`~/.claude/desk/bin/with-lock.sh test true`. If workers report it refused, serialise Stage 4
yourself — one worker in a suite at a time — and say in the report that the lock is not covering them.

**The memory rules are seeded, not remembered.** `queue.mjs init` backs up
`~/.desk-autopilot/batch-notes.md`, resets it, and re-seeds `references/batch-notes-header.md` — so
the Jest cap and the lock survive an init. If another orchestrator is live, `init` keeps the file
instead of resetting it, because that batch's workers still read it. Check the `## MEMORY` heading is
there after `init`. The rules also live in the worker contract, which is never truncated.

## Commands

```bash
B=~/.claude/desk/bin
$B/triage.sh SV-XXX                       # read-only, no worktree
AUTOPILOT_WRITE_QUEUE=1 node $B/plan-batch.mjs SV-GATE SV-XXX SV-YYY   # gates first: arg order = spawn order
node $B/answer.mjs SV-XXX "<answer>"
node $B/pass.mjs                          # one pass; drive with /loop
node $B/queue.mjs render                  # status
node $B/queue.mjs front SV-XXX            # move a released ticket to the front of the spawn order
node $B/harvest.mjs ~/.desk-autopilot/logs/SV-XXX.log
AUTOPILOT_DRY_RUN=1 …                     # no push, no PR, no review post, no Jira writes
AUTOPILOT_USER_APPROVED=1 node $B/pass.mjs   # only when §3 autopilot-workers is `ask` and the user confirmed this batch
AUTOPILOT_ALLOW_NO_CODEX=1 node $B/pass.mjs  # codex-review is yes but codex is not installed: accept same-vendor reviews knowingly
nohup $B/merge-driver.sh --tickets "SV-1 SV-2" --deps "SV-2:SV-1" >> ~/.desk-autopilot/merge-driver.log 2>&1 &

# config
node $B/desk-env.mjs ids                # every §3 key and config row the scripts read, and its value
node $B/desk-env.mjs perm codex-review  # one permission: yes|ask|no|never|stop (missing/TODO -> no)
node $B/desk-env.mjs budget worker      # 25 | none; exit 4 if malformed

# resource management
node $B/desk-env.mjs mem status         # vmmem= avail= rss=
node $B/desk-env.mjs heavy              # suites, typechecks, dev servers actually running (never pgrep -f)
$B/with-lock.sh test true                 # probe the lock once
cat ~/.claude/skills/desk-autopilot/references/batch-notes-header.md >> ~/.desk-autopilot/batch-notes.md

# the two Monitors, started once at Stage 0b (change-only; the second fires on sustained only)
node $B/queue.mjs render | tail -n +2; node $B/desk-env.mjs mem status
[ "$(node $B/desk-env.mjs mem used | cut -d. -f1)" -ge "<§3b ceiling>" ] && [ -z "$(node $B/desk-env.mjs heavy)" ] && echo "SUSTAINED-HIGH: footprint over the ceiling with nothing running to explain it"

# apply the ladder — top-level field
node $B/queue.mjs set-batch concurrency=1
```

`pass.mjs` re-reads `concurrency` from the queue on every pass, so the ladder is applied by editing
that one field between passes — never by hand-spawning, and never by holding tickets out of the batch.

## Red flags — stop

- About to report a status table while a PR's gate is green and unmerged (or, without the merge grant, un-reported)
- About to hold a finished PR open "until the batch is done"
- About to read a worker's full log "just to check"
- About to answer a parked question with your own judgement, or to *act* on your own recommendation before the user picks it
- About to hand the user a list of questions as prose instead of an `AskUserQuestion` carousel
- About to spawn anything outside `pass.mjs`
- About to widen a config §3 row, or export `AUTOPILOT_USER_APPROVED` without having asked
- About to raise concurrency because the machine looks idle
- About to size a spawn from `free -h`, or from `vmmem` instead of `avail`
- About to throttle the batch on a ninety-second spike
- Spawning workers before the peer handshake, or after a new session appeared without re-handshaking
- Ran `queue.mjs init` and did not check the memory block is in `batch-notes.md`
- About to kill a port, dev server or process another session owns
- A worker quiet for 6+ passes — park it, do not wait
- Answered a parked ticket and assumed a worker will pick it up
- A ticket in the batch the user did not name
- Reporting a lane-C/D park as settled when its challenge line says the pass did not run

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "The answer to this park is obvious" | Parks exist because the obvious answer was wrong before. |
| "I answered it, the next pass will resume it" | `pass.mjs` never spawns a parked ticket, and the worker exited long ago. Finish the step or requeue. |
| "I'll peek at the diff to check it's sane" | That is the worker's job, and it costs you the context discipline everything here rests on. |
| "It only needs a quick reindex to verify" | The Typesense collections are every other worker's index. |
| "The PR is fine without screenshots" | If it renders differently it is not finished. That is the most common reason one is handed back. |
| "I'll summarise the parked Jira text" | Then the user approves your summary, not the text. Reproduce `desk-jira`'s gate block verbatim. |
| "I'll just launch this one myself" | Every hand-launch so far reintroduced a fixed bug. |
| "It's `ask`, but they said yes last batch" | `ask` means this batch. Ask again, or offer `/desk-setup` to make it `yes`. |
| "I'll merge them all once the batch is done" | Then each one conflicts with the last and pays a re-review. Merge on green, one at a time. |
| "Order does not matter, they are independent" | They are independent to *write* and ordered to *merge*. A rename landing late strands the files every later ticket added. |
| "Triage said D, so it is D" | Triage is one opinion and a D is terminal. Read the challenge line, and check its "new" things against main. |
| "The description tells me the scope" | A ticket's scope changes the moment an open PR touching the same lines comes into view. That is what `prior_art` is for. |
| "The machine is quiet, one unlocked suite is fine" | The lock costs a wait. An OOM costs every worker, worktree, database and port at once. |
| "The footprint is past the ceiling, I should stop the batch" | Spikes are expected. It is the ceiling held for minutes with nothing running to explain it that means something. |
| "`free` says 2.5Gi used, there is loads of room" | `free`'s `used` excludes page cache. It read 2.5Gi while the host sat past 16GB. Read `avail`. |
| "I'll ask whether to throttle" | Decide from the monitor. Report the decision and the number behind it; do not park it. |
| "That idle dev server is wasting 1.2GB" | It is probably a peer's. Ask over `SendMessage`; killing another session's server has already cost someone a ticket. |
