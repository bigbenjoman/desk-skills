#!/usr/bin/env bash
# suite: decider (a headless session settles what a pass needs the person for)
# layer: L2
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

# shellcheck source=link_bin.sh
. "$S/link_bin.sh"
cp "$B/supervisor.mjs" "$T/bin/"
cat > "$T/bin/pass.mjs" <<EOF
import { readFileSync } from 'node:fs';
const v = JSON.parse(readFileSync('$T/verdict.json', 'utf8'));
console.log(JSON.stringify(v));
process.exitCode = v.code;
EOF
echo "console.log(JSON.stringify({ status: 'not_due', push: null }));" > "$T/bin/digest.mjs"
echo "console.log(JSON.stringify({ hold: false, lines: [] }));" > "$T/bin/maintenance.mjs"
link_bin "$B" "$T/bin"
# The fake claude: its arguments one per line in claude.args.<n>, then whatever $T/claude.mode says:
# requeue <KEY> (un-park it and say so), hand (hand every item on), hang, or none (no result line).
cat > "$T/fakes/claude" <<EOF
#!/bin/bash
n=\$(ls "$T" | grep -c '^claude\.args\.')
printf '%s\n' "\$@" > "$T/claude.args.\$n"
read -r mode key < "$T/claude.mode"
# webfact: requeue only when the prompt carries the public-fact rule, otherwise hand on
[ "\$mode" = webfact ] && { grep -q 'requeue it for its worker to look the fact up' <<< "\$2" && mode=requeue || mode=hand; }
# take: where the prompt carries the take rule, log and answer the call with the commands it names
# (the real decisions.mjs and answer.mjs), then requeue; otherwise hand on
if [ "\$mode" = take ]; then
  if grep -q 'take a call a worker could have taken itself' <<< "\$2" \\
    && DESK_HOME="$S/../desk" node "$B/answer.mjs" --taken "\$key" '{"question":"Merge as foundation, or split?","options":["Merge as foundation","Split"],"chose":"Merge as foundation","category":"scope"}' >> "$T/take.out" 2>&1 \\
    && node "$B/decisions.mjs" log --source decider "\$key" '{"question":"Merge as foundation, or split?","options":["Merge as foundation","Split"],"chose":"Merge as foundation","category":"scope"}' >> "$T/take.out" 2>&1; then mode=requeue; else mode=hand; fi
fi
ids=\$(grep -oE 'id \`[a-z]+-[0-9a-f]+\`' <<< "\$2" | grep -oE '[a-z]+-[0-9a-f]+')
case "\$mode" in
  hang) exec sleep 60 ;;
  requeue)
    node -e 'const f=process.argv[1]; const q=JSON.parse(require("fs").readFileSync(f,"utf8")); Object.assign(q.tickets[process.argv[2]], {state:"triaged", park:null}); require("fs").writeFileSync(f, JSON.stringify(q))' "$T/queue.json" "\$key"
    node -e 'const [key, ids] = process.argv.slice(1); console.log(JSON.stringify({type:"result", total_cost_usd:0.1234, result:"Done.\nDECIDER_RESULT: "+JSON.stringify({settled: ids.split(/\s+/).filter(Boolean).map((id) => ({id, did:"requeued "+key+" for more agent work"})), handed:[]})}))' "\$key" "\$ids" ;;
  hand)
    node -e 'console.log(JSON.stringify({type:"result", total_cost_usd:0.05, result:"DECIDER_RESULT: "+JSON.stringify({settled:[], handed: process.argv[1].split(/\s+/).filter(Boolean).map((id) => ({id, why:"a product call"}))})}))' "\$ids" ;;
  # restate <KEY>: record its clears-when as a form (the real queue.mjs), then hand every item on
  restate) node "$B/queue.mjs" clears-when "\$key" "pr 5 merged" >> "$T/restate.out" 2>&1
    node -e 'console.log(JSON.stringify({type:"result", total_cost_usd:0.05, result:"DECIDER_RESULT: "+JSON.stringify({settled:[], handed: process.argv[1].split(/\s+/).filter(Boolean).map((id) => ({id, why:"a product call"}))})}))' "\$ids" ;;
  limit) cat "$S/fixtures/decider-usage-limit.json" ;;
  *) echo '{"type":"result","total_cost_usd":0.01,"result":"I could not decide."}' ;;
esac
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/fakes/osascript"
printf '#!/bin/sh\necho OPEN\n' > "$T/fakes/gh"
# No real notifier: on Linux notify.mjs tries notify-send, then WSL's powershell.exe, and neither may reach the desktop.
printf '#!/bin/sh\nexit 1\n' | tee "$T/fakes/notify-send" > "$T/fakes/powershell.exe"
chmod +x "$T/fakes/claude" "$T/fakes/osascript" "$T/fakes/gh" "$T/fakes/notify-send" "$T/fakes/powershell.exe"
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

# ---- DS-872: a tick the config check holds back still stops a session past its time ----------------
mark; rm -f "$T/state/handed.json"
queue '{"J":{"key":"J","state":"parked","lane":"A","park":{"question":"j?"}}}'
verdict "$(parked J "j?")"; echo "hang" > "$T/claude.mode"
out=$(tick)
PID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).decider.pid)' "$T/state/supervisor.json")
CFG="$T/cfg/repos/acme__widgets/config.md"; cp "$CFG" "$T/config.good"
printf '\n## 4. Tools\n| Field | Value |\n|---|---|\n| Evidence workflow | `none` `pr-evidence.yml` |\n' >> "$CFG"
node -e 'const f=process.argv[1]; const s=JSON.parse(require("fs").readFileSync(f,"utf8")); s.decider.started=new Date(Date.now()-16*60000).toISOString(); require("fs").writeFileSync(f, JSON.stringify(s))' "$T/state/supervisor.json"
out=$(tick)
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
check "DS-872: the tick runs no pass, and still stops the session past its time and hands its items on" 'grep -q "config check: no pass run, no worker spawned" "$LOG" && ! kill -0 "$PID" 2>/dev/null && handed | grep -qx "J|decider timed out"'
cp "$T/config.good" "$CFG"

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

