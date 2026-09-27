# Cloning staging into local docker

Makes a **local copy** of the staging database, so the app shows the real cohort while nothing
touches real staging. Run all commands from `<repo root>/packages/studia-web` (config §2);
`.env.staging` lives there, not at the monorepo root. Check config §3
`db-clone-staging` first. `ask` means ask each time.

`.env.staging` is not committed. If you don't have one, ask the Vercel, infra and security owner (config §4)
rather than assembling one from elsewhere.

**Never prune the `postgres:17` images.** `docker system df` calls `postgres:17` (645MB) and
`postgres:17-alpine` (424MB) reclaimable because nothing runs them. They are the dump tooling
step 2 depends on, while the running container is postgres:**16**. `docker image prune -a` deletes
them, and the next clone then needs a 645MB re-download exactly when you want it.

Local infra containers, started by `bun run dev:infra` if they aren't up:
`studia-web-postgres-1` (postgres:16), `studia-web-typesense-1`, `studia-web-mailpit-1`.

## 1. Create the target database

```bash
docker exec studia-web-postgres-1 psql -U postgres \
  -c 'DROP DATABASE IF EXISTS "studia-web_staging";' \
  -c 'CREATE DATABASE "studia-web_staging";'
```

This is destructive to the *copy* only. It never touches `studia-web_development`, and never
touches staging. If another session is mid-flight against the copy, ask before dropping it, or use
a per-session name (see below).

## 2. Dump staging into it

Staging is PG17 and the local container is PG16, so a local `pg_dump` refuses on the version
mismatch. Dump through a throwaway `postgres:17` container instead. The `sed` swaps Neon's pooler
endpoint for the direct one, which `pg_dump` needs.

```bash
URL=$(grep '^DATABASE_URL=' .env.staging | cut -d= -f2- | tr -d '"' | sed 's/-pooler//')
docker run --rm postgres:17 pg_dump "$URL" --no-owner --no-privileges \
  | docker exec -i studia-web-postgres-1 psql -U postgres -d studia-web_staging -q
```

Never echo `$URL`: it carries the staging credentials.

One `transaction_timeout` ERROR from the PG17 dump header is expected on a PG16 target and can be
ignored. Any other error means the copy is incomplete. Do not proceed on a partial clone.

This is a **read** of live staging, and the only staging contact in this procedure. It puts load on
the shared instance, and the pooler has a known advisory-lock flake, so don't repeat it casually.
Reuse an existing copy when one is current enough.

## 3. Run the app against the copy

```bash
cd <repo root>/packages/studia-web
export DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' \
  | sed 's/studia-web_development/studia-web_staging/')"
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$(grep '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' .env.staging | cut -d= -f2- | tr -d '"')"
export CLERK_SECRET_KEY="$(grep '^CLERK_SECRET_KEY=' .env.staging | cut -d= -f2- | tr -d '"')"
PORT=<config §3b Preferred dev-server port> bun run dev
```

The `DATABASE_URL` is built from the local `.env` with the database name swapped: local host,
local credentials, copied data. The staging Clerk keys are used so an existing next.studia.io login
works against rows keyed to staging Clerk user IDs.

Then fill the `DB PROOF` block in SKILL.md. The export reaching the process is an assumption until
you have read it back from the process.

## Concurrent sessions

Every worktree's `.env` is a copy of the same file (`~/.claude/desk/bin/copy-env.sh`), so by default
all sessions point at the same Postgres instance and the same `studia-web_staging` database. Two
consequences:

- The Vitest integration suite deletes wholesale. For example,
  `specs-it/booking-attachment-limits.itest.ts` runs `db.bookingAttachment.deleteMany()` through
  `db.user.deleteMany()`. **Never run `specs-it/` against a staging copy another session may be
  using** (config §3 `specs-it-shared`). Unit specs (`specs/`, Jest, mocked Prisma) and `typecheck` are always
  safe.
- Where it matters, use a distinct database name per session (`studia-web_staging_sv508`) and
  swap it into the export above.

One port holds one session's app. If yours is occupied, pick another and record which. Otherwise
the screenshots and the user's manual check will be of a different branch's code.
