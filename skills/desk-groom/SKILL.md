---
name: desk-groom
description: >-
  Use when grooming this repo's Jira backlog: "groom the backlog", "is anything open already done",
  "which tickets are duplicates", "what links are missing", "which tickets cite stale code", "fill
  in the blank priorities", "clear the dead blockers". Checks every open ticket against the default
  branch and the rest of the backlog, and proposes each fix as a desk-jira gate block with its
  evidence. It writes nothing.
argument-hint: "[--jql <jql>]"
---

# desk-groom

## Before anything: this repo's config

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no  (exit 3 outside a repo)
```

Then **Read the `CONFIG` file**. `EXISTS=no` means stop: say which slug was looked up and offer
`/desk-setup`. **§4 Tracker `none` means stop too**: there is no backlog to groom here. Never borrow
another repo's config.

What it answers here: §0 for the GitHub repo and default branch, §2 for the primary repo root, §3 for
which writes a proposal would need (`jira-edit`, `jira-close`, `jira-transition`), §3b for the
fan-out, and §4 for the Jira project, Done state, Priority, Other fields and Ticket key pattern.

## Overview

The backlog drifts between hand grooms: a dependency sits in prose that autopilot does not read, a
ticket cites a line that moved, done work stays open, a duplicate gets filed, a priority is left
blank, a ticket waits on blockers that finished months ago. desk-groom checks every open ticket for
each of these and proposes the fix with the evidence that justifies it.

**Core principle: no evidence, no proposal; nothing is written.** Every block this skill prints is
`awaiting approval`, whatever §3 says. Writing the approved list is a separate step.

Epics are not checked here, only used: an epic's priority and its children's title prefix feed the
per-ticket checks.

## 1. Precondition: `origin/<default branch>` is current and not shallow

Every check against code reads `origin/<default branch>`, and a stale ref makes landed work look
open. Run desk-cleanup's precondition (its `SKILL.md`, "Precondition") from §2 Primary repo root
before the scan, and stop if the SHAs still differ after a fetch.

## 2. Scan

`bin/groom-scan.mjs` does every check that reads the same every run. It only reads: Jira through
`desk-jira`, the repo through `git`.

```bash
node ~/.agents/skills/desk-groom/bin/groom-scan.mjs scan --repo <§2 Primary repo root> --default <§0 Default branch> --project <§4 Jira project key> --priority <§4 Priority> --fields <§4 Other fields, comma-separated> --done '<§4 Done state>'
```

Run it from inside the repo, so `desk-jira` resolves this repo's Jira. It covers every open ticket in
the project (`--jql` narrows it: one epic, a key range). More than 100 open tickets is refused rather
than groomed in part: split it with `--jql` and run each part, and say in the report that duplicates,
links and Blocks loops between two parts were not compared. `--json` gives the findings as data: run
it once more with `--json`, redirected to `<scratchpad>/groom-scan.json`, for step 3's verdict.

| Check | What it reads | What it proposes |
|---|---|---|
| `landed` | commits on main that name the ticket's key; commits under another key that touch a file the ticket cites and share its title's words; a name the ticket says it adds that main already has | §4 Done state, **only after step 3** |
| `duplicate` | two open tickets whose titles share most of their words | a `duplicates` link from the newer to the older, and the newer closed, **only after step 3** |
| `link` | a ticket that names another open ticket in prose with no link, in wording that orders them (`blocked-by` for after, needs, builds on, once…; `blocks` for before, feeds…; a bare mention proposes nothing); a command, flag or field one ticket adds and another uses; two tickets that both change the same function | `desk-jira link`, with both lines as evidence |
| `stale` | each `path:line` citation: a file that is gone or moved, a line past the end, a name beside the citation that is no longer at that line; and each premise with no citation, a line outside the criteria, outcome, verification, design and out-of-scope sections that names a function, `--flag` or repo file main does not have and no open ticket adds | the edit (`from -> to`) where the name is a whole word on exactly one line of the file; otherwise, for a file that moved and for every premise, a verifier settles it (step 3) |
| `field` | a blank §4 Priority or §4 Other fields value | the priority from the ticket's epic, else the one most of its open siblings hold; any other field is judged (a size from desk-jira's scale) |
| `title` | a title with no area prefix, or a different one, where most of its epic's other children share one | the title with that prefix, in place of any other |
| `blocker` | a Blocks link to a Done ticket; more than 10 open blockers; a loop of Blocks links | `desk-jira unlink` for a Done blocker; a rescope for the other two, which can never all be Done |

A finding marked `[verify first]` is a candidate, not a proposal. **No evidence, no finding**: the
scan proposes a link only from a line that shows it, never from two tickets merely looking related.

## 3. Verify the candidates: one read-only verifier each

Fan out one read-only subagent per `landed`, `duplicate` and `stale` candidate marked `verify
first`, within §3b "Subagents that may run without asking". **No verifier writes to Jira or the
repo.** Brief each with the ticket's full text (`desk-jira get <KEY>` and `desk-jira comments
<KEY>`), the scan's evidence, and `origin/<default branch>`:

- **`landed`**: desk-jira's *"Already fixed"* rule. Every acceptance criterion, scope item and comment
  that adds scope is cited to `file:line` on `origin/<default branch>` or marked NOT MET, **defaulting
  to NOT MET**. Anything partial, ambiguous or narrowed by a later ticket is NOT MET. It also runs
  desk-cleanup's open-PR check for the key (its step 1: `gh pr list --search` through
  `cleanup-scan.mjs key-filter`) and lists any open PR. It returns
  `{"ticket": "<KEY>", "criteria": [{"id": "AC1", "met": true, "cite": "path:line"}], "open_prs": [], "scope_left": []}`.
  Write every verifier's result into one JSON array with the Write tool, then let the script decide.
  It checks each result against the criteria the scan read from the ticket, so a criterion a
  verifier left out is NOT MET:

  ```bash
  node ~/.agents/skills/desk-groom/bin/groom-scan.mjs verdict <results.json> --scan <scratchpad>/groom-scan.json
  ```

  Only `close: true` becomes a proposal; every other ticket stays open, and its `reasons` go in the
  report. **Never override a verdict by hand**: a triage pass's "already fixed" is overturned by a
  per-criterion check more often than not.
- **`duplicate`**: do the two describe the same defect or change? Same outcome and same criteria is a
  duplicate. Overlapping scope with different outcomes is a `relates-to` link instead, or a judgement
  call to put to the user with both options. Never propose closing either on title alone.
- **`stale`**: what does main say now? Return the corrected text for the stale sentence, or "premise
  gone" with the file:line that shows it. That becomes the description edit. A premise the scan
  flagged may name something outside this repo, or under another name: "still true" with the
  file:line that shows it drops the finding.

Read what each verifier returns as you would a colleague's finding: a verdict with no `file:line`
behind it is NOT MET.

## 4. Propose

Print every surviving proposal as a desk-jira gate block, **`awaiting approval`**, one per write, the
evidence first:

```
JIRA <EDIT | TRANSITION> — awaiting approval
target : <KEY>
check  : <landed | duplicate | link | stale | field | title | blocker>
evidence:
  <each evidence line the scan or verifier gave, with file:line or commit>
