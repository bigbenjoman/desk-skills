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
# The process listing a pass reads for each kept worktree: what $T/lsof.out says, else nothing.
printf '#!/bin/sh\ncat "%s/lsof.out" 2>/dev/null\nexit 0\n' "$T" > "$T/stub/lsof"
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/lsof"
# Finishes the batch: every ticket done and every PR merged, so the next pass reports it idle.
all_done(){ node -e 'const f = process.argv[1], q = JSON.parse(require("fs").readFileSync(f, "utf8")); for (const t of Object.values(q.tickets)) { t.state = "done"; if (t.result?.pr != null) { t.merged_at ??= "2026-10-23T10:00:00Z"; t.pr_status = { pr: t.result.pr, state: "MERGED", merged_at: t.merged_at, checks: [] }; } } require("fs").writeFileSync(f, JSON.stringify(q))' "$DESK_QUEUE"; }

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
for k in T-1 T-2 T-3; do mkdir -p "$T/state/images/$k"; : > "$T/state/images/$k/after-desktop.png"; done
# I-1 and I-2: finished workers that captured nothing, naming a directory that is missing or empty.
q add I-1; q set I-1 state=running branch=fix/I-1 session_id=gone
say "AUTOPILOT_IMAGES: $T/state/images/I-1/" "AUTOPILOT_DONE: pr=11 jira=none" > "$T/state/logs/I-1.log"
q add I-2; q set I-2 state=running branch=fix/I-2 session_id=gone
mkdir -p "$T/state/images/I-2"; : > "$T/state/images/I-2/notes.txt"
say "AUTOPILOT_IMAGES: $T/state/images/I-2/" "AUTOPILOT_DONE: pr=12 jira=none" > "$T/state/logs/I-2.log"

out=$(node "$B/pass.mjs" 2>&1)
check "the log's PR wins over the stored one"           'grep -qx "2 $T/state/images/T-1/" "$T/uploads"'
check "nothing goes to the stored PR when the log has one" '! grep -q "^1 " "$T/uploads"'
check "the stored PR is used when the log has none"     'grep -qx "5 $T/state/images/T-2/" "$T/uploads"'
check "the finished round records the log's PR"         '[ "$(field T-1 result.pr)" = 2 ]'
check "DS-193 AC1 a missing image directory runs no upload and reports nothing" '! grep -q "^11 " "$T/uploads" && ! echo "$out" | grep -q "I-1: image" && [ "$(field I-1 images_uploaded)" = "\"none\"" ] && [ "$(field I-1 state)" = "\"done\"" ]'
check "DS-193 AC2 a directory with no image runs no upload and reports nothing" '! grep -q "^12 " "$T/uploads" && ! echo "$out" | grep -q "I-2: image" && [ "$(field I-2 images_uploaded)" = "\"none\"" ] && [ "$(field I-2 state)" = "\"done\"" ]'
check "DS-193 AC3 a directory with screenshots still uploads and is reported" 'echo "$out" | grep -q "T-1 images → #2" && [ "$(field T-1 images_uploaded)" = true ]'

# T-3: round one finished with PR 1 and uploaded; it is requeued for a deliberate re-run.
q add T-3; q set T-3 state=triaged branch=fix/T-3 result.pr=1 result.summary=old images_uploaded=true images_reported=true draft_pr=1
say "AUTOPILOT_IMAGES: $T/state/images/T-3/" "AUTOPILOT_DONE: pr=1 jira=none" > "$T/state/logs/T-3.log"
echo older > "$T/state/logs/T-3.log.round1"
: > "$T/uploads"
out=$(AUTOPILOT_RERUN=T-3 node "$B/pass.mjs" 2>&1)
check "the requeued ticket spawns"                      '[ "$(field T-3 state)" = "\"running\"" ]'
check "spawn clears result"                             '[ "$(field T-3 result)" = null ]'
check "spawn clears images_uploaded"                    '[ "$(field T-3 images_uploaded)" = null ]'
check "spawn clears images_reported"                    '[ "$(field T-3 images_reported)" = null ]'
check "DS-201 spawn clears the last round's draft_pr"   '[ "$(field T-3 draft_pr)" = null ]'
check "spawn moves the log to the next free round, compressed" '! grep -q "pr=1" "$T/state/logs/T-3.log" && gzip -dc "$T/state/logs/T-3.log.round2.gz" | grep -q "pr=1" && [ ! -e "$T/state/logs/T-3.log.round2" ] && grep -qx older "$T/state/logs/T-3.log.round1"'
check "DS-158 AC3 a preflight that reports no cost leaves it unknown in the spawn line and the new log" 'echo "$out" | grep -q "T-3 port=.*; preflight cost unknown, turns unknown" && grep -q "\"type\":\"desk_preflight\",\"total_cost_usd\":null,\"num_turns\":null" "$T/state/logs/T-3.log"'

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
check "requeue moves the finished log aside"            '[ ! -e "$T/state/logs/T-4.log" ] && gzip -dc "$T/state/logs/T-4.log.round2.gz" | grep -q "pr=4"'
check "requeue moves log, park and answer to one round" '[ ! -e "$T/state/logs/T-4.log.round1" ] && [ ! -e "$T/state/logs/T-4.log.round1.gz" ] && [ ! -e "$T/state/parks/T-4.json" ] && grep -q yesterday "$T/state/parks/T-4.json.round2" && grep -q older "$T/state/parks/T-4.json.round1" && [ ! -e "$T/state/answers/T-4.txt" ] && [ -e "$T/state/answers/T-4.txt.round2" ]'
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

# P-1: a live worker that opens its draft PR at Stage 7 and carries on. The stub gh has it open.
printf '#!/bin/sh\ncase "$*" in *"--head fix/P-1"*) echo 77 ;; esac\n' > "$T/stub/gh"
q add P-1; q set P-1 state=running branch=fix/P-1 session_id=live-1 stage=5/9
say "AUTOPILOT_STAGE: 6/9 evidence" > "$T/state/logs/P-1.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-201 AC2 before Stage 7 the pass does not look for the PR"      '[ "$(field P-1 draft_pr)" = null ]'
say "AUTOPILOT_STAGE: 7/9 pr" >> "$T/state/logs/P-1.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-201 AC2 a PR a running worker opened is kept as draft_pr"      '[ "$(field P-1 draft_pr)" = 77 ] && [ "$(field P-1 state)" = "\"running\"" ] && echo "$out" | grep -q "P-1 opened PR #77"'
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
q drop P-1

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
all_done
out=$(node "$B/pass.mjs" 2>&1)
check "AC3 an idle batch gives the scope total"         'echo "$out" | grep -q "^IDLE" && echo "$out" | grep -q "scope: 1 of 2 checked ticket(s) changed files outside their triaged scope, 2 file(s) in all"'
check "DS-122 an idle batch gives each worker's cost, unknown where its log has no result event" 'echo "$out" | grep -q "^WORKER COST" && echo "$out" | grep -qE "^  T-15 +1 +unknown +unknown +unknown +none +unknown" && echo "$out" | grep -qE "^  total .*not counted\)$"'

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
bfield(){ node -e 'console.log(JSON.stringify(process.argv[2].split(".").reduce((o, k) => o?.[k], JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) ?? null))' "$DESK_QUEUE" "$1"; }
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
# The ladder moved to its reference file with DS-202's split.
SK="$SRC/skills/desk-autopilot/references/concurrency-and-memory.md"
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
# The same for a named batch's queue beside that repo's standing one.
X1="$T/desk/repos/acme__other/batches/X-1"; mkdir -p "$X1"; other '{"tickets":{}}'
printf '%s\n' '{"tickets":{"X-2":{"key":"X-2","state":"running","port":47501}}}' > "$X1/queue.json"
spawn_one P-174
check "DS-305 AC1 a port a named batch's running worker holds is skipped" '[ "$(field P-174 state)" = "\"running\"" ] && [ "$(field P-174 port)" = 47502 ]'
printf '%s\n' '{"tickets": not json' > "$X1/queue.json"
spawn_one P-175
check "DS-305 AC4 an unreadable named batch's queue does not stop the spawn, and the report names it" '[ "$(field P-175 state)" = "\"running\"" ] && [ "$(field P-175 port)" = 47501 ] && echo "$out" | grep -qF "ports: $X1/queue.json is not valid JSON ("'
rm -rf "$T/desk/repos/acme__other/batches"; other '{"tickets": not json'

# DS-121: a worker at the 5-hour usage limit. The event is built from the provisional fixture (the
# real event at the limit has not been captured yet), with its reset moved to suit each case. Each
# case is a running ticket whose log stopped growing five passes ago, one pass from the stall killer.
export DESK_QUEUE="$T/queue-u.json" DESK_AUTOPILOT_STATE="$T/state-u" AUTOPILOT_PORT_FLOOR=47601; mkdir -p "$T/state-u/logs"
limit_event(){ node -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); e.rate_limit_info.resetsAt = Number(process.argv[2]); if (process.argv[3]) e.rate_limit_info.rateLimitType = process.argv[3]; console.log(JSON.stringify(e))' "$S/fixtures/usage-limit-five-hour.provisional.json" "$1" "${2:-}"; }
# The registry stub also answers the probe call (claude -p): what the probe says is $T/probe.out.
# probe_says limited <resetsAt> [type] | ok
probe_says(){ if [ "$1" = ok ]; then { say "ok"; echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'; } > "$T/probe.out"
  else { limit_event "$2" "${3:-}"; echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"api_error":"usage_limit_reached","result":"usage limit reached"}'; } > "$T/probe.out"; fi; }
stub_claude(){ printf '#!/bin/sh\nif [ "$1" = -p ]; then echo "$*" >> "%s/probes"; cat "%s/probe.out"; exit 0; fi\necho %s\n' "$T" "$T" "'$1'" > "$T/stub/claude"; }
quiet_running(){ q add "$1"; q set "$1" state=running lane=A "branch=fix/$1" "session_id=$2" idle_passes=5 "log_bytes=$(wc -c < "$T/state-u/logs/$1.log" | tr -d ' ')"; }
now=$(date +%s)
q init u
LPID=$( (sleep 300 >/dev/null 2>&1 & echo $!) )
stub_claude "[{\"sessionId\": \"live-1\"}, {\"sessionId\": \"lim-1\", \"pid\": $LPID}]"
probe_says limited $((now + 3600))

# U-1: a live worker at the limit is never stopped or parked, whatever an old config row says.
{ say "AUTOPILOT_STAGE: 3/9 implement"; limit_event $((now + 3600)); } > "$T/state-u/logs/U-1.log"
quiet_running U-1 lim-1
{ cat "$T/config.md"; echo '| `autopilot-usage-resume` | Resume across the usage limit | `no` | `no` |'; } > "$T/config-old-row.md"
out=$(DESK_CONFIG="$T/config-old-row.md" node "$B/pass.mjs" 2>&1)
check "DS-344 AC4b a worker at the 5-hour limit is paused, never parked, whatever the retired row says" '[ "$(field U-1 state)" = "\"running\"" ] && [ "$(field U-1 park)" = null ] && kill -0 "$LPID" 2>/dev/null && ! echo "$out" | grep -q "worker was stopped"'
kill "$LPID" 2>/dev/null
q set U-1 state=done
# U-7: the worker resumed before any pass saw it paused: it carries on, and the batch notes say so.
{ limit_event $((now - 60)); say "AUTOPILOT_STAGE: 5/9 evidence"; } > "$T/state-u/logs/U-7.log"
quiet_running U-7 live-1; q set U-7 idle_passes=0
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 a worker that resumed before a pass saw it carries on, and is not parked" '[ "$(field U-7 state)" = "\"running\"" ] && grep -q "^- \[U-7\] resumed after the 5-hour usage limit (reset at .* UTC)" "$T/state-u/batch-notes.md"'
q set U-7 state=done
# U-8: the session registry cannot be read: a worker at the limit is left running, and the pass says so.
printf '#!/bin/sh\nexit 1\n' > "$T/stub/claude"
{ say "AUTOPILOT_STAGE: 3/9 implement"; limit_event $((now + 3600)); } > "$T/state-u/logs/U-8.log"
quiet_running U-8 live-1; q set U-8 idle_passes=0
out=$(node "$B/pass.mjs" 2>&1)
check "DS-121 AC2 an unreadable registry leaves a worker at the limit running, and says so" '[ "$(field U-8 state)" = "\"running\"" ] && echo "$out" | grep -q "could not read the session registry"'
stub_claude '[{"sessionId": "live-1"}]'; q set U-8 state=done

# U-2: the reset an hour away: paused, not wedged, and the quiet count cleared.
{ say "AUTOPILOT_STAGE: 4/9 verify"; limit_event $((now + 3600)); } > "$T/state-u/logs/U-2.log"
quiet_running U-2 live-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-121 AC1 a worker paused at the limit is reported with its reset time" 'echo "$out" | grep -q "^paused on the usage limit: U-2 on the 5-hour usage limit until $(date -u -r $((now + 3600)) "+%Y-%m-%d %H:%M" 2>/dev/null || date -u -d "@$((now + 3600))" "+%Y-%m-%d %H:%M") UTC, then it resumes"'
check "DS-121 AC1 and is not stopped as wedged"          '[ "$(field U-2 state)" = "\"running\"" ] && [ "$(field U-2 idle_passes)" = 0 ] && ! echo "$out" | grep -q "U-2: no output"'

# U-3: the model answered after the limit: the batch notes record the resume.
{ limit_event $((now - 60)); say "AUTOPILOT_STAGE: 5/9 evidence"; } > "$T/state-u/logs/U-3.log"
quiet_running U-3 live-1; q set U-3 idle_passes=0
out=$(node "$B/pass.mjs" 2>&1)
check "DS-121 AC3 a resumed worker's resume is in the batch notes" 'grep -q "^- \[U-3\] resumed after the 5-hour usage limit (reset at .* UTC)" "$T/state-u/batch-notes.md"'
check "DS-121 AC3 a resumed worker is not reported paused" '[ "$(field U-3 state)" = "\"running\"" ] && ! echo "$out" | grep -q "paused on the usage limit: .*U-3"'
q set U-2 state=done; q set U-3 state=done

# U-9: a rejection with no reset time is still the limit: paused until a probe call succeeds.
{ say "AUTOPILOT_STAGE: 4/9 verify"; echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}'; } > "$T/state-u/logs/U-9.log"
quiet_running U-9 live-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 a rejection with no reset time is a pause, not a stall" '[ "$(field U-9 state)" = "\"running\"" ] && echo "$out" | grep -q "^paused on the usage limit: U-9 on the 5-hour usage limit, then it resumes"'
q set U-9 state=done

