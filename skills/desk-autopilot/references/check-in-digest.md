# desk-autopilot: the check-in digest

Part of desk-autopilot, read at Stage 6b, when a pass's `health:`, `usage:` or `maintenance:` line
holds spawns, when an idle batch still has tickets parked, and when answering from a digest. It binds
exactly as the core `SKILL.md` does. Where it says "above" or "below" of something this file does
not hold, or cites a section in *italics* it does not hold, that is in the core or in the file the
core's reference table names.

## The check-in digest

Questions and taken calls reach the person at the config §3b "Check-in times" (unset: `08:00,
17:00` local), from every repo at once, as one page and one push. A row that does not read as
HH:MM times holds spawns under `STALLED`, naming the row.

**The health watchdog.** Each pass checks that the machine can still do the work (`health.mjs`):
`gh auth status`, `desk-jira whoami` (where §4 Tracker is `jira`), `claude auth status`,
`codex login status` (unless §3 `codex-review` is `no`), the browser profile's saved GitHub login
(unless §3 `pr-images` is `no`), and free disk on the worktrees disk against §3b "Free disk floor
(GB)" (unset: 20). A check with no answer in 20 seconds fails as `timed out`, and results are reused
for 15 minutes. The report always carries one `health:` line. A failing required check holds every
new spawn (running workers carry on), is named under `STALLED` with the command that fixes it, and
goes into `push` as `health:<slug>:<check>`, which is pushed once while it stays failing. Signing
back in is always the person's; the line says `recovered` on the first pass that sees it pass.

