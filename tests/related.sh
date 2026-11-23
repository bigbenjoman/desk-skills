#!/usr/bin/env bash
# Runs the tests/run.sh suites this branch's change reaches: tests/scope_sections.mjs decides them
# from the change against the merge base with origin/<default branch> (desk-env's, else main),
# committed, staged, unstaged and untracked, with the same rules CI's pull request plan uses. When it
# cannot decide, every suite runs. The suites run as many at once as run.sh runs without -j, or
# DESK_TEST_JOBS at once where that is set. One plain command, so a desk worker's allow-list can name
# it as §4 Related tests.
#   bash tests/related.sh
# It takes a test slot first (with-lock.sh test: the installed one, else this repo's), so it never runs
# beside the slots' holders: it runs this worktree's suites once it holds one, and while it waits the
# wrapper says on whom. It waits up to DESK_RELATED_WAIT seconds (an hour by default), then exits with
# the wrapper's 75 having run nothing. A run already in a slot (with-lock.sh exports DESK_LOCK_HELD to
# its command) takes no second one. With no with-lock.sh to find, as in CI, it runs with no slot.
# An end-to-end (L3) suite the change reaches only through imports, not claiming a changed file
# directly, is not run here but named as left for CI, which runs it before merge (scope_sections.mjs
# --l3-direct). A change to a desk/bin/ .mjs module that only edits or adds named functions and
# constants runs the suites reaching those names, and the scope line names them (--by-name); CI does not
# narrow it. run.sh's record of the run carries the scope it chose (full or changed), why, and how
# many suites it left for CI.
set -u
T="$(cd "$(dirname "$0")" && pwd)"
SH="${BASH:-bash}"
root="$(cd "$T/.." && pwd -P)"
wl="${HOME:-}/.claude/desk/bin/with-lock.sh"
[ -f "$wl" ] || wl="$root/desk/bin/with-lock.sh"
# A run called through a with-lock.sh that does not export DESK_LOCK_HELD yet is still seen inside its
# slot (a holder file or lease names it, or a flock(1) on the lock runs it), so it does not wait behind
# itself. This repo's slot-lease.mjs asks, else the one beside the wrapper.
lease="$root/desk/bin/slot-lease.mjs"
[ -f "$lease" ] || lease="$(dirname "$wl")/slot-lease.mjs"
if [ -z "${DESK_LOCK_HELD:-}" ] && ! node "$lease" in-slot "$$" 2>/dev/null; then
  if [ -f "$wl" ]; then
    wait_s="${DESK_RELATED_WAIT:-3600}"
    case "$wait_s" in ''|*[!0-9]*) echo "related: DESK_RELATED_WAIT wants a whole number of seconds, not '$wait_s'" >&2; exit 2 ;; esac
    echo "related: taking a test slot first, waiting up to ${wait_s}s for one"
    # DESK_LOCK_HELD set here too, so a wrapper that does not export it yet cannot make this recurse.
    (cd "$root" && "$SH" "$wl" test --timeout "$wait_s" -- env DESK_LOCK_HELD=test "$SH" "$T/related.sh" "$@")
    rc=$?
    # The suites' own runs exit 0, 1 or 2 (run.sh), so 75 is the wrapper giving up before any ran.
    [ "$rc" -eq 75 ] && echo "related: timed out after ${wait_s}s waiting for a test slot, so no suite ran"
    exit "$rc"
  fi
  echo "related: no with-lock.sh found, so the suites run without a test slot"
fi
jobs=()
[ -z "${DESK_TEST_JOBS:-}" ] || jobs=(-j "$DESK_TEST_JOBS")
base="origin/$(desk-env get default-branch 2>/dev/null || echo main)"
# The scope run.sh records for the run (full or changed), why, and how many suites it left for CI.
export DESK_RUN_SCOPE=full DESK_RUN_REASON='' DESK_RUN_LEFT_FOR_CI=0
every(){ echo "related: $1, so every suite runs" >&2; DESK_RUN_REASON=$1; "$SH" "$T/run.sh" ${jobs[@]+"${jobs[@]}"}; exit $?; }
git merge-base "$base" HEAD >/dev/null 2>&1 || every "no merge base with $base"
OUT="$(mktemp "${TMPDIR:-/tmp}/desk-related.XXXXXX")" || exit 1
trap 'rm -f "$OUT"' EXIT
if ! GITHUB_OUTPUT="$OUT" node "$T/scope_sections.mjs" --base "$base" --worktree --l3-direct --by-name --github-output >/dev/null; then
  every "scope_sections.mjs failed against $base"
fi
scope=$(grep -m 1 '^scope=' "$OUT"); scope=${scope#scope=}
reason=$(grep -m 1 '^reason=' "$OUT"); reason=${reason#reason=}
suites=$(grep -m 1 '^suites=' "$OUT"); suites=${suites#suites=}
ci=$(grep -m 1 '^ci=' "$OUT"); ci=${ci#ci=}
narrowed=$(grep -m 1 '^narrowed=' "$OUT"); narrowed=${narrowed#narrowed=}
DESK_RUN_REASON=${reason:-no reason given}
if [ "$scope" = full ] || [ -z "$suites" ]; then
  echo "related: scope ${scope:-unknown} against $base (${reason:-no reason given}), so every suite runs"
  "$SH" "$T/run.sh" ${jobs[@]+"${jobs[@]}"}; exit $?
fi
DESK_RUN_SCOPE=changed
echo "related: scope $scope against $base: $suites${narrowed:+ (narrowed on the changed names in $narrowed)}"
# End-to-end (L3) suites the change reaches only through imports: CI runs them before merge, not this.
if [ -n "$ci" ]; then
  # shellcheck disable=SC2086
  set -- $ci; DESK_RUN_LEFT_FOR_CI=$#
  echo "related: left for CI, as the change reaches these L3 suites only through imports: $ci"
fi
# Suite names never hold spaces, so the word split is the list.
# shellcheck disable=SC2086
"$SH" "$T/run.sh" ${jobs[@]+"${jobs[@]}"} $suites
