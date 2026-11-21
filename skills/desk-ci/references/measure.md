# desk-ci: measure and batch-red

Read before running `measure`, or `batch-red` against its baseline, and no other step's file with
it. The overview, the placement rule and the red flags every command shares are in `../SKILL.md`,
already loaded.

## measure

A move to self-hosted runners starts from the repo's own numbers. `measure` reads a window of the repo's
Actions runs, their jobs (every attempt, re-runs included) and its pull requests over the GitHub
API, and reports:

Every figure counts **completed** runs created in the window; a run still in progress is left out.
Each one rests on two definitions:

- **Red is what GitHub shows.** An attempt of a run is red only when GitHub shows it failed. The
  latest attempt takes the run's own conclusion (`failure`, `timed_out` or `startup_failure`),
  whichever job failed and whether or not the run tests a PR. A `continue-on-error` job that fails
  leaves that conclusion `success`, so it never makes a run red. The default branch's required
  checks are not read: today's ruleset is never applied to older runs, so a run that failed on a job
  no ruleset requires now is still red. GitHub keeps no conclusion for an earlier attempt of a
  re-run, so that attempt is red when any job in it failed, except a job that has failed in an
  attempt GitHub concluded `success` in the same workflow: that is the mark of `continue-on-error`.
- **An attempt passes** when it is not red and GitHub shows it succeeded: a conclusion of `success`,
  `skipped` or `neutral`. A cancelled or approval-waiting attempt neither passes nor is red. A PR's **head** (one commit) turns green at the first moment every run
  on it has an attempt that passed and at least one of them actually ran.

| Figure | Exact definition |
|---|---|
| billed minutes, per workflow and per job | each job's `completed_at − started_at`, rounded up to the whole minute as GitHub bills (a job that never started bills 0), at most 360 (a GitHub-hosted job stops at 6 h, so a longer span is a stuck job's record; each one capped is listed under *Capped jobs*), times the runner OS multiplier (macOS ×10, Windows ×2, Linux ×1), summed over every attempt. Runs whose jobs were not read are scaled in per stratum (below) and marked `(est.)` |
| self-hosted minutes | the same rounding with no multiplier and no cap, for jobs on a `self-hosted` label or a runner group other than GitHub Actions; not billed |
| failure rate | per workflow: red attempts ÷ decided attempts. A latest attempt is decided when its run concluded `success` or a failure; an earlier attempt when it is red or a job in it succeeded. Re-runs count each attempt; a cancelled or approval-waiting attempt is in neither count |
| first failing job | per workflow, over red attempts whose jobs were read: of the failed jobs that count (above), the one that finished first. A job marked `continue-on-error` that way is named only when the run's conclusion is red and no other failed job counts; `(no job ran)` for a red attempt with no failed job, such as a `startup_failure` |
| PRs with CI | PRs with at least one completed run in the window. A run belongs to the PR GitHub names on it, or else to the PR whose head branch (and fork) it ran on while that PR was open |
| CI red rate per PR | PRs with at least one red attempt ÷ PRs with CI |
| red-to-fix round trips | per PR, in push order: one starts at the first red attempt's completion and ends at the next head to turn green whose green time is at or after it, whether by a re-run or a new push. Its **cost** is the CI minutes of every attempt the PR started within it, and its **wait** is end minus start; both are reported as the median over all trips. A PR whose last red is never followed by green is counted as left red |
| PR time to green | per PR: from the start of the PR's first CI attempt to the moment its first head turned green (above). Red-to-fix round trips before that are inside it. PRs with no green head have none. Median and p90 over PRs |
| queue time | per job that was not skipped: `started_at − created_at`, hosted and self-hosted apart; median and p90 over jobs read |
| minutes per merged PR, by month | the month's billed plus self-hosted minutes (by run creation date) ÷ the PRs merged that month (by `merged_at`) |

Medians and p90s interpolate between closest ranks, so the median of an even count is the mean of
the middle two.

```bash
node ~/.claude/desk/bin/desk-ci.mjs measure [--repo owner/name] [--days 90] [--budget 600] [--out <dir>]
```

`--repo` defaults to `origin`. **The call budget is a ceiling, never a target.** The run uses the
smaller of `--budget` and what the rate limit has left above a reserve (a tenth of the limit, at
least 100), re-reads the limit every 100 calls because other sessions spend it too, and refuses to
start when the limit is already under the reserve. The run and PR lists take at most half and a
further 15% of the calls; what remains reads jobs. When that cannot cover every run, it samples per
stratum: a workflow's red or re-run runs, and its others, in one calendar month by run creation
date. A workflow is its file (the run's `workflow_id`, else its `path` less any `@ref`), so Dependabot's runs, each named after its update,
are one workflow; the report names a workflow by its runs' name when they share one, else by its
file. It reads first every run that did not pass and lasted (run start to last update) past the 6 h
hosted cap, since only such a run can hold a stuck job; then at least one run of every stratum; then
every red or re-run run. The rest go to the other strata: each first gets 3 reads (or all its runs,
if fewer), then each further read goes where it most narrows its month's minutes, in proportion to
the stratum's runs times the spread of their lengths over its month's total length (Neyman
allocation, per month). Within a stratum, the reads are spread evenly over its runs ordered by
length. It scales minutes back up per stratum, each read run standing for its stratum's unread ones,
so each month's minutes, and its minutes per merged PR, come from that month's own runs; it marks
those figures `(est.)`. A run read with a capped job stands for itself alone, so its 360 minutes are
never multiplied by its stratum's weight. A stratum with no run read carries
no minutes and the header counts its runs. An unread run is red or green by its own conclusion alone. The report's header states the calls made, the allowance, whether
it sampled, and any narrowing of the window. Repeat with a larger `--budget` (or after the limit
resets) rather than trusting a sampled figure close to a decision.

It writes the report and its figures as JSON to the main checkout's `.handoffs/`
(`<date>-ci-measure-<owner>__<name>.md` and `.json`; `--out` picks another directory) and nothing
else: it calls only read endpoints and changes nothing in any repo.

1. Run it and print the report.
2. Offer to attach it to a ticket. Only on the user's yes, and after showing the exact files and the
   target key, `desk-jira attach <KEY> <the .md file>`, under the repo's Jira grants.

### batch-red: a batch against the baseline

`measure`'s saved JSON is the baseline an autopilot batch is held to. `batch-red` reads a set of PRs
(by default every finished ticket's PR in the autopilot queue), the runs on each PR's head branch, and
jobs only for re-run runs, then counts red PRs by the same definitions as the *CI red rate per PR*
row above, so the two rates compare:

```bash
node ~/.claude/desk/bin/desk-ci.mjs batch-red [--prs 12,13 | --queue <queue.json>] [--baseline <measure json>] [--repo owner/name]
```

It prints `batch:` (the red PRs named), `baseline:` (the newest `<date>-ci-measure-<owner>__<name>.json`
in the main checkout's `.handoffs/`, unless `--baseline` names one), the change in percentage points,
and a `summary:` line. A rise of more than 5 points prints `RED RATE ROSE` and exits 1. It reads
only, and spends one call per PR, one per page of its runs and one per page of a re-run's jobs.
