---
name: desk-dev
description: >-
  Use when running studia-web locally and the work depends on real tutor, subject or
  booking data rather than synthetic seed data. Triggers on "run the local server",
  "spin up the app", "point it at staging", "why are the tutors different from
  next.studia.io", tutor names that look generated, a search change that doesn't show
  up in results, or Clerk "Handshake token verification failed" in the dev log.
---

# desk-dev

## Overview

studia-web connects to the **wrong database silently**. There is no error, no warning — the
app boots, renders, and serves synthetic seed tutors as if they were the real cohort.

**Core principle: a page that looks right is not evidence. Only the process environment is.**

**Read `~/.claude/desk-config.md` first.**

| Config | Used for |
|---|---|
| §2 Primary repo root | every path below is relative to it |
| §2 Backups directory | pre-change dumps before any staging write |
| §3 `db-clone-staging` | cloning reads live staging and loads a shared instance |
| §3 `typesense-reindex` | the index is shared by every local session |
| §3 `specs-it-shared` | integration suites `deleteMany()` wholesale |
| §3 `staging-write` | `no`: never write to staging · `ask`: backup + independent review, then ask |
| §3b Preferred dev-server port | the port in every command below (`3000` if unset) |
| §4 Staging bypass token location | where the user keeps their own copy (never in a file you write) |
| §4 Vercel, infra and security owner | who issues the bypass token and `.env.staging`, and holds Neon access |

A `TODO` in §3 is a `no`. Ask; don't assume.

## When to use

- The ticket touches tutor profiles, subjects, levels, search or bookings
- The user asks to "run the local server" so they can look at something themselves
- Anything where the data on screen is the thing being judged

Not needed for pure unit-test or typecheck work — no server required.

**Never point local dev at live staging.** Real-cohort work runs against a **local clone** of
staging in the docker Postgres. `db:seed`, `db:seed:rich`, `db:push` and `specs-it/` all clean or
rewrite the database they reach, and exporting `DATABASE_URL` straight from `.env.staging` aims them
at real data.

## The command

Run it from the package directory:

```bash
cd <repo root>/packages/studia-web
export DATABASE_URL="<staging-copy url>"     # built in references/desk-dev-clone-staging.md
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$(grep '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' .env.staging | cut -d= -f2- | tr -d '\"')"
export CLERK_SECRET_KEY="$(grep '^CLERK_SECRET_KEY=' .env.staging | cut -d= -f2- | tr -d '\"')"
PORT=<port> bun run dev
```

From the package dir, `bun run dev` is `next dev --turbo -p ${PORT:-3000}` directly and inherits
the exports. From the monorepo root it goes through Turborepo, whose `dev` task passes through only
`PORT` and `DOCS_PORT` (`turbo.json` `passThroughEnv`). So `DATABASE_URL` and `CLERK_SECRET_KEY`
never reach the process, while Next's framework inference still lets `NEXT_PUBLIC_*` through. The
result is the client on staging Clerk, the server on dev Clerk, and a handshake loop.

Export **both** Clerk keys or neither. One key from each instance is worse than either alone.

To build the staging copy first: **read `references/desk-dev-clone-staging.md`** and follow it.

## REQUIRED: fill this before reporting anything

No claim about the environment — not "it's up", not "the bug reproduces", not a screenshot —
until this block is filled in from live output:

```
DB PROOF
  process      : pid <pid> listening on <port>
  DATABASE_URL : <value read from the process, or ABSENT>
  row check    : <n> TutorProfile rows; <n> @factory.studia.test; sample names: <three actual names>
  index check  : <n> docs in subjects / tutors   (search work only)
  verdict      : staging copy | dev seed
```

Read the environment from the process itself, not your shell:

```bash
PORT=<port>
PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | head -1)
if [ -r "/proc/$PID/environ" ]; then tr '\0' '\n' < "/proc/$PID/environ"   # Linux / WSL
else ps eww -p "$PID" | tr ' ' '\n'; fi |                                   # macOS
  grep -E '^DATABASE_URL=|^CLERK_SECRET_KEY=' | cut -c1-90
```

