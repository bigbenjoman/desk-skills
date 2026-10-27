# Orchestrator recovery — parks, answers, requeues, resumes

Read this before answering a park, re-running a ticket, resuming a dead worker, or diagnosing a
batch that has gone quiet. Every rule here is a place where the scripts' obvious reading was wrong.

`<state>` is this repo's batch state, `~/.desk-autopilot/<slug>/` (`desk-env paths` prints it as
`DESK_STATE`). `<TICKET>` is a queue key: a tracker key, an §4 Other work id patterns id, or with §4
Tracker `none` the `issue-<n>` or slug key the batch gave it. Every non-tracker key has its ticket
text in `<state>/tickets/<TICKET>.md`, written by you before triage; a requeue reuses it.

## The ledger is GitHub and the tracker, never the log

`pass.mjs` greps each worker log in full every pass and has no notion of which `AUTOPILOT_*` markers
it has already actioned. So:

- A queue `done` and a worker's `AUTOPILOT_DONE: pr=<n>` mean **a PR exists**: not that the review
  posted, not that it merged. Re-derive with
  `gh pr view <n> --json state,mergedAt,isDraft,headRefOid` every time.
- A spent `AUTOPILOT_PARK` in the log can re-park a ticket you just un-parked, and a spent
  `AUTOPILOT_DONE` makes `pass.mjs` refuse to respawn it (it says so under `STALLED`). Un-park
  with `queue.mjs requeue`, which moves the log aside, never with a bare `queue.mjs set`.
- A PR recorded as done "without a marker" may be one whose worker died before posting its review.

## A park means the worker is already gone

A worker cannot block under `dontAsk` (every wait primitive, `timeout … until`, `sleep`, `Monitor`,
`inotifywait`, is refused) so it prints `AUTOPILOT_PARK`, messages you, and exits within a turn or
two. Treat every park as "worker gone now". Any answer that needs the user arrives after it left,
so a worker parked holding an approved Jira comment exits and nothing receives the answer.

So, when a park needs the user: get the answer, **verify the real state** (`gh pr view`, and
`desk-jira get` where §4 Tracker is `jira`), and either finish the parked step yourself or requeue
the ticket. **`answer.mjs` records; it never un-parks.** It appends the answer to
`<state>/briefings/<TICKET>.md` (so a requeued worker reads it), writes the mailbox only when a
worker is live and waiting, and lowers the open-question count. A `parked` ticket stays `parked`
until you decide: `pass.mjs` spawns only `state=triaged`, and un-parking a lane C or D ticket by
reflex would run it unattended, which is exactly what its park prevents.

How to resume, by what was parked:

| Parked on | Resume by |
|---|---|
| a Stage 3 unknown (state still `triaged`, open questions above 0) | answer every question; the count reaching 0 makes it eligible at the next pass |
| triage lane C, or lane D parked on its design (only in Figma, or a canvas not on the base) | **never requeued for a headless worker** (a lane D whose canvas is then saved on the base is triaged and planned again, and runs): it goes to an interactive `desk-ticket` session. Only if the user rules the lane itself wrong: `queue.mjs set <TICKET> lane=<A, B or E>`, answer its triage unknowns with `answer.mjs`, then `queue.mjs requeue <TICKET>` |
| a worker's `AUTOPILOT_PARK` on a single remaining step (a Jira comment, the PR, the review post) | finish that step yourself from the worker's printed payload |
| a worker's `AUTOPILOT_PARK` that needs more agent work | requeue it: `queue.mjs requeue <TICKET>` (below) |
| any park whose worker read an answer | clear `<state>/answers/<TICKET>.txt` yourself: workers cannot delete it, and a stale one answers the next park instantly. A requeue moves it aside for you |
| a failed worktree setup | fix the cause the setup log names, then requeue; the failed worktree was already removed |
| a park whose recorded `clears_when` now holds | nothing: the next pass settles it by these rules (lane C, or a lane D parked at triage on its design, left for a person, its own PR merged recorded done, otherwise requeued) and says so under `clears-when:` |
| a ticket an interactive session works | park it with the session's id, never in free text: `queue.mjs park <TICKET> --claimed-by <session id>` (the `<id>.jsonl` under `~/.claude/projects`). Once that transcript has been still past §3b "Release idle claims after (hours)" (unset 12, `0` never) and the ticket's worktree is clean, a pass requeues it with its branch kept and pushes one notification; with uncommitted changes it stays claimed, and its park names the files once |

`SendMessage` to a live worker works and is worth trying first: check `ListAgents` rather than
assuming. A parked worker that sent `SendMessage` with `notify_when_idle: true` is re-invoked when
you go idle, which is the one wait that works.

## Answering a live worker

The `<state>/answers/<TICKET>.txt` mailbox is read only by a worker that is **parked on a
question**. A running worker never polls it, and the stale file then makes that worker's next park
return "answered" instantly. For a running worker: `SendMessage` it, then delete the answer file.
Workers can read the mailbox but never delete it (their only writable state files are their park
record and images), so **clearing it after it has been read is always yours**.

A contract or rule change does not reach a live worker either: it read the contract at spawn.
Message each running worker as well as editing the file. The stage sections
(`worker-contract-stage-*.md`) are the exception in part: a worker reads each one when it reaches
that stage, so an edit reaches a worker still before that stage, and never one already past it.

## Requeueing a ticket

A requeue is several fields and files, not one, and each missing one fails silently, so it is one
command:

```bash
node ~/.claude/desk/bin/queue.mjs requeue <TICKET>
```

