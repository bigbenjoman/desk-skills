#!/usr/bin/env bash
# suite: queue.mjs stop ends one running worker, commits its work and holds its ticket
# layer: L3
# A running ticket's worker processes (found by the session id on their command line) are ended, what
# its worktree holds is committed on its branch, and the ticket is held behind no blocker, which only
# the person's start releases. A ticket with no running worker exits 11, a key the queue does not hold
# exits 2, and both change nothing.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME" "$T/state/logs"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
cat > "$T/config.md" <<'EOF'
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | `acme/widgets` |
| Default branch | `main` |
EOF
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo" DESK_AUTOPILOT_STATE="$T/state" DESK_STOP_GRACE_MS=400
git init -q -b main "$T/repo"
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
f(){ node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; for (const p of process.argv[3].split(".")) v = v?.[p]; console.log(JSON.stringify(v));' "$DESK_QUEUE" "$1" "$2"; }
sum(){ cksum < "$DESK_QUEUE"; }
says(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv[1] }] } }))' "$1"; }
spawnline(){ printf '{"type":"desk_spawn","session":"%s","stage":"0","model":"default","effort":"none","at":"2026-11-11T10:00:00.000Z"}\n' "$1"; }
# running <KEY>: a ticket recorded running in its own worktree on fix/<KEY>, session s-<KEY>.
running(){
  git -C "$T/repo" worktree add -q -b "fix/$1" "$T/wt/$1"
  q add "$1"; q set "$1" state=triaged lane=A; q set "$1" state=running stage=4/9 "session_id=s-$1" "branch=fix/$1" "worktree=$T/wt/$1"
  { spawnline "s-$1"; says "AUTOPILOT_STAGE: 6/9 hygiene"; } > "$T/state/logs/$1.log"
}
# worker <KEY> [<shell prefix>]: its worker as spawn-worker.sh starts it, a session leader (setsid) whose
# command line names the session, with a child; WPID is the leader, WCHILD its child.
worker(){
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' bash -c "${2:-}"'sleep 300 & echo $! > "$0.child"; wait' "$T/$1" claude -p x --session-id "s-$1" &
  WPID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/$1.child" ] && break; sleep 0.2; done
  WCHILD=$(cat "$T/$1.child")
}
gone(){ ! kill -0 "$1" 2>/dev/null || ps -o stat= -p "$1" | grep -q '^Z'; }
heads(){ git -C "$T/wt/$1" rev-list --count HEAD; }

q init t

# AC1, AC8: a running worker with uncommitted changes, a new file among them.
running S-1; worker S-1
echo "new" > "$T/wt/S-1/widget.txt"
q stop S-1; wait "$WPID" 2>/dev/null
sha=$(git -C "$T/wt/S-1" rev-parse HEAD)
check "AC1: its worker's processes end, its child too"                   '[ $rc -eq 0 ] && gone "$WPID" && gone "$WCHILD"'
check "AC1: the changes are committed on its branch"                      '[ "$(git -C "$T/wt/S-1" rev-parse --abbrev-ref HEAD)" = fix/S-1 ] && [ -z "$(git -C "$T/wt/S-1" status --porcelain)" ] && git -C "$T/wt/S-1" show --stat HEAD | grep -q widget.txt'
check "AC1: the ticket is held, behind no blocker, not failed"            '[ "$(f S-1 state)" = "\"parked\"" ] && [[ "$(f S-1 park.question)" == "\"held by orchestrator: stopped by queue.mjs stop"* ]] && [ "$(f S-1 held_by)" = null ]'
check "DS-895 AC2: the hold records its park kind, stopped"                '[ "$(f S-1 park.kind)" = "\"stopped\"" ]'
check "AC1: its session is cleared and its stage kept for the next worker" '[ "$(f S-1 session_id)" = null ] && [ "$(f S-1 last_round.stage)" = "\"6/9\"" ]'
check "AC8: the output names the ticket, the commit and the hold"         '[[ "$out" == *"S-1 stopped"* ]] && [[ "$out" == *"committed as ${sha:0:12} on fix/S-1"* ]] && [[ "$out" == *"S-1 is held"* ]]'

# AC4: a clean worktree makes no commit; desk's own .claude files are not work.
running S-2; worker S-2
mkdir -p "$T/wt/S-2/.claude"; echo '{}' > "$T/wt/S-2/.claude/settings.local.json.desk-disabled"
before=$(heads S-2); q stop S-2; wait "$WPID" 2>/dev/null
check "AC4: a clean worktree gets no commit, and the ticket is held"      '[ $rc -eq 0 ] && [ "$(heads S-2)" = "$before" ] && [ "$(f S-2 state)" = "\"parked\"" ] && [[ "$out" == *"nothing to commit"* ]] && [[ "$out" == *"S-2 is held"* ]]'

