#!/usr/bin/env bash
# suite: worker Stop hook (no ending a turn with a background task running)
# hooks/desk-worker-stop.py fed a fake Stop event and a fixture transcript whose background Bash task
# is a real `sleep` holding the task's output file open: one block naming the task (AC1), nothing
# with no task running (AC2) or outside a worker (AC3), and a second Stop that ends the turn and
# writes the broken rule to the worker log (AC4). Plus the transcript fallback when nothing can say
# who holds the file, and worker-settings registering the hook. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; T="$(mktemp -d)"
PIDS=""
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME" "$T/tasks"
export DESK_HOME="$T/desk" DESK_WORKER_LOG="$T/worker.log"
unset DESK_AUTOPILOT_WORKER
HOOK="$SRC/hooks/desk-worker-stop.py"
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# task <id> -> starts a fake background task: a sleep with its stdout on $T/tasks/<id>.output
task(){ sleep 60 > "$T/tasks/$1.output" & PIDS="$PIDS $!"; eval "PID_$1=$!"; }
# transcript <file> <id>... -> a Bash run_in_background call and its result for each id
transcript(){
  local f="$1" id; shift; : > "$f"
  for id in "$@"; do
    printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_%s","name":"Bash","input":{"command":"bash tests/run.sh","description":"Run the suite %s","run_in_background":true}}]}}\n' "$id" "$id"
    printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_%s","content":"Command running in background with ID: %s. Output is being written to: %s. You will be notified when it completes."}]},"toolUseResult":{"backgroundTaskId":"%s"}}\n' "$id" "$id" "$T/tasks/$id.output" "$id"
  done >> "$f"
}
notified(){ printf '{"type":"user","message":{"role":"user","content":"<task-notification>\\n<task-id>%s</task-id>\\n<status>completed</status>\\n</task-notification>"}}\n' "$2" >> "$1"; }
# stop <session> <transcript> [worker] -> $out, $rc
stop(){ out=$(printf '{"hook_event_name":"Stop","session_id":"%s","transcript_path":"%s","cwd":"%s","stop_hook_active":false}' \
  "$1" "$2" "$T" | env ${3:+DESK_AUTOPILOT_WORKER=1} python3 "$HOOK" 2>&1); rc=$?; }
blocked(){ [ "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["decision"])' 2>/dev/null)" = block ]; }
reason(){ printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reason"])' 2>/dev/null; }

task b1
transcript "$T/t1.jsonl" b1
stop s1 "$T/t1.jsonl" worker
check "AC1: running task blocks the end of turn"           '[ $rc -eq 0 ] && blocked'
check "AC1: the reason names the task and its description" '[[ "$(reason)" == *"b1 (Run the suite b1)"* ]]'
check "AC1: no broken-rule line on the first block"        '[ ! -s "$DESK_WORKER_LOG" ]'
stop s1 "$T/t1.jsonl" worker
check "AC4: a second Stop with it running ends the turn"   '[ $rc -eq 0 ] && [ -z "$out" ]'
check "AC4: the worker log records the broken rule"        'grep -q "^\[stop-hook\] .*rule broken.*b1 (Run the suite b1)" "$DESK_WORKER_LOG"'
task b2
transcript "$T/t2.jsonl" b1 b2
stop s1 "$T/t2.jsonl" worker
check "a newly started task blocks once more, naming only it" 'blocked && [[ "$(reason)" == *b2* ]] && [[ "$(reason)" != *b1* ]]'

stop s2 "$T/t1.jsonl"
check "AC3: not a worker, task running: nothing blocked"   '[ $rc -eq 0 ] && [ -z "$out" ]'
check "AC3: not a worker: no state written"                '[ ! -e "$DESK_HOME/worker-stop/s2.json" ]'

kill "$PID_b1" "$PID_b2" 2>/dev/null; wait "$PID_b1" "$PID_b2" 2>/dev/null
stop s3 "$T/t2.jsonl" worker
check "AC2: tasks finished (file no longer held): turn ends" '[ $rc -eq 0 ] && [ -z "$out" ]'
: > "$T/t0.jsonl"
stop s3 "$T/t0.jsonl" worker
check "AC2: no background task at all: turn ends"          '[ $rc -eq 0 ] && [ -z "$out" ]'
stop s3 "$T/missing.jsonl" worker
check "AC2: unreadable transcript: turn ends, no error"    '[ $rc -eq 0 ] && [ -z "$out" ]'

# With no lsof and no /proc, the transcript decides: running until its completion notification.
python3 - "$HOOK" "$T/t1.jsonl" > "$T/fallback" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("h", sys.argv[1]); h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
h.held_open = lambda path: None
print(len(h.running(sys.argv[2])))
with open(sys.argv[2], "a") as f:
    f.write('{"type":"user","message":{"content":"<task-notification>\\n<task-id>b1</task-id>\\n<status>completed</status>"}}\n')
print(len(h.running(sys.argv[2])))
PY
out=$(tr '\n' ' ' < "$T/fallback")
check "fallback: running until notified, then finished"    '[ "$out" = "1 0 " ]'

# worker-settings registers the hook on Stop when the script is installed.
mkdir -p "$HOME/.claude/hooks"; : > "$HOME/.claude/hooks/desk-worker-stop.py"
git init -q -b main "$T/repo" 2>/dev/null; git -C "$T/repo" -c user.email=t@e -c user.name=t commit -q --allow-empty -m init
cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Unit tests | \`bash tests/run.sh\` |
EOF
out=$(cd "$T/repo" && env -u DESK_REPO_OVERRIDE -u DESK_SLUG -u DESK_REPO_DIR -u DESK_DEFAULT_BRANCH -u DESK_SKILLS_DIR \
  DESK_HOME="$SRC/desk" DESK_CONFIG="$T/config.md" DESK_AUTOPILOT_STATE="$T/state" DESK_STATE="$T/state" DESK_QUEUE="$T/queue.json" \
  node "$SRC/desk/bin/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" --branch fix/fix-thing --out "$T/ws.json" 2>&1); rc=$?
check "worker-settings: Stop runs the installed hook"      '[ $rc -eq 0 ] && [ "$(jq -r ".hooks.Stop[0].hooks[0].command" "$T/ws.json")" = "python3 \"$HOME/.claude/hooks/desk-worker-stop.py\"" ]'

echo "worker stop hook: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
