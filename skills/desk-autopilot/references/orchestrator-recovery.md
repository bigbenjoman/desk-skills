# Orchestrator recovery — parks, answers, requeues, resumes

Read this before answering a park, re-running a ticket, resuming a dead worker, or diagnosing a
batch that has gone quiet. Every rule here is a place where the scripts' obvious reading was wrong.

`<state>` is this repo's batch state, `~/.desk-autopilot/<slug>/` (`desk-env paths` prints it as
`DESK_STATE`). `<TICKET>` is a queue key: a ticket key, or with §4 Tracker `none` the `issue-<n>` or
slug key the batch gave it.

## The ledger is GitHub and the tracker, never the log

`pass.mjs` greps each worker log in full every pass and has no notion of which `AUTOPILOT_*` markers
it has already actioned. So:

- A queue `done` and a worker's `AUTOPILOT_DONE: pr=<n>` mean **a PR exists**: not that the review
  posted, not that it merged. Re-derive with
  `gh pr view <n> --json state,mergedAt,isDraft,headRefOid` every time.
- A spent `AUTOPILOT_PARK` in the log can re-park a ticket you just un-parked, and a spent
  `AUTOPILOT_DONE` makes `pass.mjs` refuse to respawn it (it says so under `STALLED`).
- A PR recorded as done "without a marker" may be one whose worker died before posting its review.

## A park means the worker is already gone

A worker cannot block under `dontAsk` (every wait primitive, `timeout … until`, `sleep`, `Monitor`,
`inotifywait`, is refused) so it prints `AUTOPILOT_PARK`, messages you, and exits within a turn or
two. Treat every park as "worker gone now". Any answer that needs the user arrives after it left,
so a worker parked holding an approved Jira comment exits and nothing receives the answer.

So, when a park needs the user: get the answer, **verify the real state** (`gh pr view`, and
`desk-jira get` where §4 Tracker is `jira`), and either finish the parked step yourself or requeue
the ticket. `answer.mjs` alone does nothing for a parked ticket: `pass.mjs` spawns only
`state=triaged`.

`SendMessage` to a live worker works and is worth trying first: check `ListAgents` rather than
assuming. A parked worker that sent `SendMessage` with `notify_when_idle: true` is re-invoked when
you go idle, which is the one wait that works.

## Answering a live worker

The `<state>/answers/<TICKET>.txt` mailbox is read only by a worker that is **parked on a
question**. A running worker never polls it, and the stale file then makes that worker's next park
return "answered" instantly. For a running worker: `SendMessage` it, then delete the answer file.

A contract or rule change does not reach a live worker either: it read the contract at spawn.
Message each running worker as well as editing the file.

## Requeueing a ticket

A requeue is several fields, not one, and each missing one fails silently:

```bash
B=~/.claude/desk/bin; S=<state>
mv $S/logs/<TICKET>.log $S/logs/<TICKET>.log.round1        # else alreadyFinished() blocks it
node $B/queue.mjs set <TICKET> state=triaged open_questions=0 park=null session_id=null pid=null idle_passes=0 log_bytes=0
node $B/queue.mjs front <TICKET>                            # spawn order is .tickets key order
```

`pass.mjs` resets `log_bytes`/`idle_passes` at spawn, because a rotated log makes the byte count go
backwards and the stall killer then shoots each fresh worker. A climbing `idle_passes` across
respawns is the tell.

Remove the old worktree first (`git worktree remove --force`, under §3 `worktree-remove`) if the
follow-up needs a fresh branch off current `<default>` (§0 Default branch); otherwise
`setup-worktree.sh` reuses it.

**Then check the briefing survived.** `pass.mjs` rebuilds `<state>/briefings/<TICKET>.md` at spawn
and keeps only its `## Answer from the user` blocks. Instructions given while nothing was running
have been lost on every requeue it was checked on. The instant the ticket flips to running:

```bash
grep -c '<distinctive phrase from your newest instruction>' <state>/briefings/<TICKET>.md
```

