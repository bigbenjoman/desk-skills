#!/usr/bin/env bash
# suite: queue requeue of a running ticket whose worker exited on a park
# queue.mjs requeue takes a ticket still recorded running once its worker is gone (no live pid, its
# session not in the agent registry) and its log, after the last spawn, ends on a park: it records
# that park as the pass would and requeues it. A live worker, no park, no way to tell, or a pass
# running now is refused as before.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home"; mkdir -p "$HOME" "$T/state/logs" "$T/fakes"
unset CLAUDE_CONFIG_DIR
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
cat > "$T/config.md" <<'EOF'
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | `acme/widgets` |
| Default branch | `main` |
EOF
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo" DESK_AUTOPILOT_STATE="$T/state"
git init -q "$T/repo"
# The fake registry: the sessions in $T/agents.json, or a failed read while $T/claude.fail exists.
cat > "$T/fakes/claude" <<EOF
#!/bin/sh
[ -f "$T/claude.fail" ] && { echo "registry down" >&2; exit 1; }
cat "$T/agents.json"
EOF
chmod +x "$T/fakes/claude"
export PATH="$T/fakes:$PATH"
echo '[{"sessionId":"s-live","pid":1}]' > "$T/agents.json"

q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
# f <KEY> <path>: the JSON of that ticket's field at that dotted path.
f(){ node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; for (const p of process.argv[3].split(".")) v = v?.[p]; console.log(JSON.stringify(v));' "$DESK_QUEUE" "$1" "$2"; }
sum(){ cksum < "$DESK_QUEUE"; }
# Log lines as spawn-worker.sh and a worker's stream-json session write them.
spawn(){ printf '{"type":"desk_spawn","session":"%s","stage":"0","model":"default","effort":"none","at":"2026-11-11T10:00:00.000Z"}\n' "$1"; }
says(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv[1] }] } }))' "$1"; }
DECISION='AUTOPILOT_DECISION: {"question": "Which helper?", "options": ["a", "b"], "chose": "a", "category": "engineering"}'
running(){ q add "$1"; q set "$1" state=triaged lane=A; q set "$1" state=running stage=4/9 "$2"; }

q init t

# AC1: its session is gone and its log ends on a park.
running R-1 session_id=s-dead
{ spawn s-dead; says "AUTOPILOT_STAGE: 7/9 pr"; says "$DECISION"; says "AUTOPILOT_NOTE: helper x lives in y"; says "AUTOPILOT_PARK: need the review posted"; } > "$T/state/logs/R-1.log"
q requeue R-1
check "AC1: a dead worker whose log ends on a park is requeued"            '[ $rc -eq 0 ] && [ "$(f R-1 state)" = "\"triaged\"" ] && [[ "$out" == *"R-1 requeued"*"exited on a park"* ]]'
check "AC1: its park is kept as prev_park"                                 '[ "$(f R-1 prev_park.question)" = "\"need the review posted\"" ] && [ "$(f R-1 prev_park.round)" = 1 ] && [ "$(f R-1 park)" = null ]'
check "AC1: the round it parked at is kept for the next spawn"            '[ "$(f R-1 last_round.stage)" = "\"7/9\"" ] && [ "$(f R-1 session_id)" = null ]'
check "AC1: the decision it printed reaches the decision log"             'grep -q "\"question\":\"Which helper?\"" "$T/state/decisions.jsonl"'
check "AC1: its log is moved aside"                                        '[ ! -f "$T/state/logs/R-1.log" ]'
check "AC1: the note it printed reaches the batch notes once"              '[ "$(grep -c "^- \[R-1\] helper x lives in y$" "$T/state/batch-notes.md")" = 1 ]'

# AC2: its session is live in the registry.
running R-2 session_id=s-live
{ spawn s-live; says "AUTOPILOT_PARK: a question"; } > "$T/state/logs/R-2.log"
before=$(sum); q requeue R-2
check "AC2: a live session is refused as today"                            '[ $rc -ne 0 ] && [[ "$out" == *"R-2 is running: stop its worker first"* ]] && [ "$(sum)" = "$before" ]'