# U-4: a rate-limit event that is neither traffic under the limit nor a rejection is named, not
# guessed at, and the stall check runs as before. U-5's only event is ordinary traffic, and the limit
# event appears only quoted inside a tool result: neither is a pause.
{ say "AUTOPILOT_STAGE: 4/9 verify"; echo '{"type":"rate_limit_event","rate_limit_info":{"status":"throttled","rateLimitType":"five_hour"}}'; } > "$T/state-u/logs/U-4.log"
quiet_running U-4 live-1
{ say "AUTOPILOT_STAGE: 4/9 verify"; cat "$S/fixtures/usage-limit-allowed.json"
  node -e 'console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: process.argv[1] }] } }))' "$(limit_event $((now + 3600)))"
} > "$T/state-u/logs/U-5.log"
quiet_running U-5 live-1
# U-6: resume granted, but the reset passed over half an hour ago with nothing since: the stall check.
limit_event $((now - 7200)) > "$T/state-u/logs/U-6.log"
quiet_running U-6 live-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-121 an unrecognised usage-limit event is named in the pass output" 'echo "$out" | grep -q "^unrecognised usage-limit event: U-4: {\"type\":\"rate_limit_event\""'
check "DS-121 and falls back to the stall check"         '[ "$(field U-4 state)" = "\"parked\"" ] && field U-4 park | grep -q wedged'
check "DS-121 traffic under the limit, or a quoted event, is not a pause" '[ "$(field U-5 state)" = "\"parked\"" ] && field U-5 park | grep -q wedged && ! echo "$out" | grep -q "unrecognised usage-limit event: U-5"'
check "DS-121 a limit long past its reset falls back to the stall check" '[ "$(field U-6 state)" = "\"parked\"" ] && field U-6 park | grep -q wedged'

# A worker always restarts after a limit, so the row that chose between that and a park is gone.
check "DS-344 the retired autopilot-usage-resume row is not in the template or desk-setup" '! grep -q "autopilot-usage-resume" "$SRC/desk-config.md" "$SRC/skills/desk-setup/references/permission-rows.md"'
q set U-4 state=done; q set U-5 state=done; q set U-6 state=done

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

# N-1 settles one question by checking, then parks on another, naming its inputs. The person
# answers "not now"; the same park again is not asked, and one whose inputs changed is, saying what.
NQ='Rotate the production database password?'
nlog(){ { say 'AUTOPILOT_CHECKED: {"question":"Is the DNS record in?","checked":"dig +short api.acme.dev","showed":"203.0.113.7"}' \
  "AUTOPILOT_PARK: $NQ" "AUTOPILOT_PARK_INPUTS: {\"ticket\":\"N-1\",\"pr-head\":\"$1\"}"; result_event; } > "$T/state-d/logs/N-1.log"; }
result_event(){ node -e 'console.log(JSON.stringify({ type: "result", is_error: false, num_turns: 3, total_cost_usd: 0.5, result: "ended" }))'; }
nlog a1; q add N-1; q set N-1 state=running branch=fix/N-1 session_id=run-N-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-143 AC2 a question settled by checking is logged with what was checked and what it showed" 'grep -F "\"N-1\"" "$dlog" | grep -F "\"kind\":\"check\"" | grep -qF "\"showed\":\"203.0.113.7\""'
check "DS-143 a park stores the inputs it named" '[ "$(field N-1 state)" = "\"parked\"" ] && [ "$(field N-1 park.inputs)" = "{\"ticket\":\"N-1\",\"pr-head\":\"a1\"}" ]'
check "DS-143 and is asked" 'echo "$out" | grep -q "^NOTIFY: .*N-1"'
out=$(node "$B/answer.mjs" N-1 "not now" 2>&1)
reg="$T/state-d/not-now.jsonl"
check "DS-143 AC5 a not-now answer lands in the register with the question, date and inputs" 'echo "$out" | grep -q "N-1: put off in" && node -e "const e = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\").trim()); process.exit(e.question === process.argv[2] && /^20/.test(e.at) && e.inputs[\"pr-head\"] === \"a1\" && e.ticket === \"N-1\" ? 0 : 1)" "$reg" "$NQ"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-143 AC6 a parked question put off is no longer waiting on the person" '! echo "$out" | grep -q "^NOTIFY: .*N-1"'
nlog a1; q set N-1 state=running
out=$(node "$B/pass.mjs" 2>&1)
check "DS-143 AC6 the same question with unchanged inputs is not asked again" '[ "$(field N-1 state)" = "\"parked\"" ] && ! echo "$out" | grep -q "^NOTIFY: .*N-1" && echo "$out" | grep -q "^  N-1: $NQ (put off on 20"'
cp "$reg" "$reg.ok"; printf '{"key": "torn\n' >> "$reg"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-143 AC8 an unreadable register is reported, and the put-off question asked as usual" 'echo "$out" | awk "/^WAITING ON YOU/,0" | grep -q "not-now register: unreadable" && echo "$out" | grep -q "^NOTIFY: .*N-1"'
mv "$reg.ok" "$reg"
nlog a2; q set N-1 state=running
out=$(node "$B/pass.mjs" 2>&1)
check "DS-143 AC7 with changed inputs it is asked, saying what changed" 'echo "$out" | grep -q "^NOTIFY: .*N-1" && echo "$out" | awk "/^PARKED/,0" | grep -qF "N-1: $NQ — Changed since it was put off on" && echo "$out" | grep -qF "pr-head a1 → a2."'
q set N-1 state=done
# N-2's question turns on a config row. Put off, it comes back on the first pass after the row changes.
N2Q='Is the release branch still main?'
{ say "AUTOPILOT_PARK: $N2Q" 'AUTOPILOT_PARK_INPUTS: {"config:default-branch":"main"}'; result_event; } > "$T/state-d/logs/N-2.log"
q add N-2; q set N-2 state=running branch=fix/N-2 session_id=run-N-2
out=$(node "$B/pass.mjs" 2>&1); node "$B/answer.mjs" N-2 "not now" >/dev/null 2>&1; out=$(node "$B/pass.mjs" 2>&1)
check "DS-143 AC6 a put-off park whose config row is unchanged stays put off" '! echo "$out" | grep -q "^NOTIFY: .*N-2"'
sed 's/| Default branch | `main` |/| Default branch | `develop` |/' "$T/config.md" > "$T/config-n2.md"
out=$(DESK_CONFIG="$T/config-n2.md" node "$B/pass.mjs" 2>&1)
check "DS-143 AC7 a changed config row asks the put-off question again, saying what changed" 'echo "$out" | grep -q "^NOTIFY: .*N-2" && echo "$out" | awk "/^PARKED/,0" | grep -qF "N-2: $N2Q — Changed since it was put off on" && echo "$out" | grep -qF "config:default-branch main → develop."'
out=$(node "$B/answer.mjs" N-2 "develop is right" 2>&1)
check "DS-143 a real answer to a put-off question ends the deferral" 'echo "$out" | grep -q "N-2: answered, so its question is no longer put off" && tail -n 1 "$reg" | grep -q "\"cleared\""'
q set N-2 state=done
# N-3 names its inputs with a list; N-4's inputs hold an object, which cannot be read.
{ say 'AUTOPILOT_PARK: Resolve the conflict in the lockfile?' 'AUTOPILOT_PARK_INPUTS: {"conflict_files":["a.ts","b.ts"]}'; result_event; } > "$T/state-d/logs/N-3.log"
{ say 'AUTOPILOT_PARK: Which steps are left?' 'AUTOPILOT_PARK_INPUTS: {"steps":{"pr":true}}'; result_event; } > "$T/state-d/logs/N-4.log"
for k in N-3 N-4; do q add "$k"; q set "$k" state=running "branch=fix/$k" "session_id=run-$k"; done
out=$(node "$B/pass.mjs" 2>&1)
waiting_only(){ echo "$out" | awk '/^WAITING ON YOU/{f=1;next} /^[^ ]/{f=0} f'; }
check "DS-337 AC1 park inputs holding a list are stored, joined" '[ "$(field N-3 state)" = "\"parked\"" ] && [ "$(field N-3 park.inputs)" = "{\"conflict_files\":\"a.ts, b.ts\"}" ] && ! echo "$out" | grep -q "N-3: unreadable park inputs"'
check "DS-337 AC2 unreadable park inputs are logged, not waiting on the person" '[ "$(field N-4 state)" = "\"parked\"" ] && echo "$out" | awk "/^park inputs:/,0" | grep -qF "N-4: unreadable park inputs (inputs must be plain values or lists of them, not steps), read as none" && ! waiting_only | grep -q "unreadable park inputs"'
q set N-3 state=done; q set N-4 state=done

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
# A ticket named in $T/limit-preflight has its preflight refused at the usage limit, and one in
# $T/bad-preflight fails it for another reason. Every preflight is recorded in $T/preflights.
: > "$T/limit-preflight"; : > "$T/bad-preflight"; : > "$T/preflights"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then
  echo "\$1" >> "$T/preflights"
  if grep -qx "\$1" "$T/limit-preflight"; then echo "[preflight] \$1"; echo "[preflight] cost=0.01 turns=1"; echo "[preflight] usage-limit: the account is at its usage limit (You've hit your weekly limit)"; exit 1; fi
  if grep -qx "\$1" "$T/bad-preflight"; then echo "[preflight] \$1"; echo "  W_IN   ?        FAIL (wanted OK)"; exit 1; fi
  echo "[preflight] pass"; exit 0
fi
echo "\$1 \$3 port=\${AUTOPILOT_PORT:-} resume=\${AUTOPILOT_RESUME:+yes}" >> "$T/spawns"; echo "[spawn] ticket=\$1"
EOF
stub_claude '[{"sessionId": "live-1"}]'
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
# K-1's resumed worker is killed again, once it has had both resumes the row allows. Its log was last
# written by the resume's preflight line: set it back, or it reads as a worker the registry has not listed yet.
q set K-1 session_id=sess-k1 resumes=2; touch -t 202601010000 "$T/state-k/logs/K-1.log"
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
all_done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-145 AC8 the batch report lists the resumes" 'echo "$out" | grep -q "^resumed after a kill: .*K-7 1 time(s) (done)"'
q set K-1 state=triaged resume=pending resume_why=x
out=$(node "$B/queue.mjs" requeue K-1 2>&1)
check "DS-145 a requeue clears a pending resume" '[ "$(field K-1 resume)" = null ] && [ "$(field K-1 resume_why)" = null ] && [ "$(field K-1 session_id)" = null ]'
check "DS-145 the config template has the row, recommended 2" 'grep -qE "^\| Resume a killed worker \(times\) \| \`2\` \| \`TODO\`" "$SRC/desk-config.md"'

# DS-197: a headless worker exits at the 5-hour limit rather than waiting for the reset. Its log ends
# as VPL-443's did: the rate_limit_event at the limit, then a result with api_error_status 429.
# usage_exit <KEY> <resetsAt> [type]
usage_exit(){ say "AUTOPILOT_STAGE: 4/9 verify" > "$T/state-k/logs/$1.log"; limit_event "$2" "${3:-}" >> "$T/state-k/logs/$1.log"
  node -e 'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 429, api_error: "usage_limit_reached", num_turns: 40, total_cost_usd: 3.1, result: "usage limit reached" }))' >> "$T/state-k/logs/$1.log"; }
q set K-1 state=done
probe_says limited $(( $(date +%s) + 3600 ))
killed Y-1 sess-y1; q set Y-1 model_tier=standard model=sonnet resumes=1; usage_exit Y-1 $(( $(date +%s) + 3600 ))
out=$(node "$B/pass.mjs" 2>&1)
check "DS-197 AC1 a worker that exited at the limit before the reset is not failed, and is reported paused until it" '[ "$(field Y-1 state)" = "\"running\"" ] && echo "$out" | grep -q "^paused on the usage limit: Y-1 on the 5-hour usage limit until .* UTC" && ! echo "$out" | grep -q "Y-1: exited with no marker" && ! spawned_for Y-1'
usage_exit Y-1 $(( $(date +%s) - 60 ))
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC4b after a 5-hour reset it is queued and resumed in its own session, on the same model tier, with no park" 'echo "$out" | grep -q "Y-1 exited at the 5-hour usage limit, which lifted (its reset at .* UTC passed): queued to resume in its own session" && echo "$out" | grep -q "Y-1 resumed after the usage limit lifted" && spawned_for Y-1 | grep -q "^Y-1 sess-y1 .*resume=yes$" && [ "$(field Y-1 model_tier)" = "\"standard\"" ] && [ "$(field Y-1 model)" = "\"sonnet\"" ] && [ "$(field Y-1 resumes)" = 1 ] && [ "$(field Y-1 park)" = null ] && ! echo "$out" | grep -q "paused on the usage limit: .*Y-1"'
# The resumed session ends before the model answers, so the same limit is still last in its log.
out=$(node "$B/pass.mjs" 2>&1)
check "DS-197 a resume that ends at the same limit is not resumed again" '[ "$(spawned_for Y-1 | wc -l | tr -d " ")" = 1 ] && [ "$(field Y-1 state)" = "\"failed\"" ] && echo "$out" | grep -q "Y-1: exited with no marker and no open PR on fix/Y-1, last seen at the 5-hour usage limit"'
q set Y-1 state=done
# A resumed session that reaches the limit again records a new rejection: it is paused and resumed again.
killed Y-5 sess-y5; usage_exit Y-5 $(( $(date +%s) - 60 ))
out=$(node "$B/pass.mjs" 2>&1)
usage_exit Y-5 $(( $(date +%s) - 120 )); usage_exit Y-5x $(( $(date +%s) - 60 )); cat "$T/state-k/logs/Y-5x.log" >> "$T/state-k/logs/Y-5.log"; q set Y-5 session_id=sess-y5
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 a resume that reaches the limit again is resumed again, not failed" '[ "$(spawned_for Y-5 | wc -l | tr -d " ")" = 2 ] && [ "$(field Y-5 state)" = "\"running\"" ]'
q set Y-5 state=done
killed Y-4 sess-y4; result_event >> "$T/state-k/logs/Y-4.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-197 AC4 an exit with no marker and no limit is marked failed as before" '[ "$(field Y-4 state)" = "\"failed\"" ] && echo "$out" | grep -q "Y-4: exited with no marker and no open PR on fix/Y-4 — check" && ! spawned_for Y-4'

# The same exits with the ticket's PR open. Y-7 is killed mid-run and Y-8 ends normally with no
# marker; then Y-6 exits at the limit, its log ending as usage_exit's does.
printf '#!/bin/sh\ncase "$*" in *"--head fix/Y-"[678]*) echo 88 ;; esac\n' > "$T/stub/gh"
killed Y-7 sess-y7
killed Y-8 sess-y8; result_event >> "$T/state-k/logs/Y-8.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-388 a worker with an open PR killed mid-run is resumed in its own session, not done" 'spawned_for Y-7 | grep -q "^Y-7 sess-y7 .*resume=yes$" && [ "$(field Y-7 result)" = null ] && ! echo "$out" | grep -q "Y-7: PR #88"'
check "DS-388 AC5 a worker with an open PR that ended normally with no marker is done as before" '[ "$(field Y-8 state)" = "\"done\"" ] && [ "$(field Y-8 result.pr)" = 88 ] && echo "$out" | grep -q "Y-8: PR #88 (no marker printed"'
q set Y-7 state=done
probe_says limited $(( $(date +%s) + 3600 ))
killed Y-6 sess-y6; usage_exit Y-6 $(( $(date +%s) + 3600 ))
out=$(node "$B/pass.mjs" 2>&1)
check "DS-388 AC1 a worker with an open PR that exited at the limit stays running, paused, not done" '[ "$(field Y-6 state)" = "\"running\"" ] && [ "$(field Y-6 result)" = null ] && echo "$out" | grep -q "^paused on the usage limit: Y-6 on the 5-hour usage limit until" && ! echo "$out" | grep -q "Y-6: PR #88" && ! spawned_for Y-6'
usage_exit Y-6 $(( $(date +%s) - 60 ))
out=$(node "$B/pass.mjs" 2>&1)
check "DS-388 AC2 once the limit lifts, its own session is resumed in its worktree" 'echo "$out" | grep -q "Y-6 exited at the 5-hour usage limit, which lifted" && spawned_for Y-6 | grep -q "^Y-6 sess-y6 .*resume=yes$" && [ "$(field Y-6 worktree)" = "\"$T/wt/Y-6\"" ] && [ "$(field Y-6 result)" = null ]'
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
q set Y-6 state=done

# DS-344: the weekly limit, as DS-333's log ended: a seven_day rejection, then the 429 result. W-1
# exits there while the probe still gets 429, and W-2 is a new ticket behind it.
q set-batch concurrency=2 concurrency_by=user
wreset=$(( $(date +%s) + 3 * 86400 ))
probe_says limited "$wreset" seven_day; : > "$T/probes"
killed W-1 sess-w1; q set W-1 model_tier=standard model=sonnet; usage_exit W-1 "$wreset" seven_day
q add W-2; q set W-2 state=triaged lane=A branch=fix/W-2
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC1 a worker that exited at the weekly limit is not failed, and is paused with the reset time" '[ "$(field W-1 state)" = "\"running\"" ] && [ "$(field W-1 usage_paused.type)" = "\"seven_day\"" ] && [ "$(field W-1 usage_paused.resets_at)" = "$wreset" ] && echo "$out" | grep -q "^paused on the usage limit: W-1 on the weekly usage limit until .* UTC" && ! spawned_for W-1'
check "DS-344 AC1 the batch holds every spawn on it, after one probe" '[ "$(field W-2 state)" = "\"triaged\"" ] && ! grep -qx W-2 "$T/preflights" && echo "$out" | grep -q "the weekly usage limit until .* holds every spawn and resume" && [ "$(wc -l < "$T/probes" | tr -d " ")" = 1 ] && [ "$(bfield usage_hold.type)" = "\"seven_day\"" ]'
# AC3: a subscription switch, so a probe succeeds days before the reset.
probe_says ok
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC3 once a probe succeeds before the reset, the paused worker resumes in its own session on its model" 'echo "$out" | grep -q "W-1 exited at the weekly usage limit, which lifted (a probe call succeeded): queued to resume in its own session" && spawned_for W-1 | grep -q "^W-1 sess-w1 .*resume=yes$" && [ "$(field W-1 model_tier)" = "\"standard\"" ] && [ "$(field W-1 model)" = "\"sonnet\"" ] && [ "$(field W-1 usage_paused)" = null ]'
check "DS-344 AC3 and the held ticket spawns as normal, with no requeue" '[ "$(field W-2 state)" = "\"running\"" ] && [ "$(bfield usage_hold)" = null ]'
q set W-1 state=done; q set W-2 state=done

# AC2: P-1's preflight is refused at the limit. It is not failed, P-2 is not preflighted, and the
# batch holds until a probe succeeds; then both spawn. AC4: P-3's preflight fails for another reason.
probe_says limited "$wreset" seven_day; : > "$T/preflights"
echo P-1 > "$T/limit-preflight"
for k in P-1 P-2; do q add "$k"; q set "$k" state=triaged lane=A "branch=fix/$k"; done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC2 a preflight refused at the limit leaves its ticket as it was, not failed" '[ "$(field P-1 state)" = "\"triaged\"" ] && [ "$(field P-1 spawn_failed)" = null ] && ! echo "$out" | grep -q "P-1: preflight failed"'
check "DS-344 AC2 nothing else is preflighted or spawned that pass, and the batch is held on the limit" '[ "$(cat "$T/preflights")" = P-1 ] && [ "$(field P-2 state)" = "\"triaged\"" ] && [ "$(bfield usage_hold.preflight)" = "\"P-1\"" ] && [ "$(bfield usage_hold.type)" = "\"seven_day\"" ] && echo "$out" | grep -q "P-1: its preflight was refused at the weekly usage limit"'
: > "$T/preflights"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC2 while the probe is refused, the next pass preflights nothing" '[ ! -s "$T/preflights" ] && [ "$(field P-1 state)" = "\"triaged\"" ]'
: > "$T/limit-preflight"; probe_says ok
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC3 once a probe succeeds, the held tickets spawn with no requeue" '[ "$(field P-1 state)" = "\"running\"" ] && [ "$(field P-2 state)" = "\"running\"" ] && [ "$(bfield usage_hold)" = null ] && echo "$out" | grep -q "the weekly usage limit lifted (a probe call succeeded)"'
q set P-1 state=done; q set P-2 state=done
echo P-3 > "$T/bad-preflight"; q add P-3; q set P-3 state=triaged lane=A branch=fix/P-3
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC4 a preflight that fails for any other reason is marked failed as before" '[ "$(field P-3 state)" = "\"failed\"" ] && [ "$(field P-3 spawn_failed)" = true ] && echo "$out" | grep -q "P-3: preflight failed, not spawned" && [ "$(bfield usage_hold)" = null ]'
q set P-3 state=done; : > "$T/bad-preflight"
# AC4b: F-1's preflight is refused at the 5-hour limit. Its reset then passes while the probe is
# still refused: the first pass after it spawns F-1 with no requeue and no park.
probe_says limited $(( $(date +%s) + 3600 )) five_hour
echo F-1 > "$T/limit-preflight"; q add F-1; q set F-1 state=triaged lane=A branch=fix/F-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC4b a preflight refused at the 5-hour limit holds the batch, not failed" '[ "$(field F-1 state)" = "\"triaged\"" ] && [ "$(bfield usage_hold.type)" = "\"five_hour\"" ] && [ "$(bfield usage_hold.preflight)" = "\"F-1\"" ]'
: > "$T/limit-preflight"
q set-batch "usage_hold={\"since\":\"2026-10-29T00:00:00Z\",\"type\":\"five_hour\",\"resets_at\":$(( $(date +%s) - 60 )),\"preflight\":\"F-1\",\"paused\":[]}"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-344 AC4b once its reset passes, with the probe still refused, it spawns with no requeue or park" '[ "$(field F-1 state)" = "\"running\"" ] && [ "$(field F-1 park)" = null ] && [ "$(bfield usage_hold)" = null ] && echo "$out" | grep -q "the 5-hour usage limit lifted (its reset at .* UTC passed)"'
q set F-1 state=done

# ---- DS-185 AC6: a pass records its next planned pass in its heartbeat, and queue.mjs next-pass sets it later
# The heartbeat's next pass, in whole seconds after its last pass, or "none".
nextin(){ node -e 'const fs = require("fs"), p = require("path"); const d = process.argv[1];
  const h = fs.readdirSync(d).map((x) => JSON.parse(fs.readFileSync(p.join(d, x), "utf8"))).find((x) => x.queue === process.argv[2]);
  console.log(h?.next ? Math.round((Date.parse(h.next) - Date.parse(h.at)) / 1000) : "none")' "$DESK_AUTOPILOT_STATE/orchestrators" "$DESK_QUEUE"; }
out=$(node "$B/pass.mjs" --next +600 2>&1)
check "DS-185 AC6 pass.mjs --next +600 records a next pass 600s after this one" '[ "$(nextin)" = 600 ]'
out=$(node "$B/queue.mjs" next-pass +1200 2>&1); rc=$?
check "DS-185 AC6 queue.mjs next-pass records the next pass the orchestrator scheduled" '[ $rc -eq 0 ] && [ "$(nextin)" -ge 1199 ] && [ "$(nextin)" -le 1260 ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-185 AC6 a pass with no --next records none" '[ "$(nextin)" = none ]'
out=$(node "$B/pass.mjs" --next soon 2>&1); rc=$?
check "DS-185 AC6 a --next that is not a time is refused" '[ $rc -ne 0 ] && grep -q "\-\-next wants +<seconds> or an ISO time" <<< "$out"'

# ---- DS-155: a session that hands off at the end of Stage 4 or 6 is followed by a fresh one --------
# Real git worktrees, since the pass checks the worktree and branch. The stub spawn-worker records the
# stage each spawn starts at and the briefing it was given.
export DESK_QUEUE="$T/queue-h.json" DESK_AUTOPILOT_STATE="$T/state-h"
mkdir -p "$T/state-h/logs" "$T/state-h/answers" "$T/state-h/handoffs"; : > "$T/spawns"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1 \$3 stage=\${AUTOPILOT_START_STAGE:-} branch=\${AUTOPILOT_BRANCH:-} brief=\${4:-}" >> "$T/spawns"; echo "[spawn] ticket=\$1"
EOF
hlog(){ say "$2" > "$T/state-h/logs/$1.log"; result_event >> "$T/state-h/logs/$1.log"; }
# hfile <TICKET> <stage> <verification line> [review line]: the handoff briefing a worker writes, with
# one field no briefing holds.
hfile(){ node -e 'const [k, s, v, r] = process.argv.slice(1); require("fs").writeFileSync(`${process.env.DESK_AUTOPILOT_STATE}/handoffs/${k}.json`, JSON.stringify({ ticket: k, stage: s, criteria: ["AC1: the widget saves"], lane: "A", verification: [v], review: r ? [r] : [], evidence: [], scratch: "SCRATCH-FIELD" }))' "$@"; }
handing(){ git -C "$T/repo" worktree add -q -b "fix/$1" "$T/wt/$1"; q add "$1"; q set "$1" state=running lane=A "branch=fix/$1" "worktree=$T/wt/$1" "session_id=old-$1" stage=4/9; }
brief(){ cat "$T/state-h/briefings/$1.md"; }
q init h
printf '# Batch notes\n\nSIBLING-NOTE about a helper\n' > "$T/state-h/batch-notes.md"
handing H-1; hfile H-1 4b "typecheck: pass"; echo "use the blue widget" > "$T/state-h/answers/H-1.txt"
hlog H-1 "$(printf 'AUTOPILOT_STAGE: 4/9 verify\nAUTOPILOT_HANDOFF: 4b')"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 AC1 a session that prints AUTOPILOT_HANDOFF: 4b is not done, parked or failed, and the report says it handed off" 'echo "$out" | grep -q "H-1 handed off at the end of Stage 4: queued for a fresh session from Stage 4b"'
check "DS-155 AC2 the pass spawns a new session for the ticket, on its branch, starting at Stage 4b" 'spawned_for H-1 | grep -q "^H-1 [0-9a-f-]* stage=4b branch=fix/H-1 brief=$T/state-h/briefings/H-1.md$" && [ "$(field H-1 state)" = "\"running\"" ] && [ "$(field H-1 stage)" = "\"4b\"" ] && echo "$out" | grep -q "spawned: H-1 fresh session from Stage 4b (handed off)"'
check "DS-155 AC2 with a new session id, the same worktree, and the handed-off session's log kept as its own round" '[ "$(field H-1 session_id)" != "\"old-H-1\"" ] && [ "$(field H-1 worktree)" = "\"$T/wt/H-1\"" ] && gzip -dc "$T/state-h/logs/H-1.log.round1.gz" | grep -q "AUTOPILOT_HANDOFF: 4b" && ! grep -q "AUTOPILOT_HANDOFF" "$T/state-h/logs/H-1.log"'
h1=$(node "$B/harvest.mjs" "$T/state-h/logs/H-1.log.round1.gz" 2>&1)
check "DS-158 AC6 harvest reads a compressed round's markers and result" 'grep -q "AUTOPILOT_HANDOFF: 4b" <<< "$h1" && grep -qF "result: error=false turns=3 notional=\$0.50" <<< "$h1"'
check "DS-155 AC4 the briefing holds the key, criteria, branch, lane, verification, findings so far and evidence" 'b=$(brief H-1); for s in "## Handoff: this session starts at Stage 4b" "### Ticket" "AC1: the widget saves" "\`fix/H-1\` in $T/wt/H-1" "### Lane" "typecheck: pass" "### Self-review findings so far" "### Evidence captured"; do grep -qF -- "$s" <<< "$b" || exit 1; done'
check "DS-155 AC4 and nothing else: no field the briefing does not hold, and no sibling notes" '! brief H-1 | grep -q "SCRATCH-FIELD" && ! brief H-1 | grep -q "SIBLING-NOTE"'
check "DS-155 the handoff session's briefing still carries the binding answer" 'brief H-1 | grep -q "use the blue widget"'

# AC3: the Stage 4b session finishes Stage 6 and hands off to Stage 7.
hfile H-1 7 "typecheck: pass" "P2 src/a.js:3 fixed in abc1234 (round 1 at 1111111)"
hlog H-1 "$(printf 'AUTOPILOT_STAGE: 6/9 hygiene\nAUTOPILOT_HANDOFF: 7')"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 AC3 a session that hands off after Stage 6 is followed by one starting at Stage 7" 'echo "$out" | grep -q "H-1 handed off at the end of Stage 6: queued for a fresh session from Stage 7" && [ "$(spawned_for H-1 | tail -1 | grep -o "stage=[^ ]*")" = stage=7 ]'
check "DS-155 AC4 the Stage 7 briefing carries the self-review findings so far" 'brief H-1 | grep -q "## Handoff: this session starts at Stage 7" && brief H-1 | grep -qF "P2 src/a.js:3 fixed in abc1234"'

# AC8: the Stage 7 session parks; requeued, it starts at Stage 7 again, not at Stage 0.
hlog H-1 "AUTOPILOT_PARK: which reviewer handle goes in the PR body?"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 AC8 a handoff session that parks is parked" '[ "$(field H-1 state)" = "\"parked\"" ]'
out=$(node "$B/queue.mjs" requeue H-1 2>&1)
check "DS-155 AC8 a requeue says it starts again where the handoff named" 'echo "$out" | grep -q "it starts again at Stage 7, where its last session was handed off" && [ "$(field H-1 handoff)" = "\"pending\"" ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 AC8 and the respawn starts at Stage 7 in its worktree, not at Stage 0" '[ "$(spawned_for H-1 | wc -l | tr -d " ")" = 3 ] && [ "$(spawned_for H-1 | tail -1 | grep -o "stage=[^ ]*")" = stage=7 ] && [ "$(field H-1 stage)" = 7 ]'

