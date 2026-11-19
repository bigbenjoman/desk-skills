#!/usr/bin/env bash
# suite: merge driver: loops, releases and its log (offline, fake gh)
# The real merge-driver.sh and gate.mjs, one loop at a time, set up by merge_driver_setup.sh: which PR
# merges in a loop, the held tickets a merge releases (the driver's and pass.mjs's), a feature spine, a
# stop in the pause, and --log with its rotation.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

SHA1=1111111111111111111111111111111111111111; SHA2=2222222222222222222222222222222222222222
SHA4=4444444444444444444444444444444444444444; SHA5=5555555555555555555555555555555555555555
cat > "$T/prs.json" <<EOF
{
  "101": { "head": "fix/T-1", "base": "main",    "sha": "$SHA1", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "102": { "head": "fix/T-2", "base": "main",    "sha": "$SHA2", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "104": { "head": "fix/T-4", "base": "main",    "sha": "$SHA4", "state": "open", "draft": false, "checks": [["test", "SUCCESS"], ["lint", "FAILURE"]] },
  "105": { "head": "fix/T-5", "base": "release", "sha": "$SHA5", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
q init merge-driver
for k in T-1 T-2 T-3 T-4 T-5; do q add "$k" Task A; q set "$k" "branch=fix/$k"; done
for k in T-1 T-2 T-4 T-5; do q set "$k" state=done "result.pr=10${k#T-}"; done
q set T-3 state=triaged; q hold T-3 T-1
q set T-1 spawned_at=2026-01-01T00:00:00.000Z

# ---- loop 1: every PR is evaluated, nothing merges yet ------------------------------------------
loop
check "AC1: one loop exits 0 instead of sleeping"                   '[ $rc -eq 0 ] && [ ! -e "$T/sleeps" ] && echo "$out" | grep -q "merge driver up"'
check "AC5: the driver targets the default branch with no batch base" 'echo "$out" | grep -q "base=main"'
check "AC2: a first green loop records the heads and merges nothing" '[ -z "$(merged)" ] && echo "$out" | grep -q "#101 green at 111111111" && echo "$out" | grep -q "#102 green at 222222222"'
check "AC3: the red PR is not merged and the log names its failing check" 'echo "$out" | grep -q "#104 red at 444444444: \"lint\" failure"'
check "AC4: the held ticket stays held while its blocker is open"   '[ "$(qf T-3 .state)" = parked ]'
pj
check "pass: held behind an open PR, nothing else left, exits 10"  '[ $rc -eq 10 ] && [ "$(js .status)" = nothing_yet ] && [ "$(js "[.release_due, .stuck] | flatten | length")" = 0 ]'

# ---- loop 2: the first green PR merges, pinned, and its held ticket is released -----------------
loop
check "AC1: the second loop also exits without sleeping"            '[ $rc -eq 0 ] && [ ! -e "$T/sleeps" ]'
check "AC2: one merge in the loop, the first PR, pinned to its head" '[ "$(merged)" = 101 ] && grep -qx "101 main $SHA1" "$T/merges.log" && grep -q -- "--match-head-commit $SHA1" "$T/gh.log"'
check "DS-552 AC3: with §4 Merged-tree check unset it merges as before, logging that none is configured" 'echo "$out" | grep -q "#101 no §4 Merged-tree check is configured — merging without one" && echo "$out" | grep -q "#101 MERGED"'
check "AC4: the held ticket is released to triaged"                  '[ "$(qf T-3 .state)" = triaged ] && [ "$(qf T-3 .held_by)" = null ] && echo "$out" | grep -q "RELEASED T-3"'
check "AC4: the released ticket is at the front of the queue"        '[ "$(jq -r ".tickets | keys_unsorted | .[0]" "$DESK_QUEUE")" = T-3 ]'
check "the merge is recorded on the ticket and in the eta history"   '[ "$(qf T-1 .merged_at)" != null ] && [ "$(jq -r .key "$T/state/eta-history.jsonl")" = T-1 ] && [ "$(jq -r .merged_at "$T/state/eta-history.jsonl")" = "$(qf T-1 .merged_at)" ]'

# ---- loop 3: the second green PR merges ---------------------------------------------------------
loop
check "AC2: both green PRs merged within three loops, one per loop" '[ "$(merged)" = "101 102" ] && grep -qx "102 main $SHA2" "$T/merges.log"'
check "a merged ticket with no spawn record gets its merge time and no history line" '[ "$(qf T-2 .merged_at)" != null ] && [ "$(wc -l < "$T/state/eta-history.jsonl" | tr -d " ")" = 1 ] && echo "$out" | grep -q "no spawn record: T-2"'

# ---- pass.mjs: a release due with no driver running is released by the pass, as the driver would ---
q set T-3 state=done
q add T-6 Task A; q set T-6 state=triaged branch=fix/T-6; q hold T-6 T-2
pj
check "DS-397 AC4: every blocker merged and no driver running, the pass releases it, not the person" '[ "$(qf T-6 .state)" = triaged ] && [ "$(qf T-6 .held_by)" = null ] && [ "$(js ".release_due | length")" = 0 ] && ! js ".waiting[]" | grep -q "RELEASE DUE" && js .message | grep -q "^released: T-6, every blocker merged (T-2) and no merge driver is running; "'
check "DS-397 AC4: and moves it to the front of the spawn order"   '[ "$(jq -r ".tickets | keys_unsorted | .[0]" "$DESK_QUEUE")" = T-6 ]'

# ---- a lane C park held behind siblings loses each hold once that sibling's PR merges, and keeps its park ----
for k in L-1 L-2 L-3; do q add "$k" Task C; q set "$k" state=parked "branch=feat/$k" 'park={"question":"lane C — spans layers"}'; done
q set L-1 held_by=T-1; q set L-2 'held_by=T-1|T-4'; q set L-3 held_by=T-4
pj
check "DS-715 AC1: a lane C park held behind a merged sibling loses the hold and keeps its park, and the pass names the lift" \
  '[ "$(qf L-1 .held_by)" = null ] && [ "$(qf L-1 .state)" = parked ] && [ "$(qf L-1 .park.question)" = "lane C — spans layers" ] && js .message | grep -q "^hold lifted: L-1: T-1 merged, and it stays parked: lane C — spans layers"'
check "DS-715 AC3: held behind two siblings with one merged, held_by lists only the unmerged one" \
  '[ "$(qf L-2 .held_by)" = T-4 ] && [ "$(qf L-2 .state)" = parked ] && js .message | grep -q "^hold lifted: L-2: T-1 merged; still held behind T-4"'
check "DS-715 AC4: a sibling done but whose PR has not merged keeps the hold" '[ "$(qf L-3 .held_by)" = T-4 ] && ! js .message | grep -q "hold lifted: L-3"'
loop
check "DS-715 AC5: the merge driver sends no lifted lane C park to a worker" \
  '[ "$(qf L-1 .state)" = parked ] && [ "$(qf L-1 .park.question)" = "lane C — spans layers" ] && [ "$(qf L-2 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED L-"'
for k in L-1 L-2 L-3; do q drop "$k"; done

q drop T-6
q add T-9 Task A; q set T-9 state=triaged branch=fix/T-9; q hold T-9 T-2; q set T-9 open_questions=1
loop
check "the driver releases a ticket whose every blocker merged"     '[ "$(qf T-9 .state)" = triaged ] && echo "$out" | grep -q "RELEASED T-9"'
check "DS-189 AC3: the release line says a question is still open and it will not spawn" 'echo "$out" | grep "RELEASED T-9" | grep -q "still has 1 question(s) open and will not spawn until they are answered: answer with answer.mjs T-9"'

# ---- a blocker whose PR is older than the merged listing: the queue's record of the merge counts ----
# gh lists the newest 100 merged PRs, so an old PR (a long-lived draft merged today) is missing from it;
# the fake gh here never lists T-11's PR at all. T-13's blocker has no recorded merge and stays held.
q add T-11 Task A; q set T-11 state=done branch=fix/T-11 pr_status.pr=426; q merged T-11 2026-11-02T02:20:59.000Z
q add T-12 Task A; q set T-12 state=triaged branch=fix/T-12; q hold T-12 T-11
q add T-14 Task A; q set T-14 state=done branch=fix/T-14
q add T-13 Task A; q set T-13 state=triaged branch=fix/T-13; q hold T-13 T-14
loop
check "a blocker GitHub does not list but the queue records as merged releases its successor" '[ "$(qf T-12 .state)" = triaged ] && [ "$(qf T-12 .held_by)" = null ] && echo "$out" | grep -q "merged: T-11#426 -> RELEASED T-12"'
check "a blocker with no recorded merge and no merged PR still holds its successor" '[ "$(qf T-13 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-13"'
# A ticket the pass holds on its blocked-until date waits on that date, even where --deps names merged blockers.
q add T-15 Task A; q set T-15 state=triaged branch=fix/T-15
q park T-15 "held by orchestrator: blocked until 2099-01-01 (label blocked-until-2099-01-01) — starts on that date by itself"; q set T-15 held_label=blocked-until-2099-01-01
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2 T-4 T-5" --deps "T-15:T-11" 2>&1)
check "DS-555 a ticket held on its blocked-until date is not released by merged --deps blockers" '[ "$(qf T-15 .state)" = parked ] && [ "$(qf T-15 .held_label)" = blocked-until-2099-01-01 ] && ! echo "$out" | grep -q "RELEASED T-15"'
q set T-15 held_label=null
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2 T-4 T-5" --deps "T-15:T-11" 2>&1)
check "DS-555 the same hold with no blocked-until label is released by those blockers" '[ "$(qf T-15 .state)" = triaged ] && echo "$out" | grep -q "RELEASED T-15"'
q set T-15 state=done
# DS-742: a ticket queue.mjs stop held waits on the person, even where --deps names merged blockers.
q add T-17 Task A; q set T-17 state=triaged branch=fix/T-17
q park T-17 "$(node --input-type=module -e "import { STOPPED_PREFIX } from '$B/batch-state.mjs'; process.stdout.write(STOPPED_PREFIX)") at 2026-11-17T00:00:00Z; its work so far is nothing to commit (clean). Starts again only once you let it"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2 T-4 T-5" --deps "T-17:T-11" 2>&1)
check "DS-742 a ticket queue.mjs stop held is not released by merged --deps blockers" '[ "$(qf T-17 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-17"'
q set T-17 state=done
# A lane C park held behind a blocker that has merged keeps its own park: no release sends it to a worker.
q add T-16 Task C; q set T-16 state=triaged branch=fix/T-16; q park T-16 "lane C — needs a plan"; q hold T-16 T-11
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2 T-4 T-5" --deps "T-16:T-11" 2>&1)
check "DS-714 AC5: a lane C park held behind a merged blocker is not released to a worker" \
  '[ "$(qf T-16 .state)" = parked ] && [[ "$(qf T-16 .park.question)" == "lane C"* ]] && [ "$(qf T-16 .held_by)" = T-11 ] && ! echo "$out" | grep -q "RELEASED T-16"'
q drop T-16
q drop T-11; q drop T-12; q drop T-13; q drop T-14
check "AC3: the red PR is never merged"                              '! grep -q "^104 " "$T/merges.log" && echo "$out" | grep -q "#104 red"'
check "AC5: every merge went into the default branch"                '[ "$(cut -d" " -f2 "$T/merges.log" | sort -u)" = main ]'
check "AC5: a PR on another base is never the batch'\''s"            '! grep -q "^105 " "$T/merges.log" && ! echo "$out" | grep -q "#105"'

# A collision chain as plan-batch seeds it, each ticket held behind every one before it, releases in order.
q add T-21 Task A; q set T-21 state=done branch=fix/T-21 pr_status.pr=431; q merged T-21 2026-11-02T03:00:00.000Z
for k in T-22 T-23; do q add "$k" Task A; q set "$k" state=triaged "branch=fix/$k"; done
q hold T-22 T-21; q hold T-23 T-21 T-22
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2 T-4 T-5" --deps "T-22:T-21 T-23:T-21,T-22" 2>&1)
check "DS-793 AC2: the chain's head merged releases the second ticket, and the third stays behind it" \
  '[ "$(qf T-22 .state)" = triaged ] && echo "$out" | grep -q "merged: T-21#431 -> RELEASED T-22" && [ "$(qf T-23 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-23"'
q set T-22 state=done pr_status.pr=432; q merged T-22 2026-11-02T04:00:00.000Z
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2 T-4 T-5" --deps "T-22:T-21 T-23:T-21,T-22" 2>&1)
check "DS-793 AC2: the second merged releases the third" '[ "$(qf T-23 .state)" = triaged ] && echo "$out" | grep -q "merged: T-21#431 T-22#432 -> RELEASED T-23"'
q drop T-21; q drop T-22; q drop T-23

# ---- a feature spine: only an approved spine releases, and approved it merges like any other ------
SHA7=7777777777777777777777777777777777777777
jq --arg s "$SHA7" '. + { "107": { head: "fix/T-7", base: "main", sha: $s, state: "merged", draft: true, checks: [["test", "SUCCESS"]] } }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
q add T-7 Task A; q set T-7 branch=fix/T-7 state=done result.pr=107 'spine_check={"ok":true,"problems":[]}'
q park T-7 "spine awaiting approval: PR #107"
q add T-8 Task A; q set T-8 state=triaged branch=fix/T-8; q hold T-8 T-7
q set-batch feature=true spine=T-7
loop
check "a spine PR merged without approval releases nothing"          '[ "$(qf T-8 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-8"'
jq '."107".state = "open"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
loop
check "the spine's draft PR is not merged before approval"           '! grep -q "^107 " "$T/merges.log" && echo "$out" | grep -q "draft (still reviewing): #107"'
out=$(node "$B/queue.mjs" approve T-7 2>&1); rc=$?
check "approve undrafts the spine PR and hands it to the merge driver, exit 0" '[ $rc -eq 0 ] && [ "$(qf T-7 .state)" = done ] && [ "$(jq -r ".\"107\".draft" "$T/prs.json")" = false ] && echo "$out" | grep -q "the merge driver merges PR #107 once it is green; T-8 is released once it merges"'
loop; loop
check "the approved spine merges, pinned, and its child is released" 'grep -qx "107 main $SHA7" "$T/merges.log" && [ "$(qf T-8 .state)" = triaged ] && echo "$out" | grep -q "RELEASED T-8"'

# ---- one loop with nothing ready, and one whose PR list fails -----------------------------------
echo '{}' > "$T/prs.json"
loop
check "AC1: a loop with no ready PRs exits 0 without sleeping"       '[ $rc -eq 0 ] && [ ! -e "$T/sleeps" ] && echo "$out" | grep -q "no ready batch PRs$"'
# A driver told to stop in its pause stops then, not once the sleep is out: this sleep asks it to stop,
# then sleeps on for 30s.
mkdir -p "$T/slowstub"
cat > "$T/slowstub/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_SLEEPS"
kill -TERM "$PPID"
exec /bin/sleep 30
EOF
chmod +x "$T/slowstub/sleep"
began=$SECONDS
out=$(PATH="$T/slowstub:$PATH" MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2 T-4 T-5" 2>&1); rc=$?
took=$((SECONDS - began))
check "DS-525 AC3: a stop during the pause ends the driver at once"   '[ $rc -eq 143 ] && [ $took -lt 15 ] && grep -qx 60 "$T/sleeps" && echo "$out" | grep -q "merge driver exited 143$"'
rm -f "$T/sleeps"
cat > "$T/prs.json" <<EOF
{
  "131": { "head": "fix/T-1", "base": "release", "sha": "$SHA1", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "132": { "head": "fix/T-2", "base": "release", "sha": "$SHA2", "state": "open", "draft": true,  "checks": [["test", "SUCCESS"]] },
  "133": { "head": "fix/other", "base": "release", "sha": "$SHA4", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
loop
check "DS-313 AC2: batch PRs open on another base are named with their base, not just 'no ready'" '[ $rc -eq 0 ] && echo "$out" | grep -q "no ready batch PRs on main, the only base this driver watches; batch PRs open on another base: #131 (T-1) on release, #132 (T-2) on release$"'
check "DS-313 AC2: a PR that is not the batch'\''s is not named, and nothing merges" '! echo "$out" | grep -q "#133" && ! grep -qE "^13[123] " "$T/merges.log"'
echo 'not json' > "$T/prs.json"
loop
check "AC1: a loop that cannot list PRs exits 1 without sleeping"    '[ $rc -eq 1 ] && [ ! -e "$T/sleeps" ] && echo "$out" | grep -q "could not list PRs"'

# ---- --log: the driver appends its own output, so it is started with no shell redirect -----------
echo '{}' > "$T/prs.json"
echo "earlier run" > "$T/state/merge-driver.log"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1" --log 2>&1); rc=$?
check "--log: nothing on the terminal, the loop appended to <state>/merge-driver.log" '[ $rc -eq 0 ] && [ -z "$out" ] && [ "$(head -n 1 "$T/state/merge-driver.log")" = "earlier run" ] && grep -q "merge driver up" "$T/state/merge-driver.log" && grep -q "no ready batch PRs" "$T/state/merge-driver.log"'
out=$(bash "$B/merge-driver.sh" --tickets "T-1" --log "$T/elsewhere.log" 2>&1); rc=$?
check "--log takes no path: one is a usage error on the terminal, and nothing is written there" '[ $rc -eq 2 ] && echo "$out" | grep -q "\[--log\]" && [ ! -e "$T/elsewhere.log" ]'

# ---- DS-759: a driver running several loops logs a PR's state only when it changes, and rotates --
# This sleep lets the driver loop on: after loop <n> it runs $T/between.<n> where there is one, and it
# stops the driver after loop $FAKE_LOOPS.
mkdir -p "$T/loopstub"
cat > "$T/loopstub/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_SLEEPS"
n=$(wc -l < "$FAKE_SLEEPS" | tr -d ' ')
if [ -x "$FAKE_BETWEEN.$n" ]; then "$FAKE_BETWEEN.$n"; fi
if [ "$n" -ge "$FAKE_LOOPS" ]; then kill -TERM "$PPID"; fi
EOF
chmod +x "$T/loopstub/sleep"
loops(){ rm -f "$T/sleeps"; out=$(PATH="$T/loopstub:$PATH" FAKE_LOOPS="$1" FAKE_BETWEEN="$T/between" MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-2 T-4" "${@:2}" 2>&1); rc=$?; }
prs759(){ cat > "$T/prs.json" <<EOF
{
  "102": { "head": "fix/T-2", "base": "main", "sha": "$SHA2", "state": "open", "draft": true,  "checks": [["test", "SUCCESS"]] },
  "104": { "head": "fix/T-4", "base": "main", "sha": "$SHA4", "state": "open", "draft": false, "checks": [["test", "SUCCESS"], ["lint", "$1"]] }
}
EOF
}
prs759 SUCCESS; mv "$T/prs.json" "$T/prs-green.json"
prs759 FAILURE
printf '#!/bin/sh\ncp "%s/prs-green.json" "%s/prs.json"\n' "$T" "$T" > "$T/between.2"
chmod +x "$T/between.2"
loops 3
check "DS-759 AC5: a PR whose state is unchanged is logged once over two loops" '[ $rc -eq 143 ] && [ "$(grep -c "#104 red at 444444444: \"lint\" failure" <<< "$out")" = 1 ] && [ "$(grep -c "draft (still reviewing): #102" <<< "$out")" = 1 ]'
check "DS-759 AC6: once its state changes, the PR gets one line for the new state" '[ "$(grep -c "#104 green at 444444444" <<< "$out")" = 1 ] && [ "$(grep -n "#104 green" <<< "$out" | cut -d: -f1)" -gt "$(grep -n "#104 red" <<< "$out" | tail -1 | cut -d: -f1)" ]'
check "DS-759: the run'\''s record of what it logged goes with it" '[ -z "$(find "$T/state/merge-driver" -name "said.*" 2>/dev/null)" ]'
rm -f "$T/between.2"
prs759 FAILURE
# Limits sized so the first loop's lines take the log over and the second's do not.
{ echo "earlier run"; printf 'old line %s\n' $(seq 1 60); } > "$T/state/merge-driver.log"; rm -f "$T/state/merge-driver.log".[1-4]
DESK_LOG_ROTATE_BYTES=1000 loops 2 --log
check "DS-759 AC3: a log that passes the limit mid-run is kept as merge-driver.log.1, and the next loop writes a new one" '[ $rc -eq 143 ] && [ -z "$out" ] && [ "$(head -n 1 "$T/state/merge-driver.log.1")" = "earlier run" ] && grep -q "merge driver up" "$T/state/merge-driver.log.1" && ! grep -q "merge driver up" "$T/state/merge-driver.log" && grep -q "merge driver exited 143$" "$T/state/merge-driver.log"'
printf 'old line %s\n' $(seq 1 200) > "$T/state/merge-driver.log"; echo copy1 > "$T/state/merge-driver.log.1"; echo copy2 > "$T/state/merge-driver.log.2"; echo copy3 > "$T/state/merge-driver.log.3"
MERGE_DRIVER_ONE_LOOP=1 DESK_LOG_ROTATE_BYTES=2000 bash "$B/merge-driver.sh" --tickets "T-2 T-4" --log >/dev/null 2>&1
check "DS-759 AC2: a driver starting on a full log rotates it first, dropping the oldest of three copies" '[ "$(cat "$T/state/merge-driver.log.3")" = copy2 ] && [ "$(cat "$T/state/merge-driver.log.2")" = copy1 ] && grep -q "old line" "$T/state/merge-driver.log.1" && [ ! -e "$T/state/merge-driver.log.4" ] && grep -q "merge driver up" "$T/state/merge-driver.log"'
rm -f "$T/state/merge-driver.log".[1-4] "$T/sleeps"
# A second start while a driver holds the lock leaves the running driver's full log where it is.
printf 'old line %s\n' $(seq 1 200) > "$T/state/merge-driver.log"
/bin/sleep 60 & holder=$!
mkdir "$T/state/merge-driver.lock.d"; echo "$holder" > "$T/state/merge-driver.lock.d/pid"
MERGE_DRIVER_ONE_LOOP=1 DESK_LOG_ROTATE_BYTES=2000 bash "$B/merge-driver.sh" --tickets "T-2 T-4" --log >/dev/null 2>&1; rc=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null; rm -rf "$T/state/merge-driver.lock.d"
check "DS-759: a start that loses the lock does not rotate the running driver's log" '[ $rc -eq 1 ] && [ ! -e "$T/state/merge-driver.log.1" ] && grep -q "old line 200" "$T/state/merge-driver.log" && grep -q "another merge driver is running" "$T/state/merge-driver.log"'
# A driver whose log something else moved writes its next loop to a new merge-driver.log.
rm -f "$T/state/merge-driver.log"
printf '#!/bin/sh\nmv "%s/state/merge-driver.log" "%s/state/moved.log"\n' "$T" "$T" > "$T/between.1"; chmod +x "$T/between.1"
loops 2 --log
check "DS-759: a driver whose log was moved re-opens merge-driver.log on its next loop" '[ $rc -eq 143 ] && grep -q "merge driver up" "$T/state/moved.log" && grep -q "merge driver exited 143$" "$T/state/merge-driver.log" && ! grep -q "merge driver exited" "$T/state/moved.log"'
rm -f "$T/between.1" "$T/state/moved.log" "$T/state/merge-driver.log" "$T/sleeps"

# ---- DS-810: the driver's lock names the release it runs from, not the installed one --------------
# A desk home with one release, old0, holding a copy of these scripts, while installed.json names new1.
# The PR list hook reads the lock's version while the driver holds it.
RH="$T/relhome"; mkdir -p "$RH/releases/old0"; cp -R "$B" "$RH/releases/old0/bin"; cp -R "$SRC/desk/templates" "$RH/releases/old0/templates"
printf '{"commit":"old0","release":"old0"}\n' > "$RH/releases/old0/release.json"
printf '{"commit":"new1"}\n' > "$RH/installed.json"
echo '{}' > "$T/prs.json"
printf 'cp "%s/state/merge-driver.lock.d/version" "%s/seen-version"\n' "$T" "$T" > "$T/gh.atlist"
out=$(DESK_HOME="$RH" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$RH/releases/old0/bin/merge-driver.sh" --tickets "T-1" 2>&1); rc=$?
check "DS-810 AC1: a driver started from an older release writes that release's commit into its lock, not the installed one" '[ $rc -eq 0 ] && [ "$(cat "$T/seen-version" 2>/dev/null)" = old0 ]'

# ---- DS-796: a PR built outside its worker is recorded on its ticket, with GitHub's merge time -----
# T-31 is triaged, its worker never started, and PR #131, opened on its branch by a session, merges.
# A ticket done with its merge recorded may be archived, so it is read with queue.mjs get.
qg(){ node "$B/queue.mjs" get "$1" 2>/dev/null | jq -r "$2"; }
SHA31=3131313131313131313131313131313131313131
cat > "$T/prs.json" <<EOF
{ "131": { "head": "fix/T-31", "base": "main", "sha": "$SHA31", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]], "mergedAt": "2026-11-18T11:40:02Z" } }
EOF
q add T-31 Task A; q set T-31 state=triaged branch=fix/T-31
for i in 1 2; do out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-31" 2>&1); done
check "DS-796 AC1: the merge records the PR on the ticket and GitHub's mergedAt as its merge time" \
  'grep -q "^131 main " "$T/merges.log" && [ "$(qg T-31 .result.pr)" = 131 ] && [ "$(qg T-31 .merged_at)" = 2026-11-18T11:40:02.000Z ]'
check "DS-796 AC1: and the ticket is done, shipped outside its worker, so no worker is started for it" \
  '[ "$(qg T-31 .state)" = done ] && [ "$(qg T-31 .result.summary)" = "shipped outside its worker: PR #131 merged by the merge driver" ]'
# T-32's own worker opened PR #132 and parked: the merge records its time and leaves the ticket as its
# worker left it, for the pass to send back for its after-merge steps.
cat > "$T/prs.json" <<EOF
{ "132": { "head": "fix/T-32", "base": "main", "sha": "$SHA31", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] } }
EOF
q add T-32 Task A; q set T-32 state=parked branch=fix/T-32 draft_pr=132 'park={"question":"Stage 8: comment"}'
for i in 1 2; do out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-32" 2>&1); done
check "DS-796: a ticket that records its own PR keeps its state, and gh's unset time falls back to the driver's clock" \
  'grep -q "^132 main " "$T/merges.log" && [ "$(qg T-32 .state)" = parked ] && [ "$(qg T-32 .result.pr)" = null ] && [ "$(qg T-32 .merged_at)" != null ]'

finish loop
