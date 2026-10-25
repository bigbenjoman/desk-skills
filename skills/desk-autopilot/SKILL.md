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

### What a batch argument can be, and the ticket file

Every argument becomes one **key**, which names the queue entry, worktree, log and screenshot
directory. There are three kinds, the same ones `desk-ticket` accepts:

| Argument | Key | Where its text comes from |
|---|---|---|
| a tracker key matching §4 Ticket key pattern (Tracker `jira`) | the key as given | Jira, read by `triage.sh` with `desk-jira` |
| an **epic** key (Tracker `jira`) | never a key itself: it expands to its children (see *An epic as a batch*) | Jira |
| an id matching §4 Other work id patterns (any tracker), e.g. a planning-tool id `P1-M14-FIX-1` or `BUG-119-5` | the id exactly as given, case kept | the ticket file you write (below), never Jira |
| with Tracker `none`: a GitHub issue URL or `#<n>` on §0 GitHub repo | `issue-<n>` | the ticket file you write, from the issue |
| with Tracker `none`: a short description the user typed | a lowercase kebab slug of it, stated back at Stage 2 | the ticket file you write, from the user's words |

An argument that is none of these is refused: say so and ask; never reshape it to look like a key.

**For every key that is not a tracker key, write its ticket file before Stage 1 triage**, because
triage, the worker and the merge driver read the ticket from there and nowhere else. The file is
`$DESK_STATE/tickets/<KEY>.md` (`desk-env paths` prints `DESK_STATE`), written as:

```markdown
# <KEY>

Source: <one of: the user, in this conversation · GitHub issue <owner/name>#<n> · <path of the planning file>, entry <id>>

<the ticket text, verbatim: title, description, acceptance criteria>

## Comments
<for a GitHub issue, every comment in order with author and date; otherwise omit this section>
```

- **From the user**: their words verbatim, plus anything they added when you stated the slug back.
- **From a GitHub issue**: `gh issue view <n> --repo <§0 GitHub repo> --comments`, copied, not
  summarised. A later comment can settle or rule out what the description asks for.
- **From a planning file** (`.belmont/`, or wherever §5 Repo instructions say the repo plans work):
  find the entry for that id and copy the task text and its acceptance criteria verbatim, with the
  file's path in `Source:`. Two entries with the same id, or none, is a question for the user, not a
  pick.

Never write a ticket file for a tracker key (Jira is the source), and never edit one after triage:
answers go through `answer.mjs` into the ticket's briefing.

Everything Jira-shaped drops out for a non-tracker key: the Jira rows of the §3 table below do not
apply, workers skip `desk-ticket`'s Jira stages, and "unassigned or yours" means a GitHub issue with no
assignee or assigned to §1 GitHub handle (a description the user typed, or a planning entry, is
theirs by definition). **If an installed script refuses a key** (the merge driver's `--tickets`,
`plan-batch`, `triage.sh`), stop and say which script and which key: never reshape it to get past
the refusal.

**The branch is recorded, and the merge driver finds the PR by it.** Triage proposes a branch name
from §5 Branch names; `setup-worktree.sh` creates the worktree on it and the queue records it as the
ticket's `branch`. The merge driver takes a PR as the ticket's only when its head branch is **exactly**
that recorded branch and its base is §0 Default branch (or the batch's base: see *A batch that targets a feature branch*), so a promotion PR (default → production), a
PR for a longer id that starts with this one (`BUG-119-5` vs `BUG-119`) and a colleague's PR on the
same key are never merged by it. Never rename a worker's branch or open its PR from another one: the
driver will not see it.

**Workers cannot ask, so §3 decides up front what they may do.** `worker-settings.mjs` (run by
`spawn-worker.sh`) turns every worker row below that is not `yes` into deny rules (by bare name, by
the absolute path `command -v` resolves, and in `git -C <dir> …` form) and tells the worker which
keys, as `CONFIG_DENIED: <key> (<setting>)`, so it parks with the exact payload instead of attempting.
Enforcement is the rule, not the wording: see the contract §2.

**A worker's settings are an allow-list** (`worker-settings.mjs`, written to
`$DESK_STATE/workers/<TICKET>.settings.json`; a triage pass gets
`$DESK_STATE/workers/<TICKET>.triage.settings.json`, read-only). Both live outside the repo, and
`pass.mjs` creates worker worktrees with `setup-worktree.sh --for-worker`, so the worker gets **no
copy of your `.claude/settings.local.json`** and none of your own allows reach it. Whatever §3 says,
a worker cannot:

- push anything but the exact commands `git push [-u|--set-upstream] origin <its branch>` (and
  `git push --force-with-lease origin <its branch>` where §3 `git-force-with-lease` is `yes`); bare
  `git push` is refused;
- run `git config`, `git -c …`, `git -C` on anything but its own worktree (and there only the
  reads), git aliases or `git stash`;
- run `gh api` in any form, `gh alias`, `gh pr merge`, `gh pr ready`, or approve or request changes;
  so it cannot resolve review threads (it replies with `gh pr comment` under §3 `pr-reply`) and
  opens PRs only with a command beginning `gh pr create --draft` or
  `gh pr create --repo <§0 GitHub repo> --draft`;
- run the package manager beyond `install` with no arguments and the configured rows (no `add`,
  no `exec`/`dlx`/`x`, no `npx`/`bunx`/`uvx`), or the §4 Command prefix on its own;
- run `sed`, `awk`, `cp`, `mv`, `sort`, `uniq`, `xargs` or `tee`; `codex` other than
  `codex exec --sandbox read-only …` / `codex --version`; `psql` other than
  `docker exec <container> psql [-U postgres] -d <its database>`;
- run migrations or seeds (§4 Database migrate, Seed) unless it was given its own per-ticket database;
- write outside its worktree, except `$DESK_STATE/parks/<TICKET>.json`,
  `$DESK_STATE/handoffs/<TICKET>.json` and `$DESK_STATE/images/<TICKET>/**`. It cannot write or delete `answers/`: you clear a ticket's
  answer file once it has been read.

It may run `desk-env …` and the §4 toolchain rows, a directory item as
`~/.claude/desk/bin/with-lock.sh <test|tsc|browser|nolock> --cwd <dir> -- <cmd>`. **Database
variables**: in each worker's worktree every §4 Database URL variable is repointed at its own
per-ticket database or, when none was provisioned (§4 Local database `none`, or §3 `db-per-ticket`
not `yes`), **blanked**, so a worker never reaches a shared, staging or production database. A
worktree whose setup failed at any step is removed and the ticket parked with the setup log's
reason; a worker never runs in a half-made worktree.