# AC7: the last session finishes. Each of the four sessions' result events says $0.50.
hlog H-1 "AUTOPILOT_DONE: pr=55 jira=none"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 AC7 the ticket's cost adds the sessions that handed off to the one that finished" '[ "$(field H-1 state)" = "\"done\"" ] && [ "$(field H-1 cost)" = "\"1.50\"" ]'

# DS-349 AC8: a park waiting on an Actions run is requeued once the run finishes, and the session that
# follows is told the run's conclusion.
handing H-7; hfile H-7 7 "typecheck: pass"; q set H-7 handoff_stage=7; q park H-7 "waiting on e2e run 4104"; q clears-when H-7 "run 4104 completed"
printf '#!/bin/sh\ncase "$1 $2" in "run view") echo "{\\"status\\":\\"completed\\",\\"conclusion\\":\\"success\\"}" ;; esac\nexit 0\n' > "$T/stub/gh"
out=$(node "$B/pass.mjs" 2>&1)
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
check "DS-349 AC8 the finished run requeues it with no person, and its next session spawns" 'echo "$out" | grep -q "H-7: \"Actions run 4104 completed, conclusion success\" holds: requeued" && [ "$(field H-7 state)" = "\"running\"" ]'
check "DS-349 AC8 its briefing names the park and the run's conclusion" 'brief H-7 | grep -qF "## What cleared your last park" && brief H-7 | grep -qF "The last round parked on: waiting on e2e run 4104" && brief H-7 | grep -qF "A pass found it settled: Actions run 4104 completed, conclusion success."'
check "DS-349 the note is cleared once a session has it" '[ "$(field H-7 cleared)" = null ]'
q set H-7 state=done

# AC6: the worktree, or the branch, is gone by the time the pass reads the handoff.
q add H-2; q set H-2 state=running lane=A branch=fix/H-2 "worktree=$T/wt/H-2-gone" session_id=old-H-2; hfile H-2 4b x
hlog H-2 "AUTOPILOT_HANDOFF: 4b"
git -C "$T/repo" worktree add -q -b fix/H-3 "$T/wt/H-3"; q add H-3; q set H-3 state=running lane=A branch=fix/H-3-gone "worktree=$T/wt/H-3" session_id=old-H-3; hfile H-3 4b x
hlog H-3 "AUTOPILOT_HANDOFF: 4b"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 AC6 a handoff whose worktree is gone parks naming the worktree, and spawns nothing" '[ "$(field H-2 state)" = "\"parked\"" ] && field H-2 park.question | grep -qF "handoff to Stage 4b: its worktree $T/wt/H-2-gone no longer exists, so no session was spawned" && ! spawned_for H-2'
check "DS-155 AC6 a handoff whose branch is gone parks naming the branch, and spawns nothing" '[ "$(field H-3 state)" = "\"parked\"" ] && field H-3 park.question | grep -qF "its branch fix/H-3-gone no longer exists" && ! spawned_for H-3'
# A stage no session starts at, and a handoff with no briefing written.
handing H-5; hlog H-5 "AUTOPILOT_HANDOFF: 5"
handing H-6; hlog H-6 "AUTOPILOT_HANDOFF: 4b"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 a handoff to a stage no session starts at parks, naming it" '[ "$(field H-5 state)" = "\"parked\"" ] && field H-5 park.question | grep -qE "5\\\\\", which no session starts at \(only Stage (4b or 7|7 or 4b)\), so no session was spawned" && ! spawned_for H-5'
check "DS-155 a handoff with no briefing written parks, naming the file" '[ "$(field H-6 state)" = "\"parked\"" ] && field H-6 park.question | grep -qF "its handoff briefing $T/state-h/handoffs/H-6.json does not exist" && ! spawned_for H-6'

# AC5: a handoff briefing over the cap is cut to it with the note, and the answer after it survives.
handing H-4; hfile H-4 4b "$(node -e 'process.stdout.write("v".repeat(70000))')"; echo "keep the H-4 answer" > "$T/state-h/answers/H-4.txt"
hlog H-4 "AUTOPILOT_HANDOFF: 4b"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 AC5 an oversized handoff briefing is cut to the cap with a note saying so" 'spawned_for H-4 | grep -q "stage=4b" && [ "$(brief H-4 | wc -c | tr -d " ")" -le 60100 ] && brief H-4 | grep -qF "[briefing truncated to stay under the argv limit]"'
check "DS-155 AC5 and the cut never drops the binding answer" 'brief H-4 | grep -q "keep the H-4 answer"'

# AC7: the batch report's row adds every session's tokens and cost.
all_done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-155 AC7 the batch report's row for a ticket whose sessions handed off counts every session's run and cost" 'echo "$out" | grep -qE "^  H-1 +4 .* \\\$2\.00 "'

# ---- DS-156: a requeue after a park at Stage 3 or later resumes that round ------------------------
# Each ticket parks in a real worktree on its branch; the requeue's spawn is read one ticket at a time.
git -C "$T/repo" update-ref refs/remotes/origin/main main
parking(){ handing "$1"; q set "$1" stage=0/9; hlog "$1" "$(printf 'AUTOPILOT_STAGE: %s\nAUTOPILOT_PARK: %s' "$2" "$3")"; }
resumefile(){ mkdir -p "$T/wt/$1/.claude"; printf '{"ticket":"%s","branch":"%s"}' "$1" "$2" > "$T/wt/$1/.claude/desk-ticket-$1.json"; }
stateresume(){ mkdir -p "$DESK_AUTOPILOT_STATE/resume"; printf '{"ticket":"%s","branch":"%s"}' "$1" "$2" > "$DESK_AUTOPILOT_STATE/resume/$1.json"; }
respawn(){ q requeue "$1"; out=$(node "$B/pass.mjs" 2>&1); }
parking R-1 "4/9 verify" "which colour does the badge take?"
git -C "$T/wt/R-1" commit -q --allow-empty -m "feat: R-1 the badge"; resumefile R-1 fix/R-1
parking R-2 "2/9 understand" "is the badge in scope?"
parking R-3 "5/9 evidence" "which page shows it?"; resumefile R-3 fix/R-3-old
parking R-4 "4/9 verify" "which size?"
parking R-5 "6/9 hygiene" "which reviewer?"
parking R-6 "4/9 verify" "which border?"; stateresume R-6 fix/R-6-old
out=$(node "$B/pass.mjs" 2>&1)
check "DS-156 a worker's park records the stage its round reached and its question" '[ "$(field R-1 state)" = "\"parked\"" ] && [ "$(field R-1 last_round.stage)" = "\"4/9\"" ] && [ "$(field R-1 last_round.question)" = "\"which colour does the badge take?\"" ]'
node "$B/answer.mjs" R-1 "green, as on the cards" >/dev/null 2>&1
respawn R-1
check "DS-156 AC1 the respawn's briefing holds the last round: the stage, the park question and its answer, the branch and its commits" 'b=$(brief R-1); for s in "## Last round: this session resumes at Stage 4" "which colour does the badge take?" "- green, as on the cards" "\`fix/R-1\` in $T/wt/R-1" "feat: R-1 the badge"; do grep -qF -- "$s" <<< "$b" || exit 1; done'
check "DS-156 AC2 with a resume file on its branch, the worker starts at the stage the summary names" 'spawned_for R-1 | grep -q "^R-1 [0-9a-f-]* stage=4 branch=fix/R-1 " && [ "$(field R-1 stage)" = 4 ] && [ "$(field R-1 last_round)" = null ] && echo "$out" | grep -q "R-1 .*resumed at Stage 4, where its last round parked"'
check "DS-156 a resumed round keeps the sibling notes" 'brief R-1 | grep -q "SIBLING-NOTE"'
check "DS-339 the resumed round names the resume file it checked" 'brief R-1 | grep -qF "read your resume file $T/wt/R-1/.claude/desk-ticket-R-1.json where there is one"'
q set R-1 state=done
respawn R-5
check "DS-156 AC2 a worktree on its branch with no resume file resumes too" 'spawned_for R-5 | grep -q "stage=6 " && brief R-5 | grep -qF "## Last round: this session resumes at Stage 6"'
check "DS-339 with no resume file, the resumed round names the worker's in the state dir" 'brief R-5 | grep -qF "read your resume file $DESK_AUTOPILOT_STATE/resume/R-5.json where there is one"'
q set R-5 state=done
# R-2's round carries notes far over the cap, and an answer.
cp "$T/state-h/batch-notes.md" "$T/notes.keep"
node -e 'let s = "# Batch notes\n\n## MEMORY — mandatory\n\nHEADER-RULE cap the runner\n\n"; for (let i = 1; i <= 600; i++) s += `- [X-${i}] NOTE-${i} a helper a sibling found, padded to a realistic length\n`; process.stdout.write(s)' > "$T/state-h/batch-notes.md"
node "$B/answer.mjs" R-2 "the badge is in scope" >/dev/null 2>&1
respawn R-2
check "DS-156 AC3 a round that parked before Stage 3 starts at Stage 0 with no last-round summary" 'spawned_for R-2 | grep -q "stage= " && [ "$(field R-2 stage)" = "\"0/9\"" ] && ! brief R-2 | grep -q "## Last round"'
notes_block(){ brief "$1" | sed -n '/^## What sibling workers/,$p'; }
check "DS-362 AC1 notes over the cap: the briefing's sibling-notes block is within it" '[ "$(notes_block R-2 | wc -c | tr -d " ")" -le 16000 ]'
check "DS-362 AC2 the cut block keeps the header and the newest note, drops the oldest, and names the full file" 'b=$(notes_block R-2); grep -q "^## MEMORY" <<< "$b" && grep -q "HEADER-RULE" <<< "$b" && grep -q "NOTE-600 " <<< "$b" && ! grep -q "NOTE-1 " <<< "$b" && grep -qF "every note is in $T/state-h/batch-notes.md: grep it" <<< "$b"'
check "DS-362 AC4 the cut keeps the binding answer" 'brief R-2 | grep -q "the badge is in scope"'
cp "$T/notes.keep" "$T/state-h/batch-notes.md"
q set R-2 state=done
respawn R-3
check "DS-156 AC4 a resume file on another branch starts at Stage 0, and the first stage line it is given says why" 'spawned_for R-3 | grep -q "stage= " && brief R-3 | grep -qF "AUTOPILOT_STAGE: 0/9 triage (not resumed from Stage 5: its resume file is for branch fix/R-3-old, not the queue'"'"'s fix/R-3)" && echo "$out" | grep -q "R-3 .*from Stage 0 (not resumed from Stage 5"'
q set R-3 state=done
git -C "$T/repo" worktree remove --force "$T/wt/R-4"
respawn R-4
check "DS-156 AC5 a requeue that removed the worktree has no last-round summary, and starts at Stage 0" 'spawned_for R-4 | grep -q "stage= " && ! brief R-4 | grep -q "## Last round"'
q set R-4 state=done
respawn R-6
check "DS-339 AC2 a worker's resume file in the state dir on another branch starts at Stage 0, saying why" 'spawned_for R-6 | grep -q "stage= " && brief R-6 | grep -qF "its resume file is for branch fix/R-6-old, not the queue'"'"'s fix/R-6"'
check "DS-339 the not-resumed briefing names the state-dir file it rejected" 'brief R-6 | grep -qF "do not resume from its resume file $DESK_AUTOPILOT_STATE/resume/R-6.json"'
check "DS-339 a round started at Stage 0 moves the stale state-dir resume file aside" '[ ! -e "$DESK_AUTOPILOT_STATE/resume/R-6.json" ] && [ -f "$DESK_AUTOPILOT_STATE/resume/R-6.json.old" ]'

# ---- DS-191: a triage record from before epics were recorded gets its epic read by the next pass
cat >> "$T/config.md" <<'EOF'

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | `jira` |
| Ticket key pattern | `T-[0-9]+` |
EOF
ln -s "$B/ticket-facts.mjs" "$T/desk/bin/ticket-facts.mjs"
cat > "$T/stub/desk-jira" <<'EOF'
#!/bin/sh
echo "$*" >> "$JIRA_CALLS"
case "$1 $2" in
  "get T-50") echo '{"key":"T-50","fields":{"parent":{"key":"T-9","fields":{"summary":"The epic","issuetype":{"name":"Epic","hierarchyLevel":1}}}}}' ;;
  "children T-9") echo '[{"key":"T-50","fields":{"status":{"statusCategory":{"key":"new"}}}},{"key":"T-49","fields":{"status":{"statusCategory":{"key":"done"}}}}]' ;;
  "get T-51") echo '{"key":"T-51","fields":{}}' ;;
  *) echo "desk-jira: 404 for $2" >&2; exit 1 ;;
esac
EOF
chmod +x "$T/stub/desk-jira"
export JIRA_CALLS="$T/jira-calls"; : > "$JIRA_CALLS"
for k in T-50 T-51 T-52 T-53 T-54; do q add $k; done
q set T-52 state=done; q set T-50 state=triaged; q set T-51 state=triaged; q set T-53 state=triaged; q set T-54 state=triaged
TR="$DESK_AUTOPILOT_STATE/triage"; mkdir -p "$TR"
printf '{"ticket":"T-50","lane":"A","size":"S"}' > "$TR/T-50.json"
printf '{"ticket":"T-51","lane":"A"}' > "$TR/T-51.json"
printf '{"ticket":"T-52","lane":"A"}' > "$TR/T-52.json"
printf '{"ticket":"T-53","lane":"A"}' > "$TR/T-53.json"
printf '{"ticket":"T-54","lane":"A","epic":null}' > "$TR/T-54.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-191 a record with no epic key gets its epic and children from Jira, the rest kept" \
  '[ "$(jq -c "[.epic.key, .epic.summary, [.epic.children[] | [.key, .done]], .lane, .size]" "$TR/T-50.json")" = "[\"T-9\",\"The epic\",[[\"T-50\",false],[\"T-49\",true]],\"A\",\"S\"]" ]'
check "DS-191 a ticket Jira shows with no epic parent records epic null" '[ "$(jq -c "[has(\"epic\"), .epic]" "$TR/T-51.json")" = "[true,null]" ]'
check "DS-191 a record already read (epic null) and a done ticket are not looked up" \
  '! grep -q "T-54\|T-52" "$JIRA_CALLS" && [ "$(jq -c . "$TR/T-54.json")" = "{\"ticket\":\"T-54\",\"lane\":\"A\",\"epic\":null}" ]'
check "DS-191 a read that fails leaves the record unread and the pass says so" \
  '[ "$(jq -c "has(\"epic\")" "$TR/T-53.json")" = false ] && grep -q "^epics: read for 2 of 3 triage record(s) written before epics were recorded — not read, tried again next pass: T-53  epic NOT READ: desk-jira: 404 for T-53" <<< "$out"'
: > "$JIRA_CALLS"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-191 the next pass reads only the record still unread" '[ "$(cut -d" " -f1-2 "$JIRA_CALLS")" = "get T-53" ]'

# ---- DS-158: each spawn's preflight cost is logged and shown; a log that grows only when a message ends
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue-p.json" DESK_AUTOPILOT_STATE="$T/state-p"
mkdir -p "$T/state-p/logs"
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ] && [ "$1" = P-2 ]; then printf '[preflight] %s\n[preflight] cost=0.05 turns=2\n  W_IN   BLOCKED  FAIL (wanted OK)\n' "$1"; exit 1; fi
if [ "$3" = preflight ]; then printf '[preflight] %s\n[preflight] cost=0.4321 turns=9\n[preflight] pass\n' "$1"; exit 0; fi
echo "[spawn] ticket=$1"
EOF
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}]'" > "$T/stub/claude"
q init p
q add P-1; q set P-1 state=triaged lane=A branch=fix/P-1
q add P-2; q set P-2 state=triaged lane=A branch=fix/P-2
out=$(node "$B/pass.mjs" 2>&1)
check "DS-158 AC1 the spawn line shows the preflight's cost and turns" 'echo "$out" | grep -q "^spawned: P-1 port=.*; preflight \$0.43, 9 turn(s)"'
check "DS-158 AC1 and the ticket's log holds them" 'grep -q "\"type\":\"desk_preflight\",\"total_cost_usd\":0.4321,\"num_turns\":9" "$T/state-p/logs/P-1.log"'
check "DS-158 a failed preflight's cost is in the failure and the ticket's log too" '[ "$(field P-2 state)" = "\"failed\"" ] && echo "$out" | grep -q "preflight \$0.05, 2 turn(s)" && grep -q "\"type\":\"desk_preflight\",\"total_cost_usd\":0.05,\"num_turns\":2" "$T/state-p/logs/P-2.log"'
# P-1's worker is in long model turns: with no partial messages its log grows only when a message
# ends, here once every five passes. Today's threshold, six quiet passes, still applies.
q set P-1 session_id=live-1 idle_passes=0 "log_bytes=$(wc -c < "$T/state-p/logs/P-1.log" | tr -d ' ')"
for _ in 1 2; do
  for _ in 1 2 3 4 5; do out=$(node "$B/pass.mjs" 2>&1); done
  say "AUTOPILOT_STAGE: 3/9 implement" >> "$T/state-p/logs/P-1.log"
done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-158 AC5 a log that grows once a message, five passes apart, is never parked as wedged" '[ "$(field P-1 state)" = "\"running\"" ] && [ "$(field P-1 idle_passes)" = 0 ]'
for _ in 1 2 3 4 5; do out=$(node "$B/pass.mjs" 2>&1); done
check "DS-158 AC5 five quiet passes are not yet a stall" '[ "$(field P-1 state)" = "\"running\"" ] && [ "$(field P-1 idle_passes)" = 5 ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-158 AC5 the sixth parks it as wedged, as before" '[ "$(field P-1 state)" = "\"parked\"" ] && field P-1 park | grep -q wedged'

# ---- DS-194: each done ticket's PR state and checks are recorded as pr_status, until it merges or closes
export DESK_QUEUE="$T/queue-g.json" DESK_AUTOPILOT_STATE="$T/state-g"
mkdir -p "$T/state-g/logs"
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr view 300 "*) echo '{"state":"OPEN","url":"https://github.com/acme/widgets/pull/300","statusCheckRollup":[{"__typename":"CheckRun","name":"tests (ubuntu-latest)","workflowName":"ci","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-10-23T10:00:00Z","completedAt":"2026-10-23T10:07:35Z","detailsUrl":"https://github.com/acme/widgets/actions/runs/1/job/2"},{"__typename":"CheckRun","name":"tests (macos-latest)","workflowName":"ci","status":"QUEUED","conclusion":"","startedAt":"2026-10-23T10:00:00Z","completedAt":"0001-01-01T00:00:00Z","detailsUrl":"https://github.com/acme/widgets/actions/runs/1/job/3"}]}' ;;
  "pr view 301 "*) echo '{"state":"MERGED","url":"https://github.com/acme/widgets/pull/301","statusCheckRollup":[]}' ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
q init g
q add G-1; q set G-1 state=done result.pr=300
q add G-2; q set G-2 state=done result.pr=301
q add G-3; q set G-3 state=done
: > "$T/gh-calls"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-194 AC1 an open PR's state, and each check's name, status, conclusion, start and runner, are recorded with the read time" \
  '[ "$(field G-1 pr_status | jq -c "[.pr, .state, .url, [.checks[] | [.name, .status, .conclusion, .started, .runner]], (.at | test(\"^[0-9]{4}-\"))]")" = "[300,\"OPEN\",\"https://github.com/acme/widgets/pull/300\",[[\"tests (ubuntu-latest)\",\"completed\",\"success\",\"2026-10-23T10:00:00Z\",true],[\"tests (macos-latest)\",\"queued\",null,\"2026-10-23T10:00:00Z\",false]],true]" ]'
check "DS-194 AC2 a merged PR is recorded merged" '[ "$(field G-2 pr_status.state)" = "\"MERGED\"" ]'
check "DS-194 one gh call per done ticket with a PR, none for one without" '[ "$(grep -c "^pr view" "$T/gh-calls")" = 2 ] && [ "$(field G-3 pr_status)" = null ]'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-194 AC2 the next pass reads the open PR again and makes no call for the merged one" '[ "$(cut -d" " -f1-3 "$T/gh-calls")" = "pr view 300" ]'

