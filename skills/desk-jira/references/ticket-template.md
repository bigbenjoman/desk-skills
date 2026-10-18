# Ticket template

Every ticket desk writes uses one layout: a ticket written through `desk-jira create` by hand, a
ticket Bea drafts, and every machine-written ticket (a `desk-ticket` spin-off, a `desk-pr`
follow-up, an autopilot L split or epic close-out child). Triage and workers read these sections by
name. A ticket that has them can be picked up cold. A ticket missing them parks, or gets built from
a guess.

§5 Ticket format `default` means this file. Where a repo's §5 Ticket format names its own sections,
use those headings, but the substance below still goes in them: the rules, the criteria shape and
the Bug's diagnosis. With §5 Ticket format still `TODO`, ask, and offer `/desk-setup`.

Write the body in markdown in a `.md` file. `desk-jira create` converts it to wiki markup (desk-jira
*Transport*). Each section is one `##` heading, so the rendered ticket has one `<h2` per section.
That is the render check's count.

## Rules for every type

- **No status, priority or size in the body.** They are fields (desk-jira *Fields*), except the
  first-line `Size: M` for a project with no Size field (desk-jira *Epics*).
- **Dependencies are Blocks links, never prose** (desk-jira *Epics*). With §4 Tracker `none` a
  GitHub issue has no Blocks link, so it carries one `Blocked by #<n>` line per dependency. That
  line is for people only: autopilot reads Jira links alone, so nothing holds the issue back.
- **The body opens in this order**: a `Size:` line where one is allowed, then any `Blocked by`
  lines, then the `_Context:_` line, then the first `##` section.
- **Every acceptance criterion is one the worker who picks the ticket up can do and check**, in its
  branch and its PR. These are never acceptance criteria: creating or editing Jira links (the filer
  does that when filing), a live production measurement, a run only an operator can do, or someone's
  sign-off. A human or device step belongs under Verification, with the person who does it.
- **The design is a URL in the Design section.** A web link or an attachment alone is not read by
  triage. With nothing to show, write `No UI.`
- **Decisions are dated and name who made them. None of them is open.** An open question is asked
  before the ticket is filed, never written into it. No `TBD`, `TODO`, "to confirm" or "pending
  sign-off" anywhere in the body.
- **Waiting on someone else's input is a precondition, not an open decision.** A legal follow-up
  waits for sign-off, and a placeholder-copy spin-off waits for the final copy. Name the input and
  who supplies it as the first line of Verification, `Precondition: <person or role> supplies
  <what>`. Then keep the ticket out of autopilot batches until it arrives.
- **Behaviour in the criteria, mechanism elsewhere.** File paths, component or library names and
  regexes go in Build on (or a Bug's Diagnosis), never in a criterion.
- **No section is dropped.** `None.` is an answer for Out of scope, Decisions and Build on.

## Acceptance criteria

A numbered list. Each item is `AC<n>: Given …, when …, then …`, and a tester can run it and get a
yes or a no. A criterion that cannot fail cannot tell anyone the work is finished.

- **One behaviour per criterion, with exactly one `when`.** A second action is a second criterion.
- **`Given` is concrete**: a real role, state and data ("a repo whose §5 Ticket format is TODO"),
  never "a user" or "some data".
- **`When` is one thing a person or the system does**, at the level they do it ("runs
  /desk-setup", "the webhook arrives"), not a code path.
- **`Then` is observable**: what someone sees, what is stored, sent or logged. Never "it works",
  never a function name. Copy is the agreed text or its i18n key, never invented wording.
- **Cover the unhappy paths.** Every rule that refuses, limits or fails gets its own criterion:
  permissions, validation, the empty state, an upstream error.
- **A Bug's AC1 is the reproduction, put right.** Its `given` and `when` are the steps to reproduce.
  Its `then` is the expected result.

## Story and Task

A Task uses the Story layout. It is not a to-do list: its criteria say what must be true once it is
done. Any steps worth writing down go in Build on.

```markdown
_Context: <one line naming the parent epic or story; omit when there is none>_

## Outcome
<who this is for and what changes for them, in two or three sentences>

## Acceptance criteria
1. AC1: Given <state>, when <one action>, then <observable result>.
2. AC2: …

## Verification
* Unit: <the specs or suite that prove it, or "none" and why>
* Manual: <the steps, the environment (local, a preview, the §4 Staging URL, a named device), and
  who does any human or device step>

## Design
<the Figma dev link or Claude Design artifact URL, naming the boards that apply; or "No UI.">

## Out of scope
* <what this ticket deliberately does not do>

## Decisions
* <yyyy-mm-dd> <who>: <what was decided>

## Build on
* <the existing modules, patterns or path:line to extend, not a file tree or skeleton code>
```

## Bug

The Story sections, with Problem in place of Outcome and three more after it.

```markdown
## Problem
<what is wrong and who it affects, in two or three sentences>

## Where seen
<the URL on §4 Staging or §4 Production, or "local"> · <browser or device, if it matters> · seen <yyyy-mm-dd>

## Steps to reproduce
1. <step>
2. <step>

**Expected:** <what should happen>
**Actual:** <what happens>

## Diagnosis
Read at <short sha> on origin/<default>.
<file:line references and the actual mechanism>
Suggested fix: <one or two sentences>

## Acceptance criteria
1. AC1: Given <the reproduction's state>, when <its action>, then <the expected result>.

## Verification
## Design
## Out of scope
## Decisions
## Build on
<these five as for a Story>
```

The diagnosis names the commit it was read at. A line number goes stale as the default branch
moves, and the worker needs to know whether the code still matches it. With no diagnosis yet, say
`Not diagnosed.` under the heading rather than guessing one.

## Epic

```markdown
## Outcome
<who, and what changes for them once the whole feature is in>

## Definition of done
1. DoD1: Given …, when …, then … (the feature end to end, in the criteria shape above)

## Verification
<how the whole feature is checked, the environment, and who does any human or device step>

## Design
<the link, or "No UI.">

## Out of scope
* …

## Decisions
* <yyyy-mm-dd> <who>: …

## Children
1. <KEY or planned summary> (<size>): <one line>
```

The children are listed in build order. The order is a reading aid: the Blocks links are what
autopilot follows. Each child is a Story, Task or Bug in its own layout, size M or smaller, with
its `_Context:_` line naming the epic. Before the user approves the set, run
`references/epic-readiness.md`.

## Subtask

The Story layout, scoped to its parent. The `_Context:_` line names the parent story. Design may
point at the parent's link when it is the same design, written out as the URL, not as "see
parent". A subtask's criteria are checked by its own worker, so they never just repeat the parent's.
A project may give subtasks no Size field (Jira then refuses one with a 400 naming the field): leave
it off and size the parent.

## Before you file

1. Every section of the type is there, under its `##` heading, in this order.
2. Every criterion is Given / When / Then, one `when` each, and a worker can do it.
3. No status or priority line, and no size line beyond the allowed first one; no open decision; no
   dependency in prose. `desk-jira lint body.md <type> [field=value ...]` checks these and items 1
   and 2, and `create` refuses a blocking finding (desk-jira *House ticket format*).
4. After `create`: `desk-jira get <KEY>` reads the fields back. The render check (desk-jira
   *Transport*) counts one `<h2` per `##` heading sent and no `<del`.
5. After `create`: `desk-jira link` each dependency (with Tracker `none`, the `Blocked by #<n>`
   lines record them, for people only).
