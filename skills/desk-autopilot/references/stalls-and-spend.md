# desk-autopilot: stalls and spend

Part of desk-autopilot, read at Stage 4 in the session before the first pass, and whenever a pass
reports a stall, a budget or model hold, or a handoff. It binds exactly as the core `SKILL.md` does.
Where it says "above" or "below" of something this file does not hold, or cites a section in
*italics* it does not hold, that is in the core or in the file the core's reference table names.

## Stalls and spend

**A session's loop never loses its next tick.** When a pass returns, schedule the next one and record
it (`queue.mjs next-pass`) before acting on what it printed, whatever its exit, a crash included: a
long pass, a PR opened or a failed spawn handled after it must not end the turn without one. The
handoff hook holds you to it: a turn that ends with no next pass recorded is blocked once, and once
no pass has run for twice the loop's interval your next turn is told to re-arm the loop now; recording
the next pass logs the re-arm for needs-you. If you cannot re-arm it, say why with
`loop-tick.mjs could-not "<why>"`. A pass run by hand in another session, with no `--next`, leaves the
loop with the session that recorded its next pass.

Spend follows config §3b. Where "Autopilot batch budget (USD)" is `none`, leave `budget_usd` unset so
`pass.mjs` never stops spawning, and do not surface a running total as a finding. Where a cap is set,
`pass.mjs` stops spawning at it and says so. The per-worker budget is a runaway guard, not a cap on
asked-for work. Precedence: batch: the queue's `budget_usd`, `AUTOPILOT_BATCH_BUDGET_USD`, config,
`none`; per worker: `AUTOPILOT_BUDGET_USD`, config, `25`. A malformed value holds spawns (batch,
under `STALLED`) or fails the preflight (per worker); fix the value, never strip it. A worker whose
session stops at the per-worker budget, often with its work done but not committed, is not failed: the
next pass queues it (`resume=budget`) and resumes it once in its own session with $5 more (that run's
`AUTOPILOT_BUDGET_USD` is 5: the cap counts only a resumed run's own spend), told to commit, push and
finish its stage. It waits like any spawn while the
batch budget is spent, and the report says so. A second stop in that session parks it, naming the
budget and whether its worktree holds uncommitted work.

**Every park, hold and stall is timed by its cause** (`stuck-time.mjs`). Each pass records in the
repo's `stuck-intervals.jsonl`, and in the ticket ledger where that lever is on, when a ticket was
parked (its park kind and failure class) or kept waiting by a hold (usage, memory harm by signal or
low memory, the lock or the test lock queue, a collision, a red base, a gate reviewer down), and when
that ended. desk-q's repo screen and the levers report show the week's hours per cause, the tickets
affected and the top causes, each with the tracking issue `node stuck-time.mjs link <cause> <issue>`
set; parked hours per ticket is a lever guardrail.

**Every ask is recorded step by step where the ledger lever is on** (`ask-ledger.mjs`). An ask is a
park handed to the person or the decider, keyed `<KEY>:<park.since>`. The ticket ledger records it
raised, presented (by push, the check-in digest or the decider), answered (by the person, with the
session it came from where one is named, by the decider, or by default when a pass takes a recommended
option) with its latency from the park, and acted on by the next worker. Each step is written once, and a write that fails is a line in the report.
Each pass then measures what each step cost (`ask_tokens`), in tokens and list-price dollars: the
parked round from its park write to its end (a lower bound), the decider's session over the items it
listed or the person's session between its answers (approximate; an answer from a shell costs none),
and the next round to its first stage marker, cache reads and writes apart. A step that cannot be read
whole, a killed worker's, is marked incomplete, never 0.

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

Either form may add `finder=<alias>` (an Agent-tool model alias: the Agent tool takes no full model
name) and `text=<model>`, both unset by default. A worker launches
every self-review finder on the finder model (`desk-env model finder`; desk-review names it in its
header), and a Stage 7 session spawned from a handoff runs on the text model, which the queue's
`model` and the report's `spawned` line show. Unset, finders run on the worker's model and the
Stage 7 session on the ticket's tier. Every
preflight also asks each one set for one word on its own, so a value the CLI rejects fails the
preflight with a `FINDER` or `TEXT` line naming the row and the value, and no worker spawns. Neither
is set until the eval harness shows finding quality holds on the cheaper model. The `finder-model`
lever trials exactly that: on a ticket whose arms have it on, `desk-env model finder` prints the
lever's alias (`sonnet`, config-schema's `FINDER_MODEL_LEVER`, which its registry entry records as
`model`) whatever `finder=` says, and the blind audit compares the two arms. Only the routed finders
move: the simplicity finder reads `desk-env model finder --row`. A repo whose `finder=` already
names that alias never draws it.

