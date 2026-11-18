#!/usr/bin/env bash
# suite: desk-env.sh config snapshot (desk_cfg, desk_perm, desk_budget read once per script)
# A script that sources desk-env.sh starts node once for its config, not once per value, gets the
# same answers desk-env.mjs gives, and falls back to node when its inputs change. A shim counts the
# node runs. Scratch HOME, repo and config.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME" "$T/stub"
: > "$GIT_CONFIG_GLOBAL"
unset DESK_REPO_OVERRIDE DESK_REPO_DIR DESK_CONFIG_ROOT DESK_MACHINE DESK_BATCH AUTOPILOT_BUDGET_USD AUTOPILOT_BATCH_BUDGET_USD DESK_DEFAULT_BRANCH
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

REAL_NODE="$(node -p process.execPath)"
printf '#!/bin/sh\necho "$*" >> "%s"\nexec "%s" "$@"\n' "$T/node.log" "$REAL_NODE" > "$T/stub/node"
chmod +x "$T/stub/node"
export PATH="$T/stub:$PATH"
runs(){ grep -c 'desk-env.mjs' "$T/node.log" 2>/dev/null || true; }

git init -q -b main "$T/repo"; cd "$T/repo" || exit 1
config(){ # config <ci-rerun> <done state>
  cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`ci-rerun\` | Rerun CI | \`yes\` | \`$1\` |

## 3b. Autonomy
| Field | Value |
|---|---|
| Autopilot per-worker budget (USD) | \`12\` |

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Done state | \`$2\` |
| Required checks | \`test\` \`Lint, Type Check & Build\` |
| Merge holds | \`none\` |
| Env files | \`~/env/.env\` \`apps/web/.env.local\` |
EOF
}
config yes "It's \$HOME \`x\`"
export DESK_CONFIG="$T/config.md"
want_done="$(node "$B/desk-env.mjs" get done-state)"; want_budget="$(node "$B/desk-env.mjs" budget worker)"
want_checks="$(node "$B/desk-env.mjs" list required-checks)"; want_env="$(node "$B/desk-env.mjs" list env-files)"

# shellcheck source=../desk/bin/desk-env.sh
. "$B/desk-env.sh"
desk_load_config
: > "$T/node.log"
tracker="$(desk_cfg tracker)"; done_state="$(desk_cfg done-state)"; perm="$(desk_perm ci-rerun)"; budget="$(desk_budget worker)"
desk_cfg jira-site; unset_rc=$?
checks="$(desk_list required-checks)"; env_files="$(desk_list env-files)"; holds="$(desk_list merge-holds)"
desk_list jira-site; list_rc=$?
ci_set="$(desk_perm_or_unset ci-rerun)"; desk_perm_or_unset merge-feedback-first; unset_perm_rc=$?
check "DS-791 AC1: several config, permission and budget reads start no node after the one snapshot" '[ "$(runs)" = 0 ]'
check "DS-791 AC1: desk_list gives each item on its own line, home expanded, as desk-env.mjs list does" '[ "$checks" = "$want_checks" ] && [ "$(printf "%s\n" "$checks" | wc -l | tr -d " ")" = 2 ] && [ "$env_files" = "$want_env" ] && [[ "$env_files" == "$HOME/env/.env"* ]] && [ "$holds" = none ] && [ "$list_rc" = 3 ]'
check "DS-791 AC1: desk_perm_or_unset gives a set row, and exits 3 for an unset one" '[ "$ci_set" = yes ] && [ "$unset_perm_rc" = 3 ]'
check "DS-791 AC1: each reads as desk-env.mjs prints it, quotes and \$ kept" '[ "$tracker" = none ] && [ "$done_state" = "$want_done" ] && [ "$perm" = yes ] && [ "$budget" = "$want_budget" ] && [ "$budget" = 12 ]'
check "DS-791 AC1: an unset row prints nothing and exits 3, as desk-env.mjs get does" '[ "$unset_rc" = 3 ]'

config no "Shipped"
check "DS-791 AC3: an edit made while the script runs is not seen by desk_perm" '[ "$(desk_perm ci-rerun)" = yes ] && [ "$(runs)" = 0 ]'
check "DS-791 AC2: desk_perm_fresh reads the file as it is now" '[ "$(desk_perm_fresh ci-rerun)" = no ] && [ "$(runs)" = 1 ]'

desk_load_config
check "DS-791: a second desk_load_config under the same inputs starts no node" '[ "$(runs)" = 1 ]'

cp "$T/config.md" "$T/other.md"
check "DS-791: with DESK_CONFIG changed, a read runs node for the new config" '[ "$(DESK_CONFIG="$T/other.md" desk_cfg done-state)" = Shipped ] && [ "$(runs)" = 2 ]'
check "DS-791: with a budget variable set, desk_budget runs node and honours it" '[ "$(AUTOPILOT_BUDGET_USD=3 desk_budget worker)" = 3 ] && [ "$(runs)" = 3 ]'
out="$(desk_cfg no-such-id 2>&1)"; rc=$?
check "DS-791: an id the snapshot lacks gets desk-env.mjs'\''s own error" '[ $rc -ne 0 ] && [[ "$out" == *"unknown config id \"no-such-id\""* ]] && [ "$(runs)" = 4 ]'

export AUTOPILOT_BUDGET_USD=7; desk_load_config; ok_budget="$(desk_budget worker)"
export AUTOPILOT_BUDGET_USD=bad; desk_load_config; out="$(desk_budget worker 2>&1)"; rc=$?; unset AUTOPILOT_BUDGET_USD
check "DS-791: a read that fails in a new snapshot is not answered from the old one, and exits as desk-env.mjs does" '[ "$ok_budget" = 7 ] && [ $rc = 4 ] && [[ "$out" != 7* ]]'

echo "desk-env.sh snapshot:$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
