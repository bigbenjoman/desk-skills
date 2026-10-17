---
name: desk-ci
description: >-
  Use when deciding which of a repo's GitHub Actions jobs can run on the self-hosted runner and
  which must stay on GitHub-hosted runners ("which jobs can go self-hosted?", "/desk-ci classify"),
  or when checking that no workflow hands a secret to a self-hosted job ("lint the workflows",
  "/desk-ci ci-lint"). Places every job by a written rule and cites the workflow line that decided
  it, as a proposal. Never edits a workflow. Also when asking what a repo's CI costs or how often it
  holds PRs up ("how many CI minutes do we use?", "/desk-ci measure"): reads its Actions history
  within a stated API call budget and saves the figures.
argument-hint: "classify | ci-lint [<workflow file or directory>...] | measure [--repo owner/name] [--days 90] [--budget 600]"
---

# desk-ci

## Overview

Moving a repo's CI onto the self-hosted runner (the `desk-runner` VM: arm64 Linux on this machine)
starts from a reviewed proposal, not an edit. `classify` places each job hosted or self-hosted by
the rule below and cites the line that decided it; `ci-lint` refuses a workflow that would hand a
secret to a job that can land on the self-hosted runner.

**Core principle: show the proposal, change nothing.** This skill reads workflows and CI history,
and prints; its only write is `measure`'s report under `.handoffs/`. It never edits `.github/`, opens a PR, or changes runner settings, in this repo or any other. Writing
the workflow changes a proposal implies is separate work, done only after the user has read the
proposal and said which placements to take.

Both commands are read-only and take workflow files or directories (default `.github/workflows`,
run from the repo root):

```bash
node ~/.claude/desk/bin/desk-ci.mjs classify [<file or dir>...]
node ~/.claude/desk/bin/desk-ci.mjs ci-lint  [<file or dir>...]   # exit 1 on any finding
```

## The placement rule

A job is placed **hosted** if any of these holds, and **self-hosted** otherwise:

| Trigger | What fires it |
|---|---|
| a secret other than `GITHUB_TOKEN` | any `secrets.<NAME>`, `secrets[…]`, `toJSON(secrets)` or `secrets: inherit` in the job, **including the workflow-level `env:` every job inherits**, and a `${{ }}` inside a `run:` body even on a shell comment line (GitHub expands it anyway) |
| an environment | an `environment:` key on the job |
| `id-token` | `id-token: write` or `write-all` in the job's `permissions:`, or in the workflow's when the job sets none |
| a staging or preview URL | an `http(s)` URL naming staging or preview, a `*.vercel.app` host, a `*STAGING*`/`*PREVIEW*` URL variable, a deployment-status target URL |
| a third-party service | a step using a service action (Codecov, Vercel, Slack, Sentry, cloud logins, …), a service CLI (`vercel`, `aws`, `gcloud`, `wrangler`, …), or `curl`/`wget` to a host other than GitHub or localhost |
| an image with no arm64 build | a `container:` or `services:` image known amd64-only (`postgis/postgis`, `mcr.microsoft.com/mssql/server`), or a container pinned to `linux/amd64` |
| production x64 build parity | a job named or id'd for Vercel parity or a production build, or one that runs `vercel build` |
| what cannot be read here | a YAML alias (`*name`) in the job or the workflow-level `env:`/`permissions:`, which can carry any of the above in from elsewhere; a call to a reusable workflow outside this repo |

`classify` prints one line per job:

```
<file>:<line>  <job>  hosted       <the first trigger>  (also <trigger> :<line>, …)
<file>:<line>  <job>  self-hosted  no hosted trigger (runs-on today: <value>)
summary: jobs=<n> hosted=<n> self-hosted=<n>
```

The line is the one that decided it: the trigger's line for hosted, the job's own line for
self-hosted. A call to a local reusable workflow (`uses: ./…`) that passes no secrets is placed
self-hosted at its `uses:` line; the jobs it runs are placed in that workflow's own file.

**An image the list does not know is not proof of arm64.** Where a self-hosted placement runs a
`container:` or `services:` image, say so in the proposal and check it (`docker manifest inspect
<image>` lists its platforms) before anyone moves the job.

## ci-lint

For every job whose `runs-on` **can resolve** to the self-hosted runner, `ci-lint` fails when:

- it would receive a secret other than `GITHUB_TOKEN` (job or inherited workflow-level env), an
  environment, or `id-token`, or a YAML alias that could carry one in;
- its `runs-on` lacks the Dependabot-to-hosted branch, the `github.actor == 'dependabot[bot]'`
  expression that sends Dependabot's runs to a hosted runner, e.g.
  `runs-on: ${{ github.actor == 'dependabot[bot]' && 'ubuntu-latest' || 'self-hosted' }}`, or has
  one that picks anything but a GitHub-hosted label (the `!=` form,
  `github.actor != 'dependabot[bot]' && 'self-hosted' || 'ubuntu-latest'`, is read too).

