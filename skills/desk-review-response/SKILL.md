---
name: desk-review-response
description: >-
  Use when a reviewer has commented on a pull request in this repo — the code reviewer, the product
  owner or anyone else requesting changes, leaving inline comments, or approving with notes. Also when
  asked to reply to review feedback, or to judge whether a reviewer's comment is correct.
---

# desk-review-response

## Overview

**Core principle: assess every comment before touching any code.** The reviewer is usually right,
but not always, and finding out after you've rewritten the file is expensive in both directions.

**Resolve this repo's config first.**

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no
```

Read the `CONFIG` file. `EXISTS=no` means stop: say which slug was looked up and offer `/desk-setup`.
A `TODO` in a row this skill needs is not a gap to guess: stop, ask, and offer `/desk-setup`. Then:
§0 for the GitHub repo, §1 for the user's GitHub handle, §3 for whether you may push (`git-push`),
post replies and resolve threads (`pr-reply`), §4 People for who the code reviewer and product owner
are (name and GitHub handle), §4 Local review command and Clean review verdict for the fix review
(`desk-env get local-review`, `desk-env get clean-verdict`), §4 What review here consistently asks
for (`desk-env get review-asks`), §4 Typecheck and Lint (`desk-env cmds typecheck-cmd`,
`desk-env cmds lint-cmd`), and §5 for the written register (Messages to colleagues)
and AI attribution.

The order the skill's author asked for, repeatedly: *"Don't change the code yet, let's talk before
you start working. Are all of the reviewer's comments correct?"* and *"is that what we should have
done in the first place? Answer before fixing."*

**Load this skill, don't approximate it.** Comments worked "in its spirit" without loading it keep
the assessment and lose the voice file — replies run three to five paragraphs against a 2-3
sentence register, and carry em-dashes.

## Required: assess first

Produce this before any edit. One row per comment, no exceptions:

```
REVIEW ASSESSMENT — awaiting direction
| # | Comment | Verdict | Evidence |
|---|---------|---------|----------|
| 1 | <one-line paraphrase, with file:line> | valid / partly / not applicable | <what in the code or repo makes it so> |
```

Then, separately, a draft reply per comment. Then stop.

**Enumerate the threads from GitHub, not from memory or a hand-written list.** Count unresolved
threads per PR before starting — a loop over hand-typed PR numbers skips PRs, including ones with
open threads.

**Verdict needs evidence, not deference.** "The reviewer is senior so this is valid" is not a verdict.
Read the code and say what you found. If a comment rests on a misreading, say which line shows
otherwise — politely and specifically.

Two comments from a senior reviewer have turned out not to apply. Both times, answering first was
faster than changing the code and changing it back.

## Then fix only what was agreed

- Fix exactly the comments the user confirms. Not the ones you think are also worth doing.
- Don't start a fix while an assessment is still unanswered.
- When done, confirm **every** comment is addressed or explicitly declined — a re-review that
  finds a missed comment costs another round trip.
- Fix commits go on the user's branch, pushed under §3 `git-push`. No `git reset` or history
  rewriting to "start clean". AI attribution as §5 AI attribution says: none at all where it is
  `forbidden`; where it is `allowed`, whatever the repo's own instructions require.

## Review the fixes before you reply

A review fix is new code, and nobody has reviewed it — the reviewer's comment predates it. Run
§4 Local review command at the new head before pushing, the same Stage 4b `desk-ticket` runs. A round
is clean when its report matches §4 Clean review verdict. §4 Local review command `none`: review the
fix diff yourself against §4 What review here consistently asks for, run §4 Typecheck, Lint and the
unit tests touching the changed files, and say plainly that no local review command ran.

**Fix what it confirms and run it again, at most three rounds.** Each fix is itself unreviewed code,
so only a round that finds nothing has reviewed everything; if the third still finds something, stop
and report what is left. Stop early for the three things no rerun settles: a fix that changes
product, design or catalog behaviour, a fix that grows (a new file other than its own spec, or a file
the diff does not already touch), and a finding the refutation pass could not confirm. Those go to
the user, and the loop continues around them. Moving equivalent sites onto a helper this PR
creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR
body. Growth means new behaviour, not new call sites.

Not ceremony: a review fix can carry a top-severity bug the original review never reached — a server-side gate
the reviewer asked for, bypassable one procedure away. They cannot have seen it, because it did not
exist when they commented.

## Posting back

Each of these is a write under the user's GitHub account — check the config §3 row first
(`pr-reply` to reply and resolve, `pr-self-review-comment` for the self-review, `git-push` for fixes).

- The self-review goes up as one `COMMENTED` review whose body opens with **the local-review marker
  §4 Local review command defines** (for `/desk-review`, `<!-- desk-review:local -->`), then its verdict
  marker, exactly as `desk-ticket` Stage 7 and the autopilot worker contract post it. The markers
  belong to the review command, not to desk: find them in its docs or in a review it has already
  posted, and keep them verbatim, because `desk-clearance` and any required check match on them.
  A command that defines no marker gets none; never invent one.
- A later "fixed in `<sha>`" follow-up opens with the command's reply marker instead (for
  `/desk-review`, `<!-- desk-review:reply -->`) and carries no verdict — it posts at a head nothing has
  reviewed, and the review marker would claim otherwise.
- **Never `--approve` or `--request-changes`.**
- Never post a verdict at a commit that already has one with different counts; changed counts need
  a new run.
- If codex is unavailable the refutation is same-vendor: tag every finding `(same-vendor)` and say
  so, rather than letting `CONFIRMED` imply a check that did not happen.

**Replying into a thread and resolving it are both GraphQL**, keyed on the thread id (`PRRT_…`).
`gh` has no verb for either, and `gh pr comment` posts a top-level comment, not a thread reply.

```bash
# unresolved threads with ids and bodies
# OWNER and NAME from §0 GitHub repo (GH_REPO in `desk-env where`)
gh api graphql -f query='{ repository(owner:"OWNER", name:"NAME") {
  pullRequest(number: N) { reviewThreads(last:100) { nodes {
    id isResolved path line comments(first:20){ nodes { author{login} body } } } } } } }'

