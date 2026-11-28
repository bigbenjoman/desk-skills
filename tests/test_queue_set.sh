#!/usr/bin/env bash
# suite: queue set (JSON objects and arrays; move and placed)
# layer: L2
# queue.mjs set must store a value opening with { or [ as JSON, refuse an invalid one, and keep an
# object's other keys when one nested key is set. move puts an unfinished ticket at a position and
# marks it placed, and front and requeue then leave it there.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
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
# The user's own --front (front --placed) marks it placed, so the pass's re-sort leaves it there; the
# pass's own front does not.
check "#1623 a plain front leaves the ticket unplaced"                     '[ "$(placed A-5)" = false ] && [ "$(placed A-3)" = false ]'
q set A-4 state=running placed=null; q front A-4 --placed; frc=$rc; p=$(placed A-4); q set A-4 state=triaged
check "#1623 front --placed does not place a running ticket"               '[ $frc -eq 0 ] && [ "$p" = false ]'
q front A-3 --placed; o=$out; order
check "#1623 front --placed fronts it and marks it placed"                 '[ $rc -eq 0 ] && [ "${out%% *}" = A-3 ] && [ "$(placed A-3)" = true ] && [ "$o" = "A-3 moved to the front of the spawn order" ]'
# plan-batch --keep-order lays the order named with order --placed, so the re-sort keeps it.
q set A-3 placed=null; q order A-5 A-3; order
check "#1623 a plain order lays the keys and places none"                  '[ $rc -eq 0 ] && [ "${out%% *}" = A-5 ] && [ "$(placed A-5)" = false ] && [ "$(placed A-3)" = false ]'
q order A-3 A-5 --placed; order
check "#1623 order --placed lays the keys and places each one"             '[ $rc -eq 0 ] && [ "${out%% *}" = A-3 ] && [ "$(placed A-3)" = true ] && [ "$(placed A-5)" = true ]'
# A ticket the pass moved at move-and-say stays placed with its note (pass.mjs placed_move); the user
# placing it again, by move, front --placed or order --placed, clears the note.
moved(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]].placed_move !== undefined)' "$DESK_QUEUE" "$1"; }
note='placed_move={"from":1,"to":3,"gain_min":45}'
q set A-3 "$note"; q move A-3 1
check "#1625 the user moving a ticket the pass moved clears its note"       '[ $rc -eq 0 ] && [ "$(moved A-3)" = false ] && [ "$(placed A-3)" = true ]'
q set A-3 "$note"; q front A-3 --placed
check "#1625 front --placed clears it too"                                  '[ $rc -eq 0 ] && [ "$(moved A-3)" = false ] && [ "$(placed A-3)" = true ]'
q set A-3 placed=null; q set A-5 placed=null "$note"; q order A-3 A-5 --placed
check "#1625 and order --placed"                                            '[ $rc -eq 0 ] && [ "$(moved A-5)" = false ] && [ "$(placed A-5)" = true ]'
q set A-3 placed=null; q set A-5 placed=null

# A triaged ticket with a triage question open never spawns, so the table and front say so.
q render
check "DS-189 AC5: a triaged ticket with no question open has a bare row" '[ $rc -eq 0 ] && echo "$out" | grep -Eq "^  TRIAGED +A-5 +$"'
q set A-5 open_questions=1; q render
check "DS-189 AC1: its row says 1 question is open and names answer.mjs"  '[ $rc -eq 0 ] && echo "$out" | grep -q "^  TRIAGED  A-5       blocked: 1 question(s) open, answer with answer.mjs A-5 \"<answer>\"$"'
q front A-5
check "DS-189 AC4: front says it will not spawn until answered"           '[ $rc -eq 0 ] && [[ "$out" == "A-5 moved to the front of the spawn order; it still has 1 question(s) open and will not spawn until they are answered: answer with answer.mjs A-5 \"<answer>\"" ]]'
q set A-5 open_questions=0; q front A-5
check "front with no question open says nothing more"                     '[ $rc -eq 0 ] && [ "$out" = "A-5 moved to the front of the spawn order" ]'

