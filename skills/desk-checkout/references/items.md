# Building check-out items

How step 3 turns the joined sources into items, ranks them and sizes each one. The aim: every
important thing done in the window gets equal treatment, whichever ticket it sat under or whether it
had one at all.

## One item per outcome, not per ticket

Join the sources by ticket key and PR number first, as step 3 says: a session, a PR, a Jira move and
a Slack thread about the same work are one piece of evidence. Then build items by **outcome**: what
changed for someone, or what is now true that wasn't.

- **Split an umbrella.** When one ticket, or one repo with no tracker, gathers more than three PRs or
  issues and they do different things, give each outcome its own item. Group them by the PR or
  issue scope (`fix(queue)`, `feat(cloud)`), their labels, the theme of their titles and what the
  sessions behind them say they were for. Five PRs on three themes under one ticket are three
  items, not one.
- **Each item names its ticket where there is one**: `SV-3625 (#1596, #1577)`. Several items can name
  the same ticket. With no tracker, PR numbers alone.
- **Don't split for the sake of it.** PRs that all serve one outcome (a fix and its follow-up, a
  change split for review) stay one item. A ticket with one or two PRs is one item.
- **A status move the Jira collector marks `(you)` is the person's own**: their account made it, by
  hand or through a script or batch on their token. Report it as their move, even where a comment
  or session says someone else would make it, and never put it under **Check before posting**. Only
  a `then status: …, by <name>` line is someone else's.

## Work with no ticket

Work no ticket names is an item in its own right when a source shows it changed something. Never
drop it, or fold it into housekeeping, for lacking a key:

- a setting or config row changed (read from its source first, as step 3 says);
- an environment, account or integration set up;
- a root cause found, even with no code change yet `(investigated, no code change)`;
- a batch of issues filed on one theme: "Filed 14 issues on cloud starts";
- a milestone reached in a plan.

A session alone, with nothing in any other source and no finding, is still not an item (step 3).

## Rank by the change, not the ticket

Every item that changed something goes in, biggest first. Rank by the impact the sources show, not
by which ticket it belongs to or how many PRs it took:

1. Security, production or launch-blocking.
2. Unblocked others or a pipeline.
3. Shipped or merged.
4. User- or team-facing.
5. Fixed a recurring failure.
6. A milestone in a plan.

An item ranks by the highest signal it has, so anything security, production or launch-blocking
leads whatever else is merged that day; items with the same highest signal rank by how many signals
they have, then keep the order the sources gave them. Read each signal from its source, never from a
session's narration:

- **Shipped or merged** is a PR whose state is `MERGED` (its re-read in step 3, or the collector's
  `merged`), or a ticket whose status its workflow treats as done (`Done`, `Closed`, `Released`:
  the names vary by project, so read the status). A PR `CLOSED` without merging (the collector's
  `closed unmerged`) is not shipped: it is reported only as a dead end or with what replaced it. An
  `OPEN` PR, draft or not, is `(in review)` or `WIP`, not shipped.
- **Security, production or launch-blocking** needs a source that says so: a priority or label
  (`security`, `P0`, `P1`, `blocker`), a production deploy or incident, or a launch ticket it blocks.
- **Unblocked others** needs a named person, team or pipeline that was waiting on it.

The line is between items, which changed something, and everything else: ticket housekeeping rolls
up into one line below it, and a batch's own sessions are never items (step 3). Every item above the
line gets the same treatment, whatever its source or ticket: its own lines, its problem, change and
state.

**Length follows the day.** A busy day has as many items as changed something; a quiet day is five
lines, and that's fine. Never pad a quiet day, and never cut a busy one to "the few things that
mattered".

## Detail where it helps

Each item carries:

- **the problem**, in user or team terms;
- **the change**, and **its state** (`(merged)`, `(in review)`, `WIP`, `waiting on @Name`);
- **a count, or the PR and issue numbers that matter**: "8 PRs merged (#1596, #1577, …)", "filed 14
  issues on cloud starts".

Never list every PR in a large group: give the count and the two or three numbers a reader would
open. Counts follow step 4: over the post's window, the user's own unless worded otherwise.

## A fixture day

One umbrella ticket, SV-3625, with five PRs and one config change with no ticket:

| Source | What it shows |
|---|---|
| #1596 `fix(queue): drain stalled batches` | merged |
| #1577 `fix(queue): retry a lost claim` | merged |
| #1601 `feat(cloud): start workers in the cloud` | merged |
| #1603 `feat(cloud): cloud worker logs` | open, in review |
| #1610 `fix(review): retry a timed-out review` | merged |
| config, `test-cap` row | changed today from 2 to 4, read from `desk-env get test-cap` and its git log |

Four items, biggest first by their signals:

```text
Queue throughput: stalled batches never drained, so tickets sat queued for hours. SV-3625: 2 PRs merged (#1596, #1577), batches now drain and a lost claim retries.
Cloud workers: workers can now start in the cloud instead of on one laptop. SV-3625: #1601 (merged), logs in #1603 (in review).
Review reliability: a timed-out review failed the whole PR. SV-3625: #1610 (merged), it now retries once.
Test runs took too long on one job at a time. Raised the config's test-cap row from 2 to 4, in effect since today.
```

Not one SV-3625 bullet with five PR numbers, and the config change is its own line rather than
dropped for having no ticket.
