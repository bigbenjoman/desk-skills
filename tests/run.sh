#!/usr/bin/env bash
# Runs every desk-skills regression test. Each test uses a throwaway HOME and git repos; nothing
# touches your real ~/.claude, ~/.config/desk, repos, Jira or GitHub. Written for bash 3.2 (stock
# macOS /bin/bash) as well as 4+/5.
#   tests/run.sh                          every suite
#   tests/run.sh test_jira.sh test_ci.mjs only those suites (file names or paths under tests/), plus
#                                         the attribution hook self-test; an unknown name is an error
#   tests/run.sh --no-hook-test <suite>...  without the hook self-test (every CI shard but the first)
#   tests/run.sh -j 3 [<suite>...]        up to 3 suites at once, the longest recorded in
#                                         suite_durations.json first; each suite's report is printed in
#                                         one piece, in name order. -j 1 runs them one after another in
#                                         name order. Without -j: `desk-env get test-cap`, else a quarter
#                                         of the cores (at least 1).
# Every suite's TMPDIR is a symlink to the real temporary directory, on Linux as on a Mac.
# With the machine profile's job-tokens row on, each suite holds one job token from the machine's
# budget of test-lock-slots x test-cap while it runs, waiting in order for one (desk/bin/job-token.mjs).
# A suite that fails is run once more: passing then, the run passes and names it under `flaked:`;
# failing again, the run fails and prints both runs. test_compare_pass.sh is never retried.
# Each report gives the suite's user plus system CPU seconds, and a run that finishes appends one line
# to ~/.desk-autopilot/test-runs.jsonl ($TEST_RUNS_LOG): its date, suites, job count, wall and CPU
# seconds, the one-minute load average at its start, its scope (full or changed) and why, the worktree
# it ran in, the lock it ran under and the seconds it waited for it (null for each without one), and
# how many L3 suites related.sh left for CI (null for a run it did not start).
# related.sh gives the scope, its reason and that count (DESK_RUN_SCOPE, DESK_RUN_REASON,
# DESK_RUN_LEFT_FOR_CI); a run it did not start is
# full with no suite named and changed with some. with-lock.sh gives the lock (DESK_LOCK_CLASS,
# DESK_LOCK_WAITED).
# CI's CPU budgets: with DESK_SUITE_BUDGETS=warn, a suite whose last run took more CPU seconds than its
# budget prints a ::warning:: naming it and the summary lists it under `over budget:`; with `enforce`
# the same until BUDGETS_FAIL_FROM, and from that date (DESK_SUITE_BUDGETS_TODAY, YYYY-MM-DD, stands in
# for today) it fails the run. A suite's budget is the N of a `# budget: N <ticket>` line (`//` in .mjs)
# in its first ten lines, else 30 for a .mjs suite and 150 for any other; a line reading
# `# budget: N (main M) <ticket>` gives M instead unless GITHUB_EVENT_NAME is pull_request (suite_env.sh's
# budget_of). DESK_SUITE_DURATIONS names a
# file the run writes { seconds, cpu } to, each keyed by suite file, for tests/plan_shards.mjs --merge.
set -u
BUDGETS_FAIL_FROM=2026-12-08
budgets=${DESK_SUITE_BUDGETS:-}; today=${DESK_SUITE_BUDGETS_TODAY:-$(date -u +%Y-%m-%d)}; durations_out=${DESK_SUITE_DURATIONS:-}
case "$budgets" in
  '') ;;
  warn|enforce) case "$today" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "DESK_SUITE_BUDGETS_TODAY wants YYYY-MM-DD, not $today"; exit 2 ;; esac
    [ "$budgets" = enforce ] && [ "${today//-/}" -ge "${BUDGETS_FAIL_FROM//-/}" ] && budgets=fail ;;
  *) echo "DESK_SUITE_BUDGETS wants warn or enforce, not $budgets"; exit 2 ;;
esac
hook=1; jobs=; jset=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-hook-test) hook=0; shift ;;
    -j) jobs=${2:-}; jset=1; shift; [ $# -gt 0 ] && shift ;;
    -j*) jobs=${1#-j}; jset=1; shift ;;
    *) break ;;
  esac
