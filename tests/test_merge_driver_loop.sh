#!/usr/bin/env bash
# suite: merge driver: loops, releases and its log (offline, fake gh)
# layer: L3
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
ml101=$(node "$B/merge-log.mjs" show --repo acme/widgets --pr 101 --latest)
check "DS-835 AC1: the merged entry names the PR, its head, the ticket and the merge driver" \
  '[ "$(jq -r "[.event, .pr, .sha, .ticket, .repo] | join(\" \")" <<< "$ml101")" = "merged 101 $SHA1 T-1 acme/widgets" ] && jq -e ".by | startswith(\"merge-driver \")" <<< "$ml101" >/dev/null'
check "DS-835 AC3: the reader gives the latest entry back with its time" 'jq -e ".at | test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}T\")" <<< "$ml101" >/dev/null && ! echo "$out" | grep -q "merge not written to the merge log"'

check "DS-899 AC1: the ticket's merge record names the driver, the PR, the head it merged at and the base, which desk-q shows" \
  '[ "$(qf T-1 ".merge | [.pr, .head_sha, .base] | map(tostring) | join(\" \")")" = "101 $SHA1 main" ] && [ "$(qf T-1 .merge.by)" = "$(jq -r .by <<< "$ml101")" ] && [ "$(qf T-1 .merge.at)" = "$(qf T-1 .merged_at)" ]'
