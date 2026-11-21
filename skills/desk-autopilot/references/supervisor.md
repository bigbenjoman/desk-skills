# desk-autopilot: the supervisor

Part of desk-autopilot, read at Stage 4 when `run-by.mjs stage4` says `supervisor`, and in a session
opened from a supervisor's handoff. It binds exactly as the core `SKILL.md` does. Where it says
"above" or "below" of something this file does not hold, or cites a section in *italics* it does not
hold, that is in the core or in the file the core's reference table names.

### The supervisor

`supervisor.mjs` runs passes from launchd on macOS, or a systemd user timer on Linux, with no model in
the loop, so a batch keeps moving while no session is open and after a reboot. `install` (run inside the
repo, once per repo) writes the agent `com.desk-skills.supervisor.<slug>` (on Linux, that name's
`.service` and `.timer` in `~/.config/systemd/user`, enabled with `systemctl --user`): a tick at login
and every 3 minutes (`--interval <s>` to change it). On Linux, ticks stop at logout unless lingering is
on (`loginctl enable-linger`), and install says when it is off. On WSL, ticks run only while WSL is up,
and lingering does not keep it up: WSL stops once every terminal closes. Keep a terminal open, or add a
Windows Task Scheduler entry at logon that runs `wsl.exe --exec sleep infinity` (with `-d <distro>` if
the supervisor's distro is not your default), with "Stop the task if it runs longer than 3 days" turned
off; install says this on WSL. `uninstall` removes it, and no further passes run for that repo. `status` shows the agent, the
batch and the log's tail. Each tick, for a batch handed over at Stage 4:

- skips while a pass holds `<state>/orchestrator.lock`, or the previous tick's pass still runs, and
  logs the skip;
- first reads every declared config row through `desk-env get --json`. A fatal error (a value the
  row's reader refuses today, such as `none` beside another item) runs no pass and spawns no worker
  that tick, logs the row, and pushes one notification naming the row, the item and the form
  expected, not repeated while the row stays as it is (a row fixed and then broken again is pushed
  again). Such a tick still stops a decider past its time and watches the merge driver, as an idle
  tick does. An error that is not fatal never blocks
  (`desk-env drift` reports it). `DESK_CONFIG_PREFLIGHT=off` turns the check off: in a tick's
  environment, or set when `install` runs, which carries it into the installed agent; the log then
  says the check is off;
- runs `pass.mjs --json`, passing on only the approvals recorded with the batch (`approved.workers`
  as `AUTOPILOT_USER_APPROVED=1`, `approved.base_push` as `AUTOPILOT_BASE_PUSH_APPROVED=1`). It never
  grants one it was not given, so a batch whose `ask` was never answered spawns nothing and the pass
  says why;
- where the base is behind and §3 `batch-base-push` is `ask` with no `approved.base_push`, the pass
  records `base_push_ask` on the queue rather than listing it as waiting, so no decider takes it:
  `/desk-needs-you` asks it once as the batch's `base-push` item, and its `approve` sets
  `approved.base_push`;
- where a base sync merged but its push was refused while the base lags too far for anything to
  spawn, the pass records `base_sync_stuck` on the queue: `/desk-needs-you` lists it first as the
  batch's `base-sync` item, naming the frozen tickets and the command that pushes the base, and the
  next pass that finds the base current clears it;
- appends the report to `<state>/supervisor.log`;
- sends one desktop notification, titled with the repo, for the pass's `push` entries the last
  notification did not carry (the check-in digest, a production-broken park), or for a pass that
  refused or failed. This replaces Stage 6b while the supervisor runs;
- starts the merge driver for the queue's tickets (it reads their holds from the queue) while tickets
  are still to merge and no driver holds `<state>/merge-driver.lock.d`, where §3 `autopilot-merge` and
  `pr-merge-green` are both `yes` or the batch's `approved.merge` is `true`. Declined, it starts none,
  and each green PR the pass lists as `READY TO MERGE` goes to the next check-in digest;
- when a pass needs the person, starts the decider (`decider.mjs`): one fresh headless session per
  repo at a time, at low effort, given only that pass's report and `references/orchestrator-recovery.md`.
  It settles what those rules let you do without asking (a requeue of a lane A, B, D or E worker's park that
  needs more agent work, and where §3 `autopilot-judgement` is `yes`, taking the recommended option of
  a park on a take call: answered, requeued and logged as the decider's) and hands the rest to the check-in digest, which lists it (`<state>/handed.json`).
  A lane C park, a lane D parked at triage on its design, and anything needing a §3 row that is not `yes` go to the digest without a
  session; an item handed on and not answered since starts none, and an answer to one (`answer.mjs`,
  the digest's included) runs a pass again even in an idle batch. A decider still running after 15
  minutes is stopped and its items handed on as `decider timed out`. What each session cost, settled
  and handed on goes in the next report in `<state>/supervisor.log` and in the batch notes;
- once a pass reports the batch idle, runs nothing more for it until the queue changes (a new batch,
  or a ticket admitted or requeued into this one), a park is answered, or, with anything parked,
  failed or held behind a blocker in no batch, `DESK_IDLE_RECHECK_MS` (30 minutes) passes, or
  `DESK_RUN_RECHECK_MS` (2 minutes) while a park waits on an Actions run or a PR's checks. A pass asks
  GitHub whether a held ticket's outside blockers landed at most once in that interval, busy batch or
  idle.

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
11 and runs the batch in the session, and the report gives its `error` and `retry` command. On a
computer with neither launchd nor a systemd user manager that answers (`systemctl --user`), the row
reads as `session`.

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
render` (`queue.mjs render --batch <EPIC>` for an epic's batch), then deals only with what waits on the person: parks, answers (Stage 5), gates to relay
(Stage 6c), the items the decider handed on (`<state>/handed.json`) and the close-out. It runs no
pass of its own, and starts no loop or driver, while the batch stays handed over.

**Standing intake** keeps the supervisor fed between sessions. Where config §3b "Intake query" names
a Jira query and §3 `autopilot-workers` is `yes`, each tick runs `intake.mjs` first, which searches
at most every 15 minutes. Each new ticket the query finds is triaged once (`triage.sh`, three a
run, the rest the next) and admitted (`queue.mjs admit <KEY> --by intake`) with no Stage 3 plan
approval. The ticket is held behind any open blocker in the batch, and behind any blocker in no
batch until it is Done in Jira and its PR has merged to the batch's base (the pass lifts that hold);
one blocked by a ticket in another live batch joins that batch. The tick's report in
`<state>/supervisor.log` says `admitted <KEY> by intake`. With no batch, or one whose tickets are
all done with no PR open, it starts one (`standing-<time>`), already handed over. A batch with a
failed ticket, or on a base, is left alone. The search reads one page of
100, and a full page is reported every time. A lane C or D ticket goes to the check-in digest instead,
as does a blocking lint finding, open triage questions, size L or XL, or a blocker that failed in
the batch: each is listed with the reason, never asked. Once the ticket is fixed,
`intake.mjs forget <KEY>` lets the next intake try it again. A batch still being planned in a
session, an empty one just made by `queue.mjs init` included, gets nothing until it is handed over. With the row unset or `none`, no intake runs. The
register is `<state>/intake.json`. Feature-mode epics are never taken in this way: they keep their
spine and owner-table approval.

**By hand**, `/desk-admit <TICKET>...` makes the same checks now on the tickets the person names and
admits each that passes into the supervisor's batch (`intake.mjs admit`), with no query needed;
what fails a check comes back to the person with why, not to the digest.

#### Raising a ticket from an event: push

A producer that raises a ticket from an event (the Sentry investigator, or any other) admits it with
`node ~/.claude/desk/bin/intake.mjs push <KEY> [--json]`, run from inside the repo. Push needs no
intake query and does not wait out the 15 minutes. It takes intake's lock, waiting while a standing
intake holds it, so the two never triage one ticket twice. Then it reads intake's register and runs
the same batch gate, triage and checks. A ticket it admits is recorded as `by: push`, and a
supervisor tick starts at once, whose report lists it. Before pushing, the producer must have
created the ticket in §4 Jira project (its key matches §4 Ticket key pattern) and made it lint-clean
(`desk-jira lint`). §3 `autopilot-workers` must be `yes`. The exit code says what happened:

| Exit | Meaning |
|---|---|
| 0 | Admitted, its batch named. Or already in the queue, the register or another batch, or done in Jira: nothing changed |
| 10 | Not admitted yet, and pushing again later may admit it: its triage failed, a standing batch could not be started, or another intake held the lock for 30 minutes |
| 11 | Not admitted until the person acts, with the reason printed: a key that does not match the pattern (refused before any Jira call), §3 `autopilot-workers` not `yes`, a batch not handed over or on a base, an epic, a ticket routed to another batch, or one handed to the digest (lane C or D, a blocking lint finding, open questions, size L or XL, or a third failed triage in a row) |
