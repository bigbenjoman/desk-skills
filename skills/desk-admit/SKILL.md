---
name: desk-admit
description: >-
  Admits tickets into the autopilot batch the supervisor runs, after the same checks standing intake
  makes: a fresh triage, lane, blocking lint, open questions, size, and blockers outside the batch.
  Use when the user types "/desk-admit", or says "admit DS-123", "add these to the batch", "put this
  in the supervisor's queue", "get this into autopilot". Not for planning a new batch with approvals
  (that is desk-autopilot) or working one ticket in this session (that is desk-ticket).
argument-hint: "<TICKET>... [--front]"
---

# desk-admit

One script makes every check and every write, after step 0 saves any design. **Read nothing
else**: no queue, triage record or supervisor log, and do not load `desk-autopilot` except for an
epic the script says to plan (step 1b). Never run `queue.mjs admit` yourself.

## 0. Snapshot each design

A worker has no Artifact tool, and an artifact private to one subscription cannot be read from
another, so a ticket's Claude Design canvas is saved now, by this session, before it is admitted.
For each ticket the user named (an epic is skipped: its children are admitted on their own):

```bash
node ~/.claude/desk/bin/desk-design.mjs check <TICKET>
```

`ok`, or an `advisory`, needs nothing. Each `blocking` line names an artifact URL with no copy a
worker can read: snapshot it with the Artifact tool, exactly as
`desk-autopilot/references/design-snapshot.md` (read it now) lists, into `out_dir: $DESK_STATE/designs/<TICKET>/`
(`desk-env paths` prints `DESK_STATE`): `project/canvas.json`, every board's `project/*.dc.html`, the
`support.js`, stylesheets and fonts they load, each `/_blob/<id>` asset a board names, and
`artifact-type/dc-runtime.js` where the boards load a `support.js` the artifact does not publish.
Then record it, and check again:

```bash
node ~/.claude/desk/bin/desk-design.mjs write $DESK_STATE/designs/<TICKET> --url <artifact URL> \
  --version <its version> --key <TICKET>
node ~/.claude/desk/bin/desk-design.mjs check <TICKET>    # now an advisory naming the snapshot
```

The snapshot holds every file the boards need, so the worker builds from it even once the artifact
can no longer be read. **An artifact that returns a summary, or an error, rather than its files** is
not one this subscription can read: never admit that ticket on a summary. Leave it out of step 1, and
ask the user in step 2's round, header the ticket key: share the artifact `<URL>` with this
subscription, or give its files (Recommended: share it, then run /desk-admit for it again).

## 1. Admit

```bash
node ~/.claude/desk/bin/intake.mjs admit <TICKET>... --by <who> [--front]
```

- `<TICKET>...`: every ticket the user named, in one call, so a blocker named alongside what it
  blocks is admitted first and the other held behind it.
- `--by`: the user's first name, lower case, no spaces (from `git config user.name`).
- `--front`: only when the user asks for it first, or calls it urgent ("ASAP", "next").

It triages each ticket afresh, which takes a minute or two each, and admits none until every triage
is done: give the call your longest foreground timeout, and if it moves to the background, wait for
its notification rather than running it again. Exit 0: every ticket was admitted
or was already in the batch, any epic had its feature batch started, and any other epic is one to
plan (step 1b). Print its lines, and stop unless there is an epic to plan.

Where config §3 `autopilot-workers` is `yes`, an epic gets its own feature batch, beside the standing
batch, with no session: `started feature batch <E> on <branch>` (its branch pushed to origin under
§3 `git-push`), its children triaged there and held behind it, and its spine and owner table drafted
headless. Its plan then waits for the user as one `/desk-needs-you` item, and the batch waits with
it. Start nothing for it, and do not load `desk-autopilot`. The supervisor's next tick picks the admitted tickets up, so start no
pass, loop or driver for them. A child of an epic whose feature batch is running is admitted into
that batch (`into feature batch <E>`), held behind its spine, its blockers there and the children it
shares files with: the user naming it is the approval.

## 1b. An epic to plan

This line comes only where config §3 `autopilot-workers` is not `yes`.
Each `plan <EPIC> as a feature batch beside the standing batch: /desk-autopilot <EPIC>` line means
the user wants the epic run exactly as `/desk-autopilot <EPIC>` runs it: its own feature batch, beside
the standing batch, which carries on untouched. Load `desk-autopilot` and run its epic flow for
`<EPIC>` (*An epic as a batch*, from Stage 0), plan approval included; do not ask first how the epic
should run. More than one such line: run the first, then each of the others in turn; every epic gets
its own feature batch, on its own branch.

## 2. Refused (exit 11)

Each `not admitted <TICKET>: <why>` line, and an `admits nothing: <why>` line, goes to the user in
one `AskUserQuestion` round (at most four questions; header the ticket key). Put the first option
below as `(Recommended)`, with its reason as the description:

| `<why>` says | Recommended | Then |
|---|---|---|
| `lane C` or `lane D` | Work it in its own session: `/desk-ticket <TICKET>` (a worker would only park on it) | Leave it out of the batch |
| `open question(s): …` | Answer each one now; record the answers on the ticket (`desk-jira`) | Run step 1 again for it |
| `lint (blocking): …` | Fix the ticket as the finding says (`desk-jira`) | Run step 1 again for it |
| `design not snapshotted: <URL>…` | Snapshot it as step 0 says, or, where it will not read, have it shared with this subscription | Run step 1 again for it |
| `size L` or `XL` | Split it into tickets of size M or less (`desk-jira`) | Admit the new tickets |
| `blocked by <B>, which is not done and not in the batch` | Admit `<B>` with it | Run step 1 with both |
| `an epic, and its feature batch <B> is already running` | Admit the epic's children instead: they join `<B>` | Run step 1 for the children |
| `an epic, and its feature batch was not started: …` | Settle what follows the colon (the line names the push or fix), as the rows here say for it; nothing was left behind | Run step 1 again for it, or plan it in a session: `/desk-autopilot <EPIC>` |
| `is in batch <B>` or `is in the standing batch` | Leave it where it is: a ticket is in one batch at most | Admit nothing for it |
| `is a child of epic <E>, but not admitted into its feature batch: …` | Settle what follows the colon, as the row above for it says | Run step 1 again for it |
| `runs on base <B> in the standing slot: move it to epic <E>'s own slot` (or `to its own slot <S>, named after its branch`, for a batch spanning several epics) | Move it: run the `node …/move-batch.mjs` the line names, which frees the standing slot on the default branch. With workers running it drains first (exit 12, new spawns paused): run it again once none is running | Run step 1 again |
| `is run by a session, not the supervisor` | Send the tickets to that session: `ListAgents`, then `SendMessage` with each ticket and why it is wanted. That session asks and admits | Admit nothing here |
| `no batch is live, and starting one … needs …` | Plan a batch: `/desk-autopilot <TICKET>...` | |
| `triage failed` or anything else | Show the line; offer to run step 1 again | |

Do what each answer says, then run step 1 again only for the tickets now ready. A `plan <EPIC> …`
line in the same output is not refused: run step 1b for it once these are settled.

## 3. End

Print one line per ticket: admitted (and into which batch, and held behind what, if held), already
in the batch, an epic whose feature batch was started (its plan waiting in `/desk-needs-you`), an
epic being planned as a feature batch, or left out and why.
