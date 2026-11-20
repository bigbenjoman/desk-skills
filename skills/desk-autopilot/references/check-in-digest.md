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
(unless §3 `pr-images` is `no`), free disk on the worktrees disk against §3b "Free disk floor
(GB)" (unset: 20), and `docker exec <container> pg_isready` where worktree setup makes a per-ticket
database in §4 Local database's container. A worktree setup that cannot reach that Postgres leaves
its ticket queued, not parked, and fails the database check, holding spawns from that pass. A check with no answer in 20 seconds fails as `timed out`; a remote check that
times out or cannot reach its host is run once more before it counts. Results are reused for 15
minutes while every check passes, and a failing run is checked again on the next pass. The report
always carries one `health:` line. A failing required check holds every new spawn (running workers
carry on), except the browser profile's: only screenshot uploads need it, and the machine's upload
queue runs none with a login that is missing, expired or turned away by GitHub, so every repo's
uploads with it wait there without spending a try, and uploads with another login (a repo's own §2
profile) still run. It is one item for the machine per login, `health:browser-signin:<id>`, told by
the first slot to find it, listed once by needs-you, and gone from needs-you and the digest once a
slot checking that login finds it passing on a fresh check (a reused passing result clears nothing). A remote check is named under `STALLED` with the command that fixes it, and goes into
`push` as `health:<slug>:<check>`, only once it has failed two runs in a row (the disk and the
database on the first); it is pushed once while it stays failing. Every remote check failing
together, one of them unable to reach its host, is the network, one `health:<slug>:network` with no
sign-in fix (only all of them refusing a sign-in is the sign-ins), and a single check that
cannot reach its host names the connection, not the sign-in. Signing back in is always the
person's; the line says `recovered` on the first pass that sees it pass. The Claude default and the
subscription this repo is pinned to (§3b Subscription, `desk-env subscription`), where each is a
login in its own folder (`desk-env logins`), get their own `claude auth status` in that folder: signed
out, one is named under `STALLED` with its sign-in command and pushed as
`health:<slug>:claude:<login>`, but it holds no spawn, and the default login's result is its own. A
subscription this repo's work does not run on is not checked here (a repo pinned to it checks it on its
own pass), so an unused one signed out raises nothing. Each of those logins whose sign-in passes
also makes one real call (`usage-probe.mjs` `probeNow`), because a login the API refuses (401, 403,
a Cloudflare page) still passes `claude auth status`. A refused call fails that login with the
API's error, told at once: the default's holds every spawn, and the pinned login's starts no new
worker, resume or decider on it. A passing call is not made again for 15 minutes; a usage limit or
no answer passes without being kept. A triage run that writes no record and whose log holds a 401
or 403 names that status, not the session limit.

**The reviewer check.** Where §4 Gate reviewers (`desk-env list gate-reviewers`) names logins, each
pass reads `gh api user` as the account desk posts verdicts from (§4 Review account's gh config
directory, `desk-env get review-account`, else the default login) and compares it with that row. A
mismatch is pushed once as `health:<slug>:reviewer`, naming both logins; a sign-in it cannot read as
`health:<slug>:reviewer-signin`. Either holds no spawn: it holds review and fix tries on every PR red
only on a §4 State check (`desk-env list state-checks`) of kind verdict, which the pass records as
`gate_hold`, and needs-you lists it as one `reviewer` item naming those PRs.

A mismatch still lets one try through: a head with no clean desk-review verdict, or a stale one, gets
its review worker while the gate is red, since the merge driver counts desk's verdict though the gate
does not. A sign-in it cannot read holds that review too, as its verdict could not post.

The hold is for a review that is missing or stale, so it never holds findings. A desk-review at the
head that is not clean, desk's own or a §4 Gate reviewer's, goes to a review fix as on any PR, whatever
the reviewer check failed on, and that PR is not recorded as `gate_hold`.

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
Stage 7. A Stage 7 worker it names makes it wait. While the head's check is pending, cancelled (read
again on later passes, never re-run) or failed, it installs instead the newest commit on main's
first-parent line between the installed one and the head whose check passed, and says why the head
was not; with none, the installed version stays. It fast-forwards the checkout to exactly that commit
and runs `install.sh`. Local commits on `main`, changed tracked files, or untracked files where the
incoming commits write block it, and the reason is reported once per commit. A failed `tests` check
on the head pushes `release-failed-<sha>` once, from the repo whose pass saw it first, until main
moves; a cancelled one pushes nothing. Each move goes in `maintenance.log` as a `release:` line.

- **Who sends it.** Each pass past a slot calls the digest. A machine-wide lock and the last slot
  sent make the first pass on the machine, in any repo, the only one to build it, and only that
  pass's `push` carries it. A slot no pass saw (nothing running at 08:00) is covered by the first
  pass after it, back to the last digest sent. An idle batch runs no pass, so the supervisor's tick,
  or the loop (`digest.mjs checkin`), runs the check-in on its own while its tickets stay parked.
- **What it lists.** Per repo: every open question (each parked ticket's question, a hold is not
  one, and each triaged or held ticket's unknowns), every call taken and every question settled by checking
  since the last digest, and, under `Put off`, each question the user put off whose inputs have not
  changed, once, with the date and an `ask-again` command; a put-off question is never pushed. A question
  still open at the next check-in is listed again, and the batch carries on meanwhile with every
  ticket it does not block. It is pushed only when something is new (a question the last page did
  not list, or a call taken since); otherwise the page is written and nothing is pushed.
- **Merging PRs that stopped moving.** Per repo, under `Merging, no change for 2h or more`: each PR
  the last pass found in Merging whose head and check results have not changed for two hours, with
  how long and the check holding it. Listed, never pushed.
- **Collision warnings.** Each pass appends one JSON line to `<state>/passes.jsonl` (running,
  eligible, held by reason, spawned, duration, queue-write failures). After 10 passes in a row each
  holding a ticket on a collision while fewer than 25% of the batch's concurrency run, that pass's
  line carries one warning naming the held tickets and the files holding them, listed per batch under
  `Warnings` and counted in the push. It is given once until the condition clears; the streak lives on
  the queue's `pass` record (`collision_streak`, `collision_warned`).
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
