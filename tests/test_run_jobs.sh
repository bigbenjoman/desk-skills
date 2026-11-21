#!/usr/bin/env bash
# suite: run.sh runs up to test-cap suites at once, longest first, and records CPU seconds per suite and per run
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
    'printf "%s" "$out" | grep -qE "^\{\"date\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\",\"suites\":\[\"test_burn.sh\",\"test_one.sh\"\],\"jobs\":2,\"wall_s\":[0-9]+,\"cpu_s\":[0-9]+\.[0-9]{3},\"load\":([0-9]+(\.[0-9]+)?|null)\}$" && node -e "JSON.parse(process.argv[1])" "$out"'
  cpu=$(printf '%s' "$out" | grep -oE '"cpu_s":[0-9.]+' | grep -oE '[0-9.]+$' | tr -d .)
  check "AC6 $at its CPU seconds are the suites' own" '[ -n "$cpu" ] && [ $((10#$cpu)) -ge $((10#$burn)) ]'
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
  ( cd "$T/repo" && RUNNER_TEMP=$RT SHARD=1 OF=1 SUITES=$1 HOOK=false bash -e -c "$shard_body" ) >/dev/null 2>&1; src=$?
  res=$(cat "$RT/result/shard-1.txt" 2>/dev/null)
  out=$(cd "$RT/job" && PLAN=success BASH32=success SHARDS=success MATRIX='{"include":[{"shard":1}]}' bash -e -c "$tests_body" 2>&1); trc=$?; }
ci_run "test_flaky.sh test_pass.sh" 1
check "DS-926 AC4 a shard whose suite flaked writes it into its result file, and the tests job passes and names it" \
  '[ $src -eq 0 ] && printf "%s\n" "$res" | grep -qx "flaked=test_flaky.sh" && printf "%s\n" "$res" | grep -qx "rc=0" && [ $trc -eq 0 ] && printf "%s\n" "$out" | grep -qx "shard 1/1 passed" && printf "%s\n" "$out" | grep -qx "shard 1/1 flaked (failed, then passed its retry): test_flaky.sh"'
ci_run "test_pass.sh" 2
check "DS-926 AC4 a shard with no flake writes an empty flaked line, and the tests job names none" \
  '[ $src -eq 0 ] && printf "%s\n" "$res" | grep -qx "flaked=" && [ $trc -eq 0 ] && printf "%s\n" "$out" | grep -qx "shard 1/1 passed" && ! printf "%s\n" "$out" | grep -q flaked'
# AC7: the same under bash 3.2.
case "$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null)" in
  3) [ "$(/bin/bash -c 'echo "$BASH_VERSION"')" = "$BASH_VERSION" ] || checks /bin/bash ;;
  *) echo "SKIP AC7: no bash 3.2 at /bin/bash" ;;
esac

echo "run jobs: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