**The effort each worker session runs at is config §3b "Worker effort"** (`desk-env effort <start>`
prints it), read only with the `effort` lever on (config §3b "Phase 0 levers"). Off, no `--effort` is
passed. On, `spawn-worker.sh` passes the effort the row names for how the session starts: `0`, `3` to
`9` or `4b`, `task` for a fix or review try, `resume` for a resumed session, and `medium` for one the
row does not name. An unknown value anywhere in the row fails that ticket's preflight, naming it; fix
the row, then requeue the ticket. Lever on or off, each start's stage, model and effort go into the
ticket's log, and the batch report's worker table shows them per session, with `default` where
nothing was passed.

**With the `preflight` lever on (config §3b "Phase 0 levers"), a ticket does not pay for the same
preflight twice.** A pass is recorded in `$DESK_STATE/workers/<TICKET>.preflight.json` as a fingerprint
of the worker settings, the ticket's agents file, the tool list, the models, every start's effort,
the installed claude CLI version, the desk commit and the account. The ticket's worktree, key, branch
and per-ticket database are placeholders in it, and the rules denying the other worktrees are left
out, so two tickets in a repo with the same settings share a fingerprint. A spawn or resume with the fingerprint
of its ticket's last pass runs no preflight, makes no line in the ticket's log, and its spawn line
says it was skipped. So does a spawn with the fingerprint of another ticket's pass in the repo within
the last 24 hours, recorded in `$DESK_STATE/workers/preflight-passes.json`: its spawn line and run record <!-- prose-ok: written by preflight-fingerprint.mjs beside the per-ticket workers records, not a batch-state path -->
name it a cross-ticket skip and the ticket whose pass it took. Any change runs one, at low effort, and
so does a spawn after a failure or a usage limit, which leave the ticket no record of its own (another
ticket's pass can still stand for it), or with an input that cannot be read. Delete both records to force one. Off, every preflight runs as it did, with no `--effort`.

**With the `effort` lever on, no ticket runs in a cloud session**, because nothing gives one an
effort. At config §3b Worker location `cloud`, the plan keeps every ticket local and its `runs:` line
says why, and a ticket already placed in the cloud parks at its start, as does one starting with a
malformed Worker effort row. With the lever off, a cloud session starts as before, and its report row
shows start `0`, model `default` and effort `default`, since it is passed neither. So at `cloud`,
turning the lever on is a change in itself, even with every start at `medium`: tickets that ran in
the cloud now run here. The Phase 0 baseline leaves cloud workers out, so it covers a different set
of tickets. There, compare each lowered start with that all-`medium` stretch instead.

**Where workers run is config §3b "Worker location"**: `local` (also when the row is absent) or
`cloud`. Any other value refuses the plan, naming the row. At `cloud`, the batch plan's `workers:`
and `budget:` lines say how many tickets can run in a cloud session and that a cloud session takes no
per-worker budget, and each admitted ticket's `runs:` line says where it can run. A ticket stays local,
with the reason, when its triage record says it renders (the browser lock and a dev server), needs a
database, or names in `needs_local` anything else only this computer has (stub binaries, a local
service), and when the record predates `needs_local`. Admission records only that a ticket can run in
the cloud (`cloud_ok: true` on the queue); the pass places it when it starts. Cloud first: a cloud-able
ticket goes to a cloud session while "Cloud sessions at once" has room. Local slots go first to
local-only tickets: a cloud-able one takes a local slot only with the cloud full, a local slot left free
for the whole last pass, and one free now beyond those the local-only tickets behind it want. The
ticket records where it started and why (`start_place`), which desk-q's ticket screen shows as Place.
**While you use this computer** (processes that are not desk workers, their dev servers or test runs,
or desk itself, hold more memory or CPU than the machine profile's `person-baseline-gb` and
`person-baseline-cpu` by `person-use-gb` or `person-use-cpu`), the local cap drops to
`person-use-floor` (1 unset), for local-only tickets, and cloud-able tickets go only to the cloud. No
running worker is stopped. The cap comes back once your use has stayed under the threshold for
`person-use-calm-min` minutes (10 unset). Unset, the baseline is 15% of `memory-gb` and 5% of
`cpu-cores`, and the threshold 10% of `memory-gb` and 25% of `cpu-cores`; `person-use=off` turns it
off, and no machine profile means it never reads. Set any of them with `desk-env machine set`. desk-q
and the pass say "you're using this computer: local cap 1, cloud first" while it is on.
A ticket started in the cloud (`location: cloud` on the queue) gets no worktree, preflight or local worker: the pass starts `claude --cloud` under `script` with a
prompt carrying the ticket's text, and the session pushes a branch and opens a draft PR. The pass
records the ticket done once that PR shows (on its branch, or with the key in its title, opened since
the session started), on that PR's branch; the session cannot reach the tracker, so its Jira steps are
left for you. A PR the session marked unfinished (WIP in its title or body, "what is left", or "could
not finish", as the prompt's step 5 asks of a session that cannot finish) is not recorded done: the
ticket stays running at stage `cloud`, recorded as `cloud.unfinished`, the pass reads the PR again
each pass, and desk-q shows it as "cloud session idle since <time>, PR #n unfinished". Once CI on its
head has finished (or an hour passes with no checks), the pass sends the session one follow-up with the
check results; with no push an hour after that, a second; and an hour after the second, still with no
push, it parks on the PR's branch naming the session URL. A push starts the count over. The session starts on the login a local worker for the repo would get, its §3b
Subscription row and never the fallback, and the spawn line and the desk-q row name its account.
A start that fails parks with the CLI's error and is never run locally without asking; one that does
not answer within its timeout parks naming the login and the one-time `claude --cloud` to run on it
in a terminal, since a first start on a login asks a question nothing answers in the background.
Cloud starts have their own limit, §3b "Cloud sessions at once" (unset is 4): a cloud session takes
no local slot and is not counted in the repo or machine cap or the memory pool, so it starts beside the
local workers; pacing, the usage limit and maintenance still hold it.
Once its PR is read the session is over: any later work on that PR (a review try, a fix try of any
kind, a rework) goes to a local worker on the PR's branch at origin's tip, which pushes there.
The report's cost table shows a cloud worker's session URL and its wall time from session start to
PR, and its tokens as "unknown (cloud)" and its cost as "cost unknown (cloud)". Claude Code reports
no tokens or cost for a cloud session, and no OpenTelemetry collector is set up for one. desk-q's
Costs view (and `--json costs`) lists each queued cloud ticket the same way, with its session URL.
Its Timeline and By-day views date a cloud ticket with the local ones and put `cloud ·` before its
title. Nothing reads a cloud session's state back, so a session that stopped on "Claude Code hit an
error" looks the same as a quiet one: no PR and no push. Past its start plus the ticket's ETA, with
no push to its branch for half that ETA, the pass sends it one retry follow-up (`claude -p <msg>
--cloud <session>`, recorded as `cloud.retried_at`), which restarts an errored session. Past its start
plus the ETA plus half that again, with no push since that retry, it is reported **possibly stuck**
with its session URL; a retry that cannot be sent reports it at once. A push after the retry starts
it over. Its ETA is
its saved first estimate's span from start to ship (`eta.jsonl`), or with none the forecast's
typical slot time for its size; with no history either, it is not called stuck. To start a stuck one
again, `queue.mjs stop <KEY>` records its session abandoned (`cloud.abandoned_at`), puts it on the
finished-session list below and holds the ticket as a stopped worker; `queue.mjs requeue <KEY>` (or
needs-you's start) then gives it a new session. A requeue refuses a running cloud ticket until it is
stopped. A cloud spawn is held by weekly
usage pacing like a local one. Since a cloud session writes no usage reading here, a held pass
still makes its probe call while only cloud workers run.
The session is named `<repo>-ticket-<KEY>` (`--name`) and stays open in claude.ai/code once its PR
merges: nothing here can archive it. So the batch's finished cloud sessions are one desk-needs-you
item, naming each with its URL, which the person archives by hand; its done records them so none is
asked about twice.

**A ticket admitted mid-batch is placed the same way.** `queue.mjs admit`, which every mid-batch
route admits through (intake, `/desk-admit`, an approved epic plan's children, a ticket handed over
from another repo), applies the same rules to its triage record and the batch's feature
roles, so at `cloud` one that needs nothing here gets `location: cloud`, and its admit line ends with
the same `runs:` words as the plan's.

A worker whose log has not grown for 6 passes is **stopped and parked**, freeing its slot, unless
its last marker is `AUTOPILOT_DONE`: a worker that finished and then hung is stopped and recorded
done with its PR, on the first pass that reads the marker. Nor is one whose worktree is running a
suite under the test lock, or waiting for it (a `with-lock.sh test|tsc` working there): the pass lists
it as quiet, "running its suite" or "waiting on the test lock", until it has been held that way for
30 minutes, and then stops and parks it as wedged, naming the ceiling. A worker at a usage limit (5-hour, weekly
or any other) is not stalled: the pass reports it as paused, holds the repo's spawns and resumes
until its subscription's reset (no running work moves to another subscription; other subscriptions' work
carries on, and a repo following the default starts new work on a `fallback` login meanwhile), and resumes it in its own session on the login it started on once the limit lifts, at
its reset or sooner when a probe call succeeds (orchestrator-recovery.md). Log growth
alone can lie (a hung `codex exec` heartbeats into the log until the harness moves it to the
background at 600s), so on a batch that has gone
quiet, check the log tail's newest `tool_progress` `elapsed_time_seconds` too. So the pass also keeps
each running worker's last progress (a stage change, a commit on its worktree's HEAD or a push of its
branch) and, with none for 45 minutes (90 at Stage 5), lists it once under WAITING ON YOU as `NOT
PROGRESSING`, leaving it running; a suite wait under its ceiling pauses that clock, a usage hold
stops it until the hold lifts, and every new session starts it again. Recovery for both is
in `references/orchestrator-recovery.md`.

**Stages 4b and 7 run in a fresh session.** A worker ends its session after Stage 4 and after
Stage 6 with `AUTOPILOT_HANDOFF: 4b` (or `7`) and a handoff briefing in
`$DESK_STATE/handoffs/<TICKET>.json` (the Stage 4 contract file's "Handing off"). The next pass spawns a new
session for the same ticket, worktree and branch, ahead of new tickets, starting at that stage with
the handoff briefing in its first message in place of the sibling notes (`spawned: … fresh session
from Stage 4b (handed off)`). A worktree or branch that has gone, or a briefing that is missing or
lists no criteria, parks the ticket naming it and spawns nothing. A briefing that is not JSON, even
with its raw control characters escaped, is kept as `<file>.unreadable` and replaced by one that has
the session read its criteria from the ticket; the report names it. Each session's log is a round of its own, so the
batch report's row adds every session's tokens and cost. A requeue of a ticket whose handoff session
parked or failed starts again at the stage that handoff named (`queue.mjs set <TICKET>
handoff_stage=null` first starts it from Stage 0); one that finished, and is sent back for rework,
starts from Stage 0.

**A worker also hands off partway through a stage on context.** From Stage 3 on, once a worker's
context passes its threshold (the ticket's `handoff-threshold` value, else config §2's Handoff at
context % rows) and has grown 30,000 tokens since the session started, `hooks/desk-handoff.py` has
it commit, write a briefing with what is left of the stage, and print `AUTOPILOT_HANDOFF: <that
stage>`. The next pass starts a fresh session at that same stage (`handed off partway through Stage
5 on context (31% used; handoff-threshold 30)`). When two sessions in a row hand off partway through
the stage they started at with no new commit, the pass raises the ticket's threshold once, to the
one they ran on plus 25 points (at most 80), and says so on that line. The third such handoff in a
row at one stage parks the ticket instead, naming the stage. `desk-env drift` names a §2 row that a
fresh worker's measured start-up use already reaches (`STARTUP`).

**A requeue after a park at Stage 3 or later resumes that round.** When a worker parks, the pass
records the stage it reached and its question on the ticket (`last_round`). The fresh spawn after a
requeue starts at that stage, with a summary of the round in its briefing: the stage, the park
question and the answers recorded since, and the branch and its commits (`spawned: … resumed at
Stage 4, where its last round parked`). A park before Stage 3, a worktree removed for a fresh branch,
and a stalled or failed worker start at Stage 0. So does a worktree on another branch, or
a resume file there that records another branch: the briefing says why, and the worker's first stage
line repeats it.

**A requeue after the ticket file's Decisions change restarts at Stage 3.** For a ticket with a PR and
a ticket file (`$DESK_STATE/tickets/<TICKET>.md`), the spawn compares its `## Decisions` entries with
the PR's last desk review (the latest verdict review the person's logins posted, else the PR's open
time). An entry dated after that review's day, or on it when the file was written since, restarts the
worker at Stage 3, whatever stage a handoff or last round names. The briefing lists the new entries,
and the worker checks the branch for each before building it (`spawned: … restarted at Stage 3: 1
Decisions entry dated after PR #<n>'s last review`). The spawn records the time as the queue's
`decisions_seen`, and later spawns compare with it where it is after the review, so the restarted
session's own handoff to 4b, and a requeue after a session that found every entry met and pushed
nothing, do not restart again. A round whose worktree or resume file is refused starts at Stage 0
with the entries instead. An unfinished fix try keeps its own task, and a PR gh cannot read is said in
the report and resumes as before. For a GitHub issue (`issue-<n>`), the spawn first refreshes the
ticket file from the issue when its updated time is after the last read, and a criterion or comment
change with the PR open is written in as such an entry (`refreshed from issue #<n>` on the spawn line).
