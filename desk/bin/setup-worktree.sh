#!/usr/bin/env bash
# Create an isolated worktree for one ticket.
#
#   setup-worktree.sh [--for-worker] <TICKET> <branch>
#
# --for-worker   the worktree is for a detached autopilot worker (pass.mjs sets it). The primary
#                checkout's .claude/settings.local.json (the human's own harness allow rules) is then
#                NOT copied in, and an existing copy is disabled: a worker's permissions come only
#                from the settings file spawn-worker.sh generates.
#
# Everything repo-specific comes from this repo's desk config (desk-env), never from this file:
#   §0 Default branch          the base a new branch is cut from (origin/<default>)
#   §4 Env files               copied from the primary checkout by copy-env.sh
#   §4 Command prefix          put in front of every toolchain command (`none` = nothing)
#   §4 Install                 run in the new worktree, each item in its directory (`none` = skip; unset = refuse)
#   §4 Project subagents sync  run so .claude/agents is populated before a worker starts (`none` = skip)
#   §4 Local database          `postgres container <name>`: a per-ticket database, gated on §3 db-per-ticket
#   §4 Database URL variable   every variable repointed at that database, or blanked when there is none
#   §4 Database migrate        run against the per-ticket database only
#
# DESK_PSQL_TIMEOUT (seconds, default 30) limits each psql call, so a wedged container fails setup.
#
# Databases, the rule: in a worktree's copied env files, every §4 Database URL variable either points
# at this ticket's own local database or is blank. A URL whose host is not local (a hosted, staging or
# production database) is never rewritten into a local one: it is blanked. So is every variable when
# no per-ticket database was provisioned. No worktree can reach a shared database through its env files.
#
# Atomic: a failure after `git worktree add` removes the worktree (and the branch and database, when
# this run created them), so a half-built worktree is never mistaken for a ready one. A run killed
# outright leaves `.desk-setup-incomplete` in the worktree, and the next run finishes the setup rather
# than reporting the worktree as ready.
#
# Ordering is load-bearing: env files must land before the install, because an install step can run
# code generation that hard-fails without them.
#
# The last lines printed are machine-read by pass.mjs: `worktree=`, `branch=`, `database=`
# (`database=<name>` only when that per-ticket database exists; otherwise `database=none`).
set -euo pipefail

PG_CONTAINER_ENV="${DESK_PG_CONTAINER:-}"   # an explicit env override beats the config text below
# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"
desk_take_batch "$@" || exit 2
set -- ${DESK_ARGS[@]+"${DESK_ARGS[@]}"}
FOR_WORKER=""
if [ "${1:-}" = "--for-worker" ]; then FOR_WORKER=1; shift; fi
TICKET="${1:?usage: setup-worktree.sh [--for-worker] [--batch <name>] <TICKET> <branch>}"
BRANCH="${2:?usage: setup-worktree.sh [--for-worker] [--batch <name>] <TICKET> <branch>}"

# The ticket names a directory and a database: its shape is checked first (no /, no ..).
node "$DESK_ENV_MJS" ticket-kind "$TICKET" >/dev/null || exit 2
desk_load_paths || exit 1

MAIN="$DESK_REPO_ROOT"
WT="$DESK_WORKTREES_DIR/$TICKET"
BASE="origin/$DESK_DEFAULT_BRANCH"
MARKER="$WT/.desk-setup-incomplete"

