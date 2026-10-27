# desk-groom: write the approved list, hand off priority epics, and the weekly report

Read at step 6 of `../SKILL.md`, when the user has answered the approval list, when the groom was
asked for a priority epic, or when the run is the weekly report-only one. The config, the scan and
the approval list are in `SKILL.md`, already loaded.

## 6. Write the approved list, then read every write back

The user's answer to step 4's list is the approval, whatever §3 says: `all`, `none`, or the item
numbers (`1,3-5`). Anything else is asked again. An approval covers only the numbers it names;
nothing outside the list is written, and a question block is answered, not approved.

Before writing, check the batch again: the approval can come long after the scan, and a batch may
have admitted a ticket since. Pass every key the approved items name:

```bash
node ~/.agents/skills/desk-groom/bin/groom-scan.mjs held --queue <DESK_QUEUE> <KEY>...
```

It exits 1 and prints `left alone: <KEY> is <state> in batch <name>` for each one the batch now
holds. Drop every approved item that names one, and say so in the report.

Then write each approved item, in its number order, with the exact `desk-jira` command its block
shows. A description edit's command names a placeholder (`description=@<KEY description with the
edit>`): write the full new description to a file in the scratchpad with the Write tool and run the
command with that file's path. Each `landed` close runs step 5's `preclose` first, as that step says.
A write that fails is reported with its error, never retried by another route.

When the writes are done, read every one back:

```bash
node ~/.agents/skills/desk-groom/bin/groom-scan.mjs readback <scratchpad>/approval.json --approved <the numbers written>
```

`--approved` takes the numbers actually written: the user's answer less every item `held` dropped,
`preclose` kept open or whose write failed, each of which is already reported with its reason.
`approval.json` is step 4's list, written with `approval --json`. For each of those commands it reads
the ticket from Jira again: the status a transition set and the value a field edit set (any value,
where the block proposed `<value>` for the user to choose). A `link` or `unlink` was read back by
`desk-jira` as it was written, which exits 1 when the link is not as asked. For a description edit it reads the rendered HTML and
fails on any `<del` (a hyphen Jira read as strikethrough: escape it, `\-`, and edit again), and on
the new text or Children rows missing. It prints `ok` or `FAIL` per command and exits 1 on any
`FAIL`. Report every `FAIL` with its line; never report a write as done that did not read back.

## 7. Priority epics: hand their open work to the batch's orchestrator

When the user names one or more epics as the priority (`--priority <EPIC>...`), list their work:

```bash
node ~/.agents/skills/desk-groom/bin/groom-scan.mjs priority <EPIC>... --queue <DESK_QUEUE> --state <DESK_STATE>
```

(`desk-env paths` prints both.) It reads every open child of each epic, in rank order, and,
transitively, every open ticket one of them is blocked by, and leaves out every ticket already in the
batch's queue (named apart). It prints the list in Blocks order (every blocker before what it blocks,
a Blocks loop named), with the files the tickets share: each ticket's triage record where the batch
triaged it, else the files its text cites.

**With a batch running**, the printed text is the message for its orchestrator. Find the
orchestrator session with `ListAgents` (it is named after its batch, which the message names) and
send the message with `SendMessage`. The orchestrator puts the tickets to the user and admits them
itself. **Never run `queue.mjs admit`, or any other queue write, from the groom's session.** A batch
run by the supervisor has no session to send to, and the message says so: print it for the user,
who admits it.

**With no batch running**, the message says so: offer the list to the user as the next batch, in
that order, and start nothing.

## The weekly report-only run

A run with `--report` only reports. It runs steps 1 to 3 as usual, and at step 4 prints the list with
`approval --report` (every block `report only`, the questions listed rather than asked, and a closing
line that asks nothing). Where it was given priority epics it prints step 7's list without sending
it. Then it stops: it asks no question, writes nothing to Jira, sends no message and runs neither
step 6 nor step 7's send. To run it weekly, schedule
`/desk-groom --report` (a `/schedule` routine or a cron job running it headless) in the repo's
primary checkout.