# With the ledger lever on, the driver's write of that record is one merged event and no legacy one.
d899=$(node --input-type=module -e "import { readFileSync } from 'node:fs'; import { queueEvents } from '$B/queue-ledger.mjs';
  const q = JSON.parse(readFileSync(process.argv[1], 'utf8')); const before = structuredClone(q); delete before.tickets['T-1'].merge; before.tickets['T-1'].merged_at = null;
  const evs = queueEvents(before, q, { batch: 'b' }).filter((e) => e.key === 'T-1');
  console.log(evs.map((e) => e.type === 'legacy_set' ? 'legacy_set:' + Object.keys(e.data.fields).join(',') : e.type + ':' + e.data.pr + ':' + e.data.head_sha + ':' + e.data.base).join(' '))" "$DESK_QUEUE" 2>&1)
check "DS-899 AC2: the driver's merge record is one merged event with who, PR, head and base, and no legacy event for it" '[ "$d899" = "merged:101:$SHA1:main" ]'

check "#809 the merge is claimed and recorded in the merge log, by this driver, at its head" 'node "$B/merge-log.mjs" show --repo acme/widgets --pr 101 | awk "{print \$3, \$5}" | tr "\n" " " | grep -Fqx "claim ${SHA1:0:12} merged ${SHA1:0:12} " && node "$B/merge-log.mjs" show --repo acme/widgets --pr 101 | grep -q "by merge-driver "'

# ---- #809: a PR a session has claimed is not merged by the driver ------------------------------
node "$B/merge-log.mjs" claim 102 "$SHA2" --by "session s-9" --repo acme/widgets >/dev/null
loop
check "#809 a PR another merger claimed is left, naming it, and not merged" '[ "$(merged)" = 101 ] && echo "$out" | grep -q "#102 NOT merged: acme/widgets#102 is already claimed by session s-9"'
node "$B/merge-log.mjs" record 102 "$SHA2" --by "session s-9" --event failed --why "handed back" --repo acme/widgets >/dev/null
rm -f "$T/state/merge-driver/backoff-102"

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

# ---- #1298: a ticket merged, then sent back for more and done again on a new PR, still open, ----------
# is not merged: neither its kept merged_at nor its old merged PR, which still names it, releases T-42.
jq --arg s "$SHA4" '."441" = { head: "fix/T-41", base: "main", sha: $s, state: "merged", draft: false, checks: [["test", "SUCCESS"]] }
  | ."442" = { head: "fix/T-41", base: "main", sha: $s, state: "open", draft: true, checks: [["test", "SUCCESS"]] }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
q add T-41 Task A; q set T-41 state=done branch=fix/T-41 result.pr=441 pr_status.pr=441 pr_status.state=MERGED; q merged T-41 2026-11-02T02:20:59.000Z
q requeue T-41; q set T-41 state=done result.pr=442
q add T-42 Task A; q set T-42 state=triaged branch=fix/T-42; q hold T-42 T-41
loop
check "#1298 a ticket done again on a new open PR after its earlier merge does not release what is held behind it" \
  '[ "$(qf T-42 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-42"'
jq '."442".state = "merged" | ."442".draft = false' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
loop
check "#1298 once that new PR merges, it does" '[ "$(qf T-42 .state)" = triaged ] && echo "$out" | grep -q "merged: T-41#442 -> RELEASED T-42"'
q drop T-41; q drop T-42

# ---- #1306: requeue holds a ticket behind a blocker merged once and done again on a PR still open ------
# T-52 is parked for its own reason (lane C) with its hold on T-51 beside it, as DS-714's; T-51 merged on
# 451, was requeued, and is done again on 452. A requeue of T-52 keeps it behind T-51, not to a worker.
q add T-51 Task A; q set T-51 state=done branch=fix/T-51 result.pr=451 pr_status.pr=451 pr_status.state=MERGED; q merged T-51 2026-11-02T02:20:59.000Z
q requeue T-51; q set T-51 state=done result.pr=452
q add T-52 Task B; q set T-52 state=triaged branch=fix/T-52; q hold T-52 T-51; q park T-52 "lane C — needs a plan"; q set T-52 lane=B
rq=$(node "$B/queue.mjs" requeue T-52 2>&1); rc=$?
check "#1306 a requeue keeps a ticket behind a blocker done again on a PR still open after its first merge" \
  '[ $rc -eq 0 ] && [ "$(qf T-52 .state)" = parked ] && [ "$(qf T-52 .held_by)" = T-51 ] && echo "$rq" | grep -q "held behind T-51 until they merge"'
q drop T-52; q drop T-51
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
rm -f "$SD/wake"; out=$(node "$B/queue.mjs" approve T-7 2>&1); rc=$?
check "approve undrafts the spine PR and hands it to the merge driver, exit 0" '[ $rc -eq 0 ] && [ "$(qf T-7 .state)" = done ] && [ "$(jq -r ".\"107\".draft" "$T/prs.json")" = false ] && echo "$out" | grep -q "the merge driver merges PR #107 once it is green; T-8 is released once it merges"'
check "DS-971 AC2: approving the spine wakes the merge driver from an idle pause" '[ -f "$SD/wake" ]'
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

# ---- DS-971: an idle driver backs off from 1 minute to 10, and a worker's exit or an undraft wakes it --
echo '{}' > "$T/prs.json"
# 60s, then 120, 240, 480 and 600 twice: 1+2+4+8+10+1 one-minute slices, stopped in the sixth pause.
loops 26
check "DS-971 AC1: each idle pause in a row is twice the last, up to 10 minutes, slept a minute at a time" \
  '[ $rc -eq 143 ] && [ "$(grep -o "next look in [0-9]*s" <<< "$out" | grep -o "[0-9]*" | paste -sd" " -)" = "120 240 480 600 600" ] && [ "$(sort -u "$T/sleeps")" = 60 ]'
# Woken in its second pause: the third loop's pause is the next step up, not the rest of the second.
mkdir -p "$T/state/exits"
printf '#!/bin/sh\ntouch "%s/state/exits/T-9.1.json"\n' "$T" > "$T/between.2"; chmod +x "$T/between.2"
loops 3
check "DS-971 AC2: a worker's exit during a long pause ends it within a minute" \
  '[ $rc -eq 143 ] && echo "$out" | grep -q "woken: a worker exited" && echo "$out" | grep -q "next look in 240s" && [ "$(wc -l < "$T/sleeps" | tr -d " ")" = 3 ]'
printf '#!/bin/sh\ntouch "%s/state/merge-driver/wake"\n' "$T" > "$T/between.2"
loops 3
check "DS-971 AC2: an undraft by the pass ends it too" \
  '[ $rc -eq 143 ] && echo "$out" | grep -q "woken: a PR left draft" && echo "$out" | grep -q "next look in 240s"'
rm -f "$T/between.2"
# Idle, then a ready PR that merges on its second green loop, then idle again: the merge pauses 30s
# as before, and the idle run after it starts again at a minute.
SHA971=9719719719719719719719719719719719719719
q add T-971 Task A; q set T-971 branch=fix/T-971 state=done result.pr=971
printf '#!/bin/sh\necho %s > "%s/prs.json"\n' "'{ \"971\": { \"head\": \"fix/T-971\", \"base\": \"main\", \"sha\": \"$SHA971\", \"state\": \"open\", \"draft\": false, \"checks\": [[\"test\", \"SUCCESS\"]] } }'" "$T" > "$T/between.1"; chmod +x "$T/between.1"
loops 4
check "DS-971 AC3: a loop that merged pauses 30s as before, and the next idle run starts at a minute" \
  '[ $rc -eq 143 ] && grep -q "^971 main $SHA971" "$T/merges.log" && [ "$(paste -sd" " - < "$T/sleeps")" = "60 120 30 60" ] && ! echo "$out" | grep -q "next look in"'
rm -f "$T/between.1"; q drop T-971
out=$(MERGE_DRIVER_WAKE_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1" 2>&1); rc=$?
check "DS-971: a pause setting that is not a whole number above 0 stops the driver at start" '[ $rc -eq 2 ] && echo "$out" | grep -q "MERGE_DRIVER_WAKE_SECS is .0."'

# ---- DS-835: a merge GitHub refuses leaves no merged entry in the merge log -----------------------
SHA835=8358358358358358358358358358358358358358
q add T-835 Task A; q set T-835 branch=fix/T-835 state=done result.pr=835
echo "{ \"835\": { \"head\": \"fix/T-835\", \"base\": \"main\", \"sha\": \"$SHA835\", \"state\": \"open\", \"draft\": false, \"refuse\": true, \"checks\": [[\"test\", \"SUCCESS\"]] } }" > "$T/prs.json"
loop; loop
check "DS-835 AC2: a refused merge is backed off, recorded failed for its ticket, and has no merged entry" \
  'echo "$out" | grep -q "#835 merge refused" && [ -z "$(node "$B/merge-log.mjs" show --repo acme/widgets --pr 835 --latest)" ] && [ "$(jq -r "select(.pr == \"835\") | .event" "$HOME/.desk-autopilot/merges.jsonl" | sort -u | tr "\n" " ")" = "claim failed " ] && jq -e "select(.pr == \"835\" and .event == \"failed\") | .ticket == \"T-835\"" "$HOME/.desk-autopilot/merges.jsonl" >/dev/null'
q drop T-835

# ---- DS-850: a red main takes no merge but its repair ticket's; green or unread, it merges as before --
# main's tip R1 has Lint's run still going; its parent R0's run of the required check `test` failed.
R1=a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1; R0=a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0; R2=a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2; R3=a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3; R4=a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4
cat > "$T/prs.json" <<EOF
{
  "851": { "head": "fix/T-851", "base": "main", "sha": "$SHA1", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "852": { "head": "fix/base-red-main-20261121090000", "base": "main", "sha": "$SHA2", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
# The red spell began at 09:00 UTC, so its repair ticket is base-red-main-20261121090000.
printf '{"branch":"main","checks":[],"since":"2026-11-21T09:00:00.000Z","at":"2026-11-21T09:00:00.000Z"}\n' > "$T/state/base-red.json"
# The loops above read main green after their merges; this spell's driver has no green read before it,
# so the hold names the last merges the log holds.
rm -f "$T/state/base-green.json"
printf '{"tip":"%s","commits":{"%s":{"parent":"%s","runs":[["test","in_progress",null]]},"%s":{"parent":null,"runs":[["test","completed","failure","https://github.com/acme/widgets/actions/runs/850"]]}}}\n' "$R1" "$R1" "$R0" "$R0" > "$T/base.json"
: > "$T/merges.log"
rloop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-851 base-red-main-20261121090000" 2>&1); rc=$?; }
rloop; first="$out"; rloop
check "DS-850 AC1: on a main red on a required check's latest run, nothing merges but the repair ticket's PR, and the log names the check" \
  '[ "$(merged)" = 852 ] && echo "$first" | grep -qF "HOLDING on red main: required check \"test\" (run https://github.com/acme/widgets/actions/runs/850) failed on its latest run there" && ! echo "$first$out" | grep -q "#851 " && [ "$(jq -r ".checks[0].name" "$T/state/base-red.json")" = test ]'
check "DS-850 AC1: the hold names the last merges desk made" 'echo "$first" | grep -qE "the last merges desk made: #[0-9]+"'
printf '{"tip":"%s","commits":{"%s":{"parent":null,"runs":[["test","completed","success"]]}}}\n' "$R1" "$R1" > "$T/base.json"
rloop; rloop
check "DS-850 AC6: once the check passes on main again, merging resumes and the record goes" \
  '[ "$(merged)" = "852 851" ] && ! echo "$out" | grep -q "HOLDING on red" && [ ! -e "$T/state/base-red.json" ]'
check "a green read of main's tip is kept as when the base was last green" '[ "$(jq -r .branch "$T/state/base-green.json")" = main ]'
jq --arg s "$SHA4" '."853" = { head: "fix/T-853", base: "main", sha: $s, state: "open", draft: false, checks: [["test", "SUCCESS"]] }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
touch "$T/base.broken"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-853" 2>&1); first="$out"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-853" 2>&1)
check "DS-969 AC1: with main unreadable (an API error), the driver merges nothing and says it holds" \
  '[ "$(merged)" = "852 851" ] && echo "$first" | grep -qF "base unreadable on main (the tip of main could not be read) — holding merges until it can be read" && ! echo "$first$out" | grep -q "merging as before"'
rm -f "$T/base.broken"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-853" 2>&1)
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-853" 2>&1)
check "DS-969 AC4: once main can be read again, the held PR merges with no person step" '[ "$(merged)" = "852 851 853" ]'
# Every read answers, but no completed run of the required check is on main's newest commits. A new
# tip, as a merge gives: R1's completed runs are kept from the loops above.
jq --arg s "$SHA5" '."855" = { head: "fix/T-855", base: "main", sha: $s, state: "open", draft: false, checks: [["test", "SUCCESS"]] }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
printf '{"tip":"%s","commits":{"%s":{"parent":null,"runs":[["test","in_progress",null]]}}}\n' "$R4" "$R4" > "$T/base.json"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-855" 2>&1); first="$out"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-855" 2>&1)
check "DS-969 AC2: with every read answered but no completed run on main, the driver merges as today" \
  '[ "$(merged)" = "852 851 853 855" ] && echo "$first" | grep -qF "base state unknown on main (no completed run of test on the newest 5 commits of main) — merging as before"'
rm -f "$T/base.json"
# With no PR ready (only drafts), the driver still reads the base every loop, so the record the pass reports
# from is written when main goes red and goes once it is green.
printf '{"854": { "head": "fix/T-854", "base": "main", "sha": "%s", "state": "open", "draft": true, "checks": [["test", "FAILURE"]] }}\n' "$SHA4" > "$T/prs.json"
# A new tip each time main changes, as a merge gives: the driver keeps a commit's completed runs (DS-989).
printf '{"tip":"%s","commits":{"%s":{"parent":null,"runs":[["test","completed","failure","https://github.com/acme/widgets/actions/runs/854"]]}}}\n' "$R2" "$R2" > "$T/base.json"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-854" 2>&1)
check "DS-850 AC1: with only drafts open, a red main is still read and recorded for the pass" \
  'echo "$out" | grep -qF "HOLDING on red main" && [ "$(jq -r ".checks[0].url" "$T/state/base-red.json")" = https://github.com/acme/widgets/actions/runs/854 ]'
# Reads of a commit or its check runs by SHA; the tip itself is read by branch name here, as this
# checkout's origin is not on GitHub.
shareads(){ grep -cE "^api repos/acme/widgets/commits/[0-9a-f]{40}" "$T/gh.log"; }
reads0=$(shareads)
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-854" 2>&1)
check "DS-989 AC1: a loop on a tip already read, its runs all completed, reads no commit or check runs and still holds" \
  'echo "$out" | grep -qF "HOLDING on red main" && [ "$(shareads)" = "$reads0" ]'
# A repair merge moves the tip, which is read afresh (DS-989 AC4).
printf '{"tip":"%s","commits":{"%s":{"parent":"%s","runs":[["test","completed","success"]]}}}\n' "$R3" "$R3" "$R2" > "$T/base.json"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-854" 2>&1)
check "DS-850 AC6: with only drafts open, a main green again drops the record" '[ ! -e "$T/state/base-red.json" ]'
rm -f "$T/base.json"

# ---- #1281: a later red spell lets in the repair an earlier spell left open -----------------------
# The pass admits no second repair while one is open, so on a red that began at 11:00 the earlier
# spell's repair (base-red-main-20261121090000) is the PR that may merge, and no other one is.
R5=a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5; SHA857=8578578578578578578578578578578578578578; SHA858=8588588588588588588588588588588588588588
cat > "$T/prs.json" <<EOF
{
  "857": { "head": "fix/base-red-main-20261121090000", "base": "main", "sha": "$SHA857", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "858": { "head": "fix/T-858", "base": "main", "sha": "$SHA858", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
printf '{"branch":"main","checks":[],"since":"2026-11-21T11:00:00.000Z","at":"2026-11-21T11:00:00.000Z"}\n' > "$T/state/base-red.json"
printf '{"tip":"%s","commits":{"%s":{"parent":null,"runs":[["test","completed","failure","https://github.com/acme/widgets/actions/runs/857"]]}}}\n' "$R5" "$R5" > "$T/base.json"
: > "$T/merges.log"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-858 base-red-main-20261121090000" 2>&1); first="$out"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-858 base-red-main-20261121090000" 2>&1)
check "#1281: on a later red spell, the earlier spell's open repair PR still merges, and no other PR does" \
  '[ "$(merged)" = 857 ] && echo "$first" | grep -qF "HOLDING on red main" && ! echo "$first$out" | grep -q "#858 "'
rm -f "$T/base.json" "$T/state/base-red.json"

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
qg(){ node "$B/queue.mjs" get "$1" 2>/dev/null | jq -r "$2"; }
# Whether ticket $1 still owes a pass its review's after-merge criteria, which keeps it from the
# archive and from a new batch's drop (harvest.mjs postMergeUnmade).
owed(){ node --input-type=module -e "import { readFileSync } from 'node:fs'; import { postMergeUnmade } from '$B/harvest.mjs';
  process.exit(postMergeUnmade(JSON.parse(readFileSync(process.argv[1], 'utf8')).tickets[process.argv[2]]) ? 0 : 1)" "$DESK_QUEUE" "$1"; }
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
check "DS-796: it owes a pass that PR's review until one reads it, and not after" \
  'owed T-31 && q set T-31 "pr_status={\"pr\":131,\"state\":\"MERGED\"}" && ! owed T-31'
# T-34 was recorded done on another repo's PR #134 (needs-you's elsewhereDone), then requeued and
# respawned, keeping that status. This repo's PR #134 from its branch merges: the other repo's status is
# dropped, not marked merged in this PR's place, so the ticket owes a pass this PR's review. T-35's
# kept status is this repo's own PR #135, so it is kept and marked merged.
q add T-34 Task A; q set T-34 state=triaged branch=fix/T-34 'pr_status={"pr":134,"state":"MERGED","url":"https://github.com/other/thing/pull/134"}'
q merged T-34 2026-11-18T11:45:00Z --pr 134 --head fix/T-34
q add T-35 Task A; q set T-35 state=triaged branch=fix/T-35 'pr_status={"pr":135,"state":"OPEN","url":"https://github.com/Acme/Widgets/pull/135"}'
q merged T-35 2026-11-18T11:46:00Z --pr 135 --head fix/T-35
check "DS-796: a kept status naming another repo's PR of the merged number is dropped, and the ticket owes that PR's review" \
  '[ "$(qg T-34 .result.pr)" = 134 ] && [ "$(qg T-34 .shipped_pr)" = 134 ] && [ "$(qg T-34 .pr_status)" = null ] && owed T-34'
check "DS-796: one naming this repo's own PR is kept and marked merged" \
  '[ "$(qg T-35 .pr_status.state)" = MERGED ] && [ "$(qg T-35 .pr_status.url)" = https://github.com/Acme/Widgets/pull/135 ] && [ "$(qg T-35 .result.pr)" = 135 ]'
# T-33 records no branch, and PR #133 names it only in its title: another ticket's PR. Its merge time is
# recorded as before, and the ticket is not taken as shipped on it.
cat > "$T/prs.json" <<EOF
{ "133": { "head": "fix/other-work", "title": "fix: T-33 follow-up", "base": "main", "sha": "$SHA31", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]], "mergedAt": "2026-11-18T11:41:00Z" } }
EOF
q add T-33 Task A; q set T-33 state=triaged
for i in 1 2; do out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-33" 2>&1); done
check "DS-796: a PR whose branch does not name the ticket is not recorded as its PR" \
  'grep -q "^133 main " "$T/merges.log" && [ "$(qg T-33 .state)" = triaged ] && [ "$(qg T-33 .result.pr)" = null ] && [ "$(qg T-33 .merged_at)" = 2026-11-18T11:41:00.000Z ]'
# T-32's own worker opened PR #132 and parked: the merge records its time and leaves the ticket as its
# worker left it, for the pass to send back for its after-merge steps.
cat > "$T/prs.json" <<EOF
{ "132": { "head": "fix/T-32", "base": "main", "sha": "$SHA31", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] } }
EOF
q add T-32 Task A; q set T-32 state=parked branch=fix/T-32 draft_pr=132 'park={"question":"Stage 8: comment"}'
for i in 1 2; do out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-32" 2>&1); done
check "DS-796: a ticket that records its own PR keeps its state, and gh's unset time falls back to the driver's clock" \
  'grep -q "^132 main " "$T/merges.log" && [ "$(qg T-32 .state)" = parked ] && [ "$(qg T-32 .result.pr)" = null ] && [ "$(qg T-32 .merged_at | cut -c1-4)" = "$(date -u +%Y)" ]'

# ---- DS-796: a blocker requeued after its first PR merged holds its dependants until its new PR merges ----
# T-41's first PR #140 merged (merged_at, merged_pr) and GitHub still lists it on its branch; its new PR
# #141 is open. T-43, never requeued, merged on #142, which GitHub does not list: its merge still counts.
cat > "$T/prs.json" <<EOF
{ "140": { "head": "fix/T-41", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] },
  "141": { "head": "fix/T-41", "base": "main", "sha": "$SHA31", "state": "open", "draft": true, "checks": [] } }
EOF
q add T-41 Task A; q set T-41 state=done branch=fix/T-41 result.pr=141 merged_pr=140 'pr_status={"pr":141,"state":"OPEN"}'; q merged T-41 2026-11-10T00:00:00.000Z
q add T-43 Task A; q set T-43 state=done branch=fix/T-43 result.pr=142 'pr_status={"pr":142,"state":"MERGED"}'; q merged T-43 2026-11-11T00:00:00.000Z
q add T-42 Task A; q set T-42 state=triaged branch=fix/T-42; q hold T-42 T-41
q add T-44 Task A; q set T-44 state=triaged branch=fix/T-44; q hold T-44 T-43
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-41" 2>&1)
check "DS-796 a requeued blocker's first merge, recorded or listed, does not release what waits on its open PR" \
  '[ "$(qg T-42 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-42"'
check "DS-796 a blocker never requeued still releases on its recorded merge" '[ "$(qg T-44 .state)" = triaged ] && echo "$out" | grep -q "merged: T-43#142 -> RELEASED T-44"'
node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs'; const f = process.argv[1]; const p = JSON.parse(readFileSync(f, 'utf8')); p['141'].state = 'merged'; writeFileSync(f, JSON.stringify(p))" "$T/prs.json"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-41" 2>&1)
check "DS-796 and its new PR merging releases them" '[ "$(qg T-42 .state)" = triaged ] && echo "$out" | grep -q "merged: T-41#141 -> RELEASED T-42"'
# T-45 is requeued (back to triaged, no spawn yet), its first PR #145 merged and listed: what waits on it
# waits for its new round. T-47, never requeued, was just merged by the driver: its status still reads
# open until a pass reads it, and GitHub does not list it, but its recorded merge releases T-48.
cat > "$T/prs.json" <<EOF
{ "145": { "head": "fix/T-45", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] } }
EOF
q add T-45 Task A; q set T-45 state=done branch=fix/T-45 result.pr=145 'pr_status={"pr":145,"state":"MERGED"}'; q merged T-45 2026-11-12T00:00:00.000Z; q set T-45 state=triaged
q add T-47 Task A; q set T-47 state=done branch=fix/T-47 result.pr=147 'pr_status={"pr":147,"state":"OPEN"}'; q merged T-47 2026-11-12T00:00:00.000Z
q add T-46 Task A; q set T-46 state=triaged branch=fix/T-46; q hold T-46 T-45
q add T-48 Task A; q set T-48 state=triaged branch=fix/T-48; q hold T-48 T-47
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-45" 2>&1)
check "DS-796 a blocker requeued before its new worker starts does not release on its first merge" '[ "$(qg T-46 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-46"'
check "DS-796 a blocker the driver just merged releases on that merge before a pass reads its status" '[ "$(qg T-48 .state)" = triaged ] && echo "$out" | grep -q "merged: T-47#147 -> RELEASED T-48"'
# T-51 was respawned (merged_pr) after its first PR #151 merged, and its new worker parked; T-61's new
# worker failed. T-53 was requeued behind its own unmerged blocker T-55, so it is parked, held. T-57 was
# respawned before merged_pr was kept: done again on #157, read open after its first merge. None of them
# releases what waits on it on that first merge, recorded or listed.
cat > "$T/prs.json" <<EOF
{ "151": { "head": "fix/T-51", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] },
  "153": { "head": "fix/T-53", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] },
  "156": { "head": "fix/T-57", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] },
  "161": { "head": "fix/T-61", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] },
  "163": { "head": "fix/T-63", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] },
  "165": { "head": "fix/T-65", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] },
  "166": { "head": "fix/T-67", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] } }
