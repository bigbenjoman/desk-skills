# The repo facts desk-clearance depends on, and where to get them

No repo's facts are written here. Each one lives in a config row (resolve the config with
`desk-env where`, then Read it) **and** on the platform. The platform is the authority: a row is
what setup detected at the time, and it drifts. Re-verify rather than trust whenever behaviour
disagrees, and when the two differ, act on the live answer and tell the user the row needs
`/desk-setup`.

`bin/clearance-state.mjs` encodes most of this. Read here to understand *why* it does what it does,
not to reimplement it by hand. Below, `<repo>` is §0 GitHub repo and `<base>` is §0 Default branch.

## Which row holds what

| Fact | Config row | Verify live with |
|---|---|---|
| Repo, default branch | §0 GitHub repo, §0 Default branch | `gh repo view <repo> --json nameWithOwner,defaultBranchRef` |
| Whose PRs are ours | §1 GitHub handle | `gh api user --jq .login` (only if the row is unset; the row wins) |
| Required checks | §4 Required checks | the ruleset and branch-protection calls below |
| Advisory checks | §4 Advisory checks | any check on a PR that is not required |
| Approvals, stale-review dismissal, changes-request blocking, up-to-date rule | §4 Branch protection | the ruleset `pull_request` rule, or classic protection |
| Merge method | §4 Merge method | ruleset `allowed_merge_methods`; else `gh api repos/<repo> --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge}'` |
| Auto-merge, delete branch on merge | §4 Repo merge settings | `gh api repos/<repo> --jq '{allow_auto_merge,delete_branch_on_merge}'` |
| `workflow` token scope | §4 `gh` token scopes | `gh auth status` |
| PR title rule | §5 PR title | the workflow job that checks it, if any |
| Preview deploys | §4 Vercel | `vercel list` under that team, or the deploy check on a PR |
| Who owns infra, and which paths count | §4 People "Infra and security owner" | — |
| What reviewers keep asking for | §4 "What review here consistently asks for" | `clearance-state.mjs corpus` |

A row set to `none` is an answer: §4 Branch protection `none` means the default branch is
unprotected, §4 Vercel `none` means there is no Vercel project to check, and so on. It never means
"skip the bar".

## Rulesets and branch protection are two different things — read both

A branch can be guarded by a **ruleset**, by **classic branch protection**, by both, or by neither.

```bash
# rulesets (readable by anyone with read access)
gh api repos/<repo>/rules/branches/<base> --jq '.[].type'
gh api repos/<repo>/rules/branches/<base> \
  --jq '.[]|select(.type=="required_status_checks").parameters.required_status_checks[].context'
gh api repos/<repo>/rules/branches/<base> \
  --jq '.[]|select(.type=="pull_request").parameters'

# classic protection, summary form (readable without admin)
gh api repos/<repo>/branches/<base> --jq '{protected, checks: .protection.required_status_checks}'
```

**A 404 from `repos/<repo>/branches/<base>/protection` means nothing on its own.** On a repo guarded
by a ruleset it 404s, and it needs admin to read at all. The two calls above are the authority; the
union of their required contexts is the bar.

What the settings mean for clearance:

| Setting (ruleset `pull_request` parameter, or classic equivalent) | If set | If not |
|---|---|---|
| `allowed_merge_methods` | only these merge; §4 Merge method must be one of them | the repo-level `allow_*_merge` flags decide |
| required status checks | those contexts, each completed with success at head (a skipped one passes, as branch protection counts it) | §4 Required checks `none`: nothing is required by name, but green still needs every non-advisory check passed and at least one success (desk-config "Green") |
| `strict_required_status_checks_policy` / "require branches to be up to date" | the PR next to merge must be updated first | being behind never blocks a merge |
| `required_approving_review_count` > 0 | the platform refuses an unapproved merge; report `READY` | no *positive* approval is enforced |
| a standing `CHANGES_REQUESTED` | blocks the merge outright (see below) | nothing refuses it, and clearance still parks it |
| `dismiss_stale_reviews_on_push` | an approval dies on any push; the verdict re-derives as `NONE` | an approval survives later pushes |
| `required_review_thread_resolution` | unresolved threads block | unresolved threads never block |

**Read the required context from the API, never from a name you remember, a `ci.yml` comment, or
the config row.** Check names change: when a ruleset is changed ahead of the workflow, every open PR
reads `MERGEABLE`, rollup `SUCCESS`, every check green — and `BLOCKED`, "Expected — waiting for
status to be reported". The tell is a required context that appears on **no** commit:

```bash
gh api "repos/<repo>/commits/<head>/check-runs?per_page=100" --jq '[.check_runs[].name]'
```

Fixing that deadlock needs repo admin — report it to §4 People "Infra and security owner" (or the
user, where that row is `you` or `none`).

**"0 approvals required" does not mean anything merges.** Where a changes-request blocks, `gh pr
merge` fails with `Repository rule violations found — 1 review requesting changes by reviewers with
write access`, and `mergeStateStatus` reads `BLOCKED` while `mergeable` says `MERGEABLE`. Resolving
threads does not clear it; only the reviewer approving or dismissing does.

