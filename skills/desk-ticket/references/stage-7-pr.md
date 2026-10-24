# desk-ticket Stage 7: PR

Read at the start of Stage 7, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded;
a "below" here that this file does not hold points there. A fix while shepherding goes back
through Stage 4b: read its file again then.

| # | Stage | What happens |
|---|---|---|
| 7 | PR | **Invoke the `desk-pr` skill and follow it. Do not write the body from memory.** It owns the hygiene block, the permitted sections, the Testing-bullet standard and the before/after image table. Ends with `gh pr create --repo <repo> --draft --base <default> --body-file` (that flag order; see `desk-pr`), then the image upload. **Then post the Stage 4b report to the new PR**, then, where config §3 permits, **undraft it, arm auto-merge and shepherd it until it merges**. See "Merging" below. |

## The DIFF REVIEW block (gate 3)

```
DIFF REVIEW — <recorded | awaiting approval>
files changed : <n>   (<list>)
commits ahead : <output of git log --oneline origin/<default>..HEAD>
artefacts     : <git status --porcelain, or "clean">
```

**Before any push, `git log --oneline origin/<default>..HEAD` must contain only your own commits for
this ticket.** If it contains anything else, do not push: report the stray SHAs and offer to
move your commits onto a clean branch off `origin/<default>`. This has happened: another session's
work went up attached to an unrelated ticket.

## Posting the self-review

With §4 Local review command `none` there is no report to post: nothing is posted, and the PR's
Testing section says the branch had no local review (the Stage 4b skip).

**Posting the self-review (Stage 7).** Local reviews are posted to the PR so the code reviewer
(config §4 People) can merge faster. So, where config §3 `pr-self-review-comment` allows, the Stage 4b
report goes onto the PR as one `COMMENTED` review, immediately after `gh pr create --draft`:

```bash
gh pr review <n> --repo <repo> --comment --body-file <report>
```

Plain `gh`, authenticated as §1 GitHub handle (`gh auth status` shows the active account; switch
with `gh auth switch` if it is another). Never a `GH_TOKEN=…` prefix: no harness rule matches a
`VAR=value` form, and autopilot workers are refused it outright.

Where the review command defines markers, use them exactly. Open the body with its **local-review
marker**: that is what lets a later sweep tell a real review from the empty `COMMENTED` artefact
GitHub records every time you reply to an inline comment. The **second line is its verdict marker**
(the head SHA it reviewed and its counts), which a required check may read at the PR's current head.
**A later "fixed in `<sha>`" reply carries the command's reply marker instead, and no verdict**: it
posts at the new head, so giving it the review marker claims that head was reviewed when it was not.
**Never `--approve` or `--request-changes`.** A clean run posts too: absence of a review must mean
*not reviewed*, not *reviewed and clean*.

Stage 4b still runs **before** the PR exists, so this is a post of the report you already have: one
review pass per ticket, not two. The SHA and any `(same-vendor)` tag carry into the posted body
unchanged. If the head moved between 4b and the push (you fixed a finding, or rebased), re-run at
the pushed head rather than posting a report about a different commit. Never re-point an existing
marker's SHA at a new head.

**Counts never change at the same commit without a new run.** Never post a second verdict at a
SHA that already has one with different counts, and never edit the counts of one already posted.
A gate reads the last verdict at head, so a re-post that relabels findings is indistinguishable
from editing the result until it passes: a re-post that zeroes the deferred count with no code
change can clear a known P0. If a count is wrong, re-run the review at that head and post that run.

## Merging

**Merging (Stage 7).** A draft cannot merge, so a PR left drafted is a merge silently deferred. If
config §3 `pr-ready` and `pr-auto-merge` are both `yes` (auto-merge merges on green by itself, so it
also needs `pr-merge-green`), and §4 Repo merge settings allow auto-merge, right after the Stage 4b
post:

```bash
gh pr ready <n> && gh pr merge <n> --auto --<§4 Merge method> --match-head-commit <headRefOid>
```

