---
name: desk-autopilot
description: >-
  Use when the user hands over a batch of tickets in this repo to work unattended: "run ABC-1005
  ABC-1008 ABC-763", "work through these tickets", "do these issues while I'm out", "pick the batch
  back up". Tickets are keys matching the repo's ticket key pattern or, where the repo has no
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
parked work to wait. Workers see two deltas: `references/autopilot-worker-contract.md`, and the
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
| §3b "Autopilot worker concurrency", "Memory ceiling for parallel work (GB)", "Test worker cap under the test lock", "Autopilot per-worker budget (USD)", "Autopilot batch budget (USD)", "Preferred dev-server port" | the ladder, the test cap, spend guards, and the port workers must never take |
| §4 "Tracker", "Ticket key pattern" | what a batch argument is, and what the scripts accept as a key |
| §4 "Required checks", "Branch protection", "Merge method", "Repo merge settings" | what "green" means, and how the driver merges |
| §4 "Local review command", "Clean review verdict" | what a worker runs at Stage 4b, and what "reviewed with no findings" reads as |
| §4 "Local database", "Local services", "Vercel" | per-ticket databases; what workers must not rebuild; preview-build logs |
| §4 People | whose call a parked question is |

The scripts look §3 up by its **key** and other rows by exact row name, through one map in
`desk-env.mjs`. A missing row, a blank or a `TODO` is `no`, never a neighbouring row's value.
`desk-env ids` prints every lookup and what it resolved to: run it at Stage 0 when a script refuses.
The budgets must be a positive number of USD or `none`/`off`/`no cap`; anything else ("25 USD")
refuses to spawn rather than reading as no cap.

### A batch where §4 Tracker is `none`

