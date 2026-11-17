#!/usr/bin/env bash
# suite: merge driver: merge approval, Done moves and review threads (offline, fake gh)
# The real merge-driver.sh and gate.mjs, one loop at a time, set up by merge_driver_setup.sh: merging
# asked once per batch where §3 says ask (and pass.mjs and decider.mjs on a PR left to the person),
# a merged ticket moved to §4 Done state, and desk-review threads a clean verdict settles.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

# ---- DS-203: merging asked once per batch at Stage 3, where §3 says ask --------------------------
sed -e 's/| `autopilot-merge` | Merge batch PRs | `no` | `yes` |/| `autopilot-merge` | Merge batch PRs | `no` | `ask` |/' \
  -e 's/| `pr-merge-green` | Merge on green | `no` | `yes` |/| `pr-merge-green` | Merge on green | `no` | `ask` |/' "$T/config.md" > "$T/config-ask.md"
sed -e 's/| `autopilot-merge` | Merge batch PRs | `no` | `yes` |/| `autopilot-merge` | Merge batch PRs | `no` | `no` |/' \
  -e 's/| `pr-merge-green` | Merge on green | `no` | `yes` |/| `pr-merge-green` | Merge on green | `no` | `ask` |/' "$T/config.md" > "$T/config-no.md"