say() { printf '[setup-worktree] %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
is_none() { case "$(lc "$1")" in none|none\ *|none\(*) return 0 ;; esac; return 1; }
# A config row desk-env.mjs does not know yet (it exits non-zero on an unknown id) reads as the fallback.
cfg_opt() { local v; if v="$(desk_cfg "$1" 2>/dev/null)" && [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "${2:-}"; fi; }
# cfg_items list|cmds <id>: the row's items in ROW, returning non-zero when it is unset. A row desk-env
# refuses (exit 4: `none` beside other items) fails setup with desk-env's own message, so `none` is
# never run as a command and a note in backticks is never read as a value.
cfg_items() {
  local rc=0
  ROW="$(node "$DESK_ENV_MJS" "$1" "$2" 2>/dev/null)" || rc=$?
  [ "$rc" != 4 ] || fail "$(node "$DESK_ENV_MJS" "$1" "$2" 2>&1 >/dev/null || true)"
  [ "$rc" = 0 ]
}

case "$BRANCH" in
  -*|*..*|*' '*|*'<'*|*'>'*|*.lock|/*|*/) fail "branch '$BRANCH' is not a usable branch name" ;;
esac
[ "$BRANCH" != "$DESK_DEFAULT_BRANCH" ] || fail "refusing to set up a ticket worktree on the default branch ($BRANCH)"
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || fail "branch '$BRANCH' is not a valid git branch name"

# ---- toolchain ---------------------------------------------------------------------------------
# A detached worker's shell does not get an interactive shell's PATH injection (mise, asdf, nvm), which
# is what §4 Command prefix is for. Unset reads as no prefix, said out loud.
if PREFIX="$(desk_cfg command-prefix 2>/dev/null)"; then
  is_none "$PREFIX" && PREFIX=""
else
  PREFIX=""; say "note: config §4 Command prefix is unset — running toolchain commands bare"
fi
# Command rows as `DIR<TAB>CMD` lines (desk-env cmds): an item may name the directory it runs in.
cfg_items cmds install-cmd || \
  fail "config §4 Install is not set — run /desk-setup (write \`none\` if there is no install step). Refusing to guess."
INSTALL_CMDS="$ROW"
AGENTS_UNSET=""
if cfg_items cmds agents-sync; then AGENTS_CMDS="$ROW"; else AGENTS_UNSET=1; AGENTS_CMDS=""; fi
cfg_items cmds db-migrate-cmd || true
MIGRATE_CMDS="$ROW"

# Fail before creating anything if the toolchain cannot even be found.
if [ -n "$INSTALL_CMDS" ]; then
  first="$(printf '%s' "${PREFIX:-$(printf '%s\n' "$INSTALL_CMDS" | head -1 | cut -f2)}" | awk '{print $1}')"
  command -v "$first" >/dev/null 2>&1 \
    || fail "'$first' not found on PATH (config §4 Command prefix / Install). A detached shell has no interactive PATH setup."
fi

run_tool() { # run_tool <dir relative to the worktree> <configured command>
  ( cd "$WT/$1" && sh -c "${PREFIX:+$PREFIX }$2" )
}
run_cmds() { # run_cmds <DIR<TAB>CMD lines> — every item, each in its directory; stops at the first failure
  local d c
  while IFS="$(printf '\t')" read -r d c; do
    [ -n "$c" ] || continue
    say "  $d: $c"
    run_tool "$d" "$c" || return 1
  done <<EOF_CMDS
$1
EOF_CMDS
}

# Claude Code harness allow rules written by /desk-setup for this repo live in the primary checkout's
# .claude/settings.local.json (gitignored). A worktree a PERSON works in needs the same rules, and a
# revocation must reach it too, so this is refreshed every time, keeping the previous copy. A worker's
# worktree must never carry them: they are the human's grants (the merge driver among them), and the
# worker's own generated settings are its whole permission surface.
sync_local_settings() {
  local src="$MAIN/.claude/settings.local.json" dst="$WT/.claude/settings.local.json"
  if [ -n "$FOR_WORKER" ]; then
    if [ -f "$dst" ]; then
      mv "$dst" "$dst.desk-disabled"
      say "disabled .claude/settings.local.json in this worker's worktree (kept as settings.local.json.desk-disabled)"
    fi
    return 0
  fi
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
  if [ -z "$AGENTS_CMDS" ]; then
    if [ -n "$AGENTS_UNSET" ]; then say "  WARNING: config §4 Project subagents sync is unset — named subagents may be general-purpose"
    else say "  config §4 Project subagents sync is none — skipped"; fi
    return 0
  fi
  if ! run_cmds "$AGENTS_CMDS" >/dev/null 2>&1; then
    [ "$1" = strict ] && fail "subagents sync errored in $WT"
    say "  subagents sync failed in $WT"; return 0
  fi
  local n
  n=$(find "$WT/.claude/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then say "  $n agent(s) linked"
  elif [ "$1" = strict ]; then fail ".claude/agents still empty after the subagents sync"
  else say "  WARNING: .claude/agents still empty after the subagents sync"; fi
}

# ---- per-ticket database plan ------------------------------------------------------------------
LOCAL_DB="$(cfg_opt local-db '')"
DB_VARS_UNSET=""
if cfg_items list db-url-var; then DB_VARS="$ROW"; else DB_VARS=""; DB_VARS_UNSET=1; fi
is_none "$(printf '%s' "$DB_VARS" | head -1)" && DB_VARS=""
DB_VARS="$(printf '%s\n' "$DB_VARS" | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' || true)"
if [ -n "$DB_VARS_UNSET" ]; then
  if [ -n "$FOR_WORKER" ]; then
    fail "config §4 Database URL variable is not set — run /desk-setup (write \`none\` if the repo has no database). A worker's worktree must not inherit a database URL nobody has named."
  fi
  say "WARNING: config §4 Database URL variable is unset — env files are copied unchanged, so this worktree uses whatever database they name"
fi
# The toolchain commands below (install, migrate) must not pick a database URL up from this shell.
while IFS= read -r v; do [ -n "$v" ] && unset "$v"; done <<EOF_VARS
$DB_VARS
EOF_VARS

PG_CONTAINER="$(printf '%s' "$LOCAL_DB" | sed -nE 's/^[Pp]ostgres[[:space:]]+container[[:space:]]+([A-Za-z0-9_.-]+)[[:space:]]*$/\1/p')"
[ -n "$PG_CONTAINER_ENV" ] && [ -n "$PG_CONTAINER" ] && PG_CONTAINER="$PG_CONTAINER_ENV"
REPO_PART="$(lc "${DESK_GH_REPO#*/}" | tr -c 'a-z0-9\n' '_' | tr -d '\n')"
TICKET_PART="$(lc "$TICKET" | tr -c 'a-z0-9\n' '_' | tr -d '\n')"
DB="$(printf '%s_%s' "$REPO_PART" "$TICKET_PART" | cut -c1-63)"   # Postgres identifiers cap at 63
DB_MODE=none
if [ -z "$LOCAL_DB" ]; then
  say "note: config §4 Local database is unset — no per-ticket database (run /desk-setup to set it, or \`none\`)"
elif is_none "$LOCAL_DB"; then
  say "config §4 Local database is none — no per-ticket database"
elif [ -z "$PG_CONTAINER" ]; then
  say "note: §4 Local database is '$LOCAL_DB', not \`postgres container <name>\` — per-ticket databases are not automated for it"
elif [ "$(desk_perm db-per-ticket)" != yes ]; then
  say "note: config §3 db-per-ticket is $(desk_perm db-per-ticket) — no per-ticket database"
elif [ -z "$DB_VARS" ]; then
  say "note: config §4 Database URL variable names nothing — no variable to point at a per-ticket database, so none is made"
else
  DB_MODE=ticket
fi
[ "$DB_MODE" = ticket ] || [ -z "$DB_VARS" ] || say "every §4 Database URL variable ($(printf '%s' "$DB_VARS" | paste -sd ' ' -)) will be blanked in the copied env files"

cfg_items list env-files || true
ENV_FILES="$ROW"
is_none "$(printf '%s' "$ENV_FILES" | head -1)" && ENV_FILES=""

# Repoint (ticket) or blank (none) every listed variable in every copied env file, then verify.
# A non-local URL is blanked, never rewritten. Prints one line per change; exits 1 if the result is
# not what the rule says.
rewrite_env() { # rewrite_env ticket|blank
  node - "$1" "$WT" "$DB" "$PG_CONTAINER" "$DB_VARS" "$ENV_FILES" <<'NODE'
const fs = require('fs');
const path = require('path');
const [mode, wt, db, container, varsRaw, filesRaw] = process.argv.slice(2);
const vars = varsRaw.split('\n').filter(Boolean);
const files = filesRaw.split('\n').filter(Boolean);
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal', container].filter(Boolean).map((h) => h.toLowerCase()));
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]*)@)?(\[[^\]]*\]|[^/:?#]*)(:\d+)?(\/[^?#]*)?(\?[^#]*)?$/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `(.*)` cannot match a trailing \r, so a CRLF file (common on WSL) would skip every line and keep
// its production URL. Lines are matched with the \r removed; a rewritten or blanked line is written back with a plain \n.
const lineRe = new RegExp(`^(\\s*(?:export\\s+)?)(${vars.map(esc).join('|')})(\\s*=\\s*)(.*?)\\r?$`);
let bad = 0;
let touched = 0;
function target(value) {
  let q = '';
  let v = value.trim();
  const m = /^(['"])(.*)\1\s*(#.*)?$/.exec(v);
  if (m) { q = m[1]; v = m[2]; } else v = v.replace(/\s+#.*$/, '');
  if (mode === 'blank' || v === '') return { out: '', what: 'blanked' };
  const u = URL_RE.exec(v);
  if (u) {
    const host = u[3].toLowerCase();
    if (!LOCAL.has(host)) return { out: '', what: `blanked (host ${u[3]} is not local, so it is never rewritten)` };
    return { out: `${q}${u[1]}://${u[2] != null ? `${u[2]}@` : ''}${u[3]}${u[4] ?? ''}/${db}${u[6] ?? ''}${q}`, what: `repointed at ${db}` };
  }
  if (/^[A-Za-z0-9_]+$/.test(v)) return { out: `${q}${db}${q}`, what: `set to ${db}` };
  return { out: '', what: 'blanked (not a URL or a database name)' };
}
function ok(value) {
  const v = value.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (v === '') return true;
  if (mode === 'blank') return false;
  const u = URL_RE.exec(v);
  if (u) return LOCAL.has(u[3].toLowerCase()) && (u[5] ?? '') === `/${db}`;
  return v === db;
}
if (vars.length) {
  for (const rel of files) {
    const f = path.join(wt, rel);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lineRe.exec(lines[i]);
      if (!m) continue;
      const t = target(m[4]);
      const next = `${m[1]}${m[2]}=${t.out}`;
      if (next !== lines[i]) { lines[i] = next; changed = true; }
      console.log(`[setup-worktree]   ${rel}: ${m[2]} ${t.what}`);
      touched++;
    }
    if (changed) fs.writeFileSync(f, lines.join('\n'));
    // Verify from disk, not from what was meant to be written.
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = lineRe.exec(l);
      if (m && !ok(m[4])) { console.error(`FAIL: ${rel}: ${m[2]} still holds a value outside this ticket's database`); bad++; }
    }
  }
}
if (!touched && vars.length) console.log(`[setup-worktree]   no copied env file sets ${vars.join(', ')}`);
process.exit(bad ? 1 : 0);
NODE
}

pg_user() { # the user in the first local database URL the primary checkout's env files name, else postgres
  local rel u
  while IFS= read -r rel; do
    [ -n "$rel" ] && [ -f "$MAIN/$rel" ] || continue
    u="$(sed -nE 's#^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=["'"'"']?[a-z0-9+.-]+://([^:@/]+)(:[^@/]*)?@(localhost|127\.0\.0\.1|'"$PG_CONTAINER"')[:/].*#\2#p' "$MAIN/$rel" | head -1)"
    [ -n "$u" ] && { printf '%s' "$u"; return; }
  done <<EOF_FILES
$ENV_FILES
EOF_FILES
  printf 'postgres'
}
# Every psql call runs under this limit: a stopped or wedged container must fail setup, not hang it.
PSQL_LIMIT="${DESK_PSQL_TIMEOUT:-30}"
case "$PSQL_LIMIT" in ''|*[!0-9]*|0) fail "DESK_PSQL_TIMEOUT='$PSQL_LIMIT' is not a positive number of seconds" ;; esac
pg() { # pg <user> <psql args...>: psql against the postgres database in the container, time-limited
  local u="$1"; shift
  desk_timeout "$PSQL_LIMIT" docker exec "$PG_CONTAINER" psql -U "$u" -d postgres "$@"
}
pg_why() { # pg_why <exit status>: what a failed pg call means, for the FAIL line (137: timeout(1) had to KILL)
  case "$1" in
    124|137) printf 'psql in container %s did not answer within %ss' "$PG_CONTAINER" "$PSQL_LIMIT" ;;
    *)       printf 'psql in container %s exited %s' "$PG_CONTAINER" "$1" ;;
  esac
}
CREATED_DB=""
ensure_db() { # the per-ticket database exists, or setup fails
  command -v docker >/dev/null 2>&1 || fail "docker is not on PATH — cannot create $DB in $PG_CONTAINER"
  local user; user="$(pg_user)"
  local have rc=0
  have="$(pg "$user" -Atc "SELECT 1 FROM pg_database WHERE datname = '$DB'" 2>/dev/null)" || rc=$?
  [ "$rc" = 0 ] \
    || fail "cannot reach Postgres in container $PG_CONTAINER as $user: $(pg_why "$rc") (is it running? §4 Local database names it as \`postgres container <name>\`)"
  if [ "$have" = 1 ]; then say "  database $DB already exists"; return 0; fi
  pg "$user" -c "CREATE DATABASE \"$DB\"" >/dev/null || { rc=$?; fail "could not create database $DB: $(pg_why "$rc")"; }
  CREATED_DB="$user"
  say "  created database $DB in $PG_CONTAINER"
}

