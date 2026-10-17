#!/usr/bin/env bash
# The committed pre-push hook (desk/templates): real `git push`es into a throwaway origin, with the
# templates copied into a throwaway repo. Branch pushes run §4 Pre-push checks in order; tags and
# deletes are not checked; a commit that is not HEAD is refused; no row pushes as today; a typecheck
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
LINT_RC=1 push origin HEAD~1:refs/heads/old
check "a commit that is not HEAD is refused"          '[ $rc -ne 0 ] && [ -z "$ran" ] && [[ "$out" == *"not HEAD"* ]] && [ -z "$(remote old)" ]'
commit f; echo dirty >> notes; push origin main
check "a dirty tracked tree is refused"               '[ $rc -ne 0 ] && [ -z "$ran" ] && [[ "$out" == *"differ from HEAD"* ]]'
git checkout -q -- notes

# ---- the typecheck item and the box-wide test lock ----
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `typecheck-lock-timeout-min` | `0` | test |\n' > "$DESK_MACHINE"
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
rm -f "$DESK_MACHINE"; commit g; push origin main
check "no profile, lock free: the typecheck runs"     '[ $rc -eq 0 ] && [ "$ran" = "gen tc lint " ]'

echo "pre-push: $PASS checks passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
