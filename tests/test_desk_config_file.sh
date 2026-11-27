#!/usr/bin/env bash
# suite: DESK_CONFIG_FILE rows read before the repo config (desk-env.mjs and desk-env.sh)
# layer: L2
# A JSON file of row ids to values, named by DESK_CONFIG_FILE, answers get and list before
# ~/.config/desk; a row it lacks falls back to the repo config; unset, nothing changes. Scratch HOME,
# repo, config and file.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"
: > "$GIT_CONFIG_GLOBAL"
unset DESK_REPO_OVERRIDE DESK_REPO_DIR DESK_CONFIG DESK_CONFIG_ROOT DESK_CONFIG_FILE DESK_MACHINE DESK_BATCH AUTOPILOT_BUDGET_USD AUTOPILOT_BATCH_BUDGET_USD DESK_DEFAULT_BRANCH
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
M="$B/desk-env.mjs"

git init -q -b main "$T/repo"; cd "$T/repo" || exit 1
git remote add origin git@github.com:acme/widgets.git
mkdir -p "$HOME/.config/desk/repos/acme__widgets"
cat > "$HOME/.config/desk/repos/acme__widgets/config.md" <<'EOF'
## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Review bar | `repo-bar` |
| Done state | `Shipped` |
| Required checks | `repo-check` |
EOF
cat > "$T/rows.json" <<'EOF'
{ "review-bar": "file-bar", "required-checks": ["Lint", "Unit tests"], "clean-verdict": "p0=0", "done-state": null }
EOF

unset_bar="$(node "$M" get review-bar)"; unset_checks="$(node "$M" list required-checks)"
node "$M" get clean-verdict >/dev/null 2>&1; unset_rc=$?
export DESK_CONFIG_FILE="$T/rows.json"
bar="$(node "$M" get review-bar)"; checks="$(node "$M" list required-checks)"; verdict="$(node "$M" get clean-verdict)"
done_state="$(node "$M" get done-state)"; node "$M" get jira-site >/dev/null 2>&1; miss_rc=$?
check "#1560 AC1: get gives the file's value before the repo config's" '[ "$bar" = file-bar ] && [ "$verdict" = p0=0 ]'
check "#1560 AC1: list gives each of the file's items, one per line" '[ "$checks" = "$(printf "Lint\nUnit tests")" ]'
check "#1560 AC2: a row the file lacks, or holds as null, reads from the repo config" '[ "$done_state" = Shipped ]'
check "#1560 AC2: a row in neither exits 3, as today" '[ "$miss_rc" = 3 ]'

rm "$HOME/.config/desk/repos/acme__widgets/config.md"
nocfg="$(node "$M" get review-bar)"
check "#1560: with no ~/.config/desk config at all (a cloud session), the file still answers" '[ "$nocfg" = file-bar ]'
cat > "$HOME/.config/desk/repos/acme__widgets/config.md" <<'EOF'
## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Review bar | `repo-bar` |
| Required checks | `repo-check` |
EOF

# shellcheck source=../desk/bin/desk-env.sh
. "$B/desk-env.sh"
desk_load_config
sh_bar="$(desk_cfg review-bar)"; sh_checks="$(desk_list required-checks)"
check "#1560 AC1: desk-env.sh's desk_cfg and desk_list read the file too" '[ "$sh_bar" = file-bar ] && [ "$sh_checks" = "$(printf "Lint\nUnit tests")" ]'
unset DESK_CONFIG_FILE
check "#1560: unsetting the variable mid-script drops the desk-env.sh snapshot" '[ "$(desk_cfg review-bar)" = repo-bar ]'

check "#1560 AC3: unset, get and list print what the repo config holds" '[ "$unset_bar" = repo-bar ] && [ "$unset_checks" = repo-check ] && [ "$unset_rc" = 3 ] && [ "$(node "$M" get review-bar)" = repo-bar ]'

out="$(DESK_CONFIG_FILE="$T/missing.json" node "$M" get review-bar 2>&1)"; rc=$?
check "#1560: a file named but missing fails naming it" '[ $rc -ne 0 ] && [[ "$out" == *"DESK_CONFIG_FILE"*"missing.json"* ]]'
echo '["review-bar"]' > "$T/bad.json"
out="$(DESK_CONFIG_FILE="$T/bad.json" node "$M" get review-bar 2>&1)"; rc=$?
check "#1560: a file that is not a JSON object fails rather than being ignored" '[ $rc -ne 0 ] && [[ "$out" == *"not a JSON object"* ]]'

echo "DESK_CONFIG_FILE:$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
