# studia-web facts desk-clearance depends on

Verified against the live ruleset. Re-verify rather than trust if behaviour disagrees.

`bin/clearance-state.mjs` encodes most of this. Read here to understand *why* it does what it does,
not to reimplement it by hand.

## main is guarded by a RULESET, not branch protection

`gh api .../branches/main/protection` returns **404, and that 404 means nothing.** Read instead:

```bash
gh api repos/Sophos-Education/studia-web/rules/branches/main --jq '.[].type'
gh api repos/Sophos-Education/studia-web/rules/branches/main \
  --jq '.[]|select(.type=="required_status_checks").parameters.required_status_checks[].context'
```

Ruleset "Protect Main branch" (id 15067985):

| Setting | Value | Consequence |
|---|---|---|
| `allowed_merge_methods` | `["squash"]` | **Squash is the only method.** Merge commits and rebase-merges are rejected |
| `required_status_checks` | `🏁 CI gate` only | The single gate. Its `needs:` includes `🏷️ PR title` and `🌿 Local Adversarial Code Review`, so a bad title or a missing verdict marker turns it red |
| `strict_required_status_checks_policy` | `false` | Being behind main never blocks a merge |
| `required_approving_review_count` | `0` | No *positive* approval is enforced |
| a standing `CHANGES_REQUESTED` | — | **Blocks the merge outright.** See below |
| `dismiss_stale_reviews_on_push` | `false` | An approval survives any later push |
| `required_review_thread_resolution` | `false` | Unresolved threads never block |
| `deletion`, `non_fast_forward` | on | No deleting or force-pushing `main` |

**Read the required context from the API, never from a name you remember or a `ci.yml` comment.**
Check names change: when the ruleset is changed ahead of the workflow, every open PR reads
`MERGEABLE`, rollup `SUCCESS`, every check green — and `BLOCKED`, "Expected — waiting for status to be reported". The tell is a required context that
appears on **no** commit:

```bash
gh api "repos/Sophos-Education/studia-web/commits/<head>/check-runs?per_page=100" --jq '[.check_runs[].name]'
```

Fixing that deadlock needs repo admin — config §4's "Vercel, infra and security owner; repo admin".

**"0 approvals required" does not mean anything merges.** With a `CHANGES_REQUESTED` standing,
`gh pr merge` fails with `Repository rule violations found — 1 review requesting changes by
reviewers with write access`, and `mergeStateStatus` reads `BLOCKED` while `mergeable` says
`MERGEABLE`. Resolving threads does not clear it; only the reviewer
approving or dismissing does.

**So "approved", "threads resolved" and "up to date" are conventions, not gates.** Which of them
clearance enforces is config §3 `pr-merge-green` and `merge-feedback-first` — see the merge bar in SKILL.md.

**Any base branch other than `main` has no rules at all** — no required check, no squash-only.

## Merge paths

| PR | Command |
|---|---|
| Unstacked | `gh pr merge <n> --squash`, or `gh pr merge <n> --squash --auto` to land on green |
| Stacked (`gh api repos/Sophos-Education/studia-web/pulls/<n> --jq .stack` is non-null) | `gh api -X PUT repos/Sophos-Education/studia-web/pulls/<n>/merge-async -f merge_method=squash` |

Stacked PRs refuse `gh pr merge` ("must be merged using the asynchronous merge REST API"), `--auto`
("not supported for stacked pull requests") and `PUT /merge` (403). `merge-async` returns
`{"status":"pending"}` — **enqueued is not merged**; poll `gh api .../pulls/<n> --jq .merged`. A stack
association **survives its parent being closed**, so "is it stacked?" is the `stack` field, not
`baseRefName`. Stack listing: `gh api repos/Sophos-Education/studia-web/stacks`.

`delete_branch_on_merge` is on: re-raising a reverted PR needs the branch pushed back first.

## `🏷️ PR title` gates the title, and a retitle does not clear it

The job requires `type(scope): SV-123 description` — an uppercase key immediately after the colon,
waived only by the `no-jira` label. It runs on `pull_request` with the **default** event types, and
`edited` is not among them. Renaming does not re-trigger it, and rerunning replays the old payload.
**The fix is a push** (a branch update counts) — or close/reopen, which fires `reopened`.

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
gh api --paginate repos/Sophos-Education/studia-web/pulls/<n>/reviews \
  --jq '.[]|"\(.user.login) \(.state) \(.submitted_at)"'
```

Review bodies often carry items that could not attach to a line because the file is not in the diff.

## mergeStateStatus vocabulary

| Value | Means | Action |
|---|---|---|
| `CLEAN` | mergeable, required checks green | apply the bar, then merge |
| `BLOCKED` | a requirement unmet — **usually a standing changes-request**, sometimes a pending gate or a required context that never reports | read the gate and the verdict separately |
| `UNSTABLE` | mergeable; a **non-required** check is pending or failing | if the gate passed, this is mergeable |
| `DIRTY` | conflict **with the base** — on a stacked PR that is not `main` | probe, propose, ask |
| `UNKNOWN` | recomputing after main moved | wait ~1 min, re-read; never act on it |

On one pass, 13 of 23 PRs were `BLOCKED` with the gate **green** — every one a standing
changes-request. Reading `BLOCKED` as a CI problem sends you into thirteen healthy logs.

`CLEAN` means no *required* context is pending or failing — not that anything passed.

## Bots author most of the comments

Of 87 non-author issue comments across one open set, **86 were `github-actions`**. Filter on
`author.__typename == "Bot"` plus a `[bot]` suffix check, or every PR reads as having feedback.

## Threads: reply and resolve are GraphQL only

`gh` has no verb for either, and `gh pr comment` posts a top-level comment, not a thread reply.
Bodies go in files so markdown survives the shell. Enumerate PRs from the state file, never a
hand-typed list — a `for n in …` that omitted two numbers once reported "no open threads" on a PR with four.

```bash
gh api graphql -f query='query($n:Int!){repository(owner:"Sophos-Education",name:"studia-web"){
  pullRequest(number:$n){reviewThreads(first:100){totalCount nodes{id isResolved path line
  comments(first:20){nodes{author{login} body}}}}}}}' -F n=<n>

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

