---
name: desk-admit
description: >-
  Admits tickets into the autopilot batch the supervisor runs, after the same checks standing intake
  makes: a fresh triage, lane, blocking lint, open questions, size, and blockers outside the batch.
  Use when the user types "/desk-admit", or says "admit DS-123", "add these to the batch", "put this
  in the supervisor's queue", "get this into autopilot", or asks what to admit next ("a slot is free,
  what should go in?", "candidates for the batch"). Not for planning a new batch with approvals
  (that is desk-autopilot) or working one ticket in this session (that is desk-ticket).
argument-hint: "<TICKET>... [--front]"
---

# desk-admit

One script makes every check and every write, after step 0 saves any design. **Read nothing
else**: no queue, triage record or supervisor log, and do not load `desk-autopilot` except for an
epic the script says to plan (step 1b). Never run `queue.mjs admit` yourself.

## Candidates, when no ticket was named

When the user asks what to admit rather than naming tickets, list the candidates first; never pick
from the tracker by hand:

```bash
node ~/.claude/desk/bin/candidates.mjs
```

It lists §4 Jira project's unstarted Bugs and self-contained Tasks (no open "is blocked by" link, and
not a child of an epic whose feature batch is running): first those already assigned to the person
§1 names (§1 Jira account id, else the signed-in Jira user), under
`your unstarted assigned tickets … ready to admit`, then the unassigned ones, each by §4 Priority, then
Bugs before Tasks, then newest, clean unassigned ones first. A ticket assigned to anyone else is never
listed. One whose summary or labels read as a decision, or as access, key
or infrastructure work outside the repo, is left out naming the word.
A ticket a merged PR or a commit on the default branch already names is shown as `already on main (PR
#n)` and not offered. One an open PR names is left out as `open PR #n by <author>` when someone but
§1 GitHub handle opened it, and offered flagged `open PR #n` when the person did, with
`node ~/.claude/desk/bin/queue.mjs adopt <KEY> <n> --filed`, which takes it in on that PR for the
merge driver (admitting it would open a second PR). With the open PRs unread, each says it is
unchecked. One missing its Acceptance criteria or Design section says so, and one naming a
file a PR merged in the last 7 days changed names that PR as possible overlap. Show the list and ask
which to admit, then run step 0 and step 1 for the ones chosen, or that adopt command for one
flagged so. It admits nothing itself. Exit 3 means
the repo has no Jira tracker or project to list from: say so. While a slot stays free, the pass prints
the person's own under `free slot:`, and with config §3b "Propose candidates for a free slot" on, the
whole list.

## 0. Snapshot each design

A worker has no Artifact tool, and an artifact private to one subscription cannot be read from
another, so a ticket's Claude Design canvas, and any other claude.ai artifact its description links
(a spec or notes page), is saved now, by this session, before it is admitted. `check` reads the
description only, so an artifact linked only in a comment has its link moved there first.
For each ticket the user named (an epic is skipped: its children are admitted on their own):

```bash
node ~/.claude/desk/bin/desk-design.mjs check <TICKET>
```

`ok`, or an `advisory`, needs nothing. Each `blocking` line names an artifact URL with no copy a
worker can read. **One made outside the user's organisation is read here too**: reading it asks
whether Claude may read it for the rest of this conversation, and the user's yes covers every read
of it after that, so read every such artifact in this call in one go, while they are here to answer.
Snapshot it with the Artifact tool, reading every file
`desk-autopilot/references/design-snapshot.md` (read it now) lists, a single-page artifact's page
and what it loads included, into `out_dir: $DESK_STATE/designs/<TICKET>/` (`desk-env paths` prints
`DESK_STATE`). Then record it, and check again:

```bash
node ~/.claude/desk/bin/desk-design.mjs write $DESK_STATE/designs/<TICKET> --url <artifact URL> \
  --version <its version> --key <TICKET>
node ~/.claude/desk/bin/desk-design.mjs check <TICKET>    # now an advisory naming the snapshot
```

The snapshot holds every file the boards need, so the worker builds from it even once the artifact
can no longer be read. **An artifact that returns a summary, or an error, rather than its files** is
not one this subscription can read (one holding a brand font is never shared): never admit that
ticket on a summary. Ask the user now, before step 1, in one `AskUserQuestion` (header the ticket
key): give the design's HTML export, the self-contained HTML file Claude Design downloads, by its
path (Recommended: it needs no sharing), or share the artifact `<URL>` with this subscription and
run /desk-admit for it again. Never search their folders for the file. Given a path, import it once
for every ticket in this call whose `check` names that URL, into the folder the `blocking` line
names (`<design dir>/<FOLDER>/`), then check each:

