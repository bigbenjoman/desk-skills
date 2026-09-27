# What reviews here keep asking for

Mined from the open review corpus (`clearance-state.mjs corpus`). **`corpus` reads open PRs only,
so it under-samples badly straight after a big pass** — a run after a pass that merged 20 saw only 11
comments across 3 PRs still open; rows 9 and 10 were derived from the pass's own assessments instead. Re-derive the `PRs` column rather than trusting it.

These patterns are what studia-web's reviewers — the reviewer in config §4 and whoever reviewed
before them — raise across PRs. They describe the codebase's review bar, not a person, so they
apply whoever the user is and whoever reviews their work.

**These are pre-emptive checks, not a summary of past reviews.** The IMPLEMENT subagent runs the
list against its own diff before pushing. A theme earns its place only if it can be applied to a PR
nobody has reviewed yet.

## The list — hard cap of 10

| # | Pattern | Check before pushing | PRs |
|---|---|---|---|
| 1 | A code change lands, the knowledge base still describes the old behaviour | Did the diff change something `.agents/knowledge/**` or a generated `.mdx` asserts? Fix it in the same push, then `bun run knowledge:check` | 5 |
| 2 | A comment or docstring beside changed code now describes what the code used to do | Read every comment inside the diff hunks, not just the lines changed. A detached JSDoc block binds to the wrong symbol | 4 |
| 3 | One branch of a variant fixed, its sibling left behind | List every branch of what you touched — `asChild` vs plain, each enum value, each state — and say what each now does. `!== 'hidden'` also catches `pending` | 4 |
| 4 | New code with nothing testing it, or a spec that proves less than it claims | Name the spec covering each new behaviour. A spec asserting your own declarations, or matching literal source text, proves nothing | 4 |
| 5 | A mutation succeeds and the user is told nothing | Every mutation path — including remove, clear and no-op — ends in visible feedback or a deliberate, stated silence | 3 |
| 6 | Keyboard and focus regress while the mouse path works | Tab to it closed, disabled and loading. A focus ring only on `open`, an unmounting button stealing focus, an `<a>` ignoring `disabled` | 3 |
| 7 | The PR description drifts from the code across review rounds | Re-read the body against the diff before handing back. An open question the code has since answered is worse than no description | 3 |
| 8 | The change is wider than the ticket asked for | Name the ticket's scope and show the diff sits inside it. Enabling something globally when two routes were asked for is the usual shape | 4 |
| 9 | A follow-up the reviewer explicitly deferred is agreed to and then never ticketed | Before handing back, check every "that needs a ticket rather than a fix here" has a real SV number in your reply. Agreeing in prose is not raising it | 4 |
| 10 | Two surfaces read the same value from different sources, so they disagree after an invalidation | If you point one component at a live query, find every sibling still reading the SSR prop. One reading `buttonState.priceText` while another reads the live query is the shape | 3 |

## Maintaining this file

Run after a clearance pass, not after a single PR. This file ships in the shared skills repo, so a
refresh is a change to propose there, not a local edit that silently diverges from colleagues' copies.

- **Promote** at **3 distinct PRs, or 10% of the reviewed set, whichever is larger.** Two is a
  coincidence; one is an anecdote and gets written down nowhere.
- **Evict** at the cap: a new entry displaces the lowest-support row. Ten is a limit on what a
  subagent will actually read before pushing, and the one number here that should not scale.
- **Decay:** a pattern absent from two consecutive corpus runs loses a point. At zero it goes.
  Reviewers change; the list should too.
- **Abstract, but not into nothing.** "#674 added `periodEndHasPassed` to one branch" is too specific
  to reuse. "Be careful" is too vague to act on. The test is whether a subagent could apply the row
  to a diff without knowing the PR it came from.
- **Never name a reviewer in a row.** Who reviews is config §4; what the codebase's bar is lives here.
- **Never** copy a row into `SKILL.md`. One home, capped.
