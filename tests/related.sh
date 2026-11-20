#!/usr/bin/env bash
# Runs the tests/run.sh suites this branch's change reaches: tests/scope_sections.mjs decides them
# from the change against the merge base with origin/<default branch> (desk-env's, else main),
# committed, staged, unstaged and untracked, with the same rules CI's pull request plan uses. When it
# cannot decide, every suite runs. DESK_TEST_JOBS sets how many suites run at once (run.sh's -j,
# default 1). One plain command, so a desk worker's allow-list can name it as §4 Related tests.
#   bash tests/related.sh
set -u
T="$(cd "$(dirname "$0")" && pwd)"
SH="${BASH:-bash}"
jobs="${DESK_TEST_JOBS:-1}"
base="origin/$(desk-env get default-branch 2>/dev/null || echo main)"
every(){ echo "related: $1, so every suite runs" >&2; "$SH" "$T/run.sh" -j "$jobs"; exit $?; }
git merge-base "$base" HEAD >/dev/null 2>&1 || every "no merge base with $base"
OUT="$(mktemp "${TMPDIR:-/tmp}/desk-related.XXXXXX")" || exit 1
trap 'rm -f "$OUT"' EXIT
if ! GITHUB_OUTPUT="$OUT" node "$T/scope_sections.mjs" --base "$base" --worktree --github-output >/dev/null; then
  every "scope_sections.mjs failed against $base"
fi
scope=$(grep -m 1 '^scope=' "$OUT"); scope=${scope#scope=}
reason=$(grep -m 1 '^reason=' "$OUT"); reason=${reason#reason=}
suites=$(grep -m 1 '^suites=' "$OUT"); suites=${suites#suites=}
if [ "$scope" = full ] || [ -z "$suites" ]; then
  echo "related: scope ${scope:-unknown} against $base (${reason:-no reason given}), so every suite runs"
  "$SH" "$T/run.sh" -j "$jobs"; exit $?
fi
echo "related: scope $scope against $base: $suites"
# Suite names never hold spaces, so the word split is the list.
# shellcheck disable=SC2086
"$SH" "$T/run.sh" -j "$jobs" $suites
