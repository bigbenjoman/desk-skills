#!/usr/bin/env bash
# suite: decider (a headless session settles what a pass needs the person for)
# supervisor.mjs with a fake pass that exits 11 with set reports, a fake claude that records its
# arguments and prompt and answers as told, and the real digest's question list as the intake: a lane
# A park is requeued and noted, a lane C or D park and an ungranted §3 row go to the digest, an item
# handed on and unanswered starts no session, one session at a time, a session past its time is
# stopped and its items handed on, and the report gives the session's cost. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin" "$T/fakes" "$T/repo" "$T/state/briefings" "$T/skills/desk-autopilot/references"
export HOME="$T/home"
unset DESK_CONFIG DESK_REPO_DIR DESK_REPO_ROOT DESK_SLUG DESK_STATE DESK_DEFAULT_BRANCH DESK_GH_REPO \
  AUTOPILOT_DRY_RUN AUTOPILOT_BASE_PUSH_APPROVED AUTOPILOT_USER_APPROVED
export DESK_CONFIG_ROOT="$T/cfg" DESK_REPO_OVERRIDE=acme/widgets DESK_HOME="$T/desk" \
  DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" DESK_SKILLS_DIR="$T/skills"
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

mkdir -p "$T/cfg/repos/acme__widgets"
cat > "$T/cfg/repos/acme__widgets/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`autopilot-merge\` | The merge driver merges | \`ask\` | \`no\` |
EOF
echo "RECOVERY RULES: a lane C or D park is never requeued" > "$T/skills/desk-autopilot/references/orchestrator-recovery.md"

cp "$B/supervisor.mjs" "$T/bin/"
for f in desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs decider.mjs handoff.mjs briefing.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
cat > "$T/bin/pass.mjs" <<EOF
import { readFileSync } from 'node:fs';
const v = JSON.parse(readFileSync('$T/verdict.json', 'utf8'));
console.log(JSON.stringify(v));
process.exitCode = v.code;
EOF
echo "console.log(JSON.stringify({ status: 'not_due', push: null }));" > "$T/bin/digest.mjs"
echo "console.log(JSON.stringify({ hold: false, lines: [] }));" > "$T/bin/maintenance.mjs"
# The fake claude: its arguments one per line in claude.args.<n>, then whatever $T/claude.mode says:
# requeue <KEY> (un-park it and say so), hand (hand every item on), hang, or none (no result line).
cat > "$T/fakes/claude" <<EOF
#!/bin/bash
n=\$(ls "$T" | grep -c '^claude\.args\.')
printf '%s\n' "\$@" > "$T/claude.args.\$n"
read -r mode key < "$T/claude.mode"
ids=\$(grep -oE 'id \`[a-z]+-[0-9a-f]+\`' <<< "\$2" | grep -oE '[a-z]+-[0-9a-f]+')
case "\$mode" in
  hang) exec sleep 60 ;;
  requeue)
    node -e 'const f=process.argv[1]; const q=JSON.parse(require("fs").readFileSync(f,"utf8")); Object.assign(q.tickets[process.argv[2]], {state:"triaged", park:null}); require("fs").writeFileSync(f, JSON.stringify(q))' "$T/queue.json" "\$key"
    node -e 'const [key, ids] = process.argv.slice(1); console.log(JSON.stringify({type:"result", total_cost_usd:0.1234, result:"Done.\nDECIDER_RESULT: "+JSON.stringify({settled: ids.split(/\s+/).filter(Boolean).map((id) => ({id, did:"requeued "+key+" for more agent work"})), handed:[]})}))' "\$key" "\$ids" ;;
  hand)
    node -e 'console.log(JSON.stringify({type:"result", total_cost_usd:0.05, result:"DECIDER_RESULT: "+JSON.stringify({settled:[], handed: process.argv[1].split(/\s+/).filter(Boolean).map((id) => ({id, why:"a product call"}))})}))' "\$ids" ;;
  *) echo '{"type":"result","total_cost_usd":0.01,"result":"I could not decide."}' ;;
esac
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/fakes/osascript"
printf '#!/bin/sh\necho OPEN\n' > "$T/fakes/gh"
chmod +x "$T/fakes/claude" "$T/fakes/osascript" "$T/fakes/gh"
export PATH="$T/fakes:$PATH"