Zero means resend it by `SendMessage` to the new worker right after the `spawned:` line, then grep
the worker's log for the phrase to confirm it landed. When only mechanical steps remain, finish them
yourself and give the worker only the part that needs an agent.

## Resuming a dead worker's half-finished worktree

`AUTOPILOT_RESUME` through `pass.mjs` does not work: `pass.mjs` always mints a fresh session id, so
`--resume` points at a session that does not exist. Hand-launching
`spawn-worker.sh` with the old id breaks "pass.mjs is the only spawner". Instead:

1. Pause the pass loop.
2. Rotate the ticket's log and requeue it as above.
3. Run one pass with an `AUTOPILOT_TASK` describing the worktree as it stands (the commits, the
   uncommitted files) and saying to finish from there, not redo.
4. Resume the loop.

`claude -r <session-id>` finds a session from any directory, even when its original cwd was deleted:
useful for reading an orchestrator's or worker's transcript, or resuming the orchestrator itself.
Add `--fork-session` to leave the original untouched, and check its stale view against GitHub first.

A killed worker may still have pushed: check `git log origin/<branch>` and the PR head before
re-running a ticket from scratch.

## Stalls that do not look like stalls

- **A hung `codex exec` keeps the log growing.** It emits a `tool_progress` heartbeat every 30s, so
  log-growth stall detection never fires: one call sat 8h29m and only 4 workers spawned all night.
  Check the newest `tool_progress` `elapsed_time_seconds` in the log tail; a single
  tool call past a few minutes is a hang. Kill **that worker's** codex by the PID you resolved
  (`ps -o etimes= -p <pid>`), never `pkill -f codex`: other sessions run codex concurrently.
- **Empty-reason preflight failures are usually the account session limit.** The preflight is a
  `claude -p` call; the 5-hour limit is account-wide, so workers across unrelated batches (and
  repos) die at the same instant with no reason. Look for an HTTP 429 in any concurrently dying
  agent before debugging permissions or codex, then wait for the reset: retrying only burns calls
  that produce nothing.
- **A briefing's orchestrator name can be stale.** The orchestrator session is named after its
  batch, so adding a ticket renames it. A worker whose `SendMessage` fails should run `ListAgents`
  once; exactly one row that is the same batch with tickets added or removed is the same session.
  No plausible row means nobody is listening: stop.
- **A permission denial may be the filesystem, not the rule list.** Workers can only reach their
  worktree plus `additionalDirectories`. The lock directory (`DESK_LOCK_DIR`, default `/tmp`) and
  `/proc` (Linux meminfo) needed adding there; a `Bash(flock:*)` rule never could have fixed it.
  Check whether the path is reachable before widening a command rule, and after changing any
  spawn-path script, spawn one worker and read its briefing before trusting a batch to it.
- **A script refusing a key** (the merge driver's `--tickets`, `plan-batch`, `triage.sh`) is a
  mismatch between the argument and §4 Ticket key pattern (or the Tracker-`none` key form). Read the
  refusal, check the row, and fix the argument or offer `/desk-setup`; never edit the pattern or the
  script mid-batch to get past it.

## Waiting on a process

Never `pgrep -f '<pattern>'` in a wait loop: the harness wraps each Bash call in a `bash -c` whose
command line carries the pattern literally, brackets and all, so the loop matches itself forever
(for example `while pgrep -f "[n]ode .*pass.mjs"`). Match on argv[0] instead, bounded:

```bash
for i in $(seq 1 60); do ps -eo args | awk '$1=="node" && $2 ~ /pass\.mjs$/ {f=1} END{exit !f}' || break; sleep 10; done
```

`desk-env heavy` lists suites, typechecks and dev servers the same way, excluding claude workers
whose briefings mention those words.

## Never patch a shared script mid-batch

A bad guard in the spawn path does not throw; it silently stops spawning, which looks identical to
"waiting on a worker". Change `pass.mjs`, `spawn-worker.sh` or the contract between batches.
