---
name: desk-ci
description: >-
  Use when deciding which of a repo's GitHub Actions jobs can run on its self-hosted runners and
  which must stay on GitHub-hosted runners ("which jobs can go self-hosted?", "/desk-ci classify"),
  or when checking that no workflow hands a secret to a self-hosted job ("lint the workflows",
  "/desk-ci ci-lint"). Places every job by a written rule and cites the workflow line that decided
  it, as a proposal. Never edits a workflow. Also when asking what a repo's CI costs or how often it
  holds PRs up ("how many CI minutes do we use?", "/desk-ci measure"): reads its Actions history
  within a stated API call budget and saves the figures. Also before any CI change, to save a repo's
  branch protection and rulesets and restore them, to pin required checks to the GitHub Actions app,
  or to make the default workflow token read-only ("/desk-ci protection snapshot|restore|pin|token").
  Also when asking which jobs a batch's child PRs into a batch base could skip ("/desk-ci profile"):
  proposes a light profile for those PRs and a full one for the rest, with an estimated saving.
argument-hint: "classify | ci-lint | profile [<workflow file or directory>...] | measure [--repo owner/name] [--days 90] [--budget 600] | batch-red [--prs a,b] | protection snapshot|restore <file>|pin|token"
---

# desk-ci

## Overview

CI runs on GitHub-hosted runners or on a repo's own cloud runners (self-hosted, arm64 Linux); desk
runs no CI on this computer. Moving a repo's CI onto its self-hosted runners starts from a reviewed
proposal, not an edit. `classify` places each job hosted or self-hosted by the rule below and cites
the line that decided it; `ci-lint` refuses a workflow that would hand a secret to a job that can
land on a self-hosted runner.

**Core principle: show the proposal, change nothing.** This skill reads workflows and CI history,
and prints; its only writes are `measure`'s report and `protection snapshot`'s file under
`.handoffs/`, and the protection writes below, each shown first and gated on config §3
`ci-protection`. It never edits `.github/`, opens a PR, or changes runner settings, in this repo or any other. Writing
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

For every job whose `runs-on` **can resolve** to a self-hosted runner, `ci-lint` fails when:

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

## profile: light CI on PRs into a batch base

A batch's child PRs merge into its batch base, and the promotion PR into the default branch runs
every job again, so a child PR needs only the jobs that need no database, preview or browser.
`profile` proposes that split and writes nothing:

```bash
node ~/.claude/desk/bin/desk-ci.mjs profile [<file or dir>...] [--required <check>]... [--measure <measure json>] [--batch-prs <n>] [--default <branch>] [--repo owner/name]
```

A job is **full** if any of these holds, and **light** otherwise:

| Needs | What fires it |
|---|---|
| a database | a `services:` or `container:` image of Postgres, PostGIS, MySQL, MariaDB, MongoDB, Redis, Valkey, SQL Server, CockroachDB or ClickHouse; a database setup action; `psql`, `pg_isready`, `mysqladmin`, `mongosh`, `redis-cli`, `prisma migrate`/`db push`, `supabase start`/`db`, `manage.py migrate` or `rails db:`; a `*DATABASE_URL`, `PGHOST`, `PGDATABASE` or `PGURL` variable |
| a preview | a staging or preview URL (as in the placement rule, workflow-level `env:` included), or a `vercel` or `netlify` action or CLI |
| a browser | Playwright, Cypress, Puppeteer, Selenium, WebdriverIO, TestCafe, a browser driver or a browser setup action |
| a full job | a `needs:` naming a full job, which would be skipped with it |
| what cannot be read here | a call to a reusable workflow outside this repo |

