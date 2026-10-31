#!/usr/bin/env bash
# suite: lane D (a design build runs on a worker when its canvas is saved)
# ticket-facts.mjs records what a ticket's Design section links and where each Claude Design canvas is
# saved; plan-batch queues a lane D ticket whose canvas is on the base branch or snapshotted, and parks
# one whose design is only in Figma or whose canvas is not on the base, naming which. queue.mjs requeues
# a lane D ticket its own worker parked, never one parked at triage, and the decider's prompt lets it.
# Scratch HOME, repo and state only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/triage" "$T/state/tickets"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_JIRA_NAME DESK_DESIGN_DIR AUTOPILOT_WRITE_QUEUE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=${rc:-} out: ${out:-}"; fi; }
trap 'rm -rf "$T"' EXIT

SAVED=https://claude.ai/design/p/saved-1
LOOSE=https://claude.ai/design/p/loose-2
SNAP=https://claude.ai/design/p/snap-3
git init -q -b main "$T/repo"
mkdir -p "$T/repo/docs/design/EPIC-1"
printf '{"url": "%s", "version": "1"}\n' "$SAVED" > "$T/repo/docs/design/EPIC-1/source.json"
printf '{"boards": [{"title": "Home", "width": 390, "file": "home.dc.html"}]}\n' > "$T/repo/docs/design/EPIC-1/canvas.json"
git -C "$T/repo" add -A; git -C "$T/repo" commit -q -m canvas
# Saved in the working tree only: not on the base a worker branches from.
mkdir -p "$T/repo/docs/design/EPIC-2"
printf '{"url": "%s", "version": "1"}\n' "$LOOSE" > "$T/repo/docs/design/EPIC-2/source.json"
mkdir -p "$T/state/designs/snap-ticket"
printf '{"url": "%s"}\n' "$SNAP" > "$T/state/designs/snap-ticket/source.json"

cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 1. Who you are
| Field | Value |
|---|---|
| GitHub handle | \`me\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Local database | \`none\` |
EOF
export DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1

# ticket <slug> <lane> <Design section text>: the ticket file, a triage record, then its facts.
ticket(){
  printf '# %s\n\nSource: the user, in this conversation\n\n## Outcome\nA new screen.\n\n## Design\n%s\n' "$1" "$3" > "$T/state/tickets/$1.md"
  printf '{"ticket": "%s", "type": "Story", "lane": "%s", "lane_reason": "a new screen from its design", "summary": "s", "branch": "feat/%s", "change_kind": "surface", "files_in_scope": ["src/%s"], "unknowns": []}\n' \
    "$1" "$2" "$1" "$1" > "$T/state/triage/$1.json"
  node "$B/ticket-facts.mjs" "$1" >/dev/null 2>&1; }
fact(){ jq -r ".design$2" "$T/state/triage/$1.json"; }
plan(){ node "$B/queue.mjs" init "t$RANDOM" >/dev/null; out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" "$@" 2>&1); rc=$?; }
qg(){ jq -r ".tickets[\"$1\"]$2" "$DESK_QUEUE"; }

ticket on-base D "Build it from $SAVED (docs/design/EPIC-1/)."
ticket snapped D "Build it from $SNAP"
ticket figma-only D "https://www.figma.com/design/abc/Screens?node-id=1-2"
ticket not-on-base D "Build it from $LOOSE"
ticket plan-first C "No UI."

check "facts: a canvas saved on the base is recorded with its folder" '[ "$(fact on-base ".canvases[0].saved")" = docs/design/EPIC-1/ ] && [ "$(fact on-base .ref)" = main ]'
check "facts: a snapshotted canvas is recorded with its snapshot" '[ "$(fact snapped ".canvases[0].snapshot")" = "$T/state/designs/snap-ticket" ]'
check "facts: a Figma frame is recorded, with no canvas" '[ "$(fact figma-only .figma)" = true ] && [ "$(fact figma-only ".canvases | length")" = 0 ]'
check "facts: a canvas only in the working tree is not on the base" '[ "$(fact not-on-base ".canvases[0].saved")" = null ] && [ "$(fact not-on-base ".canvases[0].snapshot")" = null ]'

plan on-base snapped figma-only not-on-base plan-first
check "AC1: a lane D ticket whose canvas is on the base is queued for a worker" '[ "$(qg on-base .state)" = triaged ] && [ "$(qg on-base .park)" = null ]'
check "AC1: so is one whose canvas the orchestrator snapshotted" '[ "$(qg snapped .state)" = triaged ]'
check "AC1: the plan admits both" 'grep -q "^on-base  lane D  size -  ADMIT$" <<< "$out" && grep -q "^snapped  lane D  size -  ADMIT$" <<< "$out"'
check "AC2: a Figma-only design parks, and the park says so" '[ "$(qg figma-only .state)" = parked ] && [[ "$(qg figma-only .park.question)" == "lane D — its only design is a Figma frame, which a worker cannot read;"* ]]'
check "AC2: a canvas not on the base parks, and the park names the base" '[ "$(qg not-on-base .state)" = parked ] && [[ "$(qg not-on-base .park.question)" == "lane D — its canvas is not on main: save $LOOSE there"* ]]'
check "AC2: the plan says why each parks" 'grep -q "^figma-only  lane D  size -  PARK (lane D — its only design is a Figma frame" <<< "$out" && grep -q "^  not-on-base: its canvas is not on main" <<< "$out"'
check "lane C still parks" '[ "$(qg plan-first .state)" = parked ] && [[ "$(qg plan-first .park.question)" == "lane C — a new screen from its design" ]]'

# A lane D ticket's own worker parked: requeued like any other. One parked at triage: refused.
node "$B/queue.mjs" set on-base state=parked 'park={"question":"which copy for the empty state?"}' >/dev/null
out=$(node "$B/queue.mjs" requeue on-base 2>&1); rc=$?
check "a lane D ticket its worker parked is requeued" '[ $rc -eq 0 ] && [ "$(qg on-base .state)" = triaged ]'
out=$(node "$B/queue.mjs" requeue figma-only 2>&1); rc=$?
check "a lane D ticket parked at triage on its design is not" '[ $rc -ne 0 ] && [ "$(qg figma-only .state)" = parked ] && grep -q "parked at triage on its design" <<< "$out"'

# The decider: a lane D worker's park goes to its session, which may requeue it; a triage park does not.
out=$(node --input-type=module -e "
import { presort, deciderPrompt } from '$B/decider.mjs';
const { hand, ask } = presort([
  { id: 'w', ticket: 'W', kind: 'parked', lane: 'D', text: 'which copy for the empty state?' },
  { id: 't', ticket: 'T', kind: 'parked', lane: 'D', text: 'lane D — its only design is a Figma frame' },
]);
console.log('ask=' + ask.map((i) => i.id).join(',') + ' hand=' + hand.map((h) => h.item.id).join(','));
console.log(deciderPrompt({ slug: 's', report: '', items: ask, rules: '', bin: '/b' }));
" 2>&1)
check "decider: a lane D worker's park goes to the session, a triage park is handed on" 'grep -qx "ask=w hand=t" <<< "$out"'
check "decider: the prompt lets it requeue lane D, and forbids only a triage park" 'grep -q "more agent work, on lane A, B, D or E:" <<< "$out" && grep -q "never requeue a lane C ticket or a park that starts \`lane C\` or \`lane D\`" <<< "$out" && ! grep -q "never requeue a lane C or D park" <<< "$out"'

# DS-358: a lane A ticket parks on a canvas no worker can read, and runs on a snapshotted one.
ticket a-loose A "Match $LOOSE exactly."
ticket a-snapped A "Match $SNAP exactly."
plan a-loose a-snapped
check "DS-358 AC6: a lane A ticket whose canvas has no snapshot parks, naming the artifact" '[ "$(qg a-loose .state)" = parked ] && [[ "$(qg a-loose .park.question)" == "design not snapshotted: $LOOSE: snapshot it from a session"* ]]'
check "DS-358 AC6: the plan lists it under PARKED ON DESIGN" 'grep -q "^PARKED ON DESIGN (1)" <<< "$out" && grep -q "^  a-loose: design not snapshotted: $LOOSE" <<< "$out"'
check "DS-358 AC2: a lane A ticket with a snapshot runs" '[ "$(qg a-snapped .state)" = triaged ]'
# A design-parked ticket is still planned: held behind what it collides with, recorded beside its park.
ticket b-first A "Match $SNAP exactly."; ticket b-second A "Match $LOOSE exactly."
for k in b-first b-second; do jq '.files_in_scope = ["src/shared.js"]' "$T/state/triage/$k.json" > "$T/fis.json" && mv "$T/fis.json" "$T/state/triage/$k.json"; done
plan b-first b-second
check "DS-358: a design-parked ticket keeps its hold behind the ticket it collides with" '[ "$(qg b-second .state)" = parked ] && [[ "$(qg b-second .park.question)" == "design not snapshotted: $LOOSE"* ]] && [ "$(qg b-second .held_by)" = b-first ]'
mkdir -p "$T/state/batches/EPIC-9/triage" "$T/state/batches/EPIC-9/tickets"
cp "$T/state/tickets/a-snapped.md" "$T/state/batches/EPIC-9/tickets/"; cp "$T/state/triage/a-snapped.json" "$T/state/batches/EPIC-9/triage/"
DESK_AUTOPILOT_STATE="$T/state/batches/EPIC-9" node "$B/ticket-facts.mjs" a-snapped >/dev/null 2>&1
check "DS-358 AC7: a feature batch's triage finds the repo state's snapshot" '[ "$(jq -r ".design.canvases[0].snapshot" "$T/state/batches/EPIC-9/triage/a-snapped.json")" = "$T/state/designs/snap-ticket" ]'

echo "lane D: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