**Weekly usage pacing.** One weekly allowance runs every repo's workers, so each pass reads the
newest 7-day reading from the `rate_limit_event` lines in every repo's worker logs written in the
last 6 hours (`usage-pace.mjs`). Pace is the share of the 7-day window gone since its last reset,
read from the event's `resetsAt`. While utilisation is more than §3b "Usage pacing headroom
(points)" (unset: 5; `off` turns it off) above pace, new spawns hold under `STALLED` and running
workers carry on; it releases by itself as the week goes on. The report always carries one `usage:`
line: `usage: 7-day 40%, pace 50%`, `… + 5: holding spawns`, `usage: no recent data` (no reading,
or the newest one's window has reset), or `pacing off`. A row that reads as neither a number nor
`off` holds every spawn, naming the row, as a malformed budget does.

**The weekly maintenance window.** One per computer (`maintenance.mjs`). With §3b "Maintenance
window" set in a repo (e.g. `Mon 06:30 UTC`, just after the weekly usage reset; unset is `none`), the
first pass at or after it opens the window, and from then every repo's pass, with a row or without,
starts no new worker, resumes included, and reports `maintenance: draining`. Each repo's workers
finish, or after its §3b "Maintenance drain limit (minutes)" (unset: 60) each one still running is
stopped with its session kept and queued to resume (`resume=maintenance`, not counted against "Resume
a killed worker"); workers in a repo whose passes are not running are waited on for 30 minutes more.
Then one pass pulls the desk-skills checkout fast-forward on a clean `main` and runs `install.sh`,
and runs `reboot-check.mjs`. Where §3 `machine-reboot` is `yes` and the check found no blocker
(anything heavy running, a worker still running in any repo, or FileVault on or unreadable, since a
restarted Mac then waits at the unlock screen until someone logs in), it restarts the computer; the
supervisor brings passes back at login, and the stopped workers resume. At `ask` (unset), or at `yes` with FileVault the only blocker, it does not restart and puts
"ready to reboot" in the next check-in, naming FileVault where it is on; at `no`
it stops there. A failed update goes in the check-in too, and does not restart. Every step, with the
old and new commit and the check's summary, goes in `~/.desk-autopilot/maintenance/maintenance.log`.
A window runs once a week; one no pass reaches within 6 hours is missed that week. An idle batch's
supervisor tick moves it on too (`maintenance.mjs step`).

**Between windows, merged desk-skills main is installed by itself.** While no window is open, each
pass checks origin `main` (at most once every 5 minutes, under a machine-wide lock, so one repo's
pass installs and any other running at once skips). It installs once origin/main has moved past the
installed commit, main's `tests` check has passed on that commit, and no worker in any repo is at
Stage 7. A pending check, or a Stage 7 worker it names, makes it wait. It fast-forwards the checkout
to exactly that commit and runs `install.sh`. Local commits on `main`, changed tracked files, or
untracked files where the incoming commits write block it, and the reason is reported once per
commit. A failed `tests` check installs nothing and pushes `release-failed-<sha>` once, from the repo
whose pass saw it first, until main moves. Each move goes in `maintenance.log` as a `release:` line.

- **Who sends it.** Each pass past a slot calls the digest. A machine-wide lock and the last slot
  sent make the first pass on the machine, in any repo, the only one to build it, and only that
  pass's `push` carries it. A slot no pass saw (nothing running at 08:00) is covered by the first
  pass after it, back to the last digest sent. An idle batch runs no pass, so the supervisor's tick,
  or the loop (`digest.mjs checkin`), runs the check-in on its own while its tickets stay parked.
- **What it lists.** Per repo: every open question (each parked ticket's question, a hold is not
  one, and each triaged ticket's unknowns), every call taken and every question settled by checking
  since the last digest, and, under `Put off`, each question the user put off whose inputs have not
  changed, once, with the date and an `ask-again` command; a put-off question is never pushed. A question
  still open at the next check-in is listed again, and the batch carries on meanwhile with every
  ticket it does not block. It is pushed only when something is new (a question the last page did
  not list, or a call taken since); otherwise the page is written and nothing is pushed.
- **Merging PRs that stopped moving.** Per repo, under `Merging, no change for 2h or more`: each PR
  the last pass found in Merging whose head and check results have not changed for two hours, with
  how long and the check holding it. Listed, never pushed.
- **Parks already Done in Jira.** Before listing a repo's parks, the digest asks that repo's Jira
  (its own `desk-jira`, run from its checkout) for their status, one `key in (...)` search per 100
  keys. A park whose status is in Jira's Done category is not asked; the repo's section names them
  in one line (`2 parked tickets are Done in Jira; their orchestrators can drop them: …`). The digest
  never writes a queue: dropping them is each orchestrator's call (`queue.mjs drop`, or `set <KEY>
  state=done`). A repo whose Jira cannot be read, or with no Jira (§4 Tracker not `jira`, or no desk
  config), has its parks listed as usual, under a line saying its Jira status was not checked.
- **Interactive close-outs.** A ticket an interactive session merges or moves to Done is noted in
  this batch's state by `closeout.mjs` (`<state>/closed-out/<KEY>.json`); the next pass records it
  done and reports it under `done:`, so it stops being listed as parked. A running ticket waits for
  its worker to end, and a note older than the ticket's place in the queue is dropped unread.
- **Where.** `~/.desk-autopilot/digest/<date>T<HHMM>.md`, named in the push.
- **Answering from it.** Each line carries its command. An answer goes through that repo's
  `answer.mjs`, exactly as Stage 5, and the page marks it answered:

```
node ~/.claude/desk/bin/digest.mjs answer <slug> <TICKET> "<answer>"
node ~/.claude/desk/bin/digest.mjs override <slug> <decision-id> "<choice>"
node ~/.claude/desk/bin/digest.mjs ask-again <slug> <TICKET>
```

  An override is recorded in that repo's decision log with who and when, and the next pass there
  lists the ticket under `WAITING ON YOU` as `decision overridden`: redo the work to the new
  choice, or put it back to the person if it cannot be.
- **Between check-ins** only a park whose question starts `PRODUCTION BROKEN: ` is pushed, at once
  and on its own (the worker contract says when a worker may use it).
- **Promotion, once a day.** Going to production is asked only in the day's last slot (`promotion.mjs`).
  Per repo with config §4 "Promotion ref" set, it lists one question covering every PR merged to
  §0 Default branch since that ref, with a staging-check page beside the digest
  (`<date>T<HHMM>-<slug>-staging.md`): each PR's title, link and the unchecked `- [ ]` items its
  Testing section leaves to a person (`desk-pr`), a PR with none under "Nothing to look at", a PR
  whose body could not be read under "Not read", each commit naming no PR (a rebase merge), and the
  §4 Staging URLs. Nothing merged: no question and no page. A Promotion ref that is unset, `none`, or
  an `origin/` branch that is not a production branch asks nothing, and the digest says why. A "go"
  is recorded in that repo's batch notes with the
  approved commit range; the repo's own promotion steps are then the person's, since skills never
  deploy production:

```
node ~/.claude/desk/bin/digest.mjs promote <slug> <from>..<to> go
```

  A pass that sees a batch PR newly merged whose title or intro starts `PRODUCTION BROKEN` pushes
  that repo's promotion question at once (`promotion:<slug>:<sha>:urgent`), not held for the
  last slot, and carries it on every pass until the evening question or a "go". A PR whose body or
  range could not be read is read again on the next pass.
