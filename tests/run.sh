#!/usr/bin/env bash
# Runs every desk-skills regression test. Each test uses a throwaway HOME and git repos; nothing
# touches your real ~/.claude, ~/.config/desk, repos, Jira or GitHub. Written for bash 3.2 (stock
# macOS /bin/bash) as well as 4+/5.
#   tests/run.sh                          every suite
#   tests/run.sh test_jira.sh test_ci.mjs only those suites (file names or paths under tests/), plus
#                                         the attribution hook self-test; an unknown name is an error
set -u
T="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp "${TMPDIR:-/tmp}/desk-test.XXXXXX")" || exit 1
trap 'rm -f "$OUT"' EXIT
# Every bash suite runs under the bash running this script, so `/bin/bash tests/run.sh` tests 3.2.
SH="${BASH:-bash}"
echo "bash $BASH_VERSION ($SH); scripts with #!/usr/bin/env bash get $(command -v bash)"
fail=0; total=0
# A suite fails the run on a FAIL line, a non-zero exit, a bash error, or no checks at all.
run() { printf '\n== %s\n' "$1"; shift; "$@" >"$OUT" 2>&1 3<&-; rc=$?
  grep -E "checks passed|^SKIP" "$OUT"; c=$(grep -c "^ok" "$OUT")
  [ "$c" -gt 0 ] || c=$(grep -oE '[0-9]+ checks passed' "$OUT" | grep -oE '^[0-9]+' | head -n 1)
  c=${c:-0}; total=$((total + c)); echo "ok: $c"
  grep -E 'FAIL|too many arguments|unbound variable|bad substitution|syntax error' "$OUT" && fail=1
  [ $rc -eq 0 ] || { echo "exit $rc"; tail -5 "$OUT"; fail=1; }
  [ "$c" -gt 0 ] || { echo "no checks ran"; fail=1; }; }
# Every tests/test_*.sh and tests/test_*.mjs is a suite, run in name order, so adding one needs no
# edit here. Its label is the first `# suite: <label>` (`// suite: <label>` in .mjs) line in its
# first ten lines, or the file name without one.
suites=$(printf '%s\n' "$T"/test_*.sh "$T"/test_*.mjs | LC_ALL=C sort)
# A filter keeps the named suites only. A name that is no suite fails the run rather than running less.
if [ $# -gt 0 ]; then
  want=""
  for a in "$@"; do
    a=${a##*/}
    case "$a" in test_*.sh|test_*.mjs) ;; *) echo "not a suite: $a (want tests/test_*.sh or tests/test_*.mjs)"; exit 2 ;; esac
    [ -f "$T/$a" ] || { echo "no such suite: tests/$a"; exit 2; }
    want="$want$T/$a
"
  done
  suites=$(printf '%s' "$want" | LC_ALL=C sort -u)
fi
# Suites that are not a tests/test_* file.
run "attribution hook self-test" python3 "$T/../hooks/deny-ai-attribution.py" --self-test
while IFS= read -r f <&3; do
  [ -f "$f" ] || continue  # a glob that matched nothing
  label=$(head -n 10 "$f" | grep -m 1 -E '^(#|//) suite: '); label=${label#* suite: }
  [ -n "$label" ] || label=${f##*/}
  case "$f" in *.sh) run "$label" "$SH" "$f" ;; *) run "$label" node "$f" ;; esac
done 3<<EOF
$suites
EOF
[ "$fail" = 0 ] && { echo; echo "all passed: $total checks"; } || { echo; echo "FAILURES above ($total checks passed)"; }
exit $fail