Where the repo does not allow auto-merge, undrafting is the same and the merge is yours to make on
green under `pr-merge-green`, always pinned: `gh pr merge <n> --<§4 Merge method>
--match-head-commit <the head SHA whose checks you read>`. **A PR that touches a glob in §4 Merge
holds is never merged or armed by you**, whatever §3 grants: report it ready with the hold's reason
(the manual step the repo needs first) and let the user merge it. Then **shepherd it until it merges** rather than handing back at
"armed": the same rules the autopilot's merge driver follows, for one PR. If either row is `ask`,
ask; otherwise stop at the draft and report the link. Once it merges, and it was the last open PR on
the key, move the ticket to §4 Done state via `desk-jira` under §3 `jira-close-own-merged` (a
non-tracker ticket: nothing to move). **Then tell the batch**, whether the PR merged or the ticket
went to Done some other way: an autopilot batch may still hold the ticket parked, and would list it
at every check-in.

```bash
node ~/.claude/desk/bin/closeout.mjs <TICKET> --pr <n>          # or --how done, with no PR
```

It leaves a note for that batch's orchestrator, whose next pass records the ticket done, and prints
one line saying so. A ticket in no batch writes nothing and prints nothing, so say nothing about
queues. The orchestrator's own merge flow already records its merges (`queue.mjs merged`), so this
is for interactive sessions only.

- **Green is the config's one definition** (desk-config "Green", the same in `desk-autopilot`,
  `desk-clearance` and the merge driver): on the exact head commit being merged, every §4 Required
  checks entry completed with success (skipped does not count); no other check failed, errored, timed out
  or is still queued or running, unless §4 Advisory checks names it; and at least one check
  completed with success. Then merge pinned to that commit with `--match-head-commit`. With §4
  Branch protection `none`, nothing on GitHub stops a red merge, so the check is entirely yours.
  Read check state with `gh pr checks <n> --json name,state,bucket`, or `awk -F'\t'` on the plain
  output: it is tab-separated, and a check name carrying an emoji breaks whitespace splitting.
- **A review gate can fail on a fresh PR's first run when the review posts late.** Where a required
  check reads the posted verdict: CI typically runs only on open, reopen and push, so posting a review
  starts nothing. If the gate polls for the verdict briefly after the run starts, a review posted
  inside that window passes the same run. If the post missed it, wait for the whole run to reach
  `completed`, confirm the verdict's SHA is the head, then rerun it.
- **Red check: read why before acting.** Retrigger only a run that has reached `completed`, found by
  head SHA (`gh run rerun <id> --failed`, under §3 `ci-rerun`). Rerunning one in flight cancels it,
  and a fast loop starves the PR forever.
- **A red preview-deploy check is often the host's builder running out of memory** (exit 137), not
  the code. Where §4 Vercel is set and §3 `read-vercel` allows,
  `vercel inspect --logs <url> --scope <team slug from §4 Vercel>` first. One preview build at a time.
- **`DIRTY` merges nothing.** Merge `origin/<default>`, typecheck, then re-run Stage 4b at the new
  head and post it: a gate that matches the verdict against the exact head SHA reads nothing older.
- **Human review feedback lands while armed** and §3 `merge-feedback-first` is `yes`:
  `gh pr merge <n> --disable-auto`, work it via `desk-review-response`, then re-arm.
- **Never `--admin`.** Any code change while shepherding gets the same diff record and self-review.

## Red flags at this stage — stop

- About to open a PR without having run Stage 4b (or stated its skip, where the command is `none`)
- About to post a verdict at a commit that already has one, with different counts
- Posting a review whose header does not state which agents actually ran, what refuted the
  findings, or that drops the SHA
- About to merge without `--match-head-commit`, or a PR under a §4 Merge holds glob

## Rationalizations at this stage

| Excuse | Reality |
|--------|---------|
| "The deferred count was wrong, I'll re-post it corrected" | Changed counts need a new run. A re-post can clear a known P0 with no code change. |
| "No branch protection here, so a red check doesn't matter" | Protection `none` moves the rule from GitHub to you. Never merge red. |
| "It's green, the hold is just a formality" | A §4 Merge holds entry is a manual step the repo needs before merging. Report it; the user merges. |

## Common mistakes at this stage

| Mistake | Consequence |
|---|---|
| Writing the PR body from memory instead of invoking `desk-pr` | The PR can ship with no before/after table and a section the convention forbids. The sibling skills own their stages: `desk-pr` for Stage 7, `desk-jira` for Stage 8, `desk-review-response` for review replies. Recalling the gist of one is not following it: working 72 review comments "in its spirit" dropped the assess-first table and the reply voice. |
| Leaving a PR in draft once review is clean | A draft cannot merge; the merge is silently deferred |
