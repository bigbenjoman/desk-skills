#!/usr/bin/env bash
# suite: cross-repo children (plan-batch sends a ticket to the repo its Jira Repository names)
# plan-batch on fixture triage records with two repos configured: a ticket whose Repository names the
# other repo reads ELSEWHERE, stays out of this queue and is admitted there by intake.mjs admit (a stub
# here), run in that repo's checkout; a ticket here blocked by it is held until it is Done in Jira; a
# Repository no configured repo has is asked about; an empty one, or this repo's, plans as before.
# Scratch HOME, state and queue only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/triage" "$T/desk/bin"
export HOME="$T/home" DESK_CONFIG_ROOT="$T/home/.config/desk" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_JIRA_NAME DESK_BATCH AUTOPILOT_WRITE_QUEUE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=${rc:-} out: ${out:-}"; fi; }
trap 'rm -rf "$T"' EXIT

# This repo (acme/zendesk) and another configured one (acme/studia-web), each with a checkout.
for r in zendesk studia-web; do
  git init -q -b main "$T/$r"; git -C "$T/$r" commit -q --allow-empty -m init
  git -C "$T/$r" remote add origin "git@github.com:acme/$r.git"
  mkdir -p "$DESK_CONFIG_ROOT/repos/acme__$r"
  cat > "$DESK_CONFIG_ROOT/repos/acme__$r/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/$r\` |
