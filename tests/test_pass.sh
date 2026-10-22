#!/usr/bin/env bash
# suite: pass (screenshots go to the current round's PR; requeue)
# pass.mjs after a requeue: screenshots go to the PR the current log names, not the one an earlier
# round stored, and a respawn clears the stored PR and image flags and starts a fresh log and park
# record. queue.mjs requeue moves a finished round's files aside so it respawns. A worker whose log
# says DONE is recorded done even while its session hangs, and is never parked as wedged. Runs the
# real pass.mjs with stub claude, gh, upload-images, setup-worktree and spawn-worker. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD
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
| \`pr-images\` | Upload PR screenshots | \`yes\` | \`yes\` |
EOF

# A DESK_HOME whose bin holds the real queue and harvest scripts beside stubs for everything that
# would touch GitHub, a browser, a worktree or a worker.
for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/upload-images.mjs" <<EOF
import { appendFileSync } from 'node:fs';
appendFileSync('$T/uploads', \`\${process.argv[2]} \${process.argv[3]}\\n\`);
console.log('done: 1 image(s) in the body, 0 placeholder(s) left');
EOF
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}]'" > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
chmod +x "$T/stub/claude" "$T/stub/gh"

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
# One assistant turn of a worker's stream-json log, carrying the given marker lines.
say(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv.slice(1).join("\n") }] } }))' "$@"; }

q init t
# T-1: a requeued round whose log names PR 2 while the queue still holds round one's PR 1.
q add T-1; q set T-1 state=running branch=fix/T-1 session_id=gone result.pr=1
say "AUTOPILOT_IMAGES: $T/state/images/T-1/" "AUTOPILOT_DONE: pr=2 jira=none" > "$T/state/logs/T-1.log"
# T-2: a log with screenshots and no AUTOPILOT_DONE yet, so the stored PR is all there is.
q add T-2; q set T-2 state=running branch=fix/T-2 session_id=gone result.pr=5
say "AUTOPILOT_IMAGES: $T/state/images/T-2/" > "$T/state/logs/T-2.log"

out=$(node "$B/pass.mjs" 2>&1)
check "the log's PR wins over the stored one"           'grep -qx "2 $T/state/images/T-1/" "$T/uploads"'
check "nothing goes to the stored PR when the log has one" '! grep -q "^1 " "$T/uploads"'
check "the stored PR is used when the log has none"     'grep -qx "5 $T/state/images/T-2/" "$T/uploads"'
check "the finished round records the log's PR"         '[ "$(field T-1 result.pr)" = 2 ]'

# T-3: round one finished with PR 1 and uploaded; it is requeued for a deliberate re-run.
q add T-3; q set T-3 state=triaged branch=fix/T-3 result.pr=1 result.summary=old images_uploaded=true images_reported=true
say "AUTOPILOT_IMAGES: $T/state/images/T-3/" "AUTOPILOT_DONE: pr=1 jira=none" > "$T/state/logs/T-3.log"
echo older > "$T/state/logs/T-3.log.round1"
: > "$T/uploads"
out=$(AUTOPILOT_RERUN=T-3 node "$B/pass.mjs" 2>&1)
check "the requeued ticket spawns"                      '[ "$(field T-3 state)" = "\"running\"" ]'
check "spawn clears result"                             '[ "$(field T-3 result)" = null ]'
check "spawn clears images_uploaded"                    '[ "$(field T-3 images_uploaded)" = null ]'
check "spawn clears images_reported"                    '[ "$(field T-3 images_reported)" = null ]'
check "spawn moves the log to the next free round"      '[ ! -e "$T/state/logs/T-3.log" ] && grep -q "pr=1" "$T/state/logs/T-3.log.round2" && grep -qx older "$T/state/logs/T-3.log.round1"'

# The respawned worker (live, as far as the stub registry says) opens PR 2: its screenshots go there.
q set T-3 session_id=live-1
say "AUTOPILOT_IMAGES: $T/state/images/T-3/" > "$T/state/logs/T-3.log"
out=$(node "$B/pass.mjs" 2>&1)
check "no upload before the new round names its PR"     '[ ! -s "$T/uploads" ]'
say "AUTOPILOT_DONE: pr=2 jira=none" >> "$T/state/logs/T-3.log"
out=$(node "$B/pass.mjs" 2>&1)
check "the new round's screenshots go to its PR"        '[ "$(cat "$T/uploads")" = "2 $T/state/images/T-3/" ]'

# T-4: round one finished and parked; its park record and an answered mailbox are still in place.
q set T-3 state=done
q add T-4; q set T-4 state=parked lane=A branch=fix/T-4 'park={"question":"old round"}' session_id=gone idle_passes=4 log_bytes=99
mkdir -p "$T/state/parks" "$T/state/answers"
say "AUTOPILOT_DONE: pr=4 jira=none" > "$T/state/logs/T-4.log"
echo '{"question": "yesterday'"'"'s question"}' > "$T/state/parks/T-4.json"
echo "yesterday's answer" > "$T/state/answers/T-4.txt"
# An even older round left a park record only: the log's own next free round would be .round1.
echo '{"question": "older"}' > "$T/state/parks/T-4.json.round1"
out=$(node "$B/queue.mjs" requeue T-4 2>&1)
check "requeue moves the finished log aside"            '[ ! -e "$T/state/logs/T-4.log" ] && grep -q "pr=4" "$T/state/logs/T-4.log.round2"'
check "requeue moves log, park and answer to one round" '[ ! -e "$T/state/logs/T-4.log.round1" ] && [ ! -e "$T/state/parks/T-4.json" ] && grep -q yesterday "$T/state/parks/T-4.json.round2" && grep -q older "$T/state/parks/T-4.json.round1" && [ ! -e "$T/state/answers/T-4.txt" ] && [ -e "$T/state/answers/T-4.txt.round2" ]'
check "requeue resets the ticket"                       '[ "$(field T-4 state)" = "\"triaged\"" ] && [ "$(field T-4 park)" = null ] && [ "$(field T-4 session_id)" = null ] && [ "$(field T-4 idle_passes)" = 0 ] && [ "$(field T-4 log_bytes)" = 0 ] && [ "$(field T-4 branch)" = "\"fix/T-4\"" ]'
check "requeue fronts the ticket"                       '[ "$(node -e "console.log(Object.keys(JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).tickets)[0])" "$DESK_QUEUE")" = T-4 ]'
out=$(node "$B/pass.mjs" 2>&1)
check "the requeued ticket spawns without AUTOPILOT_RERUN" '[ "$(field T-4 state)" = "\"running\"" ] && ! echo "$out" | grep -q "not respawning"'
check "a spawn with no stamped earlier round records spawned_at as now" '[ "$(field T-4 spawned_at | cut -c2-5)" = "$(date -u +%Y)" ]'

# T-5: a stale park record from an earlier round, on a ticket set back to triaged by hand.
q set T-4 state=done
q add T-5; q set T-5 state=triaged branch=fix/T-5
echo '{"question": "stale"}' > "$T/state/parks/T-5.json"
# A round from before spawned_at was recorded: its log's first stamp is the ticket's first spawn.
echo '{"type":"user","timestamp":"2026-01-02T03:04:05.000Z"}' > "$T/state/logs/T-5.log"
out=$(node "$B/pass.mjs" 2>&1)
check "a spawn clears the park record first"            '[ "$(field T-5 state)" = "\"running\"" ] && [ ! -e "$T/state/parks/T-5.json" ] && [ -e "$T/state/parks/T-5.json.round1" ]'
check "spawned_at keeps the earliest round'\''s start, not this spawn" '[ "$(field T-5 spawned_at)" = "\"2026-01-02T03:04:05.000Z\"" ]'

# Requeue refuses what must not get another headless worker.
out=$(node "$B/queue.mjs" requeue T-5 2>&1)
check "requeue refuses a running ticket"                '[ "$(field T-5 state)" = "\"running\"" ] && echo "$out" | grep -q "is running"'
q add T-6; q set T-6 state=parked lane=C 'park={"question":"lane C"}'
out=$(node "$B/queue.mjs" requeue T-6 2>&1)
check "requeue refuses a lane C ticket"                 '[ "$(field T-6 state)" = "\"parked\"" ] && echo "$out" | grep -q "lane C"'
q add T-7
out=$(node "$B/queue.mjs" requeue T-7 2>&1)
check "requeue refuses an untriaged ticket"             '[ "$(field T-7 state)" = "\"queued\"" ] && echo "$out" | grep -q "not been triaged"'
q set T-7 state=triaged lane=A open_questions=2
out=$(node "$B/queue.mjs" requeue T-7 2>&1)
check "requeue keeps open triage questions"             '[ "$(field T-7 open_questions)" = 2 ] && echo "$out" | grep -q "question(s) open"'
q add T-8; q set T-8 state=triaged lane=A open_questions=0; q park T-8 "size XL — split it before batching"
out=$(node "$B/queue.mjs" requeue T-8 2>&1)
check "requeue refuses a ticket parked at triage for size" '[ "$(field T-8 state)" = "\"parked\"" ] && echo "$out" | grep -q "parked at triage"'

# T-9: a lane C park with a triage unknown that the user re-lanes: answer, then requeue.
q add T-9; q set T-9 state=parked lane=C open_questions=1 'park={"question":"lane C — spans more than one sitting"}'
q set T-9 lane=A
node "$B/answer.mjs" T-9 "use the existing helper" >/dev/null 2>&1
check "an answer clears a parked ticket's questions and leaves it parked" '[ "$(field T-9 open_questions)" = 0 ] && [ "$(field T-9 state)" = "\"parked\"" ]'
out=$(node "$B/queue.mjs" requeue T-9 2>&1)
check "a re-laned, answered ticket requeues"            '[ "$(field T-9 state)" = "\"triaged\"" ]'

# T-10: a worker that printed AUTOPILOT_DONE but whose session hangs on. The stand-in session is a
# detached sleep, so its pid is reaped once killed and kill -0 can see it gone.
SPID=$( (sleep 300 >/dev/null 2>&1 & echo $!) )
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}, {\"sessionId\": \"hung-1\", \"pid\": $SPID}]'" > "$T/stub/claude"
q add T-10; q set T-10 state=running branch=fix/T-10 session_id=hung-1
say "AUTOPILOT_STAGE: 9/9 cleanup" "AUTOPILOT_DONE: pr=10 jira=none" > "$T/state/logs/T-10.log"
out=$(node "$B/pass.mjs" 2>&1)
gone=no; for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$SPID" 2>/dev/null || { gone=yes; break; }; sleep 0.2; done
check "a DONE log with a live session records the ticket done" '[ "$(field T-10 state)" = "\"done\"" ] && [ "$(field T-10 result.pr)" = 10 ]'
check "the finished worker's hung session is stopped"   '[ "$gone" = yes ] && echo "$out" | grep -q "T-10: pr=10 jira=none (session still live after DONE — stopped pid $SPID)"'
kill "$SPID" 2>/dev/null

# T-11: a finished worker that has gone quiet long enough for the stall killer: done, never wedged.
# T-12 is the same without the marker, which the stall killer still parks.
q add T-11; say "AUTOPILOT_DONE: pr=11 jira=none" > "$T/state/logs/T-11.log"
q set T-11 state=running branch=fix/T-11 session_id=live-1 idle_passes=5 "log_bytes=$(wc -c < "$T/state/logs/T-11.log" | tr -d ' ')"
q add T-12; say "AUTOPILOT_STAGE: 3/9 implement" > "$T/state/logs/T-12.log"
q set T-12 state=running branch=fix/T-12 session_id=live-1 idle_passes=5 "log_bytes=$(wc -c < "$T/state/logs/T-12.log" | tr -d ' ')"
out=$(node "$B/pass.mjs" 2>&1)
check "the stall killer does not park a ticket whose log has DONE" '[ "$(field T-11 state)" = "\"done\"" ] && [ "$(field T-11 result.pr)" = 11 ] && ! echo "$out" | grep -q "T-11: no output"'
check "the stall killer still parks a quiet ticket with no DONE" '[ "$(field T-12 state)" = "\"parked\"" ] && field T-12 park | grep -q wedged'

# T-13: an earlier round grepped for the marker, so AUTOPILOT_DONE: sits in a tool call and its
# result but the worker never printed it: it respawns. T-14's worker printed it: it does not.
q set T-5 state=done; q set T-11 state=done; q set T-12 state=done
q add T-13; q set T-13 state=triaged lane=A branch=fix/T-13
{ say "AUTOPILOT_STAGE: 4/9 verify"
  node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "grep -n \"AUTOPILOT_DONE:\" desk/bin/pass.mjs" } }] } }))'
  node -e 'console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "AUTOPILOT_DONE: pr=3 jira=none" }] } }))'
} > "$T/state/logs/T-13.log"
out=$(node "$B/harvest.mjs" "$T/state/logs/T-13.log" 2>&1)
check "harvest ignores a marker inside a tool call or tool result" '! echo "$out" | grep -q AUTOPILOT_DONE && echo "$out" | grep -q "AUTOPILOT_STAGE: 4/9"'
q add T-14; q set T-14 state=triaged lane=A branch=fix/T-14
say "AUTOPILOT_DONE: pr=14 jira=none" > "$T/state/logs/T-14.log"
out=$(node "$B/pass.mjs" 2>&1)
check "a marker only in a tool call or result does not block a respawn" '[ "$(field T-13 state)" = "\"running\"" ] && ! echo "$out" | grep -q "not respawning.*T-13"'
check "a marker the worker printed still blocks a respawn, and says why" '[ "$(field T-14 state)" = "\"triaged\"" ] && echo "$out" | grep -q "not respawning (its worker already printed AUTOPILOT_DONE): T-14"'

# A stage echoed at the start of a Bash command is read (S-1); DONE echoed the same way is not
# (S-2); a stage in a tool result is not (S-3); a stage in the worker's text still is (S-4).
bash_cmd(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: process.argv[1] } }] } }))' "$1"; }
for k in S-1 S-2 S-3 S-4; do q add "$k"; q set "$k" state=running "branch=fix/$k" session_id=live-1 stage=0/9; done
bash_cmd 'echo "AUTOPILOT_STAGE: 4/9 verify"; git status --porcelain' > "$T/state/logs/S-1.log"
bash_cmd 'echo "AUTOPILOT_DONE: pr=12"' > "$T/state/logs/S-2.log"
{ bash_cmd 'grep AUTOPILOT_STAGE notes.md'
  node -e 'console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "AUTOPILOT_STAGE: 9/9 cleanup" }] } }))'
} > "$T/state/logs/S-3.log"
say "AUTOPILOT_STAGE: 3/9 implement" > "$T/state/logs/S-4.log"
out=$(node "$B/pass.mjs" 2>&1)
render=$(node "$B/queue.mjs" render 2>&1)
check "DS-173 AC1 a stage echoed at the start of a Bash command is recorded" '[ "$(field S-1 stage)" = "\"4/9\"" ] && echo "$render" | grep -E "S-1\b" | grep -q "4/9"'
check "DS-173 AC2 DONE echoed from Bash does not record the ticket done" '[ "$(field S-2 state)" = "\"running\"" ] && [ "$(field S-2 result)" = null ]'
check "DS-173 AC3 a stage in a tool result does not change the stage" '[ "$(field S-3 stage)" = "\"0/9\"" ]'
check "DS-173 AC4 a stage in the worker's text is recorded as before" '[ "$(field S-4 stage)" = "\"3/9\"" ]'
for k in S-1 S-2 S-3 S-4; do q set "$k" state=done; done

# T-15 and T-16 finish with real branches: T-15 changed a file outside its triaged scope, T-16 only its
# scope, a test and a lockfile. Report only: both are recorded done, and the idle batch gives the total.
git -C "$T/repo" update-ref refs/remotes/origin/main main; mkdir -p "$T/state/triage"
for k in T-15 T-16; do
  git -C "$T/repo" worktree add -q -b "fix/$k" "$T/wt/$k" main
  echo x > "$T/wt/$k/a.js"; mkdir -p "$T/wt/$k/tests"; echo x > "$T/wt/$k/tests/test_a.sh"; echo x > "$T/wt/$k/yarn.lock"
  echo '{"ticket":"'"$k"'","files_in_scope":["a.js"]}' > "$T/state/triage/$k.json"
done
echo x > "$T/wt/T-15/README.md"; mkdir -p "$T/wt/T-15/lib"; echo x > "$T/wt/T-15/lib/b.js"
for k in T-15 T-16; do git -C "$T/wt/$k" add -A; git -C "$T/wt/$k" commit -q -m work
  q add "$k"; q set "$k" state=running "branch=fix/$k" "worktree=$T/wt/$k" session_id=gone
  say "AUTOPILOT_DONE: pr=${k#T-} jira=none" > "$T/state/logs/$k.log"; done
out=$(node "$B/pass.mjs" 2>&1)
check "AC2 a finished ticket's out-of-scope files are listed against it" 'echo "$out" | grep -q "T-15: README.md, lib/b.js" && [ "$(field T-15 out_of_scope)" = "[\"README.md\",\"lib/b.js\"]" ]'
check "AC2 the ticket proceeds as today"                 '[ "$(field T-15 state)" = "\"done\"" ] && [ "$(field T-15 result.pr)" = 15 ] && ! echo "$out" | grep -q "NOTIFY.*T-15"'
check "AC1 scope, a test and a lockfile report nothing"  '[ "$(field T-16 out_of_scope)" = "[]" ] && ! echo "$out" | grep -qE "T-16: (a.js|tests/|yarn.lock)"'
node -e 'const f = process.argv[1], q = JSON.parse(require("fs").readFileSync(f, "utf8")); for (const t of Object.values(q.tickets)) t.state = "done"; require("fs").writeFileSync(f, JSON.stringify(q))' "$DESK_QUEUE"
out=$(node "$B/pass.mjs" 2>&1)
check "AC3 an idle batch gives the scope total"         'echo "$out" | grep -q "^IDLE" && echo "$out" | grep -q "scope: 1 of 2 checked ticket(s) changed files outside their triaged scope, 2 file(s) in all"'
check "DS-122 an idle batch gives each worker's cost, unknown where its log has no result event" 'echo "$out" | grep -q "^WORKER COST" && echo "$out" | grep -qE "^  T-15 +1 +unknown +unknown +unknown +unknown" && echo "$out" | grep -qE "^  total .*not counted\)$"'

# T-17 advances a stage while a live process holds the queue lock past its wait: the refused write is
# in the report, naming the ticket and the change, not dropped.
q add T-17; q set T-17 state=running branch=fix/T-17 session_id=live-1 stage=2/9
say "AUTOPILOT_STAGE: 3/9 implement" > "$T/state/logs/T-17.log"
sleep 30 & holder=$!
mkdir "$T/queue.json.lock"; echo "$holder" > "$T/queue.json.lock/pid"
out=$(DESK_QUEUE_LOCK_WAIT_MS=200 node "$B/pass.mjs" 2>&1)
check "AC12 a refused queue write names the ticket and the change" 'echo "$out" | grep -q "T-17: queue write refused, not recorded — set stage=3/9 — .*pid $holder" && [ "$(field T-17 stage)" = "\"2/9\"" ]'
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

# A worker count the user set is theirs. A fresh queue and state under a §3b default of 3, cap 6.
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `3 / 6` |\n'; } > "$T/config2.md"
export DESK_CONFIG="$T/config2.md" DESK_QUEUE="$T/queue2.json" DESK_AUTOPILOT_STATE="$T/state2"; mkdir -p "$T/state2/logs"
bfield(){ node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]] ?? null))' "$DESK_QUEUE" "$1"; }
q init c
out=$(node "$B/pass.mjs" 2>&1)
check "DS-115 AC2 a count nobody set reports the §3b default" 'echo "$out" | grep -qx "workers: concurrency 3, the §3b default"'
q set-batch concurrency=4 concurrency_by=user
out=$(node "$B/pass.mjs" 2>&1)
check "DS-115 AC1 a count the user set reports as theirs" 'echo "$out" | grep -qx "workers: concurrency 4, set by the user" && [ "$(bfield concurrency_user)" = 4 ]'
q set-batch concurrency=1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-115 a lowering on memory keeps the user's number" '[ "$(bfield concurrency_by)" = "\"user\"" ] && [ "$(bfield concurrency_user)" = 4 ] && echo "$out" | grep -q "workers: concurrency 1, lowered on memory from the user.s 4: raise back to 4"'
q set-batch concurrency_by=null
check "DS-115 handing the count back to the ladder drops the user's number" '[ "$(bfield concurrency_user)" = null ]'
q set-batch concurrency=0 concurrency_by=user
q add P-1; q set P-1 state=triaged lane=A branch=fix/P-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-115 AC7 concurrency 0 pauses spawns and says so, not IDLE" '[ "$(field P-1 state)" = "\"triaged\"" ] && ! echo "$out" | grep -q "^IDLE" && echo "$out" | grep -q "paused: new spawns are paused by the batch.s worker count (concurrency 0); 1 triaged ticket(s) wait"'

# AC3–AC6: the ladder rows in desk-autopilot keep a count the user set.
SK="$SRC/skills/desk-autopilot/SKILL.md"
row=$(grep -E '^\| > 8 GiB \|' "$SK")
check "DS-115 AC3 the > 8 GiB row keeps a count the user set" 'echo "$row" | grep -q "a count the user set (\`concurrency_by\` is \`user\`): keep that number"'
check "DS-115 AC4 otherwise the §3b default, one higher only after an idle pass" 'echo "$row" | grep -q "Otherwise use the §3b default, going one higher, up to the cap, only after a slot sat idle a whole pass" && ! grep -qE "concurrency 2[;,]" "$SK"'
check "DS-115 AC5 lowering on memory leaves concurrency_by" 'grep -E "^\| < 4 GiB \|" "$SK" | grep -q "leave \`concurrency_by\` as it is" && grep -q "lower with \`set-batch concurrency=<n>\` alone and leave \`concurrency_by\` as it is" "$SK"'
check "DS-115 AC6 raising back returns to the user's number" 'grep -q "When raising back, return to the user.s number" "$SK"'

# DS-117: a pass skips the ports running workers hold in another repo's queue under DESK_HOME. Each
# case is a fresh queue with one triaged ticket, spawning from a floor nothing here listens on.
export DESK_CONFIG="$T/config.md" AUTOPILOT_PORT_FLOOR=47501; mkdir -p "$T/desk/repos/acme__other"
other(){ printf '%s\n' "$1" > "$T/desk/repos/acme__other/queue.json"; }
spawn_one(){ export DESK_QUEUE="$T/queue-$1.json" DESK_AUTOPILOT_STATE="$T/state-$1"; mkdir -p "$T/state-$1/logs"
  q init "$1"; q add "$1"; q set "$1" state=triaged lane=A "branch=fix/$1"; out=$(node "$B/pass.mjs" 2>&1); }
other '{"tickets":{"O-1":{"key":"O-1","state":"running","port":47501}}}'
spawn_one P-171
check "DS-117 AC1 a port another repo's running worker holds is skipped" '[ "$(field P-171 state)" = "\"running\"" ] && [ "$(field P-171 port)" = 47502 ]'
other '{"tickets":{"O-1":{"key":"O-1","state":"done","port":47501}}}'
spawn_one P-172
check "DS-117 AC2 a port only another repo's done ticket recorded is used" '[ "$(field P-172 state)" = "\"running\"" ] && [ "$(field P-172 port)" = 47501 ]'
other '{"tickets": not json'
spawn_one P-173
check "DS-117 AC3 an unreadable queue does not stop the spawn, and the report names it" '[ "$(field P-173 state)" = "\"running\"" ] && [ "$(field P-173 port)" = 47501 ] && echo "$out" | grep -qF "ports: $T/desk/repos/acme__other/queue.json is not valid JSON ("'

# DS-121: a worker at the 5-hour usage limit. The event is built from the provisional fixture (the
# real event at the limit has not been captured yet), with its reset moved to suit each case. Each
# case is a running ticket whose log stopped growing five passes ago, one pass from the stall killer.
export DESK_QUEUE="$T/queue-u.json" DESK_AUTOPILOT_STATE="$T/state-u" AUTOPILOT_PORT_FLOOR=47601; mkdir -p "$T/state-u/logs"
{ cat "$T/config.md"; echo '| `autopilot-usage-resume` | Resume across the usage limit | `no` | `yes` |'; } > "$T/config-resume.md"
limit_event(){ node -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); e.rate_limit_info.resetsAt = Number(process.argv[2]); console.log(JSON.stringify(e))' "$S/fixtures/usage-limit-five-hour.provisional.json" "$1"; }
quiet_running(){ q add "$1"; q set "$1" state=running lane=A "branch=fix/$1" "session_id=$2" idle_passes=5 "log_bytes=$(wc -c < "$T/state-u/logs/$1.log" | tr -d ' ')"; }
now=$(date +%s)
q init u
LPID=$( (sleep 300 >/dev/null 2>&1 & echo $!) )
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}, {\"sessionId\": \"lim-1\", \"pid\": $LPID}]'" > "$T/stub/claude"

# U-1: no autopilot-usage-resume row, so the worker is stopped at the limit and parked with the reason.
{ say "AUTOPILOT_STAGE: 3/9 implement"; limit_event $((now + 3600)); } > "$T/state-u/logs/U-1.log"
quiet_running U-1 lim-1
out=$(DESK_CONFIG="$T/config.md" node "$B/pass.mjs" 2>&1)
gone=no; for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$LPID" 2>/dev/null || { gone=yes; break; }; sleep 0.2; done
check "DS-121 AC2 with no resume grant, a worker at the limit is parked with that reason" '[ "$(field U-1 state)" = "\"parked\"" ] && field U-1 park.question | grep -q "paused on the 5-hour usage limit, which resets .* UTC. Config §3 autopilot-usage-resume is ..no.., so it does not resume into the next usage window" &&! field U-1 park.question | grep -q wedged'
check "DS-121 AC2 the stopped worker is no longer running" '[ "$gone" = yes ] && echo "$out" | grep -q "the worker was stopped (pid $LPID)"'
kill "$LPID" 2>/dev/null
q set U-1 state=done
# U-7: no grant, and the worker resumed before any pass saw it paused: stopped all the same, saying so.
{ limit_event $((now - 60)); say "AUTOPILOT_STAGE: 5/9 evidence"; } > "$T/state-u/logs/U-7.log"
quiet_running U-7 live-1; q set U-7 idle_passes=0
out=$(DESK_CONFIG="$T/config.md" node "$B/pass.mjs" 2>&1)
check "DS-121 AC2 a worker that resumed before a pass saw it is parked, and the reason says it resumed" '[ "$(field U-7 state)" = "\"parked\"" ] && field U-7 park.question | grep -q "reached the 5-hour usage limit, which reset .* UTC, and resumed into the next usage window before a pass saw it"'
q set U-7 state=done
# U-8: no grant, but the session registry cannot be read: nothing can be stopped, so nothing is parked.
cp "$T/stub/claude" "$T/claude.ok"; printf '#!/bin/sh\nexit 1\n' > "$T/stub/claude"
{ say "AUTOPILOT_STAGE: 3/9 implement"; limit_event $((now + 3600)); } > "$T/state-u/logs/U-8.log"
quiet_running U-8 live-1; q set U-8 idle_passes=0
out=$(DESK_CONFIG="$T/config.md" node "$B/pass.mjs" 2>&1)
check "DS-121 AC2 an unreadable registry leaves a worker at the limit running, and says so" '[ "$(field U-8 state)" = "\"running\"" ] && echo "$out" | grep -q "could not read the session registry"'
cp "$T/claude.ok" "$T/stub/claude"; q set U-8 state=done

# U-2: resume granted and the reset an hour away: paused, not wedged, and the quiet count cleared.
{ say "AUTOPILOT_STAGE: 4/9 verify"; limit_event $((now + 3600)); } > "$T/state-u/logs/U-2.log"
quiet_running U-2 live-1
out=$(DESK_CONFIG="$T/config-resume.md" node "$B/pass.mjs" 2>&1)
check "DS-121 AC1 a worker paused at the limit is reported with its reset time" 'echo "$out" | grep -q "^paused on the usage limit: U-2 until $(date -u -r $((now + 3600)) "+%Y-%m-%d %H:%M" 2>/dev/null || date -u -d "@$((now + 3600))" "+%Y-%m-%d %H:%M") UTC, then it resumes"'
check "DS-121 AC1 and is not stopped as wedged"          '[ "$(field U-2 state)" = "\"running\"" ] && [ "$(field U-2 idle_passes)" = 0 ] && ! echo "$out" | grep -q "U-2: no output"'

# U-3: resume granted, and the model answered after the limit: the batch notes record the resume.
{ limit_event $((now - 60)); say "AUTOPILOT_STAGE: 5/9 evidence"; } > "$T/state-u/logs/U-3.log"
quiet_running U-3 live-1; q set U-3 idle_passes=0
out=$(DESK_CONFIG="$T/config-resume.md" node "$B/pass.mjs" 2>&1)
check "DS-121 AC3 a resumed worker's resume is in the batch notes" 'grep -q "^- \[U-3\] resumed after the 5-hour usage limit reset at .* UTC (config §3 autopilot-usage-resume is \"yes\")" "$T/state-u/batch-notes.md"'
check "DS-121 AC3 a resumed worker is not reported paused" '[ "$(field U-3 state)" = "\"running\"" ] && ! echo "$out" | grep -q "paused on the usage limit: .*U-3"'
q set U-2 state=done; q set U-3 state=done

# U-4: an event that looks like the limit but lacks the fixture's reset time is named, not guessed
# at, and the stall check runs as before. U-5's only event is ordinary traffic, and the limit event
# appears only quoted inside a tool result: neither is a pause.
{ say "AUTOPILOT_STAGE: 4/9 verify"; echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}'; } > "$T/state-u/logs/U-4.log"
quiet_running U-4 live-1
{ say "AUTOPILOT_STAGE: 4/9 verify"; cat "$S/fixtures/usage-limit-allowed.json"
  node -e 'console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: process.argv[1] }] } }))' "$(limit_event $((now + 3600)))"
} > "$T/state-u/logs/U-5.log"
quiet_running U-5 live-1
# U-6: resume granted, but the reset passed over half an hour ago with nothing since: the stall check.
limit_event $((now - 7200)) > "$T/state-u/logs/U-6.log"
quiet_running U-6 live-1
out=$(DESK_CONFIG="$T/config-resume.md" node "$B/pass.mjs" 2>&1)
check "DS-121 an unrecognised usage-limit event is named in the pass output" 'echo "$out" | grep -q "^unrecognised usage-limit event: U-4: {\"type\":\"rate_limit_event\""'
check "DS-121 and falls back to the stall check"         '[ "$(field U-4 state)" = "\"parked\"" ] && field U-4 park | grep -q wedged'
check "DS-121 traffic under the limit, or a quoted event, is not a pause" '[ "$(field U-5 state)" = "\"parked\"" ] && field U-5 park | grep -q wedged && ! echo "$out" | grep -q "unrecognised usage-limit event: U-5"'
check "DS-121 a limit long past its reset falls back to the stall check" '[ "$(field U-6 state)" = "\"parked\"" ] && field U-6 park | grep -q wedged'

# AC4: a config with no such row gets the question from /desk-setup, with "no" recommended.
check "DS-121 AC4 the config template has the row, recommended no" 'grep -qE "^\| \`autopilot-usage-resume\` \| .* \| \`no\` \| \`TODO\` \|$" "$SRC/desk-config.md"'
check "DS-121 AC4 desk-setup asks it in the autopilot round, recommended no" 'awk "/^## Round 9/,/^## Round 10/" "$SRC/skills/desk-setup/references/permission-rows.md" | grep -qE "^\| \`autopilot-usage-resume\` \| no "'

# The decision log. D-1 finishes with a call it took, said in its text and again in its
# result; D-2 with a line the log cannot hold. Both runs have exited.
unset DESK_GH_REPO
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue-d.json" DESK_AUTOPILOT_STATE="$T/state-d"; mkdir -p "$T/state-d/logs"
q init d
DEC='AUTOPILOT_DECISION: {"question":"Empty state copy?","options":["No items yet","Nothing here"],"chose":"No items yet","category":"wording"}'
{ say "$DEC" "AUTOPILOT_DONE: pr=31 jira=none"
  node -e 'console.log(JSON.stringify({ type: "result", is_error: false, num_turns: 3, total_cost_usd: 0.5, result: process.argv[1] }))' "$DEC"
} > "$T/state-d/logs/D-1.log"
say 'AUTOPILOT_DECISION: {"question":"Which helper?","options":["a"]' "AUTOPILOT_DONE: pr=32 jira=none" > "$T/state-d/logs/D-2.log"
for k in D-1 D-2; do q add "$k"; q set "$k" state=running "branch=fix/$k" "session_id=run-$k"; done
out=$(node "$B/pass.mjs" 2>&1)
dlog="$T/state-d/decisions.jsonl"
entry=$(head -n 1 "$dlog" 2>/dev/null)
efield(){ node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1])[process.argv[2]] ?? null))' "$entry" "$1"; }
pass_out=$out; out=$entry
check "DS-139 AC2 a finished run's call is logged once, with every field" '[ "$(wc -l < "$dlog" | tr -d " ")" = 1 ] && efield at | grep -qE "^\"20[0-9]{2}-" && [ "$(efield repo)" = "\"acme/widgets\"" ] && [ "$(efield ticket)" = "\"D-1\"" ] && [ "$(efield question)" = "\"Empty state copy?\"" ] && [ "$(efield options)" = "[\"No items yet\",\"Nothing here\"]" ] && [ "$(efield chose)" = "\"No items yet\"" ] && [ "$(efield category)" = "\"wording\"" ] && [ "$(efield pr)" = "\"https://github.com/acme/widgets/pull/31\"" ]'
check "DS-139 AC1 the run is recorded done as usual"     '[ "$(field D-1 state)" = "\"done\"" ] && [ "$(field D-1 result.pr)" = 31 ]'
out=$pass_out
check "DS-139 AC7 an unreadable decision waits on the person with the raw line, and logs nothing" 'echo "$out" | awk "/^WAITING ON YOU/,0" | grep -qF "D-2: unreadable decision (not JSON), nothing logged: {\"question\":\"Which helper?\",\"options\":[\"a\"]" && ! grep -q "\"D-2\"" "$dlog"'
q set D-1 state=running
out=$(node "$B/pass.mjs" 2>&1)
check "DS-139 AC8 harvesting the same run again adds nothing" '[ "$(wc -l < "$dlog" | tr -d " ")" = 1 ] && [ "$(field D-1 state)" = "\"done\"" ]'

# The check-in digest. C-1 parks on a broken live service, C-2 on an ordinary question; a last digest
# dated in the future keeps the check-in itself out of the way until it is removed.
export DESK_QUEUE="$T/queue-c.json" DESK_AUTOPILOT_STATE="$T/state-c" DESK_DIGEST_DIR="$T/digest"; mkdir -p "$T/state-c/logs" "$T/digest"
echo '{"slot":"9999-01-01T00:00","through":"9999-01-01T00:00:00.000Z"}' > "$T/digest/last.json"
q init c
for k in C-1 C-2 C-3; do q add "$k"; done
q park C-1 "PRODUCTION BROKEN: checkout returns 500 on every order"; q park C-2 "which empty-state copy?"; q set C-3 state=done
out=$(node "$B/pass.mjs" --json 2>&1)
pushes(){ echo "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).push.map(p=>p.key).join(" ")))'; }
check "DS-140 AC9 a production-broken park is pushed at once, alone" 'pushes | grep -qxE "urgent:[^ ]+:C-1"'
check "DS-140 AC10 an ordinary park is not pushed between check-ins" '! pushes | grep -q C-2'
printf '%s\n' '{"id":"o1","override_of":"d1","at":"2026-10-22T09:00:00.000Z","repo":"acme/widgets","ticket":"C-3","question":"Badge colour?","was":"brand","chose":"neutral","by":"Ben"}' > "$T/state-c/decisions.jsonl"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-140 AC8 the next pass lists an overridden decision under WAITING ON YOU" 'echo "$out" | awk "/^WAITING ON YOU/,0" | grep -qF "C-3: decision overridden — \"Badge colour?\" is now \"neutral\" (was \"brand\"), by Ben at 2026-10-22T09:00:00.000Z"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-140 AC8 and only once" '! echo "$out" | grep -q "decision overridden"'
rm "$T/digest/last.json"
out=$(node "$B/pass.mjs" --json 2>&1)
check "DS-140 AC1 a pass past a slot builds the digest and pushes it" 'pushes | grep -q "^digest:20" && ls "$T/digest"/*.md >/dev/null 2>&1'
first=$(pushes); pages=$(ls "$T/digest"/*.md | wc -l)
out=$(node "$B/pass.mjs" --json 2>&1)
check "DS-140 AC4 the next pass builds no second page, and carries the same key for a failed notification to retry" '[ "$(ls "$T/digest"/*.md | wc -l)" = "$pages" ] && [ "$(pushes | grep -o "digest:[^ ]*")" = "$(echo "$first" | grep -o "digest:[^ ]*")" ]'
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Check-in times | `08:00, 17:00` | `8am and 5pm` |\n'; } > "$T/config-c.md"
q add C-4; q set C-4 state=triaged lane=A branch=fix/C-4
out=$(DESK_CONFIG="$T/config-c.md" node "$B/pass.mjs" 2>&1)
check "DS-140 AC3 a malformed Check-in times row holds spawns under STALLED, naming the row" 'echo "$out" | awk "/^STALLED/,0" | grep -qF "config §3b \"Check-in times\" is \"8am and 5pm\"" && ! echo "$out" | grep -q "spawned: C-4"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-140 AC3 and the same ticket spawns once the row reads" 'echo "$out" | grep -q "spawned: C-4"'

# DS-145: a worker killed mid-run (its log ends without a result event, no marker, no open PR) is
# resumed in its own session. The stub spawn-worker records each call and whether it was a resume.
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue-k.json" DESK_AUTOPILOT_STATE="$T/state-k" AUTOPILOT_PORT_FLOOR=47701
mkdir -p "$T/state-k/logs"; : > "$T/spawns"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1 \$3 port=\${AUTOPILOT_PORT:-} resume=\${AUTOPILOT_RESUME:+yes}" >> "$T/spawns"; echo "[spawn] ticket=\$1"
EOF
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}]'" > "$T/stub/claude"
result_event(){ node -e 'console.log(JSON.stringify({ type: "result", is_error: false, num_turns: 3, total_cost_usd: 0.5, result: "ended" }))'; }
killed(){ mkdir -p "$T/wt/$1"; q add "$1"; q set "$1" state=running lane=A "branch=fix/$1" "worktree=$T/wt/$1" "session_id=$2" port=47750 stage=4/9
  say "AUTOPILOT_STAGE: 4/9 verify" > "$T/state-k/logs/$1.log"; touch -t 202601010000 "$T/state-k/logs/$1.log"; }
spawned_for(){ grep "^$1 " "$T/spawns"; }
q init k
killed K-1 sess-k1
out=$(DESK_BOOT_TIME=2026-06-01T00:00:00Z node "$B/pass.mjs" 2>&1)
check "DS-145 AC1 a worker killed by a reboot is resumed in its own session, and the pass says so" 'echo "$out" | grep -q "K-1 resumed after it was killed (1 of 2) — the computer restarted after its last log write" && spawned_for K-1 | grep -q "^K-1 sess-k1 port=47750 resume=yes$"'
check "DS-145 AC1 it keeps its session, branch and worktree, and counts the resume" '[ "$(field K-1 state)" = "\"running\"" ] && [ "$(field K-1 session_id)" = "\"sess-k1\"" ] && [ "$(field K-1 branch)" = "\"fix/K-1\"" ] && [ "$(field K-1 worktree)" = "\"$T/wt/K-1\"" ] && [ "$(field K-1 resumes)" = 1 ] && [ "$(field K-1 resume)" = null ] && grep -q "4/9 verify" "$T/state-k/logs/K-1.log"'
# K-1's resumed worker counts as live while K-2 is killed.
q set K-1 session_id=live-1
killed K-2 sess-k2
out=$(DESK_BOOT_TIME=2020-01-01T00:00:00Z node "$B/pass.mjs" 2>&1)
check "DS-145 AC2 a worker whose process died with the computer up is resumed, and the report says so" 'echo "$out" | grep -q "K-2 resumed after it was killed (1 of 2) — its process died while the computer stayed up" && spawned_for K-2 | grep -q "resume=yes" && ! echo "$out" | grep -q "K-1 resumed"'
q set K-2 state=done
# K-1's resumed worker is killed again, once it has had both resumes the row allows.
q set K-1 session_id=sess-k1 resumes=2
out=$(DESK_BOOT_TIME=2020-01-01T00:00:00Z node "$B/pass.mjs" 2>&1)
check "DS-145 AC3 a ticket resumed as often as the row allows is parked, naming the limit and the session" '[ "$(field K-1 state)" = "\"parked\"" ] && field K-1 park.question | grep -q "after 2 resume(s), the most config §3b ..Resume a killed worker (times).. allows (2), so it is not resumed. Session sess-k1" && [ "$(spawned_for K-1 | wc -l | tr -d " ")" = 1 ]'
# K-4 ended normally: its log's last event is the result.
killed K-4 sess-k4; result_event >> "$T/state-k/logs/K-4.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-145 AC4 a session that ended normally with no marker is marked failed, not resumed" '[ "$(field K-4 state)" = "\"failed\"" ] && echo "$out" | grep -q "K-4: exited with no marker and no open PR on fix/K-4" && ! spawned_for K-4'
# K-4b ended normally too, and the CLI wrote a command_lifecycle event after its result, as real logs show.
killed K-4b sess-k4b; { result_event; echo '{"type":"command_lifecycle","state":"completed","session_id":"sess-k4b"}'; } >> "$T/state-k/logs/K-4b.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-145 AC4 bookkeeping after the result still reads as a normal end" '[ "$(field K-4b state)" = "\"failed\"" ] && ! spawned_for K-4b'
# K-9's log was written seconds ago: before a boot a minute from now it was a reboot, so resumed at
# once; with the computer up it may be a worker the registry has not listed yet, so it is left.
killed K-9 sess-k9; touch "$T/state-k/logs/K-9.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-145 a log written in the last 2 minutes with the computer up is left running" '[ "$(field K-9 state)" = "\"running\"" ] && ! spawned_for K-9 && echo "$out" | grep -q "K-9: not in the session registry, but its log was written in the last 2 minutes"'
out=$(DESK_BOOT_TIME=$(( $(date +%s) + 60 )) node "$B/pass.mjs" 2>&1)
check "DS-145 AC1 a log written just before a reboot is resumed on the first pass" 'spawned_for K-9 | grep -q "resume=yes" && echo "$out" | grep -q "K-9 resumed after it was killed (1 of 2) — the computer restarted"'
q set K-9 state=done
# K-5 is stopped as wedged this pass (its session gone from the registry), then a pass runs again.
killed K-5 sess-k5; q set K-5 idle_passes=5 "log_bytes=$(wc -c < "$T/state-k/logs/K-5.log" | tr -d ' ')"
out=$(node "$B/pass.mjs" 2>&1); out=$out$(node "$B/pass.mjs" 2>&1)
check "DS-145 AC5 a worker stopped as wedged is not resumed" '! spawned_for K-5 && ! echo "$out" | grep -q "K-5 resumed"'
q set K-5 state=done
# K-6: the row is 0.
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Resume a killed worker (times) | `2` | `0` |\n'; } > "$T/config-k0.md"
killed K-6 sess-k6
out=$(DESK_CONFIG="$T/config-k0.md" node "$B/pass.mjs" 2>&1)
check "DS-145 AC6 with the row at 0 a killed worker is marked failed, and the report says resuming is off" '[ "$(field K-6 state)" = "\"failed\"" ] && echo "$out" | grep -q "K-6: killed before it finished .*Resuming is off (config §3b \"Resume a killed worker (times)\" is 0)" && ! spawned_for K-6'
# K-3 was queued to resume, then the row went to 0 before a slot freed.
killed K-3 sess-k3; q set K-3 state=triaged resume=pending "resume_why=its process died while the computer stayed up"
out=$(DESK_CONFIG="$T/config-k0.md" node "$B/pass.mjs" 2>&1)
check "DS-145 AC6 a resume still waiting when the row goes to 0 is marked failed, not resumed" '[ "$(field K-3 state)" = "\"failed\"" ] && ! spawned_for K-3 && echo "$out" | grep -q "K-3: killed before it finished, and could not be resumed: Resuming is off"'
# K-7 is killed while the batch's one slot is held by a live worker; N-1 is a new ticket behind it.
q set-batch concurrency=1 concurrency_by=user
q add L-1; q set L-1 state=running lane=A branch=fix/L-1 session_id=live-1; say "AUTOPILOT_STAGE: 3/9 implement" > "$T/state-k/logs/L-1.log"
q add N-1; q set N-1 state=triaged lane=A branch=fix/N-1
killed K-7 sess-k7
out=$(node "$B/pass.mjs" 2>&1)
check "DS-145 AC7 with no free slot the killed worker waits to resume, and the report says so" '[ "$(field K-7 state)" = "\"triaged\"" ] && [ "$(field K-7 resume)" = "\"pending\"" ] && [ "$(field K-7 session_id)" = "\"sess-k7\"" ] && echo "$out" | grep -q "waiting to resume (killed; resumed ahead of new tickets when a slot frees): K-7" && ! spawned_for K-7'
q set L-1 state=done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-145 AC7 when a slot frees it is resumed ahead of a new ticket" 'spawned_for K-7 | grep -q "^K-7 sess-k7 .*resume=yes$" && [ "$(field N-1 state)" = "\"triaged\"" ]'
say "AUTOPILOT_DONE: pr=77 jira=none" >> "$T/state-k/logs/K-7.log"
q set N-1 state=done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-145 AC8 a resumed worker that prints DONE is recorded done, keeping its resume count" '[ "$(field K-7 state)" = "\"done\"" ] && [ "$(field K-7 result.pr)" = 77 ] && [ "$(field K-7 resumes)" = 1 ]'
node -e 'const f = process.argv[1], q = JSON.parse(require("fs").readFileSync(f, "utf8")); for (const t of Object.values(q.tickets)) if (t.state !== "done") t.state = "done"; require("fs").writeFileSync(f, JSON.stringify(q))' "$DESK_QUEUE"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-145 AC8 the batch report lists the resumes" 'echo "$out" | grep -q "^resumed after a kill: .*K-7 1 time(s) (done)"'
q set K-1 state=triaged resume=pending resume_why=x
out=$(node "$B/queue.mjs" requeue K-1 2>&1)
check "DS-145 a requeue clears a pending resume" '[ "$(field K-1 resume)" = null ] && [ "$(field K-1 resume_why)" = null ] && [ "$(field K-1 session_id)" = null ]'
check "DS-145 the config template has the row, recommended 2" 'grep -qE "^\| Resume a killed worker \(times\) \| \`2\` \| \`TODO\`" "$SRC/desk-config.md"'

echo "pass: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
