#!/usr/bin/env bash
# suite: repo templates (tests/lib/repo_template.sh: built once per run, copied per case)
# repo_template builds a template once per REPO_TPL_ROOT, however many suites ask for it or race to
# build it, and repo_copy gives each case its own copy with its remotes pointed at the copy. Scratch
# HOME only; the suites that race are background subshells of this one.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; mkdir -p "$T/home"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
git config --global init.defaultBranch main
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
# shellcheck source=lib/repo_template.sh
. "$S/lib/repo_template.sh"

# two_repos <dir>: an origin and a clone of it with one commit pushed, counting each build in
# $T/builds. $T/slow makes it wait mid-build, so a racing suite would meet a half-built template.
two_repos(){
  echo build >> "$T/builds"
  git init -q --bare "$1/origin.git" && git init -q "$1/repo" && git -C "$1/repo" remote add origin "$1/origin.git" &&
  echo a > "$1/repo/a.txt" && git -C "$1/repo" add a.txt && git -C "$1/repo" commit -q -m init || return 1
  [ ! -f "$T/slow" ] || sleep 1
  git -C "$1/repo" push -q origin main && touch "$1/whole"
}
builds(){ grep -c build "$T/builds" 2>/dev/null || echo 0; }

# AC1: several suites in one run ask for the same template; it is built once and each gets a copy.
export REPO_TPL_ROOT="$T/run1"
for s in 1 2 3; do (repo_template two two_repos && repo_copy two "$T/c$s") || echo "suite $s failed"; done > "$T/out" 2>&1
out=$(cat "$T/out")
check "AC1 three suites asking for one template build it once" '[ "$(builds)" = 1 ] && [ -z "$out" ]'
check "AC1 each case has its own copy" '[ -f "$T/c1/repo/a.txt" ] && [ -f "$T/c3/repo/a.txt" ] && echo b > "$T/c1/repo/a.txt" && [ "$(cat "$T/c3/repo/a.txt")" = a ]'
check "AC1 a copy pushes to its own origin, not the template's" 'git -C "$T/c2/repo" commit -q --allow-empty -m mine && git -C "$T/c2/repo" push -q origin main && [ "$(git -C "$T/c2/origin.git" rev-parse main)" = "$(git -C "$T/c2/repo" rev-parse HEAD)" ] && [ "$(git -C "$T/c2/origin.git" rev-parse main)" != "$(git -C "$REPO_TPL_ROOT/two/origin.git" rev-parse main)" ]'
check "AC1 nothing is left behind but the template" '[ "$(ls "$REPO_TPL_ROOT")" = two ]'

# AC2: two suites start at once and neither finds the template built: one builds, the other waits for
# the whole template.
export REPO_TPL_ROOT="$T/run2"; : > "$T/builds"; touch "$T/slow"
( repo_template two two_repos && [ -f "$REPO_TPL_ROOT/two/whole" ] && echo whole > "$T/r1" ) &
( repo_template two two_repos && [ -f "$REPO_TPL_ROOT/two/whole" ] && echo whole > "$T/r2" ) &
wait; rm -f "$T/slow"
check "AC2 two racing suites build the template once" '[ "$(builds)" = 1 ]'
check "AC2 neither racing suite reads a half-built template" '[ "$(cat "$T/r1" 2>/dev/null)" = whole ] && [ "$(cat "$T/r2" 2>/dev/null)" = whole ]'
# DS-941: the lock holds where mkdir is not atomic (uutils mkdir on ubuntu-26.04 lets racing callers
# all succeed). This mkdir succeeds even when its path exists, the worst such race.
mkdir -p "$T/bin"; printf '#!/bin/sh\nexec /bin/mkdir -p "$@"\n' > "$T/bin/mkdir"; chmod +x "$T/bin/mkdir"
export REPO_TPL_ROOT="$T/run2b"; : > "$T/builds"; rm -f "$T/r1" "$T/r2"; touch "$T/slow"
( PATH="$T/bin:$PATH"; repo_template two two_repos && [ -f "$REPO_TPL_ROOT/two/whole" ] && echo whole > "$T/r1" ) 2>/dev/null &
( PATH="$T/bin:$PATH"; repo_template two two_repos && [ -f "$REPO_TPL_ROOT/two/whole" ] && echo whole > "$T/r2" ) 2>/dev/null &
wait; rm -f "$T/slow"
check "DS-941 racing suites build once where mkdir is not atomic" '[ "$(builds)" = 1 ] && [ "$(cat "$T/r1" 2>/dev/null)" = whole ] && [ "$(cat "$T/r2" 2>/dev/null)" = whole ]'

# A lock whose builder died is taken over rather than waited on for ever.
export REPO_TPL_ROOT="$T/run3"; : > "$T/builds"; mkdir -p "$REPO_TPL_ROOT"
(sh -c 'echo $$' > "$REPO_TPL_ROOT/two.lock")
repo_template two two_repos; rc=$?
check "a dead builder's lock is taken over" '[ $rc = 0 ] && [ -f "$REPO_TPL_ROOT/two/whole" ] && [ ! -e "$REPO_TPL_ROOT/two.lock" ]'
# A builder that fails leaves no template and no lock, and says so.
broken(){ git init -q "$1/repo" && false; }
says(){ printf '%s\n' "$out" | grep -qF "$1"; }
out=$(repo_template bad broken 2>&1); rc=$?
check "a failed build leaves no template and no lock" '[ $rc = 1 ] && [ ! -e "$REPO_TPL_ROOT/bad" ] && [ ! -e "$REPO_TPL_ROOT/bad.lock" ] && says "building bad failed"'
# AC3: a builder that leaves its directory's path outside a remote URL (here a worktree, whose .git
# file holds it) fails rather than handing the path to every copy.
leaky(){ two_repos "$1" && git -C "$1/repo" worktree add -q "$1/wt" -b side; }
out=$(repo_template leak leaky 2>&1); rc=$?
check "AC3 a build that leaves its path in the template fails" '[ $rc = 1 ] && [ ! -e "$REPO_TPL_ROOT/leak" ] && [ ! -e "$REPO_TPL_ROOT/leak.lock" ] && says "building leak left its own path"'
out=$(REPO_TPL_ROOT='' repo_template two two_repos 2>&1); rc=$?
check "with no REPO_TPL_ROOT it builds nothing, and says why" '[ $rc = 2 ] && says "REPO_TPL_ROOT is not set"'

# AC3: a template built on another run, by a different clock and identity, has the same SHAs and
# dates, and no copy holds a template's path.
export REPO_TPL_ROOT="$T/run4"
(export GIT_AUTHOR_NAME=other GIT_COMMITTER_DATE="2031-05-05T05:05:05Z"; repo_template two two_repos)
repo_copy two "$T/c4"
check "AC3 SHAs are the same on every run" '[ "$(git -C "$T/c4/repo" rev-parse HEAD)" = "$(git -C "$T/c1/origin.git" rev-parse main)" ]'
check "AC3 commit dates are pinned" '[ "$(git -C "$T/c4/repo" log -1 --format="%at %ct")" = "1577836800 1577836800" ]'
check "AC3 a copy holds no path of any template" '! grep -rqF "$T/run" "$T/c4" "$T/c1" && ! grep -rqF "$REPO_TPL_ROOT" "$REPO_TPL_ROOT/two"'
check "AC3 a copy's remote is its own origin" '[ "$(git -C "$T/c4/repo" remote get-url origin)" = "$T/c4/origin.git" ]'

echo; echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