# A worker that ignores SIGTERM is killed.
running S-3; worker S-3 'trap "" TERM; '
q stop S-3; wait "$WPID" 2>/dev/null
check "a worker that ignores SIGTERM is ended with SIGKILL"              '[ $rc -eq 0 ] && gone "$WPID" && gone "$WCHILD" && [ "$(f S-3 state)" = "\"parked\"" ]'

# A worker that is no session leader (no setsid) is ended with its children, and the shell that
# started it is not.
running S-4
bash -c 'sleep 300 & echo $! > "$0.child"; wait' "$T/S-4" claude -p x --session-id s-S-4 &
WPID=$!; for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/S-4.child" ] && break; sleep 0.2; done; WCHILD=$(cat "$T/S-4.child")
q stop S-4; wait "$WPID" 2>/dev/null
check "a worker sharing its spawner's group is ended alone, children too" '[ $rc -eq 0 ] && gone "$WPID" && gone "$WCHILD" && kill -0 $$'

# AC5: a ticket that is ready but not running.
q add S-5; q set S-5 state=triaged lane=A
before=$(sum); q stop S-5
check "AC5: no running worker exits 11 and changes nothing"               '[ $rc -eq 11 ] && [[ "$out" == *"S-5 has no running worker"* ]] && [ "$(sum)" = "$before" ]'
# Recorded running, but no process runs its session.
running S-6
before=$(sum); q stop S-6
check "AC5: recorded running with no process for its session exits 11"   '[ $rc -eq 11 ] && [[ "$out" == *"S-6 has no running worker"* ]] && [ "$(sum)" = "$before" ]'

# AC6: a key the queue does not hold.
before=$(sum); q stop NOPE-1
check "AC6: an unknown key exits 2, names it and changes nothing"         '[ $rc -eq 2 ] && [[ "$out" == *"NOPE-1"* ]] && [ "$(sum)" = "$before" ]'

# AC7: a pass holds its lock for a moment. The releaser notes whether the worker was still alive as it
# let go, so the check fails if stop ended the worker without waiting.
running S-7; worker S-7
sleep 30 & pass=$!
printf '{"pid":%s,"since":"now"}\n' "$pass" > "$T/state/orchestrator.lock"
( sleep 1; if kill -0 "$WPID" 2>/dev/null; then echo alive; else echo ended; fi > "$T/S-7.at-release"; rm -f "$T/state/orchestrator.lock"; kill "$pass" ) &
releaser=$!
q stop S-7; wait "$WPID" 2>/dev/null; wait "$releaser" 2>/dev/null
check "AC7: it waits for the pass's lock, then stops the worker, exit 0" '[ $rc -eq 0 ] && [ "$(cat "$T/S-7.at-release")" = alive ] && gone "$WPID" && [ "$(f S-7 state)" = "\"parked\"" ]'
# Another writer holds the queue lock as stop comes to write the hold: the write waits for it.
running S-11; worker S-11 'trap "" TERM; '
sleep 30 & holder=$!
mkdir "$DESK_QUEUE.lock"; echo "$holder" > "$DESK_QUEUE.lock/pid"
( sleep 2; date +%s > "$T/S-11.released"; rm -rf "${DESK_QUEUE:?}.lock"; kill "$holder" ) &
releaser=$!
q stop S-11; done_at=$(date +%s); wait "$WPID" 2>/dev/null; wait "$releaser" 2>/dev/null
check "the hold is written once the queue lock frees, not over it"        '[ $rc -eq 0 ] && [ -s "$T/S-11.released" ] && [ "$done_at" -ge "$(cat "$T/S-11.released")" ] && [ "$(f S-11 state)" = "\"parked\"" ]'

# While it stops a worker it holds the pass's lock, so no pass starts and resumes the ticket over the
# hold; it lets go once done.
running S-12; worker S-12 'trap "" TERM; '
node "$B/queue.mjs" stop S-12 > "$T/S-12.out" 2>&1 & stopper=$!
held=no; for _ in $(seq 1 30); do grep -q 'queue.mjs stop S-12' "$T/state/orchestrator.lock" 2>/dev/null && { held=yes; break; }; sleep 0.05; done
wait "$stopper"; rc=$?; out=$(cat "$T/S-12.out"); wait "$WPID" 2>/dev/null
check "it holds the pass lock while it stops, and frees it after"         '[ $rc -eq 0 ] && [ $held = yes ] && [ ! -e "$T/state/orchestrator.lock" ]'