# #774: a ticket handed off between sessions is triaged until its next session starts; it reads as a
# handoff to that stage, not as a fresh ticket, unless a question still blocks it.
q set A-5 handoff=pending handoff_stage=7; q render
check "#774 a pending handoff reads as HANDOFF, starting its stage"       '[ $rc -eq 0 ] && echo "$out" | grep -q "^  HANDOFF  A-5       starting Stage 7$"'
q set A-5 open_questions=1; q render
check "#774 a handoff a question blocks still reads as blocked"           '[ $rc -eq 0 ] && echo "$out" | grep -q "^  TRIAGED  A-5       blocked: 1 question(s) open"'
q set A-5 open_questions=0 handoff=null handoff_stage=null

# DS-419 AC4: a done ticket is DONE only once its PR has merged, or it finished with no PR.
q set A-5 state=done result.pr=2289; q render
check "DS-419 AC4: a done ticket whose PR is open is not listed as DONE"  '[ $rc -eq 0 ] && echo "$out" | grep -q "^  PR OPEN  A-5       PR #2289$"'
# #1640 AC4: a draft whose red checks name no file it changes waits on their one rerun, not done.
q set A-5 pr_status.pr=2289 pr_status.state=OPEN pr_status.isDraft=true 'undraft={"call":"rerun","why":"its \"CI (shard 6/6)\" check'"'"'s failed log names no file this PR changes, so its run is re-run once at this head, every job, before any fix worker"}'; q render
check "#1640 AC4: a draft whose rerun is pending reads ON CHECKS, waiting on checks" '[ $rc -eq 0 ] && echo "$out" | grep -q "^  ON CHECKS A-5       PR #2289 draft, waiting on checks: re-run once as their failed logs name no file it changes$"'
q set A-5 'undraft={"call":"wait","why":"checks still running (CI (shard 5/6)) in the run of \"CI (shard 6/6)\", whose failed log names no file this PR changes, re-run once they finish"}'; q render
check "#1640 AC4: so does one waiting on its run before the rerun"         'echo "$out" | grep -q "^  ON CHECKS A-5 "'
q set A-5 'undraft={"call":"rerun","why":"its checks were cancelled, so their runs are re-run"}'; q render
check "#1640 AC4: another rerun stays PR OPEN"                             'echo "$out" | grep -q "^  PR OPEN  A-5       PR #2289$"'
q set A-5 undraft=null pr_status.isDraft=null
q set A-5 pr_status.pr=2289 pr_status.state=CLOSED; q render
check "DS-419 AC4: one whose PR was closed unmerged reads CLOSED"         'echo "$out" | grep -q "^  CLOSED   A-5       PR #2289$"'
q set A-5 pr_status.state=MERGED merged_at=2026-11-02T10:00:00.000Z; q render
check "DS-419 AC4: once it merged, it is DONE"                            'echo "$out" | grep -q "^  DONE     A-5       PR #2289 merged$"'
q set A-5 result.pr=null merged_at=null pr_status=null; q render
check "DS-419 AC4: one that finished with no PR is DONE"                  'echo "$out" | grep -Eq "^  DONE +A-5 *$"'