**So "approved", "threads resolved" and "up to date" are conventions unless a rule says otherwise.**
Which of them clearance enforces on top is config §3 `pr-merge-green` and `merge-feedback-first` —
see the merge bar in SKILL.md.

**Any base branch other than `<base>` usually has no rules at all** — no required check, no merge
method restriction. Check `rules/branches/<that branch>` before assuming otherwise.

## Merge paths

`<method>` is §4 Merge method (`squash`, `merge` or `rebase`).

| PR | Command |
|---|---|
| Unstacked | `gh pr merge <n> --<method> --match-head-commit <sha>`, or the same with `--auto` to land on green (only where §4 Repo merge settings allows auto-merge). Never for a PR under a §4 Merge holds glob |
| Stacked (`gh api repos/<repo>/pulls/<n> --jq .stack` is non-null) | `gh api -X PUT repos/<repo>/pulls/<n>/merge-async -f merge_method=<method>` |

Stacked PRs refuse `gh pr merge` ("must be merged using the asynchronous merge REST API"), `--auto`
("not supported for stacked pull requests") and `PUT /merge` (403). `merge-async` returns
`{"status":"pending"}` — **enqueued is not merged**; poll `gh api .../pulls/<n> --jq .merged`. A stack
association **survives its parent being closed**, so "is it stacked?" is the `stack` field, not
`baseRefName`. Stack listing: `gh api repos/<repo>/stacks`.

Where `delete_branch_on_merge` is on (§4 Repo merge settings), re-raising a reverted PR needs the
branch pushed back first.

## A PR-title check, if the repo has one, is not cleared by a retitle

Many repos check §5 PR title in CI (often a ticket key after the conventional-commit colon, waived by
a label). Such a job usually runs on `pull_request` with the **default** event types, and `edited` is
not among them. Renaming does not re-trigger it, and rerunning replays the old payload. **The fix is
a push** (a branch update counts) — or close/reopen, which fires `reopened`. Read the job's `on:`
block before relying on this.

## reviewDecision: a positive signal for CHANGES_REQUESTED, and nothing else

| `reviewDecision` | Means | Trust it? |
|---|---|---|
| `CHANGES_REQUESTED` | a standing changes-request | **yes** |
| `""` (empty) | **nothing at all** | **no** |

Empty covers both "nobody has reviewed" *and* "a reviewer approved" — GitHub never computes
`APPROVED` when 0 approvals are required. Derive the verdict from the event record, last
`APPROVED`/`CHANGES_REQUESTED`, ignoring every `COMMENTED`, and **paginate** (an approval that is
review 35 of 35 is missing from a 30-row call, which shows a stale `CHANGES_REQUESTED`):

```bash
gh api --paginate repos/<repo>/pulls/<n>/reviews \
  --jq '.[]|"\(.user.login) \(.state) \(.submitted_at)"'
```

Review bodies often carry items that could not attach to a line because the file is not in the diff.

## mergeStateStatus vocabulary

| Value | Means | Action |
|---|---|---|
| `CLEAN` | mergeable, required checks green | apply the bar, then merge |
| `BLOCKED` | a requirement unmet — **often a standing changes-request**, sometimes a pending required check, a missing approval, or a required context that never reports | read the checks and the verdict separately |
| `BEHIND` | the branch must be up to date and is not | update it, since it is next to merge |
| `UNSTABLE` | mergeable; a **non-required** check is pending or failing | if the required checks passed, this is mergeable |
| `DIRTY` | conflict **with the base** — on a stacked PR that is not the default branch | probe, propose, ask |
| `UNKNOWN` | recomputing after the base moved | wait ~1 min, re-read; never act on it |

On one pass, 13 of 23 PRs were `BLOCKED` with the required check **green** — every one a standing
changes-request. Reading `BLOCKED` as a CI problem sends you into thirteen healthy logs.

`CLEAN` means no *required* context is pending or failing — not that anything passed. On an
unprotected branch it can mean nothing ran at all, which is why the script asserts checks by name.

## Bots author most of the comments

Of 87 non-author issue comments across one open set, **86 were `github-actions`**. Filter on
`author.__typename == "Bot"` plus a `[bot]` suffix check, or every PR reads as having feedback. A
bot that posts through a personal token (not an app) will not be caught by either: add its login to
`BOT_LOGINS` in `desk/bin/gate.mjs` if the render keeps counting it as a reviewer (the autopilot
pass reads reviewers through the same list).

## Threads: reply and resolve are GraphQL only

`gh` has no verb for either, and `gh pr comment` posts a top-level comment, not a thread reply.
Bodies go in files so markdown survives the shell. Enumerate PRs from the state file, never a
hand-typed list — a `for n in …` that omitted two numbers once reported "no open threads" on a PR with four.

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
  pullRequest(number:$n){reviewThreads(first:100){totalCount nodes{id isResolved path line
  comments(first:20){nodes{author{login} body}}}}}}}' -F o=<owner> -F r=<name> -F n=<n>

gh api graphql -f query='mutation($tid:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){comment{id}}}' \
  -f tid="$TID" -f body="$(cat reply.md)"
