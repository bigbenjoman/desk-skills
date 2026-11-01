#!/usr/bin/env bash
# suite: pre-push hook (stdin, no row, lock timeout)
# The committed pre-push hook (desk/templates): real `git push`es into a throwaway origin, with the
# templates copied into a throwaway repo. Branch pushes run §4 Pre-push checks in order; tags,
# deletes and refs already on a remote are not checked; a new commit that is not HEAD is refused; no
# row pushes as today; a typecheck
# item takes the test lock and is skipped when the lock stays busy past the machine profile's timeout.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
mkdir -p "$T/desk" "$T/locks"; ln -s "$SRC/desk/bin" "$T/desk/bin"
export DESK_HOME="$T/desk" DESK_LOCK_DIR="$T/locks" DESK_MACHINE="$T/machine.md" DESK_CONFIG="$T/config.md"
unset DESK_DEFAULT_BRANCH
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"; R="$T/repo"
cp -R "$SRC/desk/templates/." "$R/"; chmod +x "$R/.githooks/pre-push"
mkdir -p "$R/sub"
printf 'echo gen >> "%s/ran"\n' "$T" > "$R/gen.sh"
printf 'echo tc >> "%s/ran"; pwd > "%s/tc-dir"\n' "$T" "$T" > "$R/sub/tc.sh"
printf 'echo lint >> "%s/ran"; echo "lint says ${LINT_SAYS:-fine}"; exit "${LINT_RC:-0}"\n' "$T" > "$R/lint.sh"
git -C "$R" add -A; git -C "$R" commit -q -m init
git -C "$R" config core.hooksPath .githooks
git -C "$R" remote add origin "$T/origin.git"
cd "$R" || exit 1

config(){ # config <Pre-push checks cell, or nothing for no row>
  { printf '## 0. Repo\n| Field | Value |\n|---|---|\n| Default branch | `main` |\n\n'
    printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Typecheck | `sub: sh tc.sh` |\n'
    [ -n "${1:-}" ] && printf '| Pre-push checks | %s |\n' "$1"; } > "$DESK_CONFIG"
}
ROW='`sh gen.sh` `sub: sh tc.sh` `sh lint.sh`'
commit(){ echo "$1" >> "$R/notes"; git add notes; git commit -q -m "$1"; }
push(){ rm -f "$T/ran"; out=$(git push "$@" 2>&1); rc=$?; ran=$(tr '\n' ' ' < "$T/ran" 2>/dev/null); }
remote(){ git --git-dir="$T/origin.git" rev-parse -q --verify "$1" 2>/dev/null; }

# ---- no row: exactly as today ----
config
commit a; push origin main
check "no row: the push goes through"                 '[ $rc -eq 0 ] && [ "$(remote main)" = "$(git rev-parse HEAD)" ]'
check "no row: nothing runs, nothing is printed"      '[ -z "$ran" ] && [[ "$out" != *pre-push:* ]]'
config '`TODO`'; commit b; push origin main
check "TODO row: pushes, nothing runs"                '[ $rc -eq 0 ] && [ -z "$ran" ]'
config '`none`'; commit c; push origin main
check "none: pushes, nothing runs"                    '[ $rc -eq 0 ] && [ -z "$ran" ] && [[ "$out" != *pre-push:* ]]'
DESK_CONFIG="$T/missing.md" push origin main:refs/heads/elsewhere
check "no repo config: pushes, nothing runs"          '[ $rc -eq 0 ] && [ -z "$ran" ]'

# ---- a branch push runs the row, in order ----
config "$ROW"; commit d; push origin main
check "branch push: every check ran, in order"        '[ $rc -eq 0 ] && [ "$ran" = "gen tc lint " ]'
check "branch push: the commit reached origin"        '[ "$(remote main)" = "$(git rev-parse HEAD)" ]'
check "each check's time is printed"                  '[[ "$out" == *"ok    sh gen.sh ("*"s)"* ]] && [[ "$out" == *"ok    sh lint.sh ("*"s)"* ]]'
check "an item with a directory runs in it"           '[ "$(cat "$T/tc-dir")" = "$(cd "$R/sub" && pwd -P)" ] && [[ "$out" == *"sh tc.sh (in sub)"* ]]'

