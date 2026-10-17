#!/usr/bin/env bash
# desk_timeout kills the command's whole process group on timeout, not just the command, and
# setup-worktree.sh's psql calls run under it: a database that never answers fails setup within the
# limit, names the container, removes the half-built worktree and leaves no docker or psql behind.
# Stub docker only; scratch HOME and repos.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME" "$T/stub"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_PG_CONTAINER DESK_PSQL_TIMEOUT
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
alive(){ local p; for p in $(cat "$1" 2>/dev/null); do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }
reap(){ local p; for p in $(cat "$1" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done; }

# shellcheck source=../desk/bin/desk-env.sh
. "$B/desk-env.sh"

# A command that starts a child and waits on it: killing only the command would orphan the child.
LEADER='sleep 30 & echo $! > "$0"; wait'

# Both the perl fallback and whichever desk_timeout picks here (timeout, gtimeout or the fallback).
for fn in desk_timeout_perl desk_timeout; do
  P="$T/$fn.pid"; t0=$SECONDS
  out=$("$fn" 1 sh -c "$LEADER" "$P" 2>&1); rc=$?; took=$((SECONDS - t0))
  check "$fn: exits 124 on timeout"                         '[ $rc -eq 124 ]'
  check "$fn: returns within the limit plus the kill grace" '[ $took -le 5 ]'
  check "$fn: the child the command started is killed too"  '[ -s "$P" ] && ! alive "$P"'
  reap "$P"
  "$fn" 5 sh -c 'exit 3'; rc=$?
  check "$fn: passes the command's exit status through"    '[ $rc -eq 3 ]'
  "$fn" 5 sh -c 'kill -TERM $$'; rc=$?
  check "$fn: a command killed by a signal exits 128+n"    '[ $rc -eq 143 ]'
done
"desk_timeout_perl" 5 /nonexistent/cmd 2>/dev/null; rc=$?
check "desk_timeout_perl: a command that cannot run exits 127" '[ $rc -eq 127 ]'

# setup-worktree.sh against a container whose psql never answers.
git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin main
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
| Env files | \`none\` |
| Local database | \`postgres container pg-hung\` |
| Database URL variable | \`DATABASE_URL\` |
| Database migrate | \`none\` |
EOF
# docker exec that never returns, through a child of its own, as a wedged container's would.
cat > "$T/stub/docker" <<EOF
#!/bin/sh
echo "\$*" >> "$T/docker.args"
sleep 30 & echo \$! >> "$T/docker.pids"; echo \$\$ >> "$T/docker.pids"; wait
EOF
chmod +x "$T/stub/docker"
export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1

t0=$SECONDS
out=$(DESK_PSQL_TIMEOUT=2 bash "$B/setup-worktree.sh" T-1 fix/T-1 2>&1); rc=$?; took=$((SECONDS - t0))
check "hung psql: setup fails"                                  '[ $rc -ne 0 ]'
check "hung psql: within the limit (2s) plus the kill grace"    '[ $took -le 10 ]'
check "hung psql: the failure names the container and limit"'[[ "$out" == *"FAIL: cannot reach Postgres in container pg-hung"*"did not answer within 2s"* ]]'
check "hung psql: psql ran through docker exec"                 'grep -q "^exec pg-hung psql " "$T/docker.args"'
check "hung psql: no docker or psql left running"               '[ -s "$T/docker.pids" ] && ! alive "$T/docker.pids"'
check "hung psql: the half-built worktree is removed"           '[ ! -d "$T/wt/T-1" ]'
reap "$T/docker.pids"

out=$(DESK_PSQL_TIMEOUT=soon bash "$B/setup-worktree.sh" T-2 fix/T-2 2>&1); rc=$?
check "a non-numeric limit is refused before anything is made"  '[ $rc -ne 0 ] && [[ "$out" == *"DESK_PSQL_TIMEOUT="* ]] && [ ! -d "$T/wt/T-2" ]'

echo "timeout: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
