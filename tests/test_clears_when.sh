#!/usr/bin/env bash
# suite: clears-when (a park says what clears it, and a pass settles it without a model)
# A worker's AUTOPILOT_PARK_CLEARS_WHEN is stored on its park, and queue.mjs clears-when sets one. Each
# pass checks every recorded condition: a lane C or D park stays for a person, one whose own PR merged
# is recorded done, any other is requeued, and a check that cannot run leaves the park as it is. The
# decider may record one, and gets an answer to a park it was never handed. Runs the real pass.mjs
# with stub claude, gh and desk-jira. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt" "$T/gh" "$T/jira"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_START_STAGE DESK_GITHUB_HANDLE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`git-push\` | Push the ticket's branch | \`yes\` | \`yes\` |
| \`git-force-with-lease\` | Force-push with a lease | \`ask\` | \`ask\` |
EOF

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
printf 'echo "[spawn] ticket=$1"\n' > "$T/desk/bin/spawn-worker.sh"
printf '#!/bin/sh\necho "[]"\n' > "$T/stub/claude"
# gh: a PR is $T/gh/pr-<n>.json (none is a failed read), a branch's merged PR $T/gh/merged-<branch with
# / as _>, the repo's variables $T/gh/vars.json ($T/gh/vars.fail fails the read), an Actions run
# $T/gh/run-<id>.json (none is a failed read). Anything else answers nothing.
cat > "$T/stub/gh" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "pr view") [ -f "$T/gh/pr-\$3.json" ] && { cat "$T/gh/pr-\$3.json"; exit 0; }; echo "gh: HTTP 502 for PR \$3" >&2; exit 1 ;;
  "pr list") h=""; while [ \$# -gt 0 ]; do [ "\$1" = --head ] && h="\$2"; shift; done
    [ -n "\$h" ] || { echo "[]"; exit 0; }
    f="$T/gh/merged-\$(echo "\$h" | tr / _)"; [ -f "\$f" ] && cat "\$f"; exit 0 ;;
  "variable list") [ -f "$T/gh/vars.fail" ] && { echo "gh: HTTP 401: Bad credentials" >&2; exit 1; }
    cat "$T/gh/vars.json" 2>/dev/null || echo "[]"; exit 0 ;;
  "run view") [ -f "$T/gh/run-\$3.json" ] && { cat "$T/gh/run-\$3.json"; exit 0; }; echo "gh: HTTP 404: run \$3 not found" >&2; exit 1 ;;
esac
exit 0
EOF
# desk-jira get <KEY> --json: $T/jira/<KEY>.json, or unreachable.
cat > "$T/stub/desk-jira" <<EOF
#!/bin/sh
[ -f "$T/jira/\$2.json" ] && { cat "$T/jira/\$2.json"; exit 0; }; echo "desk-jira: unreachable" >&2; exit 1
EOF
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/desk-jira"
pr(){ printf '{"state":"%s","isDraft":%s,"statusCheckRollup":[]}\n' "$2" "$3" > "$T/gh/pr-$1.json"; }
run(){ printf '{"status":"%s","conclusion":"%s"}\n' "$2" "$3" > "$T/gh/run-$1.json"; }
jira(){ printf '{"key":"%s","fields":{"status":{"name":"%s","statusCategory":{"key":"%s"}}}}\n' "$1" "$2" "$3" > "$T/jira/$1.json"; }

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
say(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv.slice(1).join("\n") }] } }))' "$@"; }
# parked <KEY> <lane> <question> [<clears-when>]
parked(){ q add "$1" Story "$2"; q park "$1" "$3"; q set "$1" "branch=feat/$1"; [ $# -lt 4 ] || q clears-when "$1" "$4"; }

# Nothing spawns, so a requeued ticket stays where the pass put it.
q init cw; q set-batch concurrency=0

# ---- AC2: a worker's park records what clears it --------------------------------------------------
q add C-1 Story A; q set C-1 state=running branch=feat/C-1 session_id=gone
say "AUTOPILOT_PARK: waiting on PR #41, the shared helper" "AUTOPILOT_PARK_CLEARS_WHEN: pr 41 merged" > "$T/state/logs/C-1.log"
q add C-2 Story A; q set C-2 state=running branch=feat/C-2 session_id=gone
say "AUTOPILOT_PARK: waiting on the weather" "AUTOPILOT_PARK_CLEARS_WHEN: when it rains" > "$T/state/logs/C-2.log"
q add C-3 Story A; q set C-3 state=running branch=feat/C-3 session_id=gone
say "AUTOPILOT_PARK_CLEARS_WHEN: pr 3 merged" "AUTOPILOT_PARK: which copy?" > "$T/state/logs/C-3.log"
pr 41 OPEN true

out=$(node "$B/queue.mjs" clears-when C-1 "pr 41 merged" 2>&1); rc=$?
check "queue.mjs clears-when refuses a ticket that is not parked" '[ $rc -ne 0 ] && grep -q "is not parked" <<< "$out"'

# ---- AC4: lane C or D stays; AC6: a failed check or none leaves the park; AC7: VPL-555's case -------
parked D-1 C "which of two layouts?" "ticket ABC-9 done"; jira ABC-9 Done "done"
parked E-1 A "waiting on PR 77" "pr 77 merged"
parked E-2 A "a product call" "none"
parked E-3 A "waiting on ABC-404" "ticket ABC-404 done"
parked E-4 A "waiting on ABC-10" "ticket ABC-10 done"; jira ABC-10 "In Progress" indeterminate
parked V-1 A "set DESK_DEPLOY_ON=local" "variable DESK_DEPLOY_ON set"; q set V-1 draft_pr=699
pr 699 MERGED false; echo '[{"name":"DESK_DEPLOY_ON"}]' > "$T/gh/vars.json"
# DS-349: a park that waits on an Actions run
parked R-1 A "waiting on e2e run 41048026730" "run 41048026730 completed"; run 41048026730 completed failure
parked R-2 A "waiting on e2e run 41048026731" "run 41048026731 completed"; run 41048026731 in_progress ""
parked R-3 A "waiting on e2e run 41048026732" "run 41048026732 completed"
parked W-1 B "waiting on review of #706" "pr 706 ready"; pr 706 OPEN false; echo 707 > "$T/gh/merged-feat_W-1"; pr 707 MERGED false
# DS-496: a park on a refused push. A real origin, whose pre-receive hook prints $T/gh/refuse-<branch
# with / as _> and refuses, so git reports it as a worker's push would see it.
git init -q --bare "$T/origin.git"; git -C "$T/repo" remote add origin "$T/origin.git"
cat > "$T/origin.git/hooks/pre-receive" <<EOF
#!/bin/sh
while read -r _ _ ref; do
  f="$T/gh/refuse-\$(echo "\${ref#refs/heads/}" | tr / _)"
  [ -f "\$f" ] && { cat "\$f" >&2; exit 1; }
done
exit 0
EOF
chmod +x "$T/origin.git/hooks/pre-receive"
on_origin(){ git -C "$T/origin.git" rev-parse --verify -q "refs/heads/feat/$1" >/dev/null; }
# pushpark <KEY> <lane> [<clears-when>]
pushpark(){ parked "$1" "$2" "GitHub refused the push of feat/$1 with a 5xx" "${3:-git push origin feat/$1 succeeds}"; git -C "$T/repo" branch "feat/$1"; q set "$1" "worktree=$T/repo"; }
pushpark P-1 A
pushpark P-2 A; echo "Internal Server Error" > "$T/gh/refuse-feat_P-2"
pushpark P-3 A; echo "branch is protected" > "$T/gh/refuse-feat_P-3"
PIN=$(printf a%.0s {1..40})
pushpark P-4 A "git push --force-with-lease=feat/P-4:$PIN origin feat/P-4 succeeds"
pushpark P-5 C
pushpark P-6 A "git push origin feat/other succeeds"
# P-8: a person's one-off grant for this branch and SHA, with §3's lease row at ask. P-9: a grant for another SHA.
HELD=$(git -C "$T/repo" rev-parse HEAD); REWRITTEN=$(git -C "$T/repo" commit-tree "$HELD^{tree}" -m rewritten)
git -C "$T/repo" push -q origin "$HELD:refs/heads/feat/P-8"
pushpark P-8 A "git push --force-with-lease=feat/P-8:$HELD origin feat/P-8 succeeds"; git -C "$T/repo" branch -f feat/P-8 "$REWRITTEN"
q set P-8 "grant={\"step\":\"force-push\",\"branch\":\"feat/P-8\",\"lease\":\"$HELD\",\"at\":\"2026-11-01T00:00:00Z\"}"
pushpark P-9 A "git push --force-with-lease=feat/P-9:$HELD origin feat/P-9 succeeds"
q set P-9 "grant={\"step\":\"force-push\",\"branch\":\"feat/P-9\",\"lease\":\"$PIN\",\"at\":\"2026-11-01T00:00:00Z\"}"
q add C-4 Story A; q set C-4 state=running branch=feat/C-4 session_id=gone
say "AUTOPILOT_PARK: GitHub refused the push of feat/C-4 with a 5xx" "AUTOPILOT_PARK_CLEARS_WHEN: git push -u origin feat/C-4 succeeds" > "$T/state/logs/C-4.log"
out=$(node "$B/queue.mjs" clears-when E-2 "when it rains" 2>&1); rc=$?
check "queue.mjs clears-when refuses a condition it cannot read, naming the forms" '[ $rc -ne 0 ] && grep -q "pr <n> merged, pr <n> ready, ticket <KEY> done, variable <NAME> set, run <id> completed, git push origin <branch> succeeds, or none" <<< "$out"'
check "DS-496 queue.mjs clears-when stores a push" '[ "$(field P-1 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-1\"}" ]'
check "DS-496 and a lease push, with the SHA it may overwrite" '[ "$(field P-4 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-4\",\"lease\":\"$PIN\"}" ]'
out=$(node "$B/queue.mjs" clears-when E-2 "git push --force-with-lease origin feat/P-4 succeeds" 2>&1); rc=$?
check "DS-496 a lease naming no SHA is refused: a pass would overwrite whatever the tracking ref says" '[ $rc -ne 0 ]'
out=$(node "$B/queue.mjs" clears-when E-2 "git push --force-with-lease=feat/other:$PIN origin feat/P-4 succeeds" 2>&1); rc=$?
check "DS-496 and one whose lease names another branch" '[ $rc -ne 0 ]'
out=$(node "$B/queue.mjs" clears-when E-2 "run abc completed" 2>&1); rc=$?
check "DS-349 AC10 a run id that is not a number is refused, naming the forms" '[ $rc -ne 0 ] && grep -q "\"run abc completed\" is not one of: .*run <id> completed, .*or none" <<< "$out"'
check "DS-349 queue.mjs clears-when stores a run" '[ "$(field R-1 park.clears_when)" = "{\"kind\":\"run-completed\",\"run\":41048026730}" ]'
check "queue.mjs clears-when stores the condition on the park" '[ "$(field D-1 park.clears_when)" = "{\"kind\":\"ticket-done\",\"ticket\":\"ABC-9\"}" ]'

out=$(node "$B/pass.mjs" 2>&1)
check "DS-269 AC2 a worker's park records its condition" '[ "$(field C-1 state)" = "\"parked\"" ] && [ "$(field C-1 park.clears_when)" = "{\"kind\":\"pr-merged\",\"pr\":41}" ]'
check "DS-269 AC2 an unreadable condition is recorded as none and reported" '[ "$(field C-2 park.clears_when)" = "{\"kind\":\"none\"}" ] && grep -q "C-2: unreadable clears-when (\"when it rains\" is not one of" <<< "$out"'
check "DS-269 AC2 a condition printed before the last park is not that park's" '[ "$(field C-3 park.clears_when)" = "{\"kind\":\"none\"}" ]'
check "DS-269 a condition that does not hold yet says nothing and leaves the park" '! grep -q "C-1: \"" <<< "$out" && ! grep -q "E-4: \"\|E-4: could not" <<< "$out" && [ "$(field E-4 state)" = "\"parked\"" ]'
check "DS-269 AC4 a lane C park whose condition holds stays, and the report says so" '[ "$(field D-1 state)" = "\"parked\"" ] && grep -q "D-1: \"ABC-9 done\" holds, but it is lane C: left parked for a person" <<< "$out"'
check "DS-269 AC6 a failed gh check leaves the park and is named" '[ "$(field E-1 state)" = "\"parked\"" ] && grep -q "E-1: could not check \"PR #77 merged\" (gh pr view 77: gh: HTTP 502 for PR 77): left parked" <<< "$out"'
check "DS-269 AC6 a failed Jira check leaves the park and is named" '[ "$(field E-3 state)" = "\"parked\"" ] && grep -q "E-3: could not check \"ABC-404 done\" (desk-jira get ABC-404: desk-jira: unreachable): left parked" <<< "$out"'
check "DS-269 AC6 a park with none is left alone and not reported" '[ "$(field E-2 state)" = "\"parked\"" ] && ! grep -q "E-2: \"\|E-2: could not" <<< "$out"'
check "DS-269 AC7 a variable set and its own PR merged: recorded done, no person" '[ "$(field V-1 state)" = "\"done\"" ] && [ "$(field V-1 result.pr)" = 699 ] && [ "$(field V-1 park)" = null ] && grep -q "V-1: \"repo variable DESK_DEPLOY_ON set\" holds and its PR #699 merged: recorded done" <<< "$out"'
check "DS-269 AC3 an own PR found merged from the branch closes it out" '[ "$(field W-1 state)" = "\"done\"" ] && [ "$(field W-1 result.pr)" = 707 ] && grep -q "W-1: \"PR #706 out of draft\" holds and its PR #707 merged: recorded done" <<< "$out"'
check "DS-349 AC8 a finished run: requeued with no person, and the report names its conclusion" \
  '[ "$(field R-1 state)" = "\"triaged\"" ] && grep -q "R-1: \"Actions run 41048026730 completed, conclusion failure\" holds: requeued" <<< "$out"'
check "DS-349 AC8 the next worker is told the run's conclusion" \
  '[ "$(field R-1 cleared.what)" = "\"Actions run 41048026730 completed, conclusion failure\"" ] && [ "$(field R-1 prev_park.question)" = "\"waiting on e2e run 41048026730\"" ]'
check "DS-349 AC9 a run in progress: the park stays, and the report shows it waiting" \
  '[ "$(field R-2 state)" = "\"parked\"" ] && grep -q "R-2: waiting on \"Actions run 41048026731 completed\" (still in_progress): left parked" <<< "$out"'
check "DS-349 a run that cannot be read leaves the park and is named" \
  '[ "$(field R-3 state)" = "\"parked\"" ] && grep -q "R-3: could not check \"Actions run 41048026732 completed\" (gh run view 41048026732: gh: HTTP 404: run 41048026732 not found): left parked" <<< "$out"'
check "DS-269 the report groups them under clears-when" 'grep -q "^clears-when:$" <<< "$out"'
check "DS-496 AC2 the pass makes the push, requeues, and tells the next worker" \
  'on_origin P-1 && [ "$(field P-1 state)" = "\"triaged\"" ] && [ "$(field P-1 branch)" = "\"feat/P-1\"" ] && [ "$(field P-1 cleared.what)" = "\"git push origin feat/P-1 succeeds\"" ] && grep -q "P-1: \"git push origin feat/P-1 succeeds\" holds: requeued" <<< "$out"'
check "DS-496 AC2 another 5xx: the park stays, its condition kept for the next pass" \
  '! on_origin P-2 && [ "$(field P-2 state)" = "\"parked\"" ] && [ "$(field P-2 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-2\"}" ] && grep -q "P-2: waiting on \"git push origin feat/P-2 succeeds\" (GitHub still answers 5xx): left parked" <<< "$out"'
check "DS-496 AC3 any other refusal ends the tries and goes to a person" \
  '! on_origin P-3 && [ "$(field P-3 state)" = "\"parked\"" ] && [ "$(field P-3 park.clears_when)" = "{\"kind\":\"none\"}" ] && [[ "$(field P-3 park.recovery)" == *"git refused it"* ]] && grep -q "P-3: could not check \"git push origin feat/P-3 succeeds\"" <<< "$out"'
check "DS-496 a lease push §3 does not grant is not made, and says so" \
  '! on_origin P-4 && [ "$(field P-4 park.clears_when)" = "{\"kind\":\"none\"}" ] && grep -q "P-4: could not check \"git push --force-with-lease=feat/P-4:$PIN origin feat/P-4 succeeds\" (config §3 git-force-with-lease is \"ask\"): left parked" <<< "$out"'
check "DS-496 AC2 a one-off grant for that branch and SHA lets the pass make the lease push, and requeue" \
  '[ "$(git -C "$T/origin.git" rev-parse refs/heads/feat/P-8)" = "$REWRITTEN" ] && [ "$(field P-8 state)" = "\"triaged\"" ]'
check "DS-496 a grant for another SHA does not" \
  '! on_origin P-9 && [ "$(field P-9 park.clears_when)" = "{\"kind\":\"none\"}" ] && grep -q "P-9: could not check .*(config §3 git-force-with-lease is \"ask\"): left parked" <<< "$out"'
check "DS-496 a lane C park is not pushed for" \
  '! on_origin P-5 && [ "$(field P-5 state)" = "\"parked\"" ] && grep -q "P-5: \"git push origin feat/P-5 succeeds\" not tried, since it is lane C: left parked for a person" <<< "$out"'
check "DS-496 a condition naming another branch is not pushed" \
  '[ "$(field P-6 state)" = "\"parked\"" ] && ! git -C "$T/origin.git" rev-parse --verify -q refs/heads/feat/other >/dev/null && grep -q "P-6: could not check .*it names feat/other, and the ticket.s branch is feat/P-6" <<< "$out"'
check "DS-496 a worker's park line records a push, -u dropped, and with no worktree it goes to a person" \
  '[ "$(field C-4 state)" = "\"parked\"" ] && [ "$(field C-4 park.clears_when)" = "{\"kind\":\"none\"}" ] && grep -q "C-4: could not check \"git push origin feat/C-4 succeeds\" (it has no worktree to push from): left parked" <<< "$out"'

# ---- AC3: a lane A ticket waiting on something else is requeued ------------------------------------
pr 41 MERGED false
q add V-2 Story A; q park V-2 "set FOO"; q clears-when V-2 "variable FOO set"; touch "$T/gh/vars.fail"
rm "$T/gh/refuse-feat_P-2" "$T/gh/refuse-feat_P-3"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-496 AC2 the 5xx over: the next pass pushes and requeues" 'on_origin P-2 && [ "$(field P-2 state)" = "\"triaged\"" ]'
check "DS-496 AC3 a refusal is not tried again" '! on_origin P-3 && [ "$(field P-3 state)" = "\"parked\"" ]'
check "DS-269 AC3 C-1's PR merged: requeued, with one line naming the condition" '[ "$(field C-1 state)" = "\"triaged\"" ] && [ "$(grep -c "C-1: \"PR #41 merged\" holds: requeued" <<< "$out")" = 1 ]'
check "DS-269 AC6 a failed variable read leaves the park and is named" '[ "$(field V-2 state)" = "\"parked\"" ] && grep -q "V-2: could not check \"repo variable FOO set\" (gh variable list: gh: HTTP 401: Bad credentials): left parked" <<< "$out"'
check "DS-269 AC4 still lane C: never requeued" '[ "$(field D-1 state)" = "\"parked\"" ]'
pushpark P-7 A; out=$(AUTOPILOT_DRY_RUN=1 node "$B/pass.mjs" 2>&1)
check "DS-496 a dry run pushes nothing" '! on_origin P-7 && [ "$(field P-7 state)" = "\"parked\"" ]'
git -C "$T/repo" remote set-url origin https://127.0.0.1:1/nothing.git; out=$(node "$B/pass.mjs" 2>&1); git -C "$T/repo" remote set-url origin "$T/origin.git"
check "DS-496 a push that reached nothing keeps the park and its condition" \
  '[ "$(field P-7 state)" = "\"parked\"" ] && [ "$(field P-7 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-7\"}" ] && [ "$(field P-7 park.recovery)" = null ] && grep -q "P-7: could not check \"git push origin feat/P-7 succeeds\"" <<< "$out"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-496 and the next pass that reaches origin pushes it" 'on_origin P-7 && [ "$(field P-7 state)" = "\"triaged\"" ]'

# ---- the decider records a condition, and gets an answer to a park it was never handed --------------
node "$B/answer.mjs" E-2 "go with the second option" >/dev/null 2>&1
since=$(field E-2 park.since | tr -d '"')
r=$(node --input-type=module -e "
import { deciderSettings, deciderPrompt, freshItems, deciderItems } from '$B/decider.mjs';
const allow = deciderSettings({ bin: '/b', state: '/s' }).permissions.allow;
const prompt = deciderPrompt({ slug: 's', report: '', items: [], rules: '', bin: '/b' });
const items = deciderItems({ parked: [{ key: 'E-2', question: 'a product call' }] }, { tickets: { 'E-2': { lane: 'A', park: { since: '$since' } } } });
const later = deciderItems({ parked: [{ key: 'E-2', question: 'a product call' }] }, { tickets: { 'E-2': { lane: 'A', park: { since: '2999-01-01T00:00:00Z' } } } });
console.log([allow.includes('Bash(node /b/queue.mjs clears-when:*)'), prompt.includes('/b/queue.mjs clears-when <TICKET>'),
  freshItems('$T/state', items, {})[0].answers?.[0]?.text, freshItems('$T/state', later, {})[0].answers === undefined].join('|'));
")
check "DS-269 AC2 the decider may record a condition, and its prompt says how" '[ "$(cut -d"|" -f1,2 <<< "$r")" = "true|true" ]'
check "DS-269 AC5 an answer since a park never handed on goes to the decider with it" '[ "$(cut -d"|" -f3 <<< "$r")" = "go with the second option" ]'
check "DS-269 AC5 an answer from before the park does not" '[ "$(cut -d"|" -f4 <<< "$r")" = true ]'

echo "clears-when: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
