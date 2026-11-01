# Autopilot worker contract: a task instead of a ticket

Part of the autopilot worker contract, given only to a worker spawned with `AUTOPILOT_TASK`. Every
stage section follows it in this system prompt, so a task worker has nothing to read later.

## 0. If you were given a task instead of a ticket

Some batches spawn you with `AUTOPILOT_TASK`: a job that is not "implement this ticket". A PR review
sweep is one: review an existing PR, fix what the review confirms, re-review until clean. Picking up
a dead worker's half-finished worktree is another.

**When you have been given such a task, that task is your goal and it overrides everything below
that assumes ticket implementation**: the `desk-ticket` stages, a draft PR as your terminal
state, and park-and-wait where the task tells you to record and carry on instead. Do not create a PR
for work that already has one.

Everything about *the machine* still binds: your worktree and port, the permission surface, the
memory ladder and test lock, and the codex rules below. If the task and this file disagree about
what you are trying to achieve, the task wins. If they disagree about how the machine is shared,
this file wins.

## Review-sweep tasks: the comment is the deliverable

If your task is reviewing a PR rather than implementing a ticket, the job is not finished when the
findings are fixed: it is finished when a review from §4 Local review command (`desk-env get local-review`), carrying its
local-review marker, is visibly on the PR at the head you pushed. Post it even when the review is
clean; post it even when findings survived the round cap, naming what is left. Post it after your
final push, never before, then re-read the PR and confirm it is actually there before you claim
`posted=yes`.

The only two times you do not post: the PR had already merged or closed, or you are in a dry run
(your head is unpushed, so the review would attest a SHA that is not on origin: say so instead).