EOF
# T-63 was requeued after #163 merged, and its next spawn failed its preflight: no worker ran. T-67 was
# respawned before merged_pr was kept and is done again on #167, its status still naming #166. T-65, never
# requeued, was stopped (held behind nothing) and then its draft #165 merged: that merge counts.
q add T-63 Task A; q set T-63 state=failed branch=fix/T-63 result.pr=163 spawn_failed=true; q merged T-63 2026-11-13T00:00:00.000Z
q add T-67 Task A; q set T-67 state=done branch=fix/T-67 result.pr=167 'pr_status={"pr":166,"state":"MERGED"}'; q merged T-67 2026-11-13T00:00:00.000Z
q add T-65 Task A; q set T-65 state=parked branch=fix/T-65 draft_pr=165 'park={"question":"held by orchestrator: stopped by queue.mjs stop at 2026-11-13T00:00:00.000Z"}'; q merged T-65 2026-11-14T00:00:00.000Z
for s in 64:63 68:67 66:65; do q add "T-${s%%:*}" Task A; q set "T-${s%%:*}" state=triaged branch="fix/T-${s%%:*}"; q hold "T-${s%%:*}" "T-${s##*:}"; done
q add T-51 Task A; q set T-51 state=parked branch=fix/T-51 merged_pr=151 'park={"question":"Stage 8: comment"}'; q merged T-51 2026-11-13T00:00:00.000Z
q add T-61 Task A; q set T-61 state=failed branch=fix/T-61 merged_pr=161; q merged T-61 2026-11-13T00:00:00.000Z
q add T-55 Task A; q set T-55 state=triaged branch=fix/T-55
q add T-53 Task A; q set T-53 state=done branch=fix/T-53 result.pr=153; q merged T-53 2026-11-13T00:00:00.000Z
q set T-53 state=parked result=null held_by=T-55 'park={"question":"held by orchestrator: blocked by T-55"}'
q add T-57 Task A; q set T-57 state=done branch=fix/T-57 result.pr=157 'pr_status={"pr":157,"state":"OPEN","at":"2026-11-14T00:00:00.000Z"}'; q merged T-57 2026-11-13T00:00:00.000Z
for s in 52:51 62:61 54:53 58:57; do q add "T-${s%%:*}" Task A; q set "T-${s%%:*}" state=triaged branch="fix/T-${s%%:*}"; q hold "T-${s%%:*}" "T-${s##*:}"; done
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-51" 2>&1)
check "DS-796 a respawned blocker whose new worker parked or failed does not release on its first merge" \
  '[ "$(qg T-52 .state)" = parked ] && [ "$(qg T-62 .state)" = parked ] && ! echo "$out" | grep -qE "RELEASED T-(52|62)"'
