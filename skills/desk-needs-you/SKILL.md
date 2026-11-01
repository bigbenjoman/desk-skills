---
name: desk-needs-you
description: >-
  Asks the user about every item desk-q shows as "◆ needs you", across every repo on this computer
  (or one repo when named), a few at a time with a recommendation each, and records every answer
  through the existing commands. Use when the user types "/desk-needs-you", or says "what needs me",
  "clear what needs me", "answer the parked tickets", "desk-q says something needs me". Not for
  working a ticket (that is desk-ticket) or running a batch (that is desk-autopilot).
argument-hint: "[<repo>]"
---

# desk-needs-you

One script gives every item and records every answer. **Read nothing else**: no queue, worker log,
briefing or digest page, and do not load `desk-autopilot` or its references. The script already
reads them the way desk-q does.

## 1. Collect

```bash
node ~/.claude/desk/bin/needs-you.mjs list
node ~/.claude/desk/bin/needs-you.mjs list <repo>
```

Use the second form when the user named a repo. If it prints `Nothing needs you…`, say that line
and stop.

Otherwise it prints:

- `@ <repo>: …` lines, one per repo with items, saying who runs that repo's batch: the supervisor,
  a live session, or nothing because passes stopped.
- One line per item, already in the order to ask (a `PRODUCTION BROKEN` park first, then the
  longest waiting):

```
<repo> <TICKET> <kind> <waited> | <what is needed> | 1. <action> (recommended: <why>) | 2. <action> | …
```

`<repo>` is `<repo>:<batch>` for an item in a named batch (an epic's feature batch). Pass it to
`record` as it is printed.

`<kind>` is `parked` (lane A, B or E), `session` (lane C or D), `spine` (feature specs), `plan` (an
epic admitted with `/desk-admit` or by intake: its drafted plan, in the file the need names, waits
for start, discard or an edit, and its children wait behind it. The supervisor acts on the answer
at its next tick: start starts the feature batch, an edit is applied as it stands and the batch
starts, and discard removes the batch and releases the children. An edit it cannot apply cleanly
comes back as a new `plan` item naming why), `triage`
(open triage questions), `held` (a hold only you can let start, or `admit` its blocker in no batch), `stopped` (a worker gave up), `pr`
(an unmerged PR only the user's step on GitHub moves; one closed unmerged recommends `drop`),
`worktree` (no worker spawns into its worktree until it is clean) or `usage` (the batch is held on a usage limit:
one item, named `usage-limit` in place of a ticket, that lifts by itself or sooner after a subscription
switch); `config`, `templates`: run `/desk-update`. Action 1 is the recommendation when it says `recommended`. A `pr` item stuck on a step
outside GitHub (a build, a staging migration) has none: its need names the step, and it leaves the
list once its check is green.

## 2. Ask, four at a time

Call `AskUserQuestion` with **at most four questions**, taking items in list order. For each one:

- **header**: the ticket key.
- **question**: `<repo> <TICKET>: <what is needed>`, in one line.
- **options**: the recommendation first, labelled `(Recommended)` with its reason as the
  description, then the other actions. With no recommendation, none is labelled. You get four options at most, and the free-text "Other"
  is always added.
- For `resume`, `answer` and `reject`, the answer text is what gets recorded. Where the question
  offers choices ("A or B?"), make each one an option (`Resume: A (Recommended)`). Where it does
  not, the user types it in "Other". A `parked` item has no `answer`: a typed answer to it is a
  resume, so it never stays parked once answered. A `session` item has none either: only `open`
  moves it. A `pr` item whose review left gaps offers `answer`: the user's call on each gap, which
  `record` posts on the PR and sends to a worker on it.
- An `override <id>` action takes the user's choice as its text.
- A `move` takes the batch's name (`standing` for the standing batch). An answer to move the
  ticket to another batch is a `move`, never a `resume`.

Ask the next round only after recording this one.

## 3. Record each answer

```bash
node ~/.claude/desk/bin/needs-you.mjs record <repo> <TICKET> <action> "<text>"
node ~/.claude/desk/bin/needs-you.mjs record <repo> <TICKET> override <id> "<choice>"
```

Leave `"<text>"` off for `start`, `requeue`, `drop`, `approve`, `not-now`, `open`, `admit` and `done`. Each run prints one
line saying what it recorded. Keep it for the end.

- **`MESSAGE <name>: <text>`** on the next line: a live session runs that batch, so the ticket was
  answered but not requeued, and desk-q shows it waiting on that session. `SendMessage` that text to the session named `<name>`. If that name is
  unreachable, run `ListAgents` once and send to the one row for the same batch. If none matches,
  tell the user to give the message to that repo's session themselves.
- **`drop`** (a PR closed unmerged): takes the ticket out of its batch (`queue.mjs drop`).
- **`open`** (lane C or D) and **`admit`**: records nothing. Show its line: it names the
  `/desk-ticket` or `/desk-admit` to run.
- **`not-now`**: puts it in the not-now register. `list` and `left` leave it out until its
  question, blocker or PR head changes, or, put off here, it gains an action. Do not ask it again this run.
- **A refusal** (exit 11): show the line, and offer to answer differently or skip it.

Where the supervisor runs the batch, nothing more is needed: its next pass picks the answer up.

Never run `queue.mjs`, `answer.mjs` or `digest.mjs` yourself, and never edit a queue: `record` runs
them against the right repo.

## 4. Until nothing is left

Once every listed item has been asked, run `list` again (with the same repo, if one was named). Ask
only about tickets not already asked in this run. Stop when none are left.

## 5. End

Print one line per item with what was recorded (the `record` lines, in order). Then run:

```bash
node ~/.claude/desk/bin/needs-you.mjs left
node ~/.claude/desk/bin/needs-you.mjs left <repo>
```

Print its output last. Its first line is the desk-q count still left. A line follows for each repo
whose passes stopped, saying how to resume them.
