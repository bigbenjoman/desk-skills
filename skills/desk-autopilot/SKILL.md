---
name: desk-autopilot
description: >-
  Use when the user hands over a batch of tickets in this repo to work unattended: "run ABC-1005
  ABC-1008 ABC-763", "work through these tickets", "do these issues while I'm out", "run epic
  ABC-900", "pick the batch back up". Tickets are keys matching the repo's ticket key pattern or, where the repo has no
  tracker, GitHub issue URLs or short descriptions. Drives each ticket in its own worktree in a
  detached headless worker and, where config allows, merges each PR as soon as it is green, parking
  anything that needs a human rather than guessing. Also when checking on a running batch, answering
  a parked question, or resuming after a park.
argument-hint: "<TICKET | issue URL> [<TICKET | issue URL> ...]"
---

# desk-autopilot

## Overview

Runs a **batch of tickets the user names**, each in its own worktree, each in a detached
`claude -p` worker running `desk-ticket`. Terminal state per ticket is a **merged PR** where config
§3 grants merging, otherwise a green, undrafted PR handed to the user: see *Merge each PR the
moment it goes green*. `desk-clearance` owns what outlives the batch.

This skill adds **no opinions about how a ticket is done**. `desk-ticket` decides that, and the
workers get the memory index and every `desk-*` skill exactly as an interactive session does.
What this adds is the batch: isolation, ordering, one round of questions up front, and a place for
parked work to wait. Workers see two deltas: `references/autopilot-worker-contract.md` (the core,
in every worker's system prompt; each stage's rules are a `references/worker-contract-*.md` file the
worker reads when it reaches that stage, and a task worker gets them all up front), and the
resource rules seeded into `batch-notes.md` from `references/batch-notes-header.md`. Both are
deltas: where one and a skill disagree, the skill wins.

**A worker never waits and never guesses.** Anything needing a human is asked once, and parked if
unanswered. `references/orchestrator-recovery.md` covers what happens after a park.

## Reference files: read each when you reach it

This file is the core: the config, the stages, the exit codes, asking, and the rules and red flags
every stage shares. The rest is in files under `references/`, beside this one, each needed only at
some stages or only in some batches. **When you reach a row's point, and its condition holds, read
the file the table names for it** before going on; once read, it binds exactly as this file does.
Where a section here or in a reference cites another in *italics* that its own file does not hold,
this table names the file that does.

| When | Sections | Read |
|---|---|---|
| Stage 0, before `init`, and Stage 0b's handshake | *Sharing the machine* | `references/sharing-the-machine.md` |
| Stage 0b, before starting the memory watch, and at the top of every pass run in the session | *Concurrency and memory* | `references/concurrency-and-memory.md` |
| Stage 0b, before starting the memory watch, only where config §2 "Running on WSL?" is `yes` | *On WSL* | `references/wsl-memory.md` |
| Stage 0, only when an argument is an epic; and at the epic's close-out | *An epic as a batch* · *Epic close-out* | `references/epic-batch.md` |
| Stage 0, only when the batch targets a feature branch (`set-batch base=`, or the queue shows a `base`) | *A batch that targets a feature branch* | `references/feature-branch.md` |
| Stage 1, before triage, when an argument is not a tracker key; and whenever a script refuses a key or a PR's branch is in question | *What a batch argument can be* | `references/batch-arguments.md` |
| When a worker parks on a step its settings refused, and before changing what a worker may run | *Workers cannot ask* · *A worker's settings are an allow-list* | `references/worker-grants.md` |
| Stage 1, only when `desk-design.mjs check` finds a ticket that links a Claude Design artifact | *A design in Claude Design* | `references/design-snapshot.md` |
| Stage 1b and Stage 2, only when triage puts a ticket in C or D; and when the user rules on a lane | *Why C and D get a second look* · *A lane is a proposal* | `references/lane-challenge.md` |
| Stage 2, for the merge order, Jira-linked holds and sizes; and whenever a pass reports `RELEASE DUE` or `STUCK` | *Order the batch by blast radius* · *Dependencies from Jira links* · *Size* | `references/order-and-holds.md` |
| Stage 2, only for an epic, and only when `plan-batch` prints `FEATURE MODE — on` or puts `feature_plan` in `needs_person` | *Feature mode* | `references/feature-mode.md` |
| Stage 2, before Stage 3's questions; and before any question, yours or a worker's, mid-run | *Ask or take* · *Try before asking* | `references/ask-or-take.md` |
| Stage 4, only when `run-by.mjs stage4` says `supervisor`; and in a session opened from a supervisor's handoff | *The supervisor* · *Handing a batch to the supervisor* | `references/supervisor.md` |
| Stage 4 in the session, before the first pass; and whenever a pass reports a stall, a budget or model hold, or a handoff | *Stalls and spend* | `references/stalls-and-spend.md` |
| Stage 4 in the session, before starting the merge driver; and Stage 7 | *Merge each PR the moment it goes green* · *Fix tries* | `references/merging.md` |
| Stage 4 in the session, before the first status table; and Stage 8 | *The status table* | `references/status-table.md` |
| Stage 6b; a pass's `health:`, `usage:` or `maintenance:` line that holds spawns; an idle batch with tickets parked; and answering from a digest | *The check-in digest* | `references/check-in-digest.md` |
| Only for a batch whose unit of work is not a ticket | *Task mode* | `references/task-mode.md` |
| Whenever you need a command's exact form | *Commands* | `references/commands.md` |

