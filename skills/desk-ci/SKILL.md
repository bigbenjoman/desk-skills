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

| Figure | How it is counted |
|---|---|
| billed minutes, per workflow and per job | each job rounded up to the whole minute, as GitHub bills; macOS ×10, Windows ×2 |
| self-hosted minutes | the same rounding, for jobs on a `self-hosted` label or a runner group other than GitHub Actions; not billed |
| failure rate and first failing job | per workflow, over attempts; the first failing job is the red job that finished first |
| CI red rate per PR | PRs whose CI went red at least once, of PRs with CI in the window |
| red-to-fix round trips | from a red attempt to the next green head, by re-run or new push; median CI minutes spent and median wait |
| PR time to green | first CI run on the PR to its first head with every run green; median and p90 |
| queue time | job created to job started, hosted and self-hosted apart; median and p90 |
| minutes per merged PR, by month | the month's billed plus self-hosted minutes over the PRs merged that month |

```bash
node ~/.claude/desk/bin/desk-ci.mjs measure [--repo owner/name] [--days 90] [--budget 600] [--out <dir>]
```

`--repo` defaults to `origin`. **The call budget is a ceiling, never a target.** The run uses the
smaller of `--budget` and what the rate limit has left above a reserve (a tenth of the limit, at
least 100), re-reads the limit every 100 calls because other sessions spend it too, and refuses to
start when the limit is already under the reserve. The run and PR lists take at most half and a
further 15% of the calls; what remains reads jobs. When that cannot cover every run, it reads every
red or re-run run's jobs first and an even spread of the rest, scales minutes back up per workflow,
and marks those figures `(est.)`. The report's header states the calls made, the allowance, whether
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
