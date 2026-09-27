#!/usr/bin/env bash
# Create an isolated worktree for one ticket.
#
# Ordering is load-bearing: .env must land before `bun install`, because bun runs
# prisma generate via trustedDependencies and it hard-fails without DATABASE_URL.
# DATABASE_URL is then repointed at a per-ticket database so a seed or a specs-it/
# run in one worktree cannot wipe another worktree's data.
set -euo pipefail

TICKET="${1:?usage: setup-worktree.sh SV-XXX <branch>}"
BRANCH="${2:?usage: setup-worktree.sh SV-XXX <branch>}"

# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"
studia_load_paths || exit 1

MAIN="$DESK_REPO_ROOT"
WT="$DESK_WORKTREES_DIR/$TICKET"
DB="studia-web_$(printf '%s' "$TICKET" | tr 'A-Z' 'a-z' | tr -d '-')"
# The database the main checkout uses, which a worktree must never point at.
SHARED_DB="$(sed -nE 's#^DATABASE_URL="?.*/([^/?"]+).*#\1#p' "$MAIN/packages/studia-web/.env" 2>/dev/null | head -1)"
SHARED_DB="${SHARED_DB:-studia-web_development}"

# Resolve bun explicitly: a detached worker's shell does not get mise's PATH injection.
BUN="$(command -v bun || true)"
[ -z "$BUN" ] && BUN="$(mise which bun 2>/dev/null || true)"
[ -z "$BUN" ] && { echo "FAIL: bun not found (mise install?)" >&2; exit 1; }

say() { printf '[setup-worktree] %s\n' "$*"; }

mkdir -p "$DESK_WORKTREES_DIR"

if [ -d "$WT" ]; then
  say "worktree already exists at $WT — leaving it alone"
  # ...but ALWAYS re-sync the agent symlinks. They are gitignored, so a worktree created before
  # the sync existed has none, and a `claude -p` worker loads its agent registry once at startup:
  # syncing them after it starts is too late and every named finder role silently degrades to
  # general-purpose. Cheap, idempotent, and it must happen before the spawn.
  (cd "$WT" && "$BUN" run agents:sync >/dev/null 2>&1) || say "  agents:sync failed in $WT"
  say "database=$DB"
  exit 0
fi

git -C "$MAIN" fetch origin --quiet

if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  say "branch $BRANCH already exists — checking it out into the worktree"
  git -C "$MAIN" worktree add "$WT" "$BRANCH" --quiet
else
  say "creating $BRANCH off origin/main"
  git -C "$MAIN" worktree add -b "$BRANCH" "$WT" origin/main --quiet
fi

# copy-env.sh finds the main checkout via the shared git common dir, so it is
# portable and must run from inside the new worktree.
say "seeding env files"
( cd "$WT" && bash "$DESK_ENV_DIR/copy-env.sh" )

ENV_FILE="$WT/packages/studia-web/.env"
[ -f "$ENV_FILE" ] || { echo "FAIL: $ENV_FILE missing after copy-env" >&2; exit 1; }

# .gitignore ignores .claude/agents/*.md, so a fresh worktree has no agent symlinks and every
# named subagent silently resolves to general-purpose - including pullbot's refuter, which turns
# the adversarial pass into one model checking its own work. Pure node builtins, so it runs
# before `bun install`. Fail loudly: a silent skip here is invisible for the rest of the run.
say "linking subagents"
if [ -f "$WT/scripts/agents-sync.mjs" ]; then
  ( cd "$WT" && node scripts/agents-sync.mjs >/dev/null ) || { echo "FAIL: agents-sync errored" >&2; exit 1; }
  AGENT_COUNT=$(find "$WT/.claude/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  [ "$AGENT_COUNT" -gt 0 ] || { echo "FAIL: .claude/agents still empty after agents-sync" >&2; exit 1; }
  say "  $AGENT_COUNT agent(s) linked"
else
  # An existing branch old enough to predate the script. Not fatal, but the worker has to know:
  # every named subagent it dispatches will be general-purpose.
  say "  WARNING: no scripts/agents-sync.mjs on this branch - subagents will be general-purpose"
fi

say "repointing DATABASE_URL at $DB"
studia_sed_inplace "s#^(DATABASE_URL=\"?.*/)[^/?\"]+(\\?[^\"]*)?(\"?)\$#\\1$DB\\2\\3#" "$ENV_FILE"

if ! grep -q "^DATABASE_URL=.*/$DB" "$ENV_FILE"; then
  echo "FAIL: DATABASE_URL rewrite did not take" >&2; exit 1
fi
if grep -q "^DATABASE_URL=.*/$SHARED_DB\([?\"]\|\$\)" "$ENV_FILE"; then
  echo "FAIL: DATABASE_URL still points at the shared $SHARED_DB" >&2; exit 1
fi

# Allocating a name is not provisioning. A bare database fails on the citext extension, and
# a half-pushed one fails worse — create it and let migrations bring it up properly.
say "provisioning database $DB in container $DESK_PG_CONTAINER"
if docker exec "$DESK_PG_CONTAINER" psql -U postgres -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB"; then
  say "  already exists — leaving it alone"
else
  if docker exec "$DESK_PG_CONTAINER" psql -U postgres -c "CREATE DATABASE \"$DB\"" >/dev/null 2>&1; then
    say "  created"
  else
    say "  WARNING: could not create $DB (is $DESK_PG_CONTAINER running? set DESK_PG_CONTAINER) — a worker needing data will have to"
  fi
fi

say "installing dependencies (this is the slow part)"
( cd "$WT" && "$BUN" install --prefer-offline )

# Migrations create the citext extension the schema needs; a bare CREATE DATABASE is not enough.
say "applying migrations to $DB"
if ( cd "$WT" && "$BUN" run --filter studia-web db:migrate >/dev/null 2>&1 ); then
  say "  migrated"
else
  say "  WARNING: migrations did not complete — a data-dependent ticket will need to fix this"
fi

say "done"
say "worktree=$WT"
say "branch=$BRANCH"
say "database=$DB"
