#!/usr/bin/env bash
# suite: pass (a ticket whose triage puts its code in another repo is handed there, not spawned)
# The real pass.mjs, with two repos configured, on triage records whose files in scope are all in the
# other repo, or whose scope call runs it there: admitted there by intake.mjs admit (a stub, run in that
# repo's checkout) and dropped from this queue. Files in both repos spawn as before; a repo with no
# config here, or an admit there that fails, parks. Stub claude, gh, desk-jira, setup-worktree and
# spawn-worker. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/logs" "$T/state/triage" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" DESK_CONFIG_ROOT="$T/home/.config/desk" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_START_STAGE DESK_GITHUB_HANDLE DESK_BATCH AUTOPILOT_WRITE_QUEUE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
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

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/$r\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`SV-[0-9]+\` |
| Local database | \`none\` |
EOF
done

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1" >> "$T/spawned"; echo "[spawn] ticket=\$1"; fi
EOF
# intake.mjs admit <KEY>: logs where and how it ran, and admits, or refuses where $T/refuse names the key.
cat > "$T/desk/bin/intake.mjs" <<EOF
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const e = process.env;
const key = process.argv[3];
appendFileSync('$T/intake.log', JSON.stringify({ key, cwd: process.cwd(), args: process.argv.slice(2), dir: e.DESK_REPO_DIR ?? null, state: e.DESK_AUTOPILOT_STATE ?? null, queue: e.DESK_QUEUE ?? null, from: e.DESK_ADMIT_FROM ?? null }) + '\n');
if (existsSync('$T/refuse') && readFileSync('$T/refuse', 'utf8').split('\n').includes(key)) {
  console.log(JSON.stringify({ ran: true, lines: [\`not admitted \${key}: the queue is locked\`], admitted: [], refused: [key] }));
  process.exitCode = 11;
} else console.log(JSON.stringify({ ran: true, lines: [\`admitted \${key} by pass into batch the standing batch (lane A, size S)\`], admitted: [key], refused: [] }));
EOF
printf '#!/bin/sh\necho "[]"\n' > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/lsof"
printf '#!/bin/sh\n[ "$1 $2" = "pr list" ] && echo "[]"\nexit 0\n' > "$T/stub/gh"
printf '#!/bin/sh\necho "desk-jira: unreachable" >&2; exit 1\n' > "$T/stub/desk-jira"
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/desk-jira" "$T/stub/lsof"

export PATH="$T/stub:$PATH" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/zendesk" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
qg(){ jq -r ".tickets[\"$1\"]$2" "$DESK_QUEUE"; }
spawned(){ grep -qx "$1" "$T/spawned" 2>/dev/null; }
admitted(){ grep -q "\"key\":\"$1\"" "$T/intake.log" 2>/dev/null; }
# rec <KEY> <files_in_scope json> [<decided json>]: a triage record, and the ticket queued on it.
rec(){ printf '{"ticket": "%s", "type": "Bug", "lane": "A", "size": "S", "summary": "s", "branch": "fix/%s", "files_in_scope": %s, "unknowns": [], "decided": %s, "blockers": []}\n' \
  "$1" "$1" "$2" "${3:-[]}" > "$T/state/triage/$1.json"; q add "$1" Bug A; q set "$1" state=triaged "branch=fix/$1" added_at=2026-11-12T10:00:00Z; }
scope(){ printf '[{"question": "Where does it run?", "options": ["%s", "keep it here"], "chose": "%s", "category": "%s"}]' "$1" "$1" "${2:-scope}"; }

q init other
q set-batch concurrency=9
rec SV-3986 '["studia-web: apps/portal/a.ts", "acme/studia-web: apps/portal/b.ts"]'
rec SV-3994 '["src/hook.js"]' "$(scope 'Drop SV-3994 from this zendesk batch and run it in a studia-web batch')"
rec SV-3001 '["studia-web: apps/portal/a.ts", "src/handler.js"]'
rec SV-3002 '["studia-mobile: app/screen.ts"]'
rec SV-3003 '["studia-web: apps/portal/c.ts"]'; echo SV-3003 > "$T/refuse"
rec SV-3004 '["src/a.js: the handler", "src/b.js: its test"]'
rec SV-3005 '["src/x.js"]' "$(scope 'Run it in this zendesk batch, not a studia-web one')"
rec SV-3006 '["src/y.js"]' "$(scope 'Run it in a studia-web batch' engineering)"
rec SV-3007 '["studia-web: apps/portal/d.ts"]'; q set SV-3007 draft_pr=12
rec SV-3008 '["studia-web: apps/portal/e.ts"]'
rec SV-3009 '["src/z.js"]'; q set SV-3009 state=parked held_by=SV-3008

out=$(node "$B/pass.mjs" 2>&1)
check "AC1: files all in another configured repo: no worker, admitted there, out of this queue" \
  '! spawned SV-3986 && admitted SV-3986 && [ "$(qg SV-3986 "")" = null ]'
check "AC1: intake.mjs admit ran in the other repo's checkout, with none of this batch's state or queue" \
  '[ "$(jq -r "select(.key == \"SV-3986\") | [.cwd, .dir, (.args | join(\" \")), (.state | tostring), (.queue | tostring)] | join(\",\")" "$T/intake.log")" = "$(cd "$T/studia-web" && pwd -P),$T/studia-web,admit SV-3986 --by pass --json,null,null" ]'
check "DS-800: the admit there names this repo as the one handing it over, so this repo's copy does not refuse it" \
  '[ "$(jq -r "select(.key == \"SV-3986\") | .from" "$T/intake.log")" = acme__zendesk ]'
check "AC1: the report names the repo it went to" \
  'grep -qF "SV-3986: its files in scope are all in acme/studia-web, so it was admitted into acme/studia-web (admitted SV-3986 by pass into batch the standing batch (lane A, size S)) and taken out of this queue, no worker spawned" <<< "$out"'
check "AC2: a scope call to run it in the other repo hands it over the same way" \
  '! spawned SV-3994 && admitted SV-3994 && [ "$(qg SV-3994 "")" = null ] && grep -qF "SV-3994: triage decided to run it in acme/studia-web (\"Drop SV-3994 from this zendesk batch and run it in a studia-web batch\"), so it was admitted into acme/studia-web" <<< "$out"'
check "AC3: files in both repos spawn as today" 'spawned SV-3001 && ! admitted SV-3001 && [ "$(qg SV-3001 .state)" = running ]'
check "AC4: a repo with no config here: no worker, parked naming it, nothing admitted" \
  '! spawned SV-3002 && ! admitted SV-3002 && [ "$(qg SV-3002 .state)" = parked ] && qg SV-3002 .park.question | grep -qF "its files in scope are all in studia-mobile, and studia-mobile is no repo configured on this computer, so no worker was spawned: which repo does it run in?"'
check "AC5: the admit there fails: no worker, parked with the failure and the command that admits it" \
  '! spawned SV-3003 && [ "$(qg SV-3003 .state)" = parked ] && qg SV-3003 .park.question | grep -qF "admitting it into acme/studia-web failed (not admitted SV-3003: the queue is locked). Admit it there: cd $T/studia-web && node $T/desk/bin/intake.mjs admit SV-3003 --by pass"'
# The batch runs three workers at once: those finish, and a second pass reaches the rest.
while read -r k; do q set "$k" state=done; done < "$T/spawned"
out=$(node "$B/pass.mjs" 2>&1)
check "a path with a colon note is this repo's file, so it spawns" 'spawned SV-3004 && ! admitted SV-3004'
check "a scope call that keeps it in this repo spawns" 'spawned SV-3005 && ! admitted SV-3005'
check "a call outside the scope category spawns" 'spawned SV-3006 && ! admitted SV-3006'
check "a ticket with a PR in this repo already stays here" 'spawned SV-3007 && ! admitted SV-3007'
check "a ticket another is held behind here: no worker, nothing admitted, parked naming the one held" \
  '! spawned SV-3008 && ! admitted SV-3008 && [ "$(qg SV-3008 .state)" = parked ] && qg SV-3008 .park.question | grep -qF "but SV-3009 is held behind it here: release or drop it, then admit SV-3008 in acme/studia-web"'

echo "pass other repo: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
