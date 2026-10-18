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
| §4 "Tracker", "Ticket key pattern", "Other work id patterns" | what a batch argument is, and what the scripts accept as a key |
| §4 "Required checks", "Advisory checks", "Branch protection", "Merge method", "Repo merge settings" | what "green" means, and how the driver merges |
| §4 "Merge holds" | PRs a person merges: the driver and you never merge them |
| §4 "Local review command", "Clean review verdict" | what a worker runs at Stage 4b, and what "reviewed with no findings" reads as |
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
- run `git config`, `git -c …`, `git -C …`, git aliases or `git stash`;
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
- write outside its worktree, except `$DESK_STATE/parks/<TICKET>.json` and
  `$DESK_STATE/images/<TICKET>/**`. It cannot write or delete `answers/`: you clear a ticket's
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
| `git-push`, `pr-open`, `pr-edit` | worker pushes / opens the draft / edits the body | worker parks at that step with the branch or PR body; you ask, then do it |
| `pr-self-review-comment` | worker posts the §4 Local review command's report (`gh pr review`, `gh pr comment`) | worker parks with the report; you ask, then post it |
| `pr-reply` | a worker may reply with `gh pr comment`; resolving threads (GraphQL, `gh api`) is yours, since workers never get `gh api` whatever this row says | the worker parks with its replies; you post them or report the threads to the user |
| `pr-update-branch`, `ci-rerun` | worker may `gh pr update-branch` / `gh run rerun`; the merge driver reruns completed red runs | denied to the worker; the driver logs the red run and leaves it for you |
| `jira-comment`, `jira-transition`, `jira-create`, `jira-edit` (Tracker `jira` only) | worker posts / moves / creates / edits (`edit`, `labels`, `attach`) itself; `desk-jira link` and `unlink` are never a worker's | worker parks with `desk-jira`'s block; relay it verbatim (Stage 6c) |
| `codex-review` | workers get `codex`; the preflight asserts `CODEX=OK` (fails if codex is missing, unless `AUTOPILOT_ALLOW_NO_CODEX=1`) | `codex` is denied and the preflight asserts `CODEX=BLOCKED`; refutations are same-vendor, and where a required check demands a cross-vendor verdict those PRs cannot pass it: say so |
| `pr-images` | `pass.mjs` uploads automatically | `pass.mjs` reports the directory; ask, then run the uploader with `DESK_UPLOAD_APPROVED=1` |
| `read-figma` | workers get the Figma read tools | a ticket needing the frame parks |
| `pr-ready` | you undraft once the checks in Stage 7 hold | report the PR as ready to undraft |
| `pr-auto-merge` | not used in a batch: neither you nor the driver arms auto-merge, because the platform's idea of green is not the config's | — |
| `autopilot-merge` **and** `pr-merge-green` | the merge driver merges on green, pinned to the head | the driver refuses to start (exit 1); report green PRs to the user |
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
| 2 | Plan | `plan-batch.mjs`: ownership, admission, collisions, and the question batch. Then **set the merge order yourself**: see *Order the batch by blast radius*. Admit only work the batch can finish whole: a ticket that is doable except for a design, copy or product call is a question, not a partial run. |
| 3 | Ask once | Every unknown across every ticket, in **one** round, **always via `AskUserQuestion`**, never as prose in the report. Include any §3 `ask` the batch will hit (headless workers, upload, merge). Wait. This is the whole promise. See *Asking*. |
| 4 | Run | `pass.mjs`, self-paced via `/loop`. It preflights, spawns, harvests, reports. **Re-read the ladder at the top of every pass**: concurrency is a per-pass decision, not a batch setting. Start the merge driver now, before the first worker finishes. |
| 5 | Answer | `answer.mjs <TICKET> "..."` records the answer in the ticket's briefing (and in the mailbox only if a worker is live and waiting) and lowers its open-question count, so a `triaged` ticket blocked on Stage 3 answers becomes eligible at the next pass. **It never un-parks**: resuming a `parked` ticket is your decision. A ticket whose worker parked: the worker has already exited, so verify the real state, then finish the parked step yourself or requeue it (`queue.mjs requeue <TICKET>`, details in `references/orchestrator-recovery.md`). **A lane C or D park is never requeued for a headless worker**: answering it does not make it one sitting. It goes to an interactive `desk-ticket` session, unless the user rules the lane itself wrong (*A lane is a proposal*). For a *running* worker, `SendMessage` it. |
| 6 | Images | Where config §3 `pr-images` is `yes`, `pass.mjs` runs `upload-images.mjs` when a worker prints `AUTOPILOT_IMAGES:`: serialised, one PR at a time, never a worker. There is **one signed-in browser profile machine-wide** (config §2), so claim it from peer sessions by message first and release it the moment you are done. Only `0 placeholder(s) left` counts as uploaded. Placeholders left (uploader exit 4) or none matched (exit 3) sets `images_uploaded=partial`, saves the output to `<state>/images/<TICKET>.upload.log` and reports it under `WAITING ON YOU`: fix the body's `_drag <file>_` cells from the saved tags, do not re-upload (the assets already exist). |
| 6b | Notify | When a pass reports `WAITING ON YOU` or `PARKED`, send **one** `PushNotification` covering everything that pass surfaced (where §3b "Push notification when a batch needs you" is `yes`). Never one per park: they are coalesced deliberately. Say the ticket and the question in one line each. |
| 6c | Relay a gate | When a worker parks on a write config §3 did not grant (most often the Jira comment), reproduce `desk-jira`'s block **verbatim**: `JIRA COMMENT — awaiting approval` (or `JIRA TICKET`/`EDIT`/`TRANSITION`), target, fields, then the exact body. Never paraphrase it. The user must read the exact string that is about to be public; a summary defeats the gate while looking like it honoured it. The same holds for a parked PR body or review report. |
| 7 | Merge | The moment a PR is green at its head, **merge it** (where granted, pinned to that head, never under a §4 Merge holds glob): do not collect PRs and merge at the end. See *Merge each PR the moment it goes green*. |
| 8 | Report | What is merged, what is parked and on whom, what is still running. **Emit the status table on every stage change**: see *The status table*. |