# reply into a thread (body in a file so markdown survives the shell), then resolve it
gh api graphql -f query='mutation($tid:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){ comment { id } } }' \
  -f tid="$TID" -f body="$(cat reply.md)"
gh api graphql -f query='mutation($tid:ID!){ resolveReviewThread(input:{threadId:$tid}){ thread { isResolved } } }' \
  -f tid="$TID"
```

- Resolve only threads you actually addressed — a change, or an agreed pushback — and only after the
  reply that says so. Resolve means addressed, not replied-to.
- **Resolving never clears a standing `CHANGES_REQUESTED`.** Only a new approving review does, so a
  PR at 0 unresolved threads can still show `BLOCKED`. Say that rather than resolving harder.

A finding that needs a product decision does not block the reply — say what you fixed, and put the
question where the reviewer will see it.

## What reviewers here actually ask for

**Read the config §4 People table** ("Code reviewer", "Product owner") for who reviews this user's
work and who answers product and destination questions; match comment authors by the GitHub handle
it gives. `you` means the user reviews or decides themselves (a solo repo): comments from anyone
else are assessed on their merits, and product questions go to the user. If the table is `TODO`, say
so; you can still assess comments on their merits.

**The house standard is §4 "What review here consistently asks for".** It was mined from the repo's
review history when setup ran, or written by the user, and is not necessarily confirmed with the
current reviewer. Treat it as what this repo has rejected before, not as anyone's stated preference
— lead with the code, not with "they always ask for this". If the table is empty or `TODO`, assess
every comment on its merits alone.

Two rows hold in every repo because the config owns them:

| Pattern | What gets asked for |
|---|---|
| New infrastructure | Expect to justify it; fewer moving parts wins (§4 People "Infra and security owner") |
| A product, destination or copy decision | Not yours; it goes to the product owner |

Product and destination questions — where a link goes, whether a flow is right — go to §4 People
Product owner. If a comment asks for a product, design or catalog decision, that is not yours to
answer in a reply (`product-calls` is `stop`). Draft the question instead. A design question goes to
§4 People Designer, or the product owner when Designer is `none`.

## Replies

Short, direct, specific. Say what changed, or why it shouldn't. Reference the file or the commit.
No preamble, no thanking-for-the-review boilerplate, no emoji.

**Read `references/voice.md` before writing a single reply.** Comments on a PR are messages to
people, so that register applies. PR *bodies* are ordinary technical prose and exempt — see
`desk-pr`.

When the user will attribute it to Claude explicitly (*"Claude said this is the issue"*), write it
as the agent speaking: state the finding directly, no first-person framing as them.

## Keep the user posted

If a comment turns out not to apply, or reveals something bigger than the comment itself, say so as
soon as you establish it. That changes what the user says back to the reviewer.

## Common mistakes

| Mistake | Fix |
|---|---|
| Editing code on receipt of a comment | Assess all comments first, then wait |
| Working the comments without loading this skill | The assess-first table and `voice.md` only come with it |
| `git reset` or rewriting history to "start clean" | Don't restructure the user's branch to make a fix easier |
| Agreeing with a comment you haven't verified | Read the code; give the evidence |
| Fixing extra things while you're in there | Only what was agreed |
| A long, apologetic reply | Two or three sentences, what changed, done |
| `gh pr comment` to answer an inline comment | Thread reply via GraphQL on the thread id |
| Answering a product question yourself | Draft it for §4 People Product owner |
| Declaring it addressed without re-checking every thread | Enumerate from GitHub and confirm each |
| Replying and pushing without reviewing the fix | The fix is unreviewed code; §4 Local review command at the new head first |
| Resolving a thread you answered but did not act on | Resolve means addressed, not replied-to |
| Expecting 0 unresolved threads to unblock the PR | A standing `CHANGES_REQUESTED` needs a new approval |