# A release by set names the blockers it cleared that have not merged, on stderr only, and still goes ahead.
# qs: stdout in out, stderr in err. held <KEY>: its held_by and state.
qs(){ out=$(node "$B/queue.mjs" "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); }
held(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(`${t.held_by} ${t.state}`)' "$DESK_QUEUE" "$1"; }
q init holds
for k in B-1 B-2 B-3 B-4 W-1 W-2 W-3 W-4; do q add "$k"; q set "$k" state=triaged lane=A; done
q set W-1 state=parked held_by='B-1|B-3|B-4|B-2' 'park={"question":"held"}'
qs set W-1 state=triaged park=null held_by=null
check "DS-1045 AC1: the release goes ahead and names every open blocker"  '[ $rc -eq 0 ] && [ "$(held W-1)" = "null triaged" ] && [ "$err" = "warning: W-1 is no longer held behind B-1, B-3, B-4, B-2, which have not merged yet" ]'
check "DS-1045 AC5: stdout is the one-line pairs output"                  '[ "$out" = "W-1: state=triaged park=null held_by=null" ]'
for k in B-1 B-3; do q set "$k" state=done merged_at=2026-11-02T10:00:00.000Z; done
q set W-2 state=parked held_by='B-1|B-2|B-3|B-4' 'park={"question":"held"}'
qs set W-2 state=triaged park=null held_by=null; rc_warned=$rc
check "DS-1045 AC2: only the blockers that have not merged are named"     '[ $rc -eq 0 ] && [ "$err" = "warning: W-2 is no longer held behind B-2, B-4, which have not merged yet" ]'
q set W-3 state=parked held_by='B-1|B-3' 'park={"question":"held"}'
qs set W-3 state=triaged park=null held_by=null
check "DS-1045 AC3: all merged, nothing on stderr, stdout as today"       '[ $rc -eq 0 ] && [ -z "$err" ] && [ "$out" = "W-3: state=triaged park=null held_by=null" ] && [ "$(held W-3)" = "null triaged" ]'
# AC4: the warned release (W-2) writes what the silent one (W-3) does, bar what each add stamps
# (key, added_at and the levers pin, which carries its own time) and updated_at.
strip(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; for (const f of ["key", "added_at", "levers", "updated_at"]) delete t[f]; console.log(JSON.stringify(t))' "$DESK_QUEUE" "$1"; }
check "DS-1045 AC4: exit 0, and the queue holds what it would without it" '[ $rc_warned -eq 0 ] && [ "$(strip W-2)" = "$(strip W-3)" ]'
# The merge driver's release passes --merged: it confirmed each blocker merged on GitHub, which the queue can trail.
q set W-4 state=parked held_by='B-2|B-4' 'park={"question":"held"}'
qs set W-4 --merged state=triaged park=null held_by=null
check "DS-1045 --merged: a release whose caller confirmed the merges warns of nothing" '[ $rc -eq 0 ] && [ -z "$err" ] && [ "$out" = "W-4: state=triaged park=null held_by=null" ] && [ "$(held W-4)" = "null triaged" ]'

# #1681: clearing the last blocker from a hold's held_by releases it in the same write, and says so;
# a hold with a blocker left, or a date to wait for, stays held.
parkq(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(t.park?.question ?? null))' "$DESK_QUEUE" "$1"; }
for k in W-5 W-6 W-7 W-8; do q add "$k"; q set "$k" state=triaged lane=A; done
q hold W-5 B-2
qs set W-5 held_by=null
check "#1681 AC1: clearing held_by on a hold releases it to triaged and says so" '[ $rc -eq 0 ] && [ "$(held W-5)" = "null triaged" ] && [ "$(parkq W-5)" = null ] && [ "$out" = "W-5: held_by=null; no blocker is left, so it is released: state=triaged park=null" ]'
q hold W-6 B-2 B-4
qs set W-6 held_by=B-4
check "#1681 AC1: a hold with a blocker left stays held"                    '[ $rc -eq 0 ] && [ "$(held W-6)" = "B-4 parked" ] && [ "$out" = "W-6: held_by=B-4" ]'
q set W-6 held_label=blocked-until-2099-01-01
qs set W-6 held_by=null
check "#1681 AC1: a hold with its date label left stays held on the date"   '[ $rc -eq 0 ] && [ "$(held W-6)" = "null parked" ] && [ "$out" = "W-6: held_by=null" ]'
# A hold left with no blocker by a write that named its state is shown as such, not "held behind ?",
# and `set state=triaged`, as it says, releases it with its park.
q hold W-7 B-2; q set W-7 state=parked held_by=null; q render
check "#1681 AC2: a hold with no blocker reads HELD, with the release command" '[ $rc -eq 0 ] && echo "$out" | grep -q "^  HELD     W-7       held, no blocker: release with queue.mjs set W-7 state=triaged$" && ! echo "$out" | grep -q "held behind ?"'
qs set W-7 state=triaged
check "#1681 AC2: and set state=triaged releases it, its park too"           '[ $rc -eq 0 ] && [ "$(held W-7)" = "null triaged" ] && [ "$(parkq W-7)" = null ] && [ "$out" = "W-7: state=triaged; its hold is lifted: park=null" ]'
# A park of its own is no hold, so clearing its held_by leaves it parked.
q set W-8 state=parked held_by=B-2 'park={"question":"which colour?"}'
qs set W-8 held_by=null
check "#1681 a park of its own is not released by clearing held_by"          '[ "$(held W-8)" = "null parked" ] && [ "$(parkq W-8)" = "\"which colour?\"" ]'

rm -rf "$T"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