**These rules catch mistakes, not every deliberate workaround.** Git accepts abbreviated flags that
no pattern can list, and the configured toolchain commands run code. The contract is what keeps a worker in
bounds, so never widen a worker's grants on the strength of the deny list.

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
| 1 | Triage | First write the ticket file for every non-tracker key (see *What a batch argument can be*); triage refuses one without it. Snapshot any Claude Design artifact a ticket links (*A design in Claude Design*). Run `git -C <§2 Primary repo root> fetch origin --quiet` **once**, so triage reads a current `origin/<default>`: triage is read-only and cannot fetch, and concurrent fetches race on the refs. Then `triage.sh` per ticket: read-only, no worktree. Returns lane, files, unknowns, `renders`, and `prior_art`: any branch already touching those files, which changes the shape of a ticket more than its description does. |
| 1b | Challenge | Only for a ticket triage put in **C or D**. A second read-only pass re-derives the lane and either confirms it or downgrades to A, B or E. It can never upgrade, and a missing or malformed verdict leaves the first pass untouched. `AUTOPILOT_SKIP_CHALLENGE=1` turns it off. See *Why C and D get a second look*. |
| 2 | Plan | `plan-batch.mjs --json`: ownership, admission, collisions, and the question batch. Its exit and `needs_person` say what goes to the user before Stage 3 (*What a script's exit tells you*): a `lint` entry is a ticket a worker would park on, so fix the ticket or put the finding to the user at Stage 3 before it spawns. Report its merge order and any contradiction: see *Order the batch by blast radius*. Admit only work the batch can finish whole: a ticket that is doable except for a call *Ask or take* keeps (a missing design, copy or product fact, or a call with no recommendation) is a question, not a partial run. In feature mode, draft the spine ticket and the owner table here and re-plan (*Feature mode*). |
| 3 | Ask once | Every unknown across every ticket that *Ask or take* keeps as a question, in **one** round, **always via `AskUserQuestion`**, never as prose in the report. Include any §3 `ask` the batch will hit (headless workers, upload, merge, pushing to a batch base, undrafting), each as one question for the whole batch, and in feature mode the drafted spine and owner table for approval. Leave out what you take instead: a call outside the ask categories that has a recommendation, and any write §3 grants (a Jira comment, edit or transition under a `yes` row), which you make and then log. Wait. This is the whole promise. See *Asking*. |
| 4 | Run | **Who runs the batch is config §3b "Batches run by"**: run `run-by.mjs stage4` and follow its `by`. **At `supervisor`** (the row says `supervisor` and the supervisor is installed and loaded, or was just installed: the row is the consent, so never ask), hand the batch to it and start neither `/loop` nor a `nohup` merge driver: `queue.mjs set-batch supervised=true`, plus `approved.workers=true` and `approved.base_push=true` for exactly the Stage 3 approvals the user gave, and `approved.merge` as the user answered the merge question (*The supervisor*); then write the handoff and end the session (*Handing a batch to the supervisor*). **At `session`**, whatever is installed, run the batch here as below, and say its `note` once when it has one (an unset row: `/desk-setup` can set it). Exit 11 is an install that failed: run the batch here, and put its `error` and `retry` command in the report. Stages 0 to 3 run in this session whatever the row says. In the session: `pass.mjs --json`, self-paced via `/loop`; **each time you schedule the next pass, record it** with `queue.mjs next-pass +<the delay in seconds>`, or desk-q shows the batch as stopped once 15 minutes pass with no pass (the supervisor records its own). It preflights, spawns, harvests, reports, and its exit says what comes next (*What a script's exit tells you*). **Re-read the ladder at the top of every pass**: concurrency is a per-pass decision, not a batch setting. In the session, start the merge driver now, before the first worker finishes. |
| 5 | Answer | `answer.mjs <TICKET> "..."` records the answer in the ticket's briefing (and in the mailbox only if a worker is live and waiting) and lowers its open-question count, so a `triaged` ticket blocked on Stage 3 answers becomes eligible at the next pass. **It never un-parks**: resuming a `parked` ticket is your decision. A ticket whose worker parked: the worker has already exited, so verify the real state, then finish the parked step yourself or requeue it (`queue.mjs requeue <TICKET>`, details in `references/orchestrator-recovery.md`). **A lane C or D park is never requeued for a headless worker**: answering it does not make it one sitting. It goes to an interactive `desk-ticket` session, unless the user rules the lane itself wrong (*A lane is a proposal*). For a *running* worker, `SendMessage` it. |
| 6 | Images | Where config §3 `pr-images` is `yes`, `pass.mjs` runs `upload-images.mjs` when a worker prints `AUTOPILOT_IMAGES:` naming a directory that holds a screenshot (a missing or empty one is no images: a finished ticket gets `images_uploaded=none` and nothing is reported): serialised, one PR at a time, never a worker. There is **one signed-in browser profile machine-wide** (config §2), so claim it from peer sessions by message first and release it the moment you are done. Only `0 placeholder(s) left` counts as uploaded. Placeholders left (uploader exit 4) or none matched (exit 3) sets `images_uploaded=partial`, saves the output to `<state>/images/<TICKET>.upload.log` and reports it under `WAITING ON YOU`: fix the body's `_drag <file>_` cells from the saved tags, do not re-upload (the assets already exist). |
| 6b | Notify | Push only what a pass's `push` lists, whatever its exit: send **one** `PushNotification` carrying the `text` of each entry whose `key` the last notification did not already carry (where §3b "Push notification when a batch needs you" is `yes`). That is the check-in digest, once a §3b "Check-in times" slot has passed, a park reading `PRODUCTION BROKEN: …`, at once, and a health check newly failing. Everything else waiting on the person reaches them in the next digest (*The check-in digest*), so a park, a failure or a finished batch is shown in the session and never pushed on its own. |
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
| `push` | `{key, text}` for each thing to push now: the check-in digest (`digest:<slot>`) on the one pass on the machine that built it, each park whose question reads `PRODUCTION BROKEN` (`urgent:<slug>:<TICKET>`), the promotion question for a newly merged production-broken fix (`promotion:<slug>:<sha>:urgent`), and each failing health check (`health:<slug>:<check>`, below). Empty otherwise, on any exit |
| `release_due` | held tickets whose every blocker's PR has merged (under `waiting` too when no merge driver is running) |
| `stuck` | held tickets whose blocker can no longer merge on its own (under `waiting` too) |

On 11 from `pass.mjs`, put `waiting` and `parked` in front of the person, then keep the loop going
unless `status` is `idle` or `error`. Push only `push`, and only the entries the last notification
did not already carry (Stage 6b): the rest waits for the check-in. An `idle` batch with tickets still
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

### The supervisor

`supervisor.mjs` runs passes from launchd with no model in the loop, so a batch keeps moving while no
session is open and after a reboot. `install` (run inside the repo, once per repo) writes the agent
`com.desk-skills.supervisor.<slug>`: a tick at login and every 3 minutes (`--interval <s>` to change
it). `uninstall` removes it, and no further passes run for that repo. `status` shows the agent, the
batch and the log's tail. Each tick, for a batch handed over at Stage 4:

- skips while a pass holds `<state>/orchestrator.lock`, or the previous tick's pass still runs, and
  logs the skip;
- runs `pass.mjs --json`, passing on only the approvals recorded with the batch (`approved.workers`
  as `AUTOPILOT_USER_APPROVED=1`, `approved.base_push` as `AUTOPILOT_BASE_PUSH_APPROVED=1`). It never
  grants one it was not given, so a batch whose `ask` was never answered spawns nothing and the pass
  says why;
- appends the report to `<state>/supervisor.log`;
- sends one macOS notification, titled with the repo, for the pass's `push` entries the last
  notification did not carry (the check-in digest, a production-broken park), or for a pass that
  refused or failed. This replaces Stage 6b while the supervisor runs;
- starts the merge driver for the queue's tickets (it reads their holds from the queue) while tickets
  are still to merge and no driver holds `<state>/merge-driver.lock.d`, where §3 `autopilot-merge` and
  `pr-merge-green` are both `yes` or the batch's `approved.merge` is `true`. Declined, it starts none,
  and each green PR the pass lists as `READY TO MERGE` goes to the next check-in digest;
- when a pass needs the person, starts the decider (`decider.mjs`): one fresh headless session per
  repo at a time, at low effort, given only that pass's report and `references/orchestrator-recovery.md`.
  It settles what those rules let you do without asking (a requeue of a lane A, B or E park that needs
  more agent work) and hands the rest to the check-in digest, which lists it (`<state>/handed.json`).
  A lane C or D park and anything needing a §3 row that is not `yes` go to the digest without a
  session; an item handed on and not answered since starts none, and an answer to one (`answer.mjs`,
  the digest's included) runs a pass again even in an idle batch. A decider still running after 15
  minutes is stopped and its items handed on as `decider timed out`. What each session cost, settled
  and handed on goes in the next report in `<state>/supervisor.log` and in the batch notes;
- once a pass reports the batch idle, runs nothing more for it until the queue changes (a new batch,
  or a ticket admitted or requeued into this one).

A batch not handed over gets no pass, so the supervisor never runs one before Stage 3 has asked; the
log says so once per batch.
Handing over does not hand over the person's side: answers (Stage 5), relaying a gate (Stage 6c),
recovery the decider handed on, and the close-out are still yours, read from `<state>/supervisor.log` and `queue.mjs render`
rather than a loop. A pass you run by hand while the supervisor's holds the lock refuses; run it again.

#### Handing a batch to the supervisor

Config §3b "Batches run by" says who runs a batch once Stage 3 has asked. `run-by.mjs stage4` reads
it: `session` (or unset, said once as a `note`) runs the batch in this session through `/loop`,
whether or not a supervisor is installed. `supervisor` hands the batch over, first installing the
supervisor without asking when `supervisor.mjs status` does not exit 0; an install that fails exits
11 and runs the batch in the session, and the report gives its `error` and `retry` command. Off
macOS the row reads as `session`, since the supervisor needs launchd.

Once the batch is handed over, the session does not stay open to watch it:

1. Write a handoff to the main checkout's `.handoffs/` (`<§2 Primary repo root>/.handoffs/<yyyy-mm-dd>.md`,
   `-2`, `-3` and on for a name already taken, as the handoff hook names them). It names the batch
   and its tickets, the approvals recorded with it, where its log is (`<state>/supervisor.log`, and
   `supervisor.mjs status` for the tail), and how to come back: a fresh session in the repo (a
   `/clear` there reads the latest handoff) asked to pick the batch up, or desk-q to follow it.
2. End the turn. Schedule no wakeup and start no `/loop`, no monitor and no merge driver: the
   supervisor runs the passes, starts the driver and brings both back after a reboot.

A session opened from that handoff shows the batch from `supervisor.mjs status` and `queue.mjs
render`, then deals only with what waits on the person: parks, answers (Stage 5), gates to relay
(Stage 6c), the items the decider handed on (`<state>/handed.json`) and the close-out. It runs no
pass of its own, and starts no loop or driver, while the batch stays handed over.

**Standing intake** keeps the supervisor fed between sessions. Where config §3b "Intake query" names
a Jira query and §3 `autopilot-workers` is `yes`, each tick runs `intake.mjs` first, which searches
at most every 15 minutes. Each new ticket the query finds is triaged once (`triage.sh`, three a
run, the rest the next) and admitted (`queue.mjs admit <KEY> --by intake`) with no Stage 3 plan
approval. The ticket is held behind any blocker in the batch, and the tick's report in
`<state>/supervisor.log` says `admitted <KEY> by intake`. With no batch, or one whose tickets are
all done with no PR open, it starts one (`standing-<time>`), already handed over. A batch with a
failed ticket, or on a base, is left alone. The search reads one page of
100, and a full page is reported every time. A lane C or D ticket goes to the check-in digest instead,
as does a blocking lint finding, open triage questions, size L or XL, or a blocker that is not done
and not in the batch: each is listed with the reason, never asked. Once the ticket is fixed,
`intake.mjs forget <KEY>` lets the next intake try it again. A batch still being planned in a
session, an empty one just made by `queue.mjs init` included, gets nothing until it is handed over. With the row unset or `none`, no intake runs. The
register is `<state>/intake.json`. Feature-mode epics are never taken in this way: they keep their
spine and owner-table approval.

## Order the batch by blast radius

`plan-batch` sets the merge order: triage records each ticket's `change_kind` (`relocate`, `schema`,
`shared` or `surface`), and the plan's `MERGE ORDER` section lists the admitted tickets largest blast
radius first, each with its kind and why. Two tickets that share files are chained, the larger blast
radius first (two of a kind: the smaller first, then the order named), as holds in the queue and
entries in the `--deps` it prints, which already carries the chain; tickets that share no files are
never chained. Jira Blocks links win over the kinds, and `CONTRADICTIONS` names each place they
disagree. **Say the order in the Stage 2 report** and put it in the status table's Notes; a
contradiction is worth one line to the user, since the link may be stale.

**The user's named order is spawn priority, not a merge chain**: `plan-batch` seeds the queue
blockers first and otherwise in the order named, and `pass.mjs` spawns in queue order, so pass the
tickets that gate the most others first. If the user asks for a literal chain that would idle a gate,
say what that costs and ask. A released ticket's `collides_with` still
blocks it while that worker runs, so clear the entry too if you release it early. A ticket added
mid-batch (`queue.mjs admit`) is not chained for you: hold it with `queue.mjs hold <SUCCESSOR>
<TICKET>` behind any ticket it shares files with.

## An epic as a batch

A large feature runs as an epic: one key whose children are the tickets. **Expand it at Stage 0,
before triage**, and never triage, build, transition or edit the epic itself:

```bash
node ~/.claude/desk/bin/expand-parent.mjs ABC-900   # the batch keys on stdout, the report on stderr
node ~/.claude/desk/bin/queue.mjs set-batch epic=ABC-900
```

- It keeps the epic's children that are this repo's keys and not started, in Jira rank order. A
  child story that has open subtasks is replaced by them (one level), **whether the story itself is
  To Do or In Progress**, and its Blocks links pass to them (`<state>/expansion.json`, read by
  `plan-batch`). Done children are dropped; **in-progress children are dropped** too (one may
  already have a PR), and so is an In Progress story with no open subtask: include one only if the
  user names it. The subtasks of a story are read before its own status is, because an In Progress
  story is where open subtasks usually sit, and dropping it first made them vanish unreported.
- Exit 4 means the key is not an epic: run it as an ordinary ticket. A story runs as its subtasks
  only when the user asks for exactly that (`--subtasks`); a bug or story named on its own with QA
  or checklist subtasks runs as itself, as it always has. Exit 3: nothing open under it; say so.
- **State the expanded list and every drop with its reason in the Stage 2 report.** A child the
  user named alongside the epic is one key, not two.
- **Half an epic on the default branch: ask now, at Stage 0, before triage.** With no batch base,
  each child merges to §0 Default branch as it goes green, so production carries a half-built feature
  until the last one lands. Ask this one question straight after expansion (an `AskUserQuestion`,
  recommending `set-batch base=<feature branch>` unless each child is invisible or flagged until the
  feature is complete), because the base must be set before triage reads prior art against it
  (*A batch that targets a feature branch*). Everything else waits for Stage 3.
- Triage reads the epic's description for context; each child's own criteria are its scope.
- Tickets filed during the batch (an L split into children, a close-out follow-up) are written in
  desk-jira's `references/ticket-template.md` layout for their type, each child with its own
  criteria and its dependencies as Blocks links, and join the batch one at a time: fetch as at Stage 1, `triage.sh <KEY>`, then `queue.mjs admit <KEY>` (and `queue.mjs hold` if it is blocked by a
  ticket in the batch), or they wait for the next batch.

### Dependencies from Jira links

`triage.sh` records each ticket's "is blocked by" (Blocks) links and size from Jira, and
`plan-batch` acts on them. Only Blocks is honoured; it reports any other link type it ignored.

| Blocker | What `plan-batch` does |
|---|---|
| in the batch, admitted | holds the successor: parked `held by orchestrator: blocked by … (Jira link)`, `held_by` set, and an entry in the `--deps` it prints |
| outside the batch and done | nothing (noted) |
| outside the batch and not done; in the batch but parked or someone else's; or links that could not be read | a question on the successor, asked at Stage 3 like any unknown |
| on a cycle | parks every ticket on it: the links need fixing |

A ticket parked for its lane (C, D) or its size (L, XL) is **never held and never in `--deps`**:
those parks win, so a release can never send one to a headless worker. `plan-batch` seeds the queue
blockers first, and its `--deps` already carries the merge chain for tickets that share files (*Order
the batch by blast radius*): pass it to the merge driver as it stands.

**A held ticket is in flight, not idle.** While every blocker is still on its way (running, waiting
to spawn, or done with an open PR), `pass.mjs` reports it under `WAITING ON MERGE` and never exits
with `status` `idle`: keep the loop going. Two states come to you as an exit 11, in `release_due` or
`stuck` and under `waiting`:

- **RELEASE DUE**: every blocker's PR has merged. The merge driver releases it on its next loop (it
  reads both `--deps` and the queue's `held_by`, so a blocker added mid-batch counts). **Where the
  driver is not running** (no merge grants), you release it: `queue.mjs set <TICKET> state=triaged
  park=null held_by=null`, then `queue.mjs front <TICKET>`. That is the one manual release, and only
  once GitHub shows every blocker merged: never because "it probably does not really depend on it".
- **STUCK**: a blocker can no longer merge on its own (it failed, is parked for its own reason,
  finished with no PR, or its PR was closed unmerged). The user decides: re-run or finish the
  blocker, release the ticket anyway, or drop it.

Answering a held ticket's question (`answer.mjs`) keeps the hold.

**"Add the blocker to the batch"** as an answer: fetch as at Stage 1, `triage.sh <B>`, `queue.mjs admit <B>`,
`queue.mjs hold <S> <B>`. A running merge driver picks B up from the queue on its next loop and
merges B's PR; do not restart it. Never re-run `plan-batch` with `AUTOPILOT_WRITE_QUEUE` mid-batch: it resets every ticket's
state.

### Size

Every ticket should carry a size (desk-jira's scale: XS, S, M, L, XL), from the project's `Size`
field or a first description line `Size: M`. **L and XL park** (`size L — split it before
batching`): they are split into smaller tickets, not run. A ticket with no size is reported
`! no size` and runs on its lane as before.

### Feature mode

Children of one epic that share a schema or contract build it in parallel and collide, and nothing
tests the epic's criteria until the last one merges. So an epic gets feature mode when **all** of
these hold: the batch has a base (*A batch that targets a feature branch*), config §4 Acceptance
specs names the spec directory and a command taking `{ids}`, and the epic has numbered criteria
(its DoD ids, else its AC ids, which `expand-parent.mjs` records in `expansion.json`). `plan-batch`
prints `FEATURE MODE — on` or `— off: <why>` for every epic batch; an ordinary batch says nothing.

**Stage 2: draft it.** On, with no plan yet, `plan-batch` puts a `feature_plan` entry on the epic in
`needs_person`. Draft two things into `<state>/feature.json`, then re-run `plan-batch`:

```json
{"epic": "ABC-900", "spine": null,
 "draft": "<the spine ticket, as it would be filed: one strict expected-fail spec per criterion id, titled with the id, plus the shared contracts the children need>",
 "owners": {"DoD1": "ABC-901", "DoD2": "ABC-903"},
 "contributors": {"DoD2": ["ABC-902"]},
 "untestable": {"DoD3": {"why": "about Jira state, not code"}}}
```

- **The spine** is a dedicated ticket, drafted in desk-jira's ticket template; nothing is filed yet.
- **One owner per criterion**: the child whose PR makes that criterion's spec pass. Where several
  children contribute, the owner is the one that completes it, and the rest go under `contributors`:
  `plan-batch` holds the owner behind each of them.
- **A criterion that cannot be written as a test** (for example "all children Done") goes under
  `untestable` with why. `plan-batch` asks whether to leave it to the close-out check; on a yes,
  set its `close_out` to `true`.

The plan prints the draft and one row per criterion id with its owner; a criterion with no owner, an
owner or contributor the batch does not build, an id the epic does not have, or owners and
contributors that hold each other in a cycle, is a question on the epic. Put the draft, the table and those questions to the person at Stage 3.

**Stage 3: approved.** File the spine under the epic through `desk-jira`'s gate (`create … parent=<EPIC>`),
triage it (fetch as at Stage 1, `triage.sh <SPINE>`), set `"spine": "<SPINE>"` in `feature.json`,
and seed the queue with the spine named among the children:
`AUTOPILOT_WRITE_QUEUE=1 plan-batch.mjs <SPINE> <children…>`. The spine is seeded first and runnable,
and every other child is held behind it (`held by orchestrator: blocked by <SPINE> (feature spine)`),
so nothing else spawns until its PR merges. Pass the printed `--deps` to the merge driver as usual.

- `plan-batch` **refuses to seed** while feature mode is on and the spine is not filed and planned,
  or the owner table still has questions: seeded early, the children would start with nothing held.
- **A spine that triage parks** (lane C or D, or size L or XL) stops feature mode for the batch:
  the plan says so, and the children are planned as an ordinary epic batch. Report it; the person
  decides whether to work the spine interactively first.

**When the spine finishes: the person approves its specs.** Seeding records the spine and the
criterion ids it owes a spec for on the queue (`spine`, `spine_ids`: every criterion not left to the
close-out check). When the spine's worker is done, `pass.mjs` reads the specs its branch changed
under the §4 Acceptance specs directory and checks one spec per id, titled with the id, each strict
expected-fail (`test.fail`, `it.fails`, `test.failing`, `@pytest.mark.xfail(strict=True)`). The
spine is never left done: it parks, and its PR stays draft.

- **`spine awaiting approval`**: the check passed. `WAITING ON YOU` carries `SPINE APPROVAL`, the
  children held behind it show as `WAITING ON APPROVAL` (never `STUCK`), the batch is not idle, and
  the pass exits 11. Put the specs to the person: do they mean what the criteria say? **Review them
  first**, because a page of specs hides the one that tests the wrong thing:
  1. `node ~/.claude/desk/bin/spine-review.mjs brief <SPINE>` prints the reviewer's prompt: every
     spec titled with a criterion id, its criterion and its file.
  2. Run Mira (`mira-playwright-expert`) with your own Agent call, read-only, on that prompt. It
     reports, per spec, a criterion clause the spec does not assert, two specs that contradict, a spec
     coupled to an internal module path, and an expected failure that would come from something other
     than the assertion (an import error, a typo). It changes no spec. Save its final text to
     `<state>/spine-review-<SPINE>.txt` and check `git -C <its worktree> status --porcelain` is clean.
  3. `node ~/.claude/desk/bin/spine-review.mjs questions <SPINE> <state>/spine-review-<SPINE>.txt`
     prints one question per spec, each with its criterion, its file and the findings for it. A
     reviewer that failed or returned nothing (leave the file off) makes every question say its spec
     was not reviewed; never present those as clean. Findings naming no reviewed spec come back as
     `unmatched`: show them too.
  4. Ask them as `AskUserQuestion` carousels (*Asking*), one question per spec, its `question`
     text verbatim, options approve or send back. Every spec approved: approve the spine. Any sent
     back: reject it with every spec's note in one.
  - Approved: `queue.mjs approve <SPINE>`. The spine is done, its PR leaves draft (§3 `pr-ready`;
    otherwise it tells you to undraft it), and it merges under the batch's merge rules: the merge
    driver where §3 `autopilot-merge` and `pr-merge-green` are `yes` or the batch approved merging at
    Stage 3, else each pass says
    `SPINE APPROVED — merge PR #<n>` until the person merges it. Once it merges, the children are
    released as any hold is, and spawn on a later pass. The driver releases nothing behind a spine
    that was never approved, even if its PR merged.
  - Rejected: `queue.mjs reject <SPINE> "<their note>"`. The note goes into the spine's briefing as
    a binding answer, and the spine is requeued for a new worker on the same branch and PR. Nothing
    is released.
- **`spine specs incomplete: <problems>`**: an id with no spec, or a spec not marked strict
  expected-fail, each named. `approve` refuses it; send it back with what to fix,
  `queue.mjs reject <SPINE> "<note>"`. Its children wait on it, as above.

**Each child makes the specs it owns pass, and leaves the others alone.** Seeding records the owner
table on the queue too (`owners`, `{<id>: <KEY>}`). A child that owns criteria gets a section in its
briefing, `Acceptance specs you own`, naming each owned spec (its title and file on the base) and
telling it to remove its expected-fail marker and make it pass, changing no other. When its worker
is done, `pass.mjs` checks the branch and, only once the markers are clean, runs the §4 Acceptance
specs command once for each id the child owns, and for no other, in its worktree under the test lock
(the base gate runs them all). A clean check is done as today. Otherwise it parks
`acceptance specs not done: <problems>`, its PR stays draft, and the check is on the ticket as
`spec_check`. The problems it names:

- an owned id with no spec titled with it, or an owned spec still marked expected-fail (strict or
  not) or skipped;
- an owned spec failing when run (the spec, the command and the tail of its output);
- a spec another child owns that the branch added, removed or changed, with that spec's owner.

Send it back with what to fix: `answer.mjs <KEY> "<note>"`, then `queue.mjs requeue <KEY>`. A child
that owns nothing runs as before.

`answer.mjs` still never un-parks: approving is the orchestrator's decision, made on the person's
word.

**The promotion PR opens as the batch starts.** On its first pass, a feature-mode batch opens a
draft PR from the base to §0 Default branch, titled with the epic key, and records it on the queue as
`promotion`. GitHub opens no PR between branches with nothing between them, so a base with no
commits beyond the default branch first gets one empty commit, pushed under §3 `batch-base-push`;
opening the PR is §3 `pr-open`. It is tried once: a refused push, the rows, or a failed
`gh pr create` opens nothing, the report names why under `WAITING ON YOU`, and the batch carries on.
Opened by hand later, record it with `queue.mjs set-batch promotion.pr=<n>` so the gate can mark
it ready.

**The promotion PR carries the batch's ledger.** One comment on it, which only the autopilot writes,
holds a table with one row per child (key, state, PR link, and the model its worker ran on) between
`<!-- desk-autopilot:ledger -->` and `<!-- desk-autopilot:ledger-end -->`, so the feature can be
followed from GitHub. `pass.mjs` finds that comment by its opening marker (one you wrote, not a
reply quoting it), creates it once if it is missing and edits it in place whenever a row changes, a
child merging into the base included, under §3 `pr-edit`. It records what it wrote as
`promotion.ledger` so an unchanged ledger is not written again. The PR body is never read or
written for the ledger, so nothing the person writes there is overwritten; edits to the ledger
comment itself are. Comments that cannot be read or written (or the row not granted) are reported
as `ledger not updated`, the batch carries on, and the next pass tries again.

**The base gate checks the feature as a whole before the promotion PR leaves draft.** When the
batch would go idle, `pass.mjs` decides:

- A child parked or failed: the gate does not run. `WAITING ON YOU` carries `BASE GATE: not run`
  with each such child, and the promotion PR stays draft.
- A child that finished with no PR, or whose PR was closed without merging: the gate does not run,
  and `WAITING ON YOU` names it to requeue or drop.
- A child's PR still open: the gate waits for it (under `WAITING ON YOU` when no merge driver is
  running), and the batch is not idle.
- Every child merged into the base: the pass starts `base-gate.mjs` in the background (it can
  outlast one pass) and reports `BASE GATE: started`. The batch is not idle while it runs. In the
  base worktree the gate merges §0 Default branch in, runs §4 Install, the §4 Acceptance specs
  command once for each criterion id (the spine's, and any other a spec there is titled with), and
  §4 Typecheck, Lint and Unit tests (Jest and
  Vitest capped at §3b's test cap), each under its lock. Its result is the queue's `gate`, and its
  output is `<state>/logs/base-gate.log`.
- **Passed** (every spec and check passed, and no spec under the acceptance directory is still
  marked expected-fail or skipped): the promotion PR is marked ready (§3 `pr-ready`; otherwise
  `WAITING ON YOU` says to undraft it) and the report gives its link. Merging it is the person's.
- **Failed**: each failure is under `WAITING ON YOU` and the PR stays draft. The fix goes onto the
  base; the gate runs again on the first idle pass after the base moves (or at once after
  `queue.mjs set-batch gate=null`).

### Epic close-out

When the batch is idle with no held ticket left:

1. If any child is parked or failed, list them and stop: the epic is not complete, and nothing is
   verified. In feature mode, also stop while the base gate has not passed: its failures come first.
2. Otherwise, if the epic has acceptance criteria or a definition of done (and likewise for each
   story that was expanded into its subtasks, whose own criteria no worker checked), check each one against
   `origin/<base>` with desk-jira's *"Already fixed"* method (one read-only verifier per criterion,
   file:line or NOT MET, defaulting to NOT MET) and report MET / NOT MET. Each NOT MET is proposed
   as a new child under the epic through `desk-jira`'s gate, in the ticket template's layout (the
   unmet criterion becomes its AC1), never appended to the epic. With no
   criteria, say "epic has no criteria — not verified". **In feature mode, a passed base gate has
   already checked every criterion with a spec**: verify only the ones its `close-out:` line names
   (the criteria no spec covers, such as those left to the close-out at Stage 2), or every one when
   it says the criteria could not be read.
3. With a batch base, the promotion PR (base → default) is the user's to merge. Title it with the epic
   key so `/desk-review` checks the epic's criteria against the whole feature, and say so. In feature
   mode it is already open, titled that way, and the gate marked it ready.
4. **Never transition the epic**, whatever the result.

### A design in Claude Design

Workers have no Artifact tool, so a ticket whose design is a Claude Design artifact gets a
snapshot **at Stage 1, before its triage**, taken by you. Find them with
`node ~/.claude/desk/bin/desk-design.mjs check <KEY>` per ticket (a `blocking` line: no copy is saved
in the repo yet). List the artifact's files (`Artifact action:list scope:files`), then read
`project/canvas.json`, every `project/*.dc.html`, and the `support.js`, stylesheets and fonts they
load, with `paths` and `out_dir: <state>/designs/<TICKET>/` (they land under
`<state>/designs/<TICKET>/project/`; triage and workers can read `<state>`). Read too what the
published files leave out: each `/_blob/<id>` asset a board names, in its attributes or script, one
`read` with `path: "/_blob/<id>"` apiece (a `paths` read refuses asset ids), and
`artifact-type/dc-runtime.js` when a board loads a `support.js` the artifact does not publish
(desk-ticket `design-canvas.md` has why). The saves need no
approval: `/desk-setup` grants this session the state folder (`orchestrator-tools`), so a prompt per
file means the repo was set up before that, and re-running `/desk-setup` fixes it. Then record where it
came from, naming **every** ticket in the batch that uses this canvas, so the workers who save it
write identical files:

```bash
node ~/.claude/desk/bin/desk-design.mjs write <state>/designs/<TICKET> --url <artifact URL> \
  --version <its version> --epic <EPIC, or the first ticket> --key <KEY> [--boards '<a>,<b>'] --key <KEY2> …
```

Each worker runs `desk-design.mjs save` on its snapshot (desk-ticket `design-canvas.md`, "A Claude Design canvas is saved
into the repo"), which commits it under `<§2 Design canvases directory>/<EPIC or KEY>/` on the
ticket's branch, once per artifact. `canvas.json` names each board and its width; each board holds
the exact copy, colours and sizes. For a ticket whose canvas is already saved (`check` prints `ok`
or an `advisory`), read the artifact's current version (`Artifact action:list`) and run
`desk-design.mjs status <URL> --version <v>`. Exit 3 means it has moved on: re-saving is a Stage 3
question, and on a yes you snapshot it as above.
An artifact the user does not own returns a summary, not the files: that, or one that will not
read, is a Stage 3 question. A worker never builds from a summary or a guess.

## A batch that targets a feature branch

Some work ships as one merge from a long-lived branch (a release with no feature flag), so its PRs
must base on that branch, not on §0 Default branch. Set it once per batch, **after `init` and before
triage**:

```bash
node ~/.claude/desk/bin/queue.mjs set-batch base=feat/<branch>   # base= clears it; init clears it too
```

- It refuses a branch that is not on origin, and any production branch. Push the branch first.
- `pass.mjs`, `triage.sh` and `merge-driver.sh` export it as `DESK_DEFAULT_BRANCH`. Worktrees then
  branch from it, workers rebase onto it and open their PRs against it (their system prompt names
  it), and the merge driver merges only PRs based on it.
- Interactive sessions in the same repo never read the queue, so they keep §0 Default branch.
- `queue.mjs render` shows `base <branch>`. Say it in the Stage 2 report.

**Check before the first spawn that CI runs on PRs into that branch.** A workflow filtered to
`branches: [<default>]` reports nothing on such a PR, so every required check reads "has not
reported" and nothing ever merges.

**`pass.mjs` keeps the base current; do not merge into it by hand.** Every pass makes sure the base
has its own worktree, `<§2 Worktrees directory>/base-<branch>` (a plain `git worktree add`, no
database or env files). Before a pass that will spawn, and only then, it merges §0 Default branch into
the base there as a merge commit (never a rebase, so running workers' bases stay valid) and pushes
it, and the report says how many commits came in. A push refused as non-fast-forward (the merge
driver just merged into the base) is fetched, merged again and retried once. Pushing is config §3
`batch-base-push`: unset or `ask` is one approval per batch, so ask it at Stage 3 and run passes with
`AUTOPILOT_BASE_PUSH_APPROVED=1`. A sync that cannot run pushes nothing and goes under `WAITING ON
YOU` with its reason: a conflict (its files listed; resolve it in the base worktree and push), a
refused push, the row, or the primary checkout having the base checked out (switch it off that
branch; no base worktree is made until then). In feature mode that pass spawns nothing; otherwise
spawning carries on from the base as it stands. Feature mode here is the decision `plan-batch`
recorded on the queue when it seeded (`feature`), not whatever `feature.json` names.

**Baseline checks (config §4 "Baseline checks" `on`).** Once the sync is done, and only when the
base has moved since the last record, the pass runs §4 Install, Typecheck and Lint in the base
worktree and records their errors in `<state>/baseline.json`. The report says
`baseline: recorded <base> at <sha>: typecheck <n> error(s) · lint <n> error(s)`, or names a check
whose output it could not read (workers run that one in full). Each worker's briefing then carries a
`Baseline checks` section telling it to check with `desk-env baseline typecheck|lint`, which fails
only on errors its branch adds. A base that cannot be recorded (a dirty base worktree, a failed
install) goes under `WAITING ON YOU` and leaves no baseline, so workers run the full checks. CI and
the pre-push hook are unchanged.

## Merge each PR the moment it goes green

**An open PR is not a finished ticket, and holding several open is what makes a batch expensive.**
Every merge moves `<default>`, and every PR still open has to absorb that move: a conflict to
resolve, a new head SHA, and, where a required check matches the review verdict against the *exact*
head, a whole fresh review and CI run. The cost is quadratic in how many you hold: the last of a
batch carried to all-open-before-any-merged pays a conflict resolution and a re-review for each PR
ahead of it, none of which exist had each merged when it first went green.

**This section applies as written where config §3 `autopilot-merge` and `pr-merge-green` are both
`yes`, or where the user approved merging this batch at Stage 3 (the queue's `approved.merge` is
`true`; the §3 table under *Read the config first*).** Where neither holds, do everything below except the merge itself:
undraft (if `pr-ready` allows), keep the checks green, and put each green PR in front of the user the
moment it flips (the pass lists it as `READY TO MERGE`): the cost of holding PRs open is the same, so
say so rather than letting them queue.

**"Green" is the config's one definition** (desk-config "Green"), the same in the driver, in
`desk-clearance`, in `desk-ticket` and here: on the **exact head commit** being merged, every §4
Required checks entry completed with success (**skipped does not count**); no other check failed, errored,
timed out or is still queued or running, unless §4 Advisory checks names it; and at least one check
completed with success. With Required checks `none`, the second and third clauses still apply. The
merge is pinned to that commit, `gh pr merge <n> --<§4 Merge method> --match-head-commit <sha>`, so a
push after the checks cannot be merged unchecked. With §4 Branch protection `none`, GitHub will
accept a merge with red checks, so the rule is enforced only by you and the driver.

**Merge holds.** A PR whose diff touches any glob in §4 Merge holds (for a `<glob>#<key>` hold, changes
that key of the file) is merged by a person, never by
the driver or by you, whatever §3 grants: the repo needs a manual step first (the hold says which).
The driver skips it and logs `HELD`; you put it under `WAITING ON YOU` with the hold's reason, the
PR link and its head SHA, and it stays there until the user says they have merged it.

**Known flaky checks: the one written waiver.** A PR whose only red checks are named in §4 Known
flaky checks (`` `<check>: <glob> [<glob>…]` ``) is merged by the driver, pinned to its head, once
each of them is still red after the driver's two reruns at that head, the PR's files touch none of
the globs the row gives for that check, and nothing else in the gate is red or pending. It logs
`WAIVED <check>`, and once merged files a ticket naming the check, the PR, the head SHA and the
failing run (`desk-jira create`, under §3 `jira-create`). Where it cannot file one (§3 not `yes`,
Tracker `none`, or `create` refused), its log names the body file under `<state>/merge-driver/`:
put that under `WAITING ON YOU`. It never waives:

- a check the PR's diff could have broken (it touches one of the row's globs): logged as the waiver
  not applying, and red as ever;
- a §4 Required check, whatever the row says: branch protection enforces it, and merging past it
  would be a bypass (§3 `merge-bypass` is `never`). The driver records it as `merge_blocked` and you
  report the PR;
- a check the row does not name: red, as it always was.

A row that does not parse stops the driver at start, naming the row; fix it with `/desk-setup`.
Unset waives nothing.

**Start the merge driver at Stage 4, before the first worker finishes, unless the batch is handed
to the supervisor (it starts one itself): do not merge off your own turn cadence.** Merging tied to when a monitor happens to wake you is how a PR sits green and
unmerged: nothing undrafts, merges or retriggers it until the orchestrator's next turn.

The driver **refuses to start while §4 Merge holds is unset** (write `none` when nothing is held),
as it does for §4 Required checks and Merge method.

```bash
nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2 ABC-3" --deps "ABC-3:ABC-1" \
  --log &
```

`--log` has the driver append its own output to `<state>/merge-driver.log`, so the command carries
no `>>` redirect: a redirect outside the working directory prompts every time, whatever the allow
rules say. **Where the batch is handed to the supervisor, do not start one**: it starts the driver for a
handed-over batch and starts it again after a reboot (*The supervisor*).

It loops every ~2 minutes over the batch's **ready** (non-draft) PRs by config §1's handle, **one at
a time**: skips a PR with outstanding review feedback where `merge-feedback-first` is `yes`, skips
a PR under a §4 Merge holds glob (logging `HELD` and the reason), disarming any auto-merge armed on
either, merges with §4 Merge method and `--match-head-commit <sha>` when the head is green, updates
a `BEHIND` PR with `gh pr update-branch` where §3 `pr-update-branch` is `yes`, skips a `DIRTY` PR,
and, where `ci-rerun` is `yes`, retriggers `gh run rerun <id> --failed` only once that run has
reached `completed`. It **never arms auto-merge** (the platform's idea of green is not the
config's) and never undrafts. Why a ticket's PR is not merging is recorded on the ticket as
`merge_blocked=` (a hold, or behind without `pr-update-branch`), which `queue.mjs render` shows. It
matches a ticket's PR by the recorded branch and base (above). `--tickets` is the starting set:
every loop also takes in each ticket in the queue, so a ticket admitted or requeued mid-batch is
merged with no restart. `--tickets` takes whitespace- or comma-separated keys and refuses (exit 2) anything that is not a key for this repo (§4 Ticket
key pattern, §4 Other work id patterns, or the Tracker-`none` forms), and `--deps` anything not
`<key>:<key>[,<key>…]`. Only one driver runs at a time (`<state>/merge-driver.lock.d`); a second
exits 1 naming the holder's pid. Two things it must get right or it makes the problem worse: **never
retrigger a run that is not `completed`** (per-PR `cancel-in-progress` kills the run in flight, and a
loop that re-reads too soon after a rerun sees the stale `completed` and fires again, starving the PR
forever) and **only one PR may be building a preview at a time** (see the preview-build cap below).

- **Merge on green as defined, not on the checks you like.** A red check is advisory only when §4
  Advisory checks names it, and waivable only by the driver under §4 Known flaky checks (above),
  never by you; a skipped required check is not a pass. Read checks with
  `gh pr checks <n> --json name,state,bucket` against the head SHA you will pin, or `awk -F'\t'` on
  the plain output: it is tab-separated and a name column that carries an emoji makes splitting on
  whitespace silently yield the wrong word instead of the verdict, and nothing ever merges.
- **Never bypass them.** `--admin` is not yours to use (`merge-bypass` is `never`).
- **A review gate can fail on a PR's first CI run when the review posts late.** Where a required
  check reads the posted review verdict: opening the PR triggers CI seconds before the worker posts
  its review. If the gate polls for the verdict briefly, a review posted inside that window passes
  the same run. Posting starts no run of its own: CI typically runs only on open, reopen and push.
  Otherwise confirm the verdict's SHA equals `headRefOid` and re-run the whole failed set once the
  run is `completed`. The driver merges on its next loop once the gate clears.
- **A PR that has gone `DIRTY` merges nothing.** Resolve it, then expect the re-review: that is the
  cost this stage exists to avoid paying seven more times. A conflict in a generated file (one whose
  header says it is generated) is resolved by taking `<default>`'s version and re-running only that
  generator.
- **Undraft only once the PR is done and reviewed with no findings**, and only where config §3
  `pr-ready` is `yes`, or is `ask` and the user approved undrafting for this batch at Stage 3 (the
  queue's `approved.undraft` is `true`), then do whatever is needed to merge it immediately. Under
  that batch approval, undraft without asking again, and add one line to `batch-notes.md` with the
  Edit tool each time: `- [<TICKET>] undrafted #<n> at <head sha>: §3 pr-ready is ask, batch approval
  given at Stage 3`. Declined, or never asked, is today's rule: report the PR as ready to undraft. Done and reviewed means the review verdict on the PR's **current**
  `headRefOid` reads as §4 Clean review verdict with nothing deferred and no requirement gaps, the
  screenshots are uploaded (or the body says nothing renders differently), and `mergeStateStatus` is
  not `DIRTY`. A review gate may pass with gaps open, so a gap count above 0 is a question for the
  user, not a merge: keep it draft, since the driver merges any ready PR that goes green. With §4
  Local review command `none`, there is no verdict: "reviewed" is then the user's call, so report the
  PR rather than undrafting it. A clean verdict on a conflicted head is spent the moment the conflict
  is resolved. Workers are denied `gh pr ready`, so every pass checks these facts for each done
  ticket's draft PR (`undraft.mjs`, whoever runs the pass, the supervisor included), with its checks
  green too, then runs `gh pr ready` and writes that `batch-notes.md` line itself. One whose checks
  are still running, or whose mergeability GitHub has not worked out yet, waits for a later pass; any other draft it may not undraft is under WAITING ON
  YOU as `DRAFT`, with the reason and what to do. Either way it is recorded on the
  ticket as `undraft`; a feature spine is left to `queue.mjs approve`. The driver merges a ready PR,
  pinned, the moment it is green (never a PR under a §4 Merge holds glob). Do not arm auto-merge.
  Undrafting earlier pings the reviewer before the evidence is in.
- **One preview build at a time, where PRs deploy previews (§4 Vercel set). Two is already too
  many.** A shared preview builder can OOM concurrent builds against each other: seven triggered
  together have given one `Ready` and six `Error` (exit 137), and **two** PRs opening a minute apart
  have killed *both* builds. A monorepo PR can trigger several previews at once (an app, docs, a
  component catalogue), so two PRs can be four-plus concurrent builds. Stagger PR creation and
  serialise every retrigger. Where this applies, it, not review or CI, caps how fast a batch can
  merge, and it is what a red preview-deploy check almost always means. Where config §3
  `read-vercel` allows, read the build log before treating it as broken code:
  `vercel inspect --logs <url> --scope <team slug from §4 Vercel>`, looking for exit 137 or
  "Out of Memory".

**Act, do not watch.** The failure this stage exists to prevent is a green PR sitting unmerged while
the orchestrator reports on it. If a PR can be merged, merge it before writing the next status
table; if a build is red and nothing is in flight, retrigger it. When asked why a batch is slow,
answer with the specific thing being waited on and what is already in flight against it.

## The status table

**Every state change gets a table, not a sentence** (unless the repo has set quiet, below), so the user can see each ticket and its state
whenever one moves. A prose line about the one ticket that moved makes the reader reconstruct the
other six from memory, and silence between spawn and PR reads as nothing happening.

Emit it whenever the status monitor fires with a real change: a spawn, a park, an unpark, a question
for the person, a PR landing, a merge, a failure. Not on memory jitter, and not on a pass that
changed nothing. **A worker stepping from one stage to the next no longer wakes you**: each wake
re-reads your whole context, and desk-q already shows every stage. The table printed on the next
real change carries each running ticket's current stage. `queue.mjs watch --stages` fires on stage
steps too, as it used to.

| Ticket | State | Stage | Port | Notes |
|---|---|---|---|---|
| ABC-1200 | 🟢 Running | 5/9 | 3001 | one line: the gate, blocker or decision that matters |
| ABC-1208 | ⏳ Queued | — | — | its position when the order was set deliberately |
| ABC-1166 | 🅿️ Parked | — | — | what unparks it |
| ABC-1181 | ✅ PR #NNN | — | — | the PR number once it exists |

- **Every ticket in the batch, every time**: parked and queued rows included.
- **Mark what changed** (an arrow, a bold cell) so the delta is findable without diffing.
- **Carry `vmmem=` and `avail=`** with it, since the ladder decision is read from those two numbers,
  and the `runner=` and `ladder=` figures whenever the pass line carries them.
- **Notes stay to one line.** The full park reason lives in the queue.

**Quiet: config §3b "Orchestrator status table" `quiet`** (`desk-env get status-table`; unset is
`full`, the rule above). It applies to a batch run in the session: someone following the batch in
desk-q already sees every row, so the table twice in the session is only spent context. The status
watch then prints the table once at start and, after that, one line per ticket that changed (key,
old → new) with the memory line. On a spawn (or, with `--stages`, a stage step), reply in one line at most, with no
table, or not at all. Quiet removes repetition, never signal:

- **A park, a question for the person, a PR opening, a merge or a failure** still gets its line,
  naming the ticket and what it needs (what unparks it, the question, the PR number, the failure).
- **The Stage 8 batch report** carries the full table and the `WORKER COST` table, as at `full`.
- **Asked for the status**, print the full table (`queue.mjs render`, with `desk-env mem status`).

Any value but `full` or `quiet` reads as `full`: the watch's first line says the value was not
recognised; say that once to the person, and run the batch at `full`.

**The batch report (Stage 8) carries the batch's CI red rate.** Workers now run related tests rather
than full suites, so a rise in red PRs is the cost of that showing up. Once the batch has PRs, run

```bash
node ~/.claude/desk/bin/desk-ci.mjs batch-red      # the queue's finished tickets; --prs 12,13 for others
```

It measures those PRs exactly as `desk-ci measure` measures a window (a PR is red when any attempt
of any run on it went red) and compares the rate with the newest `measure` report for the repo, the
D6 baseline, in the main checkout's `.handoffs/`. Put its `batch:` and `baseline:` lines in the
report. **`RED RATE ROSE`** (more than 5 percentage points above the baseline, exit 1) is a finding:
say it first, with the PRs that went red, and do not lower it to a note. With no baseline it says so;
offer `desk-ci measure` rather than reporting the rate as normal.

**The batch report also carries what each worker cost.** The idle pass prints a `WORKER COST` table:
each worker's input and output tokens, cost in USD and wall time, summed over every round of it in
this batch, and a total row. Put the table in the report as printed. A worker whose log has no result event reads `unknown`, and
the total says how many it left out: report those as unknown, never as zero. The cost includes the
permissions preflight before each spawn, and the `preflight` column gives that part on its own; a
preflight that produced no result is named `unknown` there, never counted as zero. Each spawn line
of a pass says what its preflight cost too. Each row also gives
the worker's first-turn input (the prompt each run started on), and under it one line per stage
with the input and output tokens from that stage marker to the next; tokens before the first marker
are `start-up`. A worker whose log has no usage figures reads `unknown` there too.

## Why C and D get a second look

Triage is one `claude -p` pass forming one opinion, and for A, B and E that is fine: the worker
commits its own lane at `desk-ticket` Stage 2 and demotes if it was wrong, so a bad guess costs
minutes. **C and D are different, because they are terminal here**: `plan-batch` parks them, no
worker ever runs, and the ticket sits until the user reads a question. A wrongly parked ticket
costs a whole batch cycle and looks exactly like a correctly parked one. So here
**C-or-D-when-really-A** is the expensive direction, and the challenge only ever runs downhill.

The over-escalations that have actually happened, all named in the challenge prompt:

- **A design frame read as lane D on its own.** In a repo whose UI tickets routinely link one, most
  tickets have one. A ticket triaged D on that basis can sit through a batch and turn out to be
  three files and one copy key.
- **An unanswered question read as complexity.** Missing information belongs in `unknowns`.
- **`spans more than one sitting` (lane C) sized from the description rather than the code.** The
  most common one. Triage researches `prior_art` and then sizes the ticket as though it had found
  nothing. Where a ticket defines sequenced, independently-mergeable stages, only the first stage is
  what runs.

The challenge confirms unless it can name the trigger that does not fire, and doubt confirms. **The
one exception is a park on size alone**, where "describe it file by file" would make the trigger
unfalsifiable; there the test is whether the work is mechanical and bounded. **A challenge that could
not read the code is not doubt**: any read it needed and could not make makes its verdict
INCONCLUSIVE, with the failed reads recorded, and the lane is left exactly as the first pass set it.

**A confirmed park can still be wrong, because both passes can share one over-estimate.** A park on
size CONFIRMED by counting new things to build can be lane A in a handful of files when every one has
an existing pattern on `origin/<default>` to copy. Before reporting any park on size, check each
thing the challenge calls "new" against `origin/<default>` and say what you found: report the doubt,
not the verdict. **Branch on the challenge's `needs_person` entry**, not the plan's wording: a park
with `challenge_inconclusive` (its reads failed, named in `detail`) or `challenge_not_run` is a single
unchecked opinion that must not be reported as settled, and a confirmed park has neither. An
INCONCLUSIVE park is also a `question`: put it to the user to confirm or re-lane.

**A lane is a proposal.** When the user rules that a park's lane is wrong (it is really A, B or E),
re-lane it with `queue.mjs set <TICKET> lane=A`, answer its triage unknowns (`answer.mjs`), then
`queue.mjs requeue <TICKET>`, and, where the ticket is
genuinely big, scope it in the briefing so what runs really is one sitting. That is a new lane, not
a requeue of a C or D: a ticket that stays C or D is worked interactively, never by a worker.

## Ask or take

Most questions only add waiting: the recommended option is chosen nearly nine times in ten. So
every would-be question, yours, a worker's or an interactive session's, is first sorted into **ask**
or **take**.

**Try before asking.** A question whether the user has done a step ("is the secret set?", "has the
DNS record gone in?", "did the migration run?") is not a question when you can check it through an
API, CLI or browser read config §3 already grants. Check first, and ask only if the check cannot
settle it:

- **It settles it:** ask nothing, carry on, and log what you checked and what it showed. A worker
  prints `AUTOPILOT_CHECKED: {"question": "…", "checked": "…", "showed": "…"}` at the start of a line
  in its own text; you and interactive sessions run
  `node ~/.claude/desk/bin/decisions.mjs check <TICKET> '{"question": "…", "checked": "…", "showed": "…"}'`.
  The digest lists it under `Checked instead of asking`.
- **It fails** (refused, an error, an answer that settles nothing): ask, and say in the question what
  you tried and the error it got, word for word.
- **Never attempt** a step whose attempt would spend money, write to a shared or live system, or
  need a credential you do not hold. Ask it as an ask-category question (`money` or `production`),
  without trying. Trying never widens §3: an attempt uses only what the config already grants.

A value only the user holds stays a question, with its routes offered (*Asking*); a step you can
check is not one of them.

**Do not re-ask what the user put off.** An answer of "not now" puts the question in the repo's
register, `<state>/not-now.jsonl` (`not-now.mjs`), with the date and the inputs it depends on: the
ticket, a PR head SHA, config rows, an external value it read, whatever the question names. A
question in the register whose inputs are unchanged is not asked again: the digest lists it once
under `Put off`, with the date, and its ticket stays parked without counting as waiting on the
user. One whose inputs changed is asked, with a line saying what changed since it was put off.

- **A worker** names a park's inputs on the line after it, as
  `AUTOPILOT_PARK_INPUTS: {"ticket": "ABC-1", "pr-head": "3f2a…"}` (a flat object of plain values;
  none is `{}`, which matches on the question's text alone). `pass.mjs` stores them on the park and
  checks the register when it harvests the run. While the park stays put off, each pass reads its
  `pr-head` (the branch's head on origin) and `config:<row id>` inputs again, and asks the question
  as soon as one has changed; any other input is compared only when a session asks again.
- **You and interactive sessions** check before asking, and record a "not now" the user gives in
  the conversation (an answer through `answer.mjs` or the digest is recorded for you):

```
node ~/.claude/desk/bin/not-now.mjs check "<question>" --inputs '{"ticket": "ABC-1"}'
node ~/.claude/desk/bin/not-now.mjs add <TICKET> "<question>" --inputs '{"ticket": "ABC-1"}'
```

  `check` exits 3 for a question put off with the same inputs (do not ask it), and 0 to ask, printing
  the what-changed line to put in the question when there is one. An entry stops holding the question back once its
  inputs change, and goes when the user answers the question or clears it (`not-now.mjs clear "<question>"`, or `ask-again` from the digest); it never
  expires by age. A register that cannot be read puts nothing off: every question is asked as it
  would be without one, and each pass reports it under `WAITING ON YOU`.

**Ask** only when it falls in one of the five ask categories (the id in brackets is the one
`decisions.mjs` knows):

| Ask category | For example |
|---|---|
| money (`money`) | approving a spend, a paid plan, anything billed |
| legal or regulatory (`legal`) | legal or policy copy, privacy, compliance (`legal-content` is `stop`) |
| production data or credentials (`production`) | a production database, a secret, a key, a live account |
| customer copy where length means cost (`customer-copy`) | an SMS, a paid placement, any copy billed by length |
| facts only the user holds (`user-fact`) | product or catalog data, a design URL, an asset, a name, who owns what |

Ask too when the call has **no recommendation you can defend**: say so, as "no recommendation", in
the question.

**Take** everything else: a product, design, wording, review, engineering, scope or tracker call
with a recommendation. Build or do the recommended option, carry on, and log the call so the
check-in digest can list it. Taking it is not widening §3: a row that is not `yes` still parks or
asks, so a take never makes a write the config did not grant. And `autopilot-judgement` decides it
for workers: where that row is not `yes`, a worker parks as before.

Each taken call is one entry in `<state>/decisions.jsonl` (time, repo, ticket, question, options,
the option chosen, category, PR link):

- **A worker** prints one line per call, at the start of a line in its own text, as
  `AUTOPILOT_DECISION: {"question": "…", "options": ["…", "…"], "chose": "…", "category": "…"}`,
  and lists it in its PR body under `Decisions taken` (`desk-pr`). `pass.mjs` appends it to the log
  when it harvests the finished run, with the PR from its `AUTOPILOT_DONE`, once per run however
  often it reads the log. A line it cannot read (not that JSON, a choice outside its options, or an
  ask category) logs nothing and comes back under `WAITING ON YOU` as `unreadable decision`, with
  the raw line: settle it with the user, and log it yourself if it stands.
- **You and interactive sessions** log through the CLI, after doing it:

```
node ~/.claude/desk/bin/decisions.mjs log <TICKET> '{"question": "…", "options": ["…", "…"], "chose": "…", "category": "…"}' [--pr <n>]
```

A category is one of `product`, `design`, `wording`, `review`, `engineering`, `scope` or `tracker`;
the CLI refuses an ask category with exit 11, because that call is asked, never taken. A Jira write
that §3 grants is a `tracker` entry.

## The check-in digest

Questions and taken calls reach the person at the config §3b "Check-in times" (unset: `08:00,
17:00` local), from every repo at once, as one page and one push. A row that does not read as
HH:MM times holds spawns under `STALLED`, naming the row.

**The health watchdog.** Each pass checks that the machine can still do the work (`health.mjs`):
`gh auth status`, `desk-jira whoami` (where §4 Tracker is `jira`), `claude auth status`,
`codex login status` (unless §3 `codex-review` is `no`), the browser profile's saved GitHub login
(unless §3 `pr-images` is `no`), and free disk on the worktrees disk against §3b "Free disk floor
(GB)" (unset: 20). A check with no answer in 20 seconds fails as `timed out`, and results are reused
for 15 minutes. The report always carries one `health:` line. A failing required check holds every
new spawn (running workers carry on), is named under `STALLED` with the command that fixes it, and
goes into `push` as `health:<slug>:<check>`, which is pushed once while it stays failing. Signing
back in is always the person's; the line says `recovered` on the first pass that sees it pass.

**Weekly usage pacing.** One weekly allowance runs every repo's workers, so each pass reads the
newest 7-day reading from the `rate_limit_event` lines in every repo's worker logs written in the
last 6 hours (`usage-pace.mjs`). Pace is the share of the 7-day window gone since its last reset,
read from the event's `resetsAt`. While utilisation is more than §3b "Usage pacing headroom
(points)" (unset: 5; `off` turns it off) above pace, new spawns hold under `STALLED` and running
workers carry on; it releases by itself as the week goes on. The report always carries one `usage:`
line: `usage: 7-day 40%, pace 50%`, `… + 5: holding spawns`, `usage: no recent data` (no reading,
or the newest one's window has reset), or `pacing off`. A row that reads as neither a number nor
`off` holds every spawn, naming the row, as a malformed budget does.

**The weekly maintenance window.** One per computer (`maintenance.mjs`). With §3b "Maintenance
window" set in a repo (e.g. `Mon 06:30 UTC`, just after the weekly usage reset; unset is `none`), the
first pass at or after it opens the window, and from then every repo's pass, with a row or without,
starts no new worker, resumes included, and reports `maintenance: draining`. Each repo's workers
finish, or after its §3b "Maintenance drain limit (minutes)" (unset: 60) each one still running is
stopped with its session kept and queued to resume (`resume=maintenance`, not counted against "Resume
a killed worker"); workers in a repo whose passes are not running are waited on for 30 minutes more.
Then one pass pulls the desk-skills checkout fast-forward on a clean `main` and runs `install.sh`,
and runs `reboot-check.mjs`. Where §3 `machine-reboot` is `yes` and the check found no blocker
(anything heavy running, a worker still running in any repo, or FileVault on or unreadable, since a
restarted Mac then waits at the unlock screen until someone logs in), it runs `desk-runner down` if the
runner was up and restarts the computer; the supervisor brings passes back at login, the first pass
runs `desk-runner up` again (as does a restart that fails or never happens), and the stopped workers
resume. At `ask` (unset), or at `yes` with FileVault the only blocker, it does not restart and puts
"ready to reboot" in the next check-in, naming FileVault where it is on; at `no`
it stops there. A failed update goes in the check-in too, and does not restart. Every step, with the
old and new commit and the check's summary, goes in `~/.desk-autopilot/maintenance/maintenance.log`.
A window runs once a week; one no pass reaches within 6 hours is missed that week. An idle batch's
supervisor tick moves it on too (`maintenance.mjs step`).

- **Who sends it.** Each pass past a slot calls the digest. A machine-wide lock and the last slot
  sent make the first pass on the machine, in any repo, the only one to build it, and only that
  pass's `push` carries it. A slot no pass saw (nothing running at 08:00) is covered by the first
  pass after it, back to the last digest sent. An idle batch runs no pass, so the supervisor's tick,
  or the loop (`digest.mjs checkin`), runs the check-in on its own while its tickets stay parked.
- **What it lists.** Per repo: every open question (each parked ticket's question, a hold is not
  one, and each triaged ticket's unknowns), every call taken and every question settled by checking
  since the last digest, and, under `Put off`, each question the user put off whose inputs have not
  changed, once, with the date and an `ask-again` command; a put-off question is never pushed. A question
  still open at the next check-in is listed again, and the batch carries on meanwhile with every
  ticket it does not block. It is pushed only when something is new (a question the last page did
  not list, or a call taken since); otherwise the page is written and nothing is pushed.
- **Parks already Done in Jira.** Before listing a repo's parks, the digest asks that repo's Jira
  (its own `desk-jira`, run from its checkout) for their status, one `key in (...)` search per 100
  keys. A park whose status is in Jira's Done category is not asked; the repo's section names them
  in one line (`2 parked tickets are Done in Jira; their orchestrators can drop them: …`). The digest
  never writes a queue: dropping them is each orchestrator's call (`queue.mjs drop`, or `set <KEY>
  state=done`). A repo whose Jira cannot be read, or with no Jira (§4 Tracker not `jira`, or no desk
  config), has its parks listed as usual, under a line saying its Jira status was not checked.
- **Interactive close-outs.** A ticket an interactive session merges or moves to Done is noted in
  this batch's state by `closeout.mjs` (`<state>/closed-out/<KEY>.json`); the next pass records it
  done and reports it under `done:`, so it stops being listed as parked. A running ticket waits for
  its worker to end, and a note older than the ticket's place in the queue is dropped unread.
- **Where.** `~/.desk-autopilot/digest/<date>T<HHMM>.md`, named in the push.
- **Answering from it.** Each line carries its command. An answer goes through that repo's
  `answer.mjs`, exactly as Stage 5, and the page marks it answered:

```
node ~/.claude/desk/bin/digest.mjs answer <slug> <TICKET> "<answer>"
node ~/.claude/desk/bin/digest.mjs override <slug> <decision-id> "<choice>"
node ~/.claude/desk/bin/digest.mjs ask-again <slug> <TICKET>
```

  An override is recorded in that repo's decision log with who and when, and the next pass there
  lists the ticket under `WAITING ON YOU` as `decision overridden`: redo the work to the new
  choice, or put it back to the person if it cannot be.
- **Between check-ins** only a park whose question starts `PRODUCTION BROKEN: ` is pushed, at once
  and on its own (the worker contract says when a worker may use it).
- **Promotion, once a day.** Going to production is asked only in the day's last slot (`promotion.mjs`).
  Per repo with config §4 "Promotion ref" set, it lists one question covering every PR merged to
  §0 Default branch since that ref, with a staging-check page beside the digest
  (`<date>T<HHMM>-<slug>-staging.md`): each PR's title, link and the unchecked `- [ ]` items its
  Testing section leaves to a person (`desk-pr`), a PR with none under "Nothing to look at", a PR
  whose body could not be read under "Not read", each commit naming no PR (a rebase merge), and the
  §4 Staging URLs. Nothing merged: no question and no page. A Promotion ref that is unset, `none`, or
  an `origin/` branch that is not a production branch asks nothing, and the digest says why. A "go"
  is recorded in that repo's batch notes with the
  approved commit range; the repo's own promotion steps are then the person's, since skills never
  deploy production:

```
node ~/.claude/desk/bin/digest.mjs promote <slug> <from>..<to> go
```

  A pass that sees a batch PR newly merged whose title or intro starts `PRODUCTION BROKEN` pushes
  that repo's promotion question at once (`promotion:<slug>:<sha>:urgent`), not held for the
  last slot, and carries it on every pass until the evening question or a "go". A PR whose body or
  range could not be read is read again on the next pass.

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

## Task mode — a batch that is not "implement these tickets"

`spawn-worker.sh` takes **`AUTOPILOT_TASK`**: a prompt for a *fresh* worker that replaces the default
"work the ticket with desk-ticket" instruction. `$TICKET`, `$WT` and `$PORT` are substituted into
it, so one task string serves the whole batch. `AUTOPILOT_RESUME` takes precedence; `pass.mjs` sets
it only to resume a worker a reboot or crash killed, and setting it yourself does not work: see
`references/orchestrator-recovery.md`. Set `AUTOPILOT_TASK` once in
`pass.mjs`'s environment and every worker gets it; the worker contract's section 0 (`references/worker-contract-task.md`) says a task
overrides the ticket-implementation stages.

Use it when the unit of work is not a ticket. A PR review sweep across open PRs is the worked
example: the queue comes from `gh pr list` rather than triage, and **Stages 1, 1b and 2 are skipped
entirely** because `plan-batch` would simply park everything. Stage 4 onward is unchanged:
`pass.mjs` is still the only spawner, and the ladder, the locks and the handshake all still apply.
It is also how a dead worker's half-finished worktree is picked up.

Raise `AUTOPILOT_BUDGET_USD` above the per-worker default when a task is longer than one ticket: a
review loop runs its finders several times, and the default exists to stop a runaway.

**A review sweep ends with a posted review on every PR, and you verify it: the worker's word is
not evidence.** It needs §4 Local review command (with `none`, there is nothing to sweep with; say
so and stop). The loop is "review, fix, re-review until the verdict reads as §4 Clean review verdict,
capped at 3 rounds", then the review is posted to the PR **unconditionally**: a clean review still
gets posted, because the review's local marker at the PR's current head is the only record the PR
was reviewed. The only exemptions are a PR that had already merged and a dry run. Do not take
`posted=yes` from a worker's `AUTOPILOT_DONE` line; re-derive it from GitHub every pass and re-queue
any PR whose marker is missing from its current head.

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

## Stalls and spend

Spend follows config §3b. Where "Autopilot batch budget (USD)" is `none`, leave `budget_usd` unset so
`pass.mjs` never stops spawning, and do not surface a running total as a finding. Where a cap is set,
`pass.mjs` stops spawning at it and says so. The per-worker budget is a runaway guard, not a cap on
asked-for work. Precedence: batch: the queue's `budget_usd`, `AUTOPILOT_BATCH_BUDGET_USD`, config,
`none`; per worker: `AUTOPILOT_BUDGET_USD`, config, `25`. A malformed value holds spawns (batch,
under `STALLED`) or fails the preflight (per worker); fix the value, never strip it.

**Which model each worker runs on is config §3b "Worker models".** At `default` (also when the row
is absent) no `--model` is passed and every worker runs on the session default. At
`standard=<model> high=<model>`, `pass.mjs` picks a tier per ticket at spawn: a lane A or E ticket
sized XS or S runs on `standard`; lane B, size M and an unsized ticket run on `high`. The preflight
runs on the same model, so a value the CLI rejects fails that ticket's preflight with a `MODEL` line
naming it. The queue records `model_tier` and `model`, and the status table shows the model of each
running worker. `queue.mjs requeue` raises a `standard` ticket to `high` when its worker failed or was
stopped as stalled, and says so in the table; a requeue after a park with a question, or after a
failed preflight or spawn (no worker ran), keeps the model. A malformed row, an unknown key
included, holds spawns under `STALLED`.

Either form may add `finder=<alias>` (an alias such as `haiku`: the Agent tool takes no full model
name) and `text=<model>`, both unset by default. A worker launches
every self-review finder on the finder model (`desk-env model finder`; desk-review names it in its
header), and a Stage 7 session spawned from a handoff runs on the text model, which the queue's
`model` and the report's `spawned` line show. Unset, finders run on the model they do today and the
Stage 7 session on the ticket's tier. Every
preflight also asks each one set for one word on its own, so a value the CLI rejects fails the
preflight with a `FINDER` or `TEXT` line naming the row and the value, and no worker spawns. Neither
is set until the eval harness shows finding quality holds on the cheaper model.

**Where workers run is config §3b "Worker location"**: `local` (also when the row is absent) or
`cloud`. Cloud workers are not available yet, so every worker runs locally either way, and at
`cloud` the batch plan's `workers:` line says so. Any other value refuses the plan, naming the row.

A worker whose log has not grown for 6 passes is **stopped and parked**, freeing its slot, unless
its last marker is `AUTOPILOT_DONE`: a worker that finished and then hung is stopped and recorded
done with its PR, on the first pass that reads the marker. A worker waiting at the 5-hour usage
limit is not stalled: where config §3 `autopilot-usage-resume` is `yes` the pass reports it as
paused until the reset and lets it resume, and otherwise it stops and parks it with the reset time
(orchestrator-recovery.md). Log growth
alone can lie (a hung `codex exec` heartbeats into the log for hours), so on a batch that has gone
quiet, check the log tail's newest `tool_progress` `elapsed_time_seconds` too. Recovery for both is
in `references/orchestrator-recovery.md`.

**Stages 4b and 7 run in a fresh session.** A worker ends its session after Stage 4 and after
Stage 6 with `AUTOPILOT_HANDOFF: 4b` (or `7`) and a handoff briefing in
`$DESK_STATE/handoffs/<TICKET>.json` (the Stage 4 contract file's "Handing off"). The next pass spawns a new
session for the same ticket, worktree and branch, ahead of new tickets, starting at that stage with
the handoff briefing in its system prompt in place of the sibling notes (`spawned: … fresh session
from Stage 4b (handed off)`). A worktree or branch that has gone, or a briefing that cannot be read,
parks the ticket naming it and spawns nothing. Each session's log is a round of its own, so the
batch report's row adds every session's tokens and cost. A requeue of a ticket whose handoff session
parked or failed starts again at the stage that handoff named (`queue.mjs set <TICKET>
handoff_stage=null` first starts it from Stage 0); one that finished, and is sent back for rework,
starts from Stage 0.

**A requeue after a park at Stage 3 or later resumes that round.** When a worker parks, the pass
records the stage it reached and its question on the ticket (`last_round`). The fresh spawn after a
requeue starts at that stage, with a summary of the round in its briefing: the stage, the park
question and the answers recorded since, and the branch and its commits (`spawned: … resumed at
Stage 4, where its last round parked`). A park before Stage 3, a worktree removed for a fresh branch,
and a stalled or failed worker start at Stage 0 as before. So does a worktree on another branch, or
a resume file there that records another branch: the briefing says why, and the worker's first stage
line repeats it.

## Concurrency and memory

Default **2**, cap **3** (config §3b "Autopilot worker concurrency" can change either), and it is
**re-decided every pass, not set once** (a count the user set is kept while memory allows, below).
RAM binds before CPU, and the 5-hour and 7-day usage limits
are account-level, shared with the user's own sessions. Worker ports start **one above** config §3b
"Preferred dev-server port" (`AUTOPILOT_PORT_FLOOR` overrides), skipping any port another ticket
holds or anything bound. Where §4 Local database is set and §3 `db-per-ticket` allows, each ticket
gets its own database; otherwise every §4 Database URL variable in its worktree is blanked, and a
ticket that needs a database parks. Shared local services (§4 Local services: a search index, a cache) cannot be
isolated, so workers park rather than rebuild them.

Count a worker at ~0.5GB idle and ~3GB in its heavy stages (typecheck, lint and specs in its own
worktree, plus a dev server if it takes screenshots) and an uncapped parallel test fan-out at ~10GB.
Budget against config §3b "Memory ceiling for parallel work (GB)", never against what the OS
advertises.

**Two numbers, two questions. Using the wrong one has thrown a batch in both directions:**

| Question | Read |
|---|---|
| How big has the footprint grown? | `vmmem`: Linux `MemTotal - MemFree`; macOS total minus free pages |
| Is there room to start something? | `avail`: Linux `MemAvailable`; macOS free + inactive + purgeable |

`desk-env mem status` prints both plus total process RSS. They diverge badly (by several GiB at the
same instant) so **gate a spawn and the sustained-high watch on `avail`**, and report `vmmem` as the
footprint, using RSS to tell live work from page cache. Never alert on `vmmem`: it counts page
cache, so on macOS it sits over the §3b ceiling while tens of GiB are free to start work. `free`'s
`used` column is a third number, wrong for both: it excludes page cache.

**Spikes are fine. Sustained is the problem.** A test fan-out at the ceiling for ninety seconds is
the system working; `avail` under the reclaim band held five minutes or more with no suite or
typecheck running to explain it is what destabilises the machine. Do not throttle on a spike: over-caution that slows the
batch is a failure too.

**The ladder, read at the top of every pass** (config §3b "Spawn gate (available memory)" can move
the bands):

| `avail` | Do |
|---|---|
| > 8 GiB | a count the user set (`concurrency_by` is `user`): keep that number. Otherwise use the §3b default, going one higher, up to the cap, only after a slot sat idle a whole pass |
| 4–8 GiB | hold: finish what is running, spawn nothing new this pass |
| < 4 GiB | drop to 1 (`set-batch concurrency=1`, and leave `concurrency_by` as it is); a worker mid-suite will drain, so wait a pass before touching anything |
| < 2 GiB **and** sustained | reclaim (where §3 `autopilot-reclaim` is `yes`): kill an orphaned dev server or a stale typecheck first, never a worker mid-commit, never a process another session owns |

**On a computer running the runner VM, its memory is a fixed reservation.** While the desk-runner VM
runs, the machine profile's `runner-memory-reserved-gb` is held back from `avail` before the ladder
reads it, less what the VM already holds (which `avail` has already lost), because CI can fill the
rest at any moment. `pass.mjs` gates on that figure and its memory line, like `desk-env mem status`,
shows `runner=<n>G reserved (<r>G resident, <h>G held back) ladder=<x>G`; read the bands against
`ladder=`. Without a running VM, or with no reservation in the profile, nothing is held back and the
line carries neither.

Lowering is silent but **reported**: say which number caused it. Raising back needs the same
evidence. The ladder is what the "machine looks idle" red flag guards: a fan-out sized from the
guest figure can take the whole VM down and kill every agent mid-flight.
An OOM leaves a worker's worktree, database and port behind.

**A worker count the user set is theirs.** When the user names a count (or 0 to pause new spawns),
record it as theirs with `set-batch concurrency=<n> concurrency_by=user`; the queue keeps their
number as `concurrency_user`, and the pass report's `workers:` line says whose the count is. While
memory is above the gate it wins over the §3b default: never pull it back to the default. Memory
still lowers it: lower with `set-batch concurrency=<n>` alone and leave `concurrency_by` as it is.
When raising back, return to the user's number (`concurrency_user`, which the `workers:` line
names), not to the §3b default. `set-batch concurrency_by=null` hands the count back to the ladder.

**Borrowing idle workers is config §3b "Borrow idle workers"**, `off` unless it is `on`. At `on`,
a pass may start workers above the batch's own number, up to the §3b cap, into machine slots that
other live batches are not using. The machine total comes from the machine profile's
`autopilot-concurrency` cap, less the running workers in every queue. The batch takes those free
slots for its own number first, then borrows what is left after each other live batch below its own
number has its first claim (as many as it has ready tickets for). It reads every queue and writes
only its own. Counting and starting happen under one lock shared by every repo, so two passes cannot
take the same slot. Running work is never stopped: when the lender has ready tickets again, the
borrower starts nothing new, and a lender with borrowing on that comes back to a full machine starts
its own as the borrowed workers finish. The memory gate still stops everything. A `borrowing:` line
under `workers:` says how many were borrowed, or why none were: a first claim, a full machine, the
cap, the gate. Where the slots cannot be counted (another repo's queue unreadable, no machine
profile, the lock held past two minutes), the batch starts up to its own number as with borrowing
off, and the line says why. Borrowed workers are not a reason to lower the count: the ladder leaves
the batch's own number as it is.

**Run the watch yourself: do not hand it back to the user.** Two `Monitor`s for the life of the
batch: the status watch (`node ~/.claude/desk/bin/queue.mjs watch`), which prints the table and the
memory line (`vmmem=`, `avail=`) at start, then again only when a ticket's state or question
changes (a stage step alone does not wake you; `--stages` restores it), checking every 90 seconds (`--interval <s>` to change it), or at §3b "Orchestrator status table" `quiet` one line
per ticket that changed (*The status table*); and a sustained-high watch (`desk-env mem watch`) that
fires only on `avail` below the ladder's lowest band (2 GiB, or a lower band the §3b row names) held
5 minutes with nothing heavy running to explain it. Run each under `Monitor` exactly as written:
never write a shell loop around `render` and `mem status` instead, which Claude Code prompts on every
time. Both keep their state in the process, so re-arm one when its `Monitor` expires. Killing a
runaway process is a call to make from the monitor, not a park.

**Test runners ignore the cap unless it is on the command line**, so seed the worker-count flag
(`--maxWorkers=<cap>`, appended **only** to a Jest or Vitest command; never to pytest or another
runner, which rejects it) into `batch-notes.md` (the header does) and `SendMessage` any worker seen
over it.

### On WSL (config §2 "Running on WSL?" = yes)

`free -h` and the guest's `MemTotal` report the `.wslconfig` grant, but VmmemWSL can only grow as far
as **Windows has free RAM**, and nothing in the guest can see that. On a 31.7GB host with ~13GB held
by Windows and a 24GB grant, the working ceiling was ~16GB, ~19GB on swap, and concurrency 4 tripped
host exhaustion within 15 minutes while guest `avail` still read 7.4GB, so the ladder alone said only
"hold". Run a third `Monitor` on the host figure: Windows free under 3GB for 2 minutes:

```bash
powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB"
```

Before acting on an alert, split it: a large `Cached` with low `AnonPages` in `/proc/meminfo` is page
cache WSL returns lazily (`autoMemoryReclaim=gradual` in `.wslconfig` helps). If the host is low while
VmmemWSL is under the ceiling, the pressure is on the Windows side and lowering concurrency will not
fix it.

## Sharing the machine

Assume you are never alone: the user runs interactive sessions alongside you and often a second
batch, possibly in another repo, so coordinate, and do not run out of memory on spikes such as test
runs or the PR image upload. Batch state is per repo; these four resources are machine-wide, and
each has cost a run.

**Handshake at Stage 0b, before any worker spawns.** `ListAgents`, then one `SendMessage` per live
session stating your repo and batch, worktrees, port range, the files your tickets touch, and your
test-lock and test-worker cap, and asking the same four back. Re-send when a new session appears.
What a peer says it holds beats anything you can measure, and a peer's heads-up ("full suite in five
minutes") is the only warning before a 10GB spike.

| Resource | Protocol |
|---|---|
| **Test suites** | One at a time machine-wide, via `~/.claude/desk/bin/with-lock.sh test --cwd <dir> -- <cmd>` (unit, integration, E2E; `<dir>` and `<cmd>` from `desk-env cmds test-cmd`) and `with-lock.sh tsc --cwd <dir> -- <cmd>` (same lock). No timeout, no bypass; waiting is the feature. Two database-backed integration runs also collide on their per-worker schemas for the whole run, so announce integration runs to peers. |
| **GitHub PR image upload** | One signed-in browser profile (config §2), so it is exclusive. `pass.mjs` serialises it *within* your batch; across sessions claim it by message before `upload-images.mjs` runs and release it by message immediately after. Screenshot *capture* uses Playwright's own browser and `with-lock.sh browser`, and is safely concurrent: do not serialise the wrong one. Never delete the profile's `SingletonLock`. |
| **Ports** | Yours start above the user's dev port. Publish your range, treat a peer's as claimed, and never kill a server you did not start however idle it looks. |
| **Files** | Exchange diff surfaces at handshake. `plan-batch` finds collisions inside your batch only; the cross-batch one can only come from the peer. |

**Probe the lock, do not trust it.** Test it once at Stage 0 with
`~/.claude/desk/bin/with-lock.sh test true`. If workers report it refused, serialise Stage 4
yourself (one worker in a suite at a time) and say in the report that the lock is not covering them.

**The memory rules are seeded, not remembered.** `queue.mjs init` backs up
`<state>/batch-notes.md`, resets it, and re-seeds `references/batch-notes-header.md`, so the test
cap and the lock survive an init. If another orchestrator is live, `init` keeps the file instead of
resetting it, because that batch's workers still read it. Check the `## MEMORY` heading is there
after `init`; if it is not, add `references/batch-notes-header.md` to the end of the file with the
Edit tool (Write if the file is missing), not a shell redirect. The rules also live in the worker
contract, which is never truncated.

## Commands

```bash
# Written exactly as the harness rules name them (permission-rows.md), so they match without a
# prompt: `node ~/.claude/desk/bin/<x>.mjs`, `~/.claude/desk/bin/<x>.sh`, `desk-env`. Never via a
# shell variable such as $B: no allow rule matches a variable path. <state> is DESK_STATE from
# `desk-env paths`, written out in full.
node ~/.claude/desk/bin/expand-parent.mjs ABC-900                     # an epic -> its batch keys (stdout), drops on stderr
~/.claude/desk/bin/triage.sh ABC-123                                  # read-only, no worktree
AUTOPILOT_WRITE_QUEUE=1 node ~/.claude/desk/bin/plan-batch.mjs --json ABC-GATE ABC-123 ABC-124   # gates first: arg order = spawn order
node ~/.claude/desk/bin/answer.mjs ABC-123 "<answer>"
node ~/.claude/desk/bin/pass.mjs --json                               # one pass; drive with /loop unless the supervisor runs passes; exit 0 go on, 10 nothing yet, 11 show the person
node ~/.claude/desk/bin/queue.mjs next-pass +1500                     # after scheduling the next pass: when it runs (here 25 minutes), so desk-q counts the batch live until then
node ~/.claude/desk/bin/supervisor.mjs install                        # passes and the merge driver from launchd, at login and every 3 minutes
node ~/.claude/desk/bin/supervisor.mjs status                         # exit 0 while installed and loaded; uninstall removes it
node ~/.claude/desk/bin/run-by.mjs stage4                             # Stage 4: who runs the batch (§3b Batches run by); installs the supervisor at supervisor; exit 11 an install failed
node ~/.claude/desk/bin/queue.mjs set-batch supervised=true approved.workers=true   # Stage 4 with the supervisor: only the approvals the user gave
node ~/.claude/desk/bin/queue.mjs set-batch approved.undraft=true     # Stage 3: §3 pr-ready is ask and the user approved undrafting this batch's clean PRs
node ~/.claude/desk/bin/queue.mjs set-batch approved.merge=true       # Stage 3: §3 autopilot-merge / pr-merge-green are ask and the user approved merging this batch's green PRs (=false when declined)
node ~/.claude/desk/bin/desk-env.mjs merge-grant                      # config, batch or none, and why: whether the merge driver may merge this batch
node ~/.claude/desk/bin/queue.mjs render                              # status
node ~/.claude/desk/bin/queue.mjs front ABC-123                       # move a released ticket to the front of the spawn order (one the user placed stays put)
node ~/.claude/desk/bin/queue.mjs move ABC-123 2                      # the user's order: position among unfinished tickets, or `last`; marks it placed
node ~/.claude/desk/bin/queue.mjs hold ABC-124 ABC-123               # hold a ticket behind a blocker (recorded; released on its merge)
node ~/.claude/desk/bin/queue.mjs admit ABC-125                      # add one triaged ticket mid-batch (never re-run plan-batch to do it)
node ~/.claude/desk/bin/intake.mjs run --force                        # standing intake now (§3b Intake query); the supervisor runs it every 15 minutes
node ~/.claude/desk/bin/intake.mjs forget ABC-127                     # a ticket intake handed to the digest, once fixed: the next intake tries it again
node ~/.claude/desk/bin/spine-review.mjs brief ABC-126                # the read-only reviewer's prompt for a spine awaiting approval
node ~/.claude/desk/bin/spine-review.mjs questions ABC-126 <reply>    # one approval question per spec, with the review's findings
node ~/.claude/desk/bin/queue.mjs approve ABC-126                     # the person approved a feature spine's specs: done, undrafted, merges
node ~/.claude/desk/bin/queue.mjs reject ABC-126 "<note>"             # the person sent the spine's specs back: requeued with the note
node ~/.claude/desk/bin/harvest.mjs <state>/logs/ABC-123.log
AUTOPILOT_DRY_RUN=1 …                                                 # no push, no PR, no review post, no Jira writes
AUTOPILOT_USER_APPROVED=1 node ~/.claude/desk/bin/pass.mjs            # only when §3 autopilot-workers is `ask` and the user confirmed this batch
AUTOPILOT_BASE_PUSH_APPROVED=1 node ~/.claude/desk/bin/pass.mjs       # only when §3 batch-base-push is `ask`/unset and the user approved syncing this batch's base
AUTOPILOT_ALLOW_NO_CODEX=1 node ~/.claude/desk/bin/pass.mjs           # codex-review is yes but codex is not installed: accept same-vendor reviews knowingly
nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2" --deps "ABC-2:ABC-1" --log &   # output to <state>/merge-driver.log; not for a batch handed to the supervisor

# config
desk-env where                   # which repo, which config, does it exist
desk-env ids                     # every §3 key and config row the scripts read, and its value
desk-env perm codex-review       # one permission: yes|ask|no|never|stop (missing/TODO -> no)
desk-env budget worker           # 25 | none; exit 4 if malformed

# resource management
desk-env mem status              # vmmem= avail= rss=
desk-env heavy                   # suites, typechecks, dev servers actually running (never pgrep -f)
~/.claude/desk/bin/with-lock.sh test true   # probe the lock once
# no `## MEMORY` heading in <state>/batch-notes.md: Read references/batch-notes-header.md and add it
# to the end of batch-notes.md with the Edit tool (the Write tool if the file is missing), never a
# shell redirect, which writes outside the working directory and prompts every time

# the two Monitors, started once at Stage 0b (change-only; the second fires on sustained only)
node ~/.claude/desk/bin/queue.mjs watch   # table + memory line at start, then only on a state or question change, not a stage step (--stages adds them; quiet: one line per changed ticket); every 90s, or --interval <s>
desk-env mem watch               # SUSTAINED-HIGH: avail=<x>G below <band>G for 5m with nothing heavy running

# apply the ladder — top-level field (a lowering leaves concurrency_by as it is)
node ~/.claude/desk/bin/queue.mjs set-batch concurrency=1
# a count the user asked for (0 pauses new spawns)
node ~/.claude/desk/bin/queue.mjs set-batch concurrency=4 concurrency_by=user
```

The keys above can be any of the three kinds: a tracker key, an §4 Other work id patterns id, or (Tracker `none`) `issue-<n>` or the slug stated at Stage 2.

`pass.mjs` re-reads `concurrency` from the queue on every pass, so the ladder is applied by editing
that one field between passes: never by hand-spawning, and never by holding tickets out of the batch.

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
