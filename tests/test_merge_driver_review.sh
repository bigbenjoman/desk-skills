#!/usr/bin/env bash
# suite: merge driver: clean review verdicts and epic PRs (offline, fake gh)
# The real merge-driver.sh and gate.mjs, one loop at a time, set up by merge_driver_setup.sh: a PR
# merges on a clean desk-review verdict at its head (carried across a clean base merge, by the review
# account, under the review-reuse lever), and an epic batch's PR into main (and pass.mjs on its hold).
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

# ---- DS-433: every PR merges on a clean desk-review at its head, whatever its title, with no approval --
write_rv_config
# rv_prs "<n> <branch> <sha> <title> [<feedback>]"...: open, ready, green PRs read from vp-<n>.json, each a ticket T-<n>.
rv_prs(){
  : > "$T/merges.log"; : > "$T/gh.log"; rm -f "$SD"/green-*; echo '{}' > "$T/prs.json"; q init "merge-rv-$1"; shift; RV_TICKETS=""
  local row n br sha title fb
  for row in "$@"; do
    IFS='|' read -r n br sha title fb <<EOF_ROW
$row
EOF_ROW
    jq --arg n "$n" --arg br "$br" --arg sha "$sha" --arg t "$title" --arg fb "$fb" --arg pl "$T/vp-$n.json" \
      '.[$n] = { head: $br, base: "main", sha: $sha, state: "open", draft: false, title: $t, feedback: $fb, payload: $pl, checks: [["test", "SUCCESS"]] }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
    q add "T-$n" Story A; q set "T-$n" "branch=$br" state=done "result.pr=$n"
    RV_TICKETS="$RV_TICKETS T-$n"
  done
}
SHA201=d201111111111111111111111111111111111111; SHA202=d202222222222222222222222222222222222222; SHA203=d203333333333333333333333333333333333333

vp 201 "$SHA201" "$CLEAN"
rv_prs ac1 "201|feat/T-201|$SHA201|feat(rail): T-201 live classes|"
rvloop; rvloop
check "DS-433 AC1: a green feat PR with a clean verdict at its head and no approval merges, pinned to that head" '[ "$(merged)" = 201 ] && grep -qx "201 main $SHA201" "$T/merges.log"'
check "DS-433 AC1: and nothing is left for needs-you" '[ "$(qf T-201 .merge_blocked)" = null ]'

vp 201 "$SHA202" "$CLEAN"
rv_prs ac2 "201|feat/T-201|$SHA201|feat(rail): T-201 live classes|"
rvloop; rvloop
check "DS-433 AC2: a clean verdict for an older head does not merge it, and it is held for the review" '[ -z "$(merged)" ] && echo "$out" | grep -q "#201 green at d20111111, HELD with no clean review at its head: its review verdict is for d20222222, not the head d20111111" && [ ! -e "$SD/green-201" ]'
vp 201 "$SHA201" "$CLEAN"
rvloop; rvloop
check "DS-433 AC2: once a clean verdict is posted at the head, it merges with no other answer" '[ "$(merged)" = 201 ] && grep -qx "201 main $SHA201" "$T/merges.log"'

vp 201 "$SHA201" -
vp 202 "$SHA202" 'p0=0 p1=0 p2=1 deferred=0 gaps=0 unrefuted=0 partial=0'
vp 203 "$SHA203" 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0' '<!-- desk-review:carried v=1 p2=2 since=d200000000000000000000000000000000000000 -->'
rv_prs p2 "201|fix/T-201|$SHA201|fix: T-201 no review|" "202|fix/T-202|$SHA202|fix: T-202 an open P2|" "203|fix/T-203|$SHA203|fix: T-203 carried P2s|"
rvloop; rvloop
check "DS-433: a PR with no verdict at all is held" 'echo "$out" | grep -q "#201 green at d20111111, HELD with no clean review at its head: no desk-review verdict is posted on it"'
check "DS-433: an uncarried P2 at the head holds it" 'echo "$out" | grep -q "#202 green at d20222222, HELD with no clean review at its head: its review verdict at d20222222 is not clean (p2=1)"'
check "DS-433: P2s carried on the carried line do not hold it, and only it merges" '[ "$(merged)" = 203 ] && grep -qx "203 main $SHA203" "$T/merges.log"'

vp 201 "$SHA201" "$CLEAN"
rv_prs ac3 "201|feat/T-201|$SHA201|feat(rail): T-201 live classes|REVIEW_REQUIRED 0"
rvloop; rvloop
check "DS-433 AC3: where GitHub requires an approving review, a green cleanly reviewed feat PR stays held and needs-you asks" '[ -z "$(merged)" ] && [ "$(qf T-201 .merge_blocked)" = "approval: an approving review is required at d20111111: a person approves it before desk merges it" ]'

