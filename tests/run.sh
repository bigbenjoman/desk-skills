#!/usr/bin/env bash
# Runs every desk-skills regression test. Each test uses a throwaway HOME and git repos; nothing
# touches your real ~/.claude, ~/.config/desk, repos, Jira or GitHub. Written for bash 3.2 (stock
# macOS /bin/bash) as well as 4+/5.
#   tests/run.sh                          every suite
#   tests/run.sh test_jira.sh test_ci.mjs only those suites (file names or paths under tests/), plus
#                                         the attribution hook self-test; an unknown name is an error
#   tests/run.sh --no-hook-test <suite>...  without the hook self-test (every CI shard but the first)
set -u
hook=1
[ "${1:-}" = --no-hook-test ] && { hook=0; shift; }
T="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=suite_env.sh
. "$T/suite_env.sh"
OUT="$(mktemp "${TMPDIR:-/tmp}/desk-test.XXXXXX")" || exit 1
trap 'rm -f "$OUT"' EXIT
echo "bash $BASH_VERSION ($SH); scripts with #!/usr/bin/env bash get $(command -v bash)"
fail=0; total=0; failed=""
# A suite fails the run on a FAIL line, a non-zero exit, a bash error, or no checks at all. A failed
# suite's whole output but its ok lines is printed, so whatever it said about the failure is in the log.
run() { printf '\n== %s\n' "$1"; shift; "$@" >"$OUT" 2>&1 3<&-; rc=$?; bad=0
  grep -E "checks passed|^SKIP" "$OUT"; c=$(grep -c "^ok" "$OUT")
  [ "$c" -gt 0 ] || c=$(grep -oE '[0-9]+ checks passed' "$OUT" | grep -oE '^[0-9]+' | head -n 1)
  c=${c:-0}; total=$((total + c)); echo "ok: $c"
  grep -qE 'FAIL|too many arguments|unbound variable|bad substitution|syntax error' "$OUT" && bad=1
  [ $rc -eq 0 ] || { echo "exit $rc"; bad=1; }
  [ "$c" -gt 0 ] || { echo "no checks ran"; bad=1; }
  [ $bad -eq 0 ] || { grep -vE '^ok|checks passed|^SKIP' "$OUT"; fail=1; }; return $bad; }
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
[ $hook = 0 ] || run "attribution hook self-test" python3 "$T/../hooks/deny-ai-attribution.py" --self-test || failed="$failed hooks/deny-ai-attribution.py"
while IFS= read -r f <&3; do
  [ -f "$f" ] || continue  # a glob that matched nothing
  label=$(head -n 10 "$f" | grep -m 1 -E '^(#|//) suite: '); label=${label#* suite: }
  [ -n "$label" ] || label=${f##*/}
  case "$f" in *.sh) run "$label" "$SH" "$f" ;; *) run "$label" node "$f" ;; esac || failed="$failed ${f##*/}"
done 3<<EOF
$suites
EOF
# The last line names each failed suite by file, for the CI shard that ran it to report.
[ "$fail" = 0 ] && { echo; echo "all passed: $total checks"; } || { echo; echo "FAILURES above ($total checks passed)"; echo "failed suites:$failed"; }
exit $fail