commit e; LINT_RC=1 LINT_SAYS=nope push origin main
check "a failing check stops the push"                '[ $rc -ne 0 ] && [ "$(remote main)" != "$(git rev-parse HEAD)" ]'
check "the failure names the command and its output"  '[[ "$out" == *"FAIL  sh lint.sh"* ]] && [[ "$out" == *"lint says nope"* ]]'
LINT_RC=1 push --no-verify origin main
check "--no-verify still pushes"                      '[ $rc -eq 0 ] && [ -z "$ran" ] && [ "$(remote main)" = "$(git rev-parse HEAD)" ]'

# ---- tags, deletes, and commits that are not HEAD ----
git tag v1 HEAD~1; LINT_RC=1 push origin v1
check "a tag push is not checked"                     '[ $rc -eq 0 ] && [ -z "$ran" ] && [ -n "$(remote v1)" ]'
LINT_RC=1 push origin --delete elsewhere
check "a delete is not checked"                       '[ $rc -eq 0 ] && [ -z "$ran" ] && [ -z "$(remote elsewhere)" ]'
git checkout -q -b side; commit side; git checkout -q main
LINT_RC=1 push origin side:refs/heads/old
check "a commit on no remote that is not HEAD is refused" '[ $rc -ne 0 ] && [ -z "$ran" ] && [[ "$out" == *"not HEAD"* ]] && [ -z "$(remote old)" ]'
git checkout -q side; echo dirty >> notes; LINT_RC=1 push origin origin/main:refs/heads/copy
check "a ref already on a remote is pushed from any branch, unchecked" '[ $rc -eq 0 ] && [ -z "$ran" ] && [[ "$out" != *pre-push:* ]] && [ "$(remote copy)" = "$(git rev-parse origin/main)" ]'
git checkout -q -- notes; git checkout -q main
commit f; echo dirty >> notes; push origin main
check "a dirty tracked tree is refused"               '[ $rc -ne 0 ] && [ -z "$ran" ] && [[ "$out" == *"differ from HEAD"* ]]'
git checkout -q -- notes

# ---- the typecheck item and the box-wide test lock ----
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `pre-push-lock-timeout-s` | `0` | test |\n' > "$DESK_MACHINE"
bash "$SRC/desk/bin/with-lock.sh" test sh -c ": > '$T/held'; sleep 3" & holder=$!
n=0; while [ ! -f "$T/held" ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n + 1)); done
push origin main
check "lock busy past the timeout: typecheck skipped, the rest ran" '[ $rc -eq 0 ] && [ "$ran" = "gen lint " ]'
check "the skip says CI will run it"                  '[[ "$out" == *"skip  sh tc.sh (in sub): the box-wide test lock stayed busy for 0s; CI will run it"* ]]'