The arguments are GitHub issue URLs (or `#<n>` numbers on §0 GitHub repo) and, where the user gives
them, short quoted descriptions. Each gets the key `desk-ticket` would give it: `issue-<n>`, or a
kebab-case slug of the description stated back to the user at Stage 2. That key names the queue
entry, worktree, branch, log and screenshot directory. If §4 Ticket key pattern is set anyway (task
ids from the repo's own planning files), arguments matching it are keys as usual.

Everything Jira-shaped drops out: the Jira rows of the §3 table below do not apply, workers skip
`desk-ticket`'s Jira stages, and "unassigned or yours" means a GitHub issue with no assignee or
assigned to §1 GitHub handle (a description the user typed is theirs by definition). **If an
installed script refuses a key that is not a §4 Ticket key pattern match** (the merge driver's
`--tickets`, `plan-batch`, `triage.sh`), stop and say which script and which key: never reshape a
slug to look like a ticket key to get past it.

**Workers cannot ask, so §3 decides up front what they may do.** `worker-settings.mjs` (run by
`spawn-worker.sh`) turns every worker row below that is not `yes` into deny rules (by bare name, by
the absolute path `command -v` resolves, and in `git -C <dir> …` form) and tells the worker which
keys, as `CONFIG_DENIED: <key> (<setting>)`, so it parks with the exact payload instead of attempting.
Enforcement is the rule, not the wording: see the contract §2.

**These rules catch mistakes, not a deliberate workaround.** Git accepts bundled and abbreviated
flags (`-qf`, `--force-w`, `--delet`), which no pattern can list, and workers may run `node`,
`python3` and the §4 Package manager. A stray `--force` or a push through `git -C` is stopped; a
worker set on getting round the rules is not. The contract is what keeps a worker in bounds, so
never widen a worker's grants on the strength of the deny list.

| §3 key | `yes` | anything else |
|---|---|---|
| `autopilot-workers` | `pass.mjs` spawns workers; `triage.sh` runs | `ask`: `triage.sh` still runs (read-only, foreground); confirm the batch at Stage 3, then run passes with `AUTOPILOT_USER_APPROVED=1`. `no`: neither runs; say so |
| `git-push`, `pr-open`, `pr-edit` | worker pushes / opens the draft / edits the body | worker parks at that step with the branch or PR body; you ask, then do it |
| `pr-self-review-comment` | worker posts the §4 Local review command's report (`gh pr review`, `gh pr comment`) | worker parks with the report; you ask, then post it |
| `pr-reply` | worker may write through `gh api` (explicit methods, graphql mutations, REST fields) | those `gh api` forms are denied |
| `pr-update-branch`, `ci-rerun` | worker may `gh pr update-branch` / `gh run rerun`; the merge driver reruns completed red runs | denied to the worker; the driver logs the red run and leaves it for you |
| `jira-comment`, `jira-transition`, `jira-create`, `jira-edit` (Tracker `jira` only) | worker posts / moves / creates / edits (`edit`, `labels`, `attach`) itself | worker parks with `desk-jira`'s block; relay it verbatim (Stage 6c) |
| `codex-review` | workers get `codex`; the preflight asserts `CODEX=OK` (fails if codex is missing, unless `AUTOPILOT_ALLOW_NO_CODEX=1`) | `codex` is denied and the preflight asserts `CODEX=BLOCKED`; refutations are same-vendor, and where a required check demands a cross-vendor verdict those PRs cannot pass it: say so |
| `pr-images` | `pass.mjs` uploads automatically | `pass.mjs` reports the directory; ask, then run the uploader with `DESK_UPLOAD_APPROVED=1` |
| `read-figma` | workers get the Figma read tools | a ticket needing the frame parks |
| `pr-ready`, `pr-auto-merge` | you undraft (and arm auto-merge, where §4 Repo merge settings allow it) once the checks in Stage 7 hold | report the PR as ready to undraft |
| `autopilot-merge` **and** `pr-merge-green` | the merge driver merges on green (it arms `--auto` only where `pr-auto-merge` is `yes`) | the driver refuses to start (exit 1); report green PRs to the user |
| `merge-feedback-first` | the driver skips a PR with `CHANGES_REQUESTED` or an unresolved thread, and disarms its auto-merge | the checks alone decide; feedback is still worked and reported |

Never widen a row because the batch would go faster. Offer `/desk-setup` instead.

## Your context must stay flat

You are a reader. Each pass re-derives state from disk and forgets it.

- Never read ticket code, a worker's transcript, or more than a log tail on failure.
- Never carry "ABC-940 needs X, ABC-1009 hit Y" between passes: that is the queue's job.
- If your context grows with the batch, you are doing the workers' work.

## Stages

| # | Stage | What happens |
|---|---|---|
| 0 | Claim | `queue.mjs init`. `pass.mjs` takes an exclusive lock at `<state>/orchestrator.lock` and refuses to run if a live orchestrator holds it; a lock from a dead process is taken over automatically. Each pass also writes a heartbeat under `<state>/orchestrators/`, so another batch's `init` sees this one between passes (fresh = under 15 minutes). `init` backs up and re-seeds `batch-notes.md`: **check the `## MEMORY` heading is there**. See *Sharing the machine*. |
| 0b | Share the machine | `ListAgents`, handshake every live session (in any repo: the machine is shared even where the state is not), start the memory monitors. Before any worker spawns, not after. See *Sharing the machine*. |
| 1 | Triage | `triage.sh` per ticket: read-only, no worktree. Returns lane, files, unknowns, `renders`, and `prior_art`: any branch already touching those files, which changes the shape of a ticket more than its description does. |
| 1b | Challenge | Only for a ticket triage put in **C or D**. A second read-only pass re-derives the lane and either confirms it or downgrades to A, B or E. It can never upgrade, and a missing or malformed verdict leaves the first pass untouched. `AUTOPILOT_SKIP_CHALLENGE=1` turns it off. See *Why C and D get a second look*. |
| 2 | Plan | `plan-batch.mjs`: ownership, admission, collisions, and the question batch. Then **set the merge order yourself**: see *Order the batch by blast radius*. Admit only work the batch can finish whole: a ticket that is doable except for a design, copy or product call is a question, not a partial run. |
| 3 | Ask once | Every unknown across every ticket, in **one** round, **always via `AskUserQuestion`**, never as prose in the report. Include any §3 `ask` the batch will hit (headless workers, upload, merge). Wait. This is the whole promise. See *Asking*. |
| 4 | Run | `pass.mjs`, self-paced via `/loop`. It preflights, spawns, harvests, reports. **Re-read the ladder at the top of every pass**: concurrency is a per-pass decision, not a batch setting. Start the merge driver now, before the first worker finishes. |
| 5 | Answer | `answer.mjs <TICKET> "..."` records the answer in the briefing. **It does not resume a parked ticket**: `pass.mjs` only spawns `triaged`, and the worker has already exited. Finish the parked step yourself or requeue per `references/orchestrator-recovery.md`. For a *running* worker, `SendMessage` it. |
| 6 | Images | Where config §3 `pr-images` is `yes`, `pass.mjs` runs `upload-images.mjs` when a worker prints `AUTOPILOT_IMAGES:`: serialised, one PR at a time, never a worker. There is **one signed-in browser profile machine-wide** (config §2), so claim it from peer sessions by message first and release it the moment you are done. Only `0 placeholder(s) left` counts as uploaded. Placeholders left (uploader exit 4) or none matched (exit 3) sets `images_uploaded=partial`, saves the output to `<state>/images/<TICKET>.upload.log` and reports it under `WAITING ON YOU`: fix the body's `_drag <file>_` cells from the saved tags, do not re-upload (the assets already exist). |
| 6b | Notify | When a pass reports `WAITING ON YOU` or `PARKED`, send **one** `PushNotification` covering everything that pass surfaced (where §3b "Push notification when a batch needs you" is `yes`). Never one per park: they are coalesced deliberately. Say the ticket and the question in one line each. |
| 6c | Relay a gate | When a worker parks on a write config §3 did not grant (most often the Jira comment), reproduce `desk-jira`'s block **verbatim**: `JIRA COMMENT — awaiting approval` (or `JIRA TICKET`/`EDIT`/`TRANSITION`), target, fields, then the exact body. Never paraphrase it. The user must read the exact string that is about to be public; a summary defeats the gate while looking like it honoured it. The same holds for a parked PR body or review report. |
| 7 | Merge | The moment a PR's required checks are green, **merge it** (where granted): do not collect PRs and merge at the end. See *Merge each PR the moment it goes green*. |
| 8 | Report | What is merged, what is parked and on whom, what is still running. **Emit the status table on every stage change**: see *The status table*. |

Idle = every ticket merged, parked or failed. Say so and stop. Do not invent work. **Never
transition a ticket to §4 Done state** (and with no tracker, never close an issue), and never treat
a triage "already fixed" as grounds to close one: a per-criterion check once overturned four of six
such verdicts.

## Order the batch by blast radius

`plan-batch` finds collisions; it does not decide sequence. **You do, at Stage 2, from the
`files_in_scope` triage already gave you**, and the order is a merge order, not just a spawn order.

**Largest blast radius first.** A ticket that *moves, renames or deletes* files must land before any
ticket that *edits* them. Rank by how much of the tree a ticket disturbs:

1. moves, renames, deletions of whole directories, and new shared packages
2. schema and migration changes
3. shared components, design-system primitives and translation files
4. ordinary single-surface work

The reason is asymmetric: a rename landing after an edit conflicts badly and git will not follow an
*added* file across it, so the edit's new files strand at the old path. The same two tickets in the
other order usually merge cleanly.

A relocation merged mid-batch re-breaks every remaining ticket that touches what it moved: a
conflict resolution and a re-review each, severed migrations, deleted files silently resurrected.
Merged first, it costs none of that.

**Say the order and why in the Stage 2 report**, and put it in the status table's Notes so a reader
can see a queue position was chosen rather than arbitrary. Where two tickets genuinely cannot be
ordered (each edits what the other moves) say so and merge the smaller one first, so only one of
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
ticket is released move it to the front with `queue.mjs front <TICKET>`, or it waits behind every
independent ticket. A released ticket's `collides_with` still blocks it while that worker runs, so
clear the entry too if you release it early.

**Colliding tickets are serial to the merge, not to the worker** (§5 Batches): as soon as a PR is
done it gets merged, and then work starts on the next ticket. `pass.mjs` only holds a
collider back while the other one's *worker* is running. So chain them yourself: park each successor
with a `held by orchestrator: … starts once <TICKET>'s PR merges` reason, and pass the chain to the
merge driver as `--deps`, which releases it (`state=triaged`, moved to the front) once that PR has
merged. Tickets that share no files run in parallel lanes up to the concurrency cap, and each lane
stays serial.

## Merge each PR the moment it goes green

**An open PR is not a finished ticket, and holding several open is what makes a batch expensive.**
Every merge moves `<default>`, and every PR still open has to absorb that move: a conflict to
resolve, a new head SHA, and, where a required check matches the review verdict against the *exact*
head, a whole fresh review and CI run. The cost is quadratic in how many you hold: the last of a
batch carried to all-open-before-any-merged pays a conflict resolution and a re-review for each PR
ahead of it, none of which exist had each merged when it first went green.

**This section applies as written where config §3 `autopilot-merge` and `pr-merge-green` are both
`yes`.** Where they are not, do everything below except the merge itself: undraft (if `pr-ready`
allows), keep the checks green, and put each green PR in front of the user the moment it flips: the
cost of holding PRs open is the same, so say so rather than letting them queue.

**"Green" is §4 Required checks, every one passed.** With that row `none`, it is every check on the
PR. §4 Advisory checks never block, and never count as green either. With §4 Branch protection
`none`, GitHub will accept a merge with red checks, so the rule is enforced only by you and the
driver: a missing, pending or red required check is not green.

**Start the merge driver at Stage 4, before the first worker finishes: do not merge off your own
turn cadence.** Merging tied to when a monitor happens to wake you is how a PR sits green and
unmerged: nothing undrafts, arms or retriggers it until the orchestrator's next turn.

```bash
nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2 ABC-3" --deps "ABC-3:ABC-1" \
  >> <state>/merge-driver.log 2>&1 &
```

It loops every ~2 minutes over the batch's **ready** (non-draft) PRs by config §1's handle, **one at
a time**: skips (and disarms) a PR with outstanding review feedback where `merge-feedback-first` is
`yes`, arms `--auto --<§4 Merge method>` where `pr-auto-merge` is `yes`, merges outright with §4
Merge method when the required checks are green, skips a `DIRTY` PR, and, where `ci-rerun` is
`yes`, retriggers `gh run rerun <id> --failed` only once that run has reached `completed`. It never
undrafts. `--tickets` takes whitespace- or comma-separated keys and refuses (exit 2) anything that is
not a key for this repo (§4 Ticket key pattern, or the Tracker-`none` key form), and `--deps` anything
not `<key>:<key>[,<key>…]`. Only one driver runs at a time (`<state>/merge-driver.lock.d`); a second
exits 1 naming the holder's pid. Two things it must get right or it makes the problem worse: **never
retrigger a run that is not `completed`** (per-PR `cancel-in-progress` kills the run in flight, and a
loop that re-reads too soon after a rerun sees the stale `completed` and fires again, starving the PR
forever) and **only one PR may be building a preview at a time** (see the preview-build cap below).

- **Merge on the required checks, not on the checks you like.** Other red checks are advisory. Read
  them with `gh pr checks <n> --json name,state,bucket`, or `awk -F'\t'` on the plain output: it is
  tab-separated and a name column that carries an emoji makes splitting on whitespace silently yield
  the wrong word instead of the verdict, and nothing ever merges.
- **Never bypass them.** `--admin` is not yours to use (`merge-bypass` is `never`).
- **A review gate can fail on a PR's first CI run when the review posts late.** Where a required
  check reads the posted review verdict: opening the PR triggers CI seconds before the worker posts
  its review. If the gate polls for the verdict briefly, a review posted inside that window passes
  the same run. Posting starts no run of its own: CI typically runs only on open, reopen and push.
  Otherwise confirm the verdict's SHA equals `headRefOid` and re-run the whole failed set once the
  run is `completed`. With auto-merge armed, clearing the gate is the merge.
- **A PR that has gone `DIRTY` merges nothing.** Resolve it, then expect the re-review: that is the
  cost this stage exists to avoid paying seven more times. A conflict in a generated file (one whose
  header says it is generated) is resolved by taking `<default>`'s version and re-running only that
  generator.
- **Undraft only once the PR is done and reviewed with no findings**, and only where config §3
  `pr-ready` is `yes` (arm auto-merge only where `pr-auto-merge` is too), then do whatever is needed
  to merge it immediately. Done and reviewed means the review verdict on the PR's **current**
  `headRefOid` reads as §4 Clean review verdict with nothing deferred and no requirement gaps, the
  screenshots are uploaded (or the body says nothing renders differently), and `mergeStateStatus` is
  not `DIRTY`. A review gate may pass with gaps open, so a gap count above 0 is a question for the
  user, not a merge: keep it draft, since the driver merges any ready PR that goes green. With §4
  Local review command `none`, there is no verdict: "reviewed" is then the user's call, so report the
  PR rather than undrafting it. A clean verdict on a conflicted head is spent the moment the conflict
  is resolved. Workers are denied `gh pr ready`, so check these facts yourself, then `gh pr ready` and
  `gh pr merge --<§4 Merge method> --auto` in the same breath. Undrafting earlier pings the reviewer
  before the evidence is in.
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

**Every stage change gets a table, not a sentence**, so the user can see each ticket and its state
at every stage. A prose line about the one ticket that moved makes the reader reconstruct the
other six from memory, and silence between spawn and PR reads as nothing happening.

Emit it whenever the status monitor fires with a real change: a stage advance, a spawn, a park, an
unpark, a PR landing. Not on memory jitter, and not on a pass that changed nothing.

| Ticket | State | Stage | Port | Notes |
|---|---|---|---|---|
| ABC-1200 | 🟢 Running | 5/9 | 3001 | one line: the gate, blocker or decision that matters |
| ABC-1208 | ⏳ Queued | — | — | its position when the order was set deliberately |
| ABC-1166 | 🅿️ Parked | — | — | what unparks it |
| ABC-1181 | ✅ PR #NNN | — | — | the PR number once it exists |

- **Every ticket in the batch, every time**: parked and queued rows included.
- **Mark what changed** (an arrow, a bold cell) so the delta is findable without diffing.
- **Carry `vmmem=` and `avail=`** with it, since the ladder decision is read from those two numbers.
- **Notes stay to one line.** The full park reason lives in the queue.

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
unfalsifiable; there the test is whether the work is mechanical and bounded.

**A confirmed park can still be wrong, because both passes can share one over-estimate.** A park on
size CONFIRMED by counting new things to build can be lane A in a handful of files when every one has
an existing pattern on `origin/<default>` to copy. Before reporting any park on size, check each
thing the challenge calls "new" against `origin/<default>` and say what you found: report the doubt,
not the verdict. **Read the challenge line**: `plan-batch` prints `challenge CONFIRMED`, or
`! challenge did not run`: a single unreviewed opinion that must not be reported as settled.

**A lane is a proposal.** When the user says a park is wrong, re-lane with
`queue.mjs set <TICKET> lane=A state=triaged` and, where the ticket is genuinely big, scope it in the
briefing so what runs really is one sitting.

## Asking

Every question (a Stage 3 unknown, a mid-run park, a lane C or D ticket, a §3 `ask`) goes to the user
as an **`AskUserQuestion` carousel**, never as a numbered list in the report. One question per
decision, up to four per call; run another call for more, or hold the rest for the next round.

Each question carries a **recommended option first, labelled `(Recommended)`**, chosen by your own
judgement of the code you already have in hand. The remaining options are real alternatives. In each
`description` say what that choice costs: the migration it adds, the contract it touches, the
follow-up ticket it spawns. Defaults that need no real judgement can share one "accept these?"
question.

This does not soften *Never answer a parked question yourself*. The recommendation is a proposal the
user accepts or overrides; a park stays parked until they have chosen. A question you would have felt
able to answer alone should have been settled at triage, not asked here.

Two have no recommendation to give: a value only the user holds (a design URL, an asset, a
credential): offer the routes to it rather than inventing one; and a call that belongs to someone
else: name whose it is from config §4 People (product decisions: the product owner; design: the
designer, or the product owner where Designer is `none`; engineering and review: the code reviewer;
infra and security: that owner). Where a role is `you`, it is the user's own call and gets a
recommendation like any other.

## Task mode — a batch that is not "implement these tickets"

`spawn-worker.sh` takes **`AUTOPILOT_TASK`**: a prompt for a *fresh* worker that replaces the default
"work the ticket with desk-ticket" instruction. `$TICKET`, `$WT` and `$PORT` are substituted into
it, so one task string serves the whole batch. `AUTOPILOT_RESUME` takes precedence, but it does not
work through `pass.mjs`: see `references/orchestrator-recovery.md`. Set `AUTOPILOT_TASK` once in
`pass.mjs`'s environment and every worker gets it; the worker contract's section 0 says a task
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

A worker whose log has not grown for 6 passes is **stopped and parked**, freeing its slot. Log growth
alone can lie (a hung `codex exec` heartbeats into the log for hours), so on a batch that has gone
quiet, check the log tail's newest `tool_progress` `elapsed_time_seconds` too. Recovery for both is
in `references/orchestrator-recovery.md`.

## Concurrency and memory

Default **2**, cap **3** (config §3b "Autopilot worker concurrency" can change either), and it is
**re-decided every pass, not set once**. RAM binds before CPU, and the 5-hour and 7-day usage limits
are account-level, shared with the user's own sessions. Worker ports start **one above** config §3b
"Preferred dev-server port" (`AUTOPILOT_PORT_FLOOR` overrides), skipping any port another ticket
holds or anything bound. Where §4 Local database is set and §3 `db-per-ticket` allows, each ticket
gets its own database. Shared local services (§4 Local services: a search index, a cache) cannot be
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
same instant) so **gate a spawn on `avail` and judge health on `vmmem`**, using RSS to tell live work
from page cache. `free`'s `used` column is a third number, wrong for both: it excludes page cache.