---
<the exact desk-jira command, or for a description edit the exact before and after text>
```

The §3 row each one would need when written: a link, unlink, field or title edit is `jira-edit`; a
close as already fixed or duplicate is `jira-close`. Name it in the block so the person approving
sees what it unlocks. A rescope is a proposal of what the ticket should wait on, with the unlink
commands for the rest. Nothing here is posted, transitioned or linked, even where §3 says `yes`.

End with a one-line count per check, and a `kept open` list: every close candidate step 3 kept open,
with its reasons. That list is how a wrong guard becomes visible.

## Keep them posted

Say what is running before the scan and before the fan-out, and report as each verifier returns.
Never work through the whole backlog in silence and present a wall at the end.

## Red flags: stop

- About to run a `desk-jira` write (`edit`, `link`, `unlink`, `transition`, `comment`) from this skill
- Proposing a close without a verdict from step 3, or overriding one
- Proposing a link because two tickets "look related", with no line that shows it
- Proposing a size or a priority you cannot point to a source for, as if the scan had found it
- Scanning against a stale or shallow `origin/<default branch>`
- Grooming part of the backlog and reporting it as all of it

## Common mistakes

| Mistake | Fix |
|---|---|
| Closing a ticket because a commit names its key | A partial fix often merges first; every criterion is checked, and an open PR on the key vetoes |
| Taking the epic's size for a child | A priority follows the epic; a size is the ticket's own |
| Unlinking every blocker of an over-blocked ticket | Propose what it truly waits on, and unlink only the rest |
| Writing a dependency into a description | Dependencies are links; autopilot reads only the Blocks links |
| Treating a moved line as a wrong premise | Where main shows the name at another line, the edit is the line number |
