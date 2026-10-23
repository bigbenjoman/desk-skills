#!/usr/bin/env bash
# suite: queue set (JSON objects and arrays; move and placed)
# queue.mjs set must store a value opening with { or [ as JSON, refuse an invalid one, and keep an
# object's other keys when one nested key is set. move puts an unfinished ticket at a position and
# marks it placed, and front and requeue then leave it there.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
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
R="$(cd "$T/repo" && pwd -P)"   # git reports the resolved root (/private/var on macOS)
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
# r <path>: the JSON of T-1's field at that dotted path.
r(){ out=$(node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets["T-1"]; for (const p of process.argv[2].split(".")) v = v?.[p]; console.log(JSON.stringify(v));' "$DESK_QUEUE" "$1"); }

q init t; q add T-1

q set T-1 'result={"pr":12,"summary":"done"}'
r result.pr;                check "object is stored as JSON"              '[ $rc -eq 0 ] && [ "$out" = 12 ]'
q set T-1 result.pr=13
r result;                   check "nested set keeps the other keys"       '[ "$out" = "{\"pr\":13,\"summary\":\"done\"}" ]'

q set T-1 'deps=["T-2","T-3"]'
r deps;                     check "array is stored as JSON"               '[ $rc -eq 0 ] && [ "$out" = "[\"T-2\",\"T-3\"]" ]'

q set T-1 state=done 'result={"pr":'
check "invalid JSON is an error"                                          '[ $rc -ne 0 ] && [[ "$out" == *"not valid JSON"* ]]'
r result.pr;                check "invalid JSON writes nothing"           '[ "$out" = 13 ]'
r state;                    check "nor the other pairs"                   '[ "$out" != "\"done\"" ]'

q set T-1 lane=A open_questions=0 park=null
r lane;                     check "plain string unchanged"                '[ "$out" = "\"A\"" ]'
r open_questions;           check "integer unchanged"                     '[ "$out" = 0 ]'
r park;                     check "null unchanged"                        '[ "$out" = null ]'

# A top-level pr is read by nothing (release and STUCK read result.pr), so set refuses it.
before=$(cksum < "$DESK_QUEUE"); q set T-1 state=done pr=12
check "DS-196 AC1: pr=12 is refused, names result.pr=12, writes nothing"  '[ $rc -ne 0 ] && [[ "$out" == *"result.pr=12"* ]] && [ "$(cksum < "$DESK_QUEUE")" = "$before" ]'
q set T-1 result.pr=12; r result.pr
check "DS-196 AC2: result.pr=12 is written as today"                      '[ "$out" = 12 ]'
q set T-1 state=parked held_by=T-2 'park={"question":"q"}' lane=B; s=$rc
r state; o1=$out; r held_by; o2=$out; r park.question; o3=$out; r lane
check "DS-196 AC3: state, held_by, park and lane are written as today"    '[ $s -eq 0 ] && [ "$o1" = "\"parked\"" ] && [ "$o2" = "\"T-2\"" ] && [ "$o3" = "\"q\"" ] && [ "$out" = "\"B\"" ]'

q set-batch 'meta={"a":1}'
out=$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).meta))' "$DESK_QUEUE")
check "set-batch takes JSON too"                                          '[ "$out" = "{\"a\":1}" ]'

# init refuses, before touching the queue, when the repo's settings start sessions in dontAsk
printf '{"permissions":{"defaultMode":"dontAsk"}}\n' > "$T/repo/.claude/settings.json"
q init t2
check "init refuses under dontAsk"                                        '[ $rc -ne 0 ] && [[ "$out" == *"defaultMode is dontAsk: the orchestrator cannot ask questions or run monitors"* ]] && [[ "$out" == *"$R/.claude/settings.json"* ]]'
out=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).batch)' "$DESK_QUEUE")
check "a refused init leaves the queue alone"                             '[ "$out" = t ]'
out=$(node "$B/desk-env.mjs" default-mode 2>&1); rc=$?
check "desk-env default-mode exits 1 and names the file"                  '[ $rc -eq 1 ] && [[ "$out" == *"DEFAULT_MODE=dontAsk"* ]] && [[ "$out" == *"SOURCE=$R/.claude/settings.json"* ]]'
printf '{"permissions":{"defaultMode":"default"}}\n' > "$T/repo/.claude/settings.local.json"
q init t4
check "settings.local.json outranks settings.json"                        '[ $rc -eq 0 ]'
rm -f "$T/repo/.claude/settings.local.json" "$T/repo/.claude/settings.json"
mkdir -p "$HOME/.claude"; printf '{"permissions":{"defaultMode":"dontAsk"}}\n' > "$HOME/.claude/settings.json"
q init t5
check "user-level dontAsk is caught too"                                  '[ $rc -ne 0 ] && [[ "$out" == *"$HOME/.claude/settings.json"* ]]'
rm -f "$HOME/.claude/settings.json"
out=$(node "$B/desk-env.mjs" default-mode 2>&1); rc=$?
check "no defaultMode anywhere: unset, exit 0"                            '[ $rc -eq 0 ] && [[ "$out" == *"DEFAULT_MODE=unset"* ]]'

