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
for f in desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs decider.mjs handoff.mjs briefing.mjs intake.mjs closeout.mjs installed.mjs run-by.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
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
# Sessions started since the last mark, from the supervisor's own log line: written before the tick
# returns, where the detached fake's args file may not exist yet.
base=0
started(){ grep -c "^decider: started" "$LOG" 2>/dev/null || true; }
calls(){ echo $(( $(started) - base )); }
mark(){ base=$(started); }
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
check "AC1: what it did is in the batch notes" 'grep -q "^- \[decider\] .* A: requeued A for more agent work$" "$T/state/batch-notes.md"'
check "AC8: the report gives the cost and what it settled" 'grep -q "decider .*: \$0.12; settled A (requeued A for more agent work); handed to the digest nothing" "$LOG"'
check "AC1: nothing handed on" '[ -z "$(handed)" ]'

# ---- AC2: a lane C park goes to the digest with its question, no session, no requeue ---------------
mark
queue '{"C":{"key":"C","state":"parked","lane":"C","park":{"question":"which of two designs?"}}}'
verdict "$(parked C "which of two designs?")"
out=$(tick)
check "AC2: no session for a lane C park" '[ "$(calls)" = 0 ]'
check "AC2: it is handed to the digest" 'handed | grep -q "^C|lane C park"'
check "AC2: the digest lists it with the park question" 'questions | grep -q "^C|parked|which of two designs? (handed on: lane C park"'
check "AC2: it is not requeued" 'grep -q "\"state\":\"parked\"" "$DESK_QUEUE"'

# ---- AC3: an item needing a §3 row that is ask goes to the digest ---------------------------------
queue '{"D":{"key":"D","state":"done","lane":"A","result":{"pr":4}}}'
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
AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '\n## Answer from the user (2020-01-01T00:00:00Z)\n\nan answer from before it was handed on\n\n## Answer from the user (%s)\n\nuse the recorded payload\nfrom the staging log\n' "$AT" > "$T/state/briefings/E.md"
out=$(tick)
check "AC4: once answered, a new session starts for it" '[ "$(calls)" = 2 ]'
settle; out=$(tick)
# The answer reaches the session, with its time, under its item.
P=$(grep -l "use the recorded payload" "$T"/claude.args.* | head -1)
check "DS-264 AC1: the prompt carries the answer since the hand-over, with its time, under its item" '[ -n "$P" ] && grep -A1 "· E · parked · lane A: the spec needs a fixture$" "$P" | grep -qx "  - answered $AT: use the recorded payload" && grep -qx "    from the staging log" "$P"'
check "DS-264 AC1: an answer from before the hand-over is left out" '! grep -q "an answer from before it was handed on" "$P"'
check "DS-264 AC2/AC3: the prompt says to act on the answer, not hand the question back" 'grep -q "act on the answer, and never hand the same question back" "$P" && grep -q "pr-merge-green" "$P"'
check "DS-264 AC4: an unanswered item gets no answer lines and no answer rule" '! grep -q "answered \|act on the answer" "$T/claude.args.0" && ! grep -q "act on the answer" "$T/claude.args.1"'

# ---- AC5: one session at a time per repo ------------------------------------------------------------
mark; rm -f "$T/state/handed.json"
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
check "AC8: the report names the time-out, its cost unknown rather than zero" 'grep -q "decider .*: cost unknown; settled nothing; handed to the digest F (decider timed out)" "$LOG"'
check "AC6: F handed on starts no new session" '[ "$(calls)" = 1 ]'

# ---- DS-269 AC5: an answer given while its session runs reaches the next one ------------------------
mark; rm -f "$T/state/handed.json"
queue '{"H":{"key":"H","state":"parked","lane":"A","park":{"question":"h?","since":"2020-01-01T00:00:00Z"}}}'
verdict "$(parked H "h?")"; echo "hang" > "$T/claude.mode"
out=$(tick)
PID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).decider.pid)' "$T/state/supervisor.json")
sleep 1
printf '\n## Answer from the user (%s)\n\nuse the blue one\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$T/state/briefings/H.md"
kill "$PID"; i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
echo "hand" > "$T/claude.mode"
out=$(tick); settle
P=$(grep -l "use the blue one" "$T"/claude.args.* 2>/dev/null | head -1)
check "DS-269 AC5 the session reaped after the answer hands H on from its start, so the next one gets the answer" '[ "$(calls)" = 2 ] && [ -n "$P" ] && grep -A1 "· H · parked · lane A: h?$" "$P" | grep -q "answered .*: use the blue one"'