# with-lock.sh --timeout on its own
out=$(bash "$SRC/desk/bin/with-lock.sh" tsc --timeout 0 sh -c "echo ran >> '$T/wl'" 2>&1); rc=$?
check "with-lock --timeout: exits 75 while held, command not run" '[ $rc -eq 75 ] && [ ! -f "$T/wl" ] && [[ "$out" == *"gave up waiting for the tsc lock after 0s"* ]]'
wait "$holder"
out=$(bash "$SRC/desk/bin/with-lock.sh" tsc --timeout 0 sh -c 'exit 3' 2>&1); rc=$?
check "with-lock --timeout: a free lock runs the command, keeps its status" '[ $rc -eq 3 ]'
out=$(bash "$SRC/desk/bin/with-lock.sh" tsc --timeout soon true 2>&1); rc=$?
check "with-lock --timeout: a non-number is refused"  '[ $rc -eq 2 ]'
# The test lock has slots: the machine profile's test-lock-slots row, overridden by DESK_TEST_LOCK_SLOTS
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `test-lock-slots` | `2` | test |\n' > "$DESK_MACHINE"
bash "$SRC/desk/bin/with-lock.sh" test sh -c ": > '$T/slot1'; sleep 3" & h1=$!
n=0; while [ ! -f "$T/slot1" ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n + 1)); done
out=$(bash "$SRC/desk/bin/with-lock.sh" tsc --timeout 0 sh -c 'exit 4' 2>&1); rc=$?
check "with-lock slots: a second command runs beside the first" '[ $rc -eq 4 ]'
bash "$SRC/desk/bin/with-lock.sh" test sh -c ": > '$T/slot2'; sleep 3" & h2=$!
n=0; while [ ! -f "$T/slot2" ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n + 1)); done
out=$(bash "$SRC/desk/bin/with-lock.sh" tsc --timeout 0 true 2>&1); rc=$?
check "with-lock slots: a third waits while both slots are held" '[ $rc -eq 75 ]'
out=$(DESK_TEST_LOCK_SLOTS=3 bash "$SRC/desk/bin/with-lock.sh" tsc --timeout 0 sh -c 'exit 5' 2>&1); rc=$?
check "with-lock slots: DESK_TEST_LOCK_SLOTS wins over the profile" '[ $rc -eq 5 ]'
out=$(bash "$SRC/desk/bin/with-lock.sh" browser --timeout 0 sh -c 'exit 6' 2>&1); rc=$?
check "with-lock slots: the browser lock is its own" '[ $rc -eq 6 ]'
wait "$h1" "$h2"
check "with-lock slots: slot 1 keeps the original path, every slot released" '[ ! -e "$DESK_LOCK_DIR/desk-test.lock.d" ] && [ ! -e "$DESK_LOCK_DIR/desk-test.lock.2.d" ]'
mkdir -p "$DESK_LOCK_DIR/desk-test.lock.d" "$DESK_LOCK_DIR/desk-test.lock.2.d"
echo 999999 > "$DESK_LOCK_DIR/desk-test.lock.d/pid"; echo 999998 > "$DESK_LOCK_DIR/desk-test.lock.2.d/pid"
out=$(bash "$SRC/desk/bin/with-lock.sh" test --timeout 0 sh -c 'exit 7' 2>&1); rc=$?
check "with-lock slots: a dead holder's slot is taken over" '[ $rc -eq 7 ]'
rm -f "$DESK_MACHINE"
out=$(bash "$SRC/desk/bin/with-lock.sh" test sh -c ": > '$T/one'; sleep 2" 2>&1) & h3=$!
n=0; while [ ! -f "$T/one" ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n + 1)); done
out=$(bash "$SRC/desk/bin/with-lock.sh" test --timeout 0 true 2>&1); rc=$?
check "with-lock slots: no profile row keeps one slot" '[ $rc -eq 75 ]'
wait "$h3"
# A leading -- is optional without --cwd: `with-lock.sh browser -- <cmd>` runs <cmd>, not `--`
out=$(bash "$SRC/desk/bin/with-lock.sh" browser -- sh -c 'echo ran; exit 3' 2>&1); rc=$?
check "with-lock <lock> -- <cmd>: runs the command under the lock" '[ $rc -eq 3 ] && [ "$out" = ran ]'
out=$(bash "$SRC/desk/bin/with-lock.sh" browser sh -c 'echo ran; exit 3' 2>&1); rc=$?
check "with-lock <lock> <cmd>: runs the command under the lock"    '[ $rc -eq 3 ] && [ "$out" = ran ]'
out=$(bash "$SRC/desk/bin/with-lock.sh" tsc --timeout 0 -- sh -c 'echo ran' 2>&1); rc=$?
check "with-lock --timeout n -- <cmd>: runs the command"          '[ $rc -eq 0 ] && [ "$out" = ran ]'
out=$(bash "$SRC/desk/bin/with-lock.sh" nolock -- sh -c 'echo ran' 2>&1); rc=$?
check "with-lock nolock -- <cmd>: runs the command"               '[ $rc -eq 0 ] && [ "$out" = ran ]'
out=$(bash "$SRC/desk/bin/with-lock.sh" browser -- 2>&1); rc=$?
check "with-lock <lock> -- and nothing else: no command given"     '[ $rc -eq 2 ] && [[ "$out" == *"no command given"* ]]'
# --cwd: relative or absolute inside the worktree, with or without the --; never outside it or via ..
sub_real="$(cd "$R/sub" && pwd -P)"
for spelling in "sub --" "sub" "$R/sub --" "$R/sub"; do
  # shellcheck disable=SC2086
  out=$(bash "$SRC/desk/bin/with-lock.sh" nolock --cwd $spelling pwd -P 2>&1); rc=$?
  check "with-lock --cwd $spelling: runs in the directory"         '[ $rc -eq 0 ] && [ "$out" = "$sub_real" ]'
