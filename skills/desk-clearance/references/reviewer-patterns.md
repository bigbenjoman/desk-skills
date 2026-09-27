# What reviews here keep asking for

The list itself lives in the repo's config, **§4 "What review here consistently asks for"** (resolve
it with `desk-env where`, then Read it). This file is how that table is used and kept. Nothing about
any one repo's reviewers is written here.

Mined from the open review corpus (`clearance-state.mjs corpus`). **`corpus` reads open PRs only,
so it under-samples badly straight after a big pass** — a run after a pass that merged 20 saw only 11
comments across 3 PRs still open; two rows had to be derived from the pass's own assessments instead.
Re-derive a row's support rather than trusting the count beside it.

These patterns are what the repo's reviewers — §4 People "Code reviewer" and whoever reviewed
before them — raise across PRs. They describe the codebase's review bar, not a person, so they
apply whoever the user is and whoever reviews their work.

**These are pre-emptive checks, not a summary of past reviews.** The IMPLEMENT subagent runs the
§4 table against its own diff before pushing. A theme earns its place only if it can be applied to a
PR nobody has reviewed yet.

## When the table is empty or `TODO`

A new repo, or one set up without mining review history. Say so in the IMPLEMENT brief ("no house
review bar recorded yet") rather than inventing one, and after the pass run `corpus` and propose the
first rows. §4 People "Code reviewer" `none` (or `you` in a solo repo) means there is no reviewer to
mine: the table stays whatever the user wrote, and `corpus` will be near empty — that is the answer,
not a failure.

## The shape of a row — hard cap of 10

Each row is an **Ask** (the pattern, in a line) and a **Detail** (the check to run before pushing,
and the support: how many distinct PRs raised it). The examples below show the altitude, not this
repo's bar — never run them as checks unless the §4 table carries them:

| Ask | Detail |
|---|---|
| A comment beside changed code still describes what the code used to do | Read every comment inside the diff hunks, not just the lines changed. A detached doc block binds to the wrong symbol. (4 PRs) |
| One branch of a variant fixed, its sibling left behind | List every branch of what you touched — each enum value, each state, each prop combination — and say what each now does. (4 PRs) |
| The change is wider than the ticket asked for | Name the ticket's scope and show the diff sits inside it. Enabling something globally when two routes were asked for is the usual shape. (4 PRs) |

## Maintaining the table

Run after a clearance pass, not after a single PR. The table is in §4 of the user's config, not in
§3, but it is still the user's file: **propose the edit** (rows in, rows out, and why) and write it
only on their yes, or point them at `/desk-setup`. Never let it silently diverge from what they
agreed.

- **Promote** at **3 distinct PRs, or 10% of the reviewed set, whichever is larger.** Two is a
  coincidence; one is an anecdote and gets written down nowhere.
- **Evict** at the cap: a new entry displaces the lowest-support row. Ten is a limit on what a
  subagent will actually read before pushing, and the one number here that should not scale.
- **Decay:** a pattern absent from two consecutive corpus runs loses a point. At zero it goes.
  Reviewers change; the list should too.
- **Abstract, but not into nothing.** "#674 added `periodEndHasPassed` to one branch" is too specific
  to reuse. "Be careful" is too vague to act on. The test is whether a subagent could apply the row
  to a diff without knowing the PR it came from.
- **Never name a reviewer in a row.** Who reviews is §4 People; what the codebase's bar is lives in
  the table.
- **Never** copy a row into `SKILL.md` or this file. One home, capped.
