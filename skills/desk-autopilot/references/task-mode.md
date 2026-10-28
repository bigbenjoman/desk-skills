# desk-autopilot: task mode

Part of desk-autopilot, read only for a batch whose unit of work is not a ticket. It binds exactly as
the core `SKILL.md` does. Where it says "above" or "below" of something this file does not hold, or
cites a section in *italics* it does not hold, that is in the core or in the file the core's
reference table names.

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