SHA21=b111111111111111111111111111111111111111; SHA22=b222222222222222222222222222222222222222; SHA23=b333333333333333333333333333333333333333
cat > "$T/prs.json" <<EOF
{
  "121": { "head": "fix/T-21", "base": "main", "sha": "$SHA21", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "122": { "head": "fix/T-22", "base": "main", "sha": "$SHA22", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]], "feedback": "CHANGES_REQUESTED 0" },
  "123": { "head": "fix/T-23", "base": "main", "sha": "$SHA23", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]], "feedback": "APPROVED 1" }
}
EOF
q init merge-ask
for k in T-21 T-22 T-23; do q add "$k" Task A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; rm -f "$T/state/batch-notes.md"
mloop(){ out=$(DESK_CONFIG="$1" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-21 T-22 T-23" 2>&1); rc=$?; }
mpj(){ out=$(DESK_CONFIG="$1" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off node "$B/pass.mjs" --json 2>/dev/null); rc=$?; }
ASKED='config §3 autopilot-merge is "ask" and pr-merge-green is "ask"'

mloop "$T/config-ask.md"
check "DS-203: with merging at ask and never asked, the driver refuses to start" '[ $rc -eq 1 ] && echo "$out" | grep -qF "FAIL: $ASKED with no batch approval" && ! echo "$out" | grep -q "merge driver up"'
q set-batch approved.merge=false
mloop "$T/config-ask.md"
check "DS-203 AC3: declined at Stage 3, the driver refuses to start and merges nothing" '[ $rc -eq 1 ] && echo "$out" | grep -qF "FAIL: $ASKED, and merging was declined for this batch at Stage 3" && [ ! -s "$T/merges.log" ]'
mpj "$T/config-ask.md"
check "DS-203 AC3: declined, the pass reports a green PR as ready to merge" 'js ".waiting[]" | grep -qF "T-21: READY TO MERGE — PR #121 is out of draft and green, and no merge driver merges it ($ASKED, and merging was declined for this batch at Stage 3): merge it yourself once no review thread is left unresolved"'
check "DS-203 AC3: a green PR with changes requested is put as feedback to work, never as ready to merge" 'js ".waiting[]" | grep -qF "T-22: CHANGES REQUESTED — PR #122 is out of draft and green, but changes are requested on it" && ! js ".waiting[]" | grep -q "T-22: READY TO MERGE"'
js '{waiting: [.waiting[] | select(startswith("T-21: READY TO MERGE"))]}' > "$T/ready.json"
hand=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { deciderItems, presort } from '$B/decider.mjs';
const { hand } = presort(deciderItems(JSON.parse(readFileSync('$T/ready.json', 'utf8')), JSON.parse(readFileSync('$DESK_QUEUE', 'utf8'))));
console.log(hand.map((h) => h.item.ticket + ' ' + h.why).join('\n'));")
check "DS-203 AC8: under a supervisor that line goes to the check-in digest without a decider session" '[ "$hand" = "T-21 needs config §3 autopilot-merge, which is \"ask\"" ]'
q set T-21 merge_after=OPS-9
mpj "$T/config-ask.md"
check "DS-407 AC1: with no merge driver, a green PR waiting on the person's step is held, never put to them to merge" 'js ".waiting[]" | grep -qF "T-21: MERGE HELD — PR #121 is out of draft and green, but it merges only after your step OPS-9 is Done in Jira: do not merge it yet" && ! js ".waiting[]" | grep -q "T-21: READY TO MERGE"'
q set T-21 merge_after=null

q set-batch approved.merge=true
mloop "$T/config-no.md"
check "DS-203 AC4: a batch approval never outranks a §3 no" '[ $rc -eq 1 ] && echo "$out" | grep -qF "FAIL: config §3 autopilot-merge is \"no\"" && [ ! -s "$T/merges.log" ]'
out=$(DESK_CONFIG="$T/config-no.md" node "$B/desk-env.mjs" merge-grant); rc=$?
check "DS-203 AC4: at no nothing merges, and the reason names the row at no" '[ $rc -eq 1 ] && [ "$out" = "$(printf "none\tconfig §3 autopilot-merge is \"no\"")" ]'
mpj "$T/config-ask.md"
check "DS-203 AC2: approved, the pass leaves green PRs to the merge driver" '! js ".waiting[]" | grep -q "READY TO MERGE"'
mloop "$T/config-ask.md"
check "DS-203 AC2: approved at Stage 3, the driver starts though both rows are ask" '[ $rc -eq 0 ] && echo "$out" | grep -q "merge-by=batch" && echo "$out" | grep -q "#121 green at b11111111 — confirming"'
mloop "$T/config-ask.md"
check "DS-203 AC2: the green PR merges with no further question, pinned to its head" '[ "$(merged)" = 121 ] && grep -qx "121 main $SHA21" "$T/merges.log"'
check "DS-203 AC2: the merge is noted in batch-notes.md" 'grep -qxF -- "- [T-21] merged #121 at $SHA21: $ASKED, and merging was approved for this batch at Stage 3" "$T/state/batch-notes.md"'
mloop "$T/config-ask.md"
check "DS-203 AC5: changes requested or an unresolved thread still hold a PR under the approval" '[ "$(merged)" = 121 ] && echo "$out" | grep -q "#122 has outstanding review feedback (CHANGES_REQUESTED, 0 unresolved)" && echo "$out" | grep -q "#123 has outstanding review feedback (APPROVED, 1 unresolved)"'
q init merge-ask-2
q add T-21 Task A; q set T-21 branch=fix/T-21 state=done result.pr=121
jq '."121".state = "open"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
mloop "$T/config-ask.md"
check "DS-203 AC6: a new batch carries no approval, so it is asked again" '[ $rc -eq 1 ] && echo "$out" | grep -qF "with no batch approval" && [ "$(merged)" = 121 ]'

# ---- DS-336: a ticket whose last open PR the driver merges goes to §4 Done state -------------------
sed -e 's/| Tracker | `none` |/| Tracker | `jira` |/' "$T/config.md" \
  | awk '{ print } /^\| `pr-ready`/ { print "| `jira-close-own-merged` | Close own merged | `yes` | `yes` |"; print "| `gh-close-linked-issue` | Close linked issue | `yes` | `yes` |" } /^\| Tracker/ { print "| Done state | `Done` |"; print "| Jira project | `T` |" }' > "$T/config-close.md"
sed -e 's/| `jira-close-own-merged` | Close own merged | `yes` | `yes` |/| `jira-close-own-merged` | Close own merged | `yes` | `ask` |/' "$T/config-close.md" > "$T/config-noclose.md"
stub_jira_close
printf '[{"object": {"url": "https://github.com/acme/widgets/issues/7"}}, {"object": {"url": "https://github.com/other/repo/issues/8"}}]' > "$T/jira-links/T-31"
SHA31=c111111111111111111111111111111111111111; SHA32=c222222222222222222222222222222222222222
SHA33=c333333333333333333333333333333333333333; SHA34=c444444444444444444444444444444444444444
cat > "$T/prs.json" <<EOF
{
  "131": { "head": "fix/T-31", "base": "main", "sha": "$SHA31", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "132": { "head": "fix/T-32", "base": "main", "sha": "$SHA32", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "133": { "head": "fix/T-32-more", "base": "release", "author": "colleague", "sha": "$SHA33", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
q init merge-close
for k in T-31 T-32 T-34; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
q add T-33 Bug A; q set T-33 state=done
: > "$T/merges.log"; : > "$T/jira-close.log"
cloop(){ out=$(DESK_CONFIG="$1" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-31" 2>&1); rc=$?; }
cloop "$T/config-close.md"; cloop "$T/config-close.md"
check "DS-336 AC1: the merged ticket is moved to Done and read back"  '[ "$(merged)" = 131 ] && grep -qx "transition T-31 Done" "$T/jira-close.log" && [ "$(cat "$T/jira-status/T-31")" = Done ] && echo "$out" | grep -q "#131 T-31 moved to Done (read back; §3 jira-close-own-merged)"'
check "DS-336 AC1: the status is read again after the transition"     '[ "$(grep -c "^get T-31 --json" "$T/jira-close.log")" = 2 ]'
check "DS-502 AC1: once Done, the issue the ticket links is closed naming it and its PR" 'grep -qxF "issue close 7 --repo acme/widgets --comment Closed by desk: every ticket filed for this issue is done: T-31 (#131)." "$T/gh.log" && echo "$out" | grep -qF "#131 T-31 acme/widgets#7 closed: "'
check "DS-502 AC4: the issue it links in another repo is not touched" '! grep -qE "issue (view|close) 8" "$T/gh.log"'
cloop "$T/config-close.md"
check "DS-336 AC2: another PR open on the key, by anyone and on any base, leaves the ticket as it is" '[ "$(merged)" = "131 132" ] && ! grep -q "transition T-32" "$T/jira-close.log" && echo "$out" | grep -q "#132 T-32 left as it is: #133 still open on the key"'
jq --arg s "$SHA34" '. + { "134": { head: "fix/T-34", base: "main", sha: $s, state: "open", draft: false, checks: [["test", "SUCCESS"]] } }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
cloop "$T/config-noclose.md"; cloop "$T/config-noclose.md"
check "DS-336 AC3: with jira-close-own-merged not yes, a merge moves nothing" '[ "$(merged)" = "131 132 134" ] && ! grep -q "T-34" "$T/jira-close.log" && echo "$out" | grep -q "#134 T-34 left as it is: config §3 jira-close-own-merged is ask"'
mpj "$T/config-close.md"
check "DS-336 AC4: a ticket done with no PR merged (a triage already-fixed) is never closed" '! grep -q "T-33" "$T/jira-close.log" && [ "$(grep -c "^transition" "$T/jira-close.log")" = 1 ]'

# ---- DS-347: a clean desk-review verdict at the head settles the desk-review threads before it -----
# The payloads are #282 and #271's real GraphQL responses (review-threads.mjs query): a round-4 P0
# thread, fixed, with clean verdicts since. They were recorded after the threads were resolved by
# hand on 2026-10-30, so this copy reads them unresolved, as they stood when the merges stuck.
sed -e 's/| GitHub handle | `tester` |/| GitHub handle | `bigbenjoman` |/' "$T/config.md" > "$T/config-threads.md"
echo '| Clean review verdict | `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0` |' >> "$T/config-threads.md"
FX="$T/fixtures"; H282=3cdbb0d2756940c6579c70f60fea68b36f8d19a7; H271=1088c7a85aa3ec1c8ed4ce97114412c4e57168bd
mkdir -p "$FX"
jq '.data.repository.pullRequest.reviewThreads.nodes[].isResolved = false' "$S/fixtures/review-threads-282.json" > "$FX/review-threads-282.json"
jq '.data.repository.pullRequest.reviewThreads.nodes[].isResolved = false' "$S/fixtures/review-threads-271.json" > "$FX/review-threads-271.json"
SHA43=d333333333333333333333333333333333333333
cat > "$T/prs.json" <<EOF
{
  "141": { "head": "fix/T-41", "base": "main", "author": "bigbenjoman", "sha": "$H282", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]],
           "payload": "$FX/review-threads-282.json" },
  "142": { "head": "fix/T-42", "base": "main", "author": "bigbenjoman", "sha": "$H271", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]],
           "payload": "$FX/review-threads-271.json",
           "extra": [{ "id": "human", "isResolved": false, "isOutdated": false, "path": "desk/bin/pass.mjs", "line": 970,
                       "comments": { "nodes": [{ "author": { "login": "colleague" }, "body": "Why does this hold not show in desk-q?\nIt reads as merging.", "pullRequestReview": { "id": "PRR_colleague" } }] } }] },
  "143": { "head": "fix/T-43", "base": "main", "author": "bigbenjoman", "sha": "$SHA43", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]],
           "payload": "$FX/review-threads-282.json" }
}
EOF
q init merge-threads
for k in T-41 T-42 T-43; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; : > "$T/gh.log"; rm -f "$T/resolved.log"
tloop(){ out=$(DESK_CONFIG="$T/config-threads.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-41 T-42 T-43" 2>&1); rc=$?; }
tloop
check "DS-347 AC1: #282's fixed P0 thread is resolved once the clean verdict is at its head" 'grep -qx "141-PRRT_kwDOUtzuUs6xubre" "$T/resolved.log" && echo "$out" | grep -qF "#141 resolved desk-review thread desk/bin/desk-q.mjs:1227 \"**P0** This reads the raw cache." && echo "$out" | grep -q "settles it$"'
check "DS-347 AC1: with it resolved, the driver counts nothing unresolved and holds #282 as green" '! echo "$out" | grep -q "#141 has outstanding review feedback" && echo "$out" | grep -q "#141 green at 3cdbb0d27 — confirming"'
check "DS-347 AC1: #271's outdated P0 thread is resolved too"         'grep -qx "142-PRRT_kwDOUtzuUs6xoZmC" "$T/resolved.log" && echo "$out" | grep -qF "#142 resolved desk-review thread desk/bin/pass.mjs:968"'
check "DS-347 AC2: a thread a colleague opened stays unresolved and still holds the PR" '! grep -q "142-human" "$T/resolved.log" && echo "$out" | grep -q "#142 has outstanding review feedback (NONE, 1 unresolved)"'
check "DS-347: a clean verdict for an older head settles nothing"     '! grep -q "^143-" "$T/resolved.log" && echo "$out" | grep -q "#143 has outstanding review feedback (NONE, 1 unresolved)"'
check "DS-347 AC3: one refusal is not yet the person'\''s"            '[ "$(qf T-42 .merge_blocked)" = null ]'
tloop
check "DS-347 AC1: #282 merges, and its thread is not resolved twice" '[ "$(merged)" = 141 ] && [ "$(grep -c "resolveReviewThread" "$T/gh.log")" = 2 ]'
tloop
check "DS-347 AC3: refused on two loops while green, the PR is recorded for the person with the thread" '[ "$(qf T-42 .merge_blocked)" = "review feedback: 1 unresolved thread on a green PR, first desk/bin/pass.mjs:970 \"Why does this hold not show in desk-q?\"" ]'
echo "142-human" >> "$T/resolved.log"
tloop
check "DS-347 AC3: once the thread is resolved, the record is cleared and the PR goes on to merge" '[ "$(qf T-42 .merge_blocked)" = null ] && echo "$out" | grep -q "#142 green at 1088c7a85 — confirming"'
# A thread GitHub refuses to resolve still holds the PR, and says so.
jq '."143".sha = "'"$H282"'" | ."143".extra = [{ id: "REFUSED", isResolved: false, path: "src/b.ts", line: 2, comments: { nodes: [{ author: { login: "bigbenjoman" }, body: "**P1**: x", pullRequestReview: { id: "PRR_kwDOUtzuUs8AAAABU_uh9Q" } }] } }]' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
tloop; tloop   # the first merges #142, so only the second reaches #143
check "DS-347: a thread GitHub refuses to resolve still holds the PR"  'echo "$out" | grep -qF "#143 could not resolve desk-review thread src/b.ts:2" && echo "$out" | grep -q "#143 has outstanding review feedback (NONE, 1 unresolved)"'

finish approval
