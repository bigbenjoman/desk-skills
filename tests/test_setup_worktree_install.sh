#!/usr/bin/env bash
# suite: setup-worktree install (a §4 Install item in a subdirectory)
# A §4 Install item that names a directory (`backend: uv sync --frozen`) runs there when
# setup-worktree.sh --for-worker builds a worker's worktree, so the virtualenv is in place before the
# worker spawns and the worktree is still clean. Stub uv and pnpm only; scratch HOME and repos.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME" "$T/stub"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_PG_CONTAINER
PASS=0; FAIL=0
check(){ if [ -n "${2:-}" ] && eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

# A repo with package.json at the root and its Python project, lockfile committed, in backend/.
git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"
mkdir -p "$T/repo/backend"
printf '{"name":"widgets"}\n' > "$T/repo/package.json"
printf '[project]\nname = "api"\nversion = "0.1.0"\n' > "$T/repo/backend/pyproject.toml"
printf 'version = 1\n' > "$T/repo/backend/uv.lock"
git -C "$T/repo" add -A; git -C "$T/repo" commit -q -m init
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

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`T-[0-9]+\` |
| Command prefix | \`none\` |
| Install | \`pnpm install --frozen-lockfile\` \`backend: uv sync --frozen\` |
| Project subagents sync | \`none\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
| Database migrate | \`none\` |
EOF
# uv sync makes .venv with a .gitignore of `*` in it, as the real uv does, so the venv is never
# untracked; each stub logs where it ran.
cat > "$T/stub/uv" <<EOF
#!/bin/sh
echo "uv \$* in \$PWD" >> "$T/tools.log"
mkdir -p .venv/bin && printf '*\n' > .venv/.gitignore && : > .venv/bin/python
EOF
cat > "$T/stub/pnpm" <<EOF
#!/bin/sh
echo "pnpm \$* in \$PWD" >> "$T/tools.log"
EOF
chmod +x "$T/stub/uv" "$T/stub/pnpm"
export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1

out=$(bash "$B/setup-worktree.sh" --for-worker T-1 fix/T-1 2>&1); rc=$?
W="$T/wt/T-1"
check "AC3 setup succeeds with a JS and a backend Install item"   '[ $rc -eq 0 ] && [[ "$out" == *"worktree=$W"* ]]'
check "AC3 the JS item runs at the worktree root"                 'grep -qxF "pnpm install --frozen-lockfile in $W" "$T/tools.log"'
check "AC3 the backend item runs in backend/"                     'grep -qxF "uv sync --frozen in $W/backend" "$T/tools.log"'
check "AC3 backend/.venv exists before the worker spawns"         '[ -f "$W/backend/.venv/bin/python" ] && [ ! -e "$W/.venv" ]'
st=$(git -C "$W" status --porcelain 2>&1)
check "AC3 the worktree is clean after the install"               '[ -z "$st" ]'

# DS-346: a new worktree is refused on a name no worker can push; a finished one already on such a
# branch is handed back, so a kept round resumes.
for br in 'fix/T-2-<slug>' '-x' 'fix/T-2.lock' 'fix/T-2/' 'fix/T-2..x' 'fix/T-2 x'; do
  out=$(bash "$B/setup-worktree.sh" --for-worker T-2 "$br" 2>&1); rc=$?
  check "DS-346 a new worktree on '$br' is refused" '[ $rc -ne 0 ] && [[ "$out" == *"is not usable"* ]] && [ ! -e "$T/wt/T-2" ]'
done
git -C "$T/repo" worktree add -q -b 'fix/T-3-<slug>' "$T/wt/T-3" main
out=$(bash "$B/setup-worktree.sh" --for-worker T-3 'fix/T-3-<slug>' 2>&1); rc=$?
check "DS-346 a finished worktree on a placeholder branch is handed back" '[ $rc -eq 0 ] && [[ "$out" == *"worktree=$T/wt/T-3"* ]]'

echo "setup-worktree install: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