The `cut` keeps a secret key's full value out of the transcript. The prefix is enough to see
whether it is present.

**Absence is the failure signal, and it is the common case:**

| The process shows | Meaning |
|---|---|
| nothing at all | The exports never reached the process. `next dev` then loads `.env` itself, so the app is on the **dev seed**. It boots cleanly, which is why this is invisible. |
| ends `studia-web_development` | dev seed |
| ends `studia-web_staging` (or your per-session name) | staging copy |

Verified empirically: a healthy `next dev` started without the exports has **zero**
`DATABASE_URL`/`CLERK_*` entries and still reports `✓ Ready`. Do not read a clean boot as a
connected database.

**The crispest independent check is the email domain**, because it doesn't rely on recognising
anyone. The seed's profiles are all `@factory.studia.test`:

```bash
docker exec studia-web-postgres-1 psql -U postgres -d <db> -tAc \
  "select count(*) filter (where u.email like '%@factory.studia.test'), count(*),
          min(tp.\"createdAt\")::date
   from \"TutorProfile\" tp join \"User\" u on u.id = tp.\"userId\";"
```

The dev seed reads `80 | 81 | <old date>`. A staging copy has real domains and a restore date of
today. Names corroborate: the seed produces `Rudolph Lind`, `Tina Berge`, `Marion Barrows` and
`Tutor Tester`, while the real cohort is actual people.

### Two different causes, two different fixes

Absence of `DATABASE_URL` has two causes, and they are not fixed the same way:

- **Launched from the monorepo root.** Turborepo stripped it. Fix: relaunch from the package dir.
- **Launched correctly, but the exports were never set in that shell.** The form was right, so
  relaunching from the same shell changes nothing. Fix: actually export the three variables.

Tell them apart by walking the parent chain with `ps -o pid,ppid,args` up from the server pid. A
`sh -c next dev --turbo` running from the package dir means cause two.

## Keep them posted

Cloning staging takes minutes. Say what you're starting before you start it, say when it's done,
and say what you're waiting on if it stalls. Same for a reindex or a server boot. The user
shouldn't have to ask whether the environment is coming up.

## Red flags

- About to say "it's up with staging data" with no `DB PROOF` block in the message
- Reasoning about a data bug from names you have not identified
- "The page rendered, so the connection is fine"
- "I'll verify the DB if something looks off" — by then the conclusion is already wrong
- Reporting a reproduction seen on a port you did not confirm the environment of

## Local seed — synthetic data only

For purely local work that doesn't need the real cohort, from the monorepo root:

```bash
bun install                                   # also generates the Prisma client
bun run db:generate                           # only needed again after a schema edit
bun run --filter studia-web db:seed:rich      # CLEANS the database first, then ~81 faker tutors
bun run --filter studia-web dev:all           # docker infra + next + inngest, if you need Inngest
```

"Real tutor profiles" means the real cohort, not the rich seed. That lives on staging (loaded there
by `tutors:import`), so use a clone. Before any seed or migrate, check where `DATABASE_URL` points:
destructive commands are only ever fine against localhost.

`db:seed` and `db:seed:rich` need `--conditions=react-server` (the seed reaches `server-only`
imports). The package scripts carry it. If you run `prisma/seed.ts` by hand, pass it:
`bunx tsx --conditions=react-server prisma/seed.ts --rich`.

**The dev Clerk instance has a 100-user quota.** When it is full, `users.createUser` returns 403
`user_quota_exceeded`. **Do not prune the leftover `+clerk_test` users**: they are shared across
every checkout and worktree. Sign in as an existing user with a Backend API sign-in token instead
(`signIn.create({strategy:'ticket', ticket})` + `setActive`, saved as Playwright `storageState`,
because the token is single-use).

## Typesense — search surfaces do not read the database

