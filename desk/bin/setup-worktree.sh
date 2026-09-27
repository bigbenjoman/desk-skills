#!/usr/bin/env bash
# Create an isolated worktree for one ticket.
#
#   setup-worktree.sh <TICKET> <branch>
#
# Everything repo-specific comes from this repo's desk config (desk-env), never from this file:
#   §0 Default branch         the base a new branch is cut from (origin/<default>)
#   §4 Env files              copied from the primary checkout by copy-env.sh
#   §4 Command prefix         put in front of every toolchain command (`none` = nothing)
#   §4 Install                run in the new worktree (`none` = skip; unset = refuse)
#   §4 Project subagents sync run so .claude/agents is populated before a worker starts (`none` = skip)
#   §4 Local database         Postgres in docker -> a per-ticket database (`none` = skip), gated on §3 db-per-ticket
#
# Ordering is load-bearing: env files must land before the install, because an install step can run
# code generation that hard-fails without them. The database URL is then repointed at a per-ticket
# database so a seed or a database-backed test in one worktree cannot wipe another worktree's data.
#
# The last lines printed are machine-read by pass.mjs: `worktree=`, `branch=`, `database=`
# (`database=none` when the repo has no local database, `database=shared` when one exists but no
# per-ticket database was made).
set -euo pipefail

TICKET="${1:?usage: setup-worktree.sh <TICKET> <branch>}"
BRANCH="${2:?usage: setup-worktree.sh <TICKET> <branch>}"

# The ticket names a directory; never let it climb out of the worktrees dir.
case "$TICKET" in
  */*|.*|*..*|'') echo "FAIL: ticket '$TICKET' is not usable as a directory name" >&2; exit 2 ;;
esac

PG_CONTAINER_ENV="${DESK_PG_CONTAINER:-}"   # an explicit env override beats the config text below
# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"
desk_load_paths || exit 1

MAIN="$DESK_REPO_ROOT"
WT="$DESK_WORKTREES_DIR/$TICKET"
BASE="origin/$DESK_DEFAULT_BRANCH"

say() { printf '[setup-worktree] %s\n' "$*"; }
lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
is_none() { case "$(lc "$1")" in none|none\ *|none\(*) return 0 ;; esac; return 1; }
# A config row desk-env.mjs does not know yet (it exits non-zero on an unknown id) reads as the fallback.
cfg_opt() { local v; if v="$(desk_cfg "$1" 2>/dev/null)" && [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "${2:-}"; fi; }

# ---- toolchain ---------------------------------------------------------------------------------
# A detached worker's shell does not get an interactive shell's PATH injection (mise, asdf, nvm), which
# is what §4 Command prefix is for. Unset reads as no prefix, said out loud.
if PREFIX="$(desk_cfg command-prefix 2>/dev/null)"; then
  is_none "$PREFIX" && PREFIX=""
else
  PREFIX=""; say "note: config §4 Command prefix is unset — running toolchain commands bare"
fi
if ! INSTALL="$(desk_cfg install-cmd 2>/dev/null)"; then
  echo "FAIL: config §4 Install is not set — run /desk-setup (write \`none\` if there is no install step). Refusing to guess." >&2
  exit 1
fi
is_none "$INSTALL" && INSTALL=""
AGENTS_SYNC="$(cfg_opt agents-sync '')"
AGENTS_SYNC_UNSET=""
[ -z "$AGENTS_SYNC" ] && AGENTS_SYNC_UNSET=1
is_none "${AGENTS_SYNC:-none}" && AGENTS_SYNC=""

# Fail before creating anything if the toolchain cannot even be found.
if [ -n "$INSTALL" ]; then
  first="$(printf '%s' "${PREFIX:-$INSTALL}" | awk '{print $1}')"
  command -v "$first" >/dev/null 2>&1 \
    || { echo "FAIL: '$first' not found on PATH (config §4 Command prefix / Install). A detached shell has no interactive PATH setup." >&2; exit 1; }
fi

run_tool() { # run_tool <dir> <configured command>
  ( cd "$1" && sh -c "${PREFIX:+$PREFIX }$2" )
}

# Claude Code harness allow rules written by /desk-setup for this repo live in the primary checkout's
# .claude/settings.local.json (gitignored). A worktree needs the same rules, and a revocation must
# reach an existing worktree too, so this is refreshed every time, keeping the previous copy.
sync_local_settings() {
  local src="$MAIN/.claude/settings.local.json" dst="$WT/.claude/settings.local.json"
  [ -f "$src" ] || { say "no $src — no per-repo harness rules to copy"; return 0; }
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then return 0; fi
  mkdir -p "$WT/.claude"
  [ -f "$dst" ] && cp "$dst" "$dst.bak"
  cp "$src" "$dst"
  say "copied .claude/settings.local.json from the primary checkout"
}

# .claude/agents is typically gitignored, so a fresh worktree has no agent links and every named
# subagent silently resolves to general-purpose — including a review's refuter, which turns an
# adversarial pass into one model checking its own work. A `claude -p` worker loads its agent
# registry once at startup, so this must happen before the spawn.
sync_agents() { # sync_agents strict|lenient
  if [ -z "$AGENTS_SYNC" ]; then
    if [ -n "$AGENTS_SYNC_UNSET" ]; then say "  WARNING: config §4 Project subagents sync is unset — named subagents may be general-purpose"
    else say "  config §4 Project subagents sync is none — skipped"; fi
    return 0
  fi
  if ! run_tool "$WT" "$AGENTS_SYNC" >/dev/null 2>&1; then
    [ "$1" = strict ] && { echo "FAIL: subagents sync ($AGENTS_SYNC) errored in $WT" >&2; exit 1; }
    say "  subagents sync failed in $WT"; return 0
  fi
  local n
  n=$(find "$WT/.claude/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then say "  $n agent(s) linked"
  elif [ "$1" = strict ]; then echo "FAIL: .claude/agents still empty after '$AGENTS_SYNC'" >&2; exit 1
  else say "  WARNING: .claude/agents still empty after '$AGENTS_SYNC'"; fi
}

# ---- per-ticket database plan ------------------------------------------------------------------
# Only Postgres in a docker container is automated. Anything else is reported and left alone.
LOCAL_DB="$(cfg_opt local-db '')"
DB_VAR="$(cfg_opt db-url-var DATABASE_URL)"
DB_MIGRATE="$(cfg_opt db-migrate-cmd '')"
REPO_NAME="$(lc "${DESK_GH_REPO#*/}")"
TICKET_PART="$(lc "$TICKET" | tr -cd 'a-z0-9')"
DB="$(printf '%s_%s' "$REPO_NAME" "$TICKET_PART" | cut -c1-63)"   # Postgres identifiers cap at 63
DB_MODE=none
if [ -z "$LOCAL_DB" ]; then
  say "note: config §4 Local database is unset — no per-ticket database (run /desk-setup to set it, or \`none\`)"
