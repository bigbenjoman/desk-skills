# desk-review Phase 5: requirements

Read at Phase 3, with `phase-3-find.md`: this seat is dispatched alongside the finders. The config,
the bar, the entry points, every seat's prompt, the round rules and the verdict are in
`../SKILL.md`, already loaded; a "below" or "above" this file does not hold points there or to
another phase's file. Paths such as `references/gotchas.md` are from the skill's directory.

## Phase 5: requirements

`bea-business-analyst` (else `general-purpose`), dispatched **alongside** the Phase 3 finders. She
reads the ticket, the calls already taken on it (*Settled calls*, below) and the diff, not their
output. **She never writes to the tracker**: no comment,
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
settled_by: code | person
```

**A criterion about every instance of something** ("every page", "an avatar wherever a person
shows", "all the buttons") gets one gap naming **every site the diff misses that you can find**, each
as `file:line`, never a sample: search the reviewed tree for the thing itself (`git grep` at `<TIP>`)
and say in the gap how you searched. A sample leaves the next round to find the rest, and each fix
try is spent finding sites rather than closing them.

**Settled calls amend the criteria.** Bea's prompt carries, beside the ticket, every call already
taken on it: each line of the PR body's `### Decisions taken` section (`desk-pr`), and each entry of
the triage record's `decided` list (`$DESK_STATE/triage/<KEY>.json`, where one exists). She measures
each criterion as those calls amend it, so a diff that meets the amended criterion has no gap there.
A call this ticket's worker logged amends a criterion only by choosing between its readings, or by
keeping a later-merged ticket's behaviour (below): any other that leaves a criterion unmet as worded
amends nothing, and the gap is the worker's to close.

`settled_by` is `person` only when no change the ticket allows can close the gap, so all that is
left is the person accepting it on the PR or amending the criterion: a value only the person holds,
say, or a high-risk criterion that can pass only on a deployed build (*A criterion only a live system
can check*, below). Doubt is `code`, and so is each of these, whatever the criterion's wording:

- a gap a worker could close by changing code, or by an engineering call of its own;
- a gap whose own `gap:` text names the code change that closes it;
- a gap a settled call covers;
- a gap that exists only because of the fix for a P0 or P1 found in this same review;
- a gap whose cause is a decision this ticket's worker logged, which reversing that decision closes,
  unless the decision keeps a later-merged ticket's behaviour (next);
- a gap that exists only because the diff keeps behaviour a ticket merged after this one's triage
  added. Its `gap:` names that ticket, and its posted line carries an indented
  `Engineering decision: keep <TICKET>'s <behaviour>; <TICKET> merged after this ticket's triage`,
  which the fix worker logs (`decisions.mjs log`) and lists under `Decisions taken`, so the next
  round reads it as a settled call.

Post a `person` gap as one list item holding the literal tag `PERSON'S CALL`, its detail indented
under it, on every round it stays open, ending with the seat's pick whenever it has one:
`- PERSON'S CALL · AC2: "<criterion>" — <what is open, and how the person can settle it>. Recommended: <option>`.
The autopilot pass reads the tag (`desk/bin/fix-tries.mjs` `reviewFix`): a tagged gap earns no fix try,
and it still counts in `gaps`. Under §3 `autopilot-judgement` `yes`, tagged gaps that are all the
review leaves open and all end `Recommended: <option>`, none reading as an ask category, go to one fix
try that carries out each
recommendation, so name the pick last, after `Recommended:`, and nothing after it. A pick that
accepts the gap (`Recommended: accept AC2 as built`) is never carried out for the person: only their
own comment accepts it (next), so no fix try, default or decider takes it, and desk-needs-you gives
them the comment to post.

`code_claim` answers one question: *would this still read as a defect with the ticket deleted?* A
gap marked `yes` is a claim about code that nothing has refuted, so it is **never posted**: it goes
in the terminal report tagged `UNVERIFIED CODE CLAIM`, for the author to judge, and is excluded from
the verdict's `gaps` count. It is not sent to Phase 4 either: that refuter judges against code, not
tickets, and would reject it on procedure.

### A criterion only a live system can check

