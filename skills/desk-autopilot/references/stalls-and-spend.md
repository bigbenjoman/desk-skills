# desk-autopilot: stalls and spend

Part of desk-autopilot, read at Stage 4 in the session before the first pass, and whenever a pass
reports a stall, a budget or model hold, or a handoff. It binds exactly as the core `SKILL.md` does.
Where it says "above" or "below" of something this file does not hold, or cites a section in
*italics* it does not hold, that is in the core or in the file the core's reference table names.

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
`cloud`. Any other value refuses the plan, naming the row. At `cloud`, the batch plan's `workers:`
and `budget:` lines say how many tickets run in a cloud session and that a cloud session takes no
per-worker budget, and each admitted ticket's `runs:` line says where it runs. A ticket stays local,
with the reason, when its triage record says it renders (the browser lock and a dev server), needs a
database, or names in `needs_local` anything else only this computer has (stub binaries, a local
service), and when the record predates `needs_local`. A cloud ticket (`location: cloud` on the queue)
gets no worktree, preflight or local worker: the pass starts `claude --cloud` under `script` with a
prompt carrying the ticket's text, and the session pushes a branch and opens a draft PR. The pass
records the ticket done once that PR shows (on its branch, or with the key in its title, opened since
the session started), on that PR's branch; the session cannot reach the tracker, so its Jira steps are
left for you. A start that fails parks with the CLI's error and is never run locally without asking.
The report's cost table shows a cloud worker's session URL and its wall time from session start to
PR, and its tokens and cost as "not reported for cloud".

A worker whose log has not grown for 6 passes is **stopped and parked**, freeing its slot, unless
its last marker is `AUTOPILOT_DONE`: a worker that finished and then hung is stopped and recorded
done with its PR, on the first pass that reads the marker. A worker at a usage limit (5-hour, weekly
or any other) is not stalled: the pass reports it as paused, holds every spawn and resume, and
resumes it in its own session once the limit lifts, at its reset or sooner when a probe call
succeeds (orchestrator-recovery.md). Log growth
alone can lie (a hung `codex exec` heartbeats into the log for hours), so on a batch that has gone
quiet, check the log tail's newest `tool_progress` `elapsed_time_seconds` too. Recovery for both is
in `references/orchestrator-recovery.md`.

**Stages 4b and 7 run in a fresh session.** A worker ends its session after Stage 4 and after
Stage 6 with `AUTOPILOT_HANDOFF: 4b` (or `7`) and a handoff briefing in
`$DESK_STATE/handoffs/<TICKET>.json` (the Stage 4 contract file's "Handing off"). The next pass spawns a new
session for the same ticket, worktree and branch, ahead of new tickets, starting at that stage with
the handoff briefing in its first message in place of the sibling notes (`spawned: … fresh session
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
