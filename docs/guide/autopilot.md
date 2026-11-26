# Autopilot

> Part of the [desk-skills docs](README.md). Back to the [main README](../../README.md).

How a batch runs unattended: the six stages, the worker sandbox, the supervisor that drives batches with no Claude session open, and the preflight that proves the sandbox on your computer.

## How a batch runs

```
/desk-autopilot ABC-1005 ABC-1008 ABC-763
```

1. **Triage** reads each ticket (read-only) and flags anything it can't do alone.
2. **Plan** orders the batch so tickets touching the same files don't collide.
3. **Ask once**: every open question for the batch, in one go.
4. **Run**: one headless worker per ticket, each in its own worktree and port, limited to the
   permissions you granted in this repo. A worker gets its own database where the repo has a local
   one; otherwise its database variables are blanked, so no worker can reach a shared or production
   database.
5. **Merge**: if you allowed merging in this repo, each PR is merged with the repo's merge method
   once it is green at its head, pinned to that commit, one at a time. PRs into the default branch
   that touch a merge hold are always left for you. The recommended settings leave merging to you, so green PRs are
   reported instead.
6. **Park**: anything that needs a person waits, and you get a notification.

**An epic** runs as its open children (`/desk-autopilot ABC-900`). Jira "is blocked by" links are
honoured: a blocked ticket waits until its blocker's PR merges. Tickets sized L or XL are parked to
be split. When the last child merges, the epic's own criteria are checked; the epic's status is
left to you. Bea writes epics in this shape ("Hello Bea, this is an epic"), with an adversarial
readiness review before you approve them.

Run `/desk-autopilot` again to check progress, answer a parked question or resume. Batch state is
kept per repo, so two repos can run batches at once. Workers keep going if you close the session.

Workers are sandboxed: they start **without your own Claude Code settings** (`--setting-sources
""`), so a broad allow rule of yours never reaches them. A worker can push only its own branch, and
cannot merge, undraft, run git config or aliases, use `gh api`, or write outside its worktree.

## The preflight

**Before the first autopilot batch in a repo**, prove the worker sandbox on this machine. It starts
one short real `claude -p` with the generated worker settings and checks that the worker can edit
its own worktree and run every configured toolchain, and cannot touch the main checkout, stash, use
git aliases or write outside its worktree:

```bash
AUTOPILOT_PREFLIGHT=1 ~/.claude/desk/bin/spawn-worker.sh <TICKET> <worktree> preflight
```

With the `preflight` lever on (config §3b Phase 0 levers), a ticket whose last preflight passed on
the same inputs skips it; delete `<state dir>/workers/<TICKET>.preflight.json` to force one.
A preflight session that ran no check (no reply, or no tool turn), or that read BLOCKED only on
checks that should be OK, is run once more at default effort; a boundary failure is never retried.

With the `ledger` lever on (config §3b Phase 0 levers), every queue write also appends what it
changed to the repo's ticket ledger, `~/.claude/desk/repos/<slug>/ledger/events.jsonl`, naming its
writer: a typed event for a ticket's change of state and a `legacy_set` for its other fields. A
batch the ledger has not seen starts with one `seeded` event per ticket. queue.json is still written
first and read by everything; a missed append is reported by the writer and never fails the write.
Each pass then compares queue.json with the queue rebuilt from the log: its report names each ticket
field that differs and counts the pass's missed appends, and its line in `passes.jsonl` records both
counts (`ledger_diffs`, `ledger_missed`). `queue.mjs rebuild [<batch | standing>]` writes the rebuilt
queue to `queue.rebuilt.json` beside queue.json and prints each field that differs.

With the `ledger-record` lever on as well (it does nothing without `ledger`, and a pass says so),
the log is written first. A write the log refuses as an illegal transition, such as starting a done
ticket running without a requeue, fails naming the ticket's state and the event, and changes
neither file. queue.json records the log position it holds (`ledger_seq`), so a pass that finds
queue.json missing, unreadable or behind the log rebuilds it from the log before reading it, and its
report says so. Fields still written as `legacy_set` events are kept and counted (`ledger_legacy` in
`passes.jsonl`). Turn it on only once the shadow difference has stayed at zero; turning it off goes
straight back to writing queue.json first.

## The supervisor