**Spikes are fine. Sustained is the problem.** A test fan-out at the ceiling for ninety seconds is
the system working; the ceiling held five minutes or more with no suite or typecheck running to
explain it is what destabilises the machine. Do not throttle on a spike: over-caution that slows the
batch is a failure too.

**The ladder, read at the top of every pass** (config §3b "Spawn gate (available memory)" can move
the bands):

| `avail` | Do |
|---|---|
| > 8 GiB | concurrency 2; go to 3 only if a slot sat idle a whole pass |
| 4–8 GiB | hold: finish what is running, spawn nothing new this pass |
| < 4 GiB | drop to 1; a worker mid-suite will drain, so wait a pass before touching anything |
| < 2 GiB **and** sustained | reclaim (where §3 `autopilot-reclaim` is `yes`): kill an orphaned dev server or a stale typecheck first, never a worker mid-commit, never a process another session owns |

Lowering is silent but **reported**: say which number caused it. Raising back needs the same
evidence. The ladder is what the "machine looks idle" red flag guards: a fan-out sized from the
guest figure can take the whole VM down and kill every agent mid-flight.
An OOM leaves a worker's worktree, database and port behind.

**Run the watch yourself: do not hand it back to the user.** Two `Monitor`s for the life of the
batch: the pass report (90s, change-only, carrying `vmmem=` and `avail=`), and a sustained-high watch
that fires only on the ceiling held 5 minutes with nothing heavy running to explain it. Killing a
runaway process is a call to make from the monitor, not a park.

