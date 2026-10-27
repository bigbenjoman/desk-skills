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

`<kind>` is `parked` (lane A, B or E), `session` (lane C or D), `spine` (feature specs), `triage`
(open triage questions) or `held` (a hold nothing else releases). Action 1 is always the
recommendation.

## 2. Ask, four at a time

Call `AskUserQuestion` with **at most four questions**, taking items in list order. For each one:

- **header**: the ticket key.
- **question**: `<repo> <TICKET>: <what is needed>`, in one line.
- **options**: the recommendation first, labelled `(Recommended)` with its reason as the
  description, then the other actions. You get four options at most, and the free-text "Other"
  is always added.
- For `resume`, `answer` and `reject`, the answer text is what gets recorded. Where the question
  offers choices ("A or B?"), make each one an option (`Resume: A (Recommended)`). Where it does
  not, the user types it in "Other", and a typed answer to a `parked` item is a resume.
- An `override <id>` action takes the user's choice as its text.

Ask the next round only after recording this one.

## 3. Record each answer

```bash
node ~/.claude/desk/bin/needs-you.mjs record <repo> <TICKET> <action> "<text>"
node ~/.claude/desk/bin/needs-you.mjs record <repo> <TICKET> override <id> "<choice>"
```

Leave `"<text>"` off for `release`, `approve`, `not-now`, `open` and `done`. Each run prints one
line saying what it recorded. Keep it for the end.

- **`MESSAGE <name>: <text>`** on the next line: a live session runs that batch, so the ticket was
  answered but not requeued. `SendMessage` that text to the session named `<name>`. If that name is
  unreachable, run `ListAgents` once and send to the one row for the same batch. If none matches,
  tell the user to give the message to that repo's session themselves.
- **`open`** (lane C or D): never requeued. Show its line, which names the `/desk-ticket <TICKET>`
  session to open.
- **`not-now`**: puts the item in the not-now register. Do not ask about it again in this run.
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