check "DS-796 a blocker held behind its own blockers at its requeue does not release on its first merge" \
  '[ "$(qg T-54 .state)" = parked ] && [ "$(qg T-53 .state)" = parked ] && ! echo "$out" | grep -qE "RELEASED T-5[34]"'
check "DS-796 a blocker respawned before merged_pr, its new PR read open after its merge, does not release on that merge" \
  '[ "$(qg T-58 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-58"'
check "DS-796 a requeued blocker whose next spawn failed before any worker ran does not release on its first merge" \
  '[ "$(qg T-64 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-64"'
check "DS-796 a blocker respawned before merged_pr, done on a PR its status does not name yet, does not release on its first merge" \
  '[ "$(qg T-68 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-68"'
check "DS-796 a stopped blocker never requeued releases on the merge it records" '[ "$(qg T-66 .state)" = triaged ] && echo "$out" | grep -q "RELEASED T-66"'
node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs'; const f = process.argv[1]; const p = JSON.parse(readFileSync(f, 'utf8')); p['157'] = { ...p['156'], state: 'merged' }; p['167'] = { ...p['166'], state: 'merged' }; writeFileSync(f, JSON.stringify(p))" "$T/prs.json"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-51" 2>&1)
check "DS-796 and its current PR merging releases what waits on it" '[ "$(qg T-58 .state)" = triaged ] && echo "$out" | grep -q "merged: T-57#157 -> RELEASED T-58" && [ "$(qg T-68 .state)" = triaged ] && echo "$out" | grep -q "merged: T-67#167 -> RELEASED T-68"'
# T-71's #171 merged, it was requeued, and the pass parked it before any worker spawned (its worktree
# setup failed): the requeue itself keeps #171 as merged_pr, so what waits on it waits for its next PR.
cat > "$T/prs.json" <<EOF
{ "171": { "head": "fix/T-71", "base": "main", "sha": "$SHA31", "state": "merged", "draft": false, "checks": [] } }
EOF
q add T-71 Task A; q set T-71 state=done lane=B branch=fix/T-71 result.pr=171 'pr_status={"pr":171,"state":"MERGED"}'; q merged T-71 2026-11-15T00:00:00.000Z
q requeue T-71; q park T-71 "worktree setup failed, not spawned — no space left"
q add T-72 Task A; q set T-72 state=triaged branch=fix/T-72; q hold T-72 T-71
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-71" 2>&1)
check "DS-796 a requeue keeps the merged PR, so a blocker parked before its next worker spawned does not release on it" \
  '[ "$(qg T-71 .merged_pr | tr -d " \n")" = "[171]" ] && [ "$(qg T-71 .state)" = parked ] && [ "$(qg T-72 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-72"'

finish loop