```bash
node ~/.claude/desk/bin/desk-design.mjs import <path> --url <artifact URL> --epic <FOLDER> \
  --key <TICKET> --key <TICKET2> …
node ~/.claude/desk/bin/desk-design.mjs check <TICKET>    # now an advisory naming the snapshot
```

and admit them in step 1. Exit 4 names the first file the page loads from elsewhere: it is not a
self-contained export, so ask once more for one that is, or for the artifact to be shared.

What no session reads first (standing intake, a feature batch started headless, a ticket plan-batch
seeds) is admitted parked on its unread artifact, and `/desk-needs-you` lists every such artifact in the
repo, with the tickets each holds, as one item. Its `/desk-admit` is this step for all of them at once.

## 1. Admit

```bash
node ~/.claude/desk/bin/intake.mjs admit <TICKET>... --by <who> [--front] [--session]
```

- `<TICKET>...`: every ticket the user named, in one call, so a blocker named alongside what it
  blocks is admitted first and the other held behind it.
- `--by`: the user's first name, lower case, no spaces (from `git config user.name`).
- `--front`: only when the user asks for it first, or calls it urgent ("ASAP", "next"). It moves a
  ticket already in a batch too, unless its worker has started, it is finished, or the user placed it
  (`queue.mjs move`): the line after `is already in batch` says which.
- `--session`: only when this session runs the batch (it started it with `/desk-autopilot`, and
  runs its passes); step 2's `is run by a session` row says when.

It triages each ticket afresh, which takes a minute or two each, as many at once as config §3b
"Triage concurrency" allows, and admits each one as soon as it and its blockers in the call are
triaged (at one at a time, a ticket behind another in the call waits for the last triage).
**With more than 3 tickets, start the call in the background** (`run_in_background`, at the longest
timeout the tool takes) and wait for its notification; with 3 or fewer, give it your longest
foreground timeout, and if it moves to the background, wait the same way. Never run it again while
it runs. It prints each line as it happens, in the order things happen: `triage: started`, `triage:
done` and `waiting:` lines are progress, and its last line is a `summary:` of the call. While it runs
in the background those lines land in its output file: read that when the user asks how it is going.
An epic's children, and a ticket joining another batch, are triaged in turn, each with its own
`triage:` lines, and no other triage starts and nothing else is placed until that ends.
Exit 0: every ticket was admitted
or was already where it belongs (`<TICKET> is already in batch <B> (<state>)`, its epic's feature
batch included: ask nothing about it), any epic had its feature batch started, and any other epic is one to
plan (step 1b). Print its lines, less the progress, and stop unless there is an epic to plan or a blocker to admit next.
**A `restart this session's loop now` line** comes after a `--session` admit into a batch whose loop
this session stopped (a pass found it idle) or lost: run the pass it names and restart the loop as
`desk-autopilot` Stage 4 runs it, recording the next pass, before you end the turn. Without it nothing
picks the tickets up.

A ticket blocked by one in no batch is admitted held by it (`waiting for <B>, outside the batch, until
it is Done and on <base>`), and one blocked by a ticket in another live batch joins that batch. **An
`admit next: <B>...` line** names the open blockers in no batch of what was just admitted: run step 1
again for exactly those, at once, with no question, since the user naming what they block is the
approval. Do the same for any `admit next:` line that run prints, and handle its refusals as step 2
says.

Where config §3 `autopilot-workers` is `yes`, an epic gets its own feature batch, beside the standing
batch, with no session: `started feature batch <E> on <branch>` (its branch pushed to origin under
§3 `git-push`), its children triaged there and held behind it, and its spine and owner table drafted
headless. Its plan then waits for the user as one `/desk-needs-you` item, and the batch waits with
it. Start nothing for it, and do not load `desk-autopilot`. The supervisor's next tick picks the admitted tickets up, so start no
pass, loop or driver for them. A child of an epic whose feature batch is running is admitted into
that batch (`into feature batch <E>`), held behind its spine, its blockers there and the children it
shares files with: the user naming it is the approval.

## 1a. Put each new design in the repo

