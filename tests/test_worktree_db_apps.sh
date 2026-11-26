#!/usr/bin/env bash
# suite: worktree database per app (a database, migrate and seed for each app the config names)
# layer: L2
# A §4 Database URL variable item that names its app's directory gives that app a per-ticket database
# of its own. Each env file follows the deepest app holding it, each app's migrate then seed run
# against its own database, a failure names the app and database, and a failed setup drops every
# database it made. Stub docker only; scratch HOME and repos.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME" "$T/stub"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_PG_CONTAINER DESK_PSQL_TIMEOUT DESK_PSQL_RETRY_S DESK_GH_REPO DATABASE_URL WEB_DATABASE_URL
export DESK_INSTALL_RETRY_DELAY_S=0
PASS=0; FAIL=0
check(){ if [ -n "${2:-}" ] && eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"
mkdir -p "$T/repo/apps/portal/apps/web" "$T/repo/apps/portal/packages/db"
printf '.env\n.env.local\n' > "$T/repo/.gitignore"
git -C "$T/repo" add .gitignore; git -C "$T/repo" commit -q -m init
git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin main
# The root app's env file, the portal's package env file, and the portal web app's, whose URL names a
# port where nothing listens. WEB_DATABASE_URL is the root app's even inside the portal.
cat > "$T/repo/.env" <<'EOF'
DATABASE_URL="postgresql://postgres:s3cret@localhost:5432/web_dev"
WEB_DATABASE_URL="postgresql://postgres:s3cret@localhost:5432/web_dev"
EOF
cat > "$T/repo/apps/portal/packages/db/.env" <<'EOF'
DATABASE_URL="postgresql://postgres:s3cret@localhost:5432/portal_dev"
EOF
cat > "$T/repo/apps/portal/apps/web/.env.local" <<'EOF'
DATABASE_URL="postgresql://postgres:s3cret@localhost:5433/portal_dev"
WEB_DATABASE_URL="postgresql://postgres:s3cret@localhost:5432/web_dev"
EOF
# migrate.sh / seed.sh: record which database the env file in the command's directory names; fail
# where $T/fail.<step>.<db> exists.
for step in migrate seed; do
  cat > "$T/$step.sh" <<EOF
#!/bin/sh
db=\$(sed -nE 's#^DATABASE_URL="?[^"]*/([a-z0-9_]+)"?\$#\1#p' .env)
echo "$step \$db" >> "$T/calls"
[ ! -f "$T/fail.$step.\$db" ] && exit 0
echo "P1010: denied for postgresql://postgres:s3cret@localhost:5432/\$db"; exit 1
EOF
  chmod +x "$T/$step.sh"
done
cat > "$T/install.sh" <<EOF
#!/bin/sh
[ ! -f "$T/install.fail" ] && exit 0
echo "install broke"; exit 1
EOF
chmod +x "$T/install.sh"
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
| Install | \`sh $T/install.sh\` |
| Project subagents sync | \`none\` |
| Env files | \`.env\` \`apps/portal/packages/db/.env\` \`apps/portal/apps/web/.env.local\` |
| Local database | \`postgres container pg\` |
| Database URL variable | \`DATABASE_URL\` \`WEB_DATABASE_URL\` \`apps/portal: DATABASE_URL\` |
| Database migrate | \`sh $T/migrate.sh\` \`apps/portal/packages/db: sh $T/migrate.sh\` |
| Seed | \`sh $T/seed.sh\` \`apps/portal/packages/db: sh $T/seed.sh\` |
EOF
# Databases exist as files $T/db.<name>; CREATE and DROP are logged to $T/pg.log.
cat > "$T/stub/docker" <<EOF
#!/bin/sh
case "\$1" in
  port) echo '0.0.0.0:5432' ;;
  container) echo running ;;
  exec) case "\$*" in
    *"pg_database"*) n=\$(printf '%s' "\$*" | sed -nE "s/.*datname = '([a-z0-9_]+)'.*/\1/p")
      [ -f "$T/db.\$n" ] && echo 1; exit 0 ;;
    *"CREATE DATABASE"*) n=\$(printf '%s' "\$*" | sed -nE 's/.*CREATE DATABASE "([a-z0-9_]+)".*/\1/p')
      touch "$T/db.\$n"; echo "create \$n" >> "$T/pg.log" ;;
    *"DROP DATABASE"*) n=\$(printf '%s' "\$*" | sed -nE 's/.*DROP DATABASE IF EXISTS "([a-z0-9_]+)".*/\1/p')
      rm -f "$T/db.\$n"; echo "drop \$n" >> "$T/pg.log" ;;
    *"information_schema"*) n=\$(printf '%s' "\$*" | sed -nE 's/.* -d ([a-z0-9_]+) .*/\1/p')
      cat "$T/tables.\$n" 2>/dev/null || echo 0 ;;
  esac ;;
esac
EOF
chmod +x "$T/stub/docker"
export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1
url(){ sed -nE "s/^$3=\"?([^\"]*)\"?\$/\1/p" "$T/wt/$1/$2"; }
ROOT=widgets_t_1; PORTAL=widgets_t_1_apps_portal

out=$(bash "$B/setup-worktree.sh" T-1 fix/T-1 2>&1); rc=$?
check "AC1 setup succeeds"                                         '[ $rc -eq 0 ] && [[ "$out" == *"database=$ROOT"* ]]'
check "AC1 each app gets a database of its own"                    '[ -f "$T/db.$ROOT" ] && [ -f "$T/db.$PORTAL" ] && [ "$(grep -c create "$T/pg.log")" = 2 ]'
check "AC1 the root env file names the root database"              '[ "$(url T-1 .env DATABASE_URL)" = "postgresql://postgres:s3cret@localhost:5432/$ROOT" ] && [ "$(url T-1 .env WEB_DATABASE_URL)" = "postgresql://postgres:s3cret@localhost:5432/$ROOT" ]'
check "AC1 the portal package env file names the portal database"  '[ "$(url T-1 apps/portal/packages/db/.env DATABASE_URL)" = "postgresql://postgres:s3cret@localhost:5432/$PORTAL" ]'
check "AC1 a root variable inside the portal names the root one"   '[ "$(url T-1 apps/portal/apps/web/.env.local WEB_DATABASE_URL)" = "postgresql://postgres:s3cret@localhost:5432/$ROOT" ]'
check "AC4 the dead-host URL now names the portal database"        '[ "$(url T-1 apps/portal/apps/web/.env.local DATABASE_URL)" = "postgresql://postgres:s3cret@localhost:5432/$PORTAL" ]'
check "AC2 each app migrates then seeds its own database"          '[ "$(cat "$T/calls")" = "$(printf "migrate %s\nseed %s\nmigrate %s\nseed %s" $ROOT $ROOT $PORTAL $PORTAL)" ]'
check "AC2 the output names each database it ran against"         '[[ "$out" == *"applying migrations to $ROOT (app .)"*"seeding $ROOT (app .)"*"applying migrations to $PORTAL (app apps/portal)"*"seeding $PORTAL (app apps/portal)"* ]]'
check "AC2 a clean run leaves no log and no migrate=failed"        '[ ! -e "$T/wt/T-1/.desk-migrate.log" ] && [[ "$out" != *"migrate=failed"* ]]'
check "the primary checkout's env files are not touched"          'grep -q "localhost:5433/portal_dev" "$T/repo/apps/portal/apps/web/.env.local"'

: > "$T/calls"; touch "$T/fail.migrate.widgets_t_2_apps_portal"
out=$(bash "$B/setup-worktree.sh" T-2 fix/T-2 2>&1); rc=$?
check "AC3 a failed app migrate: setup still hands over"           '[ $rc -eq 0 ] && [[ "$out" == *"[setup-worktree] migrate=failed"* ]]'
check "AC3 the failure names the app and its database"             '[[ "$out" == *"WARNING: app apps/portal: migrations did not complete against widgets_t_2_apps_portal"* ]]'
check "AC3 the error is kept and masked"                           'grep -q "P1010: denied" "$T/wt/T-2/.desk-migrate.log" && ! grep -q s3cret "$T/wt/T-2/.desk-migrate.log" && [[ "$out" != *"s3cret"* ]]'
check "AC3 the failed app is not seeded; the other app is"         '[ "$(cat "$T/calls")" = "$(printf "migrate widgets_t_2\nseed widgets_t_2\nmigrate widgets_t_2_apps_portal")" ]'

: > "$T/calls"; touch "$T/fail.seed.widgets_t_3"
out=$(bash "$B/setup-worktree.sh" T-3 fix/T-3 2>&1); rc=$?
check "AC3 a failed seed names the app and its database"           '[ $rc -eq 0 ] && [[ "$out" == *"WARNING: app .: the seed did not complete against widgets_t_3"* ]] && [[ "$out" == *"migrate=failed"* ]]'

# A kept worktree whose last run failed: every app is migrated again, and success clears the log.
rm -f "$T/fail.migrate.widgets_t_2_apps_portal"; : > "$T/calls"
out=$(bash "$B/setup-worktree.sh" T-2 fix/T-2 2>&1); rc=$?
check "kept, last run failed: both apps run again, log cleared"   '[ $rc -eq 0 ] && [ "$(grep -c migrate "$T/calls")" = 2 ] && [ ! -e "$T/wt/T-2/.desk-migrate.log" ] && [[ "$out" != *"migrate=failed"* ]]'
# Kept, no failure: only an app whose database is empty is migrated.
echo 9 > "$T/tables.$ROOT"; : > "$T/calls"
out=$(bash "$B/setup-worktree.sh" T-1 fix/T-1 2>&1); rc=$?
check "kept: only the empty app's database is migrated"           '[ $rc -eq 0 ] && [ "$(cat "$T/calls")" = "$(printf "migrate %s\nseed %s" $PORTAL $PORTAL)" ]'

: > "$T/pg.log"; touch "$T/install.fail"
out=$(bash "$B/setup-worktree.sh" T-4 fix/T-4 2>&1); rc=$?
check "AC6 a failed setup drops every database it created"        '[ $rc -ne 0 ] && [ ! -d "$T/wt/T-4" ] && grep -qx "drop widgets_t_4" "$T/pg.log" && grep -qx "drop widgets_t_4_apps_portal" "$T/pg.log" && [ ! -f "$T/db.widgets_t_4" ] && [ ! -f "$T/db.widgets_t_4_apps_portal" ]'
check "AC6 it says which it dropped"                               '[[ "$out" == *"dropped database widgets_t_4 (this run created it)"* ]] && [[ "$out" == *"dropped database widgets_t_4_apps_portal (this run created it)"* ]]'
rm -f "$T/install.fail"

echo "worktree database per app: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