tick(){ (cd "$T/repo" && node "$T/bin/supervisor.mjs" tick --foreground 2>&1); }
LOG="$T/state/supervisor.log"
calls(){ ls "$T" | grep -c '^claude\.args\.'; }
# The decider runs detached: wait (at most 10s) for it to end.
settle(){ i=0; while node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); try { process.kill(s.decider.pid, 0) } catch { process.exit(1) }' "$T/state/supervisor.json" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done; }
queue(){ printf '{"version":1,"batch":"b1","supervised":true,"approved":{},"tickets":%s}\n' "$1" > "$DESK_QUEUE"; }
verdict(){ printf '%s\n' "$1" > "$T/verdict.json"; }
parked(){ printf '{"status":"show_person","code":11,"message":"PARKED:\\n  %s: %s","waiting":[],"parked":[{"key":"%s","question":"%s"}],"notify":true,"push":[]}' "$1" "$2" "$1" "$2"; }
handed(){ node -e 'console.log(Object.values(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).map((h) => `${h.ticket}|${h.why}`).join("\n"))' "$T/state/handed.json" 2>/dev/null; }
questions(){ node --input-type=module -e "import { openQuestions } from '$B/digest.mjs'; for (const q of openQuestions({ slug: 'acme__widgets', state: '$T/state', queue: '$DESK_QUEUE' })) console.log(q.ticket + '|' + q.kind + '|' + q.text);"; }

# ---- AC1 and AC7: a lane A park asking for more agent work is requeued ----------------------------
Q='"A":{"key":"A","state":"parked","lane":"A","park":{"question":"needs another round: the tests fail"}}'
queue "{$Q}"; verdict "$(parked A "needs another round: the tests fail")"; echo "requeue A" > "$T/claude.mode"
out=$(tick); settle
check "AC1: one headless session starts" '[ "$(calls)" = 1 ] && grep -q "decider: started (pid [0-9]*) for A" "$LOG"'
check "AC7: it runs at low effort" 'grep -qx -- "--effort" "$T/claude.args.0" && grep -A1 -x -- "--effort" "$T/claude.args.0" | grep -qx low'
check "AC7: no inherited settings, dontAsk, its own allow list" 'grep -A1 -x -- "--setting-sources" "$T/claude.args.0" | tail -1 | grep -qx "" && grep -A1 -x -- "--permission-mode" "$T/claude.args.0" | grep -qx dontAsk && grep -q "queue.mjs requeue" "$(grep -A1 -x -- "--settings" "$T/claude.args.0" | tail -1)"'
check "AC7: no earlier conversation (no resume, no continue)" '! grep -qE -- "^--(resume|continue|session-id)$|^-[rc]$" "$T/claude.args.0"'
check "AC7: the prompt holds the pass report" 'grep -q "PARKED:" "$T/claude.args.0" && grep -q "A: needs another round: the tests fail" "$T/claude.args.0"'
check "AC7: the prompt holds the recovery rules" 'grep -q "RECOVERY RULES: a lane C or D park is never requeued" "$T/claude.args.0"'
verdict '{"status":"nothing_yet","code":10,"message":"no change this pass","waiting":[],"parked":[],"notify":false,"push":[]}'
out=$(tick)
check "AC1: the ticket is requeued" 'node -e "process.exit(JSON.parse(require(\"fs\").readFileSync(\"$DESK_QUEUE\",\"utf8\")).tickets.A.state === \"triaged\" ? 0 : 1)"'
check "AC1: what it did is in the batch notes" 'grep -q "^- \[decider\] .* A: requeued A for more agent work$" "$T/state/batch-notes.md"'
check "AC8: the report gives the cost and what it settled" 'grep -q "decider .*: \$0.12; settled A (requeued A for more agent work); handed to the digest nothing" "$LOG"'
check "AC1: nothing handed on" '[ -z "$(handed)" ]'

