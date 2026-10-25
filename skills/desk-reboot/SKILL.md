---
name: desk-reboot
description: >-
  Use before restarting, rebooting or shutting down this computer, or when the user asks "is it
  safe to reboot?", "what would a reboot lose?" or "get everything saved so I can restart": lists
  every open Claude session with its state and age, the desk-runner VM, dev servers and heavy
  processes, and every worktree in each configured repo with uncommitted or unpushed work; asks
  busy sessions to save a handoff, stops the runner VM cleanly, writes this session's own handoff,
  and ends with one line saying whether the machine is ready. Never reboots.
---

# desk-reboot

## Overview

Before a reboot, one pass shows everything the reboot would interrupt or lose, gets every busy
session to save a handoff, and stops desk's own VM cleanly, so that after login every piece of work
can be resumed.

**Core principle: report everything, change nothing without a yes, and never touch the reboot
itself.** This skill never reboots or schedules a reboot, never stops, kills or interrupts a
session, and never commits or stashes anyone's changes: uncommitted work survives a reboot on disk,
so it is reported, not moved.

It covers the whole computer, not one repo: sessions and the VM are machine-wide, and the worktree
check reads every repo configured in `~/.config/desk/repos/*/config.md`. The only per-repo write is
this session's handoff (step 5), in the repo it runs from.

## 1. Gather (read-only)

Two sources, in one turn:

- **Sessions: `ListAgents`.** The only source of each session's state. Every row has a name, a state
  and an age (`started 2h ago`). Read the state as:

  | `ListAgents` state | Reading | Asked to save a handoff? |
  |---|---|---|
  | `busy` | busy: working a step | yes |
  | `shell` | busy: mid-command | yes |
  | `waiting` | waiting: blocked on the user (a question or a permission prompt) | yes |
  | `idle` | idle | no: its transcript resumes as it is |

  This session is not in the list (`ListAgents` names it at the top), so it is counted separately and
  handled in step 5. An autopilot orchestrator is a session like any other; its headless workers are
  its own business, so ask the orchestrator, never a worker.

- **Everything else: `node ~/.claude/desk/bin/reboot-check.mjs`.** Read-only. For every configured
  repo it lists each worktree with uncommitted changes (and how many untracked) or commits on no
  remote, with counts; then the desk-runner VM (`desk-runner status`), then every heavy process
  (`desk-env heavy`: test suites, typechecks, dev servers), then FileVault (`fdesetup status`). Its
  last line is `summary: dirty=<n> unpushed=<n> runner=<running|stopped|absent|unknown>
  keep=<loaded|none> heavy=<n> filevault=<on|off|unknown|n/a>`. With FileVault on (or `unknown`: the
  status could not be read), a restarted Mac waits at the disk unlock screen and nothing runs until
  someone logs in, so say so in the report.
  `keep=loaded` means desk-runner's launchd agent is installed, and it starts a stopped or absent
  VM again within a minute, so the VM counts as running whatever its state reads. A repo whose
  root is unset or not a checkout here is printed as not checked: carry that into the report.

Then print the report:

```
REBOOT CHECK — <YYYY-MM-DD HH:MM>
sessions  : <n> open besides this one · <b> busy · <w> waiting · <i> idle
            <name>  busy (mid-command)  started 2h ago
            <name>  waiting             started 53m ago
            <name>  idle                started 10d ago
runner    : desk-runner <running | stopped | absent | unknown>[, keep agent loaded]
heavy     : <n>
            <pid> <args>
filevault : <on | off | unknown | n/a>[: after the restart nothing runs until you log in]
worktrees : <r> repos, <m> worktrees · <d> with uncommitted changes · <u> with unpushed commits
            <the script's per-repo lines>
            (on disk, so a reboot keeps them; reported only)
```

## 2. One confirmation

Nothing below happens until the user says yes, and silence is not a yes. Ask once, with
`AskUserQuestion`, covering only what applies:

- message the `<b + w>` busy and waiting sessions, by name, asking each to save a handoff (step 3);
- run `desk-runner down` (only if the runner is `running` or its keep agent is loaded; step 4).

Each is its own question; a no to one leaves the other standing. A no is recorded in the verdict as
a blocker, not argued.

## 3. Ask busy and waiting sessions to save a handoff

One `SendMessage` per session, to the name `ListAgents` printed:

> A reboot is planned (from session `<this session's name>`). Please finish your current step
> without starting a new one, then write your handoff to `.handoffs/<YYYY-MM-DD>.md` in your own
> repo (excluded from git, appending if the file exists), and reply to `<this session's name>` with
> `HANDOFF SAVED <absolute path>`, or `CANNOT SAVE: <reason>`. Nothing will stop or interrupt you.

- **A waiting session cannot act until the user answers what it is waiting on.** Name those
  sessions to the user: the message queues behind their question.
- **A reply is checked, not trusted.** `ls -l <path>`: the file exists and was written today. A
  session that has not replied, replied `CANNOT SAVE`, or named a file that is not there has **not**
  saved a handoff.
- **Never stop, kill, `/exit` or interrupt a session**, ask one to stop, or `TaskStop` anything you
  did not start, whatever it is running. A test suite in flight belongs to the session that started
  it; asking that session is the whole intervention.
- Idle sessions are not messaged. Their transcripts outlive the reboot and `claude -r` resumes them
  by name.

## 4. Stop desk-runner

Only if it is running or its keep agent is loaded, and the user said yes:

```bash
desk-runner down      # removes the agents, waits for `tart run` to exit; ends "nothing is left running for <VM>"
desk-runner status    # must not say running (it exits non-zero unless the VM runs), and its
                      # agents line must say "every minute not installed"
```

Report the `down` line verbatim. If `down` fails, or `status` still says running or the keep agent
loaded, that is a blocker.
`down` also removes the launchd agents that bring the VM back at login, so nothing starts it again
after the reboot: the handoff says to run `desk-runner up`, which reinstalls them.

## 5. This session's own handoff

Write `.handoffs/<YYYY-MM-DD>.md` (`date +%F`) at the root of the repo this session runs in
(`git rev-parse --show-toplevel`), appending a section if the file already exists. Outside a git
repo, ask where it goes.

Keep it out of git without changing a tracked file: if `git check-ignore -q .handoffs/x` fails,
append `.handoffs/` to `<git rev-parse --git-common-dir>/info/exclude`. Never `.gitignore`: that is
a diff in someone's repo.

It holds the `REBOOT CHECK` block, each session's reply (or that none came), and what to do after
login: `claude -r` for each session that was busy, waiting or idle; `desk-runner up` if `down` ran; the dev servers in the heavy list, to restart with their repo's §4 Dev server; and the
worktrees with uncommitted or unpushed work.

## 6. The verdict

End with exactly one line, and nothing after it:

```
READY TO REBOOT
NOT READY: <blocker>; <blocker>
```

Blockers, each named:

- a busy or waiting session with no checked handoff (`voicepa-25: no reply`, `kan-621-3d: CANNOT
  SAVE: mid-migration`), including those the user chose not to message;
- desk-runner still running, or its keep agent still loaded;
- this session's handoff not written.

Not blockers, because a reboot keeps them or they come back with one command: uncommitted or
unpushed work (on disk), idle sessions, and heavy processes whose session has saved a handoff.

**The user reboots, not this skill.** No `shutdown`, `reboot`, `osascript` restart, `pmset`
schedule or `sudo` of any kind, even after `READY TO REBOOT`.

## Red flags — stop

- About to stop, kill or `/exit` a session, or a process a session started
- About to commit, stash or clean anyone's uncommitted changes
- Messaging sessions or running `desk-runner down` before the user said yes
- Reporting a handoff as saved from the reply alone, without checking the file
- Writing `.handoffs/` into `.gitignore`
- Any command that reboots, shuts down or schedules either
