#!/usr/bin/env bash
# suite: worker location (config §3b row, the batch plan's workers line, desk-setup's question)
# plan-batch on fixture triage records under three configs: no Worker location row, `cloud`, and a
# typo. At cloud, each ticket is placed in the cloud or locally with its reason, and the queue records
# it. Scratch HOME, state and queue only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/triage"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_JIRA_NAME AUTOPILOT_WRITE_QUEUE AUTOPILOT_BUDGET_USD
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=${rc:-} out: ${out:-}"; fi; }
trap 'rm -rf "$T"' EXIT

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
# config [<Worker location value>]: no value leaves the row out.
config(){ local row=""; [ -n "${1:-}" ] && row="| Worker location | \`local\` | \`$1\` |"
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
| Jira display name | \`Me\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
$row

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`KAN-[0-9]+\` |
| Local database | \`none\` |
EOF
}
export DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1
printf '{"ticket": "KAN-1", "type": "Task", "lane": "A", "size": "S", "summary": "s", "branch": "feat/KAN-1", "change_kind": "surface", "files_in_scope": ["a.js"], "unknowns": [], "blockers": []}\n' \
  > "$T/state/triage/KAN-1.json"
plan(){ node "$B/queue.mjs" init "t$RANDOM" >/dev/null; out=$(node "$B/plan-batch.mjs" KAN-1 2>&1); rc=$?; }

config; plan
check "AC1 with no Worker location row, the plan says workers run locally"  '[ "$rc" = 0 ] && echo "$out" | grep -qx "workers: local"'
check "AC1 and does not mention cloud"                                       '! echo "$out" | grep -qi cloud'
check "AC1 desk-env reads the unset row as local"                           '[ "$(node --input-type=module -e "import { workerLocation } from \"$B/desk-env.mjs\"; console.log(workerLocation())")" = local ]'

config cloud; plan
check "AC2 at cloud, the ticket is still admitted to run"                   '[ "$rc" = 0 ] && echo "$out" | grep -q "^KAN-1  lane A  size S  ADMIT$"'
check "DS-124 AC3 a record from before needs_local runs locally, and says why" 'echo "$out" | grep -q "^  runs: local — its triage record does not say whether it needs this computer"'

# KAN-2 needs nothing on this computer; KAN-3 renders, so its screenshots need the browser lock.
printf '{"ticket": "KAN-2", "type": "Task", "lane": "A", "size": "S", "summary": "s", "branch": "feat/KAN-2", "change_kind": "surface", "files_in_scope": ["b.js"], "unknowns": [], "blockers": [], "renders": false, "needs_db": false, "needs_local": null}\n' \
  > "$T/state/triage/KAN-2.json"
printf '{"ticket": "KAN-3", "type": "Task", "lane": "A", "size": "S", "summary": "s", "branch": "feat/KAN-3", "change_kind": "surface", "files_in_scope": ["c.js"], "unknowns": [], "blockers": [], "renders": true, "needs_db": false, "needs_local": null}\n' \
  > "$T/state/triage/KAN-3.json"
node "$B/queue.mjs" init "t$RANDOM" >/dev/null; out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-1 KAN-2 KAN-3 2>&1); rc=$?
check "DS-124 AC1 the plan states the location before any worker starts"   '[ "$rc" = 0 ] && echo "$out" | grep -q "^workers: cloud — 1 of 3 admitted ticket(s) in a cloud session, the rest local"'
check "DS-124 AC1 and the per-worker budget"                                'echo "$out" | grep -q "^budget: \$25 per local worker (config §3b \"Autopilot per-worker budget (USD)\"); a cloud session takes no budget"'
check "DS-124 AC3 a ticket that needs nothing here runs in the cloud"       'echo "$out" | grep -A3 "^KAN-2 " | grep -qx "  runs: cloud"'
check "DS-124 AC3 one that renders runs locally, and the plan says why"     'echo "$out" | grep -A3 "^KAN-3 " | grep -q "^  runs: local — it renders: its screenshots need the browser lock and a local dev server$"'
check "DS-124 AC2 the queue sends the cloud ticket to the cloud, and only it" '[ "$(node -e "const q = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); console.log([\"KAN-1\", \"KAN-2\", \"KAN-3\"].map((k) => q.tickets[k].location).join())" "$DESK_QUEUE")" = ",cloud," ]'
check "DS-124 AC1 a malformed budget refuses the plan at cloud"             'out=$(AUTOPILOT_BUDGET_USD="25 USD" node "$B/plan-batch.mjs" KAN-2 2>&1); [ $? != 0 ] && echo "$out" | grep -q "per-worker budget"'

config local; plan
check "local reads as local"                                                 '[ "$rc" = 0 ] && echo "$out" | grep -qx "workers: local"'

config clod; plan
check "a value that is neither local nor cloud refuses the plan, naming the row" '[ "$rc" != 0 ] && echo "$out" | grep -q "Worker location\" is \"clod\""'

check "AC5 the config template has the row, recommended local"              'grep -qE "^\| Worker location \| \`local\` \| \`TODO\` " "$SRC/desk-config.md"'
check "AC5 desk-setup asks it in the §3b rounds, recommending local"        'grep -q "worker models, worker location," "$SRC/skills/desk-setup/SKILL.md" && grep -q "For worker location,$" "$SRC/skills/desk-setup/SKILL.md" && grep -q "^Recommended is \`local\`" "$SRC/skills/desk-setup/SKILL.md"'

echo; [ "$FAIL" = 0 ] && echo "worker location: $PASS checks passed" || echo "worker location: $FAIL failed"
exit "$FAIL"
