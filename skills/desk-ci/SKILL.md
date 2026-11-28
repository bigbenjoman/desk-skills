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
  Also when a repo's AWS runners stopped taking jobs and its CI fell back to GitHub-hosted runners
  ("is the AWS fallback on?", "put voicepa back on AWS", "/desk-ci aws-fallback status|off").
argument-hint: "classify | ci-lint | profile [<workflow file or directory>...] | measure [--repo owner/name] [--days 90] [--budget 600] | batch-red [--prs a,b] | protection snapshot|restore <file>|pin|token | aws-fallback status|off [--repo owner/name]"
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
`.handoffs/`, the protection writes below, each shown first and gated on config §3
`ci-protection`, and `aws-fallback off`, which the user runs to put a repo back on its AWS runners.
It never edits `.github/`, opens a PR, or changes runner settings, in this repo or any other. Writing
the workflow changes a proposal implies is separate work, done only after the user has read the
proposal and said which placements to take.

Both commands are read-only and take workflow files or directories (default `.github/workflows`,
run from the repo root):

```bash
node ~/.claude/desk/bin/desk-ci.mjs classify [<file or dir>...]
node ~/.claude/desk/bin/desk-ci.mjs ci-lint  [<file or dir>...]   # exit 1 on any finding
```

## The placement rule

A repo that declares AWS runner labels is placed by the rule in *A repo's AWS runners* below.

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

"Can resolve" means any label set other than GitHub-hosted image labels (`ubuntu-*`, `macos-*`,
`windows-*`) or the repo's declared AWS runner labels (below): a bare `self-hosted` or any other
custom label, a runner `group:`, a matrix entry holding one, or a value read from `vars`, `inputs`,
`env` or `needs` that the file does not fix. Where the repo declares AWS runner labels, a `${{ }}`
expression is read for every label set it can pick, through `&&`, `||`, `fromJSON` and `format`, and a
value only compared (`vars.X == 'on'`) is not a label source. Where it declares none, every quoted
literal in an expression counts as a label it may pick, as it always has. Each finding names the job
and the line:

```
<file>:<line>  <job>  can run self-hosted but receives secret DEPLOY_KEY
summary: findings=<n>
```

### A repo's AWS runners: `.github/desk-ci.yml`

A repo whose CI runs on its own AWS runners declares their labels in `.github/desk-ci.yml`, read from
the root of the repo holding the workflows:

```yaml
aws-runner-labels: [voicepa-linux-arm64, voicepa-linux-arm64-8cpu]   # arm64 runners
aws-x64-runner-labels: [voicepa-linux-x64]   # optional: x64 runners
hosted-workflows: [release.yml]   # workflow files kept on GitHub-hosted runners
```

- A label set whose labels are all declared, with or without `self-hosted`, is the repo's cloud
  runner: a job that can pick only those or GitHub-hosted labels may receive a secret, an environment
  or `id-token`, and needs no Dependabot branch. A declared label covers its `<label>-on-demand` twin.
- A declared label beside one that is not, a bare `self-hosted`, or a label from `vars` or `inputs`
  is still reported.
- Labels under `aws-x64-runner-labels` are AWS runner labels too; every label under
  `aws-runner-labels` is read as arm64.
- `ci-lint` fails on `self-hosted` or a GitHub-hosted label under either labels key, naming the file
  and line, and on any job in a `hosted-workflows` file whose `runs-on` can pick a runner that is not
  GitHub-hosted.
- `classify` places every job of a `hosted-workflows` file hosted with the reason `hosted-workflows`,
  and names the AWS label a job runs on today: `(runs-on today: AWS runner <label>, …)`.
- Where any AWS runner label is declared, `classify` places every other job **aws** instead of
  self-hosted: secrets, environments, `id-token`, staging URLs, third-party services and YAML aliases
  no longer keep a job hosted, and the line still cites the first of them. Two things do:
  - **needing x64**: an image with no arm64 build or production x64 build parity. Such a job is placed
    hosted (`needs x64: <trigger>, and the repo's AWS runners are arm64`), or, where an
    `aws-x64-runner-labels` label is declared, aws on the first one (`needs x64: <trigger>, on AWS x64
    runner <label>`);
  - **a call to a reusable workflow outside this repo**, which cannot be read here.

  The summary then reads `summary: jobs=<n> hosted=<n> aws=<n>`.
- With no `.github/desk-ci.yml`, both read as before.

## Running it

1. `classify` over the repo's workflows. Print its output, then the proposal: one table of jobs to
   move self-hosted, one of jobs that stay hosted with the trigger and line for each, and any image
   that needs its arm64 build checked.
2. `ci-lint` over the same files, and report each finding.
3. Stop. The user decides which placements to take; nothing in the repo has changed.

## Reference files — read at their step

This file holds what every run needs: the overview, the placement rule, `ci-lint`, running
`classify` and `ci-lint`, and the red flags. The rest is in `references/`, beside it. **At each step
below, read the file the table names for it**, and only that one; a step not listed needs nothing
beyond this file.

| Step | Sections | Read |
|---|---|---|
| Running `measure`, or `batch-red` against its baseline | *measure*, *batch-red* | `references/measure.md` |
| Running `profile`, or acting on its plan or its saving | *profile* | `references/profile.md` |
| Any `protection` command: `snapshot`, `restore`, `pin` or `token` | *protection* | `references/protection.md` |
| `aws-fallback status` or `off`, or an `AWS fallback on for` issue the watchdog opened | *aws-fallback* | `references/aws-fallback.md` |

**A reference file you cannot read stops the command.** If the file a step names is missing or
empty, stop and name it by its full path; never run the command from memory or an earlier copy of
this skill. `/desk-update` reinstalls it.

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