databases() { # provision (or confirm) the database and make every env file follow the rule
  if [ "$DB_MODE" = ticket ]; then
    say "per-ticket database $DB"
    ensure_db
    rewrite_env ticket || fail "database variables could not be repointed at $DB"
  elif [ -n "$DB_VARS" ]; then
    say "blanking database variables (no per-ticket database)"
    rewrite_env blank || fail "database variables could not be blanked"
  fi
}

# ---- failure cleanup -----------------------------------------------------------------------------
CREATED_WT=""; CREATED_BRANCH=""
cleanup() {
  local rc=$?
  [ "$rc" -ne 0 ] && [ -n "$CREATED_WT" ] || return 0
  say "setup failed (exit $rc) — removing the half-built worktree so it is never mistaken for a ready one"
  git -C "$MAIN" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  git -C "$MAIN" worktree prune >/dev/null 2>&1 || true
  if [ -n "$CREATED_BRANCH" ]; then git -C "$MAIN" branch -D "$BRANCH" >/dev/null 2>&1 && say "  removed branch $BRANCH (this run created it)"; fi
  if [ -n "$CREATED_DB" ]; then pg "$CREATED_DB" -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null 2>&1 && say "  dropped database $DB (this run created it)"; fi
  return 0
}
trap cleanup EXIT