**`supervisor.mjs`** runs autopilot passes from launchd on macOS, or from a systemd user timer on
Linux (WSL needs `systemd=true` under `[boot]` in `/etc/wsl.conf`), with no Claude session in the loop.
Install it once per repo, from inside the repo. Its agent runs a pass at login and every 3 minutes for a
batch the orchestrator handed over at Stage 4, and appends each report to `<state>/supervisor.log`. On
Linux, ticks stop at logout unless lingering is on (`loginctl enable-linger`); install says when it is
off. On WSL, ticks run only while WSL is up, and lingering does not keep it up: WSL stops once every
terminal closes. Keep a terminal open, or add a Windows Task Scheduler entry at logon that runs
`wsl.exe --exec sleep infinity` (with `-d <distro>` if the supervisor's distro is not your default),
with "Stop the task if it runs longer than 3 days" turned off; install says this on WSL. It keeps the batch's merge driver running, sends one desktop notification for each new set of items
that need you (osascript on macOS; on Linux notify-send, else a Windows toast under WSL, else only the
log), and stops once the batch is idle. It passes on only the approvals the batch recorded at Stage 3.
Each tick does this for every batch the repo holds, one after another: the standing batch, then each
named batch, each on its own base, with its own log and merge driver. A named batch whose last promotion
PR is merged, or whose promotion PR is closed, with no ticket running and no ticket PR open, is archived under
`batches/.done/` instead; a ticket PR still open then goes to the check-in digest for you to merge or
close. A merge driver still running for such a batch has nothing left to merge, so the tick stops it
(one mid-merge finishes that merge first) and a later tick archives the batch. `batch.mjs start <EPIC> <branch>` starts an epic's feature batch (one per repo at a time), and
`batch.mjs discard <EPIC>` removes one no ticket has started in. An epic's start that fails discards
its batch with `--keep-triage`, which keeps the children's triage records, so admitting the epic again
on the same branch within six hours triages only the children with none; a child whose triage fails is
tried once more after 60 seconds first. `batch.mjs discard <EPIC>` on a slot holding only those records
removes them, and `move-batch.mjs` clears them from the slot it moves into.
`./install.sh` puts desk's scripts and templates in a release folder of their own,
`~/.claude/desk/releases/<commit>/` (`<commit>-<time>` from a dirty checkout), and makes it live in one
step by pointing `~/.claude/desk/current` at it; `~/.claude/desk/bin` and `templates` link through
`current`, so a pass started before an install finishes on the release it started with. The newest
three releases are kept, and `./install.sh --rollback` makes the one before the current one current.
The release watch (`release-watch.mjs`) stands behind each release the auto-release installs. Once a
release has 10 tickets finished on it, or 72 hours have passed since it went in (whichever comes
first), it compares that release's tickets with the previous release's. It looks at fix tries per ticket, parked
hours per ticket, post-merge reverts, and parks in an error class the previous release never parked in.
The trips are the lever registry's: a post-merge revert trips at once. Fix tries and parked hours
trip past their guardrail margin, and a new error class trips too, but each of those three only once
both releases have 10 tickets. A trip pins the previous release (install.sh keeps the release before
each one not yet judged, past the newest three) and opens one revert PR for every merge between the two releases. It also raises one
needs-you item naming the merges, the metric and the evidence. The pin holds the auto-release and the
maintenance window's update until main carries the revert, or until the PR is closed unmerged.
`desk-q rollback <commit>` (7 or more hex digits) does the same on demand for the release installed
at `<commit>`, and `desk-q rollback --unpin` lifts a pin.
Each repo's queue and the other state under `~/.claude/desk` never move. It records the commit it installed in `~/.claude/desk/installed.json`, rewrites and
reloads each loaded supervisor agent with the current node, and restarts each merge driver waiting
between loops on the new code with the same tickets (one mid-loop is left, and named). Each tick
keeps `code` in `<state>/supervisor.json`, saying whether the agent or the running merge driver
started at an older version, and restarts a handed-over batch's driver on old code the same way once
it waits between loops.

```
node ~/.claude/desk/bin/supervisor.mjs install [--interval <s>]   write and load the agent (default 180s)
node ~/.claude/desk/bin/supervisor.mjs status                     the agent, then each batch and its log's tail
node ~/.claude/desk/bin/supervisor.mjs uninstall                  remove it; no further passes for the repo
```

desk-q does the same for any repo set up here, from anywhere: `desk-q <repo> supervisor on|off`, bare
`desk-q <repo> supervisor` for its status and last log line, and `s` on a repo's row in the full
screen (turning it off asks first; running workers finish).

Who runs a repo's batches is config §3b "Batches run by": `supervisor`, the default `/desk-setup`
offers on macOS (it installs the agent, and Stage 4 hands each batch over and ends the session), or
`session` (the batch runs in the interactive session through `/loop`; unset reads as this).
`run-by.mjs stage4` makes Stage 4's call, installing a supervisor that is missing or unloaded.
desk-q reads the same row: a repo at `session` is shown as run by its session, with a red band naming
that session once its loop stops with work left, and desk-q offers `supervisor on` only on a computer
where a supervisor can run (launchd, or a systemd user manager that answers).
