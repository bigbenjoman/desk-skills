#!/usr/bin/env bash
# suite: run.sh runs up to test-cap suites at once, longest first, and records CPU seconds per suite and per run
# layer: L2
# A copy of run.sh in a scratch repo, with a stub desk-env for the cap, runs fixture suites that log
# when they start and end, count how many run at once, or burn CPU. Every check runs under this
# suite's bash and again under /bin/bash where that is bash 3.2 (stock macOS).
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
unset TEST_RUNS_LOG
PASS=0; FAIL=0
check(){ if [ -n "${2:-}" ] && eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

R="$T/repo/tests"; mkdir -p "$R"
for f in run.sh ci_shard.sh suite_env.sh plan_shards.mjs scope_sections.mjs; do cat "$S/$f" > "$R/$f"; done
mkdir -p "$T/repo/desk/bin"; for f in quantile.mjs untracked.mjs; do cat "$S/../desk/bin/$f" > "$T/repo/desk/bin/$f"; done
printf '{\n  "seconds": {\n    "test_a.sh": 1,\n    "test_b.sh": 50,\n    "test_c.sh": 10,\n    "test_d.sh": 30\n  }\n}\n' > "$R/suite_durations.json"
# test_p1..p5: each waits until four run at once (or one has finished), then writes how many it saw.
for p in 1 2 3 4 5; do cat > "$R/test_p$p.sh" <<'EOF'
: > "$CONC/$$"; i=0
while [ "$(ls "$CONC" | wc -l)" -lt 4 ] && [ ! -e "$LEFT" ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
ls "$CONC" | wc -l | tr -d ' ' >> "$SEEN"
sleep 0.3; rm -f "$CONC/$$"; : > "$LEFT"; echo "ok p"
EOF
done
# test_a..d: log their start and end; b and d end first under -j 2, so c starts before a.
for x in a:0.1 b:0.5 c:2 d:1.5; do
  printf 'echo "start %s" >> "$LOG"; sleep %s; echo "end %s" >> "$LOG"; echo "ok %s"\n' "${x%%:*}" "${x#*:}" "${x%%:*}" "${x%%:*}" > "$R/test_${x%%:*}.sh"
done
printf 'i=0; while [ $i -lt 300000 ]; do i=$((i + 1)); done; echo "ok burn"\n' > "$R/test_burn.sh"
printf 'echo "ok one"\n' > "$R/test_one.sh"
# Retry probes, each logging a line to $RUNS per run: test_flaky fails its first run only (its flag file
# says it has run), test_broken always fails, and test_compare_pass.sh, the stand-in, fails once too.
printf 'echo flaky >> "$RUNS"\nif [ -e "$FLAG" ]; then echo "ok flaky"; else : > "$FLAG"; echo "FAIL flaky first run"; exit 1; fi\n' > "$R/test_flaky.sh"
printf 'echo broken >> "$RUNS"\necho "ok broken half"; echo "FAIL broken run $(grep -c broken "$RUNS")"\n' > "$R/test_broken.sh"
printf 'echo compare >> "$RUNS"\nif [ -e "$FLAG.c" ]; then echo "ok compare"; else : > "$FLAG.c"; echo "FAIL compare first run"; fi\n' > "$R/test_compare_pass.sh"
printf 'echo pass >> "$RUNS"; echo "ok pass"\n' > "$R/test_pass.sh"
# A suite whose budget line gives it no CPU seconds at all, so any run is over it.
printf '# budget: 0 DS-1 a fixture\ni=0; while [ $i -lt 100000 ]; do i=$((i + 1)); done; echo "ok over"\n' > "$R/test_over.sh"
# One whose pull-request budget is 0 and whose main one (a push or a local run) is 1000.
printf '# budget: 0 (main 1000) DS-942 a fixture\ni=0; while [ $i -lt 100000 ]; do i=$((i + 1)); done; echo "ok split"\n' > "$R/test_split.sh"

# The stub desk-env prints $CAP for test-cap, and exits 3 (unset) without it.
STUB="$T/stub"; mkdir -p "$STUB"
printf '#!/bin/sh\n[ "$1 $2" = "get test-cap" ] && [ -n "${CAP:-}" ] && { echo "$CAP"; exit 0; }\nexit 3\n' > "$STUB/desk-env"
chmod +x "$STUB/desk-env"
# PATH without any desk-env on it.
BARE=""; IFS=: read -r -a dirs <<EOF
$PATH
EOF
for d in "${dirs[@]}"; do [ -n "$d" ] && [ ! -x "$d/desk-env" ] && BARE="$BARE${BARE:+:}$d"; done
cores=$(getconf _NPROCESSORS_ONLN); quarter=$((cores / 4)); [ "$quarter" -ge 1 ] || quarter=1
LOGF="$HOME/.desk-autopilot/test-runs.jsonl"
# The job count the last line of the run record gives.
jobs_of(){ tail -n 1 "$LOGF" | grep -oE '"jobs":[0-9]+' | grep -oE '[0-9]+'; }
# The suites in the order their start lines were logged.
starts(){ grep '^start' "$LOG" | tr '\n' ' '; }
blocks(){ printf '%s\n' "$out" | grep '^== ' | tr '\n' ' '; }

# Job tokens (DS-983): a second scratch repo whose desk/ is the real one, so run.sh finds
# desk/bin/job-token.mjs, run against a fixture machine profile and a scratch lease directory. A suite
# starts with no DESK_* variable, so a fixture suite finds the lease store through $LEASES.
J="$T/jrepo/tests"; mkdir -p "$J"
for f in run.sh suite_env.sh plan_shards.mjs scope_sections.mjs; do cat "$S/$f" > "$J/$f"; done
ln -s "$(cd "$S/.." && pwd)/desk" "$T/jrepo/desk"
# test_j1..j3: each writes its name, how many job tokens its own label holds and how many suites run
# at once, then waits half a second.
for x in 1 2 3; do cat > "$J/test_j$x.sh" <<EOF
: > "\$CONC/\$\$"; mine=\$(grep -oE '"label": ?"job test_j$x\.sh in ' "\$LEASES/leases.json" | wc -l | tr -d ' ')
echo "test_j$x.sh \$mine \$(ls "\$CONC" | wc -l | tr -d ' ')" >> "\$SEEN"
sleep 0.5; rm -f "\$CONC/\$\$"; echo "ok j$x"
EOF
done
printf ': > "$STARTED"; exec sleep 30\n' > "$J/test_jsleep.sh"
# A machine profile holding Sizing rows $2..., written as $T/machine-$1.md, its path printed.
profile(){ p="$T/machine-$1.md"; shift; printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n' > "$p"
  for kv in "$@"; do printf '| `%s` | `%s` | test |\n' "${kv%%=*}" "${kv#*=}" >> "$p"; done; echo "$p"; }
P_NONE=$(profile none test-lock-slots=3 test-cap=4)
P_BAD=$(profile bad job-tokens=maybe test-lock-slots=3 test-cap=4)
P_ON=$(profile on job-tokens=on test-lock-slots=3 test-cap=4)
P_ONE=$(profile one job-tokens=on test-lock-slots=1 test-cap=1)
# run.sh under bash $B against profile $1, as an outer run (TEST_JOB_TOKENS is held inside this suite).
jrun(){ m=$1; shift; TEST_JOB_TOKENS='' DESK_MACHINE="$m" DESK_LEASE_DIR="$LEASES" "$B" "$J/run.sh" --no-hook-test "$@"; }
# How many lines of the lease log are a job token's $1 event.
jlog(){ grep "\"event\":\"$1\"" "$LEASES/leases.log.jsonl" 2>/dev/null | grep -c '"key":"job"'; }
fresh_jobs(){ k=$((k + 1)); export LEASES="$T/leases-$v-$k" CONC="$T/jconc-$v-$k" SEEN="$T/jseen-$v-$k"; mkdir -p "$CONC"; : > "$SEEN"; }
k=0
token_checks(){
  # AC1: no job-tokens row, and AC6: a row that is neither on nor off: no token is taken.
  for c in "$P_NONE:no job-tokens row" "$P_BAD:job-tokens maybe"; do
    fresh_jobs; pf=${c%%:*}
    out=$(jrun "$pf" -j 2 test_j1.sh test_j2.sh 2>&1); rc=$?
    check "DS-983 AC1 AC6 $at ${c#*:}: run.sh takes no job token and runs as before" \
      '[ $rc -eq 0 ] && [ ! -e "$LEASES/leases.log.jsonl" ] && [ "$(wc -l < "$SEEN" | tr -d " ")" = 2 ] && printf "%s\n" "$out" | grep -qx "all passed: 2 checks"'
  done
  # AC3: on, with 12 tokens: each suite holds one token of its own while it runs, and the log has a
  # take and a release for each.
  fresh_jobs; out=$(jrun "$P_ON" -j 1 test_j1.sh test_j2.sh test_j3.sh 2>&1); rc=$?
  out="$out
seen: $(cat "$SEEN")"
  check "DS-983 AC3 $at job-tokens on: each suite holds one job token while it runs" \
    '[ $rc -eq 0 ] && [ "$(cut -d " " -f 1,2 "$SEEN" | tr "\n" " ")" = "test_j1.sh 1 test_j2.sh 1 test_j3.sh 1 " ]'
  check "DS-983 AC3 $at and the lease log records a take and a release for each, with none held after" \
    '[ "$(jlog grant)" = 3 ] && [ "$(jlog release)" = 3 ] && [ -f "$LEASES/leases.json" ] && ! grep -qE "\"key\": ?\"job\"" "$LEASES/leases.json"'
  # AC4: on, with one token: -j 3 runs one suite at a time, the others waiting in order for the token.
  fresh_jobs; out=$(jrun "$P_ONE" -j 3 test_j1.sh test_j2.sh test_j3.sh 2>&1); rc=$?
  most=$(cut -d " " -f 3 "$SEEN" | LC_ALL=C sort -n | tail -n 1)
  check "DS-983 AC4 $at one token: the suites wait their turn for it, one running at a time, and all run" \
    '[ $rc -eq 0 ] && [ "$most" = 1 ] && [ "$(wc -l < "$SEEN" | tr -d " ")" = 3 ] && [ "$(jlog grant)" = 3 ]'
  check "DS-983 AC4 $at and a waiting suite says what it waits for and its place" \
    'printf "%s\n" "$out" | grep -qE "^run\.sh: test_j[0-9]\.sh waits for a job token \(1 on this machine\), position [0-9]+ of [0-9]+: "'
  # AC5: a run.sh stopped mid-suite: once its suite has exited, its token lapses and the next run gets it.
  fresh_jobs; export STARTED="$T/started-$v"; rm -f "$STARTED"
  TEST_JOB_TOKENS='' DESK_MACHINE="$P_ONE" DESK_LEASE_DIR="$LEASES" "$B" "$J/run.sh" --no-hook-test -j 2 test_jsleep.sh >"$T/killed-$v.out" 2>&1 & bg=$!
  i=0; while [ ! -e "$STARTED" ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i + 1)); done
  kill -TERM "$bg" 2>/dev/null; wait "$bg" 2>/dev/null
  out=$(jrun "$P_ONE" -j 1 test_j1.sh 2>&1); rc=$?
  check "DS-983 AC5 $at a run.sh killed mid-suite: its token lapses, and the next run takes it" \
    '[ -e "$STARTED" ] && [ $rc -eq 0 ] && [ "$(grep "\"event\":\"lapse\"" "$LEASES/leases.log.jsonl" | grep "\"key\":\"job\"" | grep -c "owner exited")" = 1 ] && [ "$(jlog grant)" = 2 ]'
}

checks(){ B=$1; v=$("$B" -c 'echo "${BASH_VERSINFO[0]}"'); at="(bash $v)"

  # AC1: no -j, test-cap 4: four of the five rendezvous suites run at once, never five.
  export CONC="$T/conc$v" LEFT="$T/left$v" SEEN="$T/seen$v"; mkdir -p "$CONC"; rm -f "$LEFT" "$SEEN"
  out=$(CAP=4 PATH="$STUB:$PATH" "$B" "$R/run.sh" --no-hook-test test_p1.sh test_p2.sh test_p3.sh test_p4.sh test_p5.sh 2>&1); rc=$?
  most=$(LC_ALL=C sort -n "$SEEN" | tail -n 1)
  check "AC1 $at no -j and test-cap 4: up to 4 suites run at once" '[ $rc -eq 0 ] && [ "$most" = 4 ] && [ "$(jobs_of)" = 4 ]'

  # AC2: no -j, desk-env missing or test-cap unset: a quarter of the cores, at least 1.
  out=$(PATH="$BARE" "$B" "$R/run.sh" --no-hook-test test_one.sh 2>&1); rc=$?
  check "AC2 $at no desk-env on PATH: $quarter at once ($cores cores)" '[ $rc -eq 0 ] && [ "$(jobs_of)" = "$quarter" ]'
  out=$(CAP='' PATH="$STUB:$PATH" "$B" "$R/run.sh" --no-hook-test test_one.sh 2>&1); rc=$?
  check "AC2 $at test-cap unset: $quarter at once" '[ $rc -eq 0 ] && [ "$(jobs_of)" = "$quarter" ]'
  # A leading zero is decimal, as the scheduler's test comparisons read it, never octal.
  out=$(CAP=08 PATH="$STUB:$PATH" "$B" "$R/run.sh" --no-hook-test test_one.sh 2>&1); rc=$?
  check "AC1 $at test-cap 08 runs and records 8 at once" \
    '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "^up to 8 suites at once$" && [ "$(jobs_of)" = 8 ]'

  # AC3: -j 1 runs one at a time in name order, whatever the recorded durations.
  export LOG="$T/log1-$v"; : > "$LOG"
  out=$(CAP=4 PATH="$STUB:$PATH" "$B" "$R/run.sh" --no-hook-test -j 1 test_a.sh test_b.sh test_c.sh test_d.sh 2>&1); rc=$?
  check "AC3 $at -j 1 runs them one after another in name order" \
    '[ $rc -eq 0 ] && [ "$(tr "\n" " " < "$LOG")" = "start a end a start b end b start c end c start d end d " ]'

  # AC4: -j 2 starts the longest recorded first (b 50, d 30, c 10, a 1), and reports in name order.
  export LOG="$T/log2-$v"; : > "$LOG"
  out=$("$B" "$R/run.sh" --no-hook-test -j 2 test_a.sh test_b.sh test_c.sh test_d.sh 2>&1); rc=$?
  first=$(starts)
  check "AC4 $at -j 2 starts b and d, then c, then a" \
    '[ $rc -eq 0 ] && case "$first" in "start b start d start c start a "|"start d start b start c start a ") true ;; *) false ;; esac'
  check "AC4 $at and still reports in name order" '[ "$(blocks)" = "== test_a.sh == test_b.sh == test_c.sh == test_d.sh " ]'

  # AC5: each report gives the suite's user plus system CPU seconds.
  out=$("$B" "$R/run.sh" --no-hook-test -j 2 test_burn.sh test_one.sh 2>&1); rc=$?
  burn=$(printf '%s\n' "$out" | grep -A 4 '^== test_burn.sh' | grep -E '^cpu: [0-9]+\.[0-9]{3} s$' | grep -oE '[0-9]+\.[0-9]+' | tr -d .)
  one=$(printf '%s\n' "$out" | grep -A 4 '^== test_one.sh' | grep -E '^cpu: [0-9]+\.[0-9]{3} s$' | grep -oE '[0-9]+\.[0-9]+' | tr -d .)
  check "AC5 $at a suite's report gives its CPU seconds" \
    '[ $rc -eq 0 ] && [ -n "$burn" ] && [ -n "$one" ] && [ $((10#$burn)) -ge 200 ] && [ $((10#$one)) -lt $((10#$burn)) ]'

  # AC6: the run appends one line: date, suites, job count, wall and CPU seconds, load at start.
  out=$(tail -n 1 "$LOGF")
  check "AC6 $at the run appends its record to ~/.desk-autopilot/test-runs.jsonl" \
    'printf "%s" "$out" | grep -qE "^\{\"date\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\",\"suites\":\[\"test_burn.sh\",\"test_one.sh\"\],\"jobs\":2,\"wall_s\":[0-9]+,\"cpu_s\":[0-9]+\.[0-9]{3},\"load\":([0-9]+(\.[0-9]+)?|null)," && node -e "JSON.parse(process.argv[1])" "$out"'
  rec=$(cd "$R/.." && pwd -P)
  check "DS-975 AC5 $at a run.sh with suites named and no wrapper records scope changed, why, its worktree and no lock" \
    'printf "%s" "$out" | grep -qF ",\"scope\":\"changed\",\"reason\":\"suites named on the command line\",\"worktree\":\"$rec\",\"lock\":null,\"wait_s\":null,\"left_for_ci\":null}"'
  cpu=$(printf '%s' "$out" | grep -oE '"cpu_s":[0-9.]+' | grep -oE '[0-9.]+$' | tr -d .)
  check "AC6 $at its CPU seconds are the suites' own" '[ -n "$cpu" ] && [ $((10#$cpu)) -ge $((10#$burn)) ]'
  DESK_RUN_SCOPE=full DESK_RUN_REASON='a "root" file' DESK_RUN_LEFT_FOR_CI=3 DESK_LOCK_CLASS=light DESK_LOCK_WAITED=40 "$B" "$R/run.sh" --no-hook-test -j 1 test_one.sh >/dev/null 2>&1
  out=$(tail -n 1 "$LOGF")
  check "DS-975 AC5 DS-986 AC6 $at the scope, reason and suites left for CI related.sh gives, and the lock and wait with-lock.sh gives, are recorded" \
    'printf "%s" "$out" | grep -qF ",\"scope\":\"full\",\"reason\":\"a \\\"root\\\" file\",\"worktree\":\"$rec\",\"lock\":\"light\",\"wait_s\":40,\"left_for_ci\":3}" && node -e "JSON.parse(process.argv[1])" "$out"'
  n=$(wc -l < "$LOGF")
  out=$(TEST_RUNS_LOG='' "$B" "$R/run.sh" --no-hook-test -j 1 test_one.sh 2>&1)
  check "AC6 $at a run with TEST_RUNS_LOG empty (a run.sh a suite starts) records nothing" '[ "$(wc -l < "$LOGF")" = "$n" ]'

  # A failed suite runs once more, under -j 1 and -j 2 alike; test_compare_pass.sh never does.
  for j in 1 2; do
    export RUNS="$T/runs$v-$j" FLAG="$T/flag$v-$j"; : > "$RUNS"; rm -f "$FLAG" "$FLAG.c"
    out=$("$B" "$R/run.sh" --no-hook-test -j $j test_flaky.sh test_pass.sh 2>&1); rc=$?
    check "DS-926 AC1 $at -j $j a suite failing then passing runs twice, the run passes and the summary names it" \
      '[ $rc -eq 0 ] && [ "$(grep -c flaky "$RUNS")" = 2 ] && printf "%s\n" "$out" | grep -qx "flaked: test_flaky.sh" && printf "%s\n" "$out" | grep -qx "all passed: 2 checks"'
    check "DS-926 AC1 $at -j $j and its block prints the first run's failure" \
      'printf "%s\n" "$out" | grep -A 10 "^== test_flaky.sh" | grep -qx "FAIL flaky first run" && printf "%s\n" "$out" | grep -A 10 "^== test_flaky.sh" | grep -qx "exit 1"'
    check "DS-926 AC5 $at -j $j a passing suite runs once" '[ "$(grep -c pass "$RUNS")" = 1 ]'
    : > "$RUNS"
    out=$("$B" "$R/run.sh" --no-hook-test -j $j test_broken.sh test_pass.sh 2>&1); rc=$?
    check "DS-926 AC2 $at -j $j a suite failing twice fails the run, named, with both runs' reports" \
      '[ $rc -ne 0 ] && [ "$(grep -c broken "$RUNS")" = 2 ] && printf "%s\n" "$out" | grep -qx "failed suites: test_broken.sh" && printf "%s\n" "$out" | grep -qx "FAIL broken run 1" && printf "%s\n" "$out" | grep -qx "FAIL broken run 2" && ! printf "%s\n" "$out" | grep -q "^flaked:"'
    : > "$RUNS"
    out=$("$B" "$R/run.sh" --no-hook-test -j $j test_compare_pass.sh 2>&1); rc=$?
    check "DS-926 AC3 $at -j $j a failed test_compare_pass.sh is not retried and fails the run" \
      '[ $rc -ne 0 ] && [ "$(grep -c compare "$RUNS")" = 1 ] && printf "%s\n" "$out" | grep -qx "failed suites: test_compare_pass.sh"'
  done

  # CPU budgets: test_over.sh's budget is 0, test_one.sh's the default 150.
  over_line='::warning::test_over\.sh used [0-9]+\.[0-9]{3} CPU seconds, over its budget of 0'
  out=$(DESK_SUITE_BUDGETS=warn "$B" "$R/run.sh" --no-hook-test -j 2 test_over.sh test_one.sh 2>&1); rc=$?
  check "DS-927 AC5 $at warn: a suite over its budget prints a warning naming it, its CPU seconds and its budget, and the run passes" \
    '[ $rc -eq 0 ] && printf "%s\n" "$out" | grep -qxE "$over_line" && printf "%s\n" "$out" | grep -qxE "over budget: test_over\.sh=[0-9]+\.[0-9]{3}/0" && [ "$(printf "%s\n" "$out" | grep -c "^::")" = 1 ]'
  out=$(DESK_SUITE_BUDGETS=enforce DESK_SUITE_BUDGETS_TODAY=2026-12-07 "$B" "$R/run.sh" --no-hook-test -j 1 test_over.sh test_one.sh 2>&1); rc=$?
  check "DS-927 AC5 $at enforce, in the first two weeks: a warning that names the date it fails from, and the run passes" \
    '[ $rc -eq 0 ] && printf "%s\n" "$out" | grep -qxE "$over_line \(a failure from 2026-12-08\)" && printf "%s\n" "$out" | grep -qx "all passed: 2 checks"'
  out=$(DESK_SUITE_BUDGETS=enforce DESK_SUITE_BUDGETS_TODAY=2026-12-08 "$B" "$R/run.sh" --no-hook-test -j 1 test_over.sh test_one.sh 2>&1); rc=$?
  check "DS-927 AC6 $at enforce, from the date: the run fails naming the suite" \
    '[ $rc -ne 0 ] && printf "%s\n" "$out" | grep -qxE "::error::test_over\.sh used [0-9]+\.[0-9]{3} CPU seconds, over its budget of 0" && printf "%s\n" "$out" | grep -qx "failed suites: test_over.sh"'
  out=$("$B" "$R/run.sh" --no-hook-test -j 1 test_over.sh 2>&1); rc=$?
  check "DS-927 AC5 $at without DESK_SUITE_BUDGETS (a local run) no budget is checked" '[ $rc -eq 0 ] && ! printf "%s\n" "$out" | grep -qE "^::|over budget"'
  out=$(DESK_SUITE_BUDGETS=fail "$B" "$R/run.sh" --no-hook-test test_one.sh 2>&1); rc=$?
  check "DS-927 AC5 $at a budget mode that is neither warn nor enforce is refused" '[ $rc -eq 2 ]'
  # A `(main M)` budget: M off a pull request, N on one.
  for e in push ''; do
    out=$(GITHUB_EVENT_NAME="$e" DESK_SUITE_BUDGETS=enforce DESK_SUITE_BUDGETS_TODAY=2026-12-08 "$B" "$R/run.sh" --no-hook-test -j 1 test_split.sh 2>&1); rc=$?
    check "DS-942 AC1 $at enforce from the date, event '$e': a suite within its main budget passes and is not listed over budget" \
      '[ $rc -eq 0 ] && ! printf "%s\n" "$out" | grep -qE "^::|over budget"'
  done
  out=$(GITHUB_EVENT_NAME=pull_request DESK_SUITE_BUDGETS=enforce DESK_SUITE_BUDGETS_TODAY=2026-12-08 "$B" "$R/run.sh" --no-hook-test -j 1 test_split.sh 2>&1); rc=$?
  check "DS-942 AC2 $at enforce from the date, on a pull request: the same suite is held to its pull-request budget and fails" \
    '[ $rc -ne 0 ] && printf "%s\n" "$out" | grep -qxE "::error::test_split\.sh used [0-9]+\.[0-9]{3} CPU seconds, over its budget of 0" && printf "%s\n" "$out" | grep -qx "failed suites: test_split.sh"'
  dur="$T/dur$v.json"; rm -f "$dur"
  out=$(DESK_SUITE_DURATIONS="$dur" "$B" "$R/run.sh" --no-hook-test -j 2 test_over.sh test_one.sh 2>&1); rc=$?
  check "DS-927 AC1 $at DESK_SUITE_DURATIONS gets each suite's seconds and CPU seconds, by file, as JSON" \
    '[ $rc -eq 0 ] && node -e "const d = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); const k = (o) => Object.keys(o).sort().join(); process.exit(k(d.seconds) === \"test_one.sh,test_over.sh\" && k(d.cpu) === k(d.seconds) && d.cpu[\"test_over.sh\"] > 0 ? 0 : 1)" "$dur"'
  token_checks
}

checks "$BASH"
# The flaked suite in a CI shard's result file: tests.yml's own step scripts, run as CI runs them: the shard's "Run tests" step in the scratch
# repo writes its result file, and the tests job's "Every shard passed" step reads it back.
W="$S/../.github/workflows/tests.yml"
# The `run: |` body of the step named $1 in tests.yml, unindented.
step_body(){ node -e '
const [f, name] = process.argv.slice(1); const L = require("fs").readFileSync(f, "utf8").split("\n");
const at = (l) => l.search(/\S/); const i = L.findIndex((l) => l.trim() === `- name: ${name}`);
if (i < 0) process.exit(2);
let j = i + 1; while (j < L.length && !/^\s+run: \|$/.test(L[j])) { if (L[j].trim().startsWith("- ") && at(L[j]) <= at(L[i])) process.exit(2); j++; }
const body = []; for (let k = j + 1; k < L.length && (L[k].trim() === "" || at(L[k]) > at(L[j])); k++) body.push(L[k]);
const d = Math.min(...body.filter((l) => l.trim()).map(at)); console.log(body.map((l) => l.slice(d)).join("\n"));' "$W" "$1"; }
shard_body=$(step_body "Run tests"); tests_body=$(step_body "Every shard passed")
# Runs the shard step on suites $1 into $RT, then the tests job's step on its result file.
ci_run(){ RT="$T/ci$2"; mkdir -p "$RT/job"; ln -s "$RT/result" "$RT/job/results"
  export RUNS="$T/ciruns$2" FLAG="$T/ciflag$2"; : > "$RUNS"; rm -f "$FLAG"
  ( cd "$T/repo" && RUNNER_TEMP=$RT SHARD=1 OF=1 SUITES=$1 HOOK=false DESK_SUITE_BUDGETS=${3:-} bash -e -c "$shard_body" ) >/dev/null 2>&1; src=$?
  res=$(cat "$RT/result/shard-1.txt" 2>/dev/null)
  out=$(cd "$RT/job" && PLAN=success BASH32=success TYPES=success SHARDS=success MATRIX='{"include":[{"shard":1}]}' bash -e -c "$tests_body" 2>&1); trc=$?; }
ci_run "test_flaky.sh test_pass.sh" 1
check "DS-926 AC4 a shard whose suite flaked writes it into its result file, and the tests job passes and names it" \
  '[ $src -eq 0 ] && printf "%s\n" "$res" | grep -qx "flaked=test_flaky.sh" && printf "%s\n" "$res" | grep -qx "rc=0" && [ $trc -eq 0 ] && printf "%s\n" "$out" | grep -qx "shard 1/1 passed" && printf "%s\n" "$out" | grep -qx "shard 1/1 flaked (failed, then passed its retry): test_flaky.sh"'
ci_run "test_pass.sh" 2
check "DS-926 AC4 a shard with no flake writes an empty flaked line, and the tests job names none" \
  '[ $src -eq 0 ] && printf "%s\n" "$res" | grep -qx "flaked=" && [ $trc -eq 0 ] && printf "%s\n" "$out" | grep -qx "shard 1/1 passed" && ! printf "%s\n" "$out" | grep -q flaked'
check "DS-927 AC1 the shard step leaves its suites' durations beside its result file" \
  'node -e "const d = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); process.exit(Object.keys(d.seconds).join() === \"test_pass.sh\" && \"test_pass.sh\" in d.cpu ? 0 : 1)" "$RT/result/durations-1.json"'
ci_run "test_over.sh test_pass.sh" 3 warn
check "DS-927 AC8 a shard on main with a suite over budget passes, writes it as slow=, and the tests job passes and names it" \
  '[ $src -eq 0 ] && printf "%s\n" "$res" | grep -qxE "slow=test_over\.sh=[0-9]+\.[0-9]{3}/0" && [ $trc -eq 0 ] && printf "%s\n" "$out" | grep -qE "^shard 1/1 over CPU budget \(<suite>=<CPU seconds>/<budget>\): test_over\.sh="'
# AC7: the same under bash 3.2.
case "$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null)" in
  3) [ "$(/bin/bash -c 'echo "$BASH_VERSION"')" = "$BASH_VERSION" ] || checks /bin/bash ;;
  *) echo "SKIP AC7: no bash 3.2 at /bin/bash" ;;
esac

echo "run jobs: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