gh api graphql -f query='mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{isResolved}}}' \
  -f tid="$TID"
```

## reviewRequests vs reviews

A **pending** reviewer appears in `reviewRequests`; submitting a review **removes** them. So an
empty `reviewRequests` proves only that nobody is currently owed a review. Hand back to whoever
actually reviewed.

## CI

The required checks are whatever the calls above return (§4 Required checks records them). Learn the
shape of this repo's CI once per pass from the workflow files, not from memory:

- **Is a required check an aggregate gate?** A job whose single step is "every job must have
  succeeded or been skipped", with a long `needs:`. Then a red gate is never the real signal; find
  the upstream job. Note which upstream jobs are in `needs:` and which run but are not (those are
  advisory however they look).
- **Does a check read the §4 Local review command's verdict** at the head SHA? Then any push voids
  it, and a fresh review is part of getting green again.
- **Which job is the long pole?** Read durations from recent runs
  (`gh run list --workflow <file> --json databaseId,createdAt,updatedAt,conclusion --limit 20`).
  That is the floor for the rerun cooldown.

**Check the workflow's `concurrency:` block.** With a per-PR group and `cancel-in-progress: true`,
starting any run for a PR — a rerun, `--failed`, a push — cancels the one in flight, which then
reports `The operation was canceled.` and invites another rerun. That loop is self-sustaining; it
has "cancelled" the long job across four PRs at once. **Any retry needs a per-PR cooldown longer
than the slowest job.**

**Pick a run by head SHA and workflow name**, never list position:

```bash
head=$(gh pr view <n> --json headRefOid --jq .headRefOid)
gh run list --limit 12 --json databaseId,headSha,status,conclusion,workflowName \
  --jq "[.[]|select(.headSha==\"$head\" and .workflowName==\"<workflow name>\")][0]"
```

**`gh run rerun` replays the original merge commit.** When a PR failed on a broken default branch,
fixing it and rerunning retests the broken base. Close and reopen the PR instead:
`refs/pull/N/merge` is recomputed, the head SHA is unchanged, so a local review verdict at that head
stays valid; check auto-merge survived. **But first check the branch's own tree** —
`git show origin/<branch>:<path> | grep <symbol>` — a branch that rebased onto the broken base
carries the break itself, and `git log --merges` shows nothing.

**"No checks reported" at all** may be a wedged merge ref: `git ls-remote origin 'refs/pull/N/*'`
with no `/merge` line means GitHub withholds `pull_request` entirely. Close/reopen and pushes do not
clear it, and a `workflow_dispatch` run skips PR-only jobs. Re-pointing the base or recreating the PR
is the user's call — park it.

### Failures worth a rerun (on the cooldown)

- `The operation was canceled` with no failing task — **after** ruling out your own rerun or push as
  the canceller. Genuinely intermittent too: a run can fail twice at different durations, then pass
  unchanged. Up to ~3 reruns before investigating.
- A known flake of this repo's: a timeout acquiring a database advisory lock during a migration on a
  shared preview database is the common shape where merges deploy (§4 Staging). Anything you rerun
  on that basis, name the signature in the report so it can be checked next time.

### Failures that are not the branch, and not fixed by rerunning

- **`Your deployment failed. Please retry later.`** on every PR at once (only where §4 Vercel is not
  `none`): check whether the Vercel project is `BLOCKED`. `vercel list --scope <§4 Vercel team> 2>&1`
  (the table goes to **stderr**); status `UNKNOWN` with `Duration ?` means no build started; compare
  another project in the same team; the deployment API's `state: BLOCKED` is the proof. If a required
  check depends on the preview, **a blocked project stops every merge in the repo.** Do not retry or
  reconfigure — report to §4 People "Infra and security owner" with that evidence.
- A test job failing in a schema or migration **diff** step before any test runs: the suite **never
  ran** — it is schema/migration drift, not a test failure.

Anything else is a real failure. Read it.

**Reproducing a CI-only test failure:** run §4 Unit tests with `CI=true` (behind the test lock).
Build tools that key a cache on `CI` switch reporters or coverage with it. A green default branch
proves little where CI is mostly cache hits; compare a branch run that actually executed.

**Check whether e2e gates a PR at all** before reading its result as a signal. An e2e workflow
without a `pull_request` trigger, or with `continue-on-error`, never gates a PR. To confirm a change
was exercised by a run that did complete, check ancestry: `git merge-base --is-ancestor <sha> <run-sha>`.

**A GitHub deployment status of `success` can precede the preview build** (Vercel and others). The
preview URL can say it is building for minutes after. Poll the page, and match the failure text in
the same check or a dead build reads as ready.

## Commands

```bash
gh pr update-branch --rebase <n>        # server-side; refuses on .github/workflows/** without `workflow` scope
gh pr merge <n> --<method> --match-head-commit <sha>   # unstacked only; <method> is §4 Merge method, <sha> the head you checked
git merge-tree --write-tree --name-only origin/<base> origin/<branch>   # conflict probe, no worktree
git rev-list --count origin/<branch>..origin/<base>                     # behind-ness
gh pr view <n> --json autoMergeRequest,mergeStateStatus,mergeable       # will going green merge it?
```
