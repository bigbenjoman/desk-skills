---
name: desk-dev
description: >-
  Use when running this repo's app locally, especially when the work depends on real data rather
  than synthetic seed data. Triggers on "run the local server", "spin up the app", "point it at
  staging", "why is the data different from staging", records that look generated, a search change
  that doesn't show up in results, or an auth handshake / key-mismatch error in the dev log.
---

# desk-dev

## Overview

An app can connect to the **wrong database silently**. There is no error, no warning — it boots,
renders, and serves synthetic seed data as if it were the real thing.

**Core principle: a page that looks right is not evidence. Only the process environment is.**

**Resolve this repo's config first.**

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no
```

Read the `CONFIG` file. `EXISTS=no` means stop: say which slug was looked up and offer `/desk-setup`.
Running the app is **entirely per repo**; nothing below assumes a toolchain, a database or a host.

An autopilot worker cannot read that file, so each row below is a `desk-env` read: §3b Preferred
dev-server port `desk-env get dev-port`; §4 Package manager `desk-env get package-manager`, Command
prefix `desk-env get command-prefix`, Install `desk-env cmds install-cmd`, Dev server
`desk-env cmds dev-cmd`, Env files `desk-env list env-files`, Database URL variable
`desk-env list db-url-var`, Local database `desk-env get local-db`, Local services
`desk-env get local-services`, Staging `desk-env get staging`, Staging bypass token location
`desk-env get staging-bypass` and Vercel `desk-env get vercel`.

| Config | Used for |
|---|---|
| §2 Primary repo root | the main checkout; env files are copied from it |
| §2 Backups directory | pre-change dumps before any staging write |
| §3 `db-per-ticket` | a throwaway per-ticket local database |
| §3 `db-clone-staging` | cloning reads live staging and loads a local instance |
| §3 `local-reindex` | a local index or cache every session shares (§4 Local services) |
| §3 `tests-shared-db` | database-backed tests that may wipe tables another session is using |
| §3 `staging-write` | `no`: never write to staging · `ask`: backup + independent review, then ask |
| §3b Preferred dev-server port | the port in every command below (`3000` if unset) |
| §4 Toolchain: Package manager, Command prefix, Install, Dev server, Env files | how the app is installed and started (`<prefix>` below is §4 Command prefix, or nothing when it is `none`) |
| §4 Local database | engine, container or host, database naming, how the seed is loaded; `none` means the app has no local database |
| §4 Local services | search index, mail catcher, queues, with ports; `none` means there are none |
| §4 Staging, Staging bypass token location, Vercel | the staging URL and its protection; where the user keeps their own copy of the token (never in a file you write) |
| §4 People "Infra and security owner" | who issues staging env files and bypass tokens, and holds database-host access |
| §5 Repo instructions | the repo's own run instructions; they win over this skill on anything they cover |

A `TODO` in §3 is a `no`. A `TODO` in §4 means ask and offer `/desk-setup`; don't guess a command.

## When to use

- The ticket touches data the user will judge by eye: records, catalog entries, search, bookings
- The user asks to "run the local server" so they can look at something themselves
- Anything where the data on screen is the thing being judged

Not needed for pure unit-test or typecheck work — no server required.

**Never point local dev at live staging.** Real-data work runs against a **local clone** of staging
in §4 Local database. Seed, reset, push and integration-test commands clean or rewrite the database
they reach, and exporting the database URL straight from a staging env file aims them at real data.
§4 Local database `none` or §4 Staging `none`: there is no clone to make; say so and work with what
the repo's instructions provide.

## The command

```bash
desk-env cmds dev-cmd                          # one DIR<TAB>CMD line per app in §4 Dev server
cd <DIR>                                       # a separate step, never `cd <DIR> && …` in one command
<prefix> <§4 Install>                          # first run in a fresh worktree only (from the root)
export <DB URL VAR>="<staging-copy url>"       # only for real-data work; built in references/desk-dev-clone-staging.md
PORT=<port> <prefix> <CMD>
```

§4 Dev server holds one backtick span per app, and an app that runs in a subdirectory is written
`` `portal: pnpm dev` ``; pick the line for the app you need. The row notes whether an app honours
`PORT` or hard-codes one: a hard-coded port cannot be moved, so check nothing else holds it.

A fresh worktree needs the files §4 Env files names copied from §2 Primary repo root first (`none`:
nothing to copy). Read the variable names — the database URLs, the auth keys — from §4 Database URL
variable (every one it lists), the repo's env example or its instructions, never from memory.

**A task runner can strip the exports.** If §4 Dev server goes through a monorepo task runner
(Turborepo, nx, a workspace filter), check what it passes through: Turborepo, for example, passes
only the variables its `passThroughEnv` / `globalPassThroughEnv` lists, while a framework may still
let public-prefixed variables through. The result can be the client on one auth instance, the server
on another, and a handshake loop. Launching the package's own dev script from its directory avoids
the runner.

**Auth keys come in pairs.** If the app's auth provider has a publishable and a secret key, export
**both** from the same instance or neither. One key from each instance is worse than either alone.

To build the staging copy first: **read `references/desk-dev-clone-staging.md`** and follow it.

## REQUIRED: fill this before reporting anything

No claim about the environment — not "it's up", not "the bug reproduces", not a screenshot — until
this block is filled in from live output:

```
DB PROOF
  process      : pid <pid> listening on <port>
  DB URL       : <database name read from the process, or ABSENT>
  row check    : <n> rows in <a table that tells seed from real>; <n> seed-marked; sample: <three actual values>
  index check  : <n> docs per collection   (only when a §4 Local services index serves the surface)
  verdict      : staging copy | dev seed
