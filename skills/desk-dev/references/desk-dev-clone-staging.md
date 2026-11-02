# Cloning staging into the local database

Makes a **local copy** of the staging database, so the app shows real data while nothing touches
real staging. Everything here is driven by this repo's config (`desk-env where`, then Read it; a
worker reads each row with `desk-env`): §4 Local database `desk-env get local-db`, Staging
`desk-env list staging`, Env files `desk-env list env-files`, Command prefix
`desk-env get command-prefix`, Dev server `desk-env cmds dev-cmd` and Typecheck
`desk-env cmds typecheck-cmd`, and §3b Preferred dev-server port `desk-env get dev-port`.

## 0. Does this repo have one, and may you?

| Check | If not |
|---|---|
| §4 Local database is not `none` | **Skip this whole procedure**: there is no local database to load. Say so |
| §4 Staging is not `none` | **Skip**: there is no staging to clone. Say so |
| §3 `db-clone-staging` | `yes`: proceed and print what you are doing · `ask`: ask each time · `no` or `TODO`: don't; say the row blocks it and offer `/desk-setup` |
| §5 Repo instructions give a clone or restore command | If they do, **use it** instead of the generic steps below; they know the repo's quirks |

The staging connection string lives in a staging env file the repo's instructions name (it is never
committed). If you don't have one, ask §4 People "Infra and security owner" rather than assembling
one from elsewhere (`you`: the user has it or knows where it is).

**Never echo the staging URL**: it carries the staging credentials. Read it into a variable and use
it, and keep it out of commands shown in the conversation.

**Never prune the docker images used as dump tooling.** `docker system df` calls an image
reclaimable when nothing runs it; the throwaway client image step 2 uses is exactly that. `docker
image prune -a` deletes it, and the next clone re-downloads it exactly when you want it.

Bring up the local database the way §4 Local database (or the repo's instructions) says, if it isn't
up. Note the container or host, the admin user, and the development database's name from that row.

The steps below are for Postgres, the common case. For another engine use its own dump and restore
tools with the same shape: a fresh target, a version-matched dump, read-only against staging.

## 1. Create the target database

Use a name that says what it is: the development database's name with a `_staging` suffix, or a
per-session name (`<dev db>_staging_<ticket>`) where another session might be using the shared copy.

```bash
docker exec <container> psql -U <admin user> \
  -c 'DROP DATABASE IF EXISTS "<target>";' \
  -c 'CREATE DATABASE "<target>";'
```

This is destructive to the *copy* only. It never touches the development database, and never
touches staging. If another session is mid-flight against the copy, ask before dropping it, or use
a per-session name.

## 2. Dump staging into it

`pg_dump` refuses to dump a server newer than itself. If staging's major version is newer than the
local client (check with `select version()` on each, read-only), dump through a throwaway
`postgres:<staging major>` container instead. If staging sits behind a connection pooler (Neon's
`-pooler` host, PgBouncer), swap in the direct endpoint, which `pg_dump` needs.

```bash
URL=$(grep '^<DB URL VAR>=' <staging env file> | cut -d= -f2- | tr -d '"')   # then swap pooler -> direct if needed
docker run --rm postgres:<staging major> pg_dump "$URL" --no-owner --no-privileges \
  | docker exec -i <container> psql -U <admin user> -d <target> -q
```

A dump from a newer major into an older server can emit an ERROR for a setting the older server
lacks (e.g. `transaction_timeout` from a PG17 dump on PG16); that one can be ignored. Any other
error means the copy is incomplete. Do not proceed on a partial clone.

This is a **read** of live staging, and the only staging contact in this procedure. It puts load on
the shared instance, and poolers have known lock flakes, so don't repeat it casually. Reuse an
existing copy when one is current enough.

## 3. Run the app against the copy

```bash
export <DB URL VAR>="<the local development URL with the database name swapped for <target>>"
export <AUTH PUBLISHABLE VAR>="<from the staging env file>"   # only if the app's auth provider
export <AUTH SECRET VAR>="<from the staging env file>"        # keys rows to user ids per instance
PORT=<§3b Preferred dev-server port> <§4 Command prefix> <§4 Dev server>
```

The database URL is built from the local env file with the database name swapped: local host, local
credentials, copied data. If the app's auth provider keys rows to per-instance user ids, use the
staging instance's keys (both, never one) so an existing staging login works against the copied
rows. Read the variable names from the repo's env example, not from memory.

Then fill the `DB PROOF` block in SKILL.md. The export reaching the process is an assumption until
you have read it back from the process.

## Concurrent sessions

Every worktree's env file is a copy of the same file (§4 Env files, copied by
`~/.claude/desk/bin/copy-env.sh`), so by default all sessions point at the same local database
instance and the same staging copy. Two consequences:

- Database-backed integration tests often delete tables wholesale. **Never run them against a
  database another session may be using** unless §3 `tests-shared-db` is `yes`. Unit tests with a
  mocked data layer, and §4 Typecheck, are always safe.
- Where it matters, use a distinct database name per session and swap it into the export above.

One port holds one session's app. If yours is occupied, pick another and record which. Otherwise
the screenshots and the user's manual check will be of a different branch's code.