# ---- DS-175: a merge is recorded however the PR was merged, and a missing eta history is built once
ago(){ node -e 'console.log(new Date(Date.now() - Number(process.argv[1]) * 3600e3).toISOString())' "$1"; }
SPAWNED=$(ago 5); MERGED=$(ago 2)
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr view 400 "*) echo '{"state":"MERGED","url":"https://github.com/acme/widgets/pull/400","mergedAt":"$MERGED","statusCheckRollup":[]}' ;;
  "pr view 501 "*) if [ -f "$T/n-merged" ]; then echo '{"state":"MERGED","url":"https://github.com/acme/widgets/pull/501","mergedAt":"$MERGED","statusCheckRollup":[]}'
                   else echo '{"state":"OPEN","url":"https://github.com/acme/widgets/pull/501","mergedAt":"0001-01-01T00:00:00Z","statusCheckRollup":[]}'; fi ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
lines(){ wc -l < "$DESK_AUTOPILOT_STATE/eta-history.jsonl" | tr -d ' '; }
keyed(){ grep -c "\"key\":\"$1\"" "$DESK_AUTOPILOT_STATE/eta-history.jsonl"; }

# AC1: a done ticket whose PR was merged by hand, in a repo that already has a history.
export DESK_QUEUE="$T/queue-m.json" DESK_AUTOPILOT_STATE="$T/state-m"
mkdir -p "$T/state-m/logs"
printf '%s\n' '{"key":"OLD-1","size":"S","spawned_at":"2026-10-01T00:00:00Z","merged_at":"2026-10-01T03:00:00Z","hours":3}' > "$T/state-m/eta-history.jsonl"
q init m
q add M-1; q set M-1 state=done result.pr=400 "spawned_at=$SPAWNED"
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-175 AC1 a hand-merged PR gives the ticket GitHub's merge time" "[ \"\$(field M-1 merged_at)\" = '\"$MERGED\"' ]"
check "DS-175 AC1 and the history gains exactly one line for it" '[ "$(lines)" = 2 ] && [ "$(keyed M-1)" = 1 ] && echo "$out" | grep -q "merge recorded: M-1 (PR #400)"'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-175 AC1 the next pass records nothing again and reads no PR" '[ "$(lines)" = 2 ] && [ ! -s "$T/gh-calls" ] && ! echo "$out" | grep -q "merge recorded"'
q set M-1 merged_at=null; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-175 AC1 a merged PR status kept from before is recorded from it, with no gh call and no second line" \
  "[ \"\$(field M-1 merged_at)\" = '\"$MERGED\"' ] && [ ! -s \"\$T/gh-calls\" ] && [ \"\$(keyed M-1)\" = 1 ]"

# AC2: a repo with no history file: the pass builds it once, and later passes only append.
export DESK_QUEUE="$T/queue-n.json" DESK_AUTOPILOT_STATE="$T/state-n"
mkdir -p "$T/state-n/logs"
q init n
q add N-1; q set N-1 state=done result.pr=500 "spawned_at=$SPAWNED" "merged_at=$MERGED" \
  "pr_status={\"pr\":500,\"state\":\"MERGED\",\"merged_at\":\"$MERGED\",\"checks\":[]}"
q add N-2; q set N-2 state=done result.pr=501 "spawned_at=$SPAWNED"
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-175 AC2 a missing history is built from the queue, the same as desk-q-eta.mjs build" \
  '[ "$(lines)" = 1 ] && [ "$(keyed N-1)" = 1 ] && echo "$out" | grep -q "eta history built: eta history: 1 line(s) added"'
touch "$T/n-merged"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-175 AC2 the next pass only appends the new merge: no rebuild and no merged-PR listing" \
  '[ "$(lines)" = 2 ] && [ "$(keyed N-1)" = 1 ] && [ "$(keyed N-2)" = 1 ] && ! echo "$out" | grep -q "eta history built" && ! grep -q "^pr list" "$T/gh-calls"'
export DESK_QUEUE="$T/queue-e.json" DESK_AUTOPILOT_STATE="$T/state-e"
mkdir -p "$T/state-e/logs"; q init e
out=$(node "$B/pass.mjs" 2>&1)
check "DS-175 AC2 a build with nothing to add still leaves the file, so it is built once" '[ -f "$T/state-e/eta-history.jsonl" ] && [ "$(lines)" = 0 ]'

# ---- DS-180: a ticket closed out from an interactive session is recorded done by the next pass
export DESK_QUEUE="$T/queue-co.json" DESK_AUTOPILOT_STATE="$T/state-co"
mkdir -p "$T/state-co/logs"; q init co
q add CO-1; q park CO-1 "which copy?"
q add CO-2; q park CO-2 "which tier?"
q add CO-3; q park CO-3 "which plan?"; node "$B/closeout.mjs" CO-3 >/dev/null; q set CO-3 added_at=2099-01-01T00:00:00.000Z
out=$(node "$B/closeout.mjs" CO-1 --pr 400 2>&1)
check "DS-180 AC8 closing out a parked ticket leaves a note for the batch and says so" '[ -f "$T/state-co/closed-out/CO-1.json" ] && echo "$out" | grep -q "^CO-1 is parked in batch co: noted for its orchestrator"'
out=$(node "$B/closeout.mjs" NOPE-1 --how "done" 2>&1)
check "DS-180 AC10 closing out a ticket in no batch writes nothing and says nothing" '[ -z "$out" ] && [ ! -f "$T/state-co/closed-out/NOPE-1.json" ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-180 AC9 the next pass records it done with its PR, and clears the note" \
  '[ "$(field CO-1 state)" = "\"done\"" ] && [ "$(field CO-1 result.pr)" = 400 ] && [ "$(field CO-1 park)" = null ] && [ ! -f "$T/state-co/closed-out/CO-1.json" ] && echo "$out" | grep -q "CO-1: closed out from an interactive session (merged, PR #400)"'
check "DS-180 AC9 a ticket nobody closed out stays parked" '[ "$(field CO-2 state)" = "\"parked\"" ]'
check "DS-180 a note older than the ticket's place in the queue is stale: dropped, and the ticket stays parked" '[ "$(field CO-3 state)" = "\"parked\"" ] && [ ! -f "$T/state-co/closed-out/CO-3.json" ]'

# ---- DS-221: PR draft, review and mergeable state, outside blockers, and the pass record
cat "$T/config.md" > "$T/config-j.md"
cat >> "$T/config-j.md" <<EOF

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`J-[0-9]+\` |
EOF
export DESK_CONFIG="$T/config-j.md" DESK_QUEUE="$T/queue-j.json" DESK_AUTOPILOT_STATE="$T/state-j"
mkdir -p "$T/state-j/logs" "$T/state-j/triage" "$T/jira"
ln -s "$B/ticket-facts.mjs" "$T/desk/bin/ticket-facts.mjs"
cat > "$T/stub/desk-jira" <<EOF
#!/bin/sh
echo "\$*" >> "$T/jira-calls"
[ -f "$T/jira-down" ] && { echo "jira: 503 Service Unavailable" >&2; exit 1; }
[ "\$1" = get ] && cat "$T/jira/\$2.json"
EOF
cat > "$T/stub/gh" <<EOF
#!/bin/sh
[ -f "$T/gh-down" ] && exit 1
case "\$*" in
  "pr view 600 "*) echo '{"state":"OPEN","url":"https://github.com/acme/widgets/pull/600","isDraft":true,"reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","statusCheckRollup":[]}' ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/stub/desk-jira" "$T/stub/gh"
blocked(){ printf '{"fields":{"issuelinks":[{"type":{"inward":"is blocked by"},"inwardIssue":{"key":"X-9","fields":{"status":{"statusCategory":{"key":"%s"}}}}},{"type":{"inward":"is blocked by"},"inwardIssue":{"key":"J-2","fields":{"status":{"statusCategory":{"key":"new"}}}}}]}}\n' "$1" > "$T/jira/J-1.json"; }
pass_rec(){ node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pass ?? {}; console.log(JSON.stringify(process.argv[2].split(".").reduce((o, k) => o?.[k], p) ?? null))' "$DESK_QUEUE" "$1"; }
q init j
q add J-1; q set J-1 state=triaged open_questions=1
q add J-2; q set J-2 state=triaged open_questions=1
q add J-4; q set J-4 state=done result.pr=600
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-9","category":"new"},{"key":"J-2","category":"new"}]}' > "$T/state-j/triage/J-1.json"
printf '%s\n' '{"epic":null,"blockers":[]}' > "$T/state-j/triage/J-2.json"
blocked indeterminate
: > "$T/jira-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC1 a draft PR records isDraft, reviewDecision and mergeable as GitHub reports them" \
  '[ "$(field J-4 pr_status | jq -c "[.isDraft, .reviewDecision, .mergeable]")" = "[true,\"REVIEW_REQUIRED\",\"MERGEABLE\"]" ]'
check "DS-221 AC2 an open blocker outside the batch is recorded with its status category, read again from Jira; one inside the batch is not" \
  '[ "$(field J-1 outside_blockers | jq -c .)" = "[{\"key\":\"X-9\",\"category\":\"indeterminate\"}]" ] && [ "$(cat "$T/jira-calls")" = "get J-1 --json" ]'
check "DS-221 a ticket with no outside blockers records none and is not read from Jira" '[ "$(field J-2 outside_blockers)" = "[]" ]'
check "DS-221 AC4 a pass a session ran names session" '[ "$(pass_rec by)" = "\"session\"" ] && [ "$(pass_rec errors)" = 0 ]'
STATUS_AT=$(field J-4 pr_status.at); SESSION_AT=$(pass_rec at)
check "DS-219 a pass a session ran records its time as the last session pass" '[ "$(pass_rec session_at)" = "$SESSION_AT" ]'
: > "$T/jira-calls"; touch "$T/gh-down"; out=$(node "$B/pass.mjs" --by supervisor 2>&1)
check "DS-221 outside blockers are not read from Jira again within the intake interval" '[ ! -s "$T/jira-calls" ]'
check "DS-221 AC4 a pass the supervisor ran names supervisor" '[ "$(pass_rec by)" = "\"supervisor\"" ]'
check "DS-219 a pass the supervisor ran keeps the last session pass" '[ "$(pass_rec session_at)" = "$SESSION_AT" ] && [ "$(pass_rec at)" != "$SESSION_AT" ]'
check "DS-221 AC8 a GitHub read that fails keeps the PR status as it was" '[ "$(field J-4 pr_status.at)" = "$STATUS_AT" ] && [ "$(field J-4 pr_status.isDraft)" = true ]'
rm -f "$T/gh-down"
blocked "done"; touch "$T/jira-down"; q set J-1 outside_blockers_read=null
out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC8 a Jira read that fails keeps the outside blockers as they were, and says so" \
  '[ "$(field J-1 outside_blockers | jq -c "[.[].key]")" = "[\"X-9\"]" ] && echo "$out" | grep -q "outside blockers: not read, kept as they were"'
rm -f "$T/jira-down"; q set J-1 outside_blockers_read=null
out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC3 a blocker now Done is no longer among the outside blockers" '[ "$(field J-1 outside_blockers)" = "[]" ]'
: > "$T/jira-calls"; q set J-1 outside_blockers_read=null; out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 a ticket left with no outside blockers is not read from Jira again" '[ ! -s "$T/jira-calls" ]'
# AC5 and AC6: a ticket that could spawn, held by memory, then spawned.
q add J-5; q set J-5 state=triaged
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-221 AC5 a pass memory held records why it spawned nothing" '[ "$(field J-5 state)" = "\"triaged\"" ] && pass_rec held | grep -q "^\"memory: "'
check "DS-221 AC6 a pass that started, merged and released nothing records no progress" '[ "$(pass_rec progress_at)" = null ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC6 a pass that started a ticket records its own time as the last progress" \
  '[ "$(field J-5 state)" = "\"running\"" ] && [ "$(pass_rec progress_at)" = "$(pass_rec at)" ] && [ "$(pass_rec held)" = null ]'
PROGRESS=$(pass_rec progress_at)
q set J-5 state=done; out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC6 the next pass that does none of those leaves the last progress unchanged" '[ "$(pass_rec progress_at)" = "$PROGRESS" ] && [ "$(pass_rec at)" != "$PROGRESS" ]'
q set J-2 open_questions=0; q hold J-2 J-1; out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 the pass record lists the tickets it found held" '[ "$(pass_rec held_tickets | jq -c .)" = "[\"J-2\"]" ]'
q set J-2 state=triaged park=null held_by=null open_questions=1; out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC6 a ticket released since the last pass is progress" '[ "$(pass_rec progress_at)" = "$(pass_rec at)" ] && [ "$(pass_rec held_tickets)" = "[]" ]'
# A merge recorded with a time later than the pass that found it (it merged mid-pass) counts once.
q set J-4 merged_at=2099-01-01T00:00:00.000Z; out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC6 a ticket merged since the last pass is progress" '[ "$(pass_rec progress_at)" = "$(pass_rec at)" ] && [ "$(pass_rec merged_tickets | jq -c .)" = "[\"J-4\"]" ]'
PROGRESS=$(pass_rec progress_at); out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC6 a merge already counted is not progress again, however late its merge time" '[ "$(pass_rec progress_at)" = "$PROGRESS" ] && [ "$(pass_rec at)" != "$PROGRESS" ]'
# A ticket admitted behind a blocker in no batch is lifted only once the blocker is Done and its PR has
# merged to the base, or once its link is removed.
cat > "$T/stub/gh" <<EOF
#!/bin/sh
case "\$*" in
  "pr view 600 "*) echo '{"state":"OPEN","url":"https://github.com/acme/widgets/pull/600","isDraft":true,"reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","statusCheckRollup":[]}' ;;
  *"--search X-7 "*) cat "$T/prs-x7.json" ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
x7(){ printf '{"fields":{"issuelinks":[{"type":{"inward":"is blocked by"},"inwardIssue":{"key":"X-7","fields":{"status":{"statusCategory":{"key":"%s"}}}}}]}}\n' "$1" > "$T/jira/J-7.json"
  printf '[{"number":70,"state":"%s","title":"fix(x): X-7 a thing","headRefName":"fix/X-7-thing","baseRefName":"main","mergeCommit":null}]\n' "$2" > "$T/prs-x7.json"
  q set J-7 outside_blockers_read=null; }
q add J-7; q set J-7 state=parked held_by=X-7 held_outside=X-7 'park={"question":"held by orchestrator: blocked by X-7 — starts once their PRs merge"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-7","category":"new"}]}' > "$T/state-j/triage/J-7.json"
x7 new MERGED; out=$(node "$B/pass.mjs" 2>&1)
check "DS-391 AC1 a blocker in no batch whose PR merged but is not Done keeps the ticket held, and not STUCK" \
  '[ "$(field J-7 state)" = "\"parked\"" ] && [ "$(field J-7 held_outside)" = "\"X-7\"" ] && ! echo "$out" | grep -q "J-7: STUCK"'
x7 'done' OPEN; out=$(node "$B/pass.mjs" 2>&1)
check "DS-391 AC4 a blocker Done in Jira whose PR has not merged to the base keeps the ticket held" \
  '[ "$(field J-7 state)" = "\"parked\"" ] && [ "$(field J-7 held_by)" = "\"X-7\"" ] && ! echo "$out" | grep -q "J-7: STUCK"'
x7 'done' MERGED; out=$(node "$B/pass.mjs" 2>&1)
check "DS-391 AC1 once the blocker is Done and its PR merged to the base, the pass releases the ticket" \
  '[ "$(field J-7 state)" = "\"triaged\"" ] && [ "$(field J-7 held_by)" = null ] && [ "$(field J-7 held_outside)" = null ] && echo "$out" | grep -q "outside hold: J-7: X-7 Done and on main; RELEASED"'
q set J-7 state=parked held_by=X-8 held_outside=X-8 'park={"question":"held by orchestrator: blocked by X-8 — starts once their PRs merge"}'
printf '%s\n' '{"epic":null,"blockers":[]}' > "$T/state-j/triage/J-7.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-391 AC1 a blocker in no batch whose link was removed no longer holds the ticket" \
  '[ "$(field J-7 state)" = "\"triaged\"" ] && [ "$(field J-7 held_outside)" = null ] && echo "$out" | grep -q "outside hold: J-7: X-8 no longer linked as a blocker; RELEASED"'
q drop J-7
# AC7: a pass that errors (here: no repo config to read its permissions from), twice, then one that succeeds.
out=$(DESK_CONFIG="$T/no-such-config.md" DESK_REPO_ROOT="$T/repo" DESK_WORKTREES_DIR="$T/wt" DESK_GH_REPO=acme/widgets node "$B/pass.mjs" 2>&1)
check "DS-221 AC7 a pass that errors counts one error and holds its first line" '[ "$(pass_rec errors)" = 1 ] && pass_rec error | grep -q "no repo config found"'
out=$(DESK_CONFIG="$T/no-such-config.md" DESK_REPO_ROOT="$T/repo" DESK_WORKTREES_DIR="$T/wt" DESK_GH_REPO=acme/widgets node "$B/pass.mjs" 2>&1)
check "DS-221 AC7 a second error in a row counts two" '[ "$(pass_rec errors)" = 2 ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC7 the next pass that succeeds sets the count to 0" '[ "$(pass_rec errors)" = 0 ] && [ "$(pass_rec error)" = null ]'

# ---- DS-222: a done ticket's draft PR leaves draft under Stage 7's rules
# The fake gh: every PR is an open draft with one green check until `pr ready` marks it ready
# (u/<n>.ready), or refuses while u/<n>.fail exists. Each carries a clean verdict from `ben` at
# HEAD_A; #704's head has moved on to HEAD_B since, #705 conflicts with its base, and GitHub has not
# worked out #708's mergeability yet.
HEAD_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; HEAD_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
NODE=$(command -v node); mkdir -p "$T/u"
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/gh-calls', a.join(' ') + '\n');
const n = a[2]; const has = (f) => fs.existsSync('$T/u/' + n + f);
const fields = a[a.indexOf('--json') + 1] ?? '';
const green = [{ __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const mergeable = n === '705' ? 'CONFLICTING' : n === '708' ? 'UNKNOWN' : 'MERGEABLE';
const verdict ='<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=$HEAD_A p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->\n**desk-review, round 1: clean at \`aaaaaaa\`**';
if (a[0] === 'pr' && a[1] === 'view' && fields.startsWith('state,')) {
  console.log(JSON.stringify({ state: 'OPEN', url: 'https://github.com/acme/widgets/pull/' + n, isDraft: !has('.ready'), mergeable,
    statusCheckRollup: green }));
} else if (a[0] === 'pr' && a[1] === 'view' && fields.startsWith('headRefOid,')) {
  console.log(JSON.stringify({ headRefOid: n === '704' ? '$HEAD_B' : '$HEAD_A', mergeable, mergeStateStatus: n === '705' ? 'DIRTY' : n === '708' ? 'UNKNOWN' : 'DRAFT', body: '## Summary',
    reviews: [{ author: { login: 'ben' }, body: verdict }], statusCheckRollup: green }));
} else if (a[0] === 'pr' && a[1] === 'ready') {
  if (has('.fail')) { console.error('GraphQL: Something went wrong while executing your query.'); process.exit(1); }
  fs.writeFileSync('$T/u/' + n + '.ready', '');
} else if (a[0] === 'pr' && a[1] === 'comment') { /* recorded in gh-calls */ }
else if (a[0] === 'pr' && a[1] === 'list') console.log('[]');
else if (a[0] === 'api' && /\/issues\/\d+\/events/.test(a[2])) {
  // A PR's convert_to_draft events, as REDRAFT_JQ prints them, from u/<n>.events; u/<n>.events-fail refuses.
  const f = '$T/u/' + a[2].match(/issues\/(\d+)\//)[1] + '.events';
  if (fs.existsSync(f + '-fail')) { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
  if (fs.existsSync(f)) process.stdout.write(fs.readFileSync(f, 'utf8'));
}
else process.exit(1);
EOF
chmod +x "$T/stub/gh"
# The config with pr-ready set to $1, a GitHub handle, a review command and a clean verdict.
uconfig(){
  cat > "$T/config-u.md" <<EOF
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
| \`pr-ready\` | Undraft PRs | \`yes\` | \`$1\` |
EOF
  cat >> "$T/config-u.md" <<'EOF'

## 1. Identity
| Field | Value |
|---|---|
| GitHub handle | `ben` |

## 4. Checks
| Field | Value |
|---|---|
| Local review command | `/desk-review` |
| Clean review verdict | `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0` |
EOF
}
export DESK_CONFIG="$T/config-u.md" DESK_QUEUE="$T/queue-ud.json" DESK_AUTOPILOT_STATE="$T/state-ud"
mkdir -p "$T/state-ud/logs"
q init ud
for k in 1 4 5 6 7 8; do q add "U-$k"; q set "U-$k" state=done "result.pr=70$k"; done
q set-batch spine=U-6
touch "$T/u/707.fail"
readied(){ grep -c "^pr ready $1 --repo acme/widgets" "$T/gh-calls"; }

uconfig no; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-222 AC3 pr-ready no: a clean, green PR stays draft" '[ "$(readied 701)" = 0 ] && [ "$(field U-1 undraft.call)" = "\"person\"" ]'
check "DS-222 AC3 and the ticket needs the person, with undraft #<n> as the action" \
  '[ "$(field U-1 undraft.action)" = "\"undraft #701\"" ] && echo "$out" | grep -q "U-1: DRAFT — PR #701 stays draft: it is clean and green, and config §3 pr-ready is \"no\". Undraft #701"'
uconfig ask; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-222 AC3 pr-ready ask with no batch approval: it stays draft and needs the person" \
  '[ "$(readied 701)" = 0 ] && echo "$out" | grep -q "PR #701 stays draft: .*pr-ready is \"ask\" with no batch approval. Undraft #701"'
check "DS-222 AC4 a verdict for an older head leaves the PR draft" '[ "$(readied 704)" = 0 ] && field U-4 undraft.why | grep -q "not the head bbbbbbbbb"'
check "DS-222 AC5 a conflicted PR stays draft and needs the person, the conflict its reason" \
  '[ "$(readied 705)" = 0 ] && echo "$out" | grep -q "U-5: DRAFT — PR #705 stays draft: it has a merge conflict with its base"'
q set-batch approved.undraft=true; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-222 AC2 pr-ready ask with the batch approval: the PR is marked ready" '[ "$(readied 701)" = 1 ] && echo "$out" | grep -q "undrafted: PR #701 (U-1)"'
check "DS-222 AC2 and one batch-notes line names the ticket, the PR, the head and the approval" \
  '[ "$(grep -c "^- \[U-1\] undrafted #701 at $HEAD_A: §3 pr-ready is ask, batch approval given at Stage 3$" "$T/state-ud/batch-notes.md")" = 1 ]'
check "DS-222 AC4 AC5 a stale verdict and a conflict still stay draft under the approval" '[ "$(readied 704)" = 0 ] && [ "$(readied 705)" = 0 ]'
check "DS-222 AC5 a head GitHub has not checked for conflicts yet stays draft and waits for a later pass" \
  '[ "$(readied 708)" = 0 ] && [ "$(field U-8 undraft.call)" = "\"wait\"" ] && echo "$out" | grep -q "PR #708 (U-8) stays draft for now: GitHub has not yet worked out whether it conflicts with its base (UNKNOWN)"'
check "DS-222 AC6 a feature spine's PR is never undrafted by this step" '[ "$(readied 706)" = 0 ] && [ "$(field U-6 undraft)" = null ] && ! echo "$out" | grep -q "#706 stays draft"'
check "DS-222 AC7 a failed gh pr ready leaves it draft and the pass record holds the error" \
  '[ "$(field U-7 undraft.call)" = "\"failed\"" ] && pass_rec undraft_errors | grep -q "U-7: gh pr ready 707 failed: GraphQL: Something went wrong"'
# #701 goes back to a fresh draft: its record goes too, or the pass reads it as put back by a person.
rm -f "$T/u/707.fail" "$T/u/701.ready"; q set U-1 undraft=null; q set-batch approved.undraft=false
uconfig yes; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-222 AC7 the next pass tries again, and the error is gone from the record" '[ "$(readied 707)" = 1 ] && [ "$(pass_rec undraft_errors)" = "[]" ]'
check "DS-222 AC1 pr-ready yes: a clean, green draft at its head is marked ready, with no batch-notes line" \
  '[ "$(readied 701)" = 1 ] && [ "$(grep -c "undrafted #701" "$T/state-ud/batch-notes.md")" = 1 ]'
check "DS-278 AC1 the undrafted PR gets one comment: why it left draft, on its head" \
  '[ "$(grep -c "^pr comment 701 --repo acme/widgets --body Out of draft: the desk-review verdict posted on this head (.aaaaaaaaaaaa.) is clean" "$T/gh-calls")" = 1 ]'
check "DS-278 AC1 and the comment quotes the verdict" 'grep -q "^> .sha=$HEAD_A p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1.$" "$T/gh-calls"'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-222 a PR already ready is not undrafted again" '[ "$(grep -c "^pr ready" "$T/gh-calls")" = 0 ]'
check "DS-278 AC1 nor commented on again" '[ "$(grep -c "^pr comment" "$T/gh-calls")" = 0 ]'

# ---- DS-314: a PR a person put back to draft is theirs to hold
# The person runs gh pr ready 701 --undo on the PR the pass undrafted above.
rm -f "$T/u/701.ready"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-314 AC1 a PR the pass undrafted and a person put back to draft is not marked ready" \
  '[ "$(readied 701)" = 0 ] && [ "$(field U-1 undraft.call)" = "\"held\"" ] && [ "$(field U-1 undraft.pr)" = 701 ]'
check "DS-314 AC2 and it is put to the person as held, undrafting it the way to release it" \
  'echo "$out" | grep -q "U-1: HELD — PR #701 stays draft: it was put back to draft after the pass undrafted it. Undraft #701 to release it; the merge driver then merges it once it is green (gh pr ready 701 --repo acme/widgets)"'
check "DS-314 the pass's own undraft settles it with no read of the PR's events" '! grep -q "^api .*/issues/701/events" "$T/gh-calls"'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-314 AC1 a later pass leaves it draft too" '[ "$(readied 701)" = 0 ] && [ "$(field U-1 undraft.call)" = "\"held\"" ]'
# The person undrafts it.
touch "$T/u/701.ready"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-314 AC3 the person's undraft releases the hold, and the pass leaves the PR to the driver" \
  '[ "$(field U-1 undraft.call)" = "\"ready\"" ] && echo "$out" | grep -q "released: PR #701 (U-1) was undrafted by a person" && [ "$(grep -c "^pr ready" "$T/gh-calls")" = 0 ]'
rm -f "$T/u/701.ready"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-314 AC1 put back to draft again, it is held again" '[ "$(field U-1 undraft.call)" = "\"held\"" ]'
# Drafts the pass never undrafted: #709 a person put back to draft (it was opened ready), #710 never
# left draft, and #711's events cannot be read.
for k in 9 10 11; do q add "U-$k"; done
q set U-9 state=done result.pr=709; q set U-10 state=done result.pr=710; q set U-11 state=done result.pr=711
printf '2026-10-28T06:32:27Z\tben\n' > "$T/u/709.events"; touch "$T/u/711.events-fail"
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-314 AC1 a draft whose events hold a convert_to_draft is held, naming who and when" \
  '[ "$(readied 709)" = 0 ] && [ "$(field U-9 undraft.call)" = "\"held\"" ] && echo "$out" | grep -q "U-9: HELD — PR #709 stays draft: it was put back to draft by ben at 2026-10-28T06:32:27Z"'
check "DS-314 AC4 a worker's draft nobody put back is undrafted as before" '[ "$(readied 710)" = 1 ] && [ "$(field U-10 undraft.call)" = "\"ready\"" ]'
check "DS-314 a draft whose events cannot be read stays draft until a later pass reads them" \
  '[ "$(readied 711)" = 0 ] && echo "$out" | grep -q "PR #711 (U-11) stays draft for now: its events, which say whether a person put it back to draft, could not be read (HTTP 502: Bad Gateway)"'

# ---- DS-278: a ready PR red after the driver's reruns, or in conflict, goes back to a fix worker twice
# The fake gh answers each PR from $T/fx/<n>.json. The driver's rerun record is written as the driver
# writes it: one line per check per rerun, in <state>/merge-driver/reruns-<n>-<head>.
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/gh-calls', a.join(' ') + '\n');
if (a[0] === 'pr' && a[1] === 'view') { try { process.stdout.write(fs.readFileSync('$T/fx/' + a[2] + '.json', 'utf8')); } catch { process.exit(1); } }
else if (a[0] === 'pr' && a[1] === 'list') console.log('[]');
else process.exit(1);
EOF
chmod +x "$T/stub/gh"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1 \${AUTOPILOT_TASK:-}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF
cat > "$T/config-f.md" <<EOF
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
| \`pr-conflict-unreviewed\` | Resolve a merge conflict on your PR before any human has reviewed it | \`yes\` | \`yes\` |

## 1. Identity
| Field | Value |
|---|---|
| GitHub handle | \`me\` |

## 4. Checks
| Field | Value |
|---|---|
| Required checks | \`tests\` |
| Checks workers can't fix | \`Flows image missing: build it: ensure-flows-image.sh\` |
EOF
export DESK_CONFIG="$T/config-f.md" DESK_QUEUE="$T/queue-f.json" DESK_AUTOPILOT_STATE="$T/state-f"
mkdir -p "$T/state-f/logs" "$T/state-f/merge-driver" "$T/fx"
# fx <n> <head> <mergeable> <check>:<conclusion>[:<run id>]...: PR #n open and out of draft.
fx(){
  node -e 'const [dir, n, head, mergeable, ...cs] = process.argv.slice(1);
    const checks = cs.map((c) => { const [name, conclusion, run] = c.split(":"); return { __typename: "CheckRun", name, status: "COMPLETED", conclusion, detailsUrl: run ? `https://github.com/acme/widgets/actions/runs/${run}/job/1` : "" }; });
    require("fs").writeFileSync(`${dir}/${n}.json`, JSON.stringify({ state: "OPEN", url: `https://github.com/acme/widgets/pull/${n}`, isDraft: false, mergeable, mergeStateStatus: mergeable === "CONFLICTING" ? "DIRTY" : "BLOCKED", headRefOid: head, statusCheckRollup: checks }))' "$T/fx" "$@"
}
reran(){ printf '%s\n' "${@:3}" "${@:3}" > "$T/state-f/merge-driver/reruns-$1-$2"; }   # reran <n> <head> <check>...: two reruns each
H1=1111111111111111111111111111111111111111; H2=2222222222222222222222222222222222222222; H3=3333333333333333333333333333333333333333
q init f; q set-batch concurrency=5
for k in 1 2 3 4 5 6 7; do q add "F-$k"; q set "F-$k" state=done lane=A "branch=fix/F-$k"; done
# F-6 and F-7 conflict too. A person has commented on F-6, under §3 pr-conflict-reviewed (unset, so
# no); only the user's own handle and a bot have on F-7, so pr-conflict-unreviewed (yes) is read.
q set F-6 result.pr=705; fx 705 "$H1" CONFLICTING tests:SUCCESS
q set F-7 result.pr=706; fx 706 "$H1" CONFLICTING tests:SUCCESS
withComments(){ node -e 'const [f, ...logins] = process.argv.slice(1); const v = JSON.parse(require("fs").readFileSync(f, "utf8")); v.comments = logins.map((login) => ({ author: { login }, body: "x" })); require("fs").writeFileSync(f, JSON.stringify(v))' "$@"; }
withComments "$T/fx/705.json" reviewer; withComments "$T/fx/706.json" Me "vercel[bot]"
q set F-1 result.pr=697; fx 697 "$H1" MERGEABLE tests:SUCCESS "Backend tests:FAILURE:901" Lint:FAILURE:902; reran 697 "$H1" "Backend tests" Lint
q set F-2 result.pr=704; fx 704 "$H1" CONFLICTING tests:SUCCESS
q set F-3 result.pr=696; fx 696 "$H1" MERGEABLE tests:SUCCESS "Flows image missing:FAILURE:903"
q set F-4 result.pr=698; fx 698 "$H1" MERGEABLE tests:SUCCESS "Flows image missing:FAILURE:903" Lint:FAILURE:904; reran 698 "$H1" "Flows image missing" Lint
q set F-5 result.pr=699; fx 699 "$H1" MERGEABLE tests:SUCCESS Lint:FAILURE:905; printf 'Lint\n' > "$T/state-f/merge-driver/reruns-699-$H1"
: > "$T/spawns"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-278 AC2 red after the driver's two reruns: requeued once for a fix worker, try 1" \
  '[ "$(field F-1 state)" = "\"triaged\"" ] && [ "$(field F-1 fix.try)" = 1 ] && [ "$(field F-1 fix_tries | jq length)" = 1 ] && echo "$out" | grep -q "fix try 1 of 2: F-1 requeued for PR #697 — red: Backend tests, Lint"'