done
if [ $jset = 0 ]; then
  jobs=$(desk-env get test-cap 2>/dev/null); jobs=${jobs//[[:space:]]/}
  case "$jobs" in ''|*[!0-9]*|0) cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
    case "$cores" in ''|*[!0-9]*) cores=4 ;; esac
    jobs=$((cores / 4)); [ "$jobs" -ge 1 ] || jobs=1 ;;
  esac
fi
case "$jobs" in ''|*[!0-9]*) jobs=0 ;; *) jobs=$((10#$jobs)) ;; esac
[ "$jobs" -ge 1 ] || { echo "-j wants how many suites run at once, a whole number from 1"; exit 2; }
T="$(cd "$(dirname "$0")" && pwd)"
# The run's scope and slot, for its record, read before suite_env.sh clears every DESK_* variable.
rec_scope=${DESK_RUN_SCOPE:-}; rec_reason=${DESK_RUN_REASON:-}; rec_lock=${DESK_LOCK_CLASS:-}; rec_waited=${DESK_LOCK_WAITED:-}; rec_left=${DESK_RUN_LEFT_FOR_CI:-}
if [ -z "$rec_scope" ]; then
  if [ $# -gt 0 ]; then rec_scope=changed; rec_reason="suites named on the command line"
  else rec_scope=full; rec_reason="no suite named"; fi
fi
case "$rec_waited" in ''|*[!0-9]*) rec_waited=null ;; esac
case "$rec_left" in ''|*[!0-9]*) rec_left=null ;; esac
rec_tree=$(cd "$T/.." && pwd -P)
# Job tokens (desk/bin/job-token.mjs), with the machine profile's job-tokens row on: each suite holds
# one from the machine's job pool, test-lock-slots x test-cap, for as long as it runs, waiting its turn
# for one when every token is held. The helper runs with the DESK_* variables it reads saved here, as
# suite_env.sh clears them. A run.sh that a suite starts takes none: that suite holds one already.
jt=; jt_bin="$T/../desk/bin/job-token.mjs"; jt_env=
if [ "${TEST_JOB_TOKENS:-}" != held ] && [ -f "$jt_bin" ] && [ "$(node "$jt_bin" lever 2>/dev/null)" = on ]; then
  jt=on
  for v in DESK_LEASE_DIR DESK_MACHINE DESK_CONFIG_ROOT DESK_TEST_LOCK_SLOTS DESK_LOCK_DIR; do
    eval "jv=\${$v-}"; [ -z "$jv" ] || jt_env="$jt_env export $v=$(printf %q "$jv");"
  done
fi
export TEST_JOB_TOKENS=held
# shellcheck source=suite_env.sh
. "$T/suite_env.sh"
# Where the run's record goes ($TEST_RUNS_LOG, set empty for none). A run.sh a suite starts records
# nothing: only the outer run is a run.
runs_log=${TEST_RUNS_LOG-$HOME/.desk-autopilot/test-runs.jsonl}; export TEST_RUNS_LOG=
OUT="$(mktemp -d "${TMPDIR:-/tmp}/desk-test.XXXXXX")" || exit 1
# Every suite's TMPDIR is a symlink to the real temporary directory, as a Mac's /var/folders is (under
# /var, itself a link to /private/var), so a test that confuses a path with its resolved form fails
# on Linux too.
ln -s "$(cd "${TMPDIR:-/tmp}" && pwd -P)" "$OUT/tmp" || exit 1
export TMPDIR="$OUT/tmp"
# The run's template repos (tests/lib/repo_template.sh): built once, shared by every suite in it. Not
# a DESK_* name: suites see no DESK_* variable but the ones suite_env.sh keeps (test_run_env.sh).
export REPO_TPL_ROOT="$OUT/tpl"
pids=""
# A stopped run stops its suites first: each job passes the TERM on to its suite and waits for it, and
# this waits for every job, so a lock held around run.sh is not released while a suite still runs.
stop_jobs() { for p in $pids; do kill "$p" 2>/dev/null; done; wait; rm -rf "$OUT"; }
trap stop_jobs EXIT
trap 'exit 130' INT; trap 'exit 143' TERM
echo "bash $BASH_VERSION ($SH); scripts with #!/usr/bin/env bash get $(command -v bash)"
[ "$jobs" -eq 1 ] || echo "up to $jobs suites at once"
fail=0; total=0; failed=""; flaked=""; slow=""; dsec=""; dcpu=""; cpu_all=0; ran=""; start=$SECONDS
# The one-minute load average now: Linux's /proc/loadavg, else macOS's `{ 1.23 1.45 1.67 }`.
if [ -r /proc/loadavg ]; then read -r load _ </proc/loadavg; else load=$(sysctl -n vm.loadavg 2>/dev/null); load=${load#\{ }; load=${load%% *}; fi
case "$load" in ''|*[!0-9.]*) load=null ;; esac
# The run's suites, by index: label, how it runs (hook, sh or mjs), its file, the name a failure gives
# and its CPU budget in seconds.
n=0
add() { lab[n]=$1; kind[n]=$2; file[n]=$3; name[n]=$4; bud[n]=$5; n=$((n + 1)); }
# Milliseconds in a `times` figure such as 1m2.345s (1m2,345s where the locale's decimal point is a
# comma), into $ms.
to_ms() { local m=${1%%m*} w=${1#*m} f; w=${w%s}; w=${w/,/.}; f=${w#*.}; [ "$f" = "$w" ] && f=0; f="${f}000"
  ms=$(( (10#$m * 60 + 10#${w%%.*}) * 1000 + 10#${f:0:3} )); }
# The checks output $1 shows passing: its ok lines, else the first `<n> checks passed`; into $c.
checks_in() { c=$(grep -c "^ok" "$1")
  [ "$c" -gt 0 ] || c=$(grep -oE '[0-9]+ checks passed' "$1" | grep -oE '^[0-9]+' | head -n 1); c=${c:-0}; }
# Why output $1 with exit $2 failed, one reason a line, into $why; empty when it passed. A suite fails
# on a FAIL line, a non-zero exit, a bash error, or no checks at all.
why_failed() { why=; checks_in "$1"
  grep -qE 'FAIL|too many arguments|unbound variable|bad substitution|syntax error' "$1" && why="failed"
  [ "$2" -eq 0 ] || why="${why:+$why
}exit $2"
  [ "$c" -gt 0 ] || why="${why:+$why
}no checks ran"; }
# The CPU milliseconds suite $1's job has waited for so far, into $cpu: the second line of `times`,
# written to a file because $(times) would be a new process.
cpu_now() { times >"$OUT/$1.times"; { read -r _; read -r cu cs; } <"$OUT/$1.times"
  to_ms "$cu"; cpu=$ms; to_ms "$cs"; cpu=$((cpu + ms)); }
# Runs suite $1 into its own output file, then writes "<exit> <seconds> <CPU ms> <runs> <first exit>
# <last run's CPU ms>" to its done file, last, so a done file means the output is complete. A suite that
# fails runs once more, its first output kept as $1.out1, so one flake costs a suite's time rather than a
# CI rerun; test_compare_pass.sh never does, as it is there to find nondeterminism. The suite replaces
# its subshell (exec), so with -j above 1 the pid this job waits on and passes a TERM to is the suite's
# own. The CPU is both runs'. With job tokens on, the job takes its suite's token first, owned by the
# job's own process (the pid of the sh it execs, whose parent it is), and gives it back once the suite
# has exited, before its done file; a job killed first leaves it to lapse. Without one, the suite runs.
# The suite's seconds and CPU start once it has its token, so neither counts the wait or the helper.
job() { c=; runs=0; rc1=0; cpu1=0; cpu0=0; tok=; me=
  if [ -n "$jt" ]; then me=$(exec sh -c 'echo "$PPID"')
    tok=$(eval "$jt_env"; exec node "$jt_bin" take --pid "$me" --worktree "$rec_tree" -- "${name[$1]}")
    cpu_now "$1"; cpu0=$cpu; fi
  s=$SECONDS
  suite() { case "${kind[$1]}" in
      hook) exec python3 "${file[$1]}" --self-test ;;
      sh) exec "$SH" "${file[$1]}" ;;
      *) exec node "${file[$1]}" ;;
    esac; }
  [ "$jobs" -eq 1 ] || trap '[ -z "$c" ] || { kill "$c" 2>/dev/null; wait "$c"; }; exit 143' TERM
  while :; do
    runs=$((runs + 1))
    if [ "$jobs" -eq 1 ]; then (suite "$1") >"$OUT/$1.out" 2>&1; rc=$?
    else (suite "$1") >"$OUT/$1.out" 2>&1 & c=$!; wait "$c"; rc=$?; c=
    fi
    [ $runs -eq 1 ] && [ "${name[$1]}" != test_compare_pass.sh ] || break
    why_failed "$OUT/$1.out" "$rc"; [ -n "$why" ] || break
    mv "$OUT/$1.out" "$OUT/$1.out1"; rc1=$rc; cpu_now "$1"; cpu1=$((cpu - cpu0))
  done
  cpu_now "$1"; cpu=$((cpu - cpu0))
  [ -z "$tok" ] || (eval "$jt_env"; exec node "$jt_bin" release "$tok" --pid "$me") >/dev/null
  echo "$rc $((SECONDS - s)) $cpu $runs $rc1 $((cpu - cpu1))" >"$OUT/$1.tmp" && mv "$OUT/$1.tmp" "$OUT/$1.done"; }
# Whole and thousandths of a second for $1 milliseconds.
secs() { printf '%d.%03d' $(($1 / 1000)) $(($1 % 1000)); }
# Output $1's failure, exit $2: why, then the whole output but its ok lines, so whatever the suite said
# about the failure is in the log.
show_failure() { why_failed "$1" "$2"; printf '%s\n' "$why" | grep -v '^failed$'
  grep -vE '^ok|checks passed|^SKIP' "$1"; }
# A failed suite fails the run. One that failed and passed on its retry is named as flaked, with its
# first run's failure printed so it can be fixed; one that failed both runs prints both.
# `took: <s> s` is the suite's own time, both runs when it ran twice, which tests/plan_shards.mjs
# --record reads. A budget is checked against the last run's CPU, so a retry does not double it.
report() { o="$OUT/$1.out"; read -r rc took cpu runs rc1 last <"$OUT/$1.done"
  printf '\n== %s\n' "${lab[$1]}"
  grep -E "checks passed|^SKIP" "$o"; checks_in "$o"
  total=$((total + c)); echo "ok: $c"; echo "took: $took s"; echo "cpu: $(secs "$cpu") s"
  cpu_all=$((cpu_all + cpu)); ran="$ran${ran:+,}\"${name[$1]}\""
  [ "${kind[$1]}" = hook ] || { dsec="$dsec${dsec:+,}\"${name[$1]}\":$took"; dcpu="$dcpu${dcpu:+,}\"${name[$1]}\":$(secs "$cpu")"; }
  over=
  if [ -n "$budgets" ] && [ "$last" -gt $((bud[$1] * 1000)) ]; then
    over="${name[$1]} used $(secs "$last") CPU seconds, over its budget of ${bud[$1]}"
    slow="$slow ${name[$1]}=$(secs "$last")/${bud[$1]}"
    case "$budgets" in
      fail) echo "::error::$over" ;;
      enforce) echo "::warning::$over (a failure from $BUDGETS_FAIL_FROM)" ;;
      *) echo "::warning::$over" ;;
    esac
  fi
  why_failed "$o" "$rc"; bad=$why
  if [ "${runs:-1}" -gt 1 ]; then
    if [ -z "$bad" ]; then echo "retried: failed its first run, passed its retry"; flaked="$flaked ${name[$1]}"; fi
    echo "-- first run"; show_failure "$o"1 "$rc1"
    [ -z "$bad" ] || echo "-- retry"
  fi
  [ -z "$bad" ] || show_failure "$o" "$rc"
  if [ -n "$bad" ] || { [ -n "$over" ] && [ "$budgets" = fail ]; }; then fail=1; failed="$failed ${name[$1]}"; fi; }