It moves `<state>/logs/<TICKET>.log`, `<state>/parks/<TICKET>.json` and
`<state>/answers/<TICKET>.txt` aside to one next free `.round<n>`, the log gzipped as
`.round<n>.gz`, which `harvest.mjs` reads as it is (a kept `AUTOPILOT_DONE` makes
`alreadyFinished()` refuse the respawn, a kept park file shows the last round's question as "needs
you", and a kept mailbox answers the next park instantly), sets `state=triaged open_questions=0
park=null session_id=null pid=null idle_passes=0 log_bytes=0`, and moves the ticket to the front of
the spawn order (`.tickets` key order). It refuses a running ticket, a held one (release it
instead), one never triaged, one with triage questions still open (answer them instead), one
parked at triage for its size or a dependency cycle, and any lane but A, B or E, because `pass.mjs`
spawns whatever is triaged without reading the lane.

Where config §3b "Worker models" names two models, a ticket whose `standard` worker failed or was
stopped as stalled is raised to `model_tier=high`, and the requeue line and the status table say so.
A requeue after a park with a question, or after a failed preflight or spawn, keeps the model.

`pass.mjs` resets `log_bytes`/`idle_passes` at spawn, because a rotated log makes the byte count go
backwards and the stall killer then shoots each fresh worker. A climbing `idle_passes` across
respawns is the tell. It also clears `result`, `images_uploaded` and `images_reported`, and moves
any log or park record still in place to the next free `.round<n>`, so the new round's screenshots
go to the new round's PR rather than the last one's, and no earlier question reads as the new
worker's.

Remove the old worktree first (`git worktree remove --force`, under §3 `worktree-remove`) if the
follow-up needs a fresh branch off current `<default>` (§0 Default branch); otherwise
`setup-worktree.sh` reuses it on the same recorded branch. Keep the queue's `branch` as it is: the
merge driver finds the ticket's PR by that exact head branch, so a requeue that changes it strands
any PR already open.

**Then check the briefing survived.** `pass.mjs` rebuilds `<state>/briefings/<TICKET>.md` at spawn
and keeps only its `## Answer from the user` blocks. Instructions given while nothing was running
have been lost on every requeue it was checked on. The instant the ticket flips to running:

```bash
grep -c '<distinctive phrase from your newest instruction>' <state>/briefings/<TICKET>.md
```

Zero means resend it by `SendMessage` to the new worker right after the `spawned:` line, then grep
the worker's log for the phrase to confirm it landed. When only mechanical steps remain, finish them
yourself and give the worker only the part that needs an agent.

## A worker killed by a reboot or a crash

`pass.mjs` resumes it by itself. A running worker whose session is gone, whose log ends without a
result event, and that printed no marker and has no open PR was killed mid-run. The pass queues it to
resume (`resume=pending`, state `triaged`, its `session_id`, branch and worktree kept) and the spawn
resumes it ahead of new tickets, through `spawn-worker.sh` with `AUTOPILOT_RESUME` on its own session,
so inside the worker sandbox. The report says `resumed after it was killed (<n> of <limit>)` and
whether the computer restarted. Config §3b "Resume a killed worker (times)" caps it per ticket (unset
is 2); past it the ticket parks naming the limit and the session, and at `0` it is marked failed
instead. A session that ended normally, and a worker the pass stopped as wedged, are never resumed.
The count is the queue's `resumes`; a requeue starts a fresh session and clears a pending resume.

## Resuming a dead worker's half-finished worktree

For a worker the pass did not resume (failed, wedged, or over the limit), setting `AUTOPILOT_RESUME`
on `pass.mjs` does not work: a fresh spawn always mints a new session id, so `--resume` points at a
session that does not exist. Hand-launching
`spawn-worker.sh` with the old id breaks "pass.mjs is the only spawner". Instead:

1. Pause the pass loop.
2. Requeue it as above (`queue.mjs requeue <TICKET>`, which rotates its log).
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
- **A running worker at the 5-hour usage limit is paused, not dead.** Claude Code waits for the
  reset and carries on, so the worker goes quiet for up to five hours. `pass.mjs` reads the limit
  from the worker's log (`usage-limit.mjs`) and acts on config §3 `autopilot-usage-resume`: at `yes`
  it reports `paused on the usage limit: <TICKET> until <reset>` and never stops it as wedged, and
  the batch notes record the resume; otherwise (unset included) it stops the worker and parks it
  with the reset time, so requeue it after the reset. A worker still quiet half an hour after its
  reset falls back to the stall check. An `unrecognised usage-limit event` line means the log held
  an event that looked like the limit and did not match the shape the pass knows: it was not read
  as a pause, so that ticket is under the stall check as before. Keep the line for whoever replaces
  the provisional fixture (`tests/fixtures/usage-limit-five-hour.provisional.json`).
- **Empty-reason preflight failures are usually the same limit.** The preflight is a `claude -p`
  call, and the 5-hour limit is account-wide, so preflights across unrelated batches (and repos)
  fail at the same instant with no reason. Look for an HTTP 429, or a `paused on the usage limit`
  line from a running worker, before debugging permissions or codex, then wait for the reset:
  retrying only burns calls that produce nothing.
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
  mismatch between the argument and §4 Ticket key pattern, §4 Other work id patterns or the
  Tracker-`none` key forms, or a non-tracker key with no `<state>/tickets/<TICKET>.md`. Read the
  refusal, check the row and the file, and fix the argument or offer `/desk-setup`; never edit the
  pattern or the script mid-batch to get past it.
- **A PR the merge driver never touches** is usually on a branch other than the ticket's recorded
  `branch`, or based on something other than `<default>`. Check `gh pr view <n> --json
  headRefName,baseRefName` against `queue.mjs render`; a PR under a §4 Merge holds glob is skipped by
  design and is the user's to merge.

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
