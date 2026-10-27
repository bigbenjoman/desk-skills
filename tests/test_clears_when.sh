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
EOF

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
printf 'echo "[spawn] ticket=$1"\n' > "$T/desk/bin/spawn-worker.sh"
printf '#!/bin/sh\necho "[]"\n' > "$T/stub/claude"
# gh: a PR is $T/gh/pr-<n>.json (none is a failed read), a branch's merged PR $T/gh/merged-<branch with
# / as _>, the repo's variables $T/gh/vars.json ($T/gh/vars.fail fails the read). Anything else answers nothing.
cat > "$T/stub/gh" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "pr view") [ -f "$T/gh/pr-\$3.json" ] && { cat "$T/gh/pr-\$3.json"; exit 0; }; echo "gh: HTTP 502 for PR \$3" >&2; exit 1 ;;
  "pr list") h=""; while [ \$# -gt 0 ]; do [ "\$1" = --head ] && h="\$2"; shift; done
    [ -n "\$h" ] || { echo "[]"; exit 0; }
    f="$T/gh/merged-\$(echo "\$h" | tr / _)"; [ -f "\$f" ] && cat "\$f"; exit 0 ;;
  "variable list") [ -f "$T/gh/vars.fail" ] && { echo "gh: HTTP 401: Bad credentials" >&2; exit 1; }
    cat "$T/gh/vars.json" 2>/dev/null || echo "[]"; exit 0 ;;
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
parked W-1 B "waiting on review of #706" "pr 706 ready"; pr 706 OPEN false; echo 707 > "$T/gh/merged-feat_W-1"; pr 707 MERGED false
out=$(node "$B/queue.mjs" clears-when E-2 "when it rains" 2>&1); rc=$?
check "queue.mjs clears-when refuses a condition it cannot read, naming the forms" '[ $rc -ne 0 ] && grep -q "pr <n> merged, pr <n> ready, ticket <KEY> done, variable <NAME> set, or none" <<< "$out"'
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
check "DS-269 the report groups them under clears-when" 'grep -q "^clears-when:$" <<< "$out"'

# ---- AC3: a lane A ticket waiting on something else is requeued ------------------------------------
pr 41 MERGED false
q add V-2 Story A; q park V-2 "set FOO"; q clears-when V-2 "variable FOO set"; touch "$T/gh/vars.fail"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-269 AC3 C-1's PR merged: requeued, with one line naming the condition" '[ "$(field C-1 state)" = "\"triaged\"" ] && [ "$(grep -c "C-1: \"PR #41 merged\" holds: requeued" <<< "$out")" = 1 ]'
check "DS-269 AC6 a failed variable read leaves the park and is named" '[ "$(field V-2 state)" = "\"parked\"" ] && grep -q "V-2: could not check \"repo variable FOO set\" (gh variable list: gh: HTTP 401: Bad credentials): left parked" <<< "$out"'
check "DS-269 AC4 still lane C: never requeued" '[ "$(field D-1 state)" = "\"parked\"" ]'

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