check "DS-278 AC2 a check with one rerun so far is left to the driver" '[ "$(field F-5 state)" = "\"done\"" ] && [ "$(field F-5 fix)" = null ]'
check "DS-278 AC3 a DIRTY PR is requeued once for the conflict" '[ "$(field F-2 state)" = "\"triaged\"" ] && [ "$(field F-2 fix.kind)" = "\"conflict\"" ] && [ "$(field F-2 fix.what)" = "\"conflicts with main\"" ]'
check "DS-278 AC6 red only on a check no worker can fix: never requeued, stuck with its command" \
  '[ "$(field F-3 state)" = "\"done\"" ] && [ "$(field F-3 fix)" = null ] && [ "$(field F-3 stuck.why)" = "\"Flows image missing · build it: ensure-flows-image.sh\"" ]'
check "DS-278 AC6 and it is put to the person" 'echo "$out" | grep -q "F-3: STUCK — PR #696: Flows image missing · build it: ensure-flows-image.sh"'
check "DS-278 AC7 red on both: requeued for the fixable check only" '[ "$(field F-4 state)" = "\"triaged\"" ] && [ "$(field F-4 fix.what)" = "\"red: Lint\"" ] && [ "$(field F-4 fix.not_mine | jq -r ".[0].name")" = "Flows image missing" ]'
check "DS-320 AC5 a conflict a person commented on reads pr-conflict-reviewed: not requeued, put to the person" \
  '[ "$(field F-6 state)" = "\"done\"" ] && [ "$(field F-6 fix)" = null ] && echo "$out" | grep -q "F-6: CONFLICT — PR #705 is out of draft and conflicts with main, and config §3 pr-conflict-reviewed is \"no\", so no fix worker resolves it"'
check "DS-320 AC5 the user's own handle and a bot do not count as reviewed: pr-conflict-unreviewed requeues it" \
  '[ "$(field F-7 state)" = "\"triaged\"" ] && [ "$(field F-7 fix.kind)" = "\"conflict\"" ]'
# F-7 is done with: settled and green, so it takes none of the worker slots the checks below count.
q set F-7 state=done fix=null fix_tries=null; fx 706 "$H1" MERGEABLE tests:SUCCESS

# The next pass spawns the fix workers, each given the fix as its task and in its briefing.
out=$(node "$B/pass.mjs" 2>&1)
check "DS-278 AC2 the fix worker's task is the fix try on the same PR" 'grep -q "^F-1 .*Your task is fix try 1 of 2 on PR #697" "$T/spawns"'
check "DS-278 AC2 its briefing names each failing check and its run URL" \
  'grep -q "^- Backend tests: https://github.com/acme/widgets/actions/runs/901$" "$T/state-f/briefings/F-1.md" && grep -q "^- Lint: https://github.com/acme/widgets/actions/runs/902$" "$T/state-f/briefings/F-1.md"'
check "DS-278 AC3 the conflict worker's briefing says it conflicts with the base" 'grep -q "it conflicts with main" "$T/state-f/briefings/F-2.md"'
check "DS-278 AC7 the briefing says the other check is not the worker's to fix" 'grep -q "^- Flows image missing is red too, and it is not yours to fix: build it: ensure-flows-image.sh" "$T/state-f/briefings/F-4.md"'
check "DS-278 AC4 a running fix worker's PR is not requeued again" '[ "$(field F-1 fix_tries | jq length)" = 1 ] && [ "$(grep -c "^F-1 " "$T/spawns")" = 1 ]'

# F-1's worker pushes a new head that is still red after its reruns: try 2. F-2's left its head where it was.
q set F-1 state=done session_id=null result.pr=697; fx 697 "$H2" MERGEABLE tests:SUCCESS Lint:FAILURE:906; reran 697 "$H2" Lint
q set F-2 state=done session_id=null result.pr=704
out=$(node "$B/pass.mjs" 2>&1)
check "DS-278 AC2 a new head still red after its reruns gets try 2" '[ "$(field F-1 fix.try)" = 2 ] && [ "$(field F-1 fix_tries | jq length)" = 2 ] && [ "$(field F-1 fix_tries | jq -r ".[1].head")" = "$H2" ]'
check "DS-278 AC4 a try already made for this head is not made again: stuck" \
  '[ "$(field F-2 state)" = "\"done\"" ] && [ "$(field F-2 fix_tries | jq length)" = 1 ] && [ "$(field F-2 stuck.why)" = "\"still in conflict with main after 1 fix try\"" ]'
q set F-1 state=done session_id=null result.pr=697; fx 697 "$H3" MERGEABLE tests:SUCCESS Lint:FAILURE:907; reran 697 "$H3" Lint
out=$(node "$B/pass.mjs" 2>&1)
check "DS-278 AC5 after 2 fix tries it is not requeued again" '[ "$(field F-1 state)" = "\"done\"" ] && [ "$(field F-1 fix_tries | jq length)" = 2 ]'
check "DS-278 AC5 the ticket records it stuck, and it is put to the person" \
  '[ "$(field F-1 stuck.why)" = "\"still red after 2 fix tries: Lint\"" ] && echo "$out" | grep -q "F-1: STUCK — PR #697: still red after 2 fix tries: Lint"'

# ---- DS-280: the pass records the driver's reruns and its last, when the PR last changed, and when each
# row entered its group. F-5's PR is red on Lint after one rerun; nothing merges here, so it needs you.
printf '1761650000\n' > "$T/state-f/merge-driver/cooldown-699"
F5_CHANGED=$(field F-5 pr_status.changed_at); F5_GROUP=$(field F-5 group)
out=$(node "$B/pass.mjs" 2>&1)
check "DS-280 AC1 the reruns the driver tried at this head, per check, and when it last reran one" \
  '[ "$(field F-5 pr_status | jq -c "[.reruns, .rerun_at]")" = "[{\"Lint\":1},\"2025-10-28T11:13:20.000Z\"]" ]'
check "DS-280 AC4 and AC5 each row's group is recorded with the pass that found it there" '[ "$(field F-5 group.g)" = "\"needs\"" ] && [ "$(field F-1 group.g)" = "\"needs\"" ]'
check "DS-280 AC7 with its head and checks unchanged, the last change and the group's start are kept" \
  '[ "$F5_CHANGED" != null ] && [ "$(field F-5 pr_status.changed_at)" = "$F5_CHANGED" ] && [ "$(field F-5 group)" = "$F5_GROUP" ]'
fx 699 "$H1" MERGEABLE tests:SUCCESS Lint:SUCCESS
out=$(node "$B/pass.mjs" 2>&1)
check "DS-280 AC7 a check result that changed moves the last change, and the group's start stays" \
  '[ "$(field F-5 pr_status.changed_at)" != "$F5_CHANGED" ] && [ "$(field F-5 pr_status.changed_at)" = "$(field F-5 pr_status.at)" ] && [ "$(field F-5 group)" = "$F5_GROUP" ]'
# Ahead of pace: new tickets hold, and a fix try still starts within the worker count.
export DESK_QUEUE="$T/queue-p.json" DESK_AUTOPILOT_STATE="$T/state-p"
mkdir -p "$T/state-p/logs"
node -e 'console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 }, seven_day: { utilization: 0.99, resetsAt: Math.round(Date.now() / 1000) + 6 * 86400 } } } }))' > "$T/state-p/logs/OLD-1.log"
q init p; q set-batch concurrency=2
q add P-1; q set P-1 state=triaged lane=A branch=fix/P-1 'fix={"try":1,"of":2,"pr":800,"head":"x","kind":"checks","what":"red: Lint","checks":[{"name":"Lint","url":null}]}'
q add P-2; q set P-2 state=triaged lane=A branch=fix/P-2
q add P-3; q set P-3 state=triaged lane=A branch=fix/P-3 'fix={"try":1,"of":2,"pr":801,"head":"x","kind":"conflict","what":"conflicts with main","base":"main"}'
: > "$T/spawns"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-278 ahead of pace, a fix try still starts" '[ "$(field P-1 state)" = "\"running\"" ] && grep -q "^P-1 .*fix try 1 of 2 on PR #800" "$T/spawns" && echo "$out" | grep -q "holding spawns (0 running carry on; fix tries still start)"'
check "DS-278 ahead of pace, a new ticket still holds" '[ "$(field P-2 state)" = "\"triaged\"" ] && ! grep -q "^P-2" "$T/spawns"'
check "DS-278 ahead of pace, fix tries keep to the worker count" '[ "$(grep -c "" "$T/spawns")" = 2 ]'
q set-batch concurrency=1; q set P-3 state=triaged; q set P-1 state=running session_id=live-1
: > "$T/spawns"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-278 ahead of pace, a fix try waits for a free worker slot" '[ ! -s "$T/spawns" ] && [ "$(field P-3 state)" = "\"triaged\"" ]'
sed 's/| `yes` | `yes` |$/| `yes` | `ask` |/' "$T/config-f.md" > "$T/config-pa.md"
q set-batch concurrency=2; q set P-1 state=triaged session_id=null
: > "$T/spawns"; out=$(DESK_CONFIG="$T/config-pa.md" env -u AUTOPILOT_USER_APPROVED node "$B/pass.mjs" 2>&1)
check "DS-278 ahead of pace, a fix try still waits for workers to be allowed" '[ ! -s "$T/spawns" ] && [ "$(field P-1 state)" = "\"triaged\"" ] && echo "$out" | grep -q "autopilot-workers is \"ask\""'
export DESK_QUEUE="$T/queue-f.json" DESK_AUTOPILOT_STATE="$T/state-f"
check "DS-278 AC8 the ticket keeps its last try and what it fixed, with the try finished" '[ "$(field F-1 fix | jq -c "[.try, .of, .what, (.finished != null)]")" = "[2,2,\"red: Lint\",true]" ]'

