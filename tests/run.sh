#!/usr/bin/env bash
# Runs every desk-skills regression test. Each test uses a throwaway HOME and git repos; nothing
# touches your real ~/.claude, ~/.config/desk, repos, Jira or GitHub. Written for bash 3.2 (stock
# macOS /bin/bash) as well as 4+/5.
#   tests/run.sh                          every suite
#   tests/run.sh test_jira.sh test_ci.mjs only those suites (file names or paths under tests/), plus
#                                         the attribution hook self-test; an unknown name is an error
#   tests/run.sh --no-hook-test <suite>...  without the hook self-test (every CI shard but the first)
#   tests/run.sh -j 3 [<suite>...]        up to 3 suites at once (default 1, one after another); each
#                                         suite's report is printed in one piece, in name order
set -u
hook=1; jobs=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-hook-test) hook=0; shift ;;
    -j) jobs=${2:-}; shift; [ $# -gt 0 ] && shift ;;
    -j*) jobs=${1#-j}; shift ;;
    *) break ;;
  esac
done
case "$jobs" in ''|*[!0-9]*) jobs=0 ;; esac
[ "$jobs" -ge 1 ] || { echo "-j wants how many suites run at once, a whole number from 1"; exit 2; }
T="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=suite_env.sh
. "$T/suite_env.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/desk-test.XXXXXX")" || exit 1
# The run's template repos (tests/lib/repo_template.sh): built once, shared by every suite in it.
export DESK_TPL_ROOT="$OUT/tpl"
pids=""
# A stopped run stops its suites first: each job passes the TERM on to its suite and waits for it, and
# this waits for every job, so a lock held around run.sh is not released while a suite still runs.
stop_jobs() { for p in $pids; do kill "$p" 2>/dev/null; done; wait; rm -rf "$OUT"; }
trap stop_jobs EXIT
trap 'exit 130' INT; trap 'exit 143' TERM
echo "bash $BASH_VERSION ($SH); scripts with #!/usr/bin/env bash get $(command -v bash)"
[ "$jobs" -eq 1 ] || echo "up to $jobs suites at once"
fail=0; total=0; failed=""
# The run's suites, by index: label, how it runs (hook, sh or mjs), its file and the name a failure gives.
n=0
add() { lab[n]=$1; kind[n]=$2; file[n]=$3; name[n]=$4; n=$((n + 1)); }
# Runs suite $1 into its own output file, then writes "<exit> <seconds>" to its done file, last, so a
# done file means the output is complete. The suite replaces its subshell (exec), so with -j above 1
# the pid this job waits on and passes a TERM to is the suite's own.
job() { s=$SECONDS; c=
  suite() { case "${kind[$1]}" in
      hook) exec python3 "${file[$1]}" --self-test ;;
      sh) exec "$SH" "${file[$1]}" ;;
      *) exec node "${file[$1]}" ;;
    esac; }
  if [ "$jobs" -eq 1 ]; then (suite "$1") >"$OUT/$1.out" 2>&1; rc=$?
  else
    trap '[ -z "$c" ] || { kill "$c" 2>/dev/null; wait "$c"; }; exit 143' TERM
    (suite "$1") >"$OUT/$1.out" 2>&1 & c=$!
    wait "$c"; rc=$?
  fi
  echo "$rc $((SECONDS - s))" >"$OUT/$1.tmp" && mv "$OUT/$1.tmp" "$OUT/$1.done"; }
# A suite fails the run on a FAIL line, a non-zero exit, a bash error, or no checks at all. A failed
# suite's whole output but its ok lines is printed, so whatever it said about the failure is in the log.
# `took: <s> s` is the suite's own time, which tests/plan_shards.mjs --record reads.
report() { o="$OUT/$1.out"; read -r rc took <"$OUT/$1.done"; bad=0
  printf '\n== %s\n' "${lab[$1]}"
  grep -E "checks passed|^SKIP" "$o"; c=$(grep -c "^ok" "$o")
  [ "$c" -gt 0 ] || c=$(grep -oE '[0-9]+ checks passed' "$o" | grep -oE '^[0-9]+' | head -n 1)
  c=${c:-0}; total=$((total + c)); echo "ok: $c"; echo "took: $took s"
  grep -qE 'FAIL|too many arguments|unbound variable|bad substitution|syntax error' "$o" && bad=1
  [ "$rc" -eq 0 ] || { echo "exit $rc"; bad=1; }
  [ "$c" -gt 0 ] || { echo "no checks ran"; bad=1; }
  [ $bad -eq 0 ] || { grep -vE '^ok|checks passed|^SKIP' "$o"; fail=1; failed="$failed ${name[$1]}"; }; }
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
[ $hook = 0 ] || add "attribution hook self-test" hook "$T/../hooks/deny-ai-attribution.py" hooks/deny-ai-attribution.py
while IFS= read -r f; do
  [ -f "$f" ] || continue  # a glob that matched nothing
  label=$(head -n 10 "$f" | grep -m 1 -E '^(#|//) suite: '); label=${label#* suite: }
  [ -n "$label" ] || label=${f##*/}
  case "$f" in *.sh) add "$label" sh "$f" "${f##*/}" ;; *) add "$label" mjs "$f" "${f##*/}" ;; esac
done <<EOF
$suites
EOF
# Up to $jobs suites run at once, each in its own temporary HOME and directories (the suites' own
# mktemp), and each is reported once it and every suite before it have finished. With -j 1 each runs
# in the foreground, one after another.
started=0; shown=0
while [ $shown -lt $n ]; do
  if [ -f "$OUT/$shown.done" ]; then report $shown; shown=$((shown + 1)); continue; fi
  running=$((started - shown)); k=$shown
  while [ $k -lt $started ]; do [ -f "$OUT/$k.done" ] && running=$((running - 1)); k=$((k + 1)); done
  if [ $running -lt "$jobs" ] && [ $started -lt $n ]; then
    if [ "$jobs" -eq 1 ]; then (job $started); else job $started & pids="$pids $!"; fi
    started=$((started + 1)); continue
  fi
  sleep 0.2
done
wait; pids=""
# The last line names each failed suite by file, for the CI shard that ran it to report.
[ "$fail" = 0 ] && { echo; echo "all passed: $total checks"; } || { echo; echo "FAILURES above ($total checks passed)"; echo "failed suites:$failed"; }
exit $fail
