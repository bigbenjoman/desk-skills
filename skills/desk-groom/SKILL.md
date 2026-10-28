---
name: desk-groom
description: >-
  Use when grooming this repo's Jira backlog: "groom the backlog", "is anything open already done",
  "which tickets are duplicates", "what links are missing", "which tickets cite stale code", "fill
  in the blank priorities", "clear the dead blockers", "is every epic's Definition of done covered",
  "fix the Children lists", "which tickets have no epic", "does anything outrank its epic". Checks
  every open ticket and epic against the default branch and the rest of the backlog, proposes each
  fix as a desk-jira gate block with its evidence, and asks the user each call with no single correct
  fix. Also "these epics are the priority", "send this epic to the batch", and the weekly report-only
  groom. It writes only what the user approves from one list, and reads every write back.
argument-hint: "[--jql <jql>] [--priority <EPIC>...] [--report]"
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
fan-out, and §4 for the Jira project, Done and In-progress states, Priority, Priorities only you set,
Size field, Other fields and Ticket key pattern.

## Overview

The backlog drifts between hand grooms: a dependency sits in prose that autopilot does not read, a
ticket cites a line that moved, done work stays open, a duplicate gets filed, a priority is left
blank, a ticket waits on blockers that finished months ago. Epics drift too: a Definition of done
item nobody owns, a Children list that missed a split, loose tickets outside any epic, a ticket that
outranks the epic it serves, an epic still in To Do with its children done. desk-groom checks every
open ticket and epic for each of these and proposes the fix with the evidence that justifies it.

**Core principle: no evidence, no proposal; nothing is written before the user approves.** Every
proposal arrives in one list, every block `awaiting approval`, whatever §3 says. Writing the approved
items is a separate step (step 6), every approved `landed` close is checked again first (step 5), and
every write is read back. A ticket the running autopilot batch holds is left alone, and a priority
epic's work goes to the batch's orchestrator to admit, never admitted here (step 7). The weekly run
only reports.

**A fix or a question, never both.** A finding with one correct fix is proposed, never asked. A
finding with no single correct fix (two tickets that could each own the scope, a DoD item either of
two children could take, a loose ticket two epics fit equally, which of a ticket's many blockers it
truly needs, which link in a Blocks loop to cut) is a judgement call: it is asked, with
the options and a recommendation, and nothing is proposed for it. A loose ticket is always asked,
even with one clear home: the user decides where a ticket lives.

## 1. Precondition: `origin/<default branch>` is current and not shallow

Every check against code reads `origin/<default branch>`, and a stale ref makes landed work look
open. Run desk-cleanup's precondition (its `SKILL.md`, "Precondition") from §2 Primary repo root
before the scan, and stop if the SHAs still differ after a fetch.

## 2. Scan

`bin/groom-scan.mjs` does every check that reads the same every run. It only reads: Jira through
`desk-jira`, the repo through `git`.

```bash
node ~/.agents/skills/desk-groom/bin/groom-scan.mjs scan --repo <§2 Primary repo root> --default <§0 Default branch> --project <§4 Jira project key> --priority <§4 Priority> --fields <§4 Other fields, comma-separated> --size <§4 Size field> --done '<§4 Done state>' --in-progress '<§4 In-progress state>' --queue <DESK_QUEUE>
```

`--queue` is the autopilot queue `desk-env paths` prints as `DESK_QUEUE`; each named batch's queue
beside it (`batches/<name>/`) is read too. Every finding that would write to a ticket any batch holds
(queued, triaged, held, parked, running or failed) is `left`: no proposal, no question and no
verifier, only the line naming the ticket, its state and its batch.

Run it from inside the repo, so `desk-jira` resolves this repo's Jira. It covers every open ticket in
the project (`--jql` narrows it: one epic, a key range). More than 100 open tickets is refused rather
than groomed in part: split it with `--jql` and run each part, and say in the report that duplicates,
links and Blocks loops between two parts were not compared. `--json` gives the findings as data: run
it once more with `--json`, redirected to `<scratchpad>/groom-scan.json`, for step 3's verdict.

