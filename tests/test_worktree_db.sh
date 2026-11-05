#!/usr/bin/env bash
# suite: worktree database (the container's port, a failed migrate made visible)
# setup-worktree.sh takes a ticket URL's port from the container, not from the primary checkout's env
# files, which may name another server on the same machine. A failed migrate keeps its output, masks
# URL passwords, prints the tail and `migrate=failed`. A kept worktree with an empty database is
# migrated again. Stub docker only; scratch HOME and repos.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME" "$T/stub"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_PG_CONTAINER DESK_PSQL_TIMEOUT DATABASE_URL DIRECT_DATABASE_URL
PASS=0; FAIL=0
check(){ if [ -n "${2:-}" ] && eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin main
# The env file is the shape that broke: credentials for the container, the port of another server.
cat > "$T/repo/.env" <<'EOF'
DATABASE_URL="postgresql://postgres:s3cret@localhost:5432/app_dev?schema=public"
DIRECT_DATABASE_URL="postgresql://postgres:s3cret@pg:5432/app_dev"
OTHER=keep
EOF
printf '.env\n.env.local\n' > "$T/repo/.gitignore"
git -C "$T/repo" add .gitignore; git -C "$T/repo" commit -q -m ignore; git -C "$T/repo" push -q origin main
cat > "$T/migrate.sh" <<EOF
#!/bin/sh
echo run >> "$T/migrate.calls"
[ ! -f "$T/migrate.fail" ] && exit 0
echo "P1010: denied for postgresql://postgres:s3cret@localhost:5433/db"; exit 1
EOF
chmod +x "$T/migrate.sh"
cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`db-per-ticket\` | A database per ticket | \`yes\` | \`yes\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`T-[0-9]+\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Project subagents sync | \`none\` |
| Env files | \`.env\` |
| Local database | \`postgres container pg\` |
| Database URL variable | \`DATABASE_URL\` \`DIRECT_DATABASE_URL\` |
| Database migrate | \`sh $T/migrate.sh\` |
EOF
# PORT_LINE: what `docker port` prints. TABLES: what the table count says.
cat > "$T/stub/docker" <<EOF
#!/bin/sh
case "\$1" in
  port) [ "\$2 \$3" = "pg 5432/tcp" ] || { echo "Error: No such container or port: \$2 \$3" >&2; exit 1; }
    cat "$T/port.line" 2>/dev/null; [ -s "$T/port.line" ] ;;
  exec) case "\$*" in
    *"pg_database"*) echo 1 ;;
    *"information_schema"*) cat "$T/tables" ;;
    *) : ;;
  esac ;;
esac
EOF
chmod +x "$T/stub/docker"
export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1
url(){ sed -nE "s/^$2=\"?([^\"]*)\"?\$/\1/p" "$T/wt/$1/.env"; }

printf '0.0.0.0:5433\n[::]:5433\n' > "$T/port.line"; echo 0 > "$T/tables"
out=$(bash "$B/setup-worktree.sh" T-1 fix/T-1 2>&1); rc=$?
check "published elsewhere: setup succeeds"                       '[ $rc -eq 0 ]'
check "published elsewhere: localhost takes the container's port" '[ "$(url T-1 DATABASE_URL)" = "postgresql://postgres:s3cret@localhost:5433/widgets_t_1?schema=public" ]'
check "published elsewhere: the container's own name keeps its internal port" '[ "$(url T-1 DIRECT_DATABASE_URL)" = "postgresql://postgres:s3cret@pg:5432/widgets_t_1" ]'
check "published elsewhere: the rewrite says which port"          '[[ "$out" == *"DATABASE_URL repointed at widgets_t_1 on port 5433"* ]]'
check "published elsewhere: a successful migrate leaves no log"   '[ ! -e "$T/wt/T-1/.desk-migrate.log" ] && [[ "$out" == *"  migrated"* ]] && [[ "$out" != *"migrate=failed"* ]]'
check "the primary checkout's env file is not touched"            'grep -q "localhost:5432/app_dev" "$T/repo/.env"'

: > "$T/port.line"
out=$(bash "$B/setup-worktree.sh" T-2 fix/T-2 2>&1); rc=$?
check "publishes nothing: the copied port stays, and it is said"  '[ $rc -eq 0 ] && [[ "$(url T-2 DATABASE_URL)" == *"@localhost:5432/widgets_t_2"* ]] && [[ "$out" == *"WARNING: pg publishes no port"* ]]'

echo '0.0.0.0:5432' > "$T/port.line"
out=$(bash "$B/setup-worktree.sh" T-3 fix/T-3 2>&1); rc=$?
check "published on 5432: unchanged"                              '[ $rc -eq 0 ] && [[ "$(url T-3 DATABASE_URL)" == *"@localhost:5432/widgets_t_3"* ]]'

echo '0.0.0.0:5433' > "$T/port.line"; touch "$T/migrate.fail"
out=$(bash "$B/setup-worktree.sh" T-4 fix/T-4 2>&1); rc=$?
check "failed migrate: setup still succeeds and hands over"       '[ $rc -eq 0 ] && [ -d "$T/wt/T-4" ] && [[ "$out" == *"worktree=$T/wt/T-4"* ]]'
check "failed migrate: the machine-read line is printed"          '[[ "$out" == *"[setup-worktree] migrate=failed"* ]]'
check "failed migrate: the error is printed, not discarded"       '[[ "$out" == *"P1010: denied"* ]] && [[ "$out" == *"WARNING: migrations did not complete"* ]]'
check "failed migrate: the output is kept in the worktree"        'grep -q "P1010: denied" "$T/wt/T-4/.desk-migrate.log"'
check "failed migrate: a URL password is masked in both"          '! grep -q s3cret "$T/wt/T-4/.desk-migrate.log" && [[ "$out" != *"s3cret"* ]] && [[ "$out" == *"postgres:***@localhost"* ]]'
check "failed migrate: the log stays out of git status"           '[ -z "$(git -C "$T/wt/T-4" status --porcelain)" ]'

# A kept worktree: migrated again where the last one failed, and it can clear the failure.
rm -f "$T/migrate.fail"; : > "$T/migrate.calls"; echo 12 > "$T/tables"
out=$(bash "$B/setup-worktree.sh" T-4 fix/T-4 2>&1); rc=$?
check "kept, last migrate failed: runs again and clears the log"  '[ $rc -eq 0 ] && [ -s "$T/migrate.calls" ] && [ ! -e "$T/wt/T-4/.desk-migrate.log" ] && [[ "$out" != *"migrate=failed"* ]]'

: > "$T/migrate.calls"; echo 12 > "$T/tables"
out=$(bash "$B/setup-worktree.sh" T-1 fix/T-1 2>&1); rc=$?
check "kept, tables present: not migrated"                        '[ $rc -eq 0 ] && [ ! -s "$T/migrate.calls" ]'

: > "$T/migrate.calls"; echo 0 > "$T/tables"
out=$(bash "$B/setup-worktree.sh" T-1 fix/T-1 2>&1); rc=$?
check "kept, database empty: migrated"                            '[ $rc -eq 0 ] && [ -s "$T/migrate.calls" ]'

: > "$T/migrate.calls"; : > "$T/tables"
out=$(bash "$B/setup-worktree.sh" T-1 fix/T-1 2>&1); rc=$?
check "kept, table count unknown: not migrated"                   '[ $rc -eq 0 ] && [ ! -s "$T/migrate.calls" ]'

# A worktree made before the port moved: its URL names the old port, and the next setup follows.
sed -i.bak 's/localhost:5433/localhost:5432/' "$T/wt/T-1/.env"; echo 12 > "$T/tables"
out=$(bash "$B/setup-worktree.sh" T-1 fix/T-1 2>&1); rc=$?
check "kept, URL on the old port: repointed"                      '[ $rc -eq 0 ] && [[ "$(url T-1 DATABASE_URL)" == *"@localhost:5433/widgets_t_1"* ]]'

echo "worktree database: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