# ---- a draft whose review at its head found a P0 or P1 goes back to a fix worker twice
# The fake gh answers each PR from $T/fr/<n>.json, a green draft with one review by ben, and records
# pr ready and pr comment. frx <n> <head> <reviewed sha> <counts> [inline]: a P1 count lists one P1
# finding in the body, or none with inline. The review's inline comments (gh api graphql, by its id
# PRR_<n>) are $T/fr/<n>.comments, a JSON list, or the error gh prints when it holds ERROR.
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/gh-calls', a.join(' ') + '\n');
const f = '$T/fr/' + a[2] + '.json';
if (a[0] === 'api' && a[1] === 'graphql') {
  const id = a.find((x) => x.startsWith('id=PRR_'));
  let c = '[]';
  try { c = fs.readFileSync('$T/fr/' + (id ? id.slice(7) : 'none') + '.comments', 'utf8'); } catch {}
  if (c.startsWith('ERROR')) { process.stderr.write(c); process.exit(1); }
  // As gh does, the whole response unless --jq picks the list out of it.
  const jq = a[a.indexOf('--jq') + 1];
  process.stdout.write(a.includes('--jq') && jq === '.data.node.comments.nodes' ? c : JSON.stringify({ data: { node: { comments: { nodes: JSON.parse(c) } } } }));
}
else if (a[0] === 'pr' && a[1] === 'view') { try { process.stdout.write(fs.readFileSync(f, 'utf8')); } catch { process.exit(1); } }
else if (a[0] === 'pr' && a[1] === 'ready') fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), isDraft: false }));
else if (a[0] === 'pr' && a[1] === 'comment') { /* recorded in gh-calls */ }
else if (a[0] === 'pr' && a[1] === 'list') console.log('[]');
else if (a[0] === 'api' && /\/issues\/\d+\/events/.test(a[2])) { try { process.stdout.write(fs.readFileSync('$T/fr/' + a[2].match(/issues\/(\d+)\//)[1] + '.events', 'utf8')); } catch { /* not put back to draft */ } }
else process.exit(1);
EOF
chmod +x "$T/stub/gh"
mkdir -p "$T/fr" "$T/state-r/logs"
frx(){
  node -e 'const [dir, n, head, sha, counts, inline] = process.argv.slice(1);
    const p1 = /p1=[1-9]/.test(counts) && !inline ?["", "P1 (1)", " src/money.ts:12         second currency formatter", "", "P2 (1)", " src/pager.ts:1   no consumer"] : [];
    const body = ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${sha} ${counts} deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->`, "**desk-review, round 1**", ...p1].join("\n");
    require("fs").writeFileSync(`${dir}/${n}.json`, JSON.stringify({ state: "OPEN", url: `https://github.com/acme/widgets/pull/${n}`, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", headRefOid: head, body: "## Summary",
      reviews: [{ id: `PRR_${n}`, author: { login: "ben" }, body }], statusCheckRollup: [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }] }))' "$T/fr" "$@"
}
H0=0000000000000000000000000000000000000000
cat > "$T/config-r.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 1. Identity
| Field | Value |
|---|---|
| GitHub handle | \`ben\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`pr-ready\` | Undraft PRs | \`yes\` | \`yes\` |

## 4. Checks
| Field | Value |
|---|---|
| Required checks | \`tests\` |
| Local review command | \`/desk-review\` |
| Clean review verdict | \`p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0\` |
EOF
export DESK_CONFIG="$T/config-r.md" DESK_QUEUE="$T/queue-r.json" DESK_AUTOPILOT_STATE="$T/state-r"
q init r; q set-batch concurrency=5
for k in 1 2 3 4 5 6; do q add "R-$k"; q set "R-$k" state=done lane=A "branch=fix/R-$k" "result.pr=72$k"; done
frx 721 "$H1" "$H1" 'p0=0 p1=1 p2=1'
frx 722 "$H1" "$H1" 'p0=0 p1=0 p2=1'
q set R-3 'fix_tries=[{"try":1,"head":"'"$H0"'","kind":"checks","what":"red: Lint"}]'; frx 723 "$H1" "$H1" 'p0=0 p1=1 p2=1'
q set R-4 'fix_tries=[{"try":1,"head":"'"$H0"'","kind":"review"},{"try":2,"head":"'"$H1"'","kind":"review"}]'; frx 724 "$H2" "$H2" 'p0=0 p1=1 p2=1'
q set R-5 'fix_tries=[{"try":1,"head":"'"$H1"'","kind":"review"}]'; frx 725 "$H1" "$H1" 'p0=0 p1=1 p2=1'
frx 726 "$H1" "$H1" 'p0=1 p1=0 p2=0'
: > "$T/spawns"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-281 AC1 a draft whose review at its head has 1 P1 is requeued once for a fix worker" \
  '[ "$(field R-1 state)" = "\"triaged\"" ] && [ "$(field R-1 fix.kind)" = "\"review\"" ] && [ "$(field R-1 fix.try)" = 1 ] && [ "$(field R-1 fix_tries | jq length)" = 1 ] && echo "$out" | grep -q "fix try 1 of 2: R-1 requeued for PR #721 — review not clean: 1 P1"'
check "DS-281 AC1 and it is not undrafted" '! grep -q "^pr ready 721" "$T/gh-calls"'
check "DS-281 AC6 a review with only P2s is not requeued and stays draft for the person, as today" \
  '[ "$(field R-2 state)" = "\"done\"" ] && [ "$(field R-2 fix)" = null ] && [ "$(field R-2 undraft.call)" = "\"person\"" ] && echo "$out" | grep -q "R-2: DRAFT — PR #722 stays draft: its review verdict at 111111111 is not clean (p2=1)"'
check "DS-384 AC1 a checks try leaves a review fix its own tries: the review try is try 1 of 2" '[ "$(field R-3 fix.try)" = 1 ] && [ "$(field R-3 fix_tries | jq -r ".[1].kind")" = review ]'
check "DS-281 AC5 after 2 review fix tries it is not requeued again, and is recorded stuck, naming the finding (DS-335 AC2)" \
  '[ "$(field R-4 state)" = "\"done\"" ] && [ "$(field R-4 fix_tries | jq length)" = 2 ] && [ "$(field R-4 stuck.why | jq -r .)" = "review not clean after 2 fix tries (2 review): 1 P1 — P1: src/money.ts:12         second currency formatter" ]'
check "DS-281 AC5 and it is put to the person" 'echo "$out" | grep -qF "R-4: STUCK — PR #724: review not clean after 2 fix tries (2 review): 1 P1 — P1: src/money.ts:12"'
check "DS-281 AC4 a try already made for this head is not made again" \
  '[ "$(field R-5 state)" = "\"done\"" ] && [ "$(field R-5 fix_tries | jq length)" = 1 ] && [ "$(field R-5 stuck.why | jq -r .)" = "review not clean after 1 fix try (1 review): 1 P1 — P1: src/money.ts:12         second currency formatter" ]'
check "DS-281 AC1 a P0 its review body does not list with a file:line is not requeued, and stays draft for the person" \
  '[ "$(field R-6 state)" = "\"done\"" ] && [ "$(field R-6 fix)" = null ] && echo "$out" | grep -q "R-6: DRAFT — PR #726 stays draft: its review verdict at 111111111 is not clean (p0=1)"'

# The next pass spawns the fix worker, its briefing quoting the P1 and not the P2.
out=$(node "$B/pass.mjs" 2>&1)
check "DS-281 AC1 the fix worker's task is the review fix, reviewed again on the new head" \
  'grep -q "^R-1 .*Your task is fix try 1 of 2 on PR #721.*review the new head with desk-review and post that review on the PR" "$T/spawns"'
check "DS-281 AC1 its briefing quotes the P1 with its file and line" \
  'grep -q "^- P1: src/money.ts:12         second currency formatter$" "$T/state-r/briefings/R-1.md" && ! grep -q "pager.ts" "$T/state-r/briefings/R-1.md"'
check "DS-281 AC4 a PR whose fix worker is running is not requeued again" '[ "$(field R-1 fix_tries | jq length)" = 1 ] && [ "$(grep -c "^R-1 " "$T/spawns")" = 1 ]'

# R-1's worker pushed H2 and finished without reviewing it: no undraft, and no second fix try, but
# (DS-316) a review worker for the new head.
q set R-1 state=done session_id=null result.pr=721; frx 721 "$H2" "$H1" 'p0=0 p1=1 p2=1'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-281 AC2 a new head with no review of its own is not undrafted, and goes to a review worker, not a fix" \
  '! grep -q "^pr ready 721" "$T/gh-calls" && [ "$(field R-1 fix_tries | jq -c "[.[].kind]")" = "[\"review\",\"rereview\"]" ] && [ "$(field R-1 state)" = "\"triaged\"" ] && field R-1 undraft.why | grep -q "not the head 222222222"'
# Its review of H2 is clean: out of draft, with one comment quoting the verdict.
q set R-1 state=done session_id=null result.pr=721; frx 721 "$H2" "$H2" 'p0=0 p1=0 p2=0'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-281 AC3 a clean re-review on the new head undrafts it" '[ "$(grep -c "^pr ready 721 --repo acme/widgets" "$T/gh-calls")" = 1 ]'
check "DS-281 AC3 with one comment saying its review on that head was clean, quoting the verdict" \
  '[ "$(grep -c "^pr comment 721 --repo acme/widgets --body Out of draft: the desk-review verdict posted on this head (.222222222222.) is clean" "$T/gh-calls")" = 1 ] && grep -q "^> .sha=$H2 p0=0 p1=0 p2=0 deferred=0" "$T/gh-calls"'

# ---- DS-379: a clean, green draft whose body has `_drag <file>_` cells with no screenshot file goes to a
# capture worker, once; still missing after it, the person gets the screens and why. dragbody <n> <body>.
dragbody(){ node -e 'const fs = require("fs"); const [f, b] = process.argv.slice(1); const j = JSON.parse(fs.readFileSync(f, "utf8")); j.body = b; fs.writeFileSync(f, JSON.stringify(j));' "$T/fr/$1.json" "$2"; }
node -e 'const fs = require("fs"); const [a, b] = process.argv.slice(1); const row = "| `pr-ready` | Undraft PRs | `yes` | `yes` |";
  fs.writeFileSync(b, fs.readFileSync(a, "utf8").replace(row, `${row}\n| \`pr-images\` | Upload PR screenshots | \`yes\` | \`yes\` |`));' "$T/config-r.md" "$T/config-s.md"
export DESK_CONFIG="$T/config-s.md" DESK_QUEUE="$T/queue-s.json" DESK_AUTOPILOT_STATE="$T/state-s"
mkdir -p "$T/state-s/logs" "$T/state-s/images/S-3"; : > "$T/state-s/images/S-3/s-3-after.png"
q init s; q set-batch concurrency=5
for k in 1 2 3; do q add "S-$k"; q set "S-$k" state=done lane=A "branch=fix/S-$k" "result.pr=76$k" images_uploaded=none; frx "76$k" "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody "76$k" "Before | After
_drag s-$k-before.png_ | _drag s-$k-after.png_"; done
q set S-2 'fix_tries=[{"try":1,"head":"'"$H1"'","kind":"capture","what":"take 2 screenshot(s) never taken"}]' \
  'fix={"try":1,"of":1,"pr":762,"head":"'"$H1"'","kind":"capture","what":"take 2","files":["s-2-before.png","s-2-after.png"],"finished":"x"}' \
  'result.summary=pr=762 jira=Done said=s-2-before.png: the page needs a signed-in admin; s-2-after.png: same'
# S-3: its worker took both, but config §3 pr-images was not yes when it finished, so they wait for the person.
: > "$T/state-s/images/S-3/s-3-before.png"; q set S-3 images_uploaded=null images_reported=true
: > "$T/spawns"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-379 AC1 cells with no screenshot file send the draft to a capture worker, naming the files" \
  '[ "$(field S-1 state)" = "\"triaged\"" ] && [ "$(field S-1 fix | jq -c "[.kind, .pr, .files]")" = "[\"capture\",761,[\"s-1-before.png\",\"s-1-after.png\"]]" ] && echo "$out" | grep -qF "capture try: S-1 requeued for PR #761 — take 2 screenshot(s) never taken: s-1-before.png, s-1-after.png"'
check "DS-379 AC1 and nothing is put to the person, and it is not undrafted" \
  '! echo "$out" | grep -q "S-1: DRAFT" && [ "$(field S-1 stuck)" = null ] && ! grep -q "^pr ready 761" "$T/gh-calls"'
check "DS-379 AC1 the capture try is not one of the fix tries" '[ "$(field S-1 fix_tries | jq -c "[.[].kind]")" = "[\"capture\"]" ]'
check "DS-379 AC3 still missing after the capture try, it is the person's, naming each screen and why" \
  '[ "$(field S-2 state)" = "\"done\"" ] && [ "$(field S-2 stuck.why | jq -r .)" = "2 screenshot(s) still not taken after a capture try: s-2-before.png, s-2-after.png; the capture try said: s-2-before.png: the page needs a signed-in admin; s-2-after.png: same" ] && echo "$out" | grep -qF "S-2: STUCK — PR #762: 2 screenshot(s) still not taken"'
check "DS-379 AC4 screenshots taken but not approved for upload wait for the person, as before" \
  '[ "$(field S-3 state)" = "\"done\"" ] && [ "$(field S-3 fix)" = null ] && echo "$out" | grep -qF "S-3: DRAFT — PR #763 stays draft: its screenshots are not in the body yet (a \`_drag <file>_\` cell is left). Upload the screenshots to #763"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-379 AC1 the capture worker's task is to take them and print AUTOPILOT_IMAGES" \
  'grep -q "^S-1 .*Your task is the capture try on PR #761.*print AUTOPILOT_IMAGES" "$T/spawns" && grep -q "^- s-1-after.png$" "$T/state-s/briefings/S-1.md"'
# Its worker took both: the next pass uploads them into the body (the stub swaps the cells) and undrafts it.
mkdir -p "$T/state-s/images/S-1"; : > "$T/state-s/images/S-1/s-1-before.png"; : > "$T/state-s/images/S-1/s-1-after.png"
said1='[all taken] each at 1440 px wide, signed in as the seeded admin with the demo workspace selected, the onboarding banner dismissed and the side panel open, so the before and after frames line up row for row in the body'
say "AUTOPILOT_IMAGES: $T/state-s/images/S-1/" "AUTOPILOT_DONE: pr=761 jira=Done said=$said1" > "$T/state-s/logs/S-1.log"
q set S-1 state=running session_id=gone; dragbody 761 "Before | After
<img alt=\"s-1-before\" src=\"https://github.com/user-attachments/assets/1\"> | <img alt=\"s-1-after\" src=\"https://github.com/user-attachments/assets/2\">"
: > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-379 AC2 what the capture worker took is uploaded into the PR's body, and it leaves draft" \
  'grep -qx "761 $T/state-s/images/S-1/" "$T/uploads" && [ "$(field S-1 images_uploaded)" = true ] && grep -q "^pr ready 761" "$T/gh-calls"'
check "DS-379 AC3 what a capture worker said is kept whole, past the summary's 200 characters, even opening with a bracket" \
  '[ "$(field S-1 state)" = "\"done\"" ] && [ "$(field S-1 result.done.said | jq -r .)" = "$said1" ] &&[ "$(field S-1 result.summary | jq -r . | wc -c | tr -d " ")" -le 201 ]'

# ---- DS-316: a draft with no verdict readable at its head goes to a review worker, a red one to a fix
# worker, and a verdict carries across merges of the base alone. $T/carry is a real clone: C-1's
# reviewed commit CA has main merged in (CB); C-2 has a commit of its own after CA.
git init -q --bare -b main "$T/carry-origin.git"
git init -q -b main "$T/carry"; git -C "$T/carry" remote add origin "$T/carry-origin.git"
cmt(){ echo "$2" > "$T/carry/$1"; git -C "$T/carry" add -A; git -C "$T/carry" commit -q -m "$1"; git -C "$T/carry" rev-parse HEAD; }
cmt a.txt base >/dev/null
git -C "$T/carry" checkout -q -b fix/C-1; CA=$(cmt b.txt pr)
git -C "$T/carry" checkout -q main; cmt c.txt moved >/dev/null
git -C "$T/carry" checkout -q fix/C-1; git -C "$T/carry" merge -q --no-edit main; CB=$(git -C "$T/carry" rev-parse HEAD)
git -C "$T/carry" checkout -q -b fix/C-2 "$CA"; cmt d.txt own >/dev/null; git -C "$T/carry" merge -q --no-edit main; CC=$(git -C "$T/carry" rev-parse HEAD)
git -C "$T/carry" checkout -q main; git -C "$T/carry" push -q origin main fix/C-1 fix/C-2
# redcheck <n> <run id>: its tests check failed. plainrev <n>: its review has no desk-review verdict line.
redcheck(){ node -e 'const fs = require("fs"); const [f, id] = process.argv.slice(1); const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.statusCheckRollup = [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `https://github.com/acme/widgets/actions/runs/${id}/job/1` }]; fs.writeFileSync(f, JSON.stringify(j));' "$T/fr/$1.json" "$2"; }
plainrev(){ node -e 'const fs = require("fs"); const f = process.argv[1]; const j = JSON.parse(fs.readFileSync(f, "utf8")); j.reviews[0].body = "Verdict: p0=0 p1=0 gaps=0"; fs.writeFileSync(f, JSON.stringify(j));' "$T/fr/$1.json"; }
sed "s#$T/repo#$T/carry#" "$T/config-r.md" > "$T/config-c.md"
export DESK_CONFIG="$T/config-c.md" DESK_QUEUE="$T/queue-c.json" DESK_AUTOPILOT_STATE="$T/state-c"
mkdir -p "$T/state-c/logs"
q init c; q set-batch concurrency=6
for k in 1 2 3 4 5 6; do q add "C-$k"; q set "C-$k" state=done lane=A "branch=fix/C-$k" "result.pr=75$k"; done
frx 751 "$CB" "$CA" 'p0=0 p1=0 p2=0'
frx 752 "$CC" "$CA" 'p0=0 p1=0 p2=0'
frx 753 "$H1" "$H1" 'p0=0 p1=0 p2=0'; redcheck 753 953
q set C-4 'fix_tries=[{"try":1,"head":"'"$H1"'","kind":"checks","what":"red: tests"}]'; frx 754 "$H1" "$H1" 'p0=0 p1=0 p2=0'; redcheck 754 954
frx 755 "$H1" "$H1" 'p0=0 p1=0 p2=0'; plainrev 755
q set C-6 'fix_tries=[{"try":1,"head":"'"$H0"'","kind":"checks"},{"try":2,"head":"'"$H1"'","kind":"rereview"}]'; frx 756 "$H1" "$H1" 'p0=0 p1=0 p2=0'; plainrev 756
# DS-314: held drafts a review or fix worker would otherwise get. C-7 a person put back to draft (its
# events say so) with a red check; C-8 the pass undrafted before, now draft again with no verdict line.
for k in 7 8; do q add "C-$k"; q set "C-$k" state=done lane=A "branch=fix/C-$k" "result.pr=75$k"; done
frx 757 "$H1" "$H1" 'p0=0 p1=0 p2=0'; redcheck 757 957; printf '2026-10-29T09:00:00Z\tben\n' > "$T/fr/757.events"
q set C-8 'undraft={"call":"ready","why":null,"action":null,"sha":"'"$H0"'","pr":758}'; frx 758 "$H1" "$H1" 'p0=0 p1=0 p2=0'; plainrev 758
: > "$T/spawns"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-316 AC1 a verdict carried across a merge of the base undrafts the PR at the new head" \
  'grep -q "^pr ready 751 --repo acme/widgets" "$T/gh-calls" && [ "$(field C-1 state)" = "\"done\"" ] && [ "$(field C-1 fix_tries)" = null ]'
check "DS-316 AC1 and the pass record says it was carried from the reviewed commit" \
  '[ "$(field C-1 undraft.carried_from)" = "\"$CA\"" ] && echo "$out" | grep -qF "undrafted: PR #751 (C-1) at ${CB:0:12}; its review verdict is carried from ${CA:0:12}, as only clean merges of main came since"'
check "DS-316 AC1 its comment names the commit reviewed and the head it holds on" \
  'grep -qF "pr comment 751 --repo acme/widgets --body Out of draft: the desk-review verdict posted on \`${CA:0:12}\` is clean" "$T/gh-calls" && grep -qF "holds on this head (\`${CB:0:12}\`)" "$T/gh-calls"'
check "DS-316 AC2 a verdict its own commits moved past sends the head to a review worker" \
  '[ "$(field C-2 state)" = "\"triaged\"" ] && [ "$(field C-2 fix.kind)" = "\"rereview\"" ] && [ "$(field C-2 fix.head)" = "\"$CC\"" ] && ! grep -q "^pr ready 752" "$T/gh-calls" && echo "$out" | grep -qF "review try 1 of 2: C-2 requeued for PR #752 — review its head: its review verdict is for ${CA:0:9}"'
check "DS-316 AC2 and it is not put to the person" '! echo "$out" | grep -q "C-2: DRAFT"'
check "DS-316 AC4 a red required check sends the draft to a fix worker, with the check and its run" \
  '[ "$(field C-3 state)" = "\"triaged\"" ] && [ "$(field C-3 fix | jq -c "[.kind, .draft, .what, .checks[0].url]")" = "[\"checks\",true,\"red: tests\",\"https://github.com/acme/widgets/actions/runs/953\"]" ] && ! echo "$out" | grep -q "C-3: DRAFT"'