```

§4 Local database `none`: replace the DB lines with whatever the app reads its data from (an API
base URL in the process env) and prove that the same way.

Read the environment from the process itself, not your shell:

```bash
PORT=<port>
PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | head -1)
if [ -r "/proc/$PID/environ" ]; then tr '\0' '\n' < "/proc/$PID/environ"   # Linux / WSL
else ps eww -p "$PID" | tr ' ' '\n'; fi |                                   # macOS
  grep -E '^<DB URL VAR>=|^<AUTH SECRET VAR>=' | cut -c1-90
```

The `cut` keeps a secret key's full value out of the transcript. The prefix is enough to see
whether it is present.

**Absence is the failure signal, and it is the common case:**

| The process shows | Meaning |
|---|---|
| nothing at all | The exports never reached the process. The framework then loads the local env file itself, so the app is on the **dev seed**. It boots cleanly, which is why this is invisible. |
| the development database name §4 Local database gives | dev seed |
| the staging-copy name (or your per-session name) | staging copy |

A healthy dev server started without the exports can have **zero** database or auth entries in its
process environment and still report ready. Do not read a clean boot as a connected database.

**The crispest independent check is a seed marker**, because it doesn't rely on recognising anyone.
Seeds usually leave one — a fixture email domain, a fixed creation date, generated names. Find it in
the repo's seed script, then count it read-only in §4 Local database, e.g. for Postgres in docker:

```bash
docker exec <container> psql -U <user> -d <db> -tAc \
  "select count(*) filter (where email like '%@<seed domain>'), count(*), min(created_at)::date from <table>;"
