#!/usr/bin/env bash
# suite: batch base (one batch targets a feature branch)
# A batch base (queue.mjs set-batch base=<branch>) must redirect the autopilot's processes, and only
# them: set-batch validates it, desk-env get/batch-base report it, desk_apply_batch_base exports it
# (and refuses a contradiction), and a process that never applies it still sees §0 Default branch.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# A repo with an origin holding main and feat/x.
git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
git -C "$T/repo" remote add origin "$T/origin.git"
git -C "$T/repo" push -q origin main; git -C "$T/repo" push -q origin main:feat/x
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
EOF
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo"
# An autopilot worker inherits spawn-worker's desk_load_paths exports, and DESK_REPO_ROOT would point
# set-batch's ls-remote at the real repo's origin instead of this one.
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH
cd "$T/repo" || exit 1
# Every check that needs feat/x reads it through set-batch's ls-remote against repoRoot()'s origin, so
# a setup that cannot reach this suite's origin would fail them all for one reason: say it and stop.
root=$(node --input-type=module -e "import { repoRoot } from '$B/desk-env.mjs'; console.log(repoRoot())" 2>&1)
[ "$root" = "$T/repo" ] || { echo "FAIL setup: the repo root resolves to $root, not $T/repo"; rm -rf "$T"; exit 1; }
git ls-remote --heads origin refs/heads/feat/x | grep -q . || { echo "FAIL setup: $T/origin.git does not hold feat/x"; rm -rf "$T"; exit 1; }
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
e(){ out=$(node "$B/desk-env.mjs" "$@" 2>&1); rc=$?; }

q init t
e batch-base;               check "no base: batch-base exits 3"           '[ $rc -eq 3 ]'
e get default-branch;       check "no base: default-branch is main"       '[ "$out" = main ]'

q set-batch base=feat/nope; check "unknown branch refused"                '[ $rc -ne 0 ] && [[ "$out" == *"does not exist on origin"* ]]'
q set-batch base=production; check "production refused"                   '[ $rc -ne 0 ] && [[ "$out" == *"production"* ]]'
q set-batch "base=a..b";    check "invalid name refused"                  '[ $rc -ne 0 ]'
q set-batch base=main;      check "base=default is no override"           '[ $rc -eq 0 ] && ! grep -q "\"base\"" "$DESK_QUEUE"'

q set-batch base=feat/x;    check "real branch accepted"                  '[ $rc -eq 0 ] && grep -q "\"base\": \"feat/x\"" "$DESK_QUEUE"'
q add T-1; q render;        check "render shows the base"                 '[[ "$out" == *"base feat/x"* ]]'
e batch-base;               check "batch-base prints it"                  '[ $rc -eq 0 ] && [ "$out" = feat/x ]'
e get default-branch;       check "a plain process still sees main"       '[ "$out" = main ]'

out=$(DESK_ENV_DIR="$B" bash -c ". '$B/desk-env.sh'; desk_apply_batch_base && node '$B/desk-env.mjs' get default-branch" 2>&1); rc=$?
check "applied: default-branch is the base"                               '[ $rc -eq 0 ] && [ "$out" = feat/x ]'
out=$(DESK_DEFAULT_BRANCH=other bash -c ". '$B/desk-env.sh'; desk_apply_batch_base" 2>&1); rc=$?
check "contradicting DESK_DEFAULT_BRANCH refused"                         '[ $rc -ne 0 ] && [[ "$out" == *"contradicts"* ]]'
out=$(node --input-type=module -e "import * as E from '$B/desk-env.mjs'; E.applyBatchBase(); console.log(E.defaultBranch())" 2>&1); rc=$?
check "applyBatchBase (pass.mjs path) sets it"                            '[ $rc -eq 0 ] && [ "$out" = feat/x ]'

q set-batch base=;          check "base= clears it"                       '[ $rc -eq 0 ] && ! grep -q "\"base\"" "$DESK_QUEUE"'
q set-batch base=feat/x; q init t2
e batch-base;               check "init clears the base"                  '[ $rc -eq 3 ]'

echo "batch base: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