check "DS-316 AC5 still red at a head a fix try was made for: stuck, with why" \
  '[ "$(field C-4 state)" = "\"done\"" ] && [ "$(field C-4 stuck.why)" = "\"still red after 1 fix try: tests\"" ] && echo "$out" | grep -q "C-4: STUCK — PR #754: still red after 1 fix try: tests"'
check "DS-316 AC3 a review with no desk-review verdict line sends the head to a review worker" \
  '[ "$(field C-5 state)" = "\"triaged\"" ] && [ "$(field C-5 fix.what)" = "\"review its head: no desk-review verdict is posted on it\"" ]'
check "DS-314 a red draft a person put back to draft is held, not sent to a fix worker" \
  '[ "$(field C-7 state)" = "\"done\"" ] && [ "$(field C-7 fix)" = null ] && [ "$(field C-7 undraft.call)" = "\"held\"" ] && echo "$out" | grep -q "C-7: HELD — PR #757 stays draft: it was put back to draft by ben at 2026-10-29T09:00:00Z"'
check "DS-314 a draft the pass undrafted before, with no verdict at its head, is held, not sent to a review worker" \
  '[ "$(field C-8 state)" = "\"done\"" ] && [ "$(field C-8 fix)" = null ] && [ "$(field C-8 undraft.call)" = "\"held\"" ] && ! grep -q "^pr ready 758" "$T/gh-calls"'
check "DS-316 AC5 with its tries spent it reaches the person, with what the pass read last" \
  '[ "$(field C-6 state)" = "\"done\"" ] && [ "$(field C-6 stuck.why)" = "\"no review verdict readable at its head after 2 fix tries: no desk-review verdict is posted on it\"" ] && echo "$out" | grep -q "C-6: STUCK — PR #756: no review verdict readable"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-316 AC2 the review worker's task is to review the head and post it, changing no code" \
  'grep -q "^C-2 .*Your task is review try 1 of 2 on PR #752.*Review its head with desk-review and post that review on the PR (desk-review Phase 7), and change no code" "$T/spawns"'
check "DS-316 AC4 the fix worker's briefing names the failing check, its run and how to read its log" \
  'grep -q "^- tests: https://github.com/acme/widgets/actions/runs/953$" "$T/state-c/briefings/C-3.md" && grep -q "gh run view <run id> --log-failed" "$T/state-c/briefings/C-3.md"'

# ---- a review whose P0s and P1s are posted inline goes to a fix worker too
export DESK_QUEUE="$T/queue-ri.json" DESK_AUTOPILOT_STATE="$T/state-ri"
mkdir -p "$T/state-ri/logs"
q init ri; q set-batch concurrency=5
for k in 1 2 3 4; do q add "I-$k"; q set "I-$k" state=done lane=A "branch=fix/I-$k" "result.pr=73$k"; done
frx 731 "$H1" "$H1" 'p0=0 p1=1 p2=0' inline
echo '[{"path":"src/tax.ts","line":40,"body":"**P1** VAT applied twice"}]' > "$T/fr/731.comments"
frx 732 "$H1" "$H1" 'p0=0 p1=1 p2=1'
echo '[{"path":"src/money.ts","line":12,"body":"**P1** second currency formatter"}]' > "$T/fr/732.comments"
frx 733 "$H1" "$H1" 'p0=0 p1=1 p2=0' inline
echo 'ERROR: HTTP 502: Bad Gateway (https://api.github.com/graphql)' > "$T/fr/733.comments"
frx 734 "$H1" "$H1" 'p0=0 p1=0 p2=1' inline
echo '[{"path":"src/pager.ts","line":1,"body":"**P2** no consumer"}]' > "$T/fr/734.comments"
: > "$T/spawns"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-299 AC1 a draft whose review has 1 P1 posted inline and none in its body is requeued once for a fix worker" \
  '[ "$(field I-1 state)" = "\"triaged\"" ] && [ "$(field I-1 fix.kind)" = "\"review\"" ] && [ "$(field I-1 fix_tries | jq length)" = 1 ] && echo "$out" | grep -q "fix try 1 of 2: I-1 requeued for PR #731 — review not clean: 1 P1"'
check "DS-299 AC1 the inline comments are read by the review's id" 'grep -q "^api graphql .* id=PRR_731" "$T/gh-calls"'
check "DS-299 AC2 a finding in the body and inline is quoted once" \
  '[ "$(field I-2 fix.findings | jq length)" = 1 ] && [ "$(field I-2 fix.findings | jq -r ".[0].text")" = "src/money.ts:12         second currency formatter" ]'
check "DS-299 AC3 inline comments that cannot be read leave the PR for the person, as today" \
  '[ "$(field I-3 state)" = "\"done\"" ] && [ "$(field I-3 fix)" = null ] && echo "$out" | grep -q "I-3: DRAFT — PR #733 stays draft"'
check "DS-299 AC3 and the pass log names the PR and the error" \
  'echo "$out" | grep -q "undraft: PR #733 (I-3): its review.s inline comments could not be read (ERROR: HTTP 502: Bad Gateway"'
check "DS-299 AC4 inline comments holding only P2s are not requeued, as today" \
  '[ "$(field I-4 state)" = "\"done\"" ] && [ "$(field I-4 fix)" = null ] && ! grep -q "^api graphql .* id=PRR_734" "$T/gh-calls"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-299 AC1 the fix worker's briefing quotes the inline finding with its file and line" \
  'grep -q "^- P1: src/tax.ts:40 VAT applied twice$" "$T/state-ri/briefings/I-1.md"'

# ---- a draft in conflict with its base goes to a fix worker where §3 pr-conflict-* lets one resolve it
# frc <n> <head> [commenter]: a draft with a clean review by ben at H1, in conflict with its base, and
# one PR comment by <commenter> when one is named.
frc(){
  frx "$1" "$2" "$H1" 'p0=0 p1=0 p2=0'
  node -e 'const [f, who] = process.argv.slice(1); const fs = require("fs"); const v = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...v, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", comments: who ? [{ author: { login: who }, body: "Why not reuse the formatter?" }] : [] }))' "$T/fr/$1.json" "${3:-}"
}
conflictcfg(){ node -e 'const [f, u, r] = process.argv.slice(1); const fs = require("fs");
  fs.writeFileSync(f.replace(/r\.md$/, "c.md"), fs.readFileSync(f, "utf8").replace("| `pr-ready`", `| \`pr-conflict-unreviewed\` | Resolve an unreviewed conflict | \`yes\` | \`${u}\` |\n| \`pr-conflict-reviewed\` | Resolve a reviewed conflict | \`ask\` | \`${r}\` |\n| \`pr-ready\``))' "$T/config-r.md" "$1" "$2"; }
export DESK_CONFIG="$T/config-c.md" DESK_QUEUE="$T/queue-rc.json" DESK_AUTOPILOT_STATE="$T/state-rc"
mkdir -p "$T/state-rc/logs"
q init rc; q set-batch concurrency=5
for k in 1 2 3; do q add "C-$k"; q set "C-$k" state=done lane=A "branch=fix/C-$k" "result.pr=74$k"; done
frc 741 "$H1"; frc 742 "$H1" kim; frc 743 "$H1"
# DS-314: C-4's conflicted draft was put back to draft by a person, so no conflict worker gets it.
q add C-4; q set C-4 state=done lane=A branch=fix/C-4 result.pr=744; frc 744 "$H1"; printf '2026-10-29T10:00:00Z\tben\n' > "$T/fr/744.events"
q set C-3 'fix_tries=[{"try":1,"head":"'"$H0"'","kind":"conflict"},{"try":2,"head":"'"$H2"'","kind":"conflict"}]' \
  'fix={"try":2,"of":2,"pr":743,"head":"'"$H2"'","kind":"conflict","draft":true,"finished":"2026-10-29T12:00:00Z"}' 'result.summary=pr=743 jira=In Progress said=src/x.ts left unresolved'
conflictcfg ask yes
: > "$T/spawns"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-318 AC3 with pr-conflict-unreviewed not yes, a conflicted draft is the person's as now" \
  '[ "$(field C-1 state)" = "\"done\"" ] && [ "$(field C-1 fix)" = null ] && echo "$out" | grep -q "C-1: DRAFT — PR #741 stays draft: it has a merge conflict with its base. Resolve the conflict on #741"'
check "DS-318 AC2 a human comment with pr-conflict-reviewed yes starts a fix worker" \
  '[ "$(field C-2 state)" = "\"triaged\"" ] && [ "$(field C-2 fix.kind)" = "\"conflict\"" ]'
conflictcfg yes ask
q set C-2 state=done session_id=null result.pr=742 fix=null fix_tries=null
: > "$T/spawns"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-318 AC1 no human review and pr-conflict-unreviewed yes: requeued once for a conflict fix worker" \
  '[ "$(field C-1 state)" = "\"triaged\"" ] && [ "$(field C-1 fix.kind)" = "\"conflict\"" ] && [ "$(field C-1 fix.draft)" = true ] && [ "$(field C-1 fix_tries | jq length)" = 1 ] && echo "$out" | grep -q "fix try 1 of 2: C-1 requeued for PR #741 — draft conflicts with main"'
check "DS-318 AC1 and it is neither undrafted nor put to the person" '! grep -q "^pr ready 741" "$T/gh-calls" && ! echo "$out" | grep -q "C-1: DRAFT"'
check "DS-314 a conflicted draft a person put back to draft is held, not sent to a conflict fix worker" \
  '[ "$(field C-4 state)" = "\"done\"" ] && [ "$(field C-4 fix)" = null ] && [ "$(field C-4 undraft.call)" = "\"held\"" ] && echo "$out" | grep -q "C-4: HELD — PR #744 stays draft: it was put back to draft by ben at 2026-10-29T10:00:00Z"'
check "DS-318 AC2 a human comment with pr-conflict-reviewed ask is the person's as now" \
  '[ "$(field C-2 state)" = "\"done\"" ] && [ "$(field C-2 fix)" = null ] && echo "$out" | grep -q "C-2: DRAFT — PR #742 stays draft: it has a merge conflict with its base"'
check "DS-318 AC5 after 2 conflict tries it is recorded stuck and put to the person, with the reason the last try gave" \
  '[ "$(field C-3 state)" = "\"done\"" ] && [ "$(field C-3 stuck.why)" = "\"still in conflict with main after 2 fix tries; the last try said: pr=743 jira=In Progress said=src/x.ts left unresolved\"" ] && echo "$out" | grep -q "C-3: STUCK — PR #743: still in conflict with main after 2 fix tries; the last try said: pr=743"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-318 AC4 the fix worker merges the base, reviews its new head and posts that review" \
  'grep -q "^C-1 .*Your task is fix try 1 of 2 on PR #741.*merge origin/main into your branch.*review the new head with desk-review and post that review on the PR.*leave the PR in draft" "$T/spawns"'
check "DS-318 AC1 its briefing says the draft conflicts with main" 'grep -q "is a draft on this branch, and it conflicts with main" "$T/state-rc/briefings/C-1.md"'
# C-1's worker pushed H2, resolved; its old review at H1 is stale and never undrafts it.
q set C-1 state=done session_id=null result.pr=741; frx 741 "$H2" "$H1" 'p0=0 p1=0 p2=0'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-318 AC4 a resolved head reviewed only at the old head is not undrafted: its stale review goes to a review worker (DS-316)" \
  '! grep -q "^pr ready 741" "$T/gh-calls" && [ "$(field C-1 state)" = "\"triaged\"" ] && [ "$(field C-1 fix.kind)" = "\"rereview\"" ] && [ "$(field C-1 fix_tries | jq length)" = 2 ] && field C-1 undraft.why | grep -q "not the head 222222222" && echo "$out" | grep -q "review try 2 of 2: C-1 requeued for PR #741"'
check "DS-318 AC4 and it is not put to the person" '! echo "$out" | grep -q "C-1: DRAFT"'
# A person resolved C-3's conflict: it is no longer stuck on it.
frx 743 "$H1" "$H1" 'p0=0 p1=0 p2=0'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-318 AC5 a stuck conflict the person resolved is cleared" '[ "$(field C-3 stuck)" = null ]'

# ---- under §3 autopilot-judgement yes, a review with only requirement gaps goes to a fix worker too
# frg <pr> <head> <sha> <gaps> [none]: a draft whose review at <sha> counts <gaps> gaps and lists one,
# or none with `none`.
frg(){
  node -e 'const [dir, n, head, sha, gaps, none] = process.argv.slice(1);
    const listed = none ? ["None."] : ["- **AC2**, \"no slot is handed to both.\"", "  - This holds only while the borrow lock is held."];
    const body = ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${sha} p0=0 p1=0 p2=0 deferred=0 gaps=${gaps} unrefuted=0 partial=0 vendor=codex round=1 -->`, "**desk-review, round 1**", "", "### Findings", "None.", "", "### Requirement gaps", ...listed, "", "### Scope", "- No out-of-scope hunks."].join("\n");
    require("fs").writeFileSync(`${dir}/${n}.json`, JSON.stringify({ state: "OPEN", url: `https://github.com/acme/widgets/pull/${n}`, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", headRefOid: head, body: "## Summary",
      reviews: [{ id: `PRR_${n}`, author: { login: "ben" }, body }], statusCheckRollup: [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }] }))' "$T/fr" "$@"
}
node -e 'const fs = require("fs"); const [from, to] = process.argv.slice(1);
  fs.writeFileSync(to, fs.readFileSync(from, "utf8").replace(/(\| `pr-ready` .*\n)/, "$1| `autopilot-judgement` | Take calls outside the ask categories | `yes` | `yes` |\n"))' "$T/config-r.md" "$T/config-g.md"
GAP='**AC2**, "no slot is handed to both." This holds only while the borrow lock is held.'
export DESK_CONFIG="$T/config-g.md" DESK_QUEUE="$T/queue-rg.json" DESK_AUTOPILOT_STATE="$T/state-rg"
mkdir -p "$T/state-rg/logs"
q init rg; q set-batch concurrency=5
for k in 1 2 3; do q add "G-$k"; q set "G-$k" state=done lane=A "branch=fix/G-$k" "result.pr=74$k"; done
frg 741 "$H1" "$H1" 1
frg 742 "$H1" "$H1" 1 none
q set G-3 'fix_tries=[{"try":1,"head":"'"$H0"'","kind":"review"},{"try":2,"head":"'"$H1"'","kind":"review"}]'; frg 743 "$H2" "$H2" 1
: > "$T/spawns"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-319 AC1 a draft whose review at its head has only a gap is requeued once for a fix worker" \
  '[ "$(field G-1 state)" = "\"triaged\"" ] && [ "$(field G-1 fix.kind)" = "\"review\"" ] && [ "$(field G-1 fix_tries | jq length)" = 1 ] && echo "$out" | grep -q "fix try 1 of 2: G-1 requeued for PR #741 — review not clean: 1 gap"'
check "DS-319 AC1 the gap is quoted from the review" '[ "$(field G-1 fix.gaps | jq -r ".[0]")" = "$GAP" ]'
check "DS-319 AC1 and it is not put to the person, nor undrafted" '! echo "$out" | grep -q "G-1: DRAFT" && ! grep -q "^pr ready 741" "$T/gh-calls"'
check "DS-319 a review counting a gap it does not list stays draft for the person" \
  '[ "$(field G-2 state)" = "\"done\"" ] && [ "$(field G-2 fix)" = null ] && echo "$out" | grep -q "G-2: DRAFT — PR #742 stays draft: its review verdict at 111111111 is not clean (gaps=1). Settle the findings or gaps on #742"'
check "DS-319 AC5 after 2 fix tries it is recorded stuck, with the gap the last try's review gives" \
  '[ "$(field G-3 state)" = "\"done\"" ] && [ "$(field G-3 stuck.why | jq -r .)" = "review not clean after 2 fix tries (2 review): 1 gap — $GAP" ] && echo "$out" | grep -qF "G-3: STUCK — PR #743: review not clean after 2 fix tries (2 review): 1 gap — $GAP"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-319 AC2 the fix worker's task closes the gap and reviews the new head again" \
  'grep -q "^G-1 .*Your task is fix try 1 of 2 on PR #741.*close each requirement gap it quotes.*review the new head with desk-review and post that review on the PR" "$T/spawns"'
check "DS-319 AC1 its briefing quotes the gap" 'grep -qxF -- "- Gap: $GAP" "$T/state-rg/briefings/G-1.md"'
# Without autopilot-judgement yes the same review is the person's, as today.
export DESK_CONFIG="$T/config-r.md" DESK_QUEUE="$T/queue-rn.json" DESK_AUTOPILOT_STATE="$T/state-rn"
mkdir -p "$T/state-rn/logs"
q init rn; q set-batch concurrency=5
q add N-1; q set N-1 state=done lane=A branch=fix/N-1 result.pr=751; frg 751 "$H1" "$H1" 1
: > "$T/spawns"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-319 AC4 without autopilot-judgement yes, a gap-only review stays draft for the person" \
  '[ "$(field N-1 state)" = "\"done\"" ] && [ "$(field N-1 fix)" = null ] && [ "$(field N-1 undraft.call)" = "\"person\"" ] && echo "$out" | grep -q "N-1: DRAFT — PR #751 stays draft: its review verdict at 111111111 is not clean (gaps=1). Settle the findings or gaps on #751"'