# Every tests/test_*.sh and tests/test_*.mjs is a suite, run in name order, so adding one needs no
# edit here. Its label is the first `# suite: <label>` (`// suite: <label>` in .mjs) line in its
# first ten lines, or the file name without one. Its CPU budget is the N of its first `# budget: N`
# line there, else BUDGET_MJS or BUDGET_ANY.
BUDGET_MJS=30; BUDGET_ANY=150
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
[ $hook = 0 ] || add "attribution hook self-test" hook "$T/../hooks/deny-ai-attribution.py" hooks/deny-ai-attribution.py $BUDGET_ANY
while IFS= read -r f; do
  [ -f "$f" ] || continue  # a glob that matched nothing
  label=$(head -n 10 "$f" | grep -m 1 -E '^(#|//) suite: '); label=${label#* suite: }
  [ -n "$label" ] || label=${f##*/}
  b=$(budget_of "$f")
  case "$f" in
    *.sh) add "$label" sh "$f" "${f##*/}" "$((10#${b:-$BUDGET_ANY}))" ;;
    *) add "$label" mjs "$f" "${f##*/}" "$((10#${b:-$BUDGET_MJS}))" ;;
  esac
done <<EOF
$suites
EOF
# The order suites start in, ord[]: name order with -j 1, otherwise the order plan_shards.mjs plans
# CI's shards in (the longest recorded in suite_durations.json first), or name order if it cannot say.
# It is named by its physical path: it runs its CLI only when argv[1] is its own resolved path.
name_order() { i=0; while [ $i -lt $n ]; do ord[i]=$i; i=$((i + 1)); done; }
name_order
if [ "$jobs" -gt 1 ] && [ $n -gt 1 ]; then
  k=0; TP=$(cd "$T" && pwd -P)
  while IFS= read -r s; do
    i=0; while [ $i -lt $n ] && [ "${name[$i]}" != "$s" ]; do i=$((i + 1)); done
    [ $i -lt $n ] && { ord[k]=$i; k=$((k + 1)); }
  done <<EOF
