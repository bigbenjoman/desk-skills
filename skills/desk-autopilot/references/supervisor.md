# desk-autopilot: the supervisor

Part of desk-autopilot, read at Stage 4 when `run-by.mjs stage4` says `supervisor`, and in a session
opened from a supervisor's handoff. It binds exactly as the core `SKILL.md` does. Where it says
"above" or "below" of something this file does not hold, or cites a section in *italics* it does not
hold, that is in the core or in the file the core's reference table names.

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
  It settles what those rules let you do without asking (a requeue of a lane A, B, D or E worker's park that
  needs more agent work) and hands the rest to the check-in digest, which lists it (`<state>/handed.json`).
  A lane C park, a lane D parked at triage on its design, and anything needing a §3 row that is not `yes` go to the digest without a
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

For an epic's batch the handoff also says that every command for it takes `--batch <EPIC>`.

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

**By hand**, `/desk-admit <TICKET>...` makes the same checks now on the tickets the person names and
admits each that passes into the supervisor's batch (`intake.mjs admit`), with no query needed;
what fails a check comes back to the person with why, not to the digest.