sed 's/| `autopilot-merge` | Merge batch PRs | `no` | `yes` |/| `autopilot-merge` | Merge batch PRs | `no` | `no` |/' "$T/config-rv.md" > "$T/config-rv-no.md"
vp 201 "$SHA201" "$CLEAN"
rv_prs ac4 "201|feat/T-201|$SHA201|feat(rail): T-201 live classes|"
RV_CONFIG="$T/config-rv-no.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-433 AC4: under §3 autopilot-merge no, a green cleanly reviewed feat PR is not merged" '[ -z "$(merged)" ] && [ $rc -eq 1 ] && echo "$out" | grep -q "the driver merges nothing"'

vp 201 "$SHA201" "$CLEAN"; vp 202 "$SHA202" "$CLEAN"
rv_prs ac5 "201|fix/T-201|$SHA201|fix: T-201 a bug|" "202|feat/T-202|$SHA202|feat: T-202 a feature|"
rvloop
check "DS-433 AC5: a fix PR and a feat PR both green and clean are confirmed the same way" 'echo "$out" | grep -q "#201 green at d20111111 — confirming" && echo "$out" | grep -q "#202 green at d20222222 — confirming"'
rvloop; rvloop
check "DS-433 AC5: and both merge, pinned to their heads, with nothing left for a person" '[ "$(merged)" = "201 202" ] && grep -qx "201 main $SHA201" "$T/merges.log" && grep -qx "202 main $SHA202" "$T/merges.log" && [ "$(qf T-201 .merge_blocked)" = null ] && [ "$(qf T-202 .merge_blocked)" = null ]'
vp 201 "$SHA201" -; vp 202 "$SHA202" -
rv_prs ac5b "201|fix/T-201|$SHA201|fix: T-201 a bug|" "202|feat/T-202|$SHA202|feat: T-202 a feature|"
rvloop; rvloop
check "DS-433 AC5: and neither merges with no review" '[ -z "$(merged)" ] && echo "$out" | grep -q "#201 green at d20111111, HELD" && echo "$out" | grep -q "#202 green at d20222222, HELD"'

# The hold reads the row: `none` waits on nothing, and a plain-text row and §3 merge-feedback-first no still hold.
sed 's/| Local review command | `\/desk-review` |/| Local review command | `none` |/' "$T/config-rv.md" > "$T/config-rv-none.md"
vp 201 "$SHA201" -
rv_prs none "201|fix/T-201|$SHA201|fix: T-201 a bug|"
RV_CONFIG="$T/config-rv-none.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-433: §4 Local review command none waits on no verdict" '[ "$(merged)" = 201 ]'
sed 's/^| `pr-ready` .*/&\n| `merge-feedback-first` | Feedback first | `yes` | `no` |/' "$T/config-rv.md" > "$T/config-rv-fb.md"
rv_prs fbno "201|fix/T-201|$SHA201|fix: T-201 a bug|"
RV_CONFIG="$T/config-rv-fb.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-433: §3 merge-feedback-first no skips the threads, not the verdict" '[ -z "$(merged)" ] && echo "$out" | grep -q "#201 green at d20111111, HELD"'
sed 's/| Clean review verdict | .*/| Clean review verdict | `no findings` |/' "$T/config-rv.md" > "$T/config-rv-plain.md"
node -e 'const sha = process.argv[2]; require("fs").writeFileSync(process.argv[1], JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null, reviews: { nodes: [{ id: "PRR_1", author: { login: "tester" }, commit: { oid: sha }, body: "No findings.\nNothing deferred or carried." }] }, reviewThreads: { nodes: [] } } } } }));' "$T/vp-201.json" "$SHA201"
rv_prs plain "201|fix/T-201|$SHA201|fix: T-201 a bug|"
RV_CONFIG="$T/config-rv-plain.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-433: under a plain-text row, a review stating it at the head reads as clean, so it merges" '[ "$(merged)" = 201 ]'

