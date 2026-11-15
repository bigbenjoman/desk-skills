#!/usr/bin/env bash
# suite: park cycle (a park waiting on a PR whose ticket is held behind it, and that PR's conflict)
# pass.mjs with a ticket parked until "pr <n> merged": when the ticket whose PR is n is held behind the
# park, directly or through other holds, the verdict has one waiting line naming every ticket in the
# cycle, and the PR's conflict with the base when it has one; with no cycle, a conflicting PR is said on
# the park's own item, and a mergeable one adds nothing (DS-615). Runs the real pass.mjs with stub
# claude, gh, setup-worktree and spawn-worker. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt" "$T/fx"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_START_STAGE DESK_GITHUB_HANDLE CLAUDE_CONFIG_DIR CODEX_HOME DESK_AUTOPILOT_WORKER
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

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
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
printf '#!/bin/sh\necho %s\n' "'[]'" > "$T/stub/claude"
# gh pr view <n> answers with $T/fx/<n>.json; everything else answers nothing.
printf '#!/bin/sh\ncase "$1 $2" in "pr view") [ -f "%s/fx/$3.json" ] && cat "%s/fx/$3.json" ;; esac\nexit 0\n' "$T" "$T" > "$T/stub/gh"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/lsof"
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/lsof"
export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
# PR <n> open, in merge state <state> against main.
pr(){ printf '{"state":"OPEN","isDraft":true,"mergeable":"%s","mergeStateStatus":"%s","baseRefName":"main","headRefOid":"abc"}\n' \
  "$([ "$2" = DIRTY ] && echo CONFLICTING || echo MERGEABLE)" "$2" > "$T/fx/$1.json"; }
# A fresh queue for each case, with A parked until PR 12 merges.
fresh(){ export DESK_QUEUE="$T/$1.json"; q init t; q add A; q set A state=parked 'park={"question":"Merge PR 12 first?","clears_when":{"kind":"pr-merged","pr":12}}'; }
held(){ q add "$1"; q set "$1" state=parked held_by="$2" "park={\"question\":\"held by orchestrator: blocked by $2 — starts once their PRs merge\"}"; if [ -n "${3:-}" ]; then q set "$1" result.pr="$3"; fi; }
verdict(){ node "$B/pass.mjs" --json 2>/dev/null | tail -1; }
has(){ node --input-type=module -e "import { deciderItems } from '$B/decider.mjs'; const v = JSON.parse(process.argv[1]); process.exit(eval(process.argv[2]) ? 0 : 1)" "$out" "$1"; }
CYCLE='v.waiting.filter((l) => / wait on each other/.test(l))'

# AC1: B, whose PR is 12, is held behind A, which is parked until PR 12 merges.
fresh ac1; held B A 12; pr 12 BLOCKED
out=$(verdict)
check "DS-615 AC1 one waiting line names A, B and PR 12 as waiting on each other" \
  "has '$CYCLE.length === 1 && /^A: CYCLE — A and B wait on each other: A is parked until PR #12 \\(B\\) merges, and B is held behind A\\. /.test(${CYCLE}[0])'"
check "DS-615 AC1 a mergeable PR is not called conflicting" "has '!/conflicts/.test(${CYCLE}[0])'"

# AC2: the cycle runs through C: B is held behind C, and C behind A.
fresh ac2; held C A; held B C 12; pr 12 BLOCKED
out=$(verdict)
check "DS-615 AC2 the line names all three tickets in the cycle" \
  "has '$CYCLE.length === 1 && /A, B and C wait on each other: A is parked until PR #12 \\(B\\) merges, and B is held behind C and C is held behind A/.test(${CYCLE}[0])'"

# AC3: the cycle in AC1, with PR 12 conflicting with main.
fresh ac3; held B A 12; pr 12 DIRTY
out=$(verdict)
check "DS-615 AC3 the cycle line says PR 12 conflicts with the base" "has '$CYCLE.length === 1 && /\\. PR #12 conflicts with main\\. /.test(${CYCLE}[0])'"
check "DS-615 AC3 the park item carries no second note" "has '!v.parked.find((p) => p.key === \"A\")?.note'"

# AC4: no cycle (PR 12 is nobody's in the batch), PR 12 conflicting with main.
fresh ac4; pr 12 DIRTY
out=$(verdict)
check "DS-615 AC4 A's park item says PR 12 conflicts with the base" "has 'v.parked.find((p) => p.key === \"A\")?.note === \"PR #12 conflicts with main\" && $CYCLE.length === 0'"
check "DS-615 AC4 the decider item shows the note, under the park's own id" \
  "has 'deciderItems(v).find((i) => i.ticket === \"A\")?.text === \"Merge PR 12 first? (PR #12 conflicts with main)\" && deciderItems(v).find((i) => i.ticket === \"A\").id === deciderItems({ parked: [{ key: \"A\", question: \"Merge PR 12 first?\" }] })[0].id'"

# AC5: no cycle, PR 12 open and mergeable: nothing is added.
fresh ac5; held B X 12; pr 12 BLOCKED
out=$(verdict)
check "DS-615 AC5 a mergeable PR with no cycle adds nothing" "has '$CYCLE.length === 0 && !v.parked.some((p) => p.note) && !/PARK NOTES/.test(v.message)'"

echo "park cycle: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