A criterion that can pass only once the PR has merged, because what checks it exists only live (a
production run, a call on the shared staging system, a deployed build, playback on a device, a third
party's live service), is **not a gap**: it is a follow item for after the merge. Bea posts it as one
list item holding the literal tag `POST-MERGE`, under neither gaps heading:

```
POST-MERGE
ticket: <KEY>
criterion: <quoted>
needs: production | staging | deployed | device | third-party
step: <one line: what the person runs or looks at after the merge, and where>
```

She **refuses the tag**, and the criterion stays a `REQUIREMENT GAP` measured as above, when:

- anything before the merge can check it: a unit or integration test, a local run, a recorded
  fixture, a preview deployment the repo has. A behaviour the code decides alone is tested, whatever
  the criterion says about where it shows up;
- the diff does not yet do what the criterion asks, so a live check would only find it unmet: the
  tag defers the check, never the work;
- the criterion is **high-risk**: the ticket's criterion text or its Decisions section calls it
  high-risk, or the criterion names production data or money (a migration of live records, a charge,
  a payout, a price). It keeps its pre-merge park: a `settled_by: person` gap posted as `PERSON'S
  CALL`, which the person accepts on the PR (next) before the merge.

The reviewer (not Bea) puts each tagged criterion in the results file's `post_merge` list, not in
`gaps`:

```json
"post_merge": [ { "gap": "AC7", "needs": "production", "step": "fill in the switch date at the production relay run" } ]
```

verdict.mjs refuses an entry missing any of the three, a `needs` outside that list, a criterion
listed twice, or one also in `accepted`. It prints `<!-- desk-review:post-merge v=1 gaps=<n> items=<json> -->`
after the accepted line, and the heading names the count. Like the accepted line it never decides
clean, so a verdict whose only open criteria are post-merge reads `gaps=0` to every gate copy and
the PR is not held for them. `node verdict.mjs --post-merge <results>` prints the `### After the
merge` section, naming each criterion, what it needs and its step: it goes in the review body under
the report. Once the PR merges, the autopilot pass reads the line from the PR's last review and keeps
each criterion as a follow-on step (`desk/bin/pass.mjs`), which `desk-needs-you` lists to the person
as the ticket's follow item. Where the worker already declared follow-on steps of its own (any but
kept link steps and an earlier PR's criteria still unrun), those stand and no criterion is added: the two word one check differently. A tagged criterion stays in `post_merge` on every later round.

### A gap the person accepted

A gap only the person can close (a high-risk criterion only a live system can check, a manual check
they took in another form) is **accepted** when a PR comment or review by §1 GitHub handle names the gap's
criterion and accepts it. Nobody else's counts, nor a note on the ticket alone. Before counting
`gaps`, the reviewer (not Bea) reads the PR's comments and reviews for one:

```bash
gh pr view <n> --repo <owner>/<repo> --json comments,reviews
```

Each gap so accepted leaves `gaps` and goes in the results file's `accepted` list, linked to its
record: a comment's `url`, or a review's `html_url`. That `gh pr view` gives a review's `id` as a
GraphQL node id (`PRR_…`), which no review link carries, so read a review's link from REST
(`desk-gh read repos/<owner>/<repo>/pulls/<n>/reviews -X GET --jq '.[] | {html_url, user: .user.login}'`):

```json
"accepted": [ { "gap": "AC3", "by": "<§1 GitHub handle>", "at": "2026-10-29",
                "url": "https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>" } ]
```

verdict.mjs refuses an entry missing any of the four, or a gap listed twice. It prints
`<!-- desk-review:accepted v=1 gaps=<n> -->` after the heading (and after the carried line), and the
heading names the count. Like the carried line it never decides clean, so a verdict whose only gap
is accepted reads `gaps=0` to every gate copy and is clean. `node verdict.mjs --accepted <results>`
prints the `### Accepted gaps` section, naming who accepted each gap, when, and its link: it goes in
the review body under the report. An accepted gap stays in `accepted` on every later round until its
criterion is met. Only a requirement gap is accepted: a P0 or P1 is fixed, and a P2 carried.

In an autopilot batch the pass reads the PR for one each pass while it waits on such a gap: once a
comment or review from §1 GitHub handle, posted after that verdict, names the criterion and accepts
it (a line opening "I accept", "Accepted" or "Accepting", as desk's ready comment does, and no words
refusing or limiting it, which leave it to the person), the ticket goes back to a worker on the PR with the comment as the person's call (`desk/bin/fix-tries.mjs`
`acceptedFix`), with no message to the batch's session. Where config §3 `accept-review-gaps` is `yes`,
the pass posts that comment itself as the handle, once per gap, before it reads (`grantedPost`): the
ready comment, with what the review found and the PR body's lines naming the criterion quoted under
each gap, and a last line saying desk posted it under that row. So keep a recommendation to accept
accurate, because at `yes` nobody reads it before it is acted on.

An acceptance recorded after the head's verdict posted is the one case for a second verdict at that
SHA (Phase 7, `phase-7-post.md`): the same round's results, with only the accepted gaps moved from
`gaps` into `accepted`. It repeats that round, so it is not counted as one: the next round is the
last verdict's `round=` + 1, not Phase 1's marker count + 1.

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