# ---- a batch-level line has no ticket to answer, and goes once no pass lists it ---------------------
mark; queue '{}'; echo "hand" > "$T/claude.mode"
verdict '{"status":"show_person","code":11,"message":"x","waiting":["BASE GATE: failed on main. Fix it on main"],"parked":[],"notify":true,"push":[]}'
out=$(tick); settle; out=$(tick)
check "a batch-level line is handed on as the batch's" 'questions | grep -q "^BASE GATE|batch|BASE GATE: failed on main. Fix it on main (a product call)"'
page=$(node --input-type=module -e "import { renderPage } from '$B/digest.mjs'; console.log(renderPage({ slot: '2026-10-23T08:00', since: null, groups: [{ slug: 's', questions: [{ ticket: 'BASE GATE', kind: 'batch', text: 'x' }], decisions: [] }] }));")
check "the digest offers no answer command for it" 'grep -q "no answer to record" <<< "$page" && ! grep -q "answer s BASE GATE" <<< "$page"'
verdict '{"status":"nothing_yet","code":10,"message":"no change this pass","waiting":[],"parked":[],"notify":false,"push":[]}'
out=$(tick)
check "a quiet pass drops what no pass lists any more" '[ -z "$(handed)" ]'

# ---- an answer in an idle batch ends idle, so a session acts on it -----------------------------------
mark; echo "hand" > "$T/claude.mode"
queue '{"K":{"key":"K","state":"parked","lane":"A","park":{"question":"k?"}}}'
verdict '{"status":"idle","code":11,"message":"IDLE","waiting":[],"parked":[{"key":"K","question":"k?"}],"notify":true,"push":[]}'
out=$(tick); settle; out=$(tick)
passes=$(grep -c "^== .* pass: exit" "$LOG")
out=$(tick)
check "an idle batch with K handed on and unanswered runs no pass" '[ "$(grep -c "^== .* pass: exit" "$LOG")" = "$passes" ] && [ "$(calls)" = 1 ] && handed | grep -q "^K|a product call$"'
sleep 1
printf '\n## Answer from the user (%s)\n\nuse the fixture\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$T/state/briefings/K.md"
out=$(tick)
check "once K is answered, a pass runs and a session starts for it" '[ "$(grep -c "^== .* pass: exit" "$LOG")" = $((passes + 1)) ] && [ "$(calls)" = 2 ]'
settle

# ---- a waiting line the last session settled, listed again, goes to the digest ----------------------
mark; echo "requeue X" > "$T/claude.mode"
queue '{"X":{"key":"X","state":"failed","lane":"A"}}'
verdict '{"status":"show_person","code":11,"message":"x","waiting":["X: FAILED — requeue it"],"parked":[],"notify":true,"push":[]}'
out=$(tick); settle; out=$(tick)
check "a line the last session settled and the next pass lists again is handed on, no new session" '[ "$(calls)" = 1 ] && handed | grep -q "^X|the decider settled it, but the next pass still lists it$"'

# ---- a session with no result line hands its items on -----------------------------------------------
mark
queue '{"H":{"key":"H","state":"parked","lane":"A","park":{"question":"h?"}}}'
verdict "$(parked H "h?")"; echo "none" > "$T/claude.mode"
out=$(tick); settle; out=$(tick)
check "a session with no result line hands its items on" 'handed | grep -q "^H|decider no DECIDER_RESULT: line$"'

# ---- §3 worker-web-read: a park asking only for a public fact is requeued where workers can read the web ----
lastargs(){ set -- "$T"/claude.args.*; echo "$T/claude.args.$(( $# - 1 ))"; }
FACT="what is the ONS 2024 UK household count?"
mark; echo "hand" > "$T/claude.mode"
queue '{"P":{"key":"P","state":"parked","lane":"A","park":{"question":"'"$FACT"'"}}}'
verdict "$(parked P "$FACT")"
out=$(tick); settle
check "web-read unset: the decider prompt has no public-fact rule" '[ "$(calls)" = 1 ] && ! grep -q "public fact" "$(lastargs)"'
printf '| `worker-web-read` | Read the web | `ask` | `yes` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
mark; echo "requeue Q" > "$T/claude.mode"
queue '{"Q":{"key":"Q","state":"parked","lane":"A","park":{"question":"'"$FACT"' (Q)"}}}'
verdict "$(parked Q "$FACT (Q)")"
out=$(tick); settle
verdict '{"status":"nothing_yet","code":10,"message":"no change this pass","waiting":[],"parked":[],"notify":false,"push":[]}'
out=$(tick)
check "web-read yes: the prompt says a public fact is no fact only the person holds, and to requeue it" '[ "$(calls)" = 1 ] && grep -q "a park asking only for a public fact .* is not a fact only the person holds" "$(lastargs)" && grep -q "requeue it for its worker to look the fact up" "$(lastargs)"'
check "web-read yes: the park is requeued, not handed on" 'grep -q "\"Q\":{[^}]*\"state\":\"triaged\"" "$DESK_QUEUE" && ! handed | grep -q "^Q|"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
