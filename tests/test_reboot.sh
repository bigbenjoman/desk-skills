#!/usr/bin/env bash
# suite: reboot-check (worktrees across repos, runner, heavy)
# reboot-check.mjs across several configured repos: a worktree with uncommitted changes and one with
# commits on no remote are each counted and named, clean trees are not, a repo with no root or a
# root that is not a checkout is reported rather than skipped, and the runner reads as absent.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
# A config or repo pinned by the caller must not leak into the per-repo lookups.
export DESK_CONFIG_ROOT="$T/cfg" DESK_CONFIG="$T/elsewhere.md" DESK_REPO_OVERRIDE=other/repo
export DESK_RUNNER_VM=desk-reboot-test-absent DESK_RUNNER_STATE="$T/runner"
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
config(){ mkdir -p "$T/cfg/repos/$1"; printf '## 2. Paths\n| Field | Value |\n|---|---|\n%s\n' "$2" > "$T/cfg/repos/$1/config.md"; }

# widgets: main pushed; feat/a has one modified and one untracked file; feat/b has two unpushed commits.
git init -q --bare "$T/origin.git"
git init -q -b main "$T/widgets"; echo a > "$T/widgets/f"; git -C "$T/widgets" add f; git -C "$T/widgets" commit -q -m init
git -C "$T/widgets" remote add origin "$T/origin.git"; git -C "$T/widgets" push -q origin main
git -C "$T/widgets" worktree add -q -b feat/a "$T/wt/a"; echo b > "$T/wt/a/f"; echo new > "$T/wt/a/g"
git -C "$T/widgets" worktree add -q -b feat/b "$T/wt/b"
git -C "$T/wt/b" commit -q --allow-empty -m one; git -C "$T/wt/b" commit -q --allow-empty -m two
git -C "$T/widgets" worktree add -q -b feat/c "$T/wt/c"; rm -rf "$T/wt/c"
config acme__widgets "| Primary repo root | \`$T/widgets\` |"
# gadgets: one clean checkout. nope: no root row. gone: a root that does not exist.
git init -q -b main "$T/gadgets"; git -C "$T/gadgets" commit -q --allow-empty -m init
git -C "$T/gadgets" remote add origin "$T/origin.git"; git -C "$T/gadgets" push -q origin main:gadgets
config acme__gadgets "| Primary repo root | \`$T/gadgets\` |"
config acme__nope "| Worktrees directory | \`$T/wt\` |"
# solo: commits but no remote, so nothing in it counts as unpushed.
git init -q -b main "$T/solo"; git -C "$T/solo" commit -q --allow-empty -m one; git -C "$T/solo" commit -q --allow-empty -m two
config local__solo "| Primary repo root | \`$T/solo\` |"
config acme__gone "| Primary repo root | \`$T/gone\` |"

out=$(cd "$T" && node "$B/reboot-check.mjs" 2>&1); rc=$?
check "exits 0" '[ $rc -eq 0 ]'
check "header counts repos, worktrees, dirty, unpushed and clean" 'grep -q "^worktrees: 5 configured repos, 6 worktrees; 1 with uncommitted changes, 1 with unpushed commits, 3 clean$" <<< "$out"'
check "a repo with no remote says so and counts nothing unpushed" 'grep -qE "local__solo  .*solo  \(1 worktree; no remote, so nothing counts as unpushed\)$" <<< "$out" && ! grep -qE "solo  main" <<< "$out"'
check "dirty worktree named with its counts" 'grep -qE "wt/a  feat/a  2 uncommitted \(1 untracked\)$" <<< "$out"'
check "unpushed worktree named with its count" 'grep -qE "wt/b  feat/b  2 unpushed$" <<< "$out"'
check "a registered worktree whose directory is gone is reported" 'grep -qE "wt/c  feat/c  directory missing" <<< "$out"'
check "clean trees are not listed" '! grep -qE "widgets  main|gadgets  main" <<< "$out"'
check "clean repo still listed with its worktree count" 'grep -qE "acme__gadgets  .*gadgets  \(1 worktree\)$" <<< "$out"'
check "repo with no root row reported, not skipped" 'grep -q "acme__nope: §2 Primary repo root is unset; not checked" <<< "$out"'
check "root that is not a checkout reported" 'grep -qE "acme__gone: .*gone is not a git checkout here; not checked" <<< "$out"'
check "runner absent" 'grep -q "^runner: absent$" <<< "$out"'
check "summary line" 'grep -qE "^summary: dirty=1 unpushed=1 runner=absent keep=none heavy=[0-9]+$" <<< "$out"'
check "nothing written to the dirty tree" '[ "$(git -C "$T/wt/a" status --porcelain | wc -l | tr -d " ")" = 2 ]'

rm -rf "$T/cfg/repos"
out=$(cd "$T" && node "$B/reboot-check.mjs" 2>&1); rc=$?
check "no configured repos: still reports, exits 0" '[ $rc -eq 0 ] && grep -q "^worktrees: 0 configured repos, 0 worktrees" <<< "$out"'

# A stopped VM whose keep agent is loaded will be started again, so the agent is reported.
mkdir -p "$T/bin"; cp "$B/reboot-check.mjs" "$B/desk-env.mjs" "$B/machine.mjs" "$T/bin/"
printf '#!/bin/sh\necho "desk-runner: stopped (4 CPUs, 8192 MB, 50 GB disk)"\necho "agents: restart at login and every minute loaded; verify-isolation nightly at 03:30 loaded"\nexit 1\n' > "$T/bin/desk-runner"
chmod +x "$T/bin/desk-runner"
out=$(cd "$T" && node "$T/bin/reboot-check.mjs" 2>&1); rc=$?
check "stopped VM with its keep agent loaded says so" 'grep -q "^runner: stopped (its keep agent is loaded and starts it again within a minute)$" <<< "$out"'
check "summary carries keep=loaded" 'grep -qE "^summary: .* runner=stopped keep=loaded heavy=[0-9]+$" <<< "$out"'

echo "$PASS checks passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
