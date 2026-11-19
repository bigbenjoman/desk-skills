#!/usr/bin/env bash
# suite: merge driver: repaired PRs first and the merged-tree check (offline, fake gh)
# The real merge-driver.sh and gate.mjs, one loop at a time, set up by merge_driver_setup.sh: a
# repaired PR merges before a ready PR changing the same file, and §4 Merged-tree check holds a PR (or
# an epic PR) whose merge would break the tree (base-sync.mjs's prTreeCheck, and pass.mjs's fix try).
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

# ---- a repaired PR merges before a ready PR changing the same file; the hold ends itself ------------
SHAR=abcabcabcabcabcabcabcabcabcabcabcabcabc1; SHAP=abcabcabcabcabcabcabcabcabcabcabcabcabc2
HEADR=dddddddddddddddddddddddddddddddddddddddd
rploop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-401 T-402" 2>&1); rc=$?; }
# rp_setup <repaired draft> <repaired check> <finished ms ago> <ready PR files> [<repaired head recorded>]
rp_setup(){
  local at; at=$("$NODE" -p "new Date(Date.now()-$3).toISOString()")
  : > "$T/merges.log"
  find "$T/state" \( -name 'green-41*' -o -name 'dirty-41*' -o -name 'repaired-41*' \) -delete
  q init repaired
  cat > "$T/prs.json" <<EOF
{
  "411": { "head": "fix/T-401", "base": "main", "sha": "$SHAP", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]], "files": $4 },
  "412": { "head": "fix/T-402", "base": "main", "sha": "$SHAR", "state": "open", "draft": $1, "checks": [["test", "$2"]], "files": ["src/shared.txt"] }
}
EOF
  q add T-401 Task A; q set T-401 branch=fix/T-401 state=done result.pr=411
  q add T-402 Task A; q set T-402 branch=fix/T-402 state=done result.pr=412
  q set T-402 "fix_tries=[{\"try\":1,\"head\":\"${5:-$HEADR}\",\"kind\":\"conflict\",\"at\":\"$at\",\"finished\":\"$at\"}]"
}
SHARED='["src/shared.txt"]'
rp_setup false SUCCESS 0 "$SHARED"; rploop; rploop
check "AC1 two ready PRs sharing a file: the repaired one, with the higher number, merges first" '[ "$(merged)" = 412 ] && echo "$out" | grep -q "#411 HELD: it changes src/shared.txt, as repaired #412 (T-402) does"'
rp_setup true SUCCESS 0 "$SHARED"; rploop; rploop
check "AC2 a ready PR behind a repaired PR not yet ready is not merged and names it" '[ -z "$(merged)" ] && echo "$out" | grep -q "#411 HELD: it changes src/shared.txt, as repaired #412"'
rp_setup true SUCCESS 7200000 "$SHARED"; rploop; rploop
check "AC3 past 60 minutes the hold ends, logged, and the ready PR merges" '[ "$(merged)" = 411 ] && echo "$out" | grep -q "#411 hold behind repaired #412 (T-402) ended: 60 minutes since its repair"'
rp_setup false FAILURE 0 "$SHARED"; rploop; rploop
check "AC4 behind a red repaired PR the ready PR merges" '[ "$(merged)" = 411 ] && echo "$out" | grep -q "ended: it is red"'
rp_setup true SUCCESS 0 "$SHARED"; q set T-402 state=parked; rploop; rploop
check "AC4 behind a parked repaired PR the ready PR merges" '[ "$(merged)" = 411 ] && echo "$out" | grep -q "ended: it is parked or stuck"'
rp_setup false SUCCESS 0 '["src/other.txt"]'; rploop; rploop
check "AC5 sharing no file, the ready PR merges in its usual order" '[ "$(merged)" = 411 ] && ! echo "$out" | grep -q "HELD"'
rp_setup true SUCCESS 0 "$SHARED" "$SHAR"; rploop; rploop
check "a repair that never moved the head holds nothing" '[ "$(merged)" = 411 ]'
rp_setup true SUCCESS 0 "$SHARED"; jq '."412".mergeState = "DIRTY"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"; rploop; rploop
check "AC2 a repaired PR back in conflict is not ready, so the ready PR still waits for it" '[ -z "$(merged)" ] && echo "$out" | grep -q "#411 HELD: it changes src/shared.txt, as repaired #412"'
AT0=$("$NODE" -p "new Date().toISOString()")
rp_setup true SUCCESS 0 "$SHARED"; q set T-402 "fix_tries=[{\"try\":1,\"head\":\"$HEADR\",\"kind\":\"conflict\",\"at\":\"$AT0\",\"finished\":\"$AT0\"},{\"try\":2,\"head\":\"$SHAR\",\"kind\":\"conflict\",\"at\":\"$AT0\"}]"; rploop; rploop
check "AC2 while a second repair runs, the first finished one still holds the ready PR" '[ -z "$(merged)" ] && echo "$out" | grep -q "#411 HELD: it changes src/shared.txt, as repaired #412"'
# The driver reads #412 DIRTY at the old head, then a person pushes the repair.
pr412(){ jq --arg s "$1" --arg m "${2:-}" '."412".sha = $s | if $m == "DIRTY" then ."412".mergeState = "DIRTY" else del(."412".mergeState) end' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"; }
hand_repair(){ pr412 "$HEADR" DIRTY; rploop; pr412 "$SHAR"; }
rp_setup false SUCCESS 7200000 "$SHARED"; hand_repair; rploop; rploop
check "AC1 a hand repair long after desk's last try: the repaired PR merges first" '[ "$(merged)" = 412 ] && echo "$out" | grep -q "#411 HELD: it changes src/shared.txt, as repaired #412"'
rp_setup true SUCCESS 0 "$SHARED"; q set T-402 'fix_tries=[]'; hand_repair; rploop; rploop
check "AC2 a hand repair with no desk try holds the ready PR" '[ -z "$(merged)" ] && echo "$out" | grep -q "#411 HELD: it changes src/shared.txt, as repaired #412"'
rp_setup true SUCCESS 7200000 "$SHARED"; q set T-402 "stuck={\"why\":\"still in conflict\",\"head\":\"$HEADR\"}"; hand_repair; rploop; rploop
check "AC2 a stuck record of the head that was in conflict does not end a hand repair's hold" '[ -z "$(merged)" ] && echo "$out" | grep -q "#411 HELD"'
rp_setup true SUCCESS 7200000 "$SHARED"; q set T-402 "stuck={\"why\":\"red\",\"head\":\"$SHAR\"}"; hand_repair; rploop
check "AC4 stuck again at the repaired head, the hold ends" '[ "$(merged)" = 411 ] && echo "$out" | grep -q "ended: it is parked or stuck"'
rp_setup true SUCCESS 7200000 "$SHARED"; hand_repair; rploop; printf '%s\t%s\n' "$(( $(date +%s) - 7200 ))" "$HEADR" > "$(find "$T/state" -name repaired-412)"; rploop
check "AC3 a hand repair's hold ends 60 minutes after it was seen" '[ "$(merged)" = 411 ] && echo "$out" | grep -q "ended: 60 minutes since its repair"'
rp_setup true SUCCESS 0 "$SHARED" "$SHAR"; q set T-402 'fix_tries=[]'; pr412 "$SHAR" DIRTY; rploop; pr412 "$SHAR"; rploop; rploop
check "out of DIRTY with no new push (the base moved): no repair, no hold" '[ "$(merged)" = 411 ]'

# ---- §4 Merged-tree check: two green PRs that each add the next migration revision ------------------
# Each adds a migration numbered 131 on top of main's 130, under its own filename: git merges both
# cleanly and GitHub says neither is BEHIND, so only the check sees the second leaves two heads.
write_rv_config
git init -q --bare "$T/tc-origin.git"
git -C "$T/repo" remote add origin "$T/tc-origin.git" 2>/dev/null || git -C "$T/repo" remote set-url origin "$T/tc-origin.git"
WT_BEFORE=$(git -C "$T/repo" worktree list | wc -l | tr -d ' ')
mkdir -p "$T/repo/migrations"; echo base > "$T/repo/migrations/130_base.py"
git -C "$T/repo" add migrations; git -C "$T/repo" commit -q -m m130; git -C "$T/repo" push -q origin main
TCMAIN=$(git -C "$T/repo" rev-parse HEAD)
tc_branch(){ # tc_branch <branch> <file> -> its head sha
  git -C "$T/repo" switch -q -c "$1" "$TCMAIN"; echo x > "$T/repo/migrations/$2"
  git -C "$T/repo" add migrations; git -C "$T/repo" commit -q -m "$2"; git -C "$T/repo" push -q origin "$1"
  git -C "$T/repo" rev-parse HEAD; git -C "$T/repo" switch -q main
}
SHA501=$(tc_branch fix/T-501 131_add_ai_model_data.py); SHA502=$(tc_branch fix/T-502 131_add_waitlist_invitations.py)
printf 'echo run >> %s\n' "$T/tc-runs" > "$T/tc-check.sh"
cat >> "$T/tc-check.sh" <<'EOF'
d=$(ls migrations 2>/dev/null | cut -d_ -f1 | sort | uniq -d)
[ -z "$d" ] && exit 0
touch stray.tmp; echo "Multiple head revisions are present: $d"; exit 1
EOF
HOLDS_ROW='| Merge holds | `none` |'; READY_ROW='| `pr-ready` | Undraft | `yes` | `yes` |'
conflict_rows(){ printf '%s\n| `pr-conflict-unreviewed` | Conflicts | `yes` | `%s` |\n| `pr-conflict-reviewed` | Conflicts | `yes` | `%s` |' "$READY_ROW" "$1" "$1"; }
TC=$(cat "$T/config.md"); TC=${TC/"$HOLDS_ROW"/"$HOLDS_ROW"$'\n'"| Merged-tree check | \`sh $T/tc-check.sh\` |"}
printf '%s\n' "$TC" > "$T/config-tc.md"
ROWS=$(conflict_rows yes); TCF=${TC/"$READY_ROW"/$ROWS}; printf '%s\n' "$TCF" > "$T/config-tc-fix.md"
ROWS=$(conflict_rows no); TCF=${TC/"$READY_ROW"/$ROWS}; printf '%s\n' "$TCF" > "$T/config-tc-no.md"
tcloop(){ out=$(DESK_CONFIG="${TC_CONFIG:-$T/config-tc.md}" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-501 T-502" 2>&1); rc=$?; }
: > "$T/merges.log"; q init tree-check
cat > "$T/prs.json" <<EOF
{
  "501": { "head": "fix/T-501", "base": "main", "sha": "$SHA501", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "502": { "head": "fix/T-502", "base": "main", "sha": "$SHA502", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
for k in T-501 T-502; do q add "$k" Task A; q set "$k" "branch=fix/$k" state=done "result.pr=50${k#T-50}"; done
tcloop; tcloop
check "DS-552: the first PR merges once its merged tree passes the check, which it says" '[ "$(merged)" = 501 ] && echo "$out" | grep -q "#501 merged into main at ${TCMAIN:0:9}, it passes §4 Merged-tree check"'
# GitHub's merge of #501 lands on origin's main.
git -C "$T/repo" push -q origin "$SHA501:refs/heads/main"
tcloop
check "DS-552 AC1: the second PR is not merged, and the log names the failed merged-tree check" \
  '[ "$(merged)" = 501 ] && echo "$out" | grep -q "#502 HELD: merged into main at ${SHA501:0:9}, it fails the merged-tree check \`sh $T/tc-check.sh\`: Multiple head revisions are present: 131 — not merging"'
check "DS-552 AC1: the hold is on the ticket for the pass, with the head and the check's output, not as merge_blocked" \
  '[ "$(qf T-502 .tree_check.head)" = "$SHA502" ] && [ "$(qf T-502 .tree_check.output)" = "Multiple head revisions are present: 131" ] && [ "$(qf T-502 .tree_check.base_sha)" = "$SHA501" ] && [ "$(qf T-502 .merge_blocked)" = null ]'
check "DS-552: the throwaway checkout is gone and the repo's worktrees are as they were" \
  '[ -z "$(find "$T/state" -name "tree-502-checkout")" ] && [ "$(git -C "$T/repo" worktree list | wc -l | tr -d " ")" = "$WT_BEFORE" ] && [ -z "$(git -C "$T/repo" status --porcelain)" ]'
: > "$T/tc-runs"; tcloop
check "DS-552: held at the same head and base, the next loop reads its kept result, runs no check and still does not merge" \
  '[ "$(merged)" = 501 ] && echo "$out" | grep -q "#502 HELD: merged into main" && [ ! -s "$T/tc-runs" ] && [ "$(find "$T/state" -name "tree-502-$SHA502-$SHA501-*.json" | wc -l | tr -d " ")" = 1 ]'
# A changed §4 row is not answered from the old row's kept result.
TCR=$(cat "$T/config.md"); TCR=${TCR/"$HOLDS_ROW"/"$HOLDS_ROW"$'\n'"| Merged-tree check | \`sh $T/tc-check.sh again\` |"}
printf '%s\n' "$TCR" > "$T/config-tc-row.md"
TC_CONFIG="$T/config-tc-row.md" tcloop
check "DS-552: a changed §4 Merged-tree check row runs the check again" '[ -s "$T/tc-runs" ] && echo "$out" | grep -q "#502 HELD: merged into main"'
# A check that timed out or never started says nothing about the tree: held this loop, not kept, not on the ticket.
q set T-502 tree_check=null
KEPT=$(find "$T/state" -name "tree-502-*.json" | wc -l | tr -d ' ')
STOP=$(DESK_CONFIG="$T/config-tc.md" node --input-type=module -e "
import { prTreeCheck } from '$B/base-sync.mjs';
const check = () => ({ command: 'sh slow.sh', output: 'it did not finish in 300s', stopped: true }); check.row = 'sh slow.sh';
console.log(JSON.stringify(prTreeCheck({ repo: '$T/repo', cache: '$T/state', dir: '$T/tc-stop-checkout', base: 'main', pr: 502, head: '$SHA502', check })));")
check "DS-552: a check that did not finish is an error, never a failure, and is not kept" \
  '[ "$(printf "%s" "$STOP" | jq -r .result)" = error ] && printf "%s" "$STOP" | jq -r .why | grep -q "did not finish" && [ "$(find "$T/state" -name "tree-502-*.json" | wc -l | tr -d " ")" = "$KEPT" ] && [ ! -e "$T/tc-stop-checkout" ]'
tcloop

# The pass: the held PR goes to a fix worker as a conflict does, with the check's output, and not to the person.
tcpass(){ out=$(DESK_CONFIG="$1" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off node "$B/pass.mjs" --json 2>/dev/null); rc=$?; }
cp "$DESK_QUEUE" "$T/tc-queue.json"
tcpass "$T/config-tc-fix.md"
check "DS-552 AC2: the next pass requeues the held PR for a merged-tree fix try" \
  'js .message | grep -q "fix try 1 of 2: T-502 requeued for PR #502 — fails §4 Merged-tree check merged into main" && [ "$(qf T-502 .fix.kind)" = conflict ] && [ "$(qf T-502 .fix.check.output)" = "Multiple head revisions are present: 131" ]'
check "DS-552 AC2: and it is not shown to the person" '! js ".waiting[], .stuck[]?" | grep -q "T-502"'
cp "$T/tc-queue.json" "$DESK_QUEUE"
tcpass "$T/config-tc-no.md"
check "DS-552: where §3 forbids a conflict worker, the person is told, naming the check" \
  'js ".waiting[]" | grep -q "^T-502: CONFLICT — PR #502 is out of draft and merged into main, fails §4 Merged-tree check \`sh $T/tc-check.sh\`, and config §3 pr-conflict-" && [ "$(qf T-502 .fix)" = null ]'
cp "$T/tc-queue.json" "$DESK_QUEUE"

# The fix worker renumbers its migration after main's and pushes: the new head passes, merges and clears the hold.
git -C "$T/repo" switch -q fix/T-502; git -C "$T/repo" merge -q --no-edit "$SHA501"
git -C "$T/repo" mv migrations/131_add_waitlist_invitations.py migrations/132_add_waitlist_invitations.py
git -C "$T/repo" commit -q -m renumber; SHA502B=$(git -C "$T/repo" rev-parse HEAD); git -C "$T/repo" push -q origin fix/T-502; git -C "$T/repo" switch -q main
jq --arg s "$SHA502B" '."502".sha = $s' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
tcloop; tcloop
check "DS-552: renumbered, the PR merges and its hold is cleared" '[ "$(merged)" = "501 502" ] && [ "$(qf T-502 .tree_check)" = null ]'

# The epic PR too: main gained #501's migration since its base feat/TC last synced, so its merge is held.
git -C "$T/repo" switch -q -c feat/TC "$TCMAIN"; echo x > "$T/repo/migrations/131_epic_child.py"
git -C "$T/repo" add migrations; git -C "$T/repo" commit -q -m epic-child; git -C "$T/repo" push -q origin feat/TC
SHAEP=$(git -C "$T/repo" rev-parse HEAD); git -C "$T/repo" switch -q main
RVTC=$(cat "$T/config-rv.md"); RVTC=${RVTC/"$HOLDS_ROW"/"$HOLDS_ROW"$'\n'"| Merged-tree check | \`sh $T/tc-check.sh\` |"}
printf '%s\n' "$RVTC" > "$T/config-rv-tc.md"
vp 601 "$SHAEP" "$CLEAN"
: > "$T/merges.log"; : > "$T/gh.log"; rm -f "$SD"/green-*; q init tree-check-epic
q set-batch base=feat/TC epic=T-600 feature=false 'promotion={"pr":601}'
q add T-61 Story A; q set T-61 branch=fix/T-61 state=done result.pr=610 merged_at=2026-11-06T10:00:00Z
jq -n --arg s "$SHAEP" --arg pl "$T/vp-601.json" \
  '{ "601": { head: "feat/TC", base: "main", sha: $s, state: "open", draft: false, title: "T-600: promote feat/TC to main", payload: $pl, checks: [["test", "SUCCESS"]] } }' > "$T/prs.json"
RV_TICKETS="T-61"; RV_CONFIG="$T/config-rv-tc.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-552: an epic PR whose merge into main fails the merged-tree check is held" \
  '[ -z "$(merged)" ] && echo "$out" | grep -q "#601 HELD: merged into main at ${SHA501:0:9}, it fails the merged-tree check \`sh $T/tc-check.sh\`: Multiple head revisions are present: 131 — not merging; noted on the batch'"'"'s promotion for the person"'
check "DS-552: and the hold is noted on the queue's promotion, which the pass reports, not left in the log alone" \
  '[ "$(jq -r .promotion.merge_blocked "$DESK_QUEUE")" = "merged-tree check: merged into main at ${SHA501:0:9}, it fails the merged-tree check \`sh $T/tc-check.sh\`: Multiple head revisions are present: 131" ]'
# The base renumbers its migration after main's: the epic PR passes, its note is cleared and it merges.
git -C "$T/repo" switch -q feat/TC; git -C "$T/repo" merge -q --no-edit "$SHA501"
git -C "$T/repo" mv migrations/131_epic_child.py migrations/132_epic_child.py; git -C "$T/repo" commit -q -m renumber
SHAEP=$(git -C "$T/repo" rev-parse HEAD); git -C "$T/repo" push -q origin feat/TC; git -C "$T/repo" switch -q main
vp 601 "$SHAEP" "$CLEAN"; jq --arg s "$SHAEP" '."601".sha = $s' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
RV_CONFIG="$T/config-rv-tc.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-552: renumbered, the epic PR passes, its note is cleared and it merges" '[ "$(merged)" = 601 ] && [ "$(jq -r .promotion.merge_blocked "$DESK_QUEUE")" = null ]'

finish tree