```

A seed database is nearly all seed-marked rows with an old date. A staging copy has real values and
a restore date of today. Names corroborate: seeds produce generated names; real data is actual
people and things.

### Two different causes, two different fixes

Absence of the database URL has two causes, and they are not fixed the same way:

- **Launched through a task runner that strips the env.** Fix: relaunch from the package dir.
- **Launched correctly, but the exports were never set in that shell.** The form was right, so
  relaunching from the same shell changes nothing. Fix: actually export the variables.

Tell them apart by walking the parent chain with `ps -o pid,ppid,args` up from the server pid. A
dev server running straight from the package dir means cause two.

## Keep them posted

Cloning staging takes minutes. Say what you're starting before you start it, say when it's done,
and say what you're waiting on if it stalls. Same for a reindex or a server boot. The user
shouldn't have to ask whether the environment is coming up.

## Red flags

- About to say "it's up with staging data" with no `DB PROOF` block in the message
- Reasoning about a data bug from records you have not identified
- "The page rendered, so the connection is fine"
- "I'll verify the DB if something looks off" — by then the conclusion is already wrong
- Reporting a reproduction seen on a port you did not confirm the environment of

## Local seed — synthetic data only

For purely local work that doesn't need real data, follow the repo's instructions and §4 Local
database for bringing up the local services and loading the seed. Run every toolchain command
through §4 Command prefix; never swap in a package manager §4 Package manager forbids.

- **A seed usually CLEANS the database first.** Before any seed, reset, push or migrate, check where
  the database URL points: destructive commands are only ever fine against localhost.
- **Prefer a per-ticket database** (§3 `db-per-ticket`, using the naming §4 Local database gives)
  over the shared development one, so a reset does not land on another session.
- "Real data" means the real data, not a richer seed. That lives on staging, so use a clone.
- **A development auth instance can have a user quota.** When it is full, user creation fails with a
  quota error. **Do not prune the leftover test users**: they are shared across every checkout and
  worktree. Sign in as an existing user with the provider's server-side sign-in token where it has
  one, saved as Playwright `storageState`, because such tokens are usually single-use.

## Local services — surfaces that do not read the database

Skip this section when §4 Local services is `none`.

A surface served from a search index or cache (§4 Local services) does not read the database. A
correct database URL proves nothing about it: the page returns 200 and renders whatever is in the
index, which is populated separately. So for any work on such a surface, the `DB PROOF` block needs
the index line too: read each collection's document count from the service's admin API on its §4
port, with the admin key read from the local env file (never echoed). Seed and staging counts
differ; record which you see.

To refresh the index after a data change, run the repo's indexer so it inherits the exported
database URL (a task runner strips it exactly as above). If the index's collection names are global
rather than per-session, every concurrent session shares one index. **A reindex is then a
shared-state mutation**, gated on §3 `local-reindex`: say so and get agreement first.

### Proving a search bug against staging's real index

To prove a relevance bug from data, query **staging's** index read-only, and only with the public
search-only key the browser already ships (from the staging env file). **Never use an admin key
against staging.** Replay the app's exact query: take the query fields and weights from the repo's
search code rather than from memory, since they change. The per-hit highlight or match fields show
which field each hit matched on, which is how free-text false positives get proven. §4 Staging
`none`: not available.

## Reaching staging from a headless tool

Skip this section when §4 Staging is `none`.

If §4 Staging says it is protected (for example Vercel Deployment Protection, with §4 Vercel naming
the team and project), Playwright, browser MCP and curl hit the auth wall rather than the app.
Getting past it needs a **protection-bypass token**. §4 People "Infra and security owner" issues it;
ask them rather than working around the wall (`you`: the user issues it themselves). Keep it at
§4 "Staging bypass token location" and load it at run time, e.g. `TOKEN=$(cat <that path>)`.

For Vercel, load it **once per browser context, as the cookie**:

```
<§4 Staging URL>/?x-vercel-protection-bypass=$TOKEN&x-vercel-set-bypass-cookie=true
```

Later navigations need no params. For curl or fetch, send it as the `x-vercel-protection-bypass`
header. **In Playwright, never set it through `extraHTTPHeaders`.** That applies it to cross-origin
requests too, which forces a CORS preflight that third-party CDNs (an auth provider's script, for
one) can answer with a redirect. The app then hangs on a spinner forever.

**Keep the token out of everything shared.** It bypasses authentication for the whole deployment:
never put it in a skill file, a commit, a PR body, a ticket, a screenshot or a command echoed into
the conversation.

Signing up or signing in headlessly on staging has further silent blockers: bot-protection
CAPTCHA, phone gates, and hidden inputs. **Read `references/desk-dev-staging-headless.md`** before
building a signed-in fixture.

## Known environment faults — not your branch

| Symptom | Cause | What to do |
|---|---|---|
| A preview build fails in a migrate step with Prisma **P1002** (where the repo uses Prisma migrate against a pooled Postgres such as Neon) | Prisma's migrate advisory lock leaked on a pooled backend; builds pass or fail depending on which backend they get | Redeploy. A durable clear needs database-host access (§4 People "Infra and security owner"); do not try to terminate staging backends yourself |
| React error **#418**, then `insertBefore`/`removeChild` NotFoundErrors, on a public page | A third-party script (a cookie-consent dialog, a chat widget) injects into `<body>` mid-hydration | Not a regression in your change; check the tracker for an existing ticket before investigating |
| `vercel inspect` / `vercel logs`: "Can't find the deployment … under the context <personal scope>" | The CLI defaults to your personal scope | `vercel switch <team slug from §4 Vercel>`, or `--scope <team slug>` per command. Git pushes deploy under the team regardless. §4 Vercel `none`: not applicable |
| `<tool>: command not found` in an agent shell, though it works in your terminal | Agent shells can skip a version manager's PATH injection | Run it through §4 Command prefix (the version manager's exec wrapper) rather than concluding it isn't installed. Prefix `none`: check the tool's install path |
| `grep -h '^PATTERN' file` prints usage text | Only with the RTK hook installed: it rewrites `grep` to `rtk grep`, which reads a standalone `-h` as `--help` | Drop `-h` for single files (or use combined flags like `-ho`, or `python3`). A script reading that output gets an empty string and carries on silently |
| A diff full of formatting hunks in lines you didn't touch | A formatter ran with its defaults in a package that has no config for it | Hand-edit and verify with the package's own lint; if a formatter already ran, `git checkout -- <file>` and redo the edit |

## Writing to real staging

Different task, different risk. Never a side effect of setting up an environment. This is the one
operation here that changes data other people depend on. Under §3 `staging-write` `no` it never
happens; under `ask` it asks every time, and the order below is not optional. §4 Staging `none`:
there is nothing to write to.

1. **Back up what you are about to change.** Dump the affected table plus a JSON of the pre-change
   values for the specific rows into `<§2 Backups directory>/<TICKET>/`. A rollback you have not
   written down is not a rollback.
2. **Dispatch one independent subagent to review the script before it runs.** Give it the script,
   the ticket and the backup path, and ask it to find the case where this corrupts data. It must
   not run anything. One agent is cheap next to a bad write to shared data.
3. **Then run it**, and only after the user has agreed to that specific write.
4. **Reindex if the change affects a search index**, and say so first. That is a shared-state
   mutation in its own right.

Never seed staging, and never invent the data you write: catalog entries, names and prices come
from an authoritative source or from §4 People Product owner (`product-calls` is `stop`).

## Common mistakes

| Mistake | What happens |
|---|---|
| Starting the dev server through a task runner that filters env | Exports stripped; silent fallback to dev seed |
| Exporting only the database URL | Auth instance mismatch; handshake loop |
| Exporting the database URL from a staging env file | That is live staging, not a copy; seeds and writes hit real data |
| Running a richer seed when asked for "real data" | Synthetic records; the real data is only on staging |
| Reindexing to check a change | Overwrites the shared local index other sessions are using |
| Pruning test users to free auth quota | Deletes users other checkouts depend on |
| The bypass token as a Playwright header | CORS preflight to a third-party CDN fails; infinite spinner |
| Guessing an install or dev command | Use §4 Toolchain; `TODO` means ask |
| Trusting the rendered page | The failure mode is silent by construction |