$(node "$TP/plan_shards.mjs" --order "${name[@]}" 2>/dev/null)
EOF
  [ $k -eq $n ] || name_order
fi
# Up to $jobs suites run at once, each in its own temporary HOME and directories (the suites' own
# mktemp), and each is reported once it and every suite before it in name order have finished. With
# -j 1 each runs in the foreground, one after another. $live holds the started suites not yet done.
started=0; shown=0; live=""
while [ $shown -lt $n ]; do
  if [ -f "$OUT/$shown.done" ]; then report $shown; shown=$((shown + 1)); continue; fi
  still=""; running=0
  for k in $live; do [ -f "$OUT/$k.done" ] || { still="$still $k"; running=$((running + 1)); }; done
  live=$still
  if [ $running -lt "$jobs" ] && [ $started -lt $n ]; then
    i=${ord[$started]}
    if [ "$jobs" -eq 1 ]; then (job "$i"); else job "$i" & pids="$pids $!"; fi
    live="$live $i"; started=$((started + 1)); continue
  fi
  sleep 0.2
done
wait; pids=""
wall=$((SECONDS - start))
# $1 as a JSON string, or null when it is empty.
jstr() { local s=$1; [ -n "$s" ] || { printf null; return; }; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
[ -z "$runs_log" ] || ( mkdir -p "$(dirname "$runs_log")" && printf '{"date":"%s","suites":[%s],"jobs":%d,"wall_s":%d,"cpu_s":%s,"load":%s,"scope":%s,"reason":%s,"worktree":%s,"lock":%s,"wait_s":%s,"left_for_ci":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ran" "$jobs" "$wall" "$(secs "$cpu_all")" "$load" \
  "$(jstr "$rec_scope")" "$(jstr "$rec_reason")" "$(jstr "$rec_tree")" "$(jstr "$rec_lock")" "$rec_waited" "$rec_left" >>"$runs_log" ) 2>/dev/null
[ -z "$durations_out" ] || printf '{"seconds":{%s},"cpu":{%s}}\n' "$dsec" "$dcpu" >"$durations_out"
# The last lines name each suite that flaked (failed, then passed its retry), each over its CPU budget
# (as <suite>=<CPU seconds>/<budget>) and each that failed, by file, for the CI shard that ran them to
# report.
[ -z "$flaked" ] || { echo; echo "flaked:$flaked"; }
[ -z "$slow" ] || { echo; echo "over budget:$slow"; }
[ "$fail" = 0 ] && { echo; echo "all passed: $total checks"; } || { echo; echo "FAILURES above ($total checks passed)"; echo "failed suites:$failed"; }
exit $fail
