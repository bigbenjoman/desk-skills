#!/usr/bin/env bash
# suite: setup-worktree branch held by another worktree
# A ticket's branch checked out in another worktree that is clean, level with origin and used by no
# process is detached there, so setup-worktree.sh can check the branch out for the ticket. Anything
# that could be lost or disturbed there fails setup, naming the folder and why. Scratch HOME and repos.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(cd "$(mktemp -d)" && pwd -P)"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_PG_CONTAINER
PASS=0; FAIL=0
check(){ if [ -n "${2:-}" ] && eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"
printf 'one\n' > "$T/repo/a.txt"
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
| Install | \`none\` |
| Project subagents sync | \`none\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
| Database migrate | \`none\` |
EOF
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1

# held <n>: branch fix/T-<n> pushed to origin and checked out, clean, in the other worktree $T/other-<n>.
held() {
  git -C "$T/repo" branch -q "fix/T-$1" main
  git -C "$T/repo" push -q origin "fix/T-$1"
  git -C "$T/repo" worktree add -q "$T/other-$1" "fix/T-$1"
}
on_branch() { [ "$(git -C "$1" branch --show-current)" = "$2" ]; }

# AC1: clean, level with origin, no process in it: detached at the same commit, the ticket's worktree made.
held 1; H="$T/other-1"; sha=$(git -C "$H" rev-parse HEAD)
out=$(bash "$B/setup-worktree.sh" --for-worker T-1 fix/T-1 2>&1); rc=$?
check "AC1 setup succeeds"                                      '[ $rc -eq 0 ] && [[ "$out" == *"worktree=$T/wt/T-1"* ]]'
check "AC1 the other worktree is detached at the same commit"   '! git -C "$H" symbolic-ref -q HEAD >/dev/null && [ "$(git -C "$H" rev-parse HEAD)" = "$sha" ]'
check "AC1 the other worktree and its files stay"               '[ -f "$H/a.txt" ] && git -C "$T/repo" worktree list | grep -qF "$H "'
check "AC1 the ticket worktree is on the branch"                'on_branch "$T/wt/T-1" fix/T-1'
check "AC1 the output names the folder it detached"             '[[ "$out" == *"checked out in $H"*"detached that worktree"* ]]'

# AC2: uncommitted changes there.
held 2; H="$T/other-2"; printf 'two\n' > "$H/a.txt"
out=$(bash "$B/setup-worktree.sh" --for-worker T-2 fix/T-2 2>&1); rc=$?
check "AC2 setup fails"                                         '[ $rc -ne 0 ] && [ ! -e "$T/wt/T-2" ]'
check "AC2 names the folder and its changes"                    '[[ "$out" == *"$H"*"uncommitted changes"*"a.txt"* ]]'
check "AC2 the other worktree keeps the branch and the change"  'on_branch "$H" fix/T-2 && grep -qx two "$H/a.txt"'

# AC3: untracked files there.
held 3; H="$T/other-3"; : > "$H/new.txt"
out=$(bash "$B/setup-worktree.sh" --for-worker T-3 fix/T-3 2>&1); rc=$?
check "AC3 setup fails"                                         '[ $rc -ne 0 ] && [ ! -e "$T/wt/T-3" ]'
check "AC3 names the folder and its untracked files"            '[[ "$out" == *"$H"*"untracked files"*"new.txt"* ]]'
check "AC3 the other worktree keeps the branch"                 'on_branch "$H" fix/T-3'

# AC4: a commit there not pushed to origin.
held 4; H="$T/other-4"; printf 'four\n' > "$H/a.txt"; git -C "$H" commit -q -am local
out=$(bash "$B/setup-worktree.sh" --for-worker T-4 fix/T-4 2>&1); rc=$?
check "AC4 setup fails"                                         '[ $rc -ne 0 ] && [ ! -e "$T/wt/T-4" ]'
check "AC4 says the commits are not pushed"                     '[[ "$out" == *"$H"*"1 commit(s) not pushed to origin/fix/T-4"* ]]'
check "AC4 the other worktree keeps the branch"                 'on_branch "$H" fix/T-4'

# AC5: a running process works in it.
held 5; H="$T/other-5"
( cd "$H" && exec sleep 60 ) & P=$!
sleep 1
out=$(bash "$B/setup-worktree.sh" --for-worker T-5 fix/T-5 2>&1); rc=$?
kill "$P" 2>/dev/null; wait "$P" 2>/dev/null
check "AC5 setup fails"                                         '[ $rc -ne 0 ] && [ ! -e "$T/wt/T-5" ]'
check "AC5 names the folder and the process"                    '[[ "$out" == *"$H"*"working directory of"*"pid $P"* ]]'
check "AC5 the other worktree keeps the branch"                 'on_branch "$H" fix/T-5'

# A stash made on the branch is work the person may come back to: it fails too.
held 6; H="$T/other-6"; printf 'six\n' > "$H/a.txt"; git -C "$H" stash -q
out=$(bash "$B/setup-worktree.sh" --for-worker T-6 fix/T-6 2>&1); rc=$?
check "a stash on the branch fails setup and names it"          '[ $rc -ne 0 ] && [[ "$out" == *"$H"*"stashed work"* ]] && on_branch "$H" fix/T-6'

echo "setup-worktree branch: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