**Test runners ignore the cap unless it is on the command line**, so seed the worker-count flag
(`--maxWorkers` for Jest and Vitest) into `batch-notes.md` (the header does) and `SendMessage` any
worker seen over it.

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
| **Test suites** | One at a time machine-wide, via `~/.claude/desk/bin/with-lock.sh test …` (unit, integration, E2E) and `with-lock.sh tsc …` (same lock). No timeout, no bypass; waiting is the feature. Two database-backed integration runs also collide on their per-worker schemas for the whole run, so announce integration runs to peers. |
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
after `init`. The rules also live in the worker contract, which is never truncated.

## Commands

```bash
B=~/.claude/desk/bin; S=<state>              # desk-env paths prints DESK_STATE
$B/triage.sh ABC-123                         # read-only, no worktree
AUTOPILOT_WRITE_QUEUE=1 node $B/plan-batch.mjs ABC-GATE ABC-123 ABC-124   # gates first: arg order = spawn order
node $B/answer.mjs ABC-123 "<answer>"
node $B/pass.mjs                             # one pass; drive with /loop
node $B/queue.mjs render                     # status
node $B/queue.mjs front ABC-123              # move a released ticket to the front of the spawn order
node $B/harvest.mjs $S/logs/ABC-123.log
AUTOPILOT_DRY_RUN=1 …                        # no push, no PR, no review post, no Jira writes
AUTOPILOT_USER_APPROVED=1 node $B/pass.mjs   # only when §3 autopilot-workers is `ask` and the user confirmed this batch
AUTOPILOT_ALLOW_NO_CODEX=1 node $B/pass.mjs  # codex-review is yes but codex is not installed: accept same-vendor reviews knowingly
nohup $B/merge-driver.sh --tickets "ABC-1 ABC-2" --deps "ABC-2:ABC-1" >> $S/merge-driver.log 2>&1 &

# config
desk-env where                   # which repo, which config, does it exist
desk-env ids                     # every §3 key and config row the scripts read, and its value
desk-env perm codex-review       # one permission: yes|ask|no|never|stop (missing/TODO -> no)
desk-env budget worker           # 25 | none; exit 4 if malformed

# resource management
desk-env mem status              # vmmem= avail= rss=
desk-env heavy                   # suites, typechecks, dev servers actually running (never pgrep -f)
$B/with-lock.sh test true        # probe the lock once
cat ~/.claude/skills/desk-autopilot/references/batch-notes-header.md >> $S/batch-notes.md

# the two Monitors, started once at Stage 0b (change-only; the second fires on sustained only)
node $B/queue.mjs render | tail -n +2; desk-env mem status
[ "$(desk-env mem used | cut -d. -f1)" -ge "<§3b ceiling>" ] && [ -z "$(desk-env heavy)" ] && echo "SUSTAINED-HIGH: footprint over the ceiling with nothing running to explain it"

# apply the ladder — top-level field
node $B/queue.mjs set-batch concurrency=1
```

With §4 Tracker `none`, the keys above are `issue-<n>` or the slugs stated at Stage 2.

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
- A ticket in the batch the user did not name
- Reporting a lane-C/D park as settled when its challenge line says the pass did not run
- About to merge with branch protection `none` because GitHub would allow it
- About to rename a slug into a fake ticket key because a script refused it

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
| "The footprint is past the ceiling, I should stop the batch" | Spikes are expected. It is the ceiling held for minutes with nothing running to explain it that means something. |
| "`free` says 2.5Gi used, there is loads of room" | `free`'s `used` excludes page cache. It has read 2.5Gi while the host sat past 16GB. Read `avail`. |
| "I'll ask whether to throttle" | Decide from the monitor. Report the decision and the number behind it; do not park it. |
| "That idle dev server is wasting 1.2GB" | It is probably a peer's. Ask over `SendMessage`; killing another session's server has already cost someone a ticket. |
| "No branch protection, so it can merge now" | Protection `none` means the rule is yours to enforce. Green is every required check passed. |
