#!/usr/bin/env bash
# suite: outside blockers (plan-batch acts on triage's blocker_needs for an open blocker in no batch)
# plan-batch on fixture triage records, offline: a blocker triage found not needed starts the ticket
# with a logged decision under §3 autopilot-judgement yes, a needed one holds it outside the batch
# with no question, and one triage did not judge is asked as before. Scratch HOME, state and queue only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/triage"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_JIRA_NAME AUTOPILOT_WRITE_QUEUE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=${rc:-} out: ${out:-}"; fi; }
trap 'rm -rf "$T"' EXIT

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
# config <autopilot-judgement setting>
config(){ cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 1. Who you are
| Field | Value |
|---|---|
| GitHub handle | \`me\` |
| Jira display name | \`Me\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-judgement\` | Take calls outside the ask categories | \`yes\` | \`$1\` |

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`[A-Z]+-[0-9]+\` |
| Local database | \`none\` |
EOF
}
export DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1

# rec <KEY> <blockers json> [blocker_needs json]
rec(){ printf '{"ticket": "%s", "type": "Task", "lane": "A", "size": "S", "summary": "s", "branch": "feat/%s", "change_kind": "surface", "files_in_scope": ["src/%s"], "unknowns": [], "blockers": %s%s}\n' \
  "$1" "$1" "$1" "$2" "${3:+, \"blocker_needs\": $3}" > "$T/state/triage/$1.json"; }
plan(){ rm -f "$DESK_QUEUE" "$T/state/decisions.jsonl"; node "$B/queue.mjs" init "t$RANDOM" >/dev/null; out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" "$@" 2>&1); rc=$?; }
qg(){ jq -r ".tickets[\"$1\"]$2" "$DESK_QUEUE"; }
decisions(){ jq -sc "$1" "$T/state/decisions.jsonl" 2>/dev/null; }

rec SV-3988 '[{"key": "SV-2295", "category": "new"}, {"key": "SV-3655", "category": "indeterminate"}]' \
  '{"SV-2295": {"needs": false, "why": "holds the ticket but touches none of its files"}, "SV-3655": {"needs": false, "why": "same area, no shared file"}}'
rec SV-3985 '[{"key": "SV-3629", "category": "indeterminate"}]' '{"SV-3629": {"needs": true, "why": "builds the arm runners it calls"}}'
rec SV-3990 '[{"key": "SV-3700", "category": "new"}]'
rec SV-3991 '[{"key": "SV-3701", "category": "new"}]' '{"SV-3999": {"needs": false, "why": "another blocker"}}'

# ---- AC1: not needed, under autopilot-judgement yes: no question, a decision logged ------------------
config yes
plan SV-3988
check "AC1: a blocker triage found not needed is no question, and the ticket can start" \
  '[ $rc -eq 0 ] && [ "$(qg SV-3988 .state)" = triaged ] && [ "$(qg SV-3988 .open_questions)" = 0 ] && [ "$(qg SV-3988 .held_by)" = null ] && printf "%s" "$out" | grep -q "^QUESTIONS — none"'
check "AC1: the plan notes it starts without each, with triage's reason" \
  'printf "%s\n" "$out" | grep -qF "  ~ starts without blocker SV-2295 (not started, not in this batch): triage found it is not needed (holds the ticket but touches none of its files)" && printf "%s\n" "$out" | grep -qF "  ~ starts without blocker SV-3655 (in progress, not in this batch)"'
check "AC1: an engineering decision \"start without <KEY>\" is logged for each blocker" \
  '[ "$(decisions "[.[] | select(.ticket == \"SV-3988\") | [.chose, .category, .source]]")" = "[[\"start without SV-2295\",\"engineering\",\"triage\"],[\"start without SV-3655\",\"engineering\",\"triage\"]]" ]'
plan SV-3988
check "AC1: planning the batch again logs each decision once" '[ "$(decisions length)" = 2 ]'
rm -f "$T/state/decisions.jsonl"; out=$(node "$B/plan-batch.mjs" SV-3988 2>&1); rc=$?
check "AC1: a plan that does not seed the queue logs nothing" '[ $rc -eq 0 ] && [ ! -f "$T/state/decisions.jsonl" ]'

# ---- AC2: the same ticket without autopilot-judgement yes is asked about as today -------------------
config ask
plan SV-3988
check "AC2: without autopilot-judgement yes, each blocker is a question as today, and nothing is logged" \
  '[ $rc -eq 11 ] && [ "$(qg SV-3988 .open_questions)" = 2 ] && printf "%s\n" "$out" | grep -qF "[SV-3988] SV-3988 is blocked by SV-2295 (not started), which is not in this batch: add SV-2295 to the batch, or confirm SV-3988 can start without it" && [ ! -f "$T/state/decisions.jsonl" ]'

# ---- AC3: needed: held outside the batch, with no question -----------------------------------------
for j in yes ask; do
  config "$j"
  plan SV-3985
  check "AC3 (autopilot-judgement $j): a needed blocker holds the ticket with no question" \
    '[ $rc -eq 0 ] && [ "$(qg SV-3985 .state)" = parked ] && [ "$(qg SV-3985 .open_questions)" = 0 ] && printf "%s" "$out" | grep -q "^QUESTIONS — none"'
  check "AC3 (autopilot-judgement $j): it is held as intake holds one, so the pass lifts it once the blocker is Done and on the base" \
    '[ "$(qg SV-3985 .held_by)" = SV-3629 ] && [ "$(qg SV-3985 .held_outside)" = SV-3629 ] && [ "$(qg SV-3985 .park.question)" = "held by orchestrator: blocked by SV-3629 (in progress, not in this batch; triage: builds the arm runners it calls) — starts once SV-3629 is Done and on the base" ]'
done
check "AC3: the plan says it is held, and it is not in the --deps for the merge driver" \
  'printf "%s\n" "$out" | grep -qF "HELD (blocked by SV-3629 — starts once SV-3629 is Done and on the base)" && ! printf "%s" "$out" | grep -q -- "--deps"'

# A needed blocker outside the batch and one inside it: held behind both, and the driver gets only the one inside.
rec SV-4001 '[]'
rec SV-4000 '[{"key": "SV-4001", "category": "new"}, {"key": "SV-3629", "category": "indeterminate"}]' '{"SV-3629": {"needs": true, "why": "needs its runners"}}'
config yes
plan SV-4000 SV-4001
check "AC3: held behind a blocker in the batch and a needed one outside it, each recorded where its release reads it" \
  '[ "$(qg SV-4000 .held_by)" = "SV-4001|SV-3629" ] && [ "$(qg SV-4000 .held_outside)" = SV-3629 ] && printf "%s\n" "$out" | grep -qx -- "--deps \"SV-4000:SV-4001\"" && [[ "$(qg SV-4000 .park.question)" == *"— starts once their PRs merge, and SV-3629 is Done and on the base" ]]'

# ---- AC4: no judgement recorded for the blocker: asked as today ------------------------------------
plan SV-3990 SV-3991
check "AC4: a blocker with no blocker_needs entry is a question as today" \
  '[ $rc -eq 11 ] && [ "$(qg SV-3990 .open_questions)" = 1 ] && [ "$(qg SV-3991 .open_questions)" = 1 ] && [ "$(qg SV-3990 .held_outside)" = null ] && printf "%s\n" "$out" | grep -qF "[SV-3991] SV-3991 is blocked by SV-3701 (not started), which is not in this batch"'
rec SV-3992 '[{"key": "SV-3702", "category": "new"}]' '{"SV-3702": {"needs": "no"}}'
plan SV-3992
check "AC4: an entry with no boolean needs is not a judgement: asked as today" '[ $rc -eq 11 ] && [ "$(qg SV-3992 .open_questions)" = 1 ]'

echo "outside blockers: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