# DS-576: a clean verdict posted by §4 Review account is read as desk's own; one by another login is not.
cp "$T/config-rv.md" "$T/config-rv-acct.md"; mkdir -p "$T/gh-agent-pullbot"
echo "| Review account | \`agent-pullbot: $T/gh-agent-pullbot\` |" >> "$T/config-rv-acct.md"
vp_by(){ node -e 'const [f, sha, counts, login] = process.argv.slice(1);
  const reviews = [{ id: "PRR_1", author: { login }, commit: { oid: sha }, body: ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${sha} ${counts} vendor=codex round=1 -->`].join("\n") }];
  require("fs").writeFileSync(f, JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null, reviews: { nodes: reviews }, reviewThreads: { nodes: [] } } } } }));' "$T/vp-$1.json" "$2" "$3" "$4"; }
vp_by 201 "$SHA201" "$CLEAN" agent-pullbot
rv_prs acct "201|fix/T-201|$SHA201|fix: T-201 a bug|"
RV_CONFIG="$T/config-rv-acct.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-576 AC6: a ready PR whose only clean verdict at its head is the review account's merges" '[ "$(merged)" = 201 ] && grep -qx "201 main $SHA201" "$T/merges.log"'
vp_by 201 "$SHA201" "$CLEAN" mallory
rv_prs acct7 "201|fix/T-201|$SHA201|fix: T-201 a bug|"
RV_CONFIG="$T/config-rv-acct.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-576 AC7: a clean verdict by neither the handle nor the review account holds it" '[ -z "$(merged)" ] && echo "$out" | grep -q "#201 green at d20111111, HELD with no clean review at its head"'

# A verdict carried across a clean merge of the base holds at the head; commits of its own do not. Real commits, fetched.
git init -q --bare -b main "$T/origin.git"; git -C "$T/repo" remote add origin "file://$T/origin.git"
cmt(){ echo "$1" > "$T/repo/$1"; git -C "$T/repo" add "$1"; git -C "$T/repo" commit -q -m "$1"; }
git -C "$T/repo" checkout -q main; cmt base.txt; git -C "$T/repo" push -q origin main
git -C "$T/repo" checkout -q -b fix/T-211; cmt own.txt; RA=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" checkout -q main; cmt moved.txt
git -C "$T/repo" checkout -q fix/T-211; git -C "$T/repo" merge -q --no-edit main; RB=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" checkout -q -b fix/T-212 "$RA"; cmt other.txt; git -C "$T/repo" merge -q --no-edit main; RC=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" checkout -q main; git -C "$T/repo" push -q origin main "$RB:refs/pull/211/head" "$RC:refs/pull/212/head"
vp 211 "$RA" "$CLEAN"; vp 212 "$RA" "$CLEAN"
rv_prs carry "211|fix/T-211|$RB|fix: T-211 base merged|" "212|fix/T-212|$RC|fix: T-212 own commit|"
rvloop; rvloop
check "DS-433: a clean verdict carried across a clean merge of the base merges, with no new review" '[ "$(merged)" = 211 ] && grep -qx "211 main $RB" "$T/merges.log" && echo "$out" | grep -q "#211 its clean review at ${RA:0:9} holds at ${RB:0:9}: only clean merges of main came since"'
rvloop
check "DS-433: one its own commits moved past is held for a review" '! grep -q "^212 " "$T/merges.log" && echo "$out" | grep -q "#212 green at ${RC:0:9}, HELD with no clean review at its head: its review verdict is for ${RA:0:9}"'

# With the review-reuse lever on, the same clean merge carries only while the base moved none
# of the files the review rests on, and the PR says so once. moved.txt is what the base changed.
{ cat "$T/config-rv.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `review-reuse` |\n'; } > "$T/config-rv-reuse.md"
# The merge driver reads the lever from the ticket's pin: T-211 is pinned with it.
PIN_RV='levers={"set":["review-reuse"],"at":"2026-11-14T00:00:00Z"}'
vp 211 "$RA" "$CLEAN" '<!-- desk-review:rests-on v=1 files=["own.txt"] -->'
rv_prs reuse "211|fix/T-211|$RB|fix: T-211 base merged|"; q set T-211 "$PIN_RV"
RV_CONFIG="$T/config-rv-reuse.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-448 AC2: lever on, a base merge over unrelated files carries the review, and the PR names the range" '[ "$(merged)" = 211 ] && echo "$out" | grep -q "#211 its clean review at ${RA:0:9} is carried to ${RB:0:9}, not reviewed there" && [ "$(grep -c "pr comment 211" "$T/gh.log")" = 1 ] && grep "pr comment 211" "$T/gh.log" | grep -q "which no review has read"'
vp 211 "$RA" "$CLEAN" '<!-- desk-review:rests-on v=1 files=["moved.txt","own.txt"] -->'
rv_prs reuse2 "211|fix/T-211|$RB|fix: T-211 base merged|"; q set T-211 "$PIN_RV"
RV_CONFIG="$T/config-rv-reuse.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-448 AC8: lever on, a clean merge over a recorded file is held for a review" '[ -z "$(merged)" ] && echo "$out" | grep -q "#211 green at ${RB:0:9}, HELD with no clean review at its head"'
# The row reads review-reuse, and T-211 is pinned without it: the merge driver reads the lever
# off for it, so the clean merge of main carries the review as with the lever off.
vp 211 "$RA" "$CLEAN" '<!-- desk-review:rests-on v=1 files=["moved.txt","own.txt"] -->'
rv_prs reuse4 "211|fix/T-211|$RB|fix: T-211 base merged|"; q set T-211 'levers={"set":[],"at":"2026-11-14T00:00:00Z"}'
RV_CONFIG="$T/config-rv-reuse.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-639 the merge driver reads a ticket pinned without the lever as off, whatever the row" '[ "$(merged)" = 211 ] && echo "$out" | grep -q "#211 its clean review at ${RA:0:9} holds at ${RB:0:9}: only clean merges of main came since"'
vp 211 "$RA" "$CLEAN"
rv_prs reuse3 "211|fix/T-211|$RB|fix: T-211 base merged|"; q set T-211 "$PIN_RV"
RV_CONFIG="$T/config-rv-reuse.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-448: lever on, a review that records no files is held for a review" '[ -z "$(merged)" ] && echo "$out" | grep -q "#211 green at ${RB:0:9}, HELD"'

# ---- DS-508: an epic batch not in feature mode lands its base through its epic PR into main ---------
# ep_q <case> <draft>: batch base feat/E for epic T-300, its one child merged, and epic PR #301
# (feat/E → main), green, recorded as the queue's promotion.
SHA301=e301111111111111111111111111111111111111
git -C "$T/repo" push -q origin main:feat/E
ep_q(){
  : > "$T/merges.log"; : > "$T/gh.log"; rm -f "$SD"/green-*; q init "merge-epic-$1"
  q set-batch base=feat/E epic=T-300 feature=false 'promotion={"pr":301}'
  q add T-31 Story A; q set T-31 branch=fix/T-31 state=done result.pr=310 merged_at=2026-11-06T10:00:00Z
  jq -n --arg s "$SHA301" --arg pl "$T/vp-301.json" --argjson d "$2" \
    '{ "301": { head: "feat/E", base: "main", sha: $s, state: "open", draft: $d, title: "T-300: promote feat/E to main", payload: $pl, checks: [["test", "SUCCESS"]] } }' > "$T/prs.json"
  RV_TICKETS="T-31"
}
vp 301 "$SHA301" "$CLEAN"
ep_q ready false; rvloop; rvloop
check "DS-508 AC2: a ready epic PR into main, green with a clean review at its head, is merged by the driver, pinned to its head" '[ "$(merged)" = 301 ] && grep -qx "301 main $SHA301" "$T/merges.log" && echo "$out" | grep -q "#301 MERGED (T-300)"'
check "DS-508 AC2: and its merge is recorded on the queue's promotion, not as a ticket" '[ "$(jq -r .promotion.merged_at "$DESK_QUEUE")" != null ] && [ "$(jq -r ".tickets[\"T-300\"]" "$DESK_QUEUE")" = null ]'
# GitHub shown as open again, so only the queue's promotion.merged_at can keep the driver off it.
: > "$T/merges.log"; jq '."301".state = "open"' "$T/prs.json" > "$T/prs.json.new" && mv "$T/prs.json.new" "$T/prs.json"
rvloop
check "DS-508 AC2: a merged epic PR is not tried again" '[ -z "$(merged)" ] && ! echo "$out" | grep -q "#301"'
ep_q draft true; rvloop; rvloop
check "DS-508 AC2: a draft epic PR is not merged" '[ -z "$(merged)" ] && echo "$out" | grep -q "epic PR #301 draft (still reviewing)"'
vp 301 "$SHA301" -
ep_q noreview false; rvloop; rvloop
check "DS-508 AC2: one with no clean review at its head is held for one" '[ -z "$(merged)" ] && echo "$out" | grep -q "#301 green at e30111111, HELD with no clean review at its head"'
vp 301 "$SHA301" "$CLEAN"
ep_q carried false; q set T-31 'promotion_hold=deploys the stack — infra/**'; rvloop; rvloop
check "DS-508 AC3: §4 Merge holds its children carried into the base leave the epic PR to a person" '[ -z "$(merged)" ] && echo "$out" | grep -q "epic PR #301 HELD: its children carried §4 Merge holds into feat/E"'
sed 's/| Merge holds | `none` |/| Merge holds | `infra\/**: deploys the stack` |/' "$T/config-rv.md" > "$T/config-rv-hold.md"
ep_q hold false; jq '."301".files = ["infra/x.tf"]' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
RV_CONFIG="$T/config-rv-hold.md"; rvloop; rvloop
check "DS-508 AC3: a §4 Merge hold the epic PR touches holds it, noted on the queue's promotion" '[ -z "$(merged)" ] && jq -r .promotion.merge_blocked "$DESK_QUEUE" | grep -q "^merge hold: deploys the stack — infra/\*\*, 1 file(s)"'
out=$(DESK_CONFIG="$T/config-rv-hold.md" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off node "$B/pass.mjs" --json 2>/dev/null); rc=$?; RV_CONFIG=""
check "DS-508 AC3: and the pass puts it to the person, naming the hold, exit 11" '[ $rc -eq 11 ] && js ".waiting[]" | grep -q "^EPIC PR: #301 is out of draft, but the merge driver holds it: merge hold: deploys the stack"'

finish review