# A worker's descendant that left its group (a detached child, setsid) is ended too.
running S-10
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' bash -c 'perl -MPOSIX -e "POSIX::setsid(); exec @ARGV" sleep 300 & echo $! > "$0.child"; wait' "$T/S-10" claude -p x --session-id s-S-10 &
WPID=$!; for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/S-10.child" ] && break; sleep 0.2; done; WCHILD=$(cat "$T/S-10.child")
q stop S-10; wait "$WPID" 2>/dev/null
check "a descendant in its own process group is ended with the worker"   '[ $rc -eq 0 ] && gone "$WPID" && gone "$WCHILD" && [ "$(ps -o pgid= -p "$WCHILD" 2>/dev/null | tr -d " ")" != "$WPID" ]'

# A pass running now is waited for, and one that does not finish refuses with nothing changed.
running S-8; worker S-8
sleep 30 & pass=$!
printf '{"pid":%s,"since":"now"}\n' "$pass" > "$T/state/orchestrator.lock"
before=$(sum); out=$(DESK_STOP_PASS_WAIT_MS=600 node "$B/queue.mjs" stop S-8 2>&1); rc=$?
check "a pass that does not finish in the wait: exit 11, nothing changed" '[ $rc -eq 11 ] && [[ "$out" == *"a pass is running"* ]] && [ "$(sum)" = "$before" ] && kill -0 "$WPID" && grep -q "\"pid\":$pass" "$T/state/orchestrator.lock"'
kill "$pass"; wait "$pass" 2>/dev/null; rm -f "$T/state/orchestrator.lock"
q stop S-8; wait "$WPID" 2>/dev/null
check "once the pass is gone, the same stop goes ahead"                   '[ $rc -eq 0 ] && [ "$(f S-8 state)" = "\"parked\"" ]'

# A worker that already printed DONE is the pass's to record.
running S-9; worker S-9
says "AUTOPILOT_DONE: pr=4 jira=Review" >> "$T/state/logs/S-9.log"
before=$(sum); q stop S-9
check "a worker that printed AUTOPILOT_DONE is left to the pass"          '[ $rc -eq 11 ] && [[ "$out" == *"AUTOPILOT_DONE"* ]] && [ "$(sum)" = "$before" ] && kill -0 "$WPID"'
kill -9 -- "-$WPID" 2>/dev/null; wait "$WPID" 2>/dev/null

# The pass lock is taken exclusively, by a pass and a stop alike: six takers racing over a dead holder's
# lock leave exactly one holding it, and a pass refuses while a stop holds it.
sleep 0.1 & dead=$!; wait "$dead"
printf '{"pid":%s,"since":"then"}\n' "$dead" > "$T/state/orchestrator.lock"
for i in 1 2 3 4 5 6; do
  node --input-type=module -e "import { tryLockFile, sleepSync } from '$B/dir-lock.mjs'; const got = tryLockFile(process.argv[1]); console.log(got === true ? 'took' : 'held'); if (got === true) sleepSync(1500);" "$T/state/orchestrator.lock" > "$T/taker.$i" &
done
wait
took=$(cat "$T"/taker.* | grep -c took)
check "of six racing takers of a stale pass lock exactly one holds it"   '[ "$took" = 1 ] && [ ! -e "$T/state/orchestrator.lock" ]'
# The stop's grace outlasts any pass's start (a slow runner loads pass.mjs's imports for over a second),
# and the worker is ended only once the pass has refused, so the stop holds the lock throughout.
running S-13; worker S-13 'trap "" TERM; '
DESK_STOP_GRACE_MS=120000 node "$B/queue.mjs" stop S-13 > /dev/null 2>&1 & stopper=$!
for _ in $(seq 1 30); do grep -q 'queue.mjs stop S-13' "$T/state/orchestrator.lock" 2>/dev/null && break; sleep 0.05; done
out=$(DESK_REPO_ROOT="$T/repo" node "$B/pass.mjs" 2>&1); prc=$?
kill -9 -- "-$WPID" 2>/dev/null
wait "$stopper"; wait "$WPID" 2>/dev/null
check "a pass started while a stop holds the lock refuses, naming it"    '[ $prc -ne 0 ] && [[ "$out" == *"queue.mjs stop S-13"* ]] && [ "$(f S-13 state)" = "\"parked\"" ]'

rm -rf "${T:?}"
echo "queue stop: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