finish() {
  rm -f "$MARKER"
  say "done"
  say "worktree=$WT"
  say "branch=$BRANCH"
  case "$DB_MODE" in ticket) say "database=$DB" ;; *) say "database=none" ;; esac
}

mkdir -p "$DESK_WORKTREES_DIR"

if [ -d "$WT" ] && [ ! -f "$MARKER" ]; then
  say "worktree already exists at $WT — leaving its code alone"
  have_branch="$(git -C "$WT" branch --show-current 2>/dev/null || true)"
  [ "$have_branch" = "$BRANCH" ] || fail "$WT is on branch '${have_branch:-?}', not $BRANCH — refusing to hand it out for this ticket"
  # ...but ALWAYS re-sync the harness rules and the agent links (a worktree created before either
  # existed has none), and re-apply the database rule, so the `database=` line below is true now.
  sync_local_settings
  sync_agents lenient
  databases
  finish
  exit 0
fi

if [ -d "$WT" ]; then
  # A previous run was killed between creating the worktree and finishing. Finish it now, and treat
  # it as ours to remove if this attempt fails too.
  say "found $MARKER — a previous setup did not finish; completing it"
  grep -q '^created_branch=1' "$MARKER" 2>/dev/null && CREATED_BRANCH=1
  CREATED_WT=1