done
out=$(bash "$SRC/desk/bin/with-lock.sh" test --cwd "$R" -- pwd -P 2>&1); rc=$?
check "with-lock --cwd <worktree root>: runs at the root"           '[ $rc -eq 0 ] && [ "$out" = "$(cd "$R" && pwd -P)" ]'
out=$(bash "$SRC/desk/bin/with-lock.sh" nolock --cwd "$T" -- pwd 2>&1); rc=$?
check "with-lock --cwd <absolute path outside>: refused"            '[ $rc -eq 2 ] && [[ "$out" == *"resolves outside the worktree"* ]]'
out=$(bash "$SRC/desk/bin/with-lock.sh" nolock --cwd "$R/sub/.." -- pwd 2>&1); rc=$?
check "with-lock --cwd <path with ..>: refused"                     '[ $rc -eq 2 ] && [[ "$out" == *"without .."* ]]'
rm -f "$DESK_MACHINE"; commit g; push origin main
check "no profile, lock free: the typecheck runs"     '[ $rc -eq 0 ] && [ "$ran" = "gen tc lint " ]'

# ---- --head: desk-pr runs the checks itself, and the hook does not repeat a pass ----
head_run(){ rm -f "$T/ran"; out=$(bash scripts/desk/pre-push.sh --head 2>&1 </dev/null); rc=$?; ran=$(tr '\n' ' ' < "$T/ran" 2>/dev/null); }
commit h; LINT_RC=1 LINT_SAYS=broken head_run
check "--head: a failing check exits non-zero"        '[ $rc -ne 0 ] && [ "$ran" = "gen tc lint " ] && [[ "$out" == *"FAIL  sh lint.sh"* ]] && [[ "$out" == *"lint says broken"* ]]'
LINT_RC=1 push origin main
check "--head failure records nothing: the hook still stops the push" '[ $rc -ne 0 ] && [ "$ran" = "gen tc lint " ]'
head_run
check "--head: a pass runs every check, exit 0"       '[ $rc -eq 0 ] && [ "$ran" = "gen tc lint " ] && [[ "$out" == *"checks passed"* ]]'
push origin main
check "after a --head pass the hook does not run them again" '[ $rc -eq 0 ] && [ -z "$ran" ] && [[ "$out" == *"already passed on"* ]] && [ "$(remote main)" = "$(git rev-parse HEAD)" ]'
commit i; push origin main
check "a new commit runs them again"                  '[ $rc -eq 0 ] && [ "$ran" = "gen tc lint " ]'
head_run; config '`sh gen.sh` `sh lint.sh`'; head_run
check "a changed row runs them again"                 '[ $rc -eq 0 ] && [ "$ran" = "gen lint " ]'
config "$ROW"; head_run; echo dirty >> notes; head_run
check "--head: a dirty tracked tree is refused"       '[ $rc -ne 0 ] && [ -z "$ran" ] && [[ "$out" == *"differ from HEAD"* ]]'
git checkout -q -- notes
config; head_run
check "--head with no row: nothing runs, exit 0"      '[ $rc -eq 0 ] && [ -z "$ran" ]'
config "$ROW"
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `pre-push-lock-timeout-s` | `0` | test |\n' > "$DESK_MACHINE"
bash "$SRC/desk/bin/with-lock.sh" test sh -c ": > '$T/held2'; sleep 3" & holder=$!
n=0; while [ ! -f "$T/held2" ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n + 1)); done
commit j; head_run
wait "$holder"; rm -f "$DESK_MACHINE"; push origin main
check "a pass with a check skipped on the lock is not recorded" '[ $rc -eq 0 ] && [ "$ran" = "gen tc lint " ]'

echo "pre-push: $PASS checks passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