elif is_none "$LOCAL_DB"; then
  :
elif ! printf '%s' "$LOCAL_DB" | grep -qiE 'postgres|psql'; then
  say "note: §4 Local database is not Postgres ($LOCAL_DB) — per-ticket databases are not automated for it"
  DB_MODE=shared
elif [ "$(desk_perm db-per-ticket)" != yes ]; then
  say "note: config §3 db-per-ticket is $(desk_perm db-per-ticket) — no per-ticket database; §3 tests-shared-db governs database-backed tests"
  DB_MODE=shared
else
  DB_MODE=ticket
fi
PG_CONTAINER="$PG_CONTAINER_ENV"
if [ -z "$PG_CONTAINER" ]; then
  PG_CONTAINER="$(printf '%s' "$LOCAL_DB" | grep -oE 'container[ =:]+[A-Za-z0-9_.-]+' | head -1 | sed -E 's/^container[ =:]+//' || true)"
fi
PG_CONTAINER="${PG_CONTAINER:-$DESK_PG_CONTAINER}"

mkdir -p "$DESK_WORKTREES_DIR"

if [ -d "$WT" ]; then
  say "worktree already exists at $WT — leaving it alone"
  # ...but ALWAYS re-sync the harness rules and the agent links: a worktree created before either
  # existed has none, and syncing after the worker starts is too late. Cheap and idempotent.
  sync_local_settings
  sync_agents lenient
  case "$DB_MODE" in ticket) say "database=$DB" ;; *) say "database=$DB_MODE" ;; esac
  exit 0
fi

git -C "$MAIN" fetch origin --quiet

if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  say "branch $BRANCH already exists — checking it out into the worktree"
  git -C "$MAIN" worktree add "$WT" "$BRANCH" --quiet
