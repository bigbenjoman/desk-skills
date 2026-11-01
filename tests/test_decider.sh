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
for f in desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs batches.mjs batch.mjs decider.mjs handoff.mjs briefing.mjs intake.mjs epic-plan.mjs closeout.mjs installed.mjs run-by.mjs usage-limit.mjs borrow.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
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
# webfact: requeue only when the prompt carries the public-fact rule, otherwise hand on
[ "\$mode" = webfact ] && { grep -q 'requeue it for its worker to look the fact up' <<< "\$2" && mode=requeue || mode=hand; }
ids=\$(grep -oE 'id \`[a-z]+-[0-9a-f]+\`' <<< "\$2" | grep -oE '[a-z]+-[0-9a-f]+')
case "\$mode" in
  hang) exec sleep 60 ;;
  requeue)
    node -e 'const f=process.argv[1]; const q=JSON.parse(require("fs").readFileSync(f,"utf8")); Object.assign(q.tickets[process.argv[2]], {state:"triaged", park:null}); require("fs").writeFileSync(f, JSON.stringify(q))' "$T/queue.json" "\$key"
    node -e 'const [key, ids] = process.argv.slice(1); console.log(JSON.stringify({type:"result", total_cost_usd:0.1234, result:"Done.\nDECIDER_RESULT: "+JSON.stringify({settled: ids.split(/\s+/).filter(Boolean).map((id) => ({id, did:"requeued "+key+" for more agent work"})), handed:[]})}))' "\$key" "\$ids" ;;
  hand)
    node -e 'console.log(JSON.stringify({type:"result", total_cost_usd:0.05, result:"DECIDER_RESULT: "+JSON.stringify({settled:[], handed: process.argv[1].split(/\s+/).filter(Boolean).map((id) => ({id, why:"a product call"}))})}))' "\$ids" ;;
  limit) cat "$S/fixtures/decider-usage-limit.json" ;;
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

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
