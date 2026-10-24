# desk-clearance phase 7: Hand back

Read at the start of phase 7, or earlier where the core's Phases section says. The config, ownership, what config
§3 decides, the merge bar, parking and the red flags every phase shares are in `../SKILL.md`, already
loaded.

### 7. Hand back — as you go, then asserted at the end

Hand-back is for a PR that still needs a reviewer's action: a standing `CHANGES_REQUESTED` whose
comments you worked, and under the strict bar every worked 3B PR. **Do it the moment its comments
are addressed**, never batched: set the assignee to the reviewer, remove the user, request the
re-review. A queue that fills as the pass runs lets the reviewer start while the rest moves.

Identify the reviewer from **who has actually reviewed it**, never from `reviewRequests` — that list
is empty at exactly this moment, because submitting a review removes them. Add §4 People "Infra
and security owner" as reviewer on security-touching PRs, and tell them when a PR touches one of the
paths that row names as infra (`.github/workflows/**` always counts) — a drafted message, never a
sent one. That row `none` or `you`: skip both. **GitHub only, never Jira.**

With §4 People "Code reviewer" `none` or `you` and nobody else having reviewed, there is no one to
hand back to: the PR stays with the user, reported under `NEEDS YOU`.

A PR that is merging is not handed back, it is merged. A PR parked on something that is nobody's
review to give stays with the user — see **Parking is not a hand-back**.

**At the end of the pass, re-query and assert it happened** for every PR worked: assignee is the
reviewer, the user removed, re-review requested. As a per-PR step alone this gets dropped, because
pushing and replying feel like completion. Both, not either.
