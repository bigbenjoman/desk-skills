# desk-review Phase 5: requirements

Read at Phase 3, with `phase-3-find.md`: this seat is dispatched alongside the finders. The config,
the bar, the entry points, every seat's prompt, the round rules and the verdict are in
`../SKILL.md`, already loaded; a "below" or "above" this file does not hold points there or to
another phase's file. Paths such as `references/gotchas.md` are from the skill's directory.

## Phase 5: requirements

`bea-business-analyst` (else `general-purpose`), dispatched **alongside** the Phase 3 finders. She
reads the ticket and the diff, not their output. **She never writes to the tracker**: no comment,
transition or field edit.

**Find the ticket**, case-insensitively, then in the tracker's case, from the branch name and the PR
title:

```bash
git branch --show-current
```

Match §4 Ticket key pattern (`desk-env get ticket-pattern`) against that and the PR title with `grep -oiE`, and upper-case the
result: branches are often lowercase (`fix/abc-123-…`) while keys are not, so a case-sensitive match
silently never fires on a branch. Then fetch:

| What matched | Where the ticket text comes from |
| --- | --- |
| §4 Ticket key pattern, Tracker `jira` | `desk-jira get <KEY>` (needs §3 `read-own-work`, or `read-others` for someone else's ticket) |
| §4 Other work id patterns (`desk-env list work-id-patterns`) | `$DESK_STATE/tickets/<KEY>.md` (`desk-env paths` prints `DESK_STATE`) |
| Tracker `none` | the PR's `closingIssuesReferences` (Phase 1), each read with `gh issue view <issue number> --repo <owner>/<repo>`; never the PR's own number |

If nothing matches, or the ticket cannot be read, say so in one line and continue: Direction 1 is
skipped, Direction 2 still runs if there is a description.

**Author-written intent.** Bots and CI often write into the PR *body* (preview links, checklists), so
"the description is non-empty" is almost always true and means nothing. Strip generated blocks
first, then test what is left:

```bash
gh pr view <n> --repo <owner>/<repo> --json body --jq '(.body // "") | gsub("(?s)<!--\\s*[\\w:.-]+\\s*-->.*?<!--\\s*/[\\w:.-]+\\s*-->"; "") | gsub("(?s)<!--.*?-->"; "") | test("\\S")'
```

`false` means no author-written intent (paired generated blocks and every other HTML comment
stripped, only whitespace left). It is one `gh` command, so it runs in a worker too. `gh --jq` is
gojq on Go's RE2, which has **no backreferences**: an opening block is closed by the next
`<!-- /name -->` of any name, never `\k<name>`, which errors. With no PR yet
(Stage 4b runs before one opens) there is no description: intent is the ticket or the branch. With
no ticket as well, **Direction 2 does not run**: say "scope not checked: no ticket and no
author-written description". Never infer intent from the diff and mark the diff against it; that
always returns clean.

### Direction 1: criteria the diff does not meet

Unmet or partly met criteria only, each quoting the criterion:

```
REQUIREMENT GAP
ticket: <KEY>
criterion: <quoted>
gap: <what the diff does or fails to do>
code_claim: yes | no
```

`code_claim` answers one question: *would this still read as a defect with the ticket deleted?* A
gap marked `yes` is a claim about code that nothing has refuted, so it is **never posted**: it goes
in the terminal report tagged `UNVERIFIED CODE CLAIM`, for the author to judge, and is excluded from
the verdict's `gaps` count. It is not sent to Phase 4 either: that refuter judges against code, not
tickets, and would reject it on procedure.

### Direction 2: diff the criteria do not ask for

Bea's prompt carries the review bar **verbatim**, as the finders' does, because she is now emitting
P1/P2 candidates and needs its definition of stated intent and, above all, its **boy-scout
exemption**, or she files obedience to the repo's own rules as scope creep.

```
OUT OF SCOPE
file: <path>:<line>
what: <what the hunk does>
intent: <the criterion or description line measured against, quoted>
basis: ticket | PR description | branch purpose
```

An out-of-scope hunk whose symbols the Phase 3 census found **no live consumer** for is P1 *Scope
creep with no consumer*; everything else is P2 *Out of scope*. Both are ordinary findings in the
P1/P2 sections, and both post in the **review body, never inline**: a scope call needs the intent
beside it.