| Check | What it reads | What it proposes |
|---|---|---|
| `landed` | commits on main that name the ticket's key; commits under another key that touch a file the ticket cites and share its title's words; a name the ticket says it adds that main already has | §4 Done state, **only after step 3** |
| `duplicate` | two open tickets whose titles share most of their words | a `duplicates` link from the newer to the older, and the newer closed, **only after step 3** |
| `link` | a ticket that names another open ticket in prose with no link, in wording that orders them, read only in the clause holding the key (`blocked-by` for after, needs, builds on, once… before the key; `blocks` for before, feeds… before it, or the key reading or needing this one's work; a bare mention, or wording in another sentence, proposes nothing); a command, flag or field one ticket adds and another uses; two tickets that both change the same function | `desk-jira link`, with both lines as evidence |
| `stale` | each `path:line` citation: a file that is gone or moved, a line past the end, a name beside the citation that is no longer at that line; and each premise with no citation, a line outside the criteria, outcome, verification, design and out-of-scope sections that names a function, `--flag` or repo file main does not have and no open ticket adds | the edit (`from -> to`) where the name is a whole word on exactly one line of the file; otherwise, for a file that moved and for every premise, a verifier settles it (step 3) |
| `field` | a blank §4 Priority or §4 Other fields value | the priority from the ticket's epic, else the one most of its open siblings hold; any other field is judged (a size from desk-jira's scale) |
| `title` | a title with no area prefix, or a different one, where most of its epic's other children share one | the title with that prefix, in place of any other |
| `blocker` | a Blocks link to a Done ticket; more than 10 open blockers; a loop of Blocks links | `desk-jira unlink` for a Done blocker. The other two can never all be Done, and are each a question, never a fix: for many blockers, keep the ones the ticket's text names (recommended), unlink them all, or keep them all; for a loop, one option per link to cut, a link whose blocked ticket does not name its blocker recommended |

The epic checks read each open epic's Jira children in rank order, done ones included:

| Check | What it reads | What it proposes |
|---|---|---|
| `coverage` | each DoD item of an epic: covered when an open or done child names the item (`DoD2`), the item names the child's key, or the child's Children row names the item or the label the item gives (`(ticket checks child)`); a child closed other than as §4 Done state covers nothing | nothing: an uncovered item is reported as a gap, naming it. Children that only share its words are candidates for a verifier (step 3) |
| `children` | an epic's Children section against Jira: a listed ticket that is not its child (or not in Jira), closed other than as §4 Done state, split (a `split to` link) or renamed (its row shares under two words with its title), and a child the section does not list | the corrected Children section as one description edit: the split's pieces in its place, the dropped rows gone, a renamed row retitled, the unlisted children added in rank order |
| `loose` | an open ticket with no parent epic, against each open epic's title, outcome and children's titles; an epic named as a catch-all (misc, backlog, bucket, other, general, chores, tech debt…) is never a home | a question, never a move: the best-fitting epic recommended, or "a new epic" with a draft title when none shares two words; two epics within 85% of each other are both options |
| `priority` | an open ticket whose §4 Priority is above its parent epic's, or above an epic it blocks | re-ranking one of the pair: the epic rises to the ticket's priority when at least half of its other open children sit there or higher, else the ticket comes down to the epic's, as it stands after any raise |
| `status` | an epic in To Do with a child started or done; an open epic whose every child is done | a transition to §4 In-progress state, or to §4 Done state, naming the children it rests on. An epic with no children is left alone |

Each finding has a `kind`: `fix` (proposed), `question` (asked: `question`, `options`,
`recommend`, nothing proposed) or `report` (a gap, nothing to write). A finding marked `[verify first]` is a candidate, not a proposal. **No evidence, no finding**: the
scan proposes a link only from a line that shows it, never from two tickets merely looking related.

## 3. Verify the candidates: one read-only verifier each

Fan out one read-only subagent per `landed`, `duplicate`, `stale` and `coverage` candidate marked
`verify first`, within §3b "Subagents that may run without asking". **No verifier writes to Jira or the
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
- **`coverage`**: brief it with the epic and each candidate child (`desk-jira get` and `comments`).
  Does one child's criteria deliver the DoD item? One child that does, quoting the criterion, drops
  the gap; none keeps it. Two that each could is a judgement call: put it to the user with both as
  options and the one whose outcome names the item recommended.

A `duplicate` verifier's "overlapping scope" is a judgement call too: which ticket owns the scope,
with both as options. A judgement call never becomes a proposal in step 4, only a question.

Read what each verifier returns as you would a colleague's finding: a verdict with no `file:line`
behind it is NOT MET.

## 4. Propose: one list

Write every proposal step 3 settled (a close `verdict` allowed, a verified duplicate or stale edit) to
`<scratchpad>/settled.json` with the Write tool, as findings of the scan's shape with their `propose`
commands and no `verify`. Then print the whole list once, and once more as JSON for step 6:

```bash
node ~/.agents/skills/desk-groom/bin/groom-scan.mjs approval --scan <scratchpad>/groom-scan.json --add <scratchpad>/settled.json
node ~/.agents/skills/desk-groom/bin/groom-scan.mjs approval --scan <scratchpad>/groom-scan.json --add <scratchpad>/settled.json --json
```

**A report-only run (`--report`, the weekly one) adds `--report` to the first**: every block reads
`report only`, the questions are listed and never asked, and the run stops after the list (its rules
are in `references/approve-write-handoff.md`, *The weekly report-only run*).

Redirect the second to `<scratchpad>/approval.json`, which step 6 reads back from. The list numbers every
proposal as a desk-jira gate block, **`awaiting approval`**, one per write, the evidence first, then
the questions, the gaps, any `verify first` candidate no verifier settled, and the findings left to
the batch, and ends by asking for the numbers to write. Each block reads:

```
[<n>] JIRA <EDIT | TRANSITION> — awaiting approval
target : <KEY>
check  : <landed | duplicate | link | stale | field | title | blocker | children | priority | status>
needs  : <jira-edit | jira-close | jira-transition>
evidence:
  <each evidence line the scan or verifier gave, with file:line or commit>
---
<the exact desk-jira command, or for a description edit the exact before and after text>
```

For `children`, the after text is the epic's description with the Children section replaced by the
scan's `section` lines. `needs` is the §3 row the write would need: a link, unlink, field, title or
description edit is `jira-edit`; a close as already fixed or duplicate is `jira-close`; an epic's
status move is `jira-transition`. It shows the person approving what each number unlocks.
A priority proposal whose value is in §4 Priorities only you set says so: its write needs the user's
own decision.

Every `question` finding and every judgement call from step 3 is a question block, never a proposal:

```
QUESTION — <loose | blocker | coverage | duplicate>
target : <KEY>
evidence:
  <each evidence line>
---
<the question>
  1. <the recommended option> (Recommended)
  2. <each other option>
```

The recommendation goes first. For a loose ticket with no home, rewrite the scan's draft title as
the outcome the new epic serves ("For <who>, <what>") before asking. Ask them together in one
question carousel where the session can (`AskUserQuestion`, one question per finding), and move
nothing until the user answers. Each `coverage` gap the verifier kept is a report line: the epic,
the DoD item and its text, and that no child covers it. Nothing here is posted, transitioned or
linked, even where §3 says `yes`.

End with a one-line count per check, the coverage gaps, the open questions, and a `kept open` list: every close candidate step 3 kept open,
with its reasons. That list is how a wrong guard becomes visible.

## 5. Before each approved close: check the key again

Approval can come an hour after the verdict, and a PR opened on the key in that gap is work still in
review. So whoever writes the approved list runs this **immediately before each `landed` close**, one
key at a time, and writes the close only when it exits 0:

```bash
node ~/.agents/skills/desk-groom/bin/groom-scan.mjs preclose <KEY> --scan <scratchpad>/groom-scan.json --repo <§0 GitHub repo>
```

It runs desk-cleanup's open-PR search for the key again (whole-key matches only, drafts included) and
reads the ticket's Jira status. It exits 1, and the ticket is left as it is, when a PR on the key is
open, when the status is no longer the one the scan read, or when either read fails: a failed search
is reported as a check that did not run, never as no PR found. Put its `report` line (`kept open: PR
#<n> on the key opened after the verdict`) on the `kept open` list. Never write the close by hand
over an exit 1.

## 6 and 7. Write the approved list; hand priority epics to the batch; the weekly report

Once the user answers the list, when they name priority epics (`--priority`), or on a report-only
run (`--report`, as a schedule runs it), **read `references/approve-write-handoff.md`** and
follow it: step 6 re-checks the batch, writes only the approved numbers and reads every write back
(`readback`, the rendered HTML checked for `<del`); step 7 lists a priority epic's open work for the
batch's orchestrator to admit; a report-only run stops after printing the list with
`approval --report`.

## Keep them posted

Say what is running before the scan and before the fan-out, and report as each verifier returns.
Never work through the whole backlog in silence and present a wall at the end.

## Red flags: stop

- About to run a `desk-jira` write (`edit`, `link`, `unlink`, `transition`, `comment`) the user has not
  approved by number from the list, or any write in a report-only run
- Proposing a write to a ticket the running batch holds, or writing one `held` names
- About to run `queue.mjs admit`, or any queue write, for a priority epic's tickets
- Reporting a write as done without its `readback` line reading `ok`
- Proposing a close without a verdict from step 3, or overriding one
- Writing an approved close without step 5's `preclose` exiting 0 just before it
- Proposing a link because two tickets "look related", with no line that shows it
- Proposing a size or a priority you cannot point to a source for, as if the scan had found it
- Scanning against a stale or shallow `origin/<default branch>`
- Grooming part of the backlog and reporting it as all of it
- Proposing a move for a loose ticket, or a fix for a judgement call, rather than asking
- Asking about a finding that has one correct fix
- Recommending a catch-all epic as a loose ticket's home

## Common mistakes

| Mistake | Fix |
|---|---|
| Closing a ticket because a commit names its key | A partial fix often merges first; every criterion is checked, and an open PR on the key vetoes |
| Taking the epic's size for a child | A priority follows the epic; a size is the ticket's own |
| Unlinking every blocker of an over-blocked ticket | Propose what it truly waits on, and unlink only the rest |
| Writing a dependency into a description | Dependencies are links; autopilot reads only the Blocks links |
| Treating a moved line as a wrong premise | Where main shows the name at another line, the edit is the line number |
| Calling a DoD item a gap because no child's title matches it | Coverage counts a child naming the item, or its Children row; a word match only sends it to a verifier |
| Keeping a split ticket in the Children list | Its pieces take its place |
