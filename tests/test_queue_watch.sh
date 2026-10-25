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

# A triaged ticket with a question open reads in the watch as it does in render.
q add T-2; q set T-2 state=triaged open_questions=1
watch_bg --interval 0.3
until_tables 1
stop_watch
out=$(cat "$T/watch.out")
check "DS-189 AC2 the watch row says the question is open and how to answer it" '[[ "$out" == *"TRIAGED  T-2       blocked: 1 question(s) open, answer with answer.mjs T-2 \"<answer>\""* ]]'

# DS-198: config §3b "Orchestrator status table". setting <value>: rewrite the config with that row.
setting(){ cp "$T/config.base" "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Orchestrator status table | `full` | `%s` |\n' "$1" >> "$T/config.md"; }
cp "$T/config.md" "$T/config.base"

# AC1 is the suites above: no row prints the whole table on every change. full set explicitly does too.
setting full
watch_bg --interval 0.3
until_tables 1
q set T-1 stage=6/9
until_tables 2
stop_watch
out=$(cat "$T/watch.out")
check "DS-198 AC1 full prints the whole table again on a change"             '[ "$(tables)" = 2 ] && [ "$(grep -c "RUNNING  T-1" "$T/watch.out")" = 2 ] && [[ "$out" != *"quiet"* ]]'

# AC2: quiet prints the table once, then one line per changed ticket and the memory line.
setting quiet
watch_bg --interval 0.3
until_tables 1
q set T-1 stage=7/9; q add T-3
n=0; while [ "$(mems)" -lt 2 ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done
sleep 0.7
stop_watch
out=$(cat "$T/watch.out")
check "DS-198 AC2 quiet prints the full table once at start"                 '[ "$(tables)" = 1 ] && [[ "$out" == *"status table quiet"* ]]'
check "DS-198 AC2 a stage step is one line: key, old stage → new stage"       '[[ "$out" == *"T-1       RUNNING stage 6/9  port 3501 → RUNNING stage 7/9  port 3501"* ]]'
check "DS-198 AC2 a spawn-side change (a ticket added) is its own line"       '[[ "$out" == *"T-3       added → QUEUED"* ]]'
check "DS-198 AC2 change lines carry the memory line; unchanged rows are not reprinted"'[ "$(mems)" -ge 2 ] && [ "$(grep -c "TRIAGED  T-2" "$T/watch.out")" = 1 ]'

# AC8: an unrecognised value is said once and read as full.
setting loud
watch_bg --interval 0.3
until_tables 1
q set T-1 stage=8/9
until_tables 2
stop_watch
out=$(cat "$T/watch.out")
check "DS-198 AC8 an unknown value is said once and the watch runs at full"  '[ "$(grep -c "is \"loud\"" "$T/watch.out")" = 1 ] && [[ "$out" == *"want \`full\` or \`quiet\`; read as full"* ]] && [ "$(tables)" = 2 ]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
