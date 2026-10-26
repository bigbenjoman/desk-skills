#!/usr/bin/env bash
# `bash -n` under bash 3.2.57, the /bin/bash every Mac ships, for the shell scripts named (paths from
# the repo root). bash 5 parses things 3.2 does not: run 39377850819 merged a merge-driver.sh that
# Linux passed and 3.2 could not parse ("line 375: syntax error: unexpected end of file"). One
# container of the official bash:3.2 image (pinned by digest) checks every file. Needs Docker.
# `bash -n` only parses, and some bash 4+ features parse fine in 3.2 and fail only when run
# (`${v,,}` is "bad substitution" at run time), so a scan for those features runs first, outside
# comment lines. A false hit can be rewritten, or the line ended with `# bash32: ok <reason>`.
#   tests/bash32_check.sh desk/bin/merge-driver.sh tests/test_pass.sh
set -u
IMAGE='bash:3.2@sha256:b6252c62fc86114f93f02104a486c71e6569371d95950ea7479a2ffd6b47f16a'
cd "$(dirname "$0")/.." || exit 2
[ $# -gt 0 ] || { echo "bash 3.2: no shell scripts to check"; exit 0; }
for f in "$@"; do [ -f "$f" ] || { echo "FAIL bash-3.2 -n $f: no such file"; exit 1; }; done
# Bash 4+ only: case conversion ${v,,} ${v^^}, ${v@Q} transforms, associative arrays, mapfile,
# readarray, coproc, |&, ;& and ;;& in case, &>>, [[ -v, wait -n, globstar and lastpipe, a negative
# array index, $EPOCHSECONDS and kin, and printf's %(...)T.
NEWER='\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?(,|\^)|\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?@[QEPAaUuLK]\}'
NEWER="$NEWER"'|(^|[;&|[:space:](])(declare|local|typeset|readonly)[[:space:]]+-[a-zA-Z]*A|(^|[;&|[:space:](])(mapfile|readarray|coproc)([[:space:]]|$)'
NEWER="$NEWER"'|\|&|;;&|[^;];&([[:space:]]|$)|&>>|\[\[[[:space:]]+-v[[:space:]]|wait[[:space:]]+-n|shopt[[:space:]]+-s[[:space:]]+(globstar|lastpipe)'  # bash32: ok (the pattern itself)
NEWER="$NEWER"'|\$\{[A-Za-z_][A-Za-z0-9_]*\[-[0-9]+\]\}|\$\{?(EPOCHSECONDS|EPOCHREALTIME|BASH_ARGV0)|%\([^)]*\)T'
scan=0
for f in "$@"; do
  hits=$(grep -nE "$NEWER" "$f" | grep -vE '^[0-9]+:[[:space:]]*#|# bash32: ok')
  if [ -n "$hits" ]; then scan=1; echo "FAIL bash-3.2 features $f: bash 4+ only, fails at run time on macOS /bin/bash"; printf '%s\n' "$hits" | sed "s|^|     $f:|"
  else echo "ok   bash-3.2 features $f"; fi
done
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
