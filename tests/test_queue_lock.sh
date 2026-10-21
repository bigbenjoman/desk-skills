#!/usr/bin/env bash
# suite: queue lock (every write locked; reads never wait)
# queue.mjs holds a lock from its read to its save on every command that changes the queue, so writes
# started together all land. A lock left by an exited process is cleared; one a live process holds past
# the wait is refused naming its pid, with the queue unchanged. list reads without waiting. Scratch
# DESK_HOME and queue only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home"; mkdir -p "$HOME"
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH DESK_QUEUE_LOCK_WAIT_MS
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
cat > "$T/config.md" <<'EOF'
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | `acme/widgets` |
| Default branch | `main` |
EOF
export DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_QUEUE="$T/desk/queue.json" DESK_REPO_DIR="$T/repo"
git init -q "$T/repo"
LOCK="$DESK_QUEUE.lock"
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
lane(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]].lane)' "$DESK_QUEUE" "$1"; }
sum(){ cksum < "$DESK_QUEUE"; }

q init t
for i in 1 2 3 4 5 6 7 8; do q add "T-$i"; done

# AC1: writes to different tickets started together. Without the lock each saves its own copy and
# all but one change is lost.
for i in 1 2 3 4 5 6 7 8; do node "$B/queue.mjs" set "T-$i" "lane=L$i" >/dev/null 2>&1 & done
wait
out=""; for i in 1 2 3 4 5 6 7 8; do out="$out $(lane "T-$i")"; done
check "AC1 every one of eight concurrent sets lands"                '[ "$out" = " L1 L2 L3 L4 L5 L6 L7 L8" ]'
check "a finished write leaves no lock behind"                      '[ ! -e "$LOCK" ]'

# AC2: a lock left by a process that has exited.
sh -c 'exit 0' & dead=$!; wait "$dead"
mkdir "$LOCK"; echo "$dead" > "$LOCK/pid"
q set T-1 lane=stale
check "AC2 a dead holder's lock is cleared and the change made"     '[ $rc -eq 0 ] && [ "$(lane T-1)" = stale ] && [ ! -e "$LOCK" ]'

# AC3 and AC4: a lock a live process holds. The default wait is 10 seconds.
sleep 60 & holder=$!
mkdir "$LOCK"; echo "$holder" > "$LOCK/pid"
before=$(sum); start=$(date +%s)
q set T-2 lane=late
took=$(( $(date +%s) - start ))
check "AC3 a live holder past the wait is refused, naming its pid"  '[ $rc -ne 0 ] && [[ "$out" == *"locked by pid $holder"* ]] && [[ "$out" == *"10s wait"* ]] && [ "$took" -ge 10 ]'
check "AC3 the queue file is unchanged"                             '[ "$(sum)" = "$before" ] && [ "$(lane T-2)" = L2 ]'
check "the refused write leaves the holder's lock in place"         '[ "$(cat "$LOCK/pid")" = "$holder" ]'
start=$(date +%s); q list; took=$(( $(date +%s) - start ))
check "AC4 list prints the queue without waiting"                   '[ $rc -eq 0 ] && [ "$took" -le 2 ] && [[ "$out" == *"\"T-8\""* ]]'
q render
check "render does not wait either"                                 '[ $rc -eq 0 ] && [[ "$out" == *T-8* ]]'

# A holder that lets go inside the wait: the write waits for it, then lands.
( sleep 1; rm -rf "$LOCK" ) &
q set T-3 lane=waited
check "a write waits for a holder that lets go, then lands"         '[ $rc -eq 0 ] && [ "$(lane T-3)" = waited ]'
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

# A lock with no pid yet is a taker between its mkdir and its write: waited on, not cleared.
mkdir "$LOCK"; before=$(sum)
out=$(DESK_QUEUE_LOCK_WAIT_MS=300 node "$B/queue.mjs" set T-4 lane=x 2>&1); rc=$?
check "a lock with no pid yet is not taken over inside the wait"    '[ $rc -ne 0 ] && [ "$(sum)" = "$before" ] && [ -d "$LOCK" ]'
rm -rf "$LOCK"

rm -rf "$T"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