"Can resolve" means any value other than a GitHub-hosted image label (`ubuntu-*`, `macos-*`,
`windows-*`): `self-hosted` or any custom label, a runner `group:`, a matrix entry holding one, or a
value read from `vars`, `inputs`, `env` or `needs` that the file does not fix. Each finding names the
job and the line:

```
<file>:<line>  <job>  can run self-hosted but receives secret DEPLOY_KEY
summary: findings=<n>
```

## Running it

1. `classify` over the repo's workflows. Print its output, then the proposal: one table of jobs to
   move self-hosted, one of jobs that stay hosted with the trigger and line for each, and any image
   that needs its arm64 build checked.
2. `ci-lint` over the same files, and report each finding.
3. Stop. The user decides which placements to take; nothing in the repo has changed.

## measure

A move to the runner starts from the repo's own numbers. `measure` reads a window of the repo's
Actions runs, their jobs (every attempt, re-runs included) and its pull requests over the GitHub
API, and reports:

Every figure counts **completed** runs created in the window; a run still in progress is left out.
Each one rests on two definitions:

- **Red is what GitHub shows.** An attempt of a run is red only when GitHub shows it failed, and
  only for a check that blocks the merge. The latest attempt takes the run's own conclusion
  (`failure`, `timed_out` or `startup_failure`). A `continue-on-error` job that fails leaves that
  conclusion `success`, so it never makes a run red. Where the default branch requires checks (its
  rulesets, plus its branch protection where that is readable), a failed run is red only if a
  failed job is one of those required checks. A required check that no Actions job carries (another
  app's status) is ignored, and with no such checks the conclusion alone decides. GitHub keeps no
  conclusion for an earlier attempt of a re-run, so that attempt is red when a job failed that is a
  required check (any job, where none are set). A job does not count if it has failed in an attempt
  GitHub concluded `success` in the same workflow: that is the mark of `continue-on-error`.
- **An attempt passes** when it is not red and GitHub shows it succeeded: a conclusion of `success`,
  `skipped` or `neutral`, or a failure in no required check. A cancelled or approval-waiting attempt
  neither passes nor is red. A PR's **head** (one commit) turns green at the first moment every run
  on it has an attempt that passed and at least one of them actually ran.

| Figure | Exact definition |
|---|---|
| billed minutes, per workflow and per job | each job's `completed_at − started_at`, rounded up to the whole minute as GitHub bills (a job that never started bills 0), times the runner OS multiplier (macOS ×10, Windows ×2, Linux ×1), summed over every attempt. Runs whose jobs were not read are scaled in per stratum (below) and marked `(est.)` |
| self-hosted minutes | the same rounding with no multiplier, for jobs on a `self-hosted` label or a runner group other than GitHub Actions; not billed |
| failure rate | per workflow: red attempts ÷ decided attempts. A latest attempt is decided when its run concluded `success` or a failure (red or not, by the rule above); an earlier attempt when it is red or a job in it succeeded. Re-runs count each attempt; a cancelled or approval-waiting attempt is in neither count |
| first failing job | per workflow, over red attempts whose jobs were read: the job that made the attempt red (above) and finished first; `(no job ran)` for a red attempt with no failed job, such as a `startup_failure` |
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
further 15% of the calls, after up to three that read the default branch's required checks; what
remains reads jobs. When that cannot cover every run, it reads every red or re-run run's jobs first
and an even spread of the rest. It then scales minutes back up per stratum (a workflow's red or
re-run runs, and its others), each read run standing for the stratum's unread ones, and marks those
figures `(est.)`. An unread run is red or green by its own conclusion alone. The report's header states the calls made, the allowance, whether
it sampled, and any narrowing of the window. Repeat with a larger `--budget` (or after the limit
resets) rather than trusting a sampled figure close to a decision.

It writes the report and its figures as JSON to the main checkout's `.handoffs/`
(`<date>-ci-measure-<owner>__<name>.md` and `.json`; `--out` picks another directory) and nothing
else: it calls only read endpoints and changes nothing in any repo.

1. Run it and print the report.
2. Offer to attach it to a ticket. Only on the user's yes, and after showing the exact files and the
   target key, `desk-jira attach <KEY> <the .md file>`, under the repo's Jira grants.

## Red flags — stop

- About to edit a workflow, `runs-on`, or a runner setting from this skill
- Calling a self-hosted placement final for a job running an image nobody has checked for arm64
- Moving a job self-hosted because "the secret is only used in one step": the whole job's runner
  receives it
- Treating a clean `ci-lint` as a placement: it checks secret safety, not where a job should run
- Quoting a `measure` figure without its `(est.)` mark, or without the window it covers
- Running `measure` again and again to fill a gap: each run spends the shared rate limit