A design snapshotted in step 0, from the Artifact tool or an export, goes into the repo now, before
any worker builds from it, once per artifact. For each ticket admitted that uses one, from the main
checkout (prefix `DESK_BATCH=<B>` when it went into feature batch `<B>`, so the branch comes off
that batch's base):

```bash
node ~/.claude/desk/bin/desk-design.mjs propose $DESK_STATE/designs/<FOLDER>
```

- `saved: … no PR needed`: the base already holds it.
- `committed: <path> on <branch> in <worktree> (…, base <base>)`: render it there (desk-ticket
  `design-canvas.md`: `with-lock.sh browser … render <worktree>/<path>`), commit the screens in that
  worktree, then open its PR with `desk-pr` against `<base>`, title `docs(design): <FOLDER> design
  canvas`. It goes through the normal review and is never merged on its own. Until it merges, the
  tickets run from the snapshot; once it has, every later ticket on the canvas reads the committed copy.
- `unchanged: …`: its branch already holds this version, so its PR needs nothing more.

## 1b. An epic to plan

This line comes only where config §3 `autopilot-workers` is not `yes`.
Each `plan <EPIC> as a feature batch beside the standing batch: /desk-autopilot <EPIC>` line means
the user wants the epic run exactly as `/desk-autopilot <EPIC>` runs it: its own feature batch, beside
the standing batch, which carries on untouched. Load `desk-autopilot` and run its epic flow for
`<EPIC>` (*An epic as a batch*, from Stage 0), plan approval included; do not ask first how the epic
should run. More than one such line: run the first, then each of the others in turn; every epic gets
its own feature batch, on its own branch.

## 2. Refused (exit 11)

**First, settle a design question yourself.** An `open question(s): …` whose question is a value a
design frame the ticket links shows (a colour, a gradient's stops, a size, a spacing) is not the
user's while this session can read that frame: read it through the design connector this session
has (the Figma MCP's `get_design_context` for a Figma frame, the Artifact tool for a Claude Design
canvas), write the values into the ticket's Design section (`desk-jira`, under §3 `jira-edit`; with
no tracker, the ticket file), and run step 1 again for it. It goes to the user only when no connector
here can read the frame, saying which you tried.

**Then fold in what a comment already settles.** A `lint (blocking): …` refusal whose findings are
only no acceptance criteria, a decision left open (a "Decide whether…" line, a question in scope) or
no design link is not the user's where the ticket's comments answer it: read them
(`desk-jira comments <TICKET>`; with no tracker, the issue's comments). A finding is settled by:

- **a decision left open**: a comment from the person §4 People routes it to (`desk-env get --json
  product-owner designer`: the designer for a design call, the product owner for any other, and the
  product owner where Designer is `none`) that states the choice;
- **no design link**: a Figma or Claude Design URL in a comment from the designer (the product owner
  where Designer is `none`);
- **no acceptance criteria**: criteria that follow from the ticket's text and those comments alone.
  A criterion neither states is a question, never a guess (gate 1 of `desk-ticket`). Where the line
  adds `triage drafted <n> from its goal and proposal`, it lists them: write them as they are, under
  the note it quotes. Where it adds `its text states no testable outcome`, admit has put that one
  ask on `/desk-needs-you`: say so, and do not ask it again below. Where the line reads `no acceptance
  criteria section, but <n> Given/When/Then criteria with no AC labels`, they are the ticket's own:
  move them under an `Acceptance criteria` heading as the `AC1: …` items it lists, keeping their text.
- **no design link** where the line adds `triage found nothing renders` (its change is confined to
  tests, CI, tooling or config): no comment is needed. Write `No UI.` and the reason the line gives
  (`No UI. Triage found nothing renders: it changes …`) as the Design section.

**Admit has already written what it could.** For a GitHub issue where config §3 `gh-issue-edit` is
`yes`, and for a ticket in a ticket file, it numbers Given/When/Then criteria written with no AC
labels (moving them under the criteria heading), writes the criteria triage drafted and `No UI.` itself,
with `None.` under a missing Out of scope and §4 Unit tests (`desk-env cmds test-cmd`) under a missing
Verification, prints the `ISSUE EDIT` (or `TICKET FILE EDIT`) block marked `posted`, lints the
ticket again and places it on that: nothing is left to do for it. Where `gh-issue-edit` is not
`yes`, a `desk drafted … but wrote nothing` line follows the block marked `awaiting approval`: at
`ask`, show that block, ask, and on yes run the `gh issue edit … --body-file …` it names, then run
step 1 again; at `no`, hand the person the sections to paste. On Jira, write `None.` under a missing
Out of scope and the test command under a missing Verification with the rest below.

Write each settled finding into the description through `desk-jira` (§3 `jira-edit`; with no
tracker, a GitHub issue through `gh issue edit` under §3 `gh-issue-edit`, since triage reads the
issue, not a file; any other ticket, its ticket file), before asking about any other: the
`Acceptance criteria` section, a `Design` section holding the link, and the decision line
reworded as decided, with a dated entry under `Decisions` naming the comment's author and date.
Print the `JIRA EDIT` (or `ISSUE EDIT`) block as it goes and
read it back. With none left, run step 1 again for it. Only a finding no comment settles goes to the
user, as below, saying which were folded in; once its answer is recorded the same way, run step 1 again.

Each other `not admitted <TICKET>: <why>` line, and an `admits nothing: <why>` line, goes to the user in
one `AskUserQuestion` round (at most four questions; header the ticket key). Put the first option
below as `(Recommended)`, with its reason as the description:

| `<why>` says | Recommended | Then |
|---|---|---|
| `lane C` or `lane D` | Work it in its own session: `/desk-ticket <TICKET>` (a worker would only park on it) | Leave it out of the batch |
| `open question(s): …` | Answer each one now; record the answers on the ticket (`desk-jira`). One a linked design frame answers was read above | Run step 1 again for it |
| `lint (blocking): …` | Fix what no comment settled (above) as the finding says (`desk-jira`) | Run step 1 again for it |
| `design not snapshotted: <URL>…` | Snapshot it as step 0 says, or, where it will not read, import its HTML export (step 0) | Run step 1 again for it |
| `size L` or `XL` | Split it into tickets of size M or less (`desk-jira`) | Admit the new tickets |
| `blocked by <B>, which failed in the batch` | Requeue `<B>` (`queue.mjs requeue <B>`), or drop it if it will not be done | Run step 1 again for it |
| `an epic, and its feature batch <B> is already running` | Admit the epic's children instead: they join `<B>` | Run step 1 for the children |
| `an epic, and its feature batch was not started: …` | Settle what follows the colon (the line names the push or fix), as the rows here say for it; nothing was left behind | Run step 1 again for it, or plan it in a session: `/desk-autopilot <EPIC>` |
| `already in progress by <login> in #<n>` | Leave it to them: another person has a PR for it open. Ask them, or the user, before taking it over, and never push to their branch | Admit nothing for it |
| `is in batch <B>` or `is in the standing batch` | Leave it where it is: a ticket is in one batch at most. If it belongs elsewhere, move it from `/desk-needs-you` once it is parked or stopped (`move "<batch>"`) | Admit nothing for it |
| `is already queued in <repo>'s standing batch` or `in batch <B> of <repo>` | Leave it there: a ticket is queued in one repo at most. If it belongs in this repo instead, drop it there first (`queue.mjs drop <TICKET>` in that repo's checkout) | Run step 1 again for it once it is dropped there |
| `is a child of epic <E>, but not admitted into its feature batch: …` | Settle what follows the colon, as the row above for it says | Run step 1 again for it |
| `runs on base <B> in the standing slot: move it to epic <E>'s own slot` (or `to its own slot <S>, named after its branch`, for a batch spanning several epics) | Move it: run the `node …/move-batch.mjs` the line names, which frees the standing slot on the default branch. With workers running it drains first (exit 12, new spawns paused): run it again once none is running | Run step 1 again |
| `is run by a session, not the supervisor` | If this session runs that batch, run the command the line names (`… --session`), never `queue.mjs admit` and never a message to yourself. Otherwise send the tickets to that session: `ListAgents`, then `SendMessage` with each ticket and why it is wanted. That session admits them | Admit nothing here unless this session runs it |
| `no batch is live, and starting one … needs …` | Plan a batch: `/desk-autopilot <TICKET>...` | |
| `no supervisor runs this repo's batches` (config §3b Batches run by is `session`) | If this session runs the repo's batches, run step 1 again with `--session`, which joins the finished batch. Otherwise, where an `ask session <id>` line follows and `ListAgents` shows that session, `SendMessage` it the command the line names, which joins the batch and restarts its loop. Otherwise start one: `/desk-autopilot <TICKET>...` in a session. The line is on `/desk-needs-you` until the ticket is admitted. Run in the session whose pass last ran the batch, admit says `this session runs this repo's batches` instead and puts nothing on needs-you: run its `--session` command | |
| `triage failed` or anything else | Show the line; offer to run step 1 again | |

A `not triaged (usage limit, resets <time>): <TICKET>...` line is not a question: a triage hit the
usage limit, so the rest were never started. Tell the user the reset time and the command the line
names, and run nothing for them until then.

Do what each answer says, then run step 1 again only for the tickets now ready. A `plan <EPIC> …`
line in the same output is not refused: run step 1b for it once these are settled.

## 3. End

Print one line per ticket: admitted (and into which batch, and held behind or waiting for what, if held), already
in the batch, an epic whose feature batch was started (its plan waiting in `/desk-needs-you`), an
epic being planned as a feature batch, or left out and why.
