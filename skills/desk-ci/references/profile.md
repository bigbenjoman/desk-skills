# desk-ci: profile

Read before running `profile`, and no other step's file with it. The overview, the placement rule
and the red flags every command shares are in `../SKILL.md`, already loaded.

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
| a database | a `services:` or `container:` image of Postgres, PostGIS, MySQL, MariaDB, MongoDB, Redis, Valkey, SQL Server, CockroachDB or ClickHouse; a database setup action; `psql`, `pg_isready`, `mysqladmin`, `mongosh`, `redis-cli`, `prisma migrate`/`db push`, `supabase start`/`db`, `manage.py migrate` or `rails db:`; a `*DATABASE_URL`, `PGHOST`, `PGDATABASE` or `PGURL` variable <!-- prose-ok: a Django repo's manage.py, not desk's --> |
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