| Default branch | \`main\` |

## 1. Who you are
| Field | Value |
|---|---|
| GitHub handle | \`me\` |
| Jira display name | \`Me\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/$r\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-judgement\` | Take calls outside the ask categories | \`yes\` | \`yes\` |

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`[A-Z]+-[0-9]+\` |
| Local database | \`none\` |
EOF
done

# A DESK_HOME whose bin holds the real scripts beside a stub intake.mjs, which logs where and how it
# ran and admits, or refuses, as $T/intake.mode says.
for f in "$B"/*; do [ "${f##*/}" = intake.mjs ] || ln -s "$f" "$T/desk/bin/${f##*/}"; done
cat > "$T/desk/bin/intake.mjs" <<EOF
import { appendFileSync, readFileSync } from 'node:fs';
const e = process.env;
appendFileSync('$T/intake.log', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), dir: e.DESK_REPO_DIR ?? null, state: e.DESK_AUTOPILOT_STATE ?? null, queue: e.DESK_QUEUE ?? null, write: e.AUTOPILOT_WRITE_QUEUE ?? null }) + '\n');
const key = process.argv[3];
if (readFileSync('$T/intake.mode', 'utf8').trim() === 'ok') {
  console.log(JSON.stringify({ ran: true, lines: [\`admitted \${key} by plan-batch into batch the standing batch (lane A, size S)\`], admitted: [key], refused: [] }));
} else {
  console.log(JSON.stringify({ ran: true, lines: [\`not admitted \${key}: the queue is locked\`], admitted: [], refused: [key] }));
  process.exitCode = 11;
}
EOF
export DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json"
cd "$T/zendesk" || exit 1

# rec <KEY> <repository or ""> <blockers json>
rec(){ printf '{"ticket": "%s", "type": "Task", "lane": "A", "size": "S", "summary": "s", "branch": "feat/%s", "change_kind": "surface", "files_in_scope": ["src/%s"], "unknowns": [], "repository": %s, "blockers": %s}\n' \
  "$1" "$1" "$1" "$([ -n "$2" ] && printf '"%s"' "$2" || echo null)" "$3" > "$T/state/triage/$1.json"; }
plan(){ out=$(node "$B/plan-batch.mjs" "$@" 2>&1); rc=$?; }
seed(){ rm -f "$DESK_QUEUE" "$T/intake.log"; node "$B/queue.mjs" init "t$RANDOM" >/dev/null; out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" "$@" 2>&1); rc=$?; }
qg(){ jq -r ".tickets[\"$1\"]$2" "$DESK_QUEUE"; }
ilog(){ jq -r "$1" "$T/intake.log"; }

rec SV-3994 studia-web '[]'
rec SV-3995 '' '[{"key": "SV-3994", "category": "new"}]'

# ---- AC1: the other repo's child reads ELSEWHERE and is not admitted here ---------------------------
plan SV-3994 SV-3995
check "AC1: the child whose Repository is another configured repo reads ELSEWHERE (studia-web)" \
  'printf "%s\n" "$out" | grep -qx "SV-3994  lane A  size S  ELSEWHERE (studia-web)"'
check "AC1: the plan says it is admitted there, not here" \
  'printf "%s\n" "$out" | grep -qF "  ~ its Jira Repository is studia-web, so it runs in acme/studia-web: admitted there, not here, when the queue is seeded"'
check "AC1: a plan that does not seed admits it nowhere" '[ ! -f "$T/intake.log" ]'

# ---- AC2: seeded, it is admitted into the other repo, run in that repo's checkout ---------------------
echo ok > "$T/intake.mode"
seed SV-3994 SV-3995
check "AC2: seeding leaves it out of this queue" '[ "$(qg SV-3994 "")" = null ] && [ "$(qg SV-3995 .state)" = parked ]'
check "AC2: intake.mjs admit runs once, in the other repo's checkout, with none of this batch's state or queue" \
  '[ "$(wc -l < "$T/intake.log" | tr -d " ")" = 1 ] && [[ "$(ilog .cwd)" == */studia-web ]] && [ "$(ilog .dir)" = "$T/studia-web" ] && [ "$(ilog ".args | join(\" \")")" = "admit SV-3994 --by plan-batch --json" ] && [ "$(ilog "[.state, .queue, .write] | map(tostring) | join(\",\")")" = null,null,null ]'
check "AC2: the plan says where it went" \
  'printf "%s\n" "$out" | grep -qF "  SV-3994 → acme/studia-web: admitted SV-3994 by plan-batch into batch the standing batch (lane A, size S)"'

# ---- AC3: a child here blocked by it is held until it is Done in Jira ---------------------------------
check "AC3: the blocked child is held outside the batch, with no question" \
  '[ $rc -eq 0 ] && [ "$(qg SV-3995 .held_outside)" = SV-3994 ] && [ "$(qg SV-3995 .held_by)" = SV-3994 ] && [ "$(qg SV-3995 .open_questions)" = 0 ] && printf "%s" "$out" | grep -q "^QUESTIONS — none"'
check "AC3: its hold waits for Done in Jira, not a merge on this base" \
  '[ "$(qg SV-3995 .park.question)" = "held by orchestrator: blocked by SV-3994 (not started; its Jira Repository is studia-web, so it runs in acme/studia-web) — starts once SV-3994 is Done in Jira" ] && ! printf "%s" "$out" | grep -q -- "--deps"'
rec SV-3995 '' '[{"key": "SV-3994", "category": "done"}]'
seed SV-3994 SV-3995
check "AC3: a blocker in the other repo already Done holds nothing" '[ "$(qg SV-3995 .state)" = triaged ] && [ "$(qg SV-3995 .held_outside)" = null ]'
rec SV-3995 '' '[{"key": "SV-3994", "category": "new"}]'

# ---- AC4: a Repository no configured repo has is asked about ----------------------------------------
rec SV-3996 studia-mobile '[]'
seed SV-3996
check "AC4: it is not admitted, and the plan asks where it runs" \
  '[ $rc -eq 11 ] && [ "$(qg SV-3996 "")" = null ] && [ ! -f "$T/intake.log" ] && printf "%s\n" "$out" | grep -qF "SV-3996  lane A  size S  NOT ADMITTED (its Jira Repository, studia-mobile, is no repo configured on this computer — where does it run?)" && printf "%s\n" "$out" | grep -qF "[SV-3996] SV-3996 is not admitted here: its Jira Repository, studia-mobile, is no repo configured on this computer. Which repo does it run in?"'

# ---- AC5: an empty Repository, or this repo's, plans as before --------------------------------------
rec SV-3997 '' '[]'
rec SV-3998 Zendesk '[]'
rec SV-3999 acme/zendesk '[]'
seed SV-3997 SV-3998 SV-3999
check "AC5: no Repository, this repo's name, or its owner/name each plan as today" \
  '[ $rc -eq 0 ] && [ "$(qg SV-3997 .state)" = triaged ] && [ "$(qg SV-3998 .state)" = triaged ] && [ "$(qg SV-3999 .state)" = triaged ] && [ ! -f "$T/intake.log" ] && [ "$(printf "%s\n" "$out" | grep -c "  ADMIT$")" = 3 ]'

# ---- AC6: the other repo refuses it --------------------------------------------------------------------
echo refuse > "$T/intake.mode"
seed SV-3994 SV-3995
check "AC6: this queue still leaves it out, and the blocked child is still held" '[ "$(qg SV-3994 "")" = null ] && [ "$(qg SV-3995 .held_outside)" = SV-3994 ]'
check "AC6: the plan names the failure and the command to admit it there, and shows the person" \
  '[ $rc -eq 11 ] && printf "%s\n" "$out" | grep -qF "  SV-3994 → acme/studia-web: NOT ADMITTED (not admitted SV-3994: the queue is locked). Admit it there: cd $T/studia-web && node $T/desk/bin/intake.mjs admit SV-3994 --by plan-batch"'
mv "$T/studia-web" "$T/studia-web-moved"
seed SV-3994
check "AC6: a checkout that is not where its config says is named, and intake is not run" \
  '[ $rc -eq 11 ] && [ ! -f "$T/intake.log" ] && printf "%s\n" "$out" | grep -qF "NOT ADMITTED (acme/studia-web'"'"'s checkout (its config §2 Primary repo root) is not at $T/studia-web)"'
mv "$T/studia-web-moved" "$T/studia-web"

echo "cross-repo children: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