# ---- AC2: a lane C park goes to the digest with its question, no session, no requeue ---------------
rm -f "$T"/claude.args.*
queue '{"C":{"key":"C","state":"parked","lane":"C","park":{"question":"which of two designs?"}}}'
verdict "$(parked C "which of two designs?")"
out=$(tick)
check "AC2: no session for a lane C park" '[ "$(calls)" = 0 ]'
check "AC2: it is handed to the digest" 'handed | grep -q "^C|lane C park"'
check "AC2: the digest lists it with the park question" 'questions | grep -q "^C|parked|which of two designs? (handed on: lane C park"'
check "AC2: it is not requeued" 'grep -q "\"state\":\"parked\"" "$DESK_QUEUE"'

# ---- AC3: an item needing a §3 row that is ask goes to the digest ---------------------------------
W='D: screenshots for PR #4 are in /x — config §3 pr-images is \"ask\". Upload them by hand'
verdict "{\"status\":\"show_person\",\"code\":11,\"message\":\"x\",\"waiting\":[\"$W\"],\"parked\":[],\"notify\":true,\"push\":[]}"
out=$(tick)
check "AC3: no session for an item needing an ask row" '[ "$(calls)" = 0 ]'
check "AC3: it is handed to the digest naming the row" 'handed | grep -q "^D|needs config §3 pr-images, which is \"ask\"$"'
check "AC3: the digest lists it" 'questions | grep -q "^D|handed on|D: screenshots for PR #4"'

# ---- AC4: handed on and unanswered starts no new session; an answer does -------------------------
queue '{"E":{"key":"E","state":"parked","lane":"A","park":{"question":"the spec needs a fixture"}}}'
verdict "$(parked E "the spec needs a fixture")"; echo "hand" > "$T/claude.mode"
out=$(tick); settle; out=$(tick)
check "AC4: the session handed E on" '[ "$(calls)" = 1 ] && handed | grep -q "^E|a product call$"'
check "AC8: the report says what it handed on" 'grep -q "decider .*: \$0.05; settled nothing; handed to the digest E (a product call)" "$LOG"'
check "AC4: E listed again starts no new session" '[ "$(calls)" = 1 ]'
sleep 1
printf '\n## Answer from the user (%s)\n\nuse the recorded payload\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$T/state/briefings/E.md"
out=$(tick)
check "AC4: once answered, a new session starts for it" '[ "$(calls)" = 2 ]'
settle; out=$(tick)

# ---- AC5: one session at a time per repo ------------------------------------------------------------
rm -f "$T"/claude.args.* "$T/state/handed.json"
queue '{"F":{"key":"F","state":"parked","lane":"A","park":{"question":"f?"}},"G":{"key":"G","state":"parked","lane":"B","park":{"question":"g?"}}}'
verdict "$(parked F "f?")"; echo "hang" > "$T/claude.mode"
out=$(tick)
verdict "$(parked G "g?")"
out=$(tick)
check "AC5: no second session while one runs" '[ "$(calls)" = 1 ] && grep -q "decider: one is still running (pid [0-9]*, since .*), so none starts for G" "$LOG"'

# ---- AC6: a session past 15 minutes is stopped, its items handed on --------------------------------
PID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).decider.pid)' "$T/state/supervisor.json")
node -e 'const f=process.argv[1]; const s=JSON.parse(require("fs").readFileSync(f,"utf8")); s.decider.started=new Date(Date.now()-16*60000).toISOString(); require("fs").writeFileSync(f, JSON.stringify(s))' "$T/state/supervisor.json"
verdict "$(parked F "f?")"
out=$(tick)
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
check "AC6: the session is stopped" '! kill -0 "$PID" 2>/dev/null'
check "AC6: its items are handed on as timed out" 'handed | grep -qx "F|decider timed out"'
check "AC6: the digest lists them with the reason" 'questions | grep -q "^F|parked|f? (handed on: decider timed out)"'
check "AC8: the report names the time-out" 'grep -q "decider .*: \$0.00; settled nothing; handed to the digest F (decider timed out)" "$LOG"'
check "AC6: F handed on starts no new session" '[ "$(calls)" = 1 ]'

# ---- a session with no result line hands its items on -----------------------------------------------
rm -f "$T"/claude.args.*
queue '{"H":{"key":"H","state":"parked","lane":"A","park":{"question":"h?"}}}'
verdict "$(parked H "h?")"; echo "none" > "$T/claude.mode"
out=$(tick); settle; out=$(tick)
check "a session with no result line hands its items on" 'handed | grep -q "^H|decider no DECIDER_RESULT: line$"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