`/search`, the tutor cards, predictive search and the level/subject refinements are served from
**Typesense**, not Prisma. A correct `DATABASE_URL` proves nothing about them: the page returns
200 and renders whatever is in the index, which is populated separately.

So for any search, tutor-card, subject or level work, the `DB PROOF` block needs the index
line too:

```bash
python3 - <<'EOF'
import json,urllib.request
key=[l.split('=',1)[1].strip().strip('"') for l in open('.env')
     if l.startswith('TYPESENSE_ADMIN_API_KEY=')][0]
req=urllib.request.Request('http://localhost:8108/collections',
                           headers={'X-TYPESENSE-API-KEY':key})
for c in json.load(urllib.request.urlopen(req,timeout=5)):
    print(c['name'], c.get('num_documents'), 'docs')
EOF
```

Doc counts tell the two apart: the dev seed indexes **238 subjects / 78 tutors**, while staging has
~173 subjects. The variable is `TYPESENSE_ADMIN_API_KEY` (not `TYPESENSE_API_KEY`).

To refresh the index after a data change, run the indexer with `tsx` directly so it inherits the
exported `DATABASE_URL` (turbo strips it exactly as above):

```bash
bunx tsx src/lib/typesense/index-subjects.ts   # or index-tutors.ts
```

Collection names in `src/lib/typesense/schema.ts` are unprefixed and global, so every concurrent
session shares one index. **A reindex is a shared-state mutation**, gated on §3 `typesense-reindex`: say so and
get agreement first.

### Proving a search bug against staging's real index

To prove a relevance bug from data, query **staging's** index read-only. Use the public search-only
key the browser already ships (`NEXT_PUBLIC_TYPESENSE_HOST` and
`NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY` in `.env.staging`). Never use an admin key against staging.
Replay the app's exact query: take `TUTOR_SEARCH_QUERY_BY` and `TUTOR_SEARCH_QUERY_BY_WEIGHTS`
from `src/lib/typesense/schema.ts` rather than from memory, since they change.

```bash
cd <repo root>/packages/studia-web
HOST=$(grep -E '^NEXT_PUBLIC_TYPESENSE_HOST=' .env.staging | tail -1 | cut -d= -f2- | tr -d '"')
KEY=$(grep -E '^NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY=' .env.staging | tail -1 | cut -d= -f2- | tr -d '"')
curl -s "https://$HOST/collections/tutors/documents/search?q=economics&query_by=<QUERY_BY>&query_by_weights=<WEIGHTS>&num_typos=2&per_page=20" \
  -H "X-TYPESENSE-API-KEY: $KEY" \
  | jq '{found, hits: [.hits[] | {name: .document.fullName, matched: [.highlights[].field]}]}'
```

`highlights[].field` shows which field each hit matched on, which is how bio/headline false
positives get proven. For array fields, `indices` gives the matched positions; `subjects[]` and
`subjectSlugs[]` are index-aligned.

## Where things are

`/tutors` returns 404 by design. The route is `/tutors/[slug]` only, with no index page, and the
tutor list is `/search`. A 404 there is not a broken environment.

## Reaching staging from a headless tool

`next.studia.io` sits behind Vercel Deployment Protection, so Playwright, browser MCP and curl hit
the auth wall rather than the app. Getting past it needs a **protection-bypass token**. The Vercel,
infra and security owner (config §4) issues it; ask them rather than working around the wall. Keep it
at config §4 "Staging bypass token location" and load it at run time, e.g.
`TOKEN=$(cat ~/.config/studia/vercel-staging-bypass)`.

Load it **once per browser context, as the cookie**:

```
https://next.studia.io/?x-vercel-protection-bypass=$TOKEN&x-vercel-set-bypass-cookie=true
```

Later navigations need no params. For curl or fetch, send it as the `x-vercel-protection-bypass`
header. **In Playwright, never set it through `extraHTTPHeaders`.** That applies it to cross-origin
requests too, which forces a CORS preflight that Clerk's CDN answers with a redirect. The app then
hangs on a spinner forever.