# ---- DS-327: a draft red only on a check §4 Check builds names gets its build on the host, then a re-run
# The fake gh answers each PR from $T/fb/<n>.json, a clean-reviewed draft at its worktree's head, and
# records run rerun. fbx <n> <head> <check>:<conclusion>[:<run id>]... writes one. Each PR's worktree
# is a git repo of its own; the build scripts record where they ran and how often.
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/gh-calls', a.join(' ') + '\n');
if (a[0] === 'pr' && a[1] === 'view') { try { process.stdout.write(fs.readFileSync('$T/fb/' + a[2] + '.json', 'utf8')); } catch { process.exit(1); } }
else if (a[0] === 'run' && a[1] === 'rerun') { if (fs.existsSync('$T/fb/rerun.fail')) { console.error('run 9003 cannot be rerun'); process.exit(1); } }
else if (a[0] === 'pr' && a[1] === 'list') console.log('[]');
else if (a[0] === 'api' && /\/issues\/\d+\/events/.test(a[2])) { /* no PR was put back to draft */ }
else process.exit(1);
EOF
chmod +x "$T/stub/gh"
mkdir -p "$T/fb" "$T/state-b/logs"
fbx(){
  node -e 'const [dir, n, head, ...cs] = process.argv.slice(1);
    const body = ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${head} p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->`, "**desk-review, round 1: clean**"].join("\n");
    const checks = cs.map((c) => { const [name, conclusion, id] = c.split(":"); return { __typename: "CheckRun", name, status: conclusion === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: conclusion === "PENDING" ? "" : conclusion, ...(id ? { detailsUrl: `https://github.com/acme/widgets/actions/runs/${id}/job/1` } : {}) }; });
    require("fs").writeFileSync(`${dir}/${n}.json`, JSON.stringify({ state: "OPEN", url: `https://github.com/acme/widgets/pull/${n}`, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", headRefOid: head, body: "## Summary",
      reviews: [{ id: `PRR_${n}`, author: { login: "ben" }, body }], statusCheckRollup: checks }))' "$T/fb" "$@"
}
for k in 1 2 3; do git init -q -b "fix/V-$k" "$T/wt/V-$k"; git -C "$T/wt/V-$k" commit -q --allow-empty -m "V-$k"; done
HB1=$(git -C "$T/wt/V-1" rev-parse HEAD); HB2=$(git -C "$T/wt/V-2" rev-parse HEAD); HB3=$(git -C "$T/wt/V-3" rev-parse HEAD)
cat > "$T/build-ok.sh" <<EOF
printf '%s %s\n' "\$(pwd -P)" "\$(git rev-parse HEAD)" >> "$T/built"
echo "pushed flows-lambda:staging-tree-1"
EOF
cat > "$T/build-fail.sh" <<'EOF'
for i in 1 2 3 4 5 6 7; do echo "step $i"; done
echo "no Docker context" >&2; exit 3
EOF
cat > "$T/config-b.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 1. Identity
| Field | Value |
|---|---|
| GitHub handle | \`ben\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`pr-ready\` | Undraft PRs | \`yes\` | \`yes\` |
| \`ci-rerun\` | Re-run CI | \`yes\` | \`yes\` |

## 4. Checks
| Field | Value |
|---|---|
| Required checks | \`tests\` |
| Local review command | \`/desk-review\` |
| Clean review verdict | \`p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0\` |
| Check builds | \`Flows image: sh $T/build-ok.sh\` \`Lambda image: sh $T/build-fail.sh\` |
EOF
export DESK_CONFIG="$T/config-b.md" DESK_QUEUE="$T/queue-b.json" DESK_AUTOPILOT_STATE="$T/state-b"
q init b; q set-batch concurrency=5
for k in 1 2 3; do q add "V-$k"; q set "V-$k" state=done lane=A "branch=fix/V-$k" "worktree=$T/wt/V-$k" "result.pr=76$k"; done
fbx 761 "$HB1" tests:SUCCESS "Flows image:FAILURE:9001"
fbx 762 "$HB2" tests:FAILURE:9002 "Flows image:FAILURE:9002"
fbx 763 "$HB3" tests:SUCCESS "Lambda image:FAILURE:9003"
# Waits for PR n's build at head to write its exit code.
built(){ for _ in $(seq 1 100); do [ -f "$T/state-b/check-builds/$1-$2.code" ] && return 0; sleep 0.1; done; return 1; }
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1); built 761 "$HB1"; built 763 "$HB3"
check "DS-327 AC1 a draft red only on a named check gets its command, once, in its worktree at its head" \
  '[ "$(cat "$T/built")" = "$(cd "$T/wt/V-1" && pwd -P) $HB1" ] && echo "$out" | grep -q "undraft: PR #761 (V-1) stays draft: \"Flows image\" red at ${HB1:0:9}, which §4 Check builds clears"'
check "DS-327 AC1 while it runs, the PR is not put to the person" '[ "$(field V-1 undraft.call)" = "\"build\"" ] && ! echo "$out" | grep -q "V-1: DRAFT"'
check "DS-327 AC4 a red check the row does not name is handled as before: nothing is built, and a fix worker gets it (DS-316)" \
  '[ ! -e "$T/state-b/check-builds/762-$HB2.json" ] && [ "$(field V-2 state)" = "\"triaged\"" ] && echo "$out" | grep -q "fix try 1 of 2: V-2 requeued for PR #762"'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-327 AC1 once it succeeds, the check is re-run with --failed" '[ "$(grep -c "^run rerun 9001 --repo acme/widgets --failed$" "$T/gh-calls")" = 1 ]'
check "DS-327 AC1 and the PR is not put to the person" '[ "$(field V-1 undraft.call)" = "\"rebuilt\"" ] && ! echo "$out" | grep -q "V-1: DRAFT"'
check "DS-327 AC2 a failed command puts the PR to the person, with the command, its exit code and its last lines" \
  '[ "$(field V-3 undraft.call)" = "\"person\"" ] && echo "$out" | grep -q "V-3: DRAFT — PR #763 stays draft: its check build \`sh $T/build-fail.sh\` exited 3 at ${HB3:0:9}: step 4 / step 5 / step 6 / step 7 / no Docker context. Fix the build, run it at the head of #763, then re-run \"Lambda image\""'
check "DS-327 AC2 and nothing is re-run for it" '! grep -q "^run rerun 9003" "$T/gh-calls"'
fbx 761 "$HB1" tests:SUCCESS "Flows image:PENDING:9001"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-327 AC1 while the re-run runs, the PR waits" '[ "$(field V-1 undraft.call)" = "\"wait\"" ] && ! echo "$out" | grep -q "V-1: DRAFT"'
fbx 761 "$HB1" tests:SUCCESS "Flows image:FAILURE:9001"
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-327 AC3 still red after the build and its re-run: the command is not run again at that head" \
  '[ "$(wc -l < "$T/built" | tr -d " ")" = 1 ] && ! grep -q "^run rerun" "$T/gh-calls"'
check "DS-327 AC3 and the PR is put to the person, naming the check" \
  'echo "$out" | grep -q "V-1: DRAFT — PR #761 stays draft: \"Flows image\" is still red at ${HB1:0:9} after its check build \`sh $T/build-ok.sh\` ran and the check was re-run. Fix \"Flows image\" on #761"'

# ---- DS-271: no CI runner shares the memory ladder
# A waiting marker an older desk left behind holds nothing, and the pass writes none of its own.
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue-mt.json" DESK_AUTOPILOT_STATE="$T/state-mt"
mkdir -p "$T/state-mt/logs"; MT="$DESK_HOME/memory-turns"; mkdir -p "$MT"
q init mt; q set-batch concurrency=2
q add M-1; q set M-1 state=running branch=fix/M-1 session_id=live-1
q add M-2; q set M-2 state=triaged
printf '{"side":"ci","since":%s,"at":%s,"why":"12.0G available","pid":%s}\n' "$(( ($(date +%s) - 300) * 1000 ))" "$(( ($(date +%s) - 60) * 1000 ))" "$$" > "$MT/ci.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-271 AC3 an old CI waiting marker holds nothing: the worker spawns" '[ "$(field M-2 state)" = "\"running\"" ] && ! echo "$out" | grep -q "CI is waiting"'
check "DS-271 AC3 the memory line has no runner segment" 'echo "$out" | grep -qE "memory: vmmem=[0-9.]+G avail=[0-9.]+G$"'
q add M-3; q set M-3 state=triaged; q set-batch concurrency=3
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-271 AC3 held for memory, the pass writes no waiting marker" '[ "$(field M-3 state)" = "\"triaged\"" ] && [ "$(ls "$MT")" = ci.json ]'

# ---- DS-346: a queued branch with a convention placeholder left in, and no worktree yet, is
# rebuilt from the key and the triage summary before the worktree is set up. A kept worktree's is not.
export DESK_QUEUE="$T/queue-br.json" DESK_AUTOPILOT_STATE="$T/state-br"
mkdir -p "$T/state-br/logs" "$T/state-br/triage" "$T/wt/B-2"
q init br; q set-batch concurrency=3
q add B-1; q set B-1 state=triaged 'branch=fix/B-1-<slug>'
printf '{"ticket":"B-1","summary":"Triage keeps the <slug> placeholder in"}' > "$T/state-br/triage/B-1.json"
q add B-2; q set B-2 state=triaged 'branch=fix/B-2-<slug>'
q add B-3; q set B-3 state=triaged branch=fix/B-3-already-fine
out=$(node "$B/pass.mjs" 2>&1)
check "DS-346 AC3 the placeholder branch is rebuilt from key and summary, and the worker spawns on it" \
  '[ "$(field B-1 branch)" = "\"fix/B-1-triage-keeps-the-slug-placeholder-in\"" ] && [ "$(field B-1 state)" = "\"running\"" ] && echo "$out" | grep -qF "branch fix/B-1-<slug> was unusable"'
check "DS-346 AC3 a ticket whose worktree is kept keeps its branch" '[ "$(field B-2 branch)" = "\"fix/B-2-<slug>\"" ]'
check "DS-346 AC3 a usable branch is left as it is" '[ "$(field B-3 branch)" = "\"fix/B-3-already-fine\"" ]'

# ---- pass.mjs --batch X-1, with no queue or state exported, works X-1's queue, and the
# worktree setup and the worker it starts resolve X-1's queue and state too.
unset DESK_QUEUE DESK_AUTOPILOT_STATE DESK_BATCH
export DESK_REPO_OVERRIDE=acme/widgets
X1Q="$DESK_HOME/repos/acme__widgets/batches/X-1/queue.json"; X1S="$HOME/.desk-autopilot/acme__widgets/batches/X-1"
STQ="$DESK_HOME/repos/acme__widgets/queue.json"
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
node "$B/desk-env.mjs" paths | grep -E '^DESK_(QUEUE|STATE)=' > "$T/x1-setup"
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else node "$B/desk-env.mjs" paths | grep -E '^DESK_(QUEUE|STATE)=' > "$T/x1-spawn"; echo "[spawn] ticket=\$1"; fi
EOF
q --batch X-1 init x1; q --batch X-1 add X-9; q --batch X-1 set X-9 state=triaged
out=$(node "$B/pass.mjs" --batch X-1 2>&1)
x1field(){ DESK_QUEUE="$X1Q" field "$@"; }
want="DESK_STATE='$X1S'
DESK_QUEUE='$X1Q'"
check "DS-303 AC3 pass.mjs --batch X-1 spawns X-1's ticket" '[ "$(x1field X-9 state)" = "\"running\"" ] && [ ! -f "$STQ" ]'
check "DS-303 AC3 the worktree setup it starts acts on X-1" '[ "$(cat "$T/x1-setup" 2>/dev/null)" = "$want" ]'
check "DS-303 AC3 the worker it starts acts on X-1" '[ "$(cat "$T/x1-spawn" 2>/dev/null)" = "$want" ]'
check "DS-303 AC3 the pass keeps its own state in X-1's folder" '[ -d "$X1S/logs" ]'

# ---- DS-124: cloud workers
# A ticket plan-batch placed in the cloud starts as one `claude --cloud` session, run through script
# since the pass has no terminal, is done once GitHub shows its PR, and parks when the start fails.
# The stub claude answers --cloud with the recorded output (tests/fixtures/cloud/).
export DESK_QUEUE="$T/queue-cl.json" DESK_AUTOPILOT_STATE="$T/state-cl"
mkdir -p "$T/state-cl/logs" "$T/state-cl/tickets"
cat > "$T/stub/claude" <<EOF
#!/bin/sh
if [ "\$1" = --cloud ]; then
  printf '%s' "\$2" > "$T/cloud-prompt"
  [ -e "$T/cloud-fail" ] && { cat "$S/fixtures/cloud/print-refused.txt" >&2; exit 1; }
  cat "$S/fixtures/cloud/created.txt"; exit 0
fi
echo '[{"sessionId": "live-1"}]'
EOF
cat > "$T/stub/gh" <<EOF
#!/bin/sh
[ "\$1 \$2" = "pr list" ] && [ -e "$T/cloud-prs.json" ] && cat "$T/cloud-prs.json"
exit 0
EOF
chmod +x "$T/stub/claude" "$T/stub/gh"
cloud_ticket(){ q add "$1"; q set "$1" state=triaged lane=A "branch=feat/$1" location=cloud
  printf '# %s\n\nSource: the user, in this conversation\n\nMake the widget save. AC1: it saves.\n' "$1" > "$T/state-cl/tickets/$1.md"; }
q init cl; q set-batch concurrency=2
cloud_ticket CW-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC2 a cloud ticket starts as a cloud session, recorded running" '[ "$(field CW-1 state)" = "\"running\"" ] && [ "$(field CW-1 cloud.session)" = "\"session_01Vy49H7Z4T3CSgAhSxsuhqj\"" ]'
check "DS-124 AC2 its prompt carries the ticket's text and its branch" 'grep -q "AC1: it saves" "$T/cloud-prompt" && grep -q "feat/CW-1" "$T/cloud-prompt"'
check "DS-124 AC2 no worktree or local worker is made for it" '[ ! -e "$T/wt/CW-1" ] && [ "$(field CW-1 session_id)" = null ] && echo "$out" | grep -q "CW-1 in a cloud session: https://claude.ai/code/"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC2 with no PR yet it stays running, and the pass says so" '[ "$(field CW-1 state)" = "\"running\"" ] && echo "$out" | grep -q "CW-1: cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj.from=cli&m=0, no PR yet"'
# The session opens its PR 40 minutes after it started, on a branch of its own.
node -e 'const s = Date.parse(JSON.parse(process.argv[1])); console.log(JSON.stringify([{ number: 31, title: "feat(w): CW-1 save", url: "u", headRefName: "claude/cw-1-abc", createdAt: new Date(s + 2400e3).toISOString() }]))' "$(field CW-1 cloud.started)" > "$T/cloud-prs.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC2 its PR is its result, on the PR's own branch" '[ "$(field CW-1 state)" = "\"done\"" ] && [ "$(field CW-1 result.pr)" = 31 ] && [ "$(field CW-1 branch)" = "\"claude/cw-1-abc\"" ]'
check "DS-124 AC2 the pass gives its session URL and its wall time to the PR" 'echo "$out" | grep -q "CW-1: PR #31 from cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj.from=cli&m=0 in 40m 00s"'
all_done; out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC2 the batch report shows tokens and cost as not reported for cloud, never \$0" 'echo "$out" | grep -E "^  CW-1 " | grep -q "not reported for cloud" && ! echo "$out" | grep -E "^  CW-1 " | grep -q "\$0\.00" && echo "$out" | grep -q "cloud session: https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj"'
cloud_ticket CW-2; : > "$T/cloud-fail"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC4 a cloud worker that fails to start parks with the error" '[ "$(field CW-2 state)" = "\"parked\"" ] && field CW-2 park.question | grep -q "cloud worker did not start — Error: --cloud cannot be combined with --print."'
check "DS-124 AC4 and is not run locally" '[ ! -e "$T/wt/CW-2" ] && ! echo "$out" | grep -q "CW-2 port="'
# Requeued for a fix try on the PR its session opened: a new session would start over with no fix brief.
rm -f "$T/cloud-fail" "$T/cloud-prompt"; cloud_ticket CW-3
q set CW-3 result.pr=40 'fix={"try":1,"of":2,"pr":40,"what":"a P1 review finding"}' 'cloud={"session":"session_01Vy49H7Z4T3CSgAhSxsuhqj"}'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 a cloud ticket back for a fix try on its PR parks, naming the try" '[ "$(field CW-3 state)" = "\"parked\"" ] && field CW-3 park.question | grep -q "fix try 1 of 2 (a P1 review finding) on its PR #40"'
check "DS-124 and names the session to resume, never a local requeue" 'field CW-3 park.question | grep -q "claude --teleport session_01Vy49H7Z4T3CSgAhSxsuhqj" && ! field CW-3 park.question | grep -q "location=null"'
check "DS-124 and no new cloud session or local worker starts for it" '[ ! -e "$T/cloud-prompt" ] && [ ! -e "$T/wt/CW-3" ] && ! echo "$out" | grep -q "CW-3 port="'

# ---- A pass holds a ticket whose kept worktree is in use, and spawns it once that clears.
# W-1's worktree is another process's working directory. W-2 and W-3 are fix tries: W-2's worktree
# has an uncommitted change, W-3's branch a commit origin does not have. W-4 is a fix try with only an
# untracked file, which setup-worktree.sh can leave itself: it spawns.
export DESK_QUEUE="$T/queue-wb.json" DESK_AUTOPILOT_STATE="$T/state-wb"; mkdir -p "$T/state-wb/logs" "$T/wt/W-1/src"; : > "$T/wb-spawns"
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1" >> "$T/wb-spawns"; echo "[spawn] ticket=\$1"
EOF
git init -q --bare "$T/wb-origin.git"
for k in 2 3 4; do
  git clone -q "$T/wb-origin.git" "$T/wt/W-$k" 2>/dev/null; git -C "$T/wt/W-$k" checkout -q -b "fix/W-$k"
  echo a > "$T/wt/W-$k/a.txt"; git -C "$T/wt/W-$k" add a.txt; git -C "$T/wt/W-$k" commit -q -m a; git -C "$T/wt/W-$k" push -q origin "fix/W-$k" 2>/dev/null
done
echo b >> "$T/wt/W-2/a.txt"; git -C "$T/wt/W-3" commit -q --allow-empty -m "not pushed"; : > "$T/wt/W-4/settings.local.json.desk-disabled"
printf 'p4242\ncclaude\nfcwd\nn%s/wt/W-1/src\n' "$T" > "$T/lsof.out"
q init wb; q set-batch concurrency=4
q add W-1; q set W-1 state=triaged lane=A branch=fix/W-1
for k in 2 3 4; do q add "W-$k"; q set "W-$k" state=triaged lane=A "branch=fix/W-$k" 'fix={"try":1,"of":2,"pr":5'"$k"',"kind":"review","what":"a P1 review finding"}'; done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-348 AC1 a worktree another process works in is held, naming the pid" \
  '[ "$(field W-1 state)" = "\"triaged\"" ] && ! grep -qx W-1 "$T/wb-spawns" && echo "$out" | grep -qF "W-1: WORKTREE IN USE — its worktree $T/wt/W-1 is the working directory of pid 4242 (claude), which the pass did not start"'
check "DS-348 AC2 a fix try whose worktree has an uncommitted change is held, saying so" \
  '[ "$(field W-2 state)" = "\"triaged\"" ] && ! grep -qx W-2 "$T/wb-spawns" && echo "$out" | grep -qF "W-2: WORKTREE IN USE — its worktree $T/wt/W-2 has uncommitted changes (a.txt)"'
check "DS-348 AC2 a fix try whose branch is ahead of origin is held, saying so" \
  '[ "$(field W-3 state)" = "\"triaged\"" ] && ! grep -qx W-3 "$T/wb-spawns" && echo "$out" | grep -qF "W-3: WORKTREE IN USE — its branch fix/W-3 is 1 commit(s) ahead of origin/fix/W-3, not pushed"'
check "DS-348 an untracked file alone does not hold a fix try" '[ "$(field W-4 state)" = "\"running\"" ] && grep -qx W-4 "$T/wb-spawns"'
check "a held worktree is kept on its ticket, with why, so desk-q and needs-you show it as needing you" \
  'field W-2 worktree_busy.why | grep -qF "its worktree $T/wt/W-2 has uncommitted changes (a.txt)" && field W-1 worktree_busy.why | grep -qF "pid 4242" && field W-3 worktree_busy.why | grep -qF "its branch fix/W-3 is 1 commit(s) ahead of origin/fix/W-3, not pushed" && [ "$(field W-4 worktree_busy)" = null ]'
# desk-q's own rule, read from a script file: desk-q.mjs takes an -e script's arguments for its own.
cat > "$T/shown.mjs" <<'EOF'
const { shownState } = await import(process.argv[2]);
const { readFileSync } = await import('node:fs');
const q = JSON.parse(readFileSync(process.argv[3], 'utf8'));
console.log(shownState(q, q.tickets[process.argv[4]]));
EOF
shown(){ node "$T/shown.mjs" "$B/desk-q.mjs" "$DESK_QUEUE" "$1"; }
check "desk-q groups it as needing you, not ready" '[ "$(shown W-2)" = needs ] && [ "$(shown W-3)" = needs ]'
: > "$T/lsof.out"; git -C "$T/wt/W-2" checkout -q -- a.txt; git -C "$T/wt/W-3" push -q origin fix/W-3 2>/dev/null
# The repo's shared cap leaves this batch one slot a pass here: each spawned worker is finished before the next.
held=""; left=""; stale=""
for k in 1 2 3; do
  for w in W-1 W-2 W-3 W-4; do [ "$(field "$w" state)" = "\"running\"" ] && q set "$w" state=done session_id=null; done
  out=$(node "$B/pass.mjs" 2>&1); echo "$out" | grep -q "WORKTREE IN USE" && held=yes
  # The first pass spawns one of them: the record is dropped from the others, still triaged, because
  # their worktrees are clean now, and they read as ready again.
  if [ "$k" = 1 ]; then
    stale=""
    for w in W-1 W-2 W-3; do
      [ "$(field "$w" state)" = "\"triaged\"" ] || continue
      [ "$(field "$w" worktree_busy)" = null ] && [ "$(shown "$w")" = ready ] || stale="$stale $w"
      left=yes
    done
  fi
done
check "a pass drops the record from a ticket still triaged once its worktree is clean, and it reads as ready" '[ -n "${left:-}" ] && [ -z "$stale" ]'
check "DS-348 AC3 once each cause clears, the next pass spawns the worker" \
  '[ "$(grep -cxE "W-[123]" "$T/wb-spawns")" = 3 ] && [ -z "$held" ]'
check "and the record is dropped from each ticket once its worktree is clean" \
  '[ "$(field W-1 worktree_busy)$(field W-2 worktree_busy)$(field W-3 worktree_busy)" = nullnullnull ]'

# W-5 is a fix try on its open PR whose worker was killed mid-edit, leaving an uncommitted change: its
# own session is resumed, not held. W-6 is a fix try requeued for a fresh worker, with an uncommitted change no worker
# of its own is resuming: still held.
for w in W-1 W-2 W-3 W-4; do q set "$w" state=done; done
: > "$T/wb-spawns"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1 \$3 resume=\${AUTOPILOT_RESUME:+yes}" >> "$T/wb-spawns"; echo "[spawn] ticket=\$1"
EOF
for k in 5 6; do
  git clone -q "$T/wb-origin.git" "$T/wt/W-$k" 2>/dev/null; git -C "$T/wt/W-$k" checkout -q -b "fix/W-$k"
  echo a > "$T/wt/W-$k/a.txt"; git -C "$T/wt/W-$k" add a.txt; git -C "$T/wt/W-$k" commit -q -m a; git -C "$T/wt/W-$k" push -q origin "fix/W-$k" 2>/dev/null
  echo b >> "$T/wt/W-$k/a.txt"; q add "W-$k"
done
q set W-5 state=running lane=A branch=fix/W-5 "worktree=$T/wt/W-5" session_id=sess-w5 port=47760 stage=4/9 'fix={"try":1,"of":2,"pr":55,"kind":"review","what":"a P1 review finding"}'
say "AUTOPILOT_STAGE: 4/9 verify" > "$T/state-wb/logs/W-5.log"; touch -t 202601010000 "$T/state-wb/logs/W-5.log"
q set W-6 state=triaged lane=A branch=fix/W-6 'fix={"try":1,"of":2,"pr":56,"kind":"review","what":"a P1 review finding"}'
printf '#!/bin/sh\ncase "$*" in *"--head fix/W-5"*) echo 55 ;; esac\n' > "$T/stub/gh"
out=$(node "$B/pass.mjs" 2>&1)
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
check "DS-388 AC3 a fix try whose own worker was killed with its worktree dirty is not held, and that session resumes" \
  'grep -qx "W-5 sess-w5 resume=yes" "$T/wb-spawns" && [ "$(field W-5 state)" = "\"running\"" ] && [ "$(field W-5 worktree_busy)" = null ] && ! echo "$out" | grep -q "W-5: WORKTREE IN USE" && echo "$out" | grep -q "W-5 resumed after it was killed" && ! echo "$out" | grep -q "W-5: PR #55"'
check "DS-388 AC4 a fix try whose worktree holds changes no worker of its own is resuming is still held" \
  '[ "$(field W-6 state)" = "\"triaged\"" ] && ! grep -q "^W-6 " "$T/wb-spawns" && echo "$out" | grep -qF "W-6: WORKTREE IN USE — its worktree $T/wt/W-6 has uncommitted changes (a.txt)" && [ "$(field W-6 resume)" = null ]'

echo "pass: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