else
  say "creating $BRANCH off $BASE"
  git -C "$MAIN" worktree add -b "$BRANCH" "$WT" "$BASE" --quiet
fi

# copy-env.sh finds the primary checkout via the shared git common dir, so it is
# portable and must run from inside the new worktree.
say "seeding env files"
( cd "$WT" && bash "$DESK_ENV_DIR/copy-env.sh" )

sync_local_settings

# ---- per-ticket database -------------------------------------------------------------------------
if [ "$DB_MODE" = ticket ]; then
  # The env file that carries the database URL: the first §4 Env files entry that defines it.
  ENV_FILE=""
  set -f
  for rel in $(desk_cfg env-files 2>/dev/null | tr ',;' '  '); do
    if [ -f "$WT/$rel" ] && grep -q "^$DB_VAR=" "$WT/$rel"; then ENV_FILE="$WT/$rel"; break; fi
  done
  set +f
  if [ -z "$ENV_FILE" ]; then
    say "WARNING: no §4 Env files entry defines $DB_VAR — cannot repoint it; the worktree uses whatever database its env names"
    DB_MODE=shared
  fi
fi

if [ "$DB_MODE" = ticket ]; then
  # The database the primary checkout uses, which a worktree must never point at.
  MAIN_ENV="$MAIN/${ENV_FILE#"$WT/"}"
  SHARED_DB="$(sed -nE "s#^$DB_VAR=\"?.*/([^/?\"]+).*#\\1#p" "$MAIN_ENV" 2>/dev/null | head -1)"
  PG_USER="$(sed -nE "s#^$DB_VAR=\"?[a-z]+://([^:@/]+)[:@].*#\\1#p" "$ENV_FILE" | head -1)"
  PG_USER="${PG_USER:-postgres}"

  say "repointing $DB_VAR at $DB"
  desk_sed_inplace "s#^($DB_VAR=\"?.*/)[^/?\"]+(\\?[^\"]*)?(\"?)\$#\\1$DB\\2\\3#" "$ENV_FILE"

  if ! grep -q "^$DB_VAR=.*/$DB" "$ENV_FILE"; then
    echo "FAIL: $DB_VAR rewrite did not take in $ENV_FILE" >&2; exit 1
  fi
  if [ -n "$SHARED_DB" ] && [ "$SHARED_DB" != "$DB" ] && grep -q "^$DB_VAR=.*/$SHARED_DB\([?\"]\|\$\)" "$ENV_FILE"; then
    echo "FAIL: $DB_VAR still points at the shared $SHARED_DB" >&2; exit 1
  fi

  # Allocating a name is not provisioning: create it, and let migrations bring it up properly.
  say "provisioning database $DB in container $PG_CONTAINER"
  if ! command -v docker >/dev/null 2>&1; then
    say "  WARNING: docker is not on PATH — $DB not created; a worker needing data will have to"
  elif docker exec "$PG_CONTAINER" psql -U "$PG_USER" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB"; then
    say "  already exists — leaving it alone"
  elif docker exec "$PG_CONTAINER" psql -U "$PG_USER" -c "CREATE DATABASE \"$DB\"" >/dev/null 2>&1; then
    say "  created"
  else
    say "  WARNING: could not create $DB (is $PG_CONTAINER running? name it in §4 Local database as \`container <name>\`, or set DESK_PG_CONTAINER) — a worker needing data will have to"
  fi
fi

if [ -n "$INSTALL" ]; then
  say "installing dependencies (this is the slow part)"
  run_tool "$WT" "$INSTALL"
else
  say "config §4 Install is none — no install step"
fi

say "linking subagents"
sync_agents strict

if [ "$DB_MODE" = ticket ]; then
  if [ -z "$DB_MIGRATE" ] || is_none "$DB_MIGRATE"; then
    say "note: no database migrate command configured — $DB is empty; a data-dependent ticket will need to migrate it"
  else
    say "applying migrations to $DB"
    if run_tool "$WT" "$DB_MIGRATE" >/dev/null 2>&1; then say "  migrated"
    else say "  WARNING: migrations did not complete — a data-dependent ticket will need to fix this"; fi
  fi
fi

say "done"
say "worktree=$WT"
say "branch=$BRANCH"
case "$DB_MODE" in ticket) say "database=$DB" ;; *) say "database=$DB_MODE" ;; esac
