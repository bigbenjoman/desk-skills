# desk-ticket Stage 4b: Self-review

Read at the start of Stage 4b, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded;
a "below" here that this file does not hold points there. Posting the report is Stage 7's.

| # | Stage | What happens |
|---|---|---|
| 4b | Self-review | Run §4 Local review command on the branch, **before** Stage 5, so a finding cannot invalidate screenshots already taken. With `none`, the stage is a stated skip (below). Two preconditions, each a silent false clean otherwise: where the command is a repo-local skill, the tree must contain it (rebase onto `<default>` rather than skipping), and an empty diff is a stated skip, never a clean run. **Fix what the review confirms, then report**; do not stop and ask first. Apply every confirmed P0 and P1, and any P2 whose fix is mechanical, as their own commit. Produce the `SELF-REVIEW` block as a record of what was done, with an outcome against every finding. Re-run after fixes, **at most three rounds**: each fix is itself unreviewed code, so only a round that finds nothing has reviewed everything. From round 2 a round reads only the fix range, the commits since the round before (`desk-review`'s fix-range rules), and only P0 and P1 block: a round-2 P0 or P1 is fixed and round 3 runs. If round 3 finds a P0 or P1, stop: report each, do not open the PR, and let the user decide. If round 2 or 3 finds only P2s, they are **carried**, not a stop: open the PR with them under *Carried review findings* (`desk-pr`; more than five go to one follow-up ticket where §3 `jira-create` is `yes`). **Three things also stop and wait**, because no refutation settles them: a finding whose fix changes product, design or catalog behaviour and is an ask-category call or has no recommendation (otherwise take the recommended fix and log it: "Ask or take", below); **a fix that grows**: it needs a new file other than its own spec, or a file the ticket's diff does not already touch (Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call sites.); and any finding you could not confirm because the refutation pass did not run. |

**Self-review (Stage 4b).** §4 Local review command is the repo's own review: often a repo-local
skill that reviews the branch against the house bar (§4 What review here consistently asks for) in
one or more read-only finder subagents, then refutes the findings. Where it is a repo-local skill, it
only resolves in a tree that contains it, so a checkout branched before it landed has to be rebased
first. If it still does not resolve after the rebase, the skill list was read when the session
started: restart rather than working around it. The command failing to resolve is never a reason to
skip the stage.

**§4 Local review command `none`** means this repo has no local review. Stage 4b is then a stated
skip, never an improvised review: the `SELF-REVIEW` block says `skipped: §4 Local review command is
none`, nothing is posted at Stage 7, and the PR's Testing section says the branch had no local
review. Everything else about the stage (the three-round cap, the stop conditions) has nothing to
act on.

Skills load from the **main checkout** at session start, so a main checkout behind
`origin/<default>` can serve a stale copy of a repo-local review skill, one that lacks a marker or a
rule a required check now reads. Where the review is a repo-local skill, compare the loaded copy with
`git show origin/<default>:<its SKILL.md path>` and take the contract from `origin/<default>` if the
loaded copy lacks it.

Where the review refutes its findings with `codex` (a cross-vendor pass), whether codex answers is
config §4 "Codex answers a real call?", and sending it diffs at all is §3 `codex-review`. Check it
rather than assuming it, because a logged-out or out-of-usage CLI fails the same way an absent one
does:

```bash
codex exec --sandbox read-only "Reply with exactly: CODEX_OK"
```

**Not `codex login status`**: it reports logged in on a seat that is out of usage, so it passes
while every refutation fails. Only making codex answer tells you anything.

Exit 0 means usable. Anything else (an error naming a usage reset date, a capacity error, or no
output at all) means stop and say so; `codex login` is interactive and the user's to run. If they
say run it anyway, the refutation falls back to the review's same-vendor refuter, and the
`(same-vendor)` tag has to survive into the gate block and into the PR body. Dropping it claims
cross-vendor verification that did not happen.

**Finders must stay read-only.** They inherit Edit and Write, and one will sometimes implement a fix
mid-round, even in a file the PR did not touch, so the review attests a tree nobody pushed. Check
`git status --porcelain` after every round; a dirty tree is an aborted round: save the stray diff,
restore, re-run, and say in the review that a round was discarded.

**Three rounds, then stop.** Review, fix, re-review has no natural end: every fix is new code a
finder can find something in. The branch has been read whole once by round 2, so from round 2 a
round reads only the fix range (the commits since the previous round's reviewed SHA, which goes in
its results as `since`), and from it only P0 and P1 block. Before the PR exists the review cannot
count its own rounds, so tell it: run it with "round <n> of this loop" and, from round 2, "since
<the previous round's reviewed SHA>". A round-2 P0 or P1 is fixed, and round 3 reads the fix range
since round 2. After the third round there is no fourth without the user. From round 2:

- **Round 3, a P0 or P1 still open**: stop, report each finding with its `file:line`, do not open
  the PR.
- **Round 2 or 3, only P2s**: mark each `"carried": true` in the results, so the verdict reads clean on the
  blocking counts and records the number carried, and open the PR. The P2s go in its body under
  *Carried review findings* (`node <desk-review>/bin/verdict.mjs --carried <results>` prints the
  section), or, when there are more than five and §3 `jira-create` is `yes`, into one follow-up
  ticket the body links instead (`desk-pr` §2). Nothing stops for them, whatever §3 `jira-create`
  says: without it they stay in the body.

The count belongs to one loop; a later loop, for reviewer feedback or after merging `<default>`,
starts again at one.

**Declining a confirmed finding is a deferral, and a deferral does not read as clean.** It keeps the
verdict off §4 Clean review verdict, and where a required check reads the verdict, the gate blocks
the merge. Cost the fix before deferring: "beyond scope" is usually a guess made without opening the
file. A fix that stays inside the ticket's files goes in this PR: a split buys nothing but a second
PR, review and merge. **A fix that grows stops and asks**: one that needs a new file other than its
own spec, or a file the diff does not already touch, is the "while I'm in here" red flag arriving
through a finding. The user chooses between widening this PR and splitting the finding to its own
ticket. Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them
all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call
sites.

## The SELF-REVIEW block (gate 7)

```
SELF-REVIEW
reviewed  : <branch> → <default> at <sha> · <n> files · <tier> tier · <k> finders
refuted   : <codex, or "<same-vendor refuter> (same-vendor)" and why codex was unavailable,
             or "did not run" and what confirmed the findings instead>
domains   : <what the knowledge check or the repo's instructions named, or "none — nothing documents these paths">
P0 (n)      <file:line — one line each>
P1 (n)
P2 (n)
CARRIED (n)   <file:line — the P2s round 2 or 3 carried to the PR body or follow-up ticket>
REQ GAPS (n)  <TICKET — the criterion>
caveats   : <any check the run could not perform, or "none">
outcome   : <per finding: fixed in <sha> · declined, and why · escalated, and which
             stop condition it hit>
rounds    : <n> of 3 in this loop (from round 2: fix range <since>..<sha>)
re-review : <result at the new head, or "not needed — nothing was changed">
```

With §4 Local review command `none`, the block is one line: `SELF-REVIEW skipped: §4 Local review
command is none`.

**Every finding gets an outcome line, including the ones you fixed.** The block is a record rather
than a request, so it is the only place a reader can see that a P0 existed at all: a finding that
is silently fixed and never reported reads afterwards as a review that found nothing.

**"No P0, P1 or P2 across n files" is a result and still gets the block.** An absent block is
indistinguishable from never having run it, which is the one thing this gate exists to rule out.

**The `caveats` line is the one that earns the gate.** A clean report where a check silently did
not run is worth less than a report with a finding, and the difference is invisible unless it is
written down. Two that have happened: the knowledge check named **no** owning domain for a changed
file, so no domain file reached the finders and the review's documented-exception filter never
applied; and the finders read the specs statically rather than executing them. Neither changes the
verdict. Both change how much the verdict is worth, so both go in the slot.

## Red flags at this stage — stop

- Starting a fourth review round without the user
- A round 2 or 3 that reads `origin/<default>...HEAD` rather than the fix range since the round before
- Carrying a P0 or P1, or a P2 on round 1
- Treating the local review command not resolving in this tree as a reason to skip it rather than to rebase
- Dispatching finders in a worktree without having run §4 Project subagents sync: they are all
  `general-purpose` and the report will not say so
- Claiming a codex refutation on a run where codex was never made to answer

## Rationalizations at this stage

| Excuse | Reality |
|--------|---------|
| "Self-review found nothing, so there is no block to show" | The empty result is the finding. Show it. |
| "I should ask before fixing this finding" | Stage 4b fixes what it confirms. Only the stop conditions wait: product/design/catalog behaviour, a fix that grows, a finding the refutation pass never confirmed, or a third round still finding a P0 or P1. |
| "The P0 is fixed, so the block can just report clean" | Then nobody ever learns a P0 existed. Fixed findings still get an outcome line naming the commit. |
| "One-line change, self-review is overkill" | A one-line diff gets the cheapest tier of review. Cheapness is why it is a gate and not a ceremony. |
| "I'll defer this P2, it's out of scope" | A deferral keeps the verdict off clean, and a review gate blocks on it. Cost the fix first. Inside the ticket's files, fix it; needing a new file or one outside the diff, stop and ask. Moving equivalent sites onto a helper this PR creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR body. Growth means new behaviour, not new call sites. |
| "One more round will get it clean" | Three is the cap. A P0 or P1 left after round 3 stops and is reported; P2s left are carried into the PR body, not a fourth round. |
| "Round 2 or 3 found only P2s, so I'll ask whether to fix them" | They are carried: the PR opens with them under *Carried review findings*. That question cost 255 asks and 78 parks in one month, and a P2 blocks nothing a reviewer cannot see in the body. |