**A batch with no epic never needs `references/feature-mode.md`**: feature mode is only ever an
epic's. **A reference file you cannot read stops the batch.** If one a row sends you to is missing
or empty, stop and name it by its full path; never run that part of the batch from memory or from
an earlier copy of this skill. `/desk-update` reinstalls it.

## Read the config first

**Resolve and read this repo's config before Stage 0.**

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no  (exit 3 outside a repo)
```

Read the `CONFIG` file it prints. **`EXISTS=no` means stop**: say which slug was looked up and offer
`/desk-setup`. A `TODO` in a row the batch needs is a question, not a default. The scripts read the
same file and fail loudly on a missing identity or path rather than guessing; say which value is
missing and offer `/desk-setup`. **The config is per repo**: a batch in one repo never uses another
repo's answers, and the batch state lives per repo too (`<state>` below is
`~/.desk-autopilot/<slug>/`; `desk-env paths` prints it as `DESK_STATE`).

| Config | Used for |
|---|---|
| §0 "GitHub repo", "Default branch" | where PRs live; what every worktree branches from and rebases onto (`<default>` below) |
| §1 "GitHub handle", "Jira display name" | the merge driver's `--author`; `plan-batch`'s "unassigned or yours" test |
| §2 "Primary repo root", "Worktrees directory", "Running on WSL?", "Signed-in browser profile" | where worktrees go; which memory guidance applies; the image uploader |
| §3b "Autopilot worker concurrency", "Memory ceiling for parallel work (GB)", "Test worker cap under the test lock", "Autopilot per-worker budget (USD)", "Autopilot batch budget (USD)", "Preferred dev-server port", "Worker models", "Worker location", "Borrow idle workers", "Resume a killed worker (times)", "Usage pacing headroom (points)", "Maintenance window", "Maintenance drain limit (minutes)" | the ladder, the test cap, spend guards, the port workers must never take, each worker's model, where workers run (always locally for now), whether a batch may borrow idle machine slots, how often a worker a reboot or crash killed is resumed in its own session, how far 7-day usage may run ahead of an even weekly pace before new spawns hold, and when the weekly maintenance window drains, updates and restarts (with §3 `machine-reboot`) |
| §4 "Tracker", "Ticket key pattern", "Other work id patterns" | what a batch argument is, and what the scripts accept as a key |
| §4 "Required checks", "Advisory checks", "Known flaky checks", "Branch protection", "Merge method", "Repo merge settings" | what "green" means, and how the driver merges |
| §4 "Merge holds" | PRs a person merges: the driver and you never merge them |
| §4 "Checks workers can't fix" | checks the pass never sends back to a fix worker: a PR red only on one is stuck, with what fixes it (*Fix tries*) |
| §4 "Incidental paths" | files a worker may change outside its triaged scope unreported (unset: the lockfiles; test files always). The pass lists the rest per finished ticket under `out of triaged scope`, and an idle batch prints the `scope:` total. Report only: nothing parks on it |
| §4 "Local review command", "Clean review verdict" | what a worker runs at Stage 4b, and what "reviewed with no findings" reads as |
| §4 "Acceptance specs" | the spec directory and the command that runs some specs (`{ids}`); set, an epic on a batch base runs in feature mode (*Feature mode*); `none` keeps every epic an ordinary batch |
| §4 "Baseline checks" | `on`: a batch with a base records the base's Typecheck and Lint errors before it spawns, and its workers fail only on errors they add (*A batch that targets a feature branch*); unset or `off`: workers check as before |
| §4 "Local database", "Database URL variable", "Local services", "Vercel" | per-ticket databases (or blanked database variables); what workers must not rebuild; preview-build logs |
| §5 "Branch names" | the branch each worker's worktree is created on |
| §4 People | whose call a parked question is |

Every list row holds one backtick span per item, and a command item may name its directory as
`` `apps/api: uv run pytest` ``. Read lists with `desk-env list <id>` and commands with
`desk-env cmds <id>` (`DIR<TAB>CMD` per item); never split a value on commas and never turn a
command into `cd dir && …`.

The scripts look §3 up by its **key** and other rows by exact row name, through one map in
`desk-env.mjs`. A missing row, a blank or a `TODO` is `no`, never a neighbouring row's value.
`desk-env ids` prints every lookup and what it resolved to: run it at Stage 0 when a script refuses.
The budgets must be a positive number of USD or `none`/`off`/`no cap`; anything else ("25 USD")
refuses to spawn rather than reading as no cap.

What each §3 row lets the batch and its workers do. The deny rules a row that is not `yes` becomes,
and what a worker can never do whatever §3 says, are in `references/worker-grants.md`; a non-tracker
key drops the Jira rows (`references/batch-arguments.md`).

| §3 key | `yes` | anything else |
|---|---|---|
| `autopilot-workers` | `pass.mjs` spawns workers; `triage.sh` runs | `ask`: `triage.sh` still runs (read-only, foreground); confirm the batch at Stage 3, then run passes with `AUTOPILOT_USER_APPROVED=1`. `no`: neither runs; say so |
| `batch-base-push` | `pass.mjs` merges §0 Default branch into a batch base and pushes it before a pass that spawns; in feature mode it also pushes the empty commit a promotion PR needs, and the base gate syncs the base once more | unset or `ask`: ask once at Stage 3, then run passes with `AUTOPILOT_BASE_PUSH_APPROVED=1`. `no`: the base is not synced; the report says so, and a feature-mode batch spawns nothing |
| `git-push`, `pr-open`, `pr-edit` | worker pushes / opens the draft / edits the body | worker parks at that step with the branch or PR body; you ask, then do it |
| `pr-self-review-comment` | worker posts the §4 Local review command's report (`gh pr review`, `gh pr comment`) | worker parks with the report; you ask, then post it |
| `pr-reply` | a worker may reply with `gh pr comment`; resolving threads (GraphQL, `gh api`) is yours, since workers never get `gh api` whatever this row says | the worker parks with its replies; you post them or report the threads to the user |
| `pr-update-branch`, `ci-rerun` | worker may `gh pr update-branch` / `gh run rerun`; the merge driver reruns completed red runs | denied to the worker; the driver logs the red run and leaves it for you |
| `jira-comment`, `jira-transition`, `jira-create`, `jira-edit` (Tracker `jira` only) | worker posts / moves / creates / edits (`edit`, `labels`, `attach`) itself; `desk-jira link` and `unlink` are never a worker's | worker parks with `desk-jira`'s block; relay it verbatim (Stage 6c) |
| `codex-review` | workers get `codex`; the preflight asserts `CODEX=OK` (fails if codex is missing, unless `AUTOPILOT_ALLOW_NO_CODEX=1`) | `codex` is denied and the preflight asserts `CODEX=BLOCKED`; refutations are same-vendor, and where a required check demands a cross-vendor verdict those PRs cannot pass it: say so |
| `pr-images` | `pass.mjs` uploads automatically | `pass.mjs` reports the directory; ask, then run the uploader with `DESK_UPLOAD_APPROVED=1` |
| `read-figma` | workers get the Figma read tools | a ticket needing the frame parks |
| `pr-ready` | `pass.mjs` undrafts once the checks in Stage 7 hold | `ask`: ask once at Stage 3 for the whole batch, never once per PR: "Undraft this batch's PRs once each is clean and green?" Approved: `queue.mjs set-batch approved.undraft=true`, then each pass undrafts each PR without asking once the checks in Stage 7 hold, and notes the approval each time in `batch-notes.md`. Declined, or `no`: the pass reports the PR as ready to undraft |
| `pr-auto-merge` | not used in a batch: neither you nor the driver arms auto-merge, because the platform's idea of green is not the config's | — |
| `autopilot-merge` **and** `pr-merge-green` | the merge driver merges on green, pinned to the head | each `yes` or `ask`, and at least one `ask`: ask once at Stage 3 for the whole batch, never once per green PR: "Merge each of this batch's PRs once it is green?" Approved: `queue.mjs set-batch approved.merge=true`, then the merge driver (yours, or the supervisor's) merges each green PR without asking, under the same holds and `merge-feedback-first`, and notes each merge in `batch-notes.md`; the approval lasts this batch only, since `queue.mjs init` starts the next without it. Declined: `queue.mjs set-batch approved.merge=false`; the driver refuses to start (exit 1), and each pass reports a green PR as `READY TO MERGE`, or as `CHANGES REQUESTED` while `merge-feedback-first` holds it (under a supervisor, the next check-in digest lists it). Either one `no`: don't ask; the driver refuses to start and the pass reports green PRs the same way |
| `merge-feedback-first` | the driver skips a PR with `CHANGES_REQUESTED` or an unresolved thread, and disarms any auto-merge armed on it | the checks alone decide; feedback is still worked and reported |

Never widen a row because the batch would go faster. Offer `/desk-setup` instead.

## Your context must stay flat

You are a reader. Each pass re-derives state from disk and forgets it.

- Never read ticket code, a worker's transcript, or more than a log tail on failure.
- Never carry "ABC-940 needs X, ABC-1009 hit Y" between passes: that is the queue's job.
- If your context grows with the batch, you are doing the workers' work.

## Stages

| # | Stage | What happens |
|---|---|---|
| 0 | Claim | `queue.mjs init`. It refuses, before triage, when the repo's settings start sessions in `defaultMode` `dontAsk` ("defaultMode is dontAsk: the orchestrator cannot ask questions or run monitors"): stop, name the file it gives, and offer `/desk-setup` to remove it. `pass.mjs` takes an exclusive lock at `<state>/orchestrator.lock` and refuses to run if a live orchestrator holds it; a lock from a dead process is taken over automatically. Each pass also writes a heartbeat under `<state>/orchestrators/`, so another batch's `init` sees this one between passes (fresh = under 15 minutes). `init` backs up and re-seeds `batch-notes.md`: **check the `## MEMORY` heading is there**. See *Sharing the machine*. |
| 0b | Share the machine | `ListAgents`, handshake every live session (in any repo: the machine is shared even where the state is not), start the memory monitors. Before any worker spawns, not after. See *Sharing the machine*. |
| 1 | Triage | First write the ticket file for every non-tracker key (see *What a batch argument can be*); triage refuses one without it. Snapshot any Claude Design artifact a ticket links (*A design in Claude Design*). Run `git -C <§2 Primary repo root> fetch origin --quiet` **once**, so triage reads a current `origin/<default>`: triage is read-only and cannot fetch, and concurrent fetches race on the refs. Then `triage.sh` per ticket: read-only, no worktree. Returns lane, files, unknowns, `renders`, `ben_steps` (steps only the user can take, each with a proposed blocker ticket), and `prior_art`: any branch already touching those files, which changes the shape of a ticket more than its description does. |
| 1b | Challenge | Only for a ticket triage put in **C or D**. A second read-only pass re-derives the lane and either confirms it or downgrades to A, B or E. It can never upgrade, and a missing or malformed verdict leaves the first pass untouched. `AUTOPILOT_SKIP_CHALLENGE=1` turns it off. See *Why C and D get a second look*. |
| 2 | Plan | `plan-batch.mjs --json`: ownership, admission, collisions, and the question batch. Its exit and `needs_person` say what goes to the user before Stage 3 (*What a script's exit tells you*): a `lint` entry is a ticket a worker would park on, so fix the ticket or put the finding to the user at Stage 3 before it spawns. Report its merge order and any contradiction: see *Order the batch by blast radius*. Admit only work the batch can finish whole: a ticket that is doable except for a call *Ask or take* keeps (a missing design, copy or product fact, or a call with no recommendation) is a question, not a partial run. In feature mode, draft the spine ticket and the owner table here and re-plan (*Feature mode*). |
| 3 | Ask once | Every unknown across every ticket that *Ask or take* keeps as a question, in **one** round, **always via `AskUserQuestion`**, never as prose in the report. Include any §3 `ask` the batch will hit (headless workers, upload, merge, pushing to a batch base, undrafting), each as one question for the whole batch, and in feature mode the drafted spine and owner table for approval. Leave out what you take instead: a call outside the ask categories that has a recommendation, and any write §3 grants (a Jira comment, edit or transition under a `yes` row), which you make and then log. Wait. This is the whole promise. See *Asking*. |
| 4 | Run | **Who runs the batch is config §3b "Batches run by"**: run `run-by.mjs stage4` and follow its `by`. **At `supervisor`** (the row says `supervisor` and the supervisor is installed and loaded, or was just installed: the row is the consent, so never ask), hand the batch to it and start neither `/loop` nor a `nohup` merge driver: `queue.mjs set-batch supervised=true`, plus `approved.workers=true` and `approved.base_push=true` for exactly the Stage 3 approvals the user gave, and `approved.merge` as the user answered the merge question (*The supervisor*); then write the handoff and end the session (*Handing a batch to the supervisor*). **At `session`**, whatever is installed, run the batch here as below, and say its `note` once when it has one (an unset row: `/desk-setup` can set it). Exit 11 is an install that failed: run the batch here, and put its `error` and `retry` command in the report. Stages 0 to 3 run in this session whatever the row says. In the session: `pass.mjs --json`, self-paced via `/loop`; **each time you schedule the next pass, record it** with `queue.mjs next-pass +<the delay in seconds>`, or desk-q shows the batch as stopped once 15 minutes pass with no pass (the supervisor records its own). It preflights, spawns, harvests, reports, and its exit says what comes next (*What a script's exit tells you*). **Re-read the ladder at the top of every pass**: concurrency is a per-pass decision, not a batch setting. In the session, start the merge driver now, before the first worker finishes. |
| 5 | Answer | `answer.mjs <TICKET> "..."` records the answer in the ticket's briefing (and in the mailbox only if a worker is live and waiting) and lowers its open-question count, so a `triaged` ticket blocked on Stage 3 answers becomes eligible at the next pass. **It never un-parks**: resuming a `parked` ticket is your decision. A ticket whose worker parked: the worker has already exited, so verify the real state, then finish the parked step yourself or requeue it (`queue.mjs requeue <TICKET>`, details in `references/orchestrator-recovery.md`). **A lane C park, or a lane D one parked at triage on its design, is never requeued for a headless worker**: answering it does not make it one sitting. It goes to an interactive `desk-ticket` session, unless the user rules the lane itself wrong (*A lane is a proposal*). A lane D ticket whose canvas is saved under §2 Design canvases directory on the base, or in your snapshot, is not parked at all: `plan-batch` queues it, its worker builds from the canvas without stopping for agreement (`desk-ticket-routing.md` Lane D), and its PR's canvas table is where the design is agreed. A lane D park that names a Figma-only design or a canvas not on the base clears once the canvas is saved there and the ticket is triaged and planned again. A lane D ticket whose own worker parked is requeued like any other. For a *running* worker, `SendMessage` it. |
| 6 | Images | Where config §3 `pr-images` is `yes`, `pass.mjs` runs `upload-images.mjs` when a worker prints `AUTOPILOT_IMAGES:` naming a directory that holds a screenshot (a missing or empty one is no images: a finished ticket gets `images_uploaded=none` and nothing is reported): serialised, one PR at a time, never a worker. There is **one signed-in browser profile machine-wide** (config §2), so claim it from peer sessions by message first and release it the moment you are done. Only `0 placeholder(s) left` counts as uploaded. Placeholders left (uploader exit 4) or none matched (exit 3) sets `images_uploaded=partial`, saves the output to `<state>/images/<TICKET>.upload.log` and reports it under `WAITING ON YOU`: fix the body's `_drag <file>_` cells from the saved tags, do not re-upload (the assets already exist). |
| 6b | Notify | Push only what a pass's `push` lists, whatever its exit: send **one** `PushNotification` carrying the `text` of each entry whose `key` the previous pass's `push` did not already list (where §3b "Push notification when a batch needs you" is `yes`), then remember this pass's keys, every entry and not just the ones sent. A key that stays listed, such as `release-failed-<sha>` on every pass while main sits at that commit, is not sent again when a digest or health push goes out between passes. A key that drops out and comes back is sent again. If the notification fails, keep the keys from before so the next pass retries. A pass that refused or failed checked nothing, so it adds its own key to the remembered keys rather than replacing them. The supervisor follows the same rule. That is the check-in digest, once a §3b "Check-in times" slot has passed, a park reading `PRODUCTION BROKEN: …`, at once, a health check newly failing, and main's `tests` check failing on a desk-skills commit the auto-release would install. Everything else waiting on the person reaches them in the next digest (*The check-in digest*), so a park, a failure or a finished batch is shown in the session and never pushed on its own. |
| 6c | Relay a gate | When a worker parks on a write config §3 did not grant (most often the Jira comment), reproduce `desk-jira`'s block **verbatim**: `JIRA COMMENT — awaiting approval` (or `JIRA TICKET`/`EDIT`/`TRANSITION`), target, fields, then the exact body. Never paraphrase it. The user must read the exact string that is about to be public; a summary defeats the gate while looking like it honoured it. The same holds for a parked PR body or review report. |
| 7 | Merge | The moment a PR is green at its head, **merge it** (where granted, pinned to that head, never under a §4 Merge holds glob): do not collect PRs and merge at the end. See *Merge each PR the moment it goes green*. |
| 8 | Report | What is merged, what is parked and on whom, what is still running. **Emit the status table on every state change**, or at §3b "Orchestrator status table" `quiet` a line for what needs the person; the batch report itself always carries the full table: see *The status table*. |

Idle = every ticket merged, parked or failed, none held waiting on a merge, and in feature mode no
base gate waiting on a merge or running (`pass.mjs` exits 11 with `status` `idle` only then). Say so and stop; for an epic, run the close-out first. Do not invent work. **Never
transition a ticket to §4 Done state** (and with no tracker, never close an issue), and never treat
a triage "already fixed" as grounds to close one: a per-criterion check once overturned four of six
such verdicts.

### What a script's exit tells you

`pass.mjs`, `plan-batch.mjs`, `queue.mjs` and `answer.mjs` share one exit-code contract. **Decide
what to do next from the code and the fields below, never from the wording of the report**: the
report is for the person, and its wording changes.

| Exit | Means | Do |
|---|---|---|
| 0 | go on: it worked, and work is under way (a pass spawned something) | carry on with the stage; keep the loop going |
| 10 | nothing to do yet: every remaining ticket is running or held waiting on a merge, and nothing needs the person (`pass.mjs` only) | keep the loop going, nothing else |
| 11 | show the person: an error or refusal (the message says what they must do), a ticket that needs them, or a finished batch | show them, then follow `status` below |

Run every pass as `pass.mjs --json`. Its stdout is one object:

| Field | Holds |
|---|---|
| `status` | `go_on` (0), `nothing_yet` (10), `show_person` (11: the batch still has work under way), `idle` (11: the batch is finished, nothing left to run; stop the loop), `error` (11: the pass itself refused or failed) |
| `message` | the full report, for the person and the status table |
| `waiting` | one line per thing waiting on the person: everything under `WAITING ON YOU`, a stall only they can clear (a budget, a config row, a grant, a deliberate re-run), unanswered triage questions, and every failed ticket |
| `parked` | `{key, question}` for every ticket parked for its own reason (a hold is not one) |
| `notify` | true exactly when the exit is 11 |
| `push` | `{key, text}` for each thing to push now: the check-in digest (`digest:<slot>`) on the one pass on the machine that built it, each park whose question reads `PRODUCTION BROKEN` (`urgent:<slug>:<TICKET>`), the promotion question for a newly merged production-broken fix (`promotion:<slug>:<sha>:urgent`), each failing health check (`health:<slug>:<check>`, below), and main's failed `tests` check that blocks the desk-skills auto-release (`release-failed-<sha>`, *The weekly maintenance window*). Empty otherwise, on any exit |
| `release_due` | held tickets whose every blocker's PR has merged (under `waiting` too when no merge driver is running) |
| `stuck` | held tickets whose blocker can no longer merge on its own (under `waiting` too) |

On 11 from `pass.mjs`, put `waiting` and `parked` in front of the person, then keep the loop going
unless `status` is `idle` or `error`. Push only `push`, and only the entries the previous pass's
`push` did not already list (Stage 6b): the rest waits for the check-in. An `idle` batch with tickets still
parked, and no supervisor running, is not finished with: wake at each check-in time and run
`node ~/.claude/desk/bin/digest.mjs checkin`, pushing its `push` the same way, until nothing is parked.

Run `plan-batch.mjs --json` too. It exits 0 when every ticket can start with nothing to settle, and
11 when something needs the person before Stage 3, or on a refusal. Its stdout is one object:

| Field | Holds |
|---|---|
| `status` | `go_on` (0), `show_person` (11: the plan is made, and `needs_person` lists what to settle at Stage 3), `error` (11: it refused or failed; `message` says what to do) |
| `message` | the plan, for the person |
| `needs_person` | `{ticket, why, detail}`. `why` is `question` (ask it at Stage 3), `lint` (a blocking lint finding: fix the ticket or ask), `challenge_inconclusive` (the lane challenge could not read the code: ask the user to confirm or re-lane), `challenge_not_run` (the park is one unreviewed opinion: report it as that, never as settled), `parked` (lane C or D, size, or a dependency cycle: report it; a hold is not one), or `feature_plan` (on the epic: draft the spine and owner table, or put the draft to the person for approval; *Feature mode*) |
| `notify` | true exactly when the exit is 11 |

`queue.mjs` and `answer.mjs` exit 0 or 11 only, and say what to do on 11. `expand-parent.mjs` and
`desk-env` keep their own codes.

## Asking

Every question *Ask or take* keeps (a Stage 3 unknown, a mid-run park, a lane C or D ticket, a §3 `ask`) goes to the user
as an **`AskUserQuestion` carousel**, never as a numbered list in the report. One question per
decision, up to four per call; run another call for more, or hold the rest for the next round.

Each question carries a **recommended option first, labelled `(Recommended)`**, chosen by your own
judgement of the code you already have in hand. The remaining options are real alternatives. In each
`description` say what that choice costs: the migration it adds, the contract it touches, the
follow-up ticket it spawns. Defaults that need no real judgement can share one "accept these?"
question.

This does not soften *Never answer a parked question yourself*. The recommendation is a proposal the
user accepts or overrides; a park stays parked until they have chosen. A parked question is in an
ask category or has no recommendation, which is why it parked: it stays the user's. A question you
would have felt able to answer alone should have been settled at triage, or taken and logged, not
asked here.

Two have no recommendation to give: a value only the user holds (a design URL, an asset, a
credential), once a check you could make has not settled it (*Try before asking*): offer the routes
to it rather than inventing one; and a call that belongs to someone
else: name whose it is from config §4 People (product decisions: the product owner; design: the
designer, or the product owner where Designer is `none`; engineering and review: the code reviewer;
infra and security: that owner). Where a role is `you`, it is the user's own call and gets a
recommendation like any other.

## Rules that are yours, not the workers'

- **One orchestrator per repo.** Enforced by the lock. If it refuses and you are certain the holder
  is dead, delete the lock file: do not work around it.
- **Only tickets the user named**, and only ones unassigned or theirs (config §1 "Jira display
  name"; with no tracker, §1 GitHub handle on the issue): `plan-batch` enforces it, but a ticket can
  be reassigned mid-run.
- **Never answer a parked question yourself.** Recommending is not answering: see *Asking*.
- **Never spawn a worker by hand.** Every time that has been done, a bug the scripts already fix was
  reintroduced: a stale port, a missing permission. `pass.mjs` is the only spawner.
- **Never edit a running worker's worktree**, and never patch a spawn-path script mid-batch.
- **Never widen config §3** to unblock a worker. Park, ask, and let the user decide.

## Red flags — stop

- About to report a status table while a PR's required checks are green and it is unmerged (or, without the merge grant, un-reported)
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
- A worker quiet for 6+ passes: park it, do not wait
- Answered a parked ticket and assumed a worker will pick it up
- A ticket in the batch the user did not name (an epic names its expanded children; nothing else does)
- Reporting a lane-C/D park as settled when its challenge line says the pass did not run
- About to merge with branch protection `none` because GitHub would allow it
- About to merge a PR under a §4 Merge holds glob, or without `--match-head-commit`
- About to triage a non-tracker key without having written its ticket file
- About to rename a slug into a fake ticket key because a script refused it
- About to run an epic's children without having stated the expanded list and what was dropped
- About to transition, close or edit the epic itself
- About to release a held ticket before GitHub shows every blocker's PR merged
- About to re-run `plan-batch` with `AUTOPILOT_WRITE_QUEUE` mid-batch
- About to stop the loop while `pass.mjs` exits 10, or exits 11 with a `status` other than `idle` or `error`
- About to decide what to do next from a script's wording rather than its exit code and `--json` fields
- About to hold a ticket by hand-writing a park reason instead of `queue.mjs hold` (no `held_by`, so nothing keeps the batch alive or releases it)

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "The answer to this park is obvious" | Parks exist because the obvious answer was wrong before. |
| "I answered it, the next pass will resume it" | `pass.mjs` never spawns a parked ticket, and the worker exited long ago. Finish the step or requeue. |
| "I'll peek at the diff to check it's sane" | That is the worker's job, and it costs you the context discipline everything here rests on. |
| "It only needs a quick reindex to verify" | A shared local index is every other worker's index. |
| "The PR is fine without screenshots" | If it renders differently it is not finished. That is the most common reason one is handed back. |
| "I'll summarise the parked Jira text" | Then the user approves your summary, not the text. Reproduce `desk-jira`'s gate block verbatim. |
| "I'll just launch this one myself" | Every hand-launch so far reintroduced a fixed bug. |
| "It's `ask`, but they said yes last batch" | `ask` means this batch. Ask again, or offer `/desk-setup` to make it `yes`. |
| "They said yes in the other repo" | Config is per repo. This repo's §3 is the only answer that applies here. |
| "I'll merge them all once the batch is done" | Then each one conflicts with the last and pays a re-review. Merge on green, one at a time. |
| "Order does not matter, they are independent" | They are independent to *write* and ordered to *merge*. A rename landing late strands the files every later ticket added. |
| "Triage said D, so it is D" | Triage is one opinion and a D is terminal. Read the challenge line, and check its "new" things against `origin/<default>`. |
| "The description tells me the scope" | A ticket's scope changes the moment an open PR touching the same lines comes into view. That is what `prior_art` is for. |
| "The machine is quiet, one unlocked suite is fine" | The lock costs a wait. An OOM costs every worker, worktree, database and port at once. |
| "The footprint is past the ceiling, I should stop the batch" | Spikes are expected, and `vmmem` counts page cache. It is `avail` under the reclaim band for minutes with nothing running to explain it that means something. |
| "`free` says 2.5Gi used, there is loads of room" | `free`'s `used` excludes page cache. It has read 2.5Gi while the host sat past 16GB. Read `avail`. |
| "I'll ask whether to throttle" | Decide from the monitor. Report the decision and the number behind it; do not park it. |
| "That idle dev server is wasting 1.2GB" | It is probably a peer's. Ask over `SendMessage`; killing another session's server has already cost someone a ticket. |
| "No branch protection, so it can merge now" | Protection `none` means the rule is yours to enforce. Green is the config's definition, at the head you pin. |
| "The hold is for backend deploys and this change is tiny" | A §4 Merge holds entry is a person's merge whatever the size. Report it with the reason. |
| "It's only blocked on paper, release it" | The link is the user's statement of order. Release on the blocker's merge, or ask them to remove the link. |
| "All the children merged, so the epic is done" | Check the epic's own criteria (close-out), and leave its status to the user. |
| "The size says L but it looks small" | Then the size is wrong: say so and ask for it to be re-sized. An L is never run whole. |
