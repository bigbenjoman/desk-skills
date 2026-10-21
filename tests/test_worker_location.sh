#!/usr/bin/env bash
# suite: worker location (config §3b row, the batch plan's workers line, desk-setup's question)
# plan-batch on one fixture triage record under three configs: no Worker location row, `cloud`, and a
# typo. Every worker runs locally until cloud workers exist. Scratch HOME, state and queue only.
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
check "AC2 at cloud, the plan says cloud is not available yet"              '[ "$rc" = 0 ] && echo "$out" | grep -q "^workers: local — config §3b \"Worker location\" is cloud, but cloud workers are not available yet, so every worker runs locally$"'
check "AC2 and the ticket is still admitted to run"                         'echo "$out" | grep -q "^KAN-1  lane A  size S  ADMIT$"'

config local; plan
check "local reads as local"                                                 '[ "$rc" = 0 ] && echo "$out" | grep -qx "workers: local"'

config clod; plan
check "a value that is neither local nor cloud refuses the plan, naming the row" '[ "$rc" != 0 ] && echo "$out" | grep -q "Worker location\" is \"clod\""'

check "AC5 the config template has the row, recommended local"              'grep -qE "^\| Worker location \| \`local\` \| \`TODO\` " "$SRC/desk-config.md"'
check "AC5 desk-setup asks it in the §3b rounds, recommending local"        'grep -q "worker models, worker location," "$SRC/skills/desk-setup/SKILL.md" && grep -q "For worker location,$" "$SRC/skills/desk-setup/SKILL.md" && grep -q "^Recommended is \`local\`" "$SRC/skills/desk-setup/SKILL.md"'

echo; [ "$FAIL" = 0 ] && echo "worker location: $PASS checks passed" || echo "worker location: $FAIL failed"
exit "$FAIL"
