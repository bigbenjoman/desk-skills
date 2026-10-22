#!/usr/bin/env bash
# suite: exit codes (pass, plan-batch, queue and answer: 0 go on, 10 nothing yet, 11 show the person)
# The four orchestration scripts share one exit-code contract (EXIT in desk/bin/batch-state.mjs), and
# pass.mjs --json prints one object carrying the same verdict. Runs the real scripts with stub claude,
# gh, setup-worktree and spawn-worker, as tests/test_pass.sh does. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/logs" "$T/state/triage" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_WRITE_QUEUE AUTOPILOT_USER_APPROVED
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=${rc:-} out: ${out:-}"; fi; }
trap 'rm -rf "$T"' EXIT

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 1. Who you are
| Field | Value |
|---|---|
| GitHub handle | \`tester\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`T-[0-9]+\` |
| Local database | \`none\` |
EOF

# The real queue and harvest beside stubs for everything that would make a worktree or a worker.
for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}]'" > "$T/stub/claude"
printf '#!/bin/sh\necho OPEN\n' > "$T/stub/gh"
chmod +x "$T/stub/claude" "$T/stub/gh"

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
pass(){ out=$(node "$B/pass.mjs" 2>&1); rc=$?; }
# pass --json: stdout only, so the object is all there is to parse.
pj(){ out=$(node "$B/pass.mjs" --json 2>/dev/null); rc=$?; }
js(){ printf '%s' "$out" | jq -r "$1" 2>/dev/null; }
say(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv.slice(1).join("\n") }] } }))' "$@"; }
record(){ printf '{"ticket": "%s", "type": "Bug", "lane": "%s", "size": "S", "branch": "fix/%s", "files_in_scope": ["src/%s"], "unknowns": [], "links": "n/a"}\n' "$1" "${2:-A}" "$1" "$1" > "$T/state/triage/$1.json"; }

# ---- pass.mjs ------------------------------------------------------------------------------------
pass
check "pass: no queue exits 11 and says what to run"            '[ $rc -eq 11 ] && echo "$out" | grep -q "queue.mjs init"'
pj
check "pass --json: an error is one object, notify set"         '[ $rc -eq 11 ] && [ "$(js .status)" = error ] && [ "$(js .notify)" = true ] && js .message | grep -q "no queue"'

q init exit-codes
q add T-1; q set T-1 state=triaged lane=A branch=fix/T-1
pass
check "pass: a pass that spawns exits 0"                        '[ $rc -eq 0 ] && echo "$out" | grep -q "spawned: T-1"'

# T-1 now runs (its session is live), and T-2 is held behind it.
say "AUTOPILOT_STAGE: 3/9 implement" > "$T/state/logs/T-1.log"
q set T-1 session_id=live-1
q add T-2; q set T-2 state=triaged lane=A branch=fix/T-2; q hold T-2 T-1
pj
check "pass: running and held waiting on a merge exits 10"      '[ $rc -eq 10 ] && [ "$(js .status)" = nothing_yet ] && [ "$(js .notify)" = false ]'
check "pass --json carries every field the skill reads"         '[ "$(js "[\"status\",\"message\",\"waiting\",\"parked\",\"notify\",\"release_due\",\"stuck\"] - keys | length")" = 0 ] && [ "$(js ".waiting, .parked, .release_due, .stuck | length" | paste -sd" " -)" = "0 0 0 0" ]'
pass
check "pass: the text form exits 10 too, and says nothing needs you" '[ $rc -eq 10 ] && ! echo "$out" | grep -q "^NOTIFY"'

# A ticket parked for its own reason: 11 on every pass while it stays parked, idle or not.
q add T-3; q set T-3 lane=A branch=fix/T-3; q park T-3 "which helper should the spec use?"
pj
check "pass: a parked ticket exits 11 with notify set"          '[ $rc -eq 11 ] && [ "$(js .status)" = show_person ] && [ "$(js .notify)" = true ]'
check "pass --json: parked names the ticket and its question"   '[ "$(js ".parked[0].key")" = T-3 ] && [ "$(js ".parked[0].question")" = "which helper should the spec use?" ] && [ "$(js ".parked | length")" = 1 ]'
pass
check "pass: the text form names it under NOTIFY"               '[ $rc -eq 11 ] && echo "$out" | grep -q "^NOTIFY: 1 item(s) need you — T-3"'
q drop T-3

# Triage questions still open are the person's to answer.
q add T-4; q set T-4 state=triaged lane=A branch=fix/T-4 open_questions=2
pj
check "pass: open questions exit 11 and are listed as waiting"  '[ $rc -eq 11 ] && js ".waiting[]" | grep -q "^T-4: 2 question(s) open"'
q drop T-4

# A worker that exits with no marker and no PR fails in this pass, while T-1 still runs.
q add T-9; q set T-9 state=running lane=A branch=fix/T-9 session_id=gone
{ say "AUTOPILOT_STAGE: 3/9 implement"; echo '{"type":"result","is_error":false,"num_turns":1,"result":""}'; } > "$T/state/logs/T-9.log"
pj
check "pass: a ticket that fails this pass exits 11 while others run" '[ $rc -eq 11 ] && [ "$(js .status)" = show_person ] && js ".waiting[]" | grep -q "^T-9: exited with no marker"'
q drop T-9

# A blocker that can no longer merge leaves its held ticket stuck.
q set T-1 state=failed session_id=null
pj
check "pass: a failed ticket and its stuck successor exit 11"   '[ $rc -eq 11 ] && [ "$(js ".stuck | join(\",\")")" = T-2 ] && js ".waiting[]" | grep -q "^T-1: FAILED" && js ".waiting[]" | grep -q "^T-2: STUCK"'

# Every blocker merged and no merge driver running: the release is the person's.
q set T-1 state=done result.pr=7
printf '#!/bin/sh\necho MERGED\n' > "$T/stub/gh"
pj
check "pass: a release due with no driver exits 11"             '[ $rc -eq 11 ] && [ "$(js ".release_due | join(\",\")")" = T-2 ] && js ".waiting[]" | grep -q "^T-2: RELEASE DUE"'

# A finished batch: every ticket done, nothing parked or held.
q drop T-2
pj
check "pass: a finished batch exits 11 with status idle"        '[ $rc -eq 11 ] && [ "$(js .status)" = idle ] && [ "$(js .notify)" = true ] && js .message | grep -q "^IDLE"'

# A corrupt queue refuses at the read, naming what to do, never a stack (node prints frames as "    at ").
cp "$DESK_QUEUE" "$T/queue.good"; echo 'not json' > "$DESK_QUEUE"
pass
check "pass: a corrupt queue exits 11 and says to re-create it" '[ $rc -eq 11 ] && echo "$out" | grep -q "is not valid JSON.*re-create $DESK_QUEUE (queue.mjs init" && ! echo "$out" | grep -q "^    at " && ! echo "$out" | grep -q crashed'
pj
check "pass --json: a corrupt queue is still one object"        '[ $rc -eq 11 ] && [ "$(js .status)" = error ] && js .message | grep -q "re-create"'
q list
check "queue: a corrupt queue exits 11 and says to re-create it" '[ $rc -eq 11 ] && echo "$out" | grep -q "re-create $DESK_QUEUE" && ! echo "$out" | grep -q "^    at "'
out=$(node "$B/answer.mjs" T-1 "an answer" 2>&1); rc=$?
check "answer: a corrupt queue exits 11 and says to re-create it" '[ $rc -eq 11 ] && echo "$out" | grep -q "re-create $DESK_QUEUE" && ! echo "$out" | grep -q "^    at "'
cp "$T/queue.good" "$DESK_QUEUE"

# ---- queue.mjs -----------------------------------------------------------------------------------
q add T-5;                  check "queue: add exits 0"                         '[ $rc -eq 0 ]'
q;                          check "queue: no command exits 11"                 '[ $rc -eq 11 ] && echo "$out" | grep -q "usage"'
q frobnicate;               check "queue: an unknown command exits 11, naming it" '[ $rc -eq 11 ] && echo "$out" | grep -q "unknown command \"frobnicate\""'
q set T-5 state=bogus;      check "queue: a bad argument exits 11"             '[ $rc -eq 11 ] && echo "$out" | grep -q "bad state"'
q admit T-99;               check "queue: a missing triage record exits 11, naming triage.sh" '[ $rc -eq 11 ] && echo "$out" | grep -q "run triage.sh T-99"'
q set T-5 state=triaged lane=A; q add T-6; q set T-6 state=triaged lane=A; q hold T-6 T-5
q requeue T-6;              check "queue: requeueing a held ticket exits 11 and says to release it" '[ $rc -eq 11 ] && echo "$out" | grep -q "release it rather than requeue it"'
echo '{"ticket": "T-50",' > "$T/state/triage/T-50.json"
q admit T-50;               check "queue: a corrupt triage record exits 11, naming triage.sh" '[ $rc -eq 11 ] && echo "$out" | grep -q "T-50.json is not valid JSON.*re-run triage.sh T-50" && ! echo "$out" | grep -q "^    at "'

# ---- answer.mjs ----------------------------------------------------------------------------------
out=$(node "$B/answer.mjs" T-5 "use the helper" 2>&1); rc=$?
check "answer: a recorded answer exits 0"                       '[ $rc -eq 0 ] && echo "$out" | grep -q "T-5: answered"'
out=$(node "$B/answer.mjs" 2>&1); rc=$?
check "answer: no arguments exits 11 with the usage"            '[ $rc -eq 11 ] && echo "$out" | grep -q "usage"'
out=$(node "$B/answer.mjs" ../x "an answer" 2>&1); rc=$?
check "answer: a bad ticket id exits 11"                        '[ $rc -eq 11 ] && echo "$out" | grep -q "not usable as a ticket id"'

# ---- plan-batch.mjs ------------------------------------------------------------------------------
record T-7; record T-8
out=$(node "$B/plan-batch.mjs" T-7 T-8 2>&1); rc=$?
check "plan-batch: a plan exits 0"                              '[ $rc -eq 0 ] && echo "$out" | grep -q "BATCH PLAN — 2 ticket(s)"'
out=$(node "$B/plan-batch.mjs" 2>&1); rc=$?
check "plan-batch: no tickets exits 11 with the usage"          '[ $rc -eq 11 ] && echo "$out" | grep -q "usage"'
out=$(node "$B/plan-batch.mjs" T-7 T-404 2>&1); rc=$?
check "plan-batch: a missing triage record exits 11, naming triage.sh" '[ $rc -eq 11 ] && echo "$out" | grep -q "run triage.sh T-404"'
out=$(node "$B/plan-batch.mjs" ../x 2>&1); rc=$?
check "plan-batch: a bad ticket id exits 11"                    '[ $rc -eq 11 ]'
out=$(node "$B/plan-batch.mjs" T-7 T-50 2>&1); rc=$?
check "plan-batch: a corrupt triage record exits 11, naming triage.sh" '[ $rc -eq 11 ] && echo "$out" | grep -q "T-50.json is not valid JSON.*re-run triage.sh T-50" && ! echo "$out" | grep -q "^    at "'

# plan-batch --json: needs_person is what the skill branches on before Stage 3, never the plan's wording.
pbj(){ out=$(node "$B/plan-batch.mjs" --json "$@" 2>/dev/null); rc=$?; }
why(){ js "[.needs_person[] | select(.ticket == \"$1\") | .why] | join(\",\")"; }
pbj T-7 T-8
check "plan-batch --json: nothing for the person exits 0, needs_person empty" '[ $rc -eq 0 ] && [ "$(js .status)" = go_on ] && [ "$(js .notify)" = false ] && [ "$(js ".needs_person | length")" = 0 ] && js .message | grep -q "BATCH PLAN — 2 ticket(s)"'
pbj T-7 T-404
check "plan-batch --json: a refusal is one object"              '[ $rc -eq 11 ] && [ "$(js .status)" = error ] && js .message | grep -q "run triage.sh T-404"'
printf '{"ticket": "T-10", "type": "Bug", "lane": "A", "size": "S", "branch": "fix/T-10", "files_in_scope": ["src/T-10"], "unknowns": ["which helper?"], "links": "n/a"}\n' > "$T/state/triage/T-10.json"
printf '{"ticket": "T-11", "type": "Bug", "lane": "A", "size": "S", "branch": "fix/T-11", "files_in_scope": ["src/T-11"], "unknowns": [], "links": "n/a", "lint": [{"severity": "blocking", "message": "no acceptance criteria"}]}\n' > "$T/state/triage/T-11.json"
printf '{"ticket": "T-12", "type": "Bug", "lane": "C", "size": "S", "branch": "fix/T-12", "lane_reason": "needs a product call", "unknowns": [], "links": "n/a", "lane_challenge": {"verdict": "INCONCLUSIVE", "failed_reads": ["git show main:src/a.ts: denied"]}}\n' > "$T/state/triage/T-12.json"
printf '{"ticket": "T-13", "type": "Bug", "lane": "D", "size": "S", "branch": "fix/T-13", "lane_reason": "a design build", "unknowns": [], "links": "n/a", "lane_challenge": {"verdict": "UNAVAILABLE", "reason": "timed out"}}\n' > "$T/state/triage/T-13.json"
printf '{"ticket": "T-14", "type": "Bug", "lane": "C", "size": "S", "branch": "fix/T-14", "lane_reason": "needs a plan", "unknowns": [], "links": "n/a", "lane_challenge": {"verdict": "CONFIRM", "reason": "it does"}}\n' > "$T/state/triage/T-14.json"
pbj T-7 T-10 T-11 T-12 T-13 T-14
check "plan-batch --json: a ticket that needs the person exits 11, notify set" '[ $rc -eq 11 ] && [ "$(js .status)" = show_person ] && [ "$(js .notify)" = true ]'
check "plan-batch --json: a triage question is why=question"   '[ "$(why T-10)" = question ] && [ "$(js "[.needs_person[] | select(.ticket == \"T-10\")][0].detail")" = "which helper?" ]'
check "plan-batch --json: a blocking lint finding is why=lint"  '[ "$(why T-11)" = lint ]'
check "plan-batch --json: an INCONCLUSIVE challenge is asked, unchecked and parked" '[ "$(why T-12)" = question,challenge_inconclusive,parked ]'
check "plan-batch --json: a challenge that did not run is challenge_not_run and parked" '[ "$(why T-13)" = challenge_not_run,parked ]'
check "plan-batch --json: a confirmed park is parked only, and a clean ticket is absent" '[ "$(why T-14)" = parked ] && [ -z "$(why T-7)" ]'
out=$(node "$B/plan-batch.mjs" T-7 T-10 2>&1); rc=$?
check "plan-batch: the text form exits 11 too and names them"   '[ $rc -eq 11 ] && echo "$out" | grep -q "^NEEDS YOU BEFORE STAGE 3: 1 item(s) — T-10"'

echo "exit codes: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
