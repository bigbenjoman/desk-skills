#!/usr/bin/env bash
# The shell scripts named (paths from the repo root) against bash 3.2.57, the /bin/bash every Mac
# ships. bash 5 accepts things 3.2 does not: run 39377850819 merged a merge-driver.sh that Linux
# passed and 3.2 could not parse ("line 375: syntax error: unexpected end of file").
#   1. A scan for bash 4+ features (tests/bash32_features.txt) outside comment lines. `bash -n` only
#      parses, and many of them parse in 3.2 and then fail or misbehave when run (`${v,,}` is "bad
#      substitution"; `{1..9..2}` stays literal). A false hit can be rewritten, or its line ended with
#      `# bash32: ok <reason>`.
#   2. `bash -n` in one container of the official bash:3.2 image, pinned by digest. Needs Docker.
#   tests/bash32_check.sh desk/bin/merge-driver.sh tests/test_pass.sh
#   tests/bash32_check.sh --scan-only <files>     step 1 only, no Docker
set -u
IMAGE='bash:3.2@sha256:b6252c62fc86114f93f02104a486c71e6569371d95950ea7479a2ffd6b47f16a'
cd "$(dirname "$0")/.." || exit 2
scan_only=0
[ "${1:-}" = --scan-only ] && { scan_only=1; shift; }
[ $# -gt 0 ] || { echo "bash 3.2: no shell scripts to check"; exit 0; }
for f in "$@"; do [ -f "$f" ] || { echo "FAIL bash-3.2 $f: no such file"; exit 1; }; done

PATTERNS="$(mktemp "${TMPDIR:-/tmp}/bash32.XXXXXX")" || exit 2
trap 'rm -f "$PATTERNS"' EXIT
grep -vE '^(#|$)' tests/bash32_features.txt > "$PATTERNS" || { echo "FAIL bash-3.2: tests/bash32_features.txt has no patterns"; exit 1; }
scan=0
for f in "$@"; do
  hits=$(grep -nE -f "$PATTERNS" "$f" | grep -vE '^[0-9]+:[[:space:]]*#|# bash32: ok')
  if [ -n "$hits" ]; then scan=1; echo "FAIL bash-3.2 features $f: bash 4+ only, fails or misbehaves on macOS /bin/bash"; printf '%s\n' "$hits" | sed "s|^|     $f:|"
  else echo "ok   bash-3.2 features $f"; fi
done
[ $scan_only = 1 ] && exit $scan

# Docker Hub is on the required path: retry a failed pull before calling it a failure.
pulled=0
for i in 1 2 3; do
  if docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null; then pulled=1; break; fi
  echo "bash 3.2: pull $i of 3 failed; retrying in $((i * 5))s"; sleep $((i * 5))
done
[ $pulled = 1 ] || { echo "FAIL bash-3.2 -n: could not pull $IMAGE"; exit 1; }
# shellcheck disable=SC2016  # the script is for the container's bash, not this one
docker run --rm -v "$PWD:/w:ro" -w /w "$IMAGE" bash -c '
  echo "$(bash --version | head -n 1)"
  fail=0
  for f in "$@"; do
    if out=$(bash -n "$f" 2>&1); then echo "ok   bash-3.2 -n $f"; else fail=1; echo "FAIL bash-3.2 -n $f"; printf "%s\n" "$out" | sed "s/^/     /"; fi
  done
  exit $fail' bash32 "$@"
parse=$?
[ $scan = 0 ] && [ $parse = 0 ]