Required: **`🏁 CI gate`** only — a gate job whose single step is "every job must have succeeded or
been skipped". A red gate is never the real signal; find the upstream job. Its `needs:`:
`pr-title, verify, portal-verify, portal-paths-guard, portal-deploy-dryrun, secrets, integration,
sca, sast, pullbot-gate, preview, preview-build` (`pullbot-gate` displays as `🌿 Local Adversarial Code Review`). `🌿 PullBot (advisory)` is not in it.

Typical timings: `verify` (lint, typecheck, unit tests, build, Storybook) 8-25 min, the long pole;
`🧪 Integration tests` ~5-6 min; portal jobs only when `apps/portal/**` is touched.

**`concurrency: ci-<PR number>`, `cancel-in-progress: true`.** Starting any run for a PR — a rerun,
`--failed`, a push — cancels the one in flight, which then reports `The operation was canceled.`
and invites another rerun. That loop is self-sustaining; it can "cancel" verify across four PRs at
once. **Any retry needs a per-PR cooldown longer than the slowest job: 20 minutes.**

**Pick a run by head SHA**, never list position:

```bash
head=$(gh pr view <n> --json headRefOid --jq .headRefOid)
gh run list --limit 12 --json databaseId,headSha,status,conclusion,workflowName \
  --jq "[.[]|select(.headSha==\"$head\" and .workflowName==\"CI\")][0]"
```

**`gh run rerun` replays the original merge commit.** When a PR failed on a broken `main`, fixing main
and rerunning retests the broken base. Close and
reopen the PR instead: `refs/pull/N/merge` is recomputed, the head SHA is unchanged, so a pullbot
verdict stays valid; check auto-merge survived. **But first check the branch's own tree** —
`git show origin/<branch>:<path> | grep <symbol>` — a branch that rebased onto the broken main carries
the break itself, and `git log --merges` shows nothing.

**"No checks reported" at all** may be a wedged merge ref: `git ls-remote origin 'refs/pull/N/*'`
with no `/merge` line means GitHub withholds `pull_request` entirely. Close/reopen and pushes do not
clear it, and a `workflow_dispatch` run skips PR-only jobs and audits the whole tree
for SCA. Re-pointing the base or recreating the PR is the user's call — park it.

### Failures worth a rerun (on the cooldown)

- `The operation was canceled` with no failing task — **after** ruling out your own rerun or push as
  the canceller. Genuinely intermittent too: a run can fail twice at different durations, then pass
  unchanged. Up to ~3 reruns before investigating.
- `P1002` in `db:migrate` on the Vercel build — a leaked Prisma advisory lock on the pooled staging DB.

### Failures that are not the branch, and not fixed by rerunning

- **`Your deployment failed. Please retry later.`** on every PR at once: check whether the Vercel
  project is `BLOCKED`. `vercel list --scope <Studia team> 2>&1` (the table goes to **stderr**); status
  `UNKNOWN` with `Duration ?` means no build started; compare `studia-storybook` in the same team; the
  deployment API's `state: BLOCKED` is the proof. The gate needs `preview`, so **a
  blocked project stops every merge in the repo.** Do not retry or reconfigure — report to the Vercel,
  infra and security owner (config §4) with that evidence.
- A `🧪 Integration tests` failure in the `prisma migrate diff` step means the suite **never ran** —
  it is schema/migration drift, not a test failure.

Anything else is a real failure. Read it.

**Reproducing a CI-only Jest failure:** `CI=true bun run --filter studia-web test` — `turbo.json`
keys `test` on `CI`, which switches on coverage and the JUnit reporter. A green `main` proves little:
its runs are mostly Turborepo cache hits. Compare a branch run showing `cache miss, executing`.

**e2e never gates a PR.** `.github/workflows/e2e.yml` has no `pull_request` trigger, is
`continue-on-error`, and cancels in progress on rapid merges. To confirm a change was exercised,
check ancestry against a run that *completed*: `git merge-base --is-ancestor <sha> <run-sha>`.

**A GitHub deployment status of `success` precedes the Vercel build.** The preview URL can say
`Deployment is building` for minutes after. Poll the page, and match `Deployment has failed` in the
same check or a dead build reads as ready.

## Commands

```bash
gh pr update-branch --rebase <n>        # server-side; refuses on .github/workflows/** without `workflow` scope
gh pr merge <n> --squash                # unstacked only
git merge-tree --write-tree --name-only origin/main origin/<branch>   # conflict probe, no worktree
git rev-list --count origin/<branch>..origin/main                     # behind-ness
gh pr view <n> --json autoMergeRequest,mergeStateStatus,mergeable     # will going green merge it?
```
