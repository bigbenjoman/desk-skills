#!/usr/bin/env bash
# Runs the tests/run.sh suites this branch's change reaches: tests/scope_sections.mjs decides them
# from the change against the merge base with origin/<default branch> (desk-env's, else main),
# committed, staged, unstaged and untracked, as desk-env test-scope reads it. When it cannot decide,
# every suite runs. One plain command, so a desk worker's allow-list can name it as §4 Related tests.
#   bash tests/related.sh
set -u
T="$(cd "$(dirname "$0")" && pwd)"
SH="${BASH:-bash}"
base="origin/$(desk-env get default-branch 2>/dev/null || echo main)"
every(){ echo "related: $1, so every suite runs" >&2; "$SH" "$T/run.sh"; exit $?; }
mb=$(git merge-base "$base" HEAD 2>/dev/null) || every "no merge base with $base"
diff=$(git diff --name-status -M "$mb") || every "git diff against $base failed"
files=()
while IFS=$'\t' read -r st path _; do
  [ -n "$st" ] || continue
  case "$st" in D*|R*) every "$path was deleted or renamed against $base" ;; esac
  files+=("$path")
done <<EOF
$diff
EOF
while IFS= read -r path; do [ -n "$path" ] && files+=("$path"); done <<EOF
$(git ls-files --others --exclude-standard)
EOF
OUT="$(mktemp "${TMPDIR:-/tmp}/desk-related.XXXXXX")" || exit 1
trap 'rm -f "$OUT"' EXIT
if ! GITHUB_OUTPUT="$OUT" node "$T/scope_sections.mjs" --github-output --files ${files[@]+"${files[@]}"} >/dev/null; then
  every "scope_sections.mjs failed against $base"
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