It prints one line per job, the line being the one that decided it (the job's own line for light):

```
<file>:<line>  <job>  full   <the first reason>  (also <kind> :<line>, …)
<file>:<line>  <job>  light  no database, preview or browser
```

Then the plan. Every full job in a workflow that runs on pull requests gets
`if: ${{ !github.base_ref || github.base_ref == '<default>' }}`, or its existing `if:` combined with
that condition, so a PR into the default branch, a push, a schedule or a manual run still runs every
job, and a PR into any other branch (a batch base) runs the light ones only. A block-scalar `if:` is
replaced together with the lines under it. A reusable workflow (`workflow_call`) runs on its
callers' PRs and sees their `github` context, so its full jobs are gated the same way, and its
minutes are read from the caller's `caller / job` rows. Any other workflow that does not run on pull
requests needs no change. A `pull_request` trigger limited to literal branches is named,
since light jobs will not run on PRs into a batch base it does not list.

- **A required check only a full job reports** prints `REQUIRED CHECK ONLY IN FULL`: it would be
  skipped on every light PR, and green counts a skipped required check as passing, as branch
  protection does (`desk/bin/gate.mjs`), so those PRs would merge without it running. The checks are config §4 Required checks,
  or each `--required <check>`. A check is a job's when it is its name (`name:`, else its id), one of
  its matrix legs `name (…)`, or `caller / job` for a reusable workflow. A full job whose name is
  all expression (`name: ${{ matrix.suite }}`) cannot be matched, so a required check that matches
  no job prints `REQUIRED CHECK MAY BE ONLY IN FULL` against it.
- **The saving** comes from the newest `measure` report for the repo in the main checkout's
  `.handoffs/` (or `--measure`): the full jobs' minutes in its window ÷ its PRs with CI, per PR, times
  the child PRs per batch (`--batch-prs`, else the autopilot queue's ticket count). It is an estimate
  and says so: every run of those jobs counts, pushes and schedules too, so it reads high. A full job
  the report has no minutes for is named. With no report it prints the plan without a saving and says
  to run `measure`.

`--default` defaults to config §0 Default branch, never a batch base. Never apply the plan from this
skill: the workflow change is separate work, done after the user has read it.

## protection

Moving checks to a self-hosted runner changes what can satisfy a required check, so protection is
saved before anything changes and every required check is bound to the app that should run it.

```bash
node ~/.claude/desk/bin/desk-ci.mjs protection snapshot --ticket <KEY | none> [--repo owner/name] [--branches main,production]
node ~/.claude/desk/bin/desk-ci.mjs protection restore <snapshot file> [--apply <plan id>]
node ~/.claude/desk/bin/desk-ci.mjs protection pin   [--branches main,production] [--apply <plan id>]
node ~/.claude/desk/bin/desk-ci.mjs protection token [--apply <plan id>]
```

Branches default to the default branch and `production` (one that does not exist is recorded as
such). Reading protection needs admin rights on the repo: an unreadable protection is an error,
never recorded as "off", because restoring "off" deletes it. `restore`, `pin` and `token` run from a
checkout of the repo they change (a `--repo` naming another is refused): its committed files and
its config §3 are what decide. `pin` and `token` fetch `origin/<default>` and refuse if it is not
the head GitHub reports.

- **snapshot** saves classic branch protection, the effective rules on each branch, and the repo's
  own rulesets in full, with every required check and the app it accepts (`any app`, or an app id
  and slug), as `<UTC time>-ci-protection-<owner>__<name>.json` in the main checkout's `.handoffs/`
  (`--out` picks another directory). It never overwrites a file. `--ticket` is required: the repo's
  cut-over ticket, which it attaches the file to with `desk-jira attach` under the Jira grants, or
  `none` to save only. A failed attach says so, prints the command to retry and exits 1. An
  organisation's rulesets show in the effective rules but are not the repo's to restore.
- **restore** puts the snapshot back: classic protection (`PUT`, or `DELETE` where the snapshot had
  none), required signatures, and each ruleset (`PUT` by id, else by name; `POST` if gone; `DELETE`
  for one the snapshot lacks). It then reads everything back and compares it with the file:
  `restored: read back, … matches` or each difference, exit 1.
- **pin** reads the GitHub Actions app id from a real check run on the repo (the default branch's
  head, else the latest completed Actions run's commit) and binds each required check that any app
  may satisfy, and that an Actions check run carries, to that app, in classic protection (`app_id`)
  and in the repo's rulesets (`integration_id`), so a status of the same name posted with a personal
  token no longer satisfies it. Nothing else is repointed: a check no Actions run carries is
  reported `left` (pinning it would block every merge), and one already bound to another app
  `another app` (repointing it would let a PR's own workflow satisfy it). It reads back, and reports
  `pinned:` only when every required check accepts only GitHub Actions; anything left, bound to
  another app, or undone by a committed file (below) reports `not pinned` and exits 1.
- **A repo that rewrites its own protection from a committed file** (a workflow, a file under
  `.github/`, a JSON file or a script a workflow names, read at `origin/<default>`) undoes the pin on
  its next run. A writer is a JSON file carrying `required_status_checks`, a protection or rulesets
  REST path with a method or body flag beside it (`gh api`, `curl -d`, a `${{ }}` expression in the
  path included), or an Octokit write such as `updateBranchProtection` in `actions/github-script`.
  `pin` names each such file, its line and the change it needs (`"app_id": <id>` on each check,
  `"checks"` not `"contexts"`; `integration_id` in a ruleset), and reports `not pinned` until the
  file carries it. The fix is a PR to that file, which this skill does not write.
- **token** lists every workflow at `origin/<default>` with no top-level `permissions:` block, and
  sets the default workflow token to read-only only once there are none (it keeps the "approve pull
  requests" setting as it is).

**Every write is a plan first.** Without `--apply` each command prints its plan, the exact method,
path and JSON body of every write, with a plan id, and changes nothing. `--apply <id>` re-reads live
state, recomputes the plan and applies it only if the id still matches, so what runs is what was
shown. `pin` and `token` refuse `--apply` until a snapshot of the repo exists. Config §3
`ci-protection` (unset reads as `ask`) gates it:

| `ci-protection` | What you do |
|---|---|
| `ask` (default) | print the plan, ask, and apply only on the user's yes, with that plan's id |
| `yes` | print the plan, then apply it with its id |
| `no` | print the plan; `--apply` is refused |

A write that fails stops the run and says how many applied before it: restore from the snapshot.

1. `snapshot` first, every time, with the cut-over ticket, and print where it was saved.
2. `pin` or `token`: print the plan and what it leaves, gate it, apply, print the read-back.
3. To undo: `restore <file>`, gated the same way.

## Red flags — stop

- About to edit a workflow, `runs-on`, or a runner setting from this skill, `profile`'s `if:` included
- Calling a self-hosted placement final for a job running an image nobody has checked for arm64
- Moving a job self-hosted because "the secret is only used in one step": the whole job's runner
  receives it
- Treating a clean `ci-lint` as a placement: it checks secret safety, not where a job should run
- Quoting a `measure` figure without its `(est.)` mark, or without the window it covers
- Running `measure` again and again to fill a gap: each run spends the shared rate limit
- Any protection or settings write without a snapshot taken first, or applied with a plan id the
  user has not seen
- Calling a pin done while `pin` still reports a check `left` or a committed file that rewrites
  protection