else
  git -C "$MAIN" fetch origin --quiet
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    say "branch $BRANCH already exists — checking it out into the worktree"
    git -C "$MAIN" worktree add "$WT" "$BRANCH" --quiet
  else
    say "creating $BRANCH off $BASE"
    git -C "$MAIN" worktree add -b "$BRANCH" "$WT" "$BASE" --quiet
    CREATED_BRANCH=1
  fi
  CREATED_WT=1
  printf 'ticket=%s\nbranch=%s\ncreated_branch=%s\nstarted=%s\n' "$TICKET" "$BRANCH" "${CREATED_BRANCH:-0}" "$(date -u +%FT%TZ)" > "$MARKER"
  # Keep the marker out of `git status` without touching the repo's .gitignore.
  excl="$(git -C "$WT" rev-parse --git-path info/exclude)"
  case "$excl" in /*) ;; *) excl="$WT/$excl" ;; esac
  mkdir -p "$(dirname "$excl")"; grep -qxF '/.desk-setup-incomplete' "$excl" 2>/dev/null || echo '/.desk-setup-incomplete' >> "$excl"
fi

# copy-env.sh finds the primary checkout via the shared git common dir, so it is
# portable and must run from inside the new worktree.
say "seeding env files"
( cd "$WT" && bash "$DESK_ENV_DIR/copy-env.sh" )

sync_local_settings
databases

if [ -n "$INSTALL_CMDS" ]; then
  say "installing dependencies (this is the slow part)"
  run_cmds "$INSTALL_CMDS" || fail "config §4 Install failed in $WT"
else
  say "config §4 Install is none — no install step"
fi

say "linking subagents"
sync_agents strict

if [ "$DB_MODE" = ticket ]; then
  if [ -z "$MIGRATE_CMDS" ]; then
    say "note: no database migrate command configured — $DB is empty; a data-dependent ticket will need to migrate it"
  else
    say "applying migrations to $DB"
    if run_cmds "$MIGRATE_CMDS" >/dev/null 2>&1; then say "  migrated"
    else say "  WARNING: migrations did not complete — a data-dependent ticket will need to fix this"; fi
  fi
fi

finish