**Keep the token out of everything shared.** It bypasses authentication for the whole deployment:
never put it in a skill file, a commit, a PR body, a Jira ticket, a screenshot or a command echoed
into the conversation.

Signing up or signing in headlessly on staging has further silent blockers: Clerk's CAPTCHA, the
phone gate, and hidden inputs. **Read `references/desk-dev-staging-headless.md`** before building
a signed-in fixture.

## Known environment faults — not your branch

| Symptom | Cause | What to do |
|---|---|---|
| A Vercel preview build fails in `studia-web#db:migrate` with Prisma **P1002** | Prisma's migrate advisory lock (objid `72707369`) leaked on a pooled Neon backend; builds pass or fail depending on which backend they get | Redeploy. A durable clear needs Neon access (the Vercel, infra and security owner, config §4); do not try to terminate staging backends yourself |
| React error **#418**, then `insertBefore`/`removeChild` NotFoundErrors, on a public page | Cookiebot injects its dialog as `<body>`'s first child mid-hydration | Not a regression in your change; check the status of the Cookiebot hydration ticket in Jira before investigating |
| `vercel inspect` / `vercel logs`: "Can't find the deployment … under the context <personal scope>" | The CLI defaults to your personal scope | `vercel switch sophos-education-27386abb`, or `--scope sophos-education-27386abb` per command. Git pushes deploy under the team regardless |
| `bun: command not found` in an agent shell, though it works in your terminal | If bun is mise-managed from `.tool-versions`, agent shells can inherit a stale mise session and skip PATH injection | `mise exec -- bun …` rather than concluding bun isn't installed |
| `grep -h '^PATTERN' file` prints usage text | Only with the RTK hook installed: it rewrites `grep` to `rtk grep`, which reads a standalone `-h` as `--help` | Drop `-h` for single files (or use combined flags like `-ho`, or `python3`). A script reading that output gets an empty string and carries on silently |
| A portal diff full of trailing-comma hunks in lines you didn't touch | `apps/portal/` has no prettier dependency or config, so a fresh `bunx prettier` reformats with defaults | Hand-edit portal files and verify with `bunx eslint <paths>` from `apps/portal/apps/web`; if prettier already ran, `git checkout -- <file>` and redo the edit |

## Writing to real staging

Different task, different risk. Never a side effect of setting up an environment. This is the one
operation here that changes data other people depend on. Under §3 `staging-write` `no` it never
happens; under `ask` it asks every time, and the order below is not optional:

1. **Back up what you are about to change.** Dump the affected table plus a JSON of the pre-change
   values for the specific rows into `<backups directory>/SV-XXX/` (config §2). A rollback you have
   not written down is not a rollback.
2. **Dispatch one independent subagent to review the script before it runs.** Give it the script,
   the ticket and the backup path, and ask it to find the case where this corrupts data. It must
   not run anything. One agent is cheap next to a bad write to shared data.
3. **Then run it**, and only after the user has agreed to that specific write.
4. **Reindex if the change affects search**, and say so first. That is a shared-state mutation in
   its own right.

Never seed staging, and never invent the data you write: catalog entries, subjects and prices come
from an authoritative source or from the product owner (config §4).

## Common mistakes

| Mistake | What happens |
|---|---|
| `bun run dev` from the monorepo root | Turborepo strips the env; silent fallback to dev seed |
| Exporting only `DATABASE_URL` | Clerk instance mismatch; public pages 404 in a handshake loop |
| Exporting `DATABASE_URL` from `.env.staging` | That is live staging, not a copy; seeds and writes hit real data |
| Running the rich seed when asked for "real tutors" | Faker profiles; the real cohort is only on staging |
| Reindexing to check a change | Overwrites the shared local index other sessions are using |
| Pruning `+clerk_test` users to free quota | Deletes users other checkouts depend on |
| The bypass token as a Playwright header | CORS preflight to Clerk's CDN fails; infinite spinner |
| Trusting the rendered page | The failure mode is silent by construction |