# move, placed, front and requeue. D-1 is done: it keeps its slot and is never counted.
q init moves
for k in A-1 D-1 A-2 A-3 A-4 A-5; do q add "$k"; q set "$k" state=triaged lane=A; done
q set D-1 state=done
# order: every ticket key, in spawn order. pos <KEY>: its position among the unfinished tickets.
order(){ out=$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets).join(" "))' "$DESK_QUEUE"); }
pos(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets; console.log(Object.keys(t).filter((k) => !["done", "failed"].includes(t[k].state)).indexOf(process.argv[2]) + 1)' "$DESK_QUEUE" "$1"; }
placed(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]].placed === true)' "$DESK_QUEUE" "$1"; }
st(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]].state)' "$DESK_QUEUE" "$1"; }
sum(){ cksum < "$DESK_QUEUE"; }

q move A-4 2; o=$out; order
check "AC5 the fourth unfinished ticket moves to second, the rest keep order" '[ $rc -eq 0 ] && [ "$out" = "A-1 D-1 A-4 A-2 A-3 A-5" ] && [ "$(placed A-4)" = true ] && [[ "$o" == *"position 2 of 5"* ]]'
q move A-1 last; order
check "AC6 last moves the first ticket to fifth"                          '[ $rc -eq 0 ] && [ "$out" = "A-4 D-1 A-2 A-3 A-5 A-1" ] && [ "$(pos A-1)" = 5 ] && [ "$(placed A-1)" = true ]'
before=$(sum); q move A-2 9
check "AC7 a position past the end names the range and changes nothing"   '[ $rc -ne 0 ] && [[ "$out" == *"1 to 5"* ]] && [ "$(sum)" = "$before" ]'
q move A-2 0
check "position 0 is out of range too"                                    '[ $rc -ne 0 ] && [[ "$out" == *"1 to 5"* ]] && [ "$(sum)" = "$before" ]'
q set A-3 state=running; before=$(sum); q move A-3 1
check "AC8 a running ticket is refused and nothing changes"               '[ $rc -ne 0 ] && [[ "$out" == *"A-3 is running"* ]] && [ "$(sum)" = "$before" ]'
q move D-1 1
check "a done ticket has no place to move to"                             '[ $rc -ne 0 ] && [[ "$out" == *"D-1 is done"* ]]'
q set A-3 state=triaged

q move A-2 3; q hold A-2 A-5
q set A-2 state=triaged park=null held_by=null; q front A-2
check "AC9 a placed ticket released by front stays put, and says why"     '[ $rc -eq 0 ] && [ "$(pos A-2)" = 3 ] && [[ "$out" == *"stays at position 3"*"the user placed it"* ]]'
q park A-2 "a question"; q requeue A-2
check "AC10 a placed parked ticket requeues as triaged where it was"      '[ $rc -eq 0 ] && [ "$(st A-2)" = triaged ] && [ "$(pos A-2)" = 3 ] && [[ "$out" == *"the user placed it"* ]]'
q front A-5; order
check "AC11 a ticket not placed still moves to the front"                 '[ $rc -eq 0 ] && [ "${out%% *}" = A-5 ]'
q requeue A-3; order
check "a requeue of a ticket not placed still fronts it"                  '[ "${out%% *}" = A-3 ]'

# A triaged ticket with a triage question open never spawns, so the table and front say so.
q render
check "DS-189 AC5: a triaged ticket with no question open has a bare row" '[ $rc -eq 0 ] && echo "$out" | grep -Eq "^  TRIAGED +A-5 +$"'
q set A-5 open_questions=1; q render
check "DS-189 AC1: its row says 1 question is open and names answer.mjs"  '[ $rc -eq 0 ] && echo "$out" | grep -q "^  TRIAGED  A-5       blocked: 1 question(s) open, answer with answer.mjs A-5 \"<answer>\"$"'
q front A-5
check "DS-189 AC4: front says it will not spawn until answered"           '[ $rc -eq 0 ] && [[ "$out" == "A-5 moved to the front of the spawn order; it still has 1 question(s) open and will not spawn until they are answered: answer with answer.mjs A-5 \"<answer>\"" ]]'
q set A-5 open_questions=0; q front A-5
check "front with no question open says nothing more"                     '[ $rc -eq 0 ] && [ "$out" = "A-5 moved to the front of the spawn order" ]'

rm -rf "$T"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