# AC2: a recorded pid that is alive (this shell).
running R-3 session_id=s-gone3; q set R-3 pid=$$
{ spawn s-gone3; says "AUTOPILOT_PARK: a question"; } > "$T/state/logs/R-3.log"
before=$(sum); q requeue R-3
check "AC2: a live recorded pid is refused as today"                       '[ $rc -ne 0 ] && [[ "$out" == *"R-3 is running"* ]] && [ "$(sum)" = "$before" ]'

# AC3: the park is from the session before the last spawn, which has said nothing ending since.
running R-4 session_id=s-gone4
{ spawn s-gone4; says "AUTOPILOT_PARK: answered already"; spawn s-gone4; says "AUTOPILOT_STAGE: 5/9 evidence"; } > "$T/state/logs/R-4.log"
before=$(sum); q requeue R-4
check "AC3: no park after the last spawn is refused as today"              '[ $rc -ne 0 ] && [[ "$out" == *"R-4 is running"* ]] && [ "$(sum)" = "$before" ]'
{ spawn s-gone4; says "AUTOPILOT_PARK: a question"; says "AUTOPILOT_DONE: pr=12 jira=Review"; } > "$T/state/logs/R-4.log"
q requeue R-4
check "AC3: a park followed by DONE is refused as today"                   '[ $rc -ne 0 ] && [[ "$out" == *"R-4 is running"* ]] && [ "$(sum)" = "$before" ]'

# AC3: a log with no spawn line is never read as ending on a park.
{ says "AUTOPILOT_PARK: from some round"; } > "$T/state/logs/R-4.log"
q requeue R-4
check "AC3: a log with no spawn line is refused as today"                  '[ $rc -ne 0 ] && [[ "$out" == *"R-4 is running"* ]] && [ "$(sum)" = "$before" ]'
# A round that asked for an issue link is left to the pass, which makes it.
{ spawn s-gone4; says "AUTOPILOT_LINK: R-4 relates R-9"; says "AUTOPILOT_PARK: a question"; } > "$T/state/logs/R-4.log"
q requeue R-4
check "a park whose round asked for a link is left to the pass"           '[ $rc -ne 0 ] && [[ "$out" == *"R-4 is running"* ]] && [ "$(sum)" = "$before" ]'

# AC4: no pid and no session.
running R-5 session_id=null
{ spawn x; says "AUTOPILOT_PARK: a question"; } > "$T/state/logs/R-5.log"
before=$(sum); q requeue R-5
check "AC4: a ticket with no pid or session is refused as today"           '[ $rc -ne 0 ] && [[ "$out" == *"R-5 is running"* ]] && [ "$(sum)" = "$before" ]'

# A registry that cannot be read never reads as the worker being gone.
running R-6 session_id=s-gone6
{ spawn s-gone6; says "AUTOPILOT_PARK: a question"; } > "$T/state/logs/R-6.log"
touch "$T/claude.fail"; before=$(sum); q requeue R-6
check "an unreadable registry is refused as today"                         '[ $rc -ne 0 ] && [[ "$out" == *"R-6 is running"* ]] && [ "$(sum)" = "$before" ]'
rm -f "$T/claude.fail"

# A pass running now harvests the ticket itself.
sleep 60 & pass=$!
printf '{"pid":%s,"since":"now"}\n' "$pass" > "$T/state/orchestrator.lock"
q requeue R-6
check "a pass holding its lock is left to harvest it"                      '[ $rc -ne 0 ] && [[ "$out" == *"R-6 is running"* ]] && [ "$(sum)" = "$before" ]'
kill "$pass"; wait "$pass" 2>/dev/null
printf '{"pid":' > "$T/state/orchestrator.lock"
q requeue R-6
check "a pass lock caught mid-write is taken as a pass running"           '[ $rc -ne 0 ] && [[ "$out" == *"R-6 is running"* ]] && [ "$(sum)" = "$before" ]'
rm -f "$T/state/orchestrator.lock"
q requeue R-6
check "once the pass is gone the same ticket requeues"                     '[ $rc -eq 0 ] && [ "$(f R-6 prev_park.question)" = "\"a question\"" ]'

rm -rf "$T"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