Idle = every ticket merged, parked or failed, and none held waiting on a merge (`pass.mjs` prints
IDLE only then). Say so and stop; for an epic, run the close-out first. Do not invent work. **Never
transition a ticket to §4 Done state** (and with no tracker, never close an issue), and never treat
a triage "already fixed" as grounds to close one: a per-criterion check once overturned four of six
such verdicts.

## Order the batch by blast radius

`plan-batch` finds collisions and orders by Jira Blocks links (*Dependencies from Jira links*); the
rest of the sequence is yours. **Set it at Stage 2, from the `files_in_scope` triage already gave
you**, and the order is a merge order, not just a spawn order.

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
collider back while the other one's *worker* is running. So chain them yourself: hold each successor with
`queue.mjs hold <SUCCESSOR> <TICKET>` (it records the blocker, so the batch stays alive while it
waits), and pass the chain to the merge driver as `--deps`, which releases it (`state=triaged`, moved to the front) once that PR has
merged. Tickets that share no files run in parallel lanes up to the concurrency cap, and each lane
stays serial.

## An epic as a batch

A large feature runs as an epic: one key whose children are the tickets. **Expand it at Stage 0,
before triage**, and never triage, build, transition or edit the epic itself:

```bash
node ~/.claude/desk/bin/expand-parent.mjs ABC-900 > <state>/epic-keys.txt   # report on stderr
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
- Tickets filed during the batch (an L split into children, a close-out follow-up) join it one at a
  time: fetch as at Stage 1, `triage.sh <KEY>`, then `queue.mjs admit <KEY>` (and `queue.mjs hold` if it is blocked by a
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
blockers first. Join its `--deps` with your collision chains (one entry per successor,
predecessors unioned) for the merge driver.

**A held ticket is in flight, not idle.** While every blocker is still on its way (running, waiting
to spawn, or done with an open PR), `pass.mjs` reports it under `WAITING ON MERGE` and does not print
IDLE: keep the loop going. Two states come to you under `WAITING ON YOU`, with a notification:

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

### Epic close-out

When the batch is idle with no held ticket left:

1. If any child is parked or failed, list them and stop: the epic is not complete, and nothing is
   verified.
2. Otherwise, if the epic has acceptance criteria or a definition of done (and likewise for each
   story that was expanded into its subtasks, whose own criteria no worker checked), check each one against
   `origin/<base>` with desk-jira's *"Already fixed"* method (one read-only verifier per criterion,
   file:line or NOT MET, defaulting to NOT MET) and report MET / NOT MET. Each NOT MET is proposed
   as a new child under the epic through `desk-jira`'s gate, never appended to the epic. With no
   criteria, say "epic has no criteria — not verified".
3. With a batch base, the promotion PR (base → default) is the user's. Title it with the epic key
   so `/desk-review` checks the epic's criteria against the whole feature, and say so.
4. **Never transition the epic**, whatever the result.

### A design in Claude Design

Workers have no Artifact tool, so a ticket whose design is a Claude Design artifact gets a
snapshot **at Stage 1, before its triage**, taken by you. Find them with
`node ~/.claude/desk/bin/desk-design.mjs check <KEY>` per ticket (a `blocking` line: no copy is saved
in the repo yet). List the artifact's files (`Artifact action:list scope:files`), then read
`project/canvas.json`, every `project/*.dc.html`, and the `support.js`, stylesheets and fonts they
load, with `paths` and `out_dir: <state>/designs/<TICKET>/` (they land under
`<state>/designs/<TICKET>/project/`; triage and workers can read `<state>`). Then record where it
came from, naming **every** ticket in the batch that uses this canvas, so the workers who save it
write identical files:

```bash
node ~/.claude/desk/bin/desk-design.mjs write <state>/designs/<TICKET> --url <artifact URL> \
  --version <its version> --epic <EPIC, or the first ticket> --key <KEY> [--boards '<a>,<b>'] --key <KEY2> …
```

Each worker runs `desk-design.mjs save` on its snapshot (desk-ticket, "A Claude Design canvas is saved
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
reported" and nothing ever merges. Also bring `<default>` into the branch before the batch starts,
so the workers are not based on a stale tree.

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

**Start the merge driver at Stage 4, before the first worker finishes: do not merge off your own
turn cadence.** Merging tied to when a monitor happens to wake you is how a PR sits green and
unmerged: nothing undrafts, merges or retriggers it until the orchestrator's next turn.

The driver **refuses to start while §4 Merge holds is unset** (write `none` when nothing is held),
as it does for §4 Required checks and Merge method.

```bash
nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2 ABC-3" --deps "ABC-3:ABC-1" \
  >> <state>/merge-driver.log 2>&1 &
```

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
  Advisory checks names it; a skipped required check is not a pass. Read checks with
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
  `pr-ready` is `yes`, then do whatever is needed to merge it immediately. Done and reviewed means the review verdict on the PR's **current**
  `headRefOid` reads as §4 Clean review verdict with nothing deferred and no requirement gaps, the
  screenshots are uploaded (or the body says nothing renders differently), and `mergeStateStatus` is
  not `DIRTY`. A review gate may pass with gaps open, so a gap count above 0 is a question for the
  user, not a merge: keep it draft, since the driver merges any ready PR that goes green. With §4
  Local review command `none`, there is no verdict: "reviewed" is then the user's call, so report the
  PR rather than undrafting it. A clean verdict on a conflicted head is spent the moment the conflict
  is resolved. Workers are denied `gh pr ready`, so check these facts yourself, then `gh pr ready`;
  the driver merges it, pinned, the moment it is green (never a PR under a §4 Merge holds glob). Do
  not arm auto-merge. Undrafting earlier pings the reviewer before the evidence is in.
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
unfalsifiable; there the test is whether the work is mechanical and bounded. **A challenge that could
not read the code is not doubt**: any read it needed and could not make makes its verdict
INCONCLUSIVE, with the failed reads recorded, and the lane is left exactly as the first pass set it.

**A confirmed park can still be wrong, because both passes can share one over-estimate.** A park on
size CONFIRMED by counting new things to build can be lane A in a handful of files when every one has
an existing pattern on `origin/<default>` to copy. Before reporting any park on size, check each
thing the challenge calls "new" against `origin/<default>` and say what you found: report the doubt,
not the verdict. **Read the challenge line**: `plan-batch` prints `challenge CONFIRMED`,
`! challenge INCONCLUSIVE` with the reads that failed, or `! challenge did not run`. The last two are
a single unchecked opinion that must not be reported as settled. An INCONCLUSIVE park's lane is
marked `UNCHECKED` and is listed under QUESTIONS: put it to the user to confirm or re-lane.

**A lane is a proposal.** When the user rules that a park's lane is wrong (it is really A, B or E),
re-lane it with `queue.mjs set <TICKET> lane=A`, answer its triage unknowns (`answer.mjs`), then
`queue.mjs requeue <TICKET>`, and, where the ticket is
genuinely big, scope it in the briefing so what runs really is one sitting. That is a new lane, not
a requeue of a C or D: a ticket that stays C or D is worked interactively, never by a worker.

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

A worker whose log has not grown for 6 passes is **stopped and parked**, freeing its slot, unless
its last marker is `AUTOPILOT_DONE`: a worker that finished and then hung is stopped and recorded
done with its PR, on the first pass that reads the marker. Log growth
alone can lie (a hung `codex exec` heartbeats into the log for hours), so on a batch that has gone
quiet, check the log tail's newest `tool_progress` `elapsed_time_seconds` too. Recovery for both is
in `references/orchestrator-recovery.md`.

## Concurrency and memory

Default **2**, cap **3** (config §3b "Autopilot worker concurrency" can change either), and it is
**re-decided every pass, not set once**. RAM binds before CPU, and the 5-hour and 7-day usage limits
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
(`desk-env mem watch`) that fires only on `avail` below the ladder's lowest band (2 GiB, or a lower
band the §3b row names) held 5 minutes with nothing heavy running to explain it. It keeps its timer
in the process, so re-arm it when the `Monitor` expires. Killing a runaway process is a call to make
from the monitor, not a park.

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
after `init`. The rules also live in the worker contract, which is never truncated.

## Commands

```bash
# Written exactly as the harness rules name them (permission-rows.md), so they match without a
# prompt: `node ~/.claude/desk/bin/<x>.mjs`, `~/.claude/desk/bin/<x>.sh`, `desk-env`. Never via a
# shell variable such as $B: no allow rule matches a variable path. <state> is DESK_STATE from
# `desk-env paths`, written out in full.
node ~/.claude/desk/bin/expand-parent.mjs ABC-900                     # an epic -> its batch keys (stdout), drops on stderr
~/.claude/desk/bin/triage.sh ABC-123                                  # read-only, no worktree
AUTOPILOT_WRITE_QUEUE=1 node ~/.claude/desk/bin/plan-batch.mjs ABC-GATE ABC-123 ABC-124   # gates first: arg order = spawn order
node ~/.claude/desk/bin/answer.mjs ABC-123 "<answer>"
node ~/.claude/desk/bin/pass.mjs                                      # one pass; drive with /loop
node ~/.claude/desk/bin/queue.mjs render                              # status
node ~/.claude/desk/bin/queue.mjs front ABC-123                       # move a released ticket to the front of the spawn order
node ~/.claude/desk/bin/queue.mjs hold ABC-124 ABC-123               # hold a ticket behind a blocker (recorded; released on its merge)
node ~/.claude/desk/bin/queue.mjs admit ABC-125                      # add one triaged ticket mid-batch (never re-run plan-batch to do it)
node ~/.claude/desk/bin/harvest.mjs <state>/logs/ABC-123.log
AUTOPILOT_DRY_RUN=1 …                                                 # no push, no PR, no review post, no Jira writes
AUTOPILOT_USER_APPROVED=1 node ~/.claude/desk/bin/pass.mjs            # only when §3 autopilot-workers is `ask` and the user confirmed this batch
AUTOPILOT_ALLOW_NO_CODEX=1 node ~/.claude/desk/bin/pass.mjs           # codex-review is yes but codex is not installed: accept same-vendor reviews knowingly
nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2" --deps "ABC-2:ABC-1" >> <state>/merge-driver.log 2>&1 &

# config
desk-env where                   # which repo, which config, does it exist
desk-env ids                     # every §3 key and config row the scripts read, and its value
desk-env perm codex-review       # one permission: yes|ask|no|never|stop (missing/TODO -> no)
desk-env budget worker           # 25 | none; exit 4 if malformed

# resource management
desk-env mem status              # vmmem= avail= rss=
desk-env heavy                   # suites, typechecks, dev servers actually running (never pgrep -f)
~/.claude/desk/bin/with-lock.sh test true   # probe the lock once
cat ~/.claude/skills/desk-autopilot/references/batch-notes-header.md >> <state>/batch-notes.md

# the two Monitors, started once at Stage 0b (change-only; the second fires on sustained only)
node ~/.claude/desk/bin/queue.mjs render | tail -n +2; desk-env mem status
desk-env mem watch               # SUSTAINED-HIGH: avail=<x>G below <band>G for 5m with nothing heavy running

# apply the ladder — top-level field
node ~/.claude/desk/bin/queue.mjs set-batch concurrency=1
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
- About to stop the loop while `pass.mjs` reports `WAITING ON MERGE`
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
