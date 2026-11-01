#!/usr/bin/env bash
# Runs the tests/run.sh suites this branch's change reaches: tests/scope_sections.mjs decides them
# against origin/<default branch> (desk-env's, else main). When it cannot decide, every suite runs.
# One plain command, so a desk worker's allow-list can name it as §4 Related tests.
#   bash tests/related.sh
set -u
T="$(cd "$(dirname "$0")" && pwd)"
SH="${BASH:-bash}"
base="origin/$(desk-env get default-branch 2>/dev/null || echo main)"
OUT="$(mktemp "${TMPDIR:-/tmp}/desk-related.XXXXXX")" || exit 1
trap 'rm -f "$OUT"' EXIT
if ! GITHUB_OUTPUT="$OUT" node "$T/scope_sections.mjs" --base "$base" --github-output >/dev/null; then
  echo "related: scope_sections.mjs failed against $base, so every suite runs" >&2
  "$SH" "$T/run.sh"; exit $?
fi
scope=$(grep -m 1 '^scope=' "$OUT"); scope=${scope#scope=}
suites=$(grep -m 1 '^suites=' "$OUT"); suites=${suites#suites=}
if [ "$scope" = full ] || [ -z "$suites" ]; then
  echo "related: scope ${scope:-unknown} against $base, so every suite runs"
  "$SH" "$T/run.sh"; exit $?
fi
echo "related: scope $scope against $base: $suites"
# Suite names never hold spaces, so the word split is the list.
# shellcheck disable=SC2086
"$SH" "$T/run.sh" $suites
