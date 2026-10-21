#!/usr/bin/env bash
# suite: queue watch (the orchestrator's change-only status monitor)
# queue.mjs watch prints the table and memory line once, again only when the table changes, never
# for an interval where only memory moved, and exits non-zero naming the queue when there is none.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
W=
trap '[ -n "$W" ] && kill "$W" 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
cat > "$T/config.md" <<'EOF'
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | `acme/widgets` |
| Default branch | `main` |
EOF
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo"
git init -q "$T/repo"; mkdir -p "$T/repo/.claude"
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
tables(){ grep -c '^batch ' "$T/watch.out"; }
mems(){ grep -c '^vmmem=.* avail=' "$T/watch.out"; }
# until_tables <n>: wait up to 10s for the watch to have printed n tables, so a slow start-up is
# waited out rather than read as a missing table.
until_tables(){ n=0; while [ "$(tables)" -lt "$1" ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done; }
# watch_bg [args]: start a watch in the background, writing to watch.out.
watch_bg(){ : > "$T/watch.out"; node "$B/queue.mjs" watch "$@" > "$T/watch.out" 2>&1 & W=$!; }
stop_watch(){ kill "$W" 2>/dev/null; wait "$W" 2>/dev/null; W=; }

# AC5 runs in the background and is bounded, so a watch that loops instead of exiting fails here.
watch_bg --interval 1
n=0; while kill -0 "$W" 2>/dev/null && [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done
if kill -0 "$W" 2>/dev/null; then stop_watch; rc=124; else wait "$W"; rc=$?; W=; fi
out=$(cat "$T/watch.out")
check "AC5 no queue: exits non-zero naming the missing queue"            '[ $rc -ne 0 ] && [ $rc -ne 124 ] && [[ "$out" == *"no queue at $T/queue.json"* ]]'

q init t; q add T-1; q set T-1 state=running stage=2/9 port=3501
watch_bg --interval 0.3
until_tables 1
out=$(cat "$T/watch.out")
check "AC1 the table and the memory line print once at start"           '[ "$(tables)" = 1 ] && [ "$(mems)" = 1 ] && [[ "$out" == *"RUNNING  T-1       stage 2/9"* ]]'
sleep 1
out=$(cat "$T/watch.out")
check "AC3 intervals with no change print nothing"                       '[ "$(tables)" = 1 ] && [ "$(mems)" = 1 ]'
q set T-1 stage=4/9
until_tables 2
out=$(cat "$T/watch.out")
check "AC2 a stage change prints the new table within an interval"      '[ "$(tables)" = 2 ] && [ "$(mems)" = 2 ] && [[ "$out" == *"stage 4/9"* ]]'
q set T-1 stage=4/9
sleep 1
out=$(cat "$T/watch.out")
check "a write that changes nothing shown prints nothing"               '[ "$(tables)" = 2 ]'
stop_watch

# AC4: the default interval is 90 seconds, so a change made after the first table is not printed yet.
watch_bg
until_tables 1
q set T-1 stage=5/9; sleep 1.5
out=$(cat "$T/watch.out")
check "AC4 with no flag it does not check again within a few seconds"    '[ "$(tables)" = 1 ] && [[ "$out" == *"stage 4/9"* ]] && [[ "$out" != *"stage 5/9"* ]]'
stop_watch

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