# ---- the decider at a usage limit hands nothing on, and none starts while the batch is held ----
out=$(node --input-type=module -e "
import { readResult, outcome } from '$B/decider.mjs';
const rec = { items: [{ id: 'park-1', ticket: 'L', kind: 'parked', text: 'l?' }] };
const r = readResult('$S/fixtures/decider-usage-limit.json');
const o = outcome(rec, r);
const plain = outcome(rec, { cost: 0.01, error: 'no DECIDER_RESULT: line' });
console.log([r.limit, o.handed.length, o.settled.length, o.kept.map((i) => i.ticket).join(), plain.handed[0]?.why, plain.kept].join('|'));
")
check "DS-387 AC2: the recorded limit result hands nothing on and keeps every item" '[ "${out%%|decider*}" = "true|0|0|L" ]'
check "DS-387 AC4: a result with no mark line and no error still hands its items on" '[ "$out" = "true|0|0|L|decider no DECIDER_RESULT: line|" ]'
mark; rm -f "$T/state/handed.json"; echo "limit" > "$T/claude.mode"
LQ='"L":{"key":"L","state":"parked","lane":"A","park":{"question":"l: the tests fail"}}'
queue "{$LQ}"; verdict "$(parked L "l: the tests fail")"
notes=$(grep -c "" "$T/state/batch-notes.md")
out=$(tick); settle; out=$(tick)
check "DS-387 AC2: a session at the limit hands nothing to the digest" '[ -z "$(handed)" ]'
check "DS-387 AC2: the report says it stopped at the limit and kept L" 'grep -q "decider .*: \$0.00; stopped at the usage limit, so it settled nothing and handed nothing on; L kept for the next decider" "$LOG"'
check "DS-387 AC2: nothing goes to the batch notes" '[ "$(grep -c "" "$T/state/batch-notes.md")" = "$notes" ]'
check "DS-387 AC2: L kept goes to the next decider" '[ "$(calls)" = 2 ]'
printf '{"version":1,"batch":"b1","supervised":true,"approved":{},"usage_hold":{"since":"2026-10-29T17:30:00Z","type":"seven_day","resets_at":1793545200,"preflight":"Z","paused":[]},"tickets":{%s}}\n' "$LQ" > "$DESK_QUEUE"
settle; out=$(tick)
check "DS-387 AC1: no decider starts while the batch is held on the usage limit" '[ "$(calls)" = 2 ]'
check "DS-387 AC1: the log names the usage hold" 'grep -q "^decider: not started, the batch is held on the weekly usage limit until 2026-11-01 15:00 UTC (usage_hold); L wait for the next decider once it lifts$" "$LOG"'
check "DS-387 AC1: nothing is handed on while held" '[ -z "$(handed)" ]'
echo "requeue L" > "$T/claude.mode"
queue "{$LQ}"
out=$(tick); settle
check "DS-387 AC3: once the hold clears, a decider starts for L" '[ "$(calls)" = 3 ] && grep -q "decider: started (pid [0-9]*) for L;" "$LOG"'
verdict '{"status":"nothing_yet","code":10,"message":"x","waiting":[],"parked":[],"notify":false,"push":[]}'; out=$(tick)
check "DS-387 AC3: and it settles L" 'grep -q "^- \[decider\] .* L: requeued L for more agent work$" "$T/state/batch-notes.md"'

# ---- §3 worker-web-read: a park asking only for a public fact is requeued where workers can read the web ----
lastargs(){ set -- "$T"/claude.args.*; echo "$T/claude.args.$(( $# - 1 ))"; }
FACT="what is the ONS 2024 UK household count?"
mark; echo "webfact P" > "$T/claude.mode"
queue '{"P":{"key":"P","state":"parked","lane":"A","park":{"question":"'"$FACT"'"}}}'
verdict "$(parked P "$FACT")"
out=$(tick); settle; out=$(tick)
check "web-read unset: the decider prompt has no public-fact rule" '[ "$(calls)" = 1 ] && ! grep -q "public fact" "$(lastargs)"'
check "web-read unset: the park is handed on, not requeued" 'handed | grep -q "^P|" && ! grep -q "\"P\":{[^}]*\"state\":\"triaged\"" "$DESK_QUEUE"'
printf '| `worker-web-read` | Read the web | `ask` | `yes` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
mark; echo "webfact Q" > "$T/claude.mode"
queue '{"Q":{"key":"Q","state":"parked","lane":"A","park":{"question":"'"$FACT"' (Q)"}}}'
verdict "$(parked Q "$FACT (Q)")"
out=$(tick); settle
verdict '{"status":"nothing_yet","code":10,"message":"no change this pass","waiting":[],"parked":[],"notify":false,"push":[]}'
out=$(tick)
check "web-read yes: the prompt says a public fact is no fact only the person holds, and to requeue it" '[ "$(calls)" = 1 ] && grep -q "a park asking only for a public fact .* is not a fact only the person holds" "$(lastargs)" && grep -q "requeue it for its worker to look the fact up" "$(lastargs)"'
check "web-read yes: the park is requeued, not handed on" 'grep -q "\"Q\":{[^}]*\"state\":\"triaged\"" "$DESK_QUEUE" && ! handed | grep -q "^Q|"'

# ---- DS-565: §3 autopilot-judgement yes, a park recommending an option on a take call is taken ----
REC="Merge as foundation (recommended), or split it out? A scope call."
lastsettings(){ grep -A1 -x -- "--settings" "$(lastargs)" | tail -1; }
# A ticket's state in the queue (a function, as bash brace-expands object literals in a check's eval).
stateof(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]?.state)' "$DESK_QUEUE" "$1"; }
mark; echo "take J1" > "$T/claude.mode"
queue '{"J1":{"key":"J1","state":"parked","lane":"A","park":{"question":"'"$REC"'"}}}'
verdict "$(parked J1 "$REC")"
out=$(tick); settle; out=$(tick)
check "DS-565 AC5: judgement unset, the prompt has no take rule and still never answers a product call" '[ "$(calls)" = 1 ] && ! grep -q "take a call a worker could have taken itself" "$(lastargs)" && grep -q "never answer a product, design or copy question, and" "$(lastargs)"'
check "DS-565 AC5: judgement unset, the decider may run neither answer.mjs nor decisions.mjs" '! grep -qE "answer.mjs|decisions.mjs" "$(lastsettings)"'
check "DS-565 AC5: judgement unset, the park is handed on" 'handed | grep -q "^J1|" && [ "$(stateof J1)" = parked ] && [ ! -s "$T/state/decisions.jsonl" ]'
printf '| `autopilot-judgement` | Take calls | `yes` | `yes` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
mark; echo "take J2" > "$T/claude.mode"
queue '{"J2":{"key":"J2","state":"parked","lane":"A","park":{"question":"'"$REC"' (J2)"}}}'
verdict "$(parked J2 "$REC (J2)")"
out=$(tick); settle
verdict '{"status":"nothing_yet","code":10,"message":"no change this pass","waiting":[],"parked":[],"notify":false,"push":[]}'
out=$(tick)
P=$(lastargs)
check "DS-565 AC1: judgement yes, the prompt says to take a recommended option, log it as the decider's and answer it" '[ "$(calls)" = 1 ] && grep -q "take a call a worker could have taken itself" "$P" && grep -q "decisions.mjs log --source decider <TICKET>" "$P" && grep -q "answer.mjs --taken <TICKET>" "$P" && grep -q "the decider took it, not the person" "$P"'
check "DS-565 AC1: judgement yes, the decider may run answer.mjs --taken and decisions.mjs log --source decider only" '[ "$(grep -oE "answer.mjs[^\"]*|decisions.mjs[^\"]*" "$(lastsettings)" | tr "\n" " ")" = "answer.mjs --taken:*) decisions.mjs log --source decider:*) " ]'
check "DS-565 AC3/AC4: the prompt hands on an ask category and a park with no recommended option" 'grep -q "that touches no money, legal or regulatory matter, production data or credentials, new customer-facing copy or customer copy where length means cost, or fact only the person holds" "$P" && grep -q "A park with no option marked recommended, one in an ask category" "$P"'
check "DS-565 AC1: the call is logged with source decider" 'grep -q "\"ticket\":\"J2\".*\"chose\":\"Merge as foundation\".*\"source\":\"decider\"" "$T/state/decisions.jsonl"'
check "DS-565 AC1: the option is the answer in its briefing" 'grep -q "^Merge as foundation. This was the option the last worker recommended when it parked on this scope call, .*the decider took it, not the person" "$T/state/briefings/J2.md"'
check "DS-565 AC1: the ticket is requeued and settled, not handed on" '[ "$(stateof J2)" = triaged ] && ! handed | grep -q "^J2|"'
takenof(){ node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]?.auto_answered; console.log(a ? [a.by, a.chose, a.question].join("|") : "none")' "$DESK_QUEUE" "$1"; }
check "DS-565: the take is recorded once, as the pass records its own" '[ "$(takenof J2)" = "decider|Merge as foundation|$REC (J2)" ]'
# The same park after that take, unanswered, is handed on without a session; answered since, it is not.
oncesort(){ node --input-type=module -e "
import { deciderItems, presort } from '$B/decider.mjs';
const q = (since) => ({ tickets: { J2: { lane: 'A', state: 'parked', park: { question: process.argv[1], since }, auto_answered: { question: process.argv[1], by: 'decider' } } } });
const items = (since) => deciderItems({ parked: [{ key: 'J2', question: process.argv[1] }] }, q(since));
const a = presort(items('2999-01-01T00:00:00Z'), '$T/state');
const b = presort(items('2000-01-01T00:00:00Z'), '$T/state');
console.log(a.hand.length, a.hand[0]?.why.startsWith('its recommended option was taken once already'), b.ask.length);
" "$REC (J2)"; }
check "DS-565: a park taken once already goes to the person unless answered since" '[ "$(oncesort)" = "1 true 1" ]'
queue '{"J3":{"key":"J3","state":"parked","lane":"A","branch":"b","park":{"question":"git push --force-with-lease was refused: approve the force-push?"}}}'
out=$(node "$B/answer.mjs" --taken J3 '{"question":"Force-push?","options":["Force-push","Merge instead"],"chose":"Force-push","category":"engineering"}' 2>&1); code=$?
check "DS-565: answer.mjs --taken refuses a park on a refused step, so no grant comes from the decider" '[ "$code" = 11 ] && grep -q "refused step" <<< "$out" && [ ! -e "$T/state/briefings/J3.md" ] && ! grep -q "\"grant\"" "$DESK_QUEUE"'
# An ask category is refused at the answer, before anything is written: not left to the log after it.
queue '{"J4":{"key":"J4","state":"parked","lane":"A","park":{"question":"Refund the customer (recommended), or not?"}}}'
out=$(node "$B/answer.mjs" --taken J4 '{"question":"Refund the customer?","options":["Refund","Do not refund"],"chose":"Refund","category":"money"}' 2>&1); code=$?
check "DS-565 AC3: answer.mjs --taken refuses an ask category before it writes the answer or marks the take" '[ "$code" = 11 ] && grep -q "ask category" <<< "$out" && [ ! -e "$T/state/briefings/J4.md" ] && [ "$(takenof J4)" = none ] && [ "$(stateof J4)" = parked ]'
# A park a session has claimed is the session's: the decider's take never requeues a worker beside it.
queue '{"J5":{"key":"J5","state":"parked","lane":"A","park":{"question":"Merge as foundation (recommended), or split?","claim":{"session":"s1","at":"2026-10-28T08:00:00Z"}}}}'
out=$(node "$B/answer.mjs" --taken J5 '{"question":"Merge as foundation, or split?","options":["Merge as foundation","Split"],"chose":"Merge as foundation","category":"scope"}' 2>&1); code=$?
check "DS-565: answer.mjs --taken refuses a park a session has claimed before it writes anything" '[ "$code" = 11 ] && grep -q "claimed by session s1" <<< "$out" && [ ! -e "$T/state/briefings/J5.md" ] && [ "$(takenof J5)" = none ] && [ "$(stateof J5)" = parked ]'
check "DS-565: the decider prompt hands on a claimed park" 'grep -q "one a session has claimed" "$P"'

# ---- DS-331: a done ticket's line is handed on without a session, and a reworded line keeps its id ---
mark; rm -f "$T/state/handed.json"; echo "hand" > "$T/claude.mode"
waits(){ printf '{"status":"show_person","code":11,"message":"x","waiting":%s,"parked":[],"notify":true,"push":[]}' "$1"; }
queue '{"V":{"key":"V","state":"done","lane":"A","result":{"pr":7}}}'
verdict "$(waits '["V: DRAFT — PR #7 stays draft: check ci has not reported. Look at it"]')"
out=$(tick)
check "DS-331 AC1: a done ticket's DRAFT line is handed on without a session" '[ "$(calls)" = 0 ] && handed | grep -q "^V|V is done, and the decider can only requeue"'
entry(){ node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(Object.values(r).filter((h) => h.ticket === process.argv[2]).map((h) => `${h.id}|${h.at}`).join(" "))' "$T/state/handed.json" "$1"; }
v1=$(entry V); sleep 1
verdict "$(waits '["V: DRAFT — PR #7 stays draft: check ci is failure. Look at it"]')"
out=$(tick)
check "DS-331 AC3: only pre-handed items start no session" '[ "$(calls)" = 0 ] && ! grep -q "^decider: started" <<< "$(tail -n 5 "$LOG")"'
check "DS-331 AC2: its new wording keeps the one entry, its id and time, with the latest text" '[ -n "$v1" ] && [ "$(entry V)" = "$v1" ] && questions | grep -q "^V|handed on|V: DRAFT — PR #7 stays draft: check ci is failure"'
ids=$(node --input-type=module -e "
import { deciderItems } from '$B/decider.mjs';
const q = { tickets: { W: { key: 'W', state: 'parked', lane: 'A' } } };
const id = (l) => deciderItems({ waiting: [l] }, q)[0].id;
console.log([id('W: DRAFT — PR #9 stays draft: check ci has not reported. Look at it'), id('W: DRAFT — PR #9 stays draft: check ci is in_progress. Look at it'), id('W: STUCK — PR #9: it cannot merge'), id('W: DRAFT — PR #10 stays draft: x'), id('W: unreadable park inputs (bad), read as none: a'), id('W: unreadable park inputs (bad), read as none: b')].join(' '));")
read -r d1 d2 s1 p10 u1 u2 <<< "$ids"
check "DS-331 AC2: the same ticket, class and PR keep one id while check states differ" '[ "$d1" = "$d2" ]'
check "DS-331 AC2: another class, another PR or an unclassed line gets its own id" '[ "$d1" != "$s1" ] && [ "$d1" != "$p10" ] && [ "$u1" != "$u2" ]'
mark; rm -f "$T/state/handed.json"
queue '{"W":{"key":"W","state":"parked","lane":"A","park":{"question":"w?"}}}'
verdict "$(waits '["W: DRAFT — PR #9 stays draft: check ci has not reported. Look at it"]')"
out=$(tick); settle; out=$(tick)
verdict "$(waits '["W: DRAFT — PR #9 stays draft: check ci is in_progress. Look at it"]')"
out=$(tick)
check "DS-331 AC2: a line handed on by a session, reworded, starts no second session and shows its latest text" '[ "$(calls)" = 1 ] && [ "$(handed | grep -c "^W|")" = 1 ] && questions | grep -q "^W|.*check ci is in_progress"'

# ---- DS-334: a park asking again what its last requeue cleared is handed on -------------------------
# Two of DS-313's real parks, a requeue apart: the same conflict, worded afresh.
P1='DS-313: rebasing fix/DS-313-restart-driver-inherited-base onto origin/main 6d1deb6 conflicts in desk/bin/installed.mjs and tests/test_installed.sh (upstream DS-306 3bc33a7/a53865c/e2f5c2f). Resolve the conflict (or say how), then a worker re-verifies and opens the draft PR.'
P2='DS-313: rebase onto origin/main (6d1deb6) conflicts in desk/bin/installed.mjs and tests/test_installed.sh with DS-306 (3bc33a7, a53865c, e2f5c2f). Workers never resolve conflicts: who rebases fix/DS-313-restart-driver-inherited-base? Not reached: push, draft PR, local review post, Jira comment, Jira transition.'
out=$(P1="$P1" P2="$P2" node --input-type=module -e "
import { deciderItems, samePark } from '$B/decider.mjs';
const { P1, P2 } = process.env;
const q = (prev) => ({ tickets: { 'DS-313': { lane: 'A', state: 'parked', park: { question: P2 }, prev_park: prev } } });
const [again] = deciderItems({ parked: [{ key: 'DS-313', question: P2 }] }, q({ question: P1, since: '2026-10-28T08:45:00Z', round: 3 }));
const [first] = deciderItems({ parked: [{ key: 'DS-313', question: P2 }] }, q(undefined));
const [other] = deciderItems({ parked: [{ key: 'DS-313', question: P2 }] }, q({ question: 'the spec for tests/test_pass.sh needs a fixture from DS-200 at 1a2b3c4', round: 1 }));
console.log([again.round, again.repeat, again.prev.question === P1, first.round, first.repeat, first.prev, other.round, other.repeat,
  samePark('needs another round: the tests fail', 'needs another round: the tests fail'), samePark('which design?', 'which copy?')].join(' '));
")
check "DS-334 AC2: a park carries its round, the park its last requeue cleared and whether it asks the same" '[ "$out" = "4 true true 1 false  2 false true false" ]'
out=$(node --input-type=module -e "
import { samePark } from '$B/decider.mjs';
console.log([
  samePark('rebasing fix/DS-400-x onto origin/main conflicts in desk/bin/pass.mjs. Who rebases?', 'tests/test_pass.sh fails on fix/DS-400-x after rebasing onto origin/main: needs more agent work', 'DS-400'),
  samePark('Which fixture?', 'which fixture', 'DS-400'),
].join(' '));
")
check "DS-334 AC3: two questions sharing only the ticket's branch and origin/main are not the same" '[ "$out" = "false true" ]'

queue '{"R":{"key":"R","state":"parked","lane":"A","park":{"question":"r: the tests fail","since":"2026-10-28T08:00:00Z"},"prev_park":{"question":"older","round":2}}}'
out=$(cd "$T/repo" && node "$B/queue.mjs" requeue R 2>&1)
check "DS-334: requeue keeps the park it cleared, with its time and round" 'node -e "const t=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).tickets.R; process.exit(t.state===\"triaged\" && t.park===null && t.prev_park.question===\"r: the tests fail\" && t.prev_park.since===\"2026-10-28T08:00:00Z\" && t.prev_park.round===3 && !!t.prev_park.requeued_at ? 0 : 1)" "$DESK_QUEUE"'
queue '{"X":{"key":"X","state":"parked","lane":"A","park":{"question":"wedged — no output for 6 passes, worker stopped (session s2). Requeue it with queue.mjs requeue X (orchestrator-recovery.md)"},"prev_park":{"question":"wedged — no output for 6 passes, worker stopped (session s1). Requeue it with queue.mjs requeue X (orchestrator-recovery.md)","round":1}}}'
out=$(cd "$T/repo" && node "$B/queue.mjs" requeue X 2>&1)
check "DS-334: a requeue that clears a stall ends the run, so a second stall is not a repeat" 'node -e "const t=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).tickets.X; process.exit(t.state===\"triaged\" && t.prev_park===null ? 0 : 1)" "$DESK_QUEUE"'
queue '{"R":{"key":"R","state":"failed","lane":"A","prev_park":{"question":"older","round":2}},"U":{"key":"U","state":"parked","lane":"A","park":{"question":"u: waits on PR 7","clears_when":{"kind":"pr-merged","pr":7}},"prev_park":{"question":"older","round":1}},"W":{"key":"W","state":"parked","lane":"A","park":{"question":"claimed","claim":{"session":"s1","at":"2026-10-28T08:00:00Z"}},"prev_park":{"question":"older","round":1}}}'
out=$(cd "$T/repo" && node "$B/queue.mjs" requeue R 2>&1 && node "$B/queue.mjs" requeue U 2>&1 && node "$B/queue.mjs" requeue W 2>&1)
check "DS-334: a requeue that clears no park ends the run; one that clears a park with a condition or a claim still records it" 'node -e "const q=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).tickets; process.exit([\"R\",\"U\",\"W\"].every((k) => q[k].state===\"triaged\") && q.R.prev_park===null && q.U.prev_park.question===\"u: waits on PR 7\" && q.U.prev_park.round===2 && q.W.prev_park.question===\"claimed\" ? 0 : 1)" "$DESK_QUEUE"'

mark; rm -f "$T/state/handed.json"; echo "requeue S" > "$T/claude.mode"
queue "{\"S\":{\"key\":\"S\",\"state\":\"parked\",\"lane\":\"A\",\"park\":{\"question\":\"$P2\",\"since\":\"2026-10-28T09:00:00Z\"},\"prev_park\":{\"question\":\"$P1\",\"since\":\"2026-10-28T08:45:00Z\",\"round\":1}}}"
verdict "$(parked S "$P2")"
out=$(tick)
check "DS-334 AC1: the same park again, unanswered, starts no session" '[ "$(calls)" = 0 ]'
check "DS-334 AC1: it is handed on naming both parks" 'handed | grep -q "^S|park 2 asks what park 1 asked, with no answer since: a requeue would park again (last park: \"DS-313: rebasing fix/DS-313"'
check "DS-334 AC1: it is not requeued" 'grep -q "\"state\":\"parked\"" "$DESK_QUEUE"'

mark; rm -f "$T/state/handed.json"
printf '\n## Answer from the user (2026-10-28T08:50:00Z)\n\nrebase it onto main yourself\n' > "$T/state/briefings/S.md"
out=$(tick); settle
check "DS-334 AC1: answered since the last park, it goes to a session" '[ "$(calls)" = 1 ] && [ -z "$(handed)" ]'
check "DS-334 AC2: the session sees the park its last requeue cleared" 'P=$(ls -t "$T"/claude.args.* | head -1) && grep -q "^  - park 2; the last requeue cleared park 1: DS-313: rebasing" "$P" && grep -q "asking the same thing in other words" "$P"'
verdict '{"status":"nothing_yet","code":10,"message":"x","waiting":[],"parked":[],"notify":false,"push":[]}'; out=$(tick)

mark; rm -f "$T/state/handed.json"; echo "requeue V" > "$T/claude.mode"
queue '{"V":{"key":"V","state":"parked","lane":"A","park":{"question":"v: the fixture for tests/test_a.sh is missing","since":"2026-10-28T09:00:00Z"},"prev_park":{"question":"v: rebase conflicts in desk/bin/x.mjs at 1a2b3c4","round":1}}}'
verdict "$(parked V "v: the fixture for tests/test_a.sh is missing")"
out=$(tick); settle
check "DS-334 AC3: a different question from the last park goes to a session as before" '[ "$(calls)" = 1 ] && [ -z "$(handed)" ]'
verdict '{"status":"nothing_yet","code":10,"message":"x","waiting":[],"parked":[],"notify":false,"push":[]}'; out=$(tick)

# ---- DS-397: a park the decider left waiting on a clears-when, or put off, is settled -------------------
# The recorded lines: KAN-1032 (30 Oct) recorded clears-when 'pr 863 merged' and handed it on; KAN-628
# (27 Oct) was answered "not now" and left parked as deferred. Both read as still parked.
mkdir -p "$T/nn"
cat > "$T/ds397.mjs" <<EOF
import { writeFileSync } from 'node:fs';
import { outcome, presort, deciderItems } from '$B/decider.mjs';
import { addPutOff, putOffEntry } from '$B/not-now.mjs';
import { openQuestions } from '$B/digest.mjs';
const C = 'KAN-1032: rebase it once PR 863 merges, since it changes the same files';
const N = 'KAN-628: export the archive too, or leave it?';
const park = (key, question, more = {}) => ({ key, state: 'parked', lane: 'A', park: { question, ...more } });
const before = { tickets: { 'KAN-1032': park('KAN-1032', C), 'KAN-628': park('KAN-628', N), 'KAN-9': park('KAN-9', 'k9: which helper?') } };
const items = deciderItems({ parked: [{ key: 'KAN-1032', question: C }, { key: 'KAN-628', question: N }, { key: 'KAN-9', question: 'k9: which helper?' }] }, before);
addPutOff(putOffEntry({ question: N, ticket: 'KAN-628', inputs: {} }), '$T/nn');
const after = { tickets: { ...before.tickets, 'KAN-1032': park('KAN-1032', C, { clears_when: { kind: 'pr-merged', pr: 863 } }) } };
const r = { cost: 0.02, settled: { [items[1].id]: "Ben answered 'not now': left KAN-628 parked as deferred" },
  handed: { [items[0].id]: "recorded clears-when 'pr 863 merged' so a later pass requeues KAN-1032", [items[2].id]: 'needs the person' } };
const o = outcome({ items }, r, after, { state: '$T/nn' });
const bare = outcome({ items }, r, after);
const next = presort(deciderItems({ parked: [{ key: 'KAN-1032', question: C }] }, after));
writeFileSync('$T/nn/queue.json', JSON.stringify(after));
const asked = openQuestions({ slug: 'acme/widgets', state: '$T/nn', queue: '$T/nn/queue.json' }).map((x) => x.ticket);
console.log([o.settled.map((x) => x.item.ticket + '=' + x.did).join(';'), o.handed.map((x) => x.item.ticket).join(),
  bare.handed.map((x) => x.item.ticket).join(), next.waits.map((i) => i.ticket).join(), next.ask.length + next.hand.length, asked.join()].join('|'));
EOF
out=$(node "$T/ds397.mjs" 2>&1)
check "DS-397 AC1: a park the decider recorded a clears-when on is settled, though it handed it on" 'echo "$out" | grep -q "^KAN-1032=recorded clears-when \"PR #863 merged\", which a later pass checks;"'
check "DS-397 AC2: a park put off with not-now that the decider left deferred is settled" 'echo "$out" | grep -q ";KAN-628=put off with \"not now\": left parked until its inputs change|KAN-9|"'
check "DS-397 AC2: without the register to read, the deferred park is still handed on" '[ "$(echo "$out" | cut -d"|" -f3)" = "KAN-628,KAN-9" ]'
check "DS-397 AC1: on the next pass the park waits on its clears-when: no session, not handed on" '[ "$(echo "$out" | cut -d"|" -f4,5)" = "KAN-1032|0" ]'
check "DS-397 AC1: the digest does not ask a park that waits on a clears-when, nor one put off" '[ "$(echo "$out" | cut -d"|" -f6)" = "KAN-9" ]'
mark; rm -f "$T/state/handed.json"
UQ='"U":{"key":"U","state":"parked","lane":"A","park":{"question":"u: waits on PR 7","clears_when":{"kind":"pr-merged","pr":7}}}'
queue "{$UQ}"; verdict "$(parked U "u: waits on PR 7")"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ "park-x": { id: "park-x", ticket: "U", kind: "parked", text: "u: waits on PR 7", why: "old", at: "2026-10-30T07:52:00Z" } }))' "$T/state/handed.json"
node --input-type=module -e "import { deciderItems } from '$B/decider.mjs'; import { writeFileSync, readFileSync } from 'node:fs'; const id = deciderItems({ parked: [{ key: 'U', question: 'u: waits on PR 7' }] })[0].id; const h = JSON.parse(readFileSync('$T/state/handed.json', 'utf8')); h['park-x'].id = id; writeFileSync('$T/state/handed.json', JSON.stringify({ [id]: h['park-x'] }));"
out=$(tick)
check "DS-397 AC1: a park waiting on its clears-when starts no session and leaves the digest" '[ "$(calls)" = 0 ] && [ -z "$(handed)" ] && grep -q "^decider: taken off the digest, each waits on its recorded clears-when: U$" "$LOG"'

# ---- DS-557: a park waiting on issue links only the person makes is still put to them ---------------
queue '{"L":{"key":"L","state":"parked","lane":"A","park":{"question":"Issue links not made: desk-jira link L relates-to M","clears_when":{"kind":"links-made","links":[{"key":"L","type":"relates-to","other":"M"}],"pr":7}}},'"$UQ"'}'
check "DS-557: the digest asks a park waiting on links-made, and still not one waiting on its PR" '[ "$(questions | cut -d"|" -f1 | tr "\n" " ")" = "L " ]'
# Prints the tickets presort hands on, then those it leaves waiting. A function, as bash brace-expands
# the object literals in a check's eval.
sorted(){ node --input-type=module -e "import { presort } from '$B/decider.mjs'; const c = (k) => JSON.stringify({ kind: k }); const r = presort([{ kind: 'parked', lane: 'A', ticket: 'L', text: 'x', clears: c('links-made') }, { kind: 'parked', lane: 'A', ticket: 'U', text: 'y', clears: c('pr-merged') }]); console.log(r.hand.map((h) => h.item.ticket).join(), r.waits.map((w) => w.ticket).join());"; }
check "DS-557: the decider hands a links-made park on to the person rather than letting it wait" '[ "$(sorted)" = "L U" ]'
filesort(){ node --input-type=module -e "import { presort } from '$B/decider.mjs'; const f = (person) => JSON.stringify({ kind: 'file-exists', path: 'fixtures/F/out.txt', root: 'state', ...(person ? { person } : {}) }); const r = presort([{ kind: 'parked', lane: 'A', ticket: 'F', text: 'x', clears: f(true) }, { kind: 'parked', lane: 'A', ticket: 'G', text: 'y', clears: f(false) }]); console.log(r.hand.map((h) => h.item.ticket).join(), r.waits.map((w) => w.ticket).join(), '|', r.hand[0]?.why);"; }
check "DS-807: the decider hands a park on a file the person makes on to them, naming the file, and one a script makes waits" \
  '[ "$(filesort)" = "F G | waits on a file only the person makes (file \$DESK_STATE/fixtures/F/out.txt exists): a pass requeues it once the file is there" ]'

# ---- DS-580: a park on a step only a person or another account takes is handed on unless answered since -
PO="There is no review from agent-pullbot at all. No worker can run it: only a person with Mac mini or org access can do this."
mkdir -p "$T/ds580/briefings"
printf '# P2\n\n## Answer from the user (2026-11-13T10:00:00Z)\nagent-pullbot has posted its review\n' > "$T/ds580/briefings/P2.md"
posort(){ node --input-type=module -e "
import { deciderItems, presort } from '$B/decider.mjs';
const q = { tickets: { P1: { lane: 'B', state: 'parked', park: { question: process.argv[1], since: '2026-11-13T09:00:00Z' } }, P2: { lane: 'B', state: 'parked', park: { question: process.argv[1], since: '2026-11-13T09:00:00Z' } }, P3: { lane: 'B', state: 'parked', park: { question: 'Retry or fail?', since: '2026-11-13T09:00:00Z' } } } };
const r = presort(deciderItems({ parked: ['P1', 'P2', 'P3'].map((key) => ({ key, question: q.tickets[key].park.question })) }, q), '$T/ds580');
console.log(r.hand.map((h) => h.item.ticket).join(), r.ask.map((i) => i.ticket).join(), r.hand[0]?.why);
" "$PO"; }
out=$(posort)
check "DS-580 AC1: a person-only park with no answer since it parked is handed on, naming its step, and not given to the model" '[ "$(cut -d" " -f1 <<< "$out")" = P1 ] && grep -q "only a person or another account takes, with no answer since it parked: a requeue would park again (\"No worker can run it: only a person with Mac mini or org access can do this.\")" <<< "$out"'
check "DS-580 AC2: the same park answered since it parked goes to the model, as an ordinary park does" '[ "$(cut -d" " -f2 <<< "$out")" = P2,P3 ]'

# ---- DS-597: the decider is shown a triaged ticket's open questions, and may search the state folder --
# SV-1 has one unknown in its triage record and one question plan-batch added on its queue entry;
# SV-2 has a plan question but is not waiting; SV-3 has neither.
mkdir -p "$T/q597/triage"
echo '{"unknowns":["Which retry rule applies: the first or the second?"]}' > "$T/q597/triage/SV-1.json"
cat > "$T/ds597.mjs" <<EOF
import { deciderItems, deciderPrompt, deciderSettings } from '$B/decider.mjs';
const triaged = (key, n, more = {}) => ({ key, state: 'triaged', lane: 'A', open_questions: n, ...more });
const q = { tickets: {
  'SV-1': triaged('SV-1', 2, { plan_questions: ['SV-1 is blocked by SV-9, which is not in this batch: hold it or drop the link?'] }),
  'SV-2': triaged('SV-2', 1, { plan_questions: ['which copy goes on the button?'] }),
  'SV-3': triaged('SV-3', 1) } };
const v = { waiting: ['SV-1: 2 question(s) open — answer with answer.mjs SV-1 "<answer>"', 'SV-3: 1 question(s) open — answer with answer.mjs SV-3 "<answer>"'] };
const items = deciderItems(v, q, '$T/q597');
const bare = deciderItems(v, q);
const line = (p, key) => p.split('\n').filter((l) => l.includes(' · ' + key + ' · ')).join('');
const prompt = deciderPrompt({ slug: 's', report: '', items, rules: '', bin: '/b', state: '$T/q597' });
const plain = deciderPrompt({ slug: 's', report: '', items: bare, rules: '', bin: '/b' });
const allow = deciderSettings({ bin: '/b', state: '/s' }).permissions.allow;
console.log(prompt);
const after = (p, key) => p.split('\n')[p.split('\n').findIndex((l) => l.includes(' · ' + key + ' · ')) + 1];
console.log('SV3_SAME=' + (JSON.stringify(items[1]) === JSON.stringify(bare[1]) && !('questions' in items[1]) && line(prompt, 'SV-3') === line(plain, 'SV-3') && !after(prompt, 'SV-3').startsWith('  - open question')));
console.log('FILE_RULES=' + allow.filter((a) => /^(Read|Grep|Glob)\(/.test(a)).join(' '));
EOF
out=$(node "$T/ds597.mjs" 2>&1)
check "DS-597 AC1: a triaged item lists its triage unknown and the question plan-batch added, word for word, under its line" \
  '[ "$(grep -c "^  - open question: " <<< "$out")" = 2 ] && grep -A2 -F " · SV-1 · waiting" <<< "$out" | grep -qxF "  - open question: Which retry rule applies: the first or the second?" && grep -A2 -F " · SV-1 · waiting" <<< "$out" | grep -qxF "  - open question: SV-1 is blocked by SV-9, which is not in this batch: hold it or drop the link?"'
check "DS-597 AC1: another ticket's plan question is not listed" '! grep -qF "which copy goes on the button" <<< "$out"'
check "DS-597 AC2: a triaged item with no triage record and no plan question reads as it did" 'grep -qx "SV3_SAME=true" <<< "$out"'
check "DS-597 AC3: the decider may Read, Grep and Glob the state folder and nothing outside it" 'grep -qx "FILE_RULES=Read(//s/\*\*) Grep(//s/\*\*) Glob(//s/\*\*)" <<< "$out"'
check "DS-597 AC4: the read line names Read, Grep and Glob on the state folder and says each command runs alone" \
  'grep -qF "files in the batch state directory ($T/q597) with the Read, Grep and Glob tools only. Run each allowed command on its own: no \`cd\`, pipe or \`;\`, which are refused" <<< "$out"'

# DS-649 AC2: the decider's session asks for the 5-minute prompt cache, and the caller's env is left as it was.
printf '#!/bin/sh\nprintf "%%s" "${FORCE_PROMPT_CACHING_5M-unset}" > "%s/cache.seen"\n' "$T" > "$T/fakes/cache-claude"
chmod +x "$T/fakes/cache-claude"
out=$(cd "$T/repo" && node --input-type=module -e "
import { existsSync, readFileSync } from 'node:fs';
const { startDecider } = await import('$B/decider.mjs');
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const before = JSON.stringify(env);
const rec = startDecider({ state: '$T/state', slug: 'acme__widgets', bin: '$B', report: '', items: [], rules: '', cwd: process.cwd(), env, claude: '$T/fakes/cache-claude' });
for (let i = 0; rec && !existsSync('$T/cache.seen') && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
console.log(readFileSync('$T/cache.seen', 'utf8'), JSON.stringify(env) === before);
" 2>&1)
check "DS-649 AC2: the decider runs with FORCE_PROMPT_CACHING_5M=1, the caller's env unchanged" '[ "$out" = "1 true" ]'

# ---- DS-563 AC3: a clears-when no form read goes to the decider to restate, and to the person only as none ----
cw(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]?.park?.clears_when?.kind)' "$DESK_QUEUE" "$1"; }
unpark(){ queue "{\"$1\":{\"key\":\"$1\",\"state\":\"parked\",\"lane\":\"A\",\"park\":{\"question\":\"$2\",\"since\":\"2026-11-01T09:00:00Z\",\"clears_when\":{\"kind\":\"unreadable\",\"text\":\"KAN-1086s fix PR is merged to main\",\"why\":\"x\"}}}}"; verdict "$(parked "$1" "$2")"; }
mark; rm -f "$T/state/handed.json"; echo "hand" > "$T/claude.mode"
unpark R "r: waiting on KAN-1086"
out=$(tick); settle
check "DS-563 AC3: a park whose clears-when no form read goes to a decider session, asked to restate it" \
  '[ "$(calls)" = 1 ] && [ "$(cw R)" = unreadable ] && P=$(ls -t "$T"/claude.args.* | head -1) && grep -qx "  - clears-when to restate: KAN-1086s fix PR is merged to main" "$P"'
out=$(tick)
check "DS-563 AC3: the session handed it on without a form: recorded none, and handed to the person" \
  '[ "$(cw R)" = none ] && grep -q "^decider: unreadable clears-when recorded as none, for the person: R$" "$LOG" && handed | grep -q "^R|" && [ "$(calls)" = 1 ]'
mark; rm -f "$T/state/handed.json"; echo "restate R2" > "$T/claude.mode"
unpark R2 "r2: waiting on KAN-1086"
out=$(tick); settle; out=$(tick)
check "DS-563 AC3: restated as a form, it waits on it: not handed to the person, never none" \
  '[ "$(cw R2)" = pr-merged ] && [ -z "$(handed)" ] && ! grep -q "recorded as none, for the person: R2" "$LOG"'
# No decider starts on a usage hold, so the hour a pass waits for a restate starts again: it cannot
# lapse to none before a decider has seen it.
mark; rm -f "$T/state/handed.json"; n=$(calls)
RQ='"R3":{"key":"R3","state":"parked","lane":"A","park":{"question":"r3: waiting on KAN-1086","since":"2026-11-01T09:00:00Z","clears_when":{"kind":"unreadable","text":"KAN-1086s fix PR is merged to main","why":"x","at":"2026-01-01T00:00:00Z"}}}'
printf '{"version":1,"batch":"b1","supervised":true,"approved":{},"usage_hold":{"since":"2026-10-29T17:30:00Z","type":"seven_day","resets_at":1793545200,"preflight":"Z","paused":[]},"tickets":{%s}}\n' "$RQ" > "$DESK_QUEUE"
verdict "$(parked R3 "r3: waiting on KAN-1086")"
out=$(tick)
at=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets.R3.park.clears_when.at)' "$DESK_QUEUE")
check "DS-563 AC3: on a usage hold no decider starts, and the restate's hour starts again" \
  '[ "$(calls)" = "$n" ] && [ "$(cw R3)" = unreadable ] && [ "$at" != 2026-01-01T00:00:00Z ] && node -e "process.exit(Date.now() - Date.parse(process.argv[1]) < 600000 ? 0 : 1)" "$at" && grep -q "^decider: the hour to restate an unreadable clears-when starts again once one runs: R3$" "$LOG"'
verdict '{"status":"nothing_yet","code":10,"message":"x","waiting":[],"parked":[],"notify":false,"push":[]}'

# ---- the base sync line is one item whatever its wording; a new base head is one new session --
ids=$(node --input-type=module -e "
import { deciderItems } from '$B/decider.mjs';
import { createHash } from 'node:crypto';
const id = (l, o) => deciderItems({ waiting: [l] }, {}, null, o)[0];
const a = id('base sync: merging main into feat conflicts — feat is 21 commit(s) behind main', { baseSha: 'b1' });
const b = id('base sync: feat is 3 commit(s) behind main and config §3 batch-base-push is \"ask\" — spawning carries on', { baseSha: 'b2' });
const t = id('W: DRAFT — PR #9 stays draft: x');
const today = 'wait-' + createHash('sha256').update(['W', 'DRAFT', '9'].join(String.fromCharCode(0))).digest('hex').slice(0, 12);
console.log([a.id === b.id, a.base, b.base, t.id === today, t.base === undefined].join(' '));")
check "DS-809 AC1/AC3: base sync lines share one id and carry the base head; a ticket line's id is as before" '[ "$ids" = "true b1 b2 true true" ]'
mark; rm -f "$T/state/handed.json"; echo "hand" > "$T/claude.mode"
git -C "$T/repo" init -q && git -C "$T/repo" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m one && git -C "$T/repo" update-ref refs/remotes/origin/feat HEAD
printf '{"version":1,"batch":"b1","base":"feat","supervised":true,"approved":{},"tickets":{}}\n' > "$DESK_QUEUE"
sync(){ verdict "$(waits "[\"base sync: merging main into feat conflicts, nothing pushed. Conflicting files: a.mjs — feat is $1 commit(s) behind main, more than the 20 it may lag and still spawn, so nothing spawns this pass\"]")"; }
for n in 21 22 23; do sync "$n"; out=$(tick); settle; done
check "DS-809 AC1: three passes whose base sync line differs only in its commit count start one session" '[ "$(calls)" = 1 ] && [ "$(handed | grep -c "^base sync|")" = 1 ]'
git -C "$T/repo" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m two && git -C "$T/repo" update-ref refs/remotes/origin/feat HEAD
for n in 24 25; do sync "$n"; out=$(tick); settle; done
check "DS-809 AC2: handed on and unanswered, a new base head starts one new session, and later passes none" '[ "$(calls)" = 2 ] && [ "$(handed | grep -c "^base sync|")" = 1 ]'
verdict '{"status":"nothing_yet","code":10,"message":"x","waiting":[],"parked":[],"notify":false,"push":[]}'

# ---- the ask ledger: with the ledger lever on, a park handed to the decider is raised and presented by
# it, the decider's take is its answer, and a park handed to the person without a session is raised only
printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `ledger` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
unset CLAUDE_CODE_SESSION_ID
asks(){ node --input-type=module -e "
import { fold } from '$B/ticket-ledger.mjs';
import { readAsks } from '$B/ask-ledger.mjs';
for (const a of readAsks(fold('$T'))) console.log([a.ask, a.kind, a.presented.map((p) => p.via + ':' + (p.ref ? 'ref' : '-')).join(',') || '-', a.answered ? [a.answered.by, a.answered.session, a.answered.latency_s === Math.round((Date.parse(a.answered.at) - Date.parse(a.since)) / 1000)].join(':') : '-'].join('|'));"; }
askevents(){ grep -c "\"type\":\"$1\"" "$T/ledger/events.jsonl" 2>/dev/null || echo 0; }
mark; rm -f "$T/state/handed.json"; echo "take J6" > "$T/claude.mode"
queue '{"J6":{"key":"J6","state":"parked","lane":"A","park":{"kind":"question","question":"'"$REC"' (J6)","since":"2026-10-28T08:00:00Z"}},"C2":{"key":"C2","state":"parked","lane":"C","park":{"kind":"question","question":"which of two layouts?","since":"2026-10-28T09:00:00Z"}}}'
# The batch named in its ledger, as its first queue write with the lever on would.
node --input-type=module -e "import { queueDifference } from '$B/queue-ledger.mjs'; queueDifference('$DESK_QUEUE', { seed: true });"
verdict '{"status":"show_person","code":11,"message":"PARKED","waiting":[],"parked":[{"key":"J6","question":"'"$REC"' (J6)"},{"key":"C2","question":"which of two layouts?"}],"notify":true,"push":[]}'
out=$(tick); settle
verdict '{"status":"nothing_yet","code":10,"message":"no change this pass","waiting":[],"parked":[],"notify":false,"push":[]}'
out=$(tick)
check "ask ledger: the decider's park is raised, presented by the decider, and answered by it, its latency from the park" 'asks | grep -qx "J6:2026-10-28T08:00:00Z|question|decider:ref|decider::true"'
check "ask ledger: a park handed to the person without a session is raised, and neither presented nor answered" 'asks | grep -qx "C2:2026-10-28T09:00:00Z|question|-|-"'
check "ask ledger: answer.mjs --taken and the reaped session's settle write one answer between them" '[ "$(askevents ask_answered)" = 1 ]'
n=$(askevents ask_raised)
verdict '{"status":"show_person","code":11,"message":"PARKED","waiting":[],"parked":[{"key":"C2","question":"which of two layouts?"}],"notify":true,"push":[]}'
out=$(tick)
check "ask ledger: a park listed again, still handed on, is not raised again" '[ "$n" = 2 ] && [ "$(askevents ask_raised)" = "$n" ]'

# ---- question handling: an ask handed to the person is pushed where its ticket's arm says so --------
# A notifier that works, and a time zone where the clock reads noon (the arms push nothing 22:00 to
# 08:00), or 23:00 for the quiet-hours case.
printf '#!/bin/sh\nprintf "%%s|%%s\\n" "$2" "$3" >> "%s/notified"\nexit 0\n' "$T" > "$T/fakes/notify-send"; chmod +x "$T/fakes/notify-send"
tz_at(){ local o=$(( $1 - 10#$(date -u +%H) )); [ "$o" -gt 12 ] && o=$((o - 24)); [ "$o" -lt -11 ] && o=$((o + 24)); if [ "$o" -ge 0 ]; then echo "Etc/GMT-$o"; else echo "Etc/GMT+$(( -o ))"; fi; }
qtick(){ (cd "$T/repo" && TZ="$(tz_at "$1")" DESK_PLATFORM=linux node "$T/bin/supervisor.mjs" tick --foreground 2>&1); }
arm(){ printf ',"levers":{"set":["question-handling"],"values":{"question-handling":"%s"},"at":"2026-10-28T00:00:00Z"}' "$1"; }
cpark(){ printf '"%s":{"key":"%s","state":"parked","lane":"C","park":{"kind":"question","question":"%s: which of two layouts?","since":"2026-10-28T1%s:00:00Z"}%s}' "$1" "$1" "$1" "$2" "$3"; }
cverdict(){ local ps=""; for k in "$@"; do ps="$ps${ps:+,}{\"key\":\"$k\",\"question\":\"$k: which of two layouts?\"}"; done; verdict "{\"status\":\"show_person\",\"code\":11,\"message\":\"PARKED\",\"waiting\":[],\"parked\":[$ps],\"notify\":true,\"push\":[]}"; }
arms(){ node --input-type=module -e "
import { fold } from '$B/ticket-ledger.mjs';
import { readAsks } from '$B/ask-ledger.mjs';
for (const a of readAsks(fold('$T')).filter((x) => x.key.startsWith('Q'))) console.log([a.key, a.arm ?? '-', a.blocking ?? '-', a.presented.map((p) => p.via).join(',') || '-'].join('|'));"; }
rm -f "$T/state/handed.json" "$T/notified"
queue "{$(cpark Q0 0 ""),$(cpark Q1 1 "$(arm one-at-a-time)"),$(cpark Q2 2 "$(arm mixed)"),\"R\":{\"key\":\"R\",\"state\":\"running\",\"lane\":\"A\"}}"
node --input-type=module -e "import { queueDifference } from '$B/queue-ledger.mjs'; queueDifference('$DESK_QUEUE', { seed: true });"
cverdict Q0 Q1 Q2; out=$(qtick 12)
check "question handling: a one-at-a-time ask handed to the person is pushed at once" 'grep -qx "desk: acme__widgets|Q1: Q1: which of two layouts?" "$T/notified"'
check "question handling: with the lever off, and on the mixed arm with another ticket running, nothing is pushed for it" '[ "$(grep -c "Q0\|Q2" "$T/notified")" = 0 ]'
check "question handling: the pushed ask is presented by push; each raised records its arm and blocking flag, none with the lever off" \
  '[ "$(arms | sort | paste -sd " " -)" = "Q0|-|-|- Q1|one-at-a-time|false|push Q2|mixed|false|-" ]'
n=$(wc -l < "$T/notified"); out=$(qtick 12)
check "question handling: the next pass, the ask still handed on, pushes nothing again" '[ "$(wc -l < "$T/notified")" = "$n" ]'
queue "{$(cpark Q3 3 "$(arm mixed)"),$(cpark Q4 4 "$(arm one-at-a-time)")}"
cverdict Q3 Q4; out=$(qtick 23)
check "question handling: in quiet hours nothing is pushed, and the log says the ask waits for the digest" \
  '! grep -q "Q3\|Q4" "$T/notified" && grep -q "question-handling: not pushed in quiet hours (22:00 to 08:00), each waits for the check-in digest: Q3 (mixed), Q4 (one-at-a-time)" "$LOG"'
rm -f "$T/state/handed.json"; out=$(qtick 12)
check "question handling: a mixed ask with nothing else running is blocking, and pushed" 'grep -q "^desk: acme__widgets|Q3: Q3: which of two layouts?" "$T/notified"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
