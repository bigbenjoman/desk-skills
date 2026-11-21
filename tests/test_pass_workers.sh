#!/usr/bin/env bash
# suite: pass: workers (screenshots go to the current round's PR; requeue; stalls, limits, kills, handoffs)
# pass.mjs after a requeue: screenshots go to the PR the current log names, not the one an earlier
# round stored, and a respawn clears the stored PR and image flags and starts a fresh log and park
# record. queue.mjs requeue moves a finished round's files aside so it respawns. A worker whose log
# says DONE is recorded done even while its session hangs, and is never parked as wedged. Then usage
# limits, decisions, the check-in digest, killed workers, handoffs and resumes. Runs the real pass.mjs,
# queue.mjs, harvest.mjs, batch-state.mjs and briefing.mjs with stub claude, gh, upload-images,
# setup-worktree and spawn-worker (tests/pass_setup.sh). Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
# shellcheck source=pass_setup.sh
. "$(dirname "$0")/pass_setup.sh"

q init t
# T-1: a requeued round whose log names PR 2 while the queue still holds round one's PR 1.
q add T-1; q set T-1 state=running branch=fix/T-1 session_id=gone result.pr=1 "worktree=$T/wt/T-1"
say "AUTOPILOT_IMAGES: $T/state/images/T-1/" "AUTOPILOT_DONE: pr=2 jira=none" > "$T/state/logs/T-1.log"
# DS-833: its worktree root holds a desk-review round's results file, and another JSON file.
mkdir -p "$T/wt/T-1"; echo '{"sha":"abc1234","round":1,"gaps":1}' > "$T/wt/T-1/desk-review-results-abc1234-k3q9xz.json"; echo '{}' > "$T/wt/T-1/other.json"
mkdir -p "$T/wt/T-1/desk-review-results-not-a-file.json"; ln -s "$T/wt/T-1/other.json" "$T/wt/T-1/desk-review-results-a-link.json"
# T-2: a log with screenshots and no AUTOPILOT_DONE yet, so the stored PR is all there is.
q add T-2; q set T-2 state=running branch=fix/T-2 session_id=gone result.pr=5 "worktree=$T/wt/T-2"
# Its worktree is there and holds no results file, only another JSON file.
mkdir -p "$T/wt/T-2"; echo '{}' > "$T/wt/T-2/other.json"
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
check "DS-833 AC3 an exited worker's review results file is kept under the state folder for its ticket" 'grep -q "\"gaps\":1" "$T/state/reviews/T-1/desk-review-results-abc1234-k3q9xz.json" && [ ! -e "$T/state/reviews/T-1/other.json" ]'
check "DS-833 a directory or a link named like a results file is not copied, and the pass still records the worker" '[ ! -e "$T/state/reviews/T-1/desk-review-results-not-a-file.json" ] && [ ! -e "$T/state/reviews/T-1/desk-review-results-a-link.json" ] && [ "$(field T-1 state)" = "\"done\"" ]'
check "DS-833 AC3 a worker with no results file keeps no reviews folder" '[ ! -e "$T/state/reviews/T-2" ]'
check "DS-193 AC1 a missing image directory runs no upload and reports nothing" '! grep -q "^11 " "$T/uploads" && ! echo "$out" | grep -q "I-1: image" && [ "$(field I-1 images_uploaded)" = "\"none\"" ] && [ "$(field I-1 state)" = "\"done\"" ]'
check "DS-193 AC2 a directory with no image runs no upload and reports nothing" '! grep -q "^12 " "$T/uploads" && ! echo "$out" | grep -q "I-2: image" && [ "$(field I-2 images_uploaded)" = "\"none\"" ] && [ "$(field I-2 state)" = "\"done\"" ]'
check "DS-193 AC3 a directory with screenshots still uploads and is reported" 'echo "$out" | grep -q "T-1 images → #2" && [ "$(field T-1 images_uploaded)" = true ]'
check "DS-673 AC5 the pass uploads through the machine's upload queue, capped at the minute's pace" 'grep -qx "2 $T/state/images/T-1/ --max 6" "$T/upload-args"'
check "DS-673 AC5 each upload done, the queue holds no job and no result" 'node -e "const q = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); process.exit(q.jobs.length + q.results.length)" "$T/desk/upload-queue.json"'

# R-1 and R-2: finished tickets whose uploads ended in another repo's pump. R-1's was its last round's,
# ending after its next round started; R-2's is its own round's.
q add R-1; q set R-1 state=done branch=fix/R-1 upload_round=new result.pr=21
q add R-2; q set R-2 state=done branch=fix/R-2 upload_round=same result.pr=22
node -e 'const [f, queue] = process.argv.slice(1); const r = (key, round, pr) => ({ queue, repo: "acme/widgets", key, round, pr, dir: "/d/", code: 0, out: "[upload] done: 1 image(s) in the body, 0 placeholder(s) left", done_at: new Date().toISOString() }); require("fs").writeFileSync(f, JSON.stringify({ jobs: [], results: [r("R-1", "old", 21), r("R-2", "same", 22)], served: {}, backoff: null }))' "$T/desk/upload-queue.json" "$DESK_QUEUE"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-673 a result of a ticket's earlier round is not recorded on its next round" '[ "$(field R-1 images_uploaded)" = null ] && echo "$out" | grep -q "R-1: an upload to PR #21 from an earlier round"'
check "DS-673 a result of the ticket's own round is recorded"                       '[ "$(field R-2 images_uploaded)" = true ]'

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
q add T-9; q set T-9 state=parked lane=C open_questions=1 'park={"question":"lane C — spans layers"}'
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
q init c
out=$(node "$B/pass.mjs" 2>&1)
check "DS-115 AC2 a count nobody set reports the §3b default" 'echo "$out" | grep -qx "workers: concurrency 3, the §3b default"'
q set-batch concurrency=4 concurrency_by=user
out=$(node "$B/pass.mjs" 2>&1)
check "DS-115 AC1 a count the user set reports as theirs" 'echo "$out" | grep -qx "workers: concurrency 4, set by the user" && [ "$(bfield concurrency_user)" = 4 ]'
q set-batch concurrency=1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-115 a lowering on memory keeps the user's number" '[ "$(bfield concurrency_by)" = "\"user\"" ] && [ "$(bfield concurrency_user)" = 4 ] && echo "$out" | grep -q "workers: concurrency 1, lowered on memory from the user.s 4: raise back to 4"'
# #926: under a spawn gate, the line says "on memory" only with available memory under the ladder's line.
out=$(DESK_MEM_AVAIL_GB=15 AUTOPILOT_MIN_AVAIL_GB=8 node "$B/pass.mjs" 2>&1)
check "#926 a count below the user's with memory above the line says memory did not lower it" 'echo "$out" | grep -q "workers: concurrency 1, below the user.s 4, though available memory is 15.0G, at or above the ladder.s 8G line, so memory did not lower it" && ! echo "$out" | grep -q "lowered on memory"'
out=$(DESK_MEM_AVAIL_GB=3 AUTOPILOT_MIN_AVAIL_GB=8 node "$B/pass.mjs" 2>&1)
check "#926 one under the line says memory lowered it, with the figure" 'echo "$out" | grep -q "workers: concurrency 1, lowered on memory from the user.s 4 (available memory 3.0G, under the ladder.s 8G line): raise back to 4"'
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
# #823: ports a peer session claimed at handshake (port-claims.mjs) are skipped though nothing listens.
node "$B/port-claims.mjs" claim 47501-47502 --by 'peer acme/shop' >/dev/null
spawn_one P-176
check "#823 a port range a peer claimed is skipped, though its server is down" '[ "$(field P-176 state)" = "\"running\"" ] && [ "$(field P-176 port)" = 47503 ]'
node "$B/port-claims.mjs" release --by 'peer acme/shop' >/dev/null
spawn_one P-177
check "#823 once the peer releases it, the port is used again" '[ "$(field P-177 state)" = "\"running\"" ] && [ "$(field P-177 port)" = 47501 ]'
# DS-825: a claim that lapsed unrenewed (its peer's session gone) no longer blocks its ports, and the
# pass says it dropped it, once; a claims file it cannot read is named, and the pass picks as before.
claims="$HOME/.desk-autopilot/port-claims.jsonl"
echo '{"at":"2026-01-01T00:00:00.000Z","by":"peer gone","event":"claim","from":47501,"to":47502,"until":"2026-01-01T12:00:00.000Z"}' >> "$claims"
spawn_one P-178
check "DS-825 AC3 a lapsed claim's ports are used, and the report says the stale claim was dropped" '[ "$(field P-178 port)" = 47501 ] && echo "$out" | grep -qF "ports: dropped peer gone'"'"'s claim on 47501-47502, which lapsed unrenewed at 2026-01-01T12:00:00.000Z"'
spawn_one P-179
check "DS-825 AC3 a claim dropped once is not reported again" '[ "$(field P-179 port)" = 47501 ] && ! echo "$out" | grep -qF "peer gone"'
mv "$claims" "$claims.aside"; mkdir "$claims"
spawn_one P-180
check "DS-825 AC4 a claims file that cannot be read is named, and the pass picks as before" '[ "$(field P-180 state)" = "\"running\"" ] && [ "$(field P-180 port)" = 47501 ] && echo "$out" | grep -qF "ports: the port claims file $claims cannot be read (EISDIR)"'
rmdir "$claims"
spawn_one P-181
check "DS-825 AC4 a missing claims file is named, and the pass picks as before" '[ "$(field P-181 state)" = "\"running\"" ] && [ "$(field P-181 port)" = 47501 ] && echo "$out" | grep -qF "ports: there is no port claims file $claims, so no peer has claimed a port"'
mv "$claims.aside" "$claims"
# DS-910: with the port lease kind on, a pass skips a port a peer session leases, and hands each
# worker's port lease to the pid spawn-worker.sh printed. The peer and the worker are sleep processes.
export DESK_LEASE_DIR="$T/leases" DESK_MACHINE="$T/machine-ports-on.md"
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `port=on` | test |\n' > "$DESK_MACHINE"
other '{"tickets":{}}'
PEER=$( (sleep 300 >/dev/null 2>&1 & echo $!) ); WPID=$( (sleep 300 >/dev/null 2>&1 & echo $!) )
node "$B/leases.mjs" acquire port 47501 --ttl 3600 --label 'peer session acme/shop' --pid "$PEER" >/dev/null
cp "$T/desk/bin/spawn-worker.sh" "$T/spawn-worker.kept"
printf 'if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1 pid=%s port=$AUTOPILOT_PORT"; fi\n' "$WPID" > "$T/desk/bin/spawn-worker.sh"
spawn_one P-910
check "DS-910 AC1 a port a peer session leases is not given out, though nothing listens on it" '[ "$(field P-910 state)" = "\"running\"" ] && [ "$(field P-910 port)" = 47502 ]'
check "DS-910 AC3 the lease list shows the worker's port held by its process, with its repo, batch and ticket" 'node "$B/leases.mjs" list --json | jq -e --argjson p "$WPID" "select(.key == \"47502\" and .owner.pid == \$p and .label == \"acme/widgets standing P-910\")" >/dev/null'
kill "$PEER"; while kill -0 "$PEER" 2>/dev/null; do sleep 0.1; done
spawn_one P-911
check "DS-910 AC6 a peer whose process exited no longer holds its port, and the report says so" '[ "$(field P-911 port)" = 47501 ] && echo "$out" | grep -qF "ports: dropped the stale lease on port 47501 held by peer session acme/shop (pid $PEER): owner exited"'
printf '{not json' > "$T/leases/leases.json"
spawn_one P-912
check "DS-910 AC9 an unreadable lease store picks by the legacy rule and the report says so" '[ "$(field P-912 state)" = "\"running\"" ] && [ "$(field P-912 port)" = 47501 ] && echo "$out" | grep -qF "ports: leases were unreadable ("'
kill "$WPID" 2>/dev/null; mv "$T/spawn-worker.kept" "$T/desk/bin/spawn-worker.sh"; unset DESK_LEASE_DIR DESK_MACHINE

# DS-121: a worker at the 5-hour usage limit. The event is the rejection recorded from a real worker,
# with its reset moved to suit each case. Each case is a running ticket whose log stopped growing
# five passes ago, one pass from the stall killer.
export DESK_QUEUE="$T/queue-u.json" DESK_AUTOPILOT_STATE="$T/state-u" AUTOPILOT_PORT_FLOOR=47601; mkdir -p "$T/state-u/logs"
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

# U-10: the tail a real worker wrote at the limit, its reset moved an hour ahead. After the
# rejection come the error messages written in the model's place and a subagent's reply to a request
# already in flight; neither is the model answering, so the session's 429 is the same 5-hour limit.
{ say "AUTOPILOT_STAGE: 4/9 verify"; node -e 'const fs = require("fs"); process.stdout.write(fs.readFileSync(process.argv[1], "utf8").replaceAll("1792768800", process.argv[2]))' "$S/fixtures/usage-limit-five-hour-session.jsonl" $((now + 3600)); } > "$T/state-u/logs/U-10.log"
quiet_running U-10 live-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-174 AC2 a real worker's tail at the limit is paused on the 5-hour limit with its reset time" '[ "$(field U-10 state)" = "\"running\"" ] && echo "$out" | grep -q "^paused on the usage limit: U-10 on the 5-hour usage limit until $(date -u -r $((now + 3600)) "+%Y-%m-%d %H:%M" 2>/dev/null || date -u -d "@$((now + 3600))" "+%Y-%m-%d %H:%M") UTC, then it resumes"'
check "DS-174 AC2 and is neither unrecognised nor recorded as resumed" '! echo "$out" | grep -q "unrecognised usage-limit event: U-10" && ! grep -q "^- \[U-10\] resumed" "$T/state-u/batch-notes.md"'
q set U-10 state=done

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
# N-5 and N-6 are put off on a question with a pr-head input, then both branches move. N-5 is asked
# again with the new head; N-6 is requeued while the pass reads its head from origin, and stays so.
# N-7 is requeued after its set, while the pass reads N-8's head: the write takes the set back.
RG=$(command -v git); mkdir -p "$T/lsr"
cat > "$T/stub/git" <<EOF
#!/bin/sh
if [ "\$1" = ls-remote ] && [ -f "$T/lsr/\${3##*/}" ]; then
  [ -f "$T/lsr/\${3##*/}.then" ] && sh "$T/lsr/\${3##*/}.then"
  printf '%s\t%s\n' "\$(cat "$T/lsr/\${3##*/}")" "\$3"; exit 0
fi
exec "$RG" "\$@"
EOF
chmod +x "$T/stub/git"
HQ='Ship it behind the flag?'
for k in N-5 N-6 N-7 N-8; do
  { say "AUTOPILOT_PARK: $HQ" 'AUTOPILOT_PARK_INPUTS: {"pr-head":"h1"}'; result_event; } > "$T/state-d/logs/$k.log"
  q add "$k"; q set "$k" state=running lane=A "branch=fix/$k" "session_id=run-$k"
done
node "$B/pass.mjs" >/dev/null 2>&1
for k in N-5 N-6 N-7 N-8; do node "$B/answer.mjs" "$k" "not now" >/dev/null 2>&1; echo h2 > "$T/lsr/$k"; done
printf '"%s" "%s" requeue N-6 >/dev/null 2>&1\n' "$NODE" "$B/queue.mjs" > "$T/lsr/N-6.then"
printf '"%s" "%s" requeue N-7 >/dev/null 2>&1\n' "$NODE" "$B/queue.mjs" > "$T/lsr/N-8.then"
out=$(node "$B/pass.mjs" 2>&1)
rm -rf "$T/lsr" "$T/stub/git"
check "DS-801 AC2 a put-off park whose branch moved gets the new head, and is listed under PARKED" '[ "$(field N-5 park.inputs)" = "{\"pr-head\":\"h2\"}" ] && echo "$out" | awk "/^PARKED/,0" | grep -qF "N-5: $HQ — Changed since it was put off on"'
check "DS-801 AC1 a requeue landing while the pass reads the head stands, and is not listed under PARKED" '[ "$(field N-6 state)" = "\"triaged\"" ] && [ "$(field N-6 park)" = null ] && ! echo "$out" | grep -qF "N-6: $HQ — Changed since"'
check "DS-801 AC1 a requeue landing after the set and before the write stands, and is not listed under PARKED" '[ "$(field N-7 state)" = "\"triaged\"" ] && [ "$(field N-7 park)" = null ] && ! echo "$out" | grep -qF "N-7: $HQ — Changed since" && echo "$out" | awk "/^PARKED/,0" | grep -qF "N-8: $HQ — Changed since it was put off on"'
for k in N-5 N-6 N-7 N-8; do q set "$k" state=done; done
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
# §4 rows no review of the command can read clean. Each config is the fixture's plus its two rows.
review_rows(){ { cat "$T/config.md"; printf '\n## 4. Checks\n| Field | Value |\n|---|---|\n| Local review command | `%s` |\n| Clean review verdict | `%s` |\n' "$1" "$2"; } > "$T/config-rows.md"; out=$(DESK_CONFIG="$T/config-rows.md" node "$B/pass.mjs" 2>&1); }
review_rows /code-review 'p0=0 p1=0 gaps=0'
check "DS-439 AC5 a pass logs that the review rows contradict each other, naming both" 'echo "$out" | grep -F "review rows: config §4 Local review command (\`/code-review\`) and §4 Clean review verdict (\`p0=0 p1=0 gaps=0\`) contradict each other" | grep -qF "/desk-setup"'
review_rows /code-review 'p0=0 p1=0 gaps=0'
check "DS-439 AC5 and only once" '! echo "$out" | grep -q "review rows:"'
review_rows /other-review 'p0=0 p1=0 gaps=0'
check "DS-439 AC5 a different pair of rows is logged afresh" 'echo "$out" | grep -qF "(\`/other-review\`)"'
rm -f "$T/state-c/review-rows-reported.txt"
review_rows /desk-review 'p0=0 p1=0 gaps=0'
check "DS-439 negative control: /desk-review beside the counts logs nothing" '! echo "$out" | grep -q "review rows:"'
review_rows /code-review 'no findings'
check "DS-439 negative control: /code-review beside a plain-text verdict logs nothing" '! echo "$out" | grep -q "review rows:"'
review_rows none 'p0=0 p1=0 gaps=0'
check "DS-439 AC6 §4 Local review command none logs nothing" '! echo "$out" | grep -q "review rows:"'
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
echo "\$1 \$3 port=\${AUTOPILOT_PORT:-} resume=\${AUTOPILOT_RESUME:+yes}\${AUTOPILOT_BUDGET_USD:+ budget=\$AUTOPILOT_BUDGET_USD}" >> "$T/spawns"; printf '%s\n' "\${AUTOPILOT_RESUME:-}" > "$T/resume-prompt-\$1"; echo "[spawn] ticket=\$1"
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
# A fixture saved for K-2 while it was down, after its briefing was written.
mkdir -p "$T/state-k/fixtures/K-2"; printf '{"k":2}' > "$T/state-k/fixtures/K-2/post.json"
out=$(DESK_BOOT_TIME=2020-01-01T00:00:00Z node "$B/pass.mjs" 2>&1)
check "DS-553 AC1 a killed worker's fixtures are copied into its worktree on resume, and its resume prompt names the path" \
  '[ "$(cat "$T/wt/K-2/.desk-fixtures/K-2/post.json")" = "{\"k\":2}" ] && grep -qF "copied into your worktree at $T/wt/K-2/.desk-fixtures/K-2/ (untracked, and kept out of git status): post.json." "$T/resume-prompt-K-2"'
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
# B-1's session ended on the per-worker budget with its change uncommitted.
budget_event(){ node -e 'console.log(JSON.stringify({ type: "result", subtype: process.argv[1], is_error: true, num_turns: 90, total_cost_usd: 25.02, result: "" }))' "${1:-error_max_budget_usd}"; }
killed B-1 sess-b1; budget_event >> "$T/state-k/logs/B-1.log"; echo change > "$T/wt/B-1/new.txt"; git -C "$T/wt/B-1" init -q
out=$(AUTOPILOT_BUDGET_USD=25 node "$B/pass.mjs" 2>&1)
check "DS-849 AC1 a worker stopped at the per-worker budget is resumed once in its own session, not failed" \
  'spawned_for B-1 | grep -q "^B-1 sess-b1 .*resume=yes budget=5$" && [ "$(field B-1 state)" = "\"running\"" ] && [ "$(field B-1 budget_resumed)" = "\"sess-b1\"" ] && [ "$(field B-1 resumes)" = 0 ] && echo "$out" | grep -q "B-1 resumed once after it stopped at the per-worker budget, with \$5 more to commit, push and finish its stage"'
check "DS-849 AC1 with \$5 more, told to commit, push and finish its stage" \
  'grep -q "spend it on committing your work, pushing it and finishing the stage you were in" "$T/resume-prompt-B-1"'
# Its resumed session ends on the budget too.
budget_event >> "$T/state-k/logs/B-1.log"; touch -t 202601010000 "$T/state-k/logs/B-1.log"
out=$(AUTOPILOT_BUDGET_USD=25 node "$B/pass.mjs" 2>&1)
check "DS-849 AC2 a second budget stop parks, naming the budget and the uncommitted work" \
  '[ "$(field B-1 state)" = "\"parked\"" ] && field B-1 park.question | grep -q "stopped at the per-worker budget (\$25, config §3b ..Autopilot per-worker budget (USD)..) again after its one resume with \$5 more, and its worktree $T/wt/B-1 holds uncommitted work (1 changed file(s))" && [ "$(spawned_for B-1 | wc -l | tr -d " ")" = 1 ]'
# B-3's session ended in another error; B-4's on the budget subtype, with no per-worker budget set.
killed B-3 sess-b3; budget_event error_during_execution >> "$T/state-k/logs/B-3.log"
killed B-4 sess-b4; budget_event >> "$T/state-k/logs/B-4.log"
out=$(AUTOPILOT_BUDGET_USD=none node "$B/pass.mjs" 2>&1)
check "DS-849 AC3 another error is marked failed as before" '[ "$(field B-3 state)" = "\"failed\"" ] && ! spawned_for B-3'
check "DS-849 AC4 with the per-worker budget none, a budget-stop subtype is any other error" '[ "$(field B-4 state)" = "\"failed\"" ] && ! spawned_for B-4 && [ "$(field B-4 resume)" = null ]'
h=$(AUTOPILOT_BUDGET_USD=25 node "$B/harvest.mjs" "$T/state-k/logs/B-4.log" 2>&1)
h3=$(AUTOPILOT_BUDGET_USD=25 node "$B/harvest.mjs" "$T/state-k/logs/B-3.log" 2>&1)
hn=$(AUTOPILOT_BUDGET_USD=none node "$B/harvest.mjs" "$T/state-k/logs/B-4.log" 2>&1)
check "DS-849 harvest names a budget stop, and any other error, or one with no budget, as failed" \
  'echo "$h" | grep -qx "state:  BUDGET STOP" && echo "$h3" | grep -qx "state:  FAILED" && echo "$hn" | grep -qx "state:  FAILED"'
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
# DS-554: K-11's log holds only the preflight's cost line, as FW-87's did, and spawn-worker.sh recorded
# its session's exit code. K-12's exit file is an earlier session's.
mkdir -p "$T/state-k/workers"
preflight_only(){ killed "$1" "$2"; printf '{"type":"desk_preflight","total_cost_usd":0.1,"num_turns":3}\n' > "$T/state-k/logs/$1.log"; touch -t 202601010000 "$T/state-k/logs/$1.log"; }
preflight_only K-11 sess-k11; printf '{"session":"sess-k11","code":1,"at":"2026-11-04T09:10:00Z"}\n' > "$T/state-k/workers/K-11.exit.json"
preflight_only K-12 sess-k12; printf '{"session":"sess-old","code":0,"at":"2026-11-04T09:10:00Z"}\n' > "$T/state-k/workers/K-12.exit.json"
out=$(DESK_CONFIG="$T/config-k0.md" node "$B/pass.mjs" 2>&1)
check "DS-554 AC1 a worker that ended after its preflight is failed naming that and its exit code" \
  '[ "$(field K-11 state)" = "\"failed\"" ] && field K-11 failed.why | grep -q "ended after its preflight with no output, exit code 1" && echo "$out" | grep -q "K-11: killed before it finished .*ended after its preflight with no output, exit code 1).* — check "'
check "DS-554 AC1 the status table gives the reason" 'node "$B/queue.mjs" render | grep "K-11" | grep -q "FAILED .*ended after its preflight with no output, exit code 1"'
check "DS-554 an exit code another session recorded is not quoted" 'field K-12 failed.why | grep -q "ended after its preflight with no output, exit code not recorded"'
out=$(DESK_CONFIG="$T/config-k0.md" node "$B/pass.mjs" 2>&1)
check "DS-554 AC3 a later pass's waiting line quotes the recorded reason" 'echo "$out" | grep -q "K-11: FAILED (killed before it finished .*ended after its preflight with no output, exit code 1"'
q set K-11 state=done; q set K-12 state=done
# K-13's session ended with its DONE marker after other words on its result's line, as VPL-768's did.
killed K-13 sess-k13; node -e 'console.log(JSON.stringify({ type: "result", is_error: false, num_turns: 9, total_cost_usd: 1, result: "All stages finished. AUTOPILOT_DONE: pr=93 jira=Review" }))' >> "$T/state-k/logs/K-13.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-554 AC2 a DONE marker mid-line in the last result is recorded done, not failed" '[ "$(field K-13 state)" = "\"done\"" ] && [ "$(field K-13 result.pr)" = 93 ] && [ "$(field K-13 failed)" = null ]'
q set K-13 state=done
# K-14 and K-15 only mention the marker, mid-sentence and quoted, so neither finished.
killed K-14 sess-k14; node -e 'console.log(JSON.stringify({ type: "result", is_error: false, num_turns: 9, total_cost_usd: 1, result: "Tests are red, so I did not print AUTOPILOT_DONE: pr=12" }))' >> "$T/state-k/logs/K-14.log"
killed K-15 sess-k15; node -e 'console.log(JSON.stringify({ type: "result", is_error: false, num_turns: 9, total_cost_usd: 1, result: "Tests are red. I will print `AUTOPILOT_DONE: pr=12` once they pass." }))' >> "$T/state-k/logs/K-15.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-554 AC2 a DONE marker only mentioned in the result is not read as done" '[ "$(field K-14 state)" = "\"failed\"" ] && [ "$(field K-15 state)" = "\"failed\"" ] && [ "$(field K-14 result)" = null ]'
q set K-14 state=done; q set K-15 state=done
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
q set K-11 state=failed; out=$(node "$B/queue.mjs" requeue K-11 2>&1)
check "DS-554 a requeue clears the recorded failure" '[ "$(field K-11 failed)" = null ]'
q set K-11 state=done
check "DS-145 the config template has the row, recommended 2" 'grep -qE "^\| Resume a killed worker \(times\) \| \`2\` \| \`TODO\`" "$SRC/desk-config.md"'

# DS-551: a worker asked to stop for a planned reboot ends with AUTOPILOT_REBOOT and exits normally.
# R-1 stopped just now: it waits for the boot, then resumes. R-2 stopped long ago with no boot since.
q set K-1 state=done
rebooted(){ killed "$1" "$2"; { say "AUTOPILOT_REBOOT: voicepa-83 asked at 07:31Z"; result_event; } >> "$T/state-k/logs/$1.log"; touch -t 202601010000 "$T/state-k/logs/$1.log"; }
rebooted R-1 sess-r1; touch "$T/state-k/logs/R-1.log"
out=$(DESK_BOOT_TIME=2020-01-01T00:00:00Z node "$B/pass.mjs" 2>&1)
check "DS-551 AC1 a worker stopped for a reboot is queued to resume, not parked or failed" \
  '[ "$(field R-1 state)" = "\"triaged\"" ] && [ "$(field R-1 resume)" = "\"reboot\"" ] && [ "$(field R-1 park)" = null ] && [ "$(field R-1 session_id)" = "\"sess-r1\"" ] && ! echo "$out" | grep -q "R-1: exited with no marker"'
check "DS-551 AC1 before the computer restarts it waits, and the pass says what for" \
  '! spawned_for R-1 && echo "$out" | grep -qF "waiting for the reboot: R-1 (stopped for a planned reboot (voicepa-83 asked at 07:31Z), resumed after the computer restarts, or at "'
out=$(DESK_BOOT_TIME=$(( $(date +%s) + 60 )) node "$B/pass.mjs" 2>&1)
check "DS-551 AC2 after the restart its own session resumes, naming the reboot, uncounted" \
  'spawned_for R-1 | grep -q "^R-1 sess-r1 .*resume=yes$" && echo "$out" | grep -q "R-1 resumed after its stop for a planned reboot — the computer restarted at .* after it stopped for a planned reboot (voicepa-83 asked at 07:31Z)" && [ "$(field R-1 resumes)" = 0 ] && grep -q "the computer restarted at" "$T/resume-prompt-R-1"'
# The resumed session is then killed: its spent REBOOT marker does not queue it as a reboot stop again.
say "AUTOPILOT_STAGE: 7/9 pr" >> "$T/state-k/logs/R-1.log"; touch -t 202601010000 "$T/state-k/logs/R-1.log"
out=$(DESK_BOOT_TIME=2020-01-01T00:00:00Z node "$B/pass.mjs" 2>&1)
check "DS-551 a resumed session killed later is resumed as a kill, not as another reboot stop" 'echo "$out" | grep -q "R-1 resumed after it was killed (1 of 2)"'
q set R-1 state=done
rebooted R-2 sess-r2
out=$(DESK_BOOT_TIME=2020-01-01T00:00:00Z node "$B/pass.mjs" 2>&1)
check "DS-551 AC4 with no reboot within the drain limit it resumes anyway, saying no reboot was seen" \
  'spawned_for R-2 | grep -q "^R-2 sess-r2 .*resume=yes$" && echo "$out" | grep -qF "R-2 resumed after its stop for a planned reboot — no reboot was seen within 60 min (config §3b \"Maintenance drain limit (minutes)\") of when it stopped for a planned reboot"'
q set R-2 state=done
# R-3 has had every kill resume the row allows: a reboot stop is not a kill, so it still resumes, uncounted.
rebooted R-3 sess-r3; q set R-3 resumes=2
out=$(DESK_BOOT_TIME=$(( $(date +%s) + 60 )) node "$B/pass.mjs" 2>&1)
check "DS-551 AC2 a reboot stop resumes past the kill-resume limit, leaving the count" \
  'spawned_for R-3 | grep -q "^R-3 sess-r3 .*resume=yes$" && [ "$(field R-3 resumes)" = 2 ] && [ "$(field R-3 park)" = null ]'
q set R-3 state=done
# R-4 printed DONE, then REBOOT in a later turn of the same session: it is recorded done, not resumed.
killed R-4 sess-r4; say "AUTOPILOT_DONE: pr=79 jira=none" "AUTOPILOT_REBOOT: voicepa-83 asked at 07:31Z" >> "$T/state-k/logs/R-4.log"; result_event >> "$T/state-k/logs/R-4.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-551 a REBOOT after DONE leaves the ticket done" '[ "$(field R-4 state)" = "\"done\"" ] && [ "$(field R-4 result.pr)" = 79 ] && ! spawned_for R-4'

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
check "DS-197 AC4 an exit with no marker and no limit is marked failed as before" '[ "$(field Y-4 state)" = "\"failed\"" ] && echo "$out" | grep -q "Y-4: exited with no marker and no open PR on fix/Y-4 (.*) — check" && ! spawned_for Y-4'

# The same exits with the ticket's PR open. Y-7 is killed mid-run and Y-8 ends normally with no
# marker; then Y-6 exits at the limit, its log ending as usage_exit's does.
printf '#!/bin/sh\ncase "$*" in *"--head fix/Y-"[678]*) echo 88 ;; esac\n' > "$T/stub/gh"
killed Y-7 sess-y7
killed Y-8 sess-y8; result_event >> "$T/state-k/logs/Y-8.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-388 a worker with an open PR killed mid-run is resumed in its own session, not done" 'spawned_for Y-7 | grep -q "^Y-7 sess-y7 .*resume=yes$" && [ "$(field Y-7 result)" = null ] && ! echo "$out" | grep -q "Y-7: PR #88"'
check "DS-388 AC5 a worker with an open PR that ended normally with no marker is done as before" '[ "$(field Y-8 state)" = "\"done\"" ] && [ "$(field Y-8 result.pr)" = 88 ] && echo "$out" | grep -q "Y-8: PR #88 (no marker printed"'
q set Y-7 state=done
# The same exits on the person's instruction: an open PR does not show it was carried out, and a ticket
# recorded done has its fix closed in that pass, which frees the merge.
instruction_fix='fix={"try":1,"of":1,"kind":"instruction","pr":88,"head":null,"ready":true,"what":"your instruction","answer":"rename it"}'
killed Y-61 sess-y61; q set Y-61 "$instruction_fix"; result_event >> "$T/state-k/logs/Y-61.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-501 a worker on the person's instruction that ended with no marker parks, its fix left open" '[ "$(field Y-61 state)" = "\"parked\"" ] && [ "$(field Y-61 fix.finished)" = null ] && [ "$(field Y-61 result)" = null ] && field Y-61 park.question | grep -q "your instruction on PR #88 may not be carried out" && ! echo "$out" | grep -q "Y-61: PR #88 (no marker printed"'
q requeue Y-61
check "DS-501 a requeue of that park keeps the instruction for its next worker" '[ "$(field Y-61 state)" = "\"triaged\"" ] && [ "$(field Y-61 fix.answer)" = "\"rename it\"" ] && [ "$(field Y-61 fix.finished)" = null ]'
q set Y-61 state=done
killed Y-62 sess-y62; q set Y-62 "$instruction_fix" resumes=2
out=$(DESK_BOOT_TIME=2020-01-01T00:00:00Z node "$B/pass.mjs" 2>&1)
check "DS-501 so does a worker on the instruction killed past its resumes" '[ "$(field Y-62 state)" = "\"parked\"" ] && [ "$(field Y-62 fix.finished)" = null ] && field Y-62 park.question | grep -q "your instruction on PR #88"'
q set Y-62 state=done
# DS-493: a migration rename try holds the merge the same way, and done would spend its one try.
killed Y-64 sess-y64; q set Y-64 'fix={"try":1,"of":2,"extra":true,"kind":"renames","pr":88,"head":null,"renames":[{"old":"0007_a.sql","new":"0008_a.sql","to":"main","files":["src/x.ts"]}]}'; result_event >> "$T/state-k/logs/Y-64.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-493 a worker on a rename try that ended with no marker parks, its fix left open" '[ "$(field Y-64 state)" = "\"parked\"" ] && [ "$(field Y-64 fix.finished)" = null ] && [ "$(field Y-64 result)" = null ] && field Y-64 park.question | grep -q "the migrations PR #88 names may not be updated to their base.s new names (0007_a.sql → 0008_a.sql)" && ! echo "$out" | grep -q "Y-64: PR #88 (no marker printed"'
q set Y-64 state=done
killed Y-63 sess-y63; q set Y-63 "$instruction_fix" fix.finished=2026-01-01T00:00:00Z; result_event >> "$T/state-k/logs/Y-63.log"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-501 a finished instruction fix does not park a later worker on the ticket" '[ "$(field Y-63 state)" = "\"done\"" ] && echo "$out" | grep -q "Y-63: PR #88 (no marker printed"'
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
handing(){ git -C "$T/repo" worktree add -q -b "fix/$1" "$T/wt/$1"; q add "$1"; q set "$1" state=running lane=A "branch=fix/$1" "worktree=$T/wt/$1" "session_id=old-$1" stage=4/9; }
brief(){ cat "$T/state-h/briefings/$1.md"; }
q init h
printf '# Batch notes\n\nSIBLING-NOTE about a helper\n' > "$T/state-h/batch-notes.md"
handing H-1; hfile H-1 4b "typecheck: pass"; echo "use the blue widget" > "$T/state-h/answers/H-1.txt"
mkdir -p "$T/state-h/triage"
printf '%s\n' '{"ticket":"H-1","lane":"A","unknowns":[],"decided":[{"question":"which retry backoff?","options":["fixed","exponential"],"chose":"exponential","category":"engineering"},{"question":"name the flag?","options":["on","enabled"],"chose":"enabled","category":"wording"}],"verify_only":true,"already_met":["AC1: src/a.js:12"]}' > "$T/state-h/triage/H-1.json"
printf '%s\n' '{"id":"f1","ticket":"H-1","question":"name the flag?","options":["on","enabled"],"chose":"enabled","category":"wording"}' \
  '{"id":"o1","override_of":"f1","ticket":"H-1","question":"name the flag?","was":"enabled","chose":"on","by":"ben"}' >> "$T/state-h/decisions.jsonl"
hlog H-1 "$(printf 'AUTOPILOT_STAGE: 4/9 verify\nAUTOPILOT_HANDOFF: 4b')"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-394 AC2/AC4 the briefing carries the calls triage took and the verify-only task" 'brief H-1 | grep -qxF -- "- which retry backoff?: \"exponential\" (engineering; the other options: fixed)" && brief H-1 | grep -qF "## Verify-only" && brief H-1 | grep -qxF -- "- AC1: src/a.js:12" && brief H-1 | grep -qF "Prove each criterion with a test"'
check "DS-394 AC2 a call the person overrode since admission is briefed with their choice" 'brief H-1 | grep -qxF -- "- name the flag?: \"on\" (the person overrode triage'"'"'s \"enabled\") (wording; the other options: enabled)"'
check "DS-155 AC1 a session that prints AUTOPILOT_HANDOFF: 4b is not done, parked or failed, and the report says it handed off" 'echo "$out" | grep -q "H-1 handed off at the end of Stage 4: queued for a fresh session from Stage 4b"'
check "DS-155 AC2 the pass spawns a new session for the ticket, on its branch, starting at Stage 4b" 'spawned_for H-1 | grep -q "^H-1 [0-9a-f-]* stage=4b branch=fix/H-1 brief=$T/state-h/briefings/H-1.md$" && [ "$(field H-1 state)" = "\"running\"" ] && [ "$(field H-1 stage)" = "\"4b\"" ] && echo "$out" | grep -q "spawned: H-1 fresh session from Stage 4b (handed off)"'
check "DS-155 AC2 with a new session id, the same worktree, and the handed-off session's log kept as its own round" '[ "$(field H-1 session_id)" != "\"old-H-1\"" ] && [ "$(field H-1 worktree)" = "\"$T/wt/H-1\"" ] && gzip -dc "$T/state-h/logs/H-1.log.round1.gz" | grep -q "AUTOPILOT_HANDOFF: 4b" && ! grep -q "AUTOPILOT_HANDOFF" "$T/state-h/logs/H-1.log"'
check "DS-553 AC2 a ticket with no fixtures folder has nothing copied, and its briefing does not mention fixtures" \
  '[ ! -e "$T/wt/H-1/.desk-fixtures" ] && ! brief H-1 | grep -qi "fixture"'
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

# DS-593: a hand-written briefing with a raw TAB in a string, and one that is not JSON at all.
handing H-8; printf '{"ticket":"H-8","criteria":["AC1: the widget saves"],"lane":"A","verification":["typecheck:\tpass"]}' > "$T/state-h/handoffs/H-8.json"
hlog H-8 "AUTOPILOT_HANDOFF: 7"
handing H-9; printf '{"ticket": "H-9", criteria: [' > "$T/state-h/handoffs/H-9.json"
hlog H-9 "AUTOPILOT_HANDOFF: 7"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-593 AC1 a briefing with a raw tab spawns the Stage 7 session, parking nothing" 'spawned_for H-8 | grep -q "stage=7 " && [ "$(field H-8 state)" = "\"running\"" ]'
check "DS-593 AC1 and its briefing holds the verification line" 'brief H-8 | grep -qF -- "- typecheck:$(printf "\t")pass"'
check "DS-593 AC2 a briefing that is not JSON spawns the next stage, parking nothing" 'spawned_for H-9 | grep -q "stage=7 " && [ "$(field H-9 state)" = "\"running\"" ]'
check "DS-593 AC2 its briefing tells the session to read the criteria from the ticket" 'brief H-9 | grep -qF "read them from H-9 at the start of Stage 7"'
check "DS-593 AC2 the report names the unreadable file, kept aside" 'echo "$out" | grep -qF "H-9: its handoff briefing $T/state-h/handoffs/H-9.json is not JSON" && echo "$out" | grep -qF "kept as $T/state-h/handoffs/H-9.json.unreadable" && [ -f "$T/state-h/handoffs/H-9.json.unreadable" ]'
q set H-8 state=done; q set H-9 state=done

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

# ---- DS-742: a worker queue.mjs stop ended stays held until the person lets it start -------------
all_done
handing S-1; hlog S-1 "AUTOPILOT_STAGE: 5/9 evidence"
# What an earlier release left on it: a label whose day has come, and a blocker in no batch.
q set S-1 held_label=blocked-until-2000-01-01 held_outside=GONE-9 "session_id=old-S-1-$SID_SUFFIX"
echo "half-written" > "$T/wt/S-1/widget.txt"
# The worker, as spawn-worker.sh starts it: a session leader whose command line names its session,
# started outside the suite's scratch dirs. Beside it, the same ticket's worker in another suite
# running at the same time, which only its session id tells apart.
(cd / && exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' bash -c 'sleep 300 & wait' desk-worker claude -p x --session-id "old-S-1-$SID_SUFFIX") &
sw=$!
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' bash -c 'sleep 300 & wait' desk-worker claude -p x --session-id "old-S-1-other$SID_SUFFIX" &
ow=$!
alive(){ /bin/ps -o stat= -p "$1" 2>/dev/null | grep -qv '^Z'; }
for _ in $(seq 50); do /bin/ps -o args= -p "$sw" "$ow" | grep -c -- "--session-id old-S-1-" | grep -qx 2 && break; sleep 0.1; done
node "$B/queue.mjs" stop S-1 >/dev/null 2>&1; stoprc=$?
check "DS-960 AC5 queue.mjs stop ends a real worker started outside the suite's dirs, found by its session id across the machine" '[ $stoprc = 0 ] && ! alive "$sw"'
check "DS-960 AC1 another suite's worker for a ticket of the same key is still running" 'alive "$ow"'
kill -TERM -- "-$sw" "-$ow" 2>/dev/null; wait "$sw" "$ow" 2>/dev/null
out=$(node "$B/pass.mjs" 2>&1)
check "DS-742 AC2 a stopped ticket gets no worker from the next pass" '! spawned_for S-1 && [ "$(field S-1 state)" = "\"parked\"" ] && [ "$(field S-1 held_by)" = null ] && echo "$out" | grep -q "S-1: STOPPED — its worker was stopped by queue.mjs stop"'
check "DS-742 a stopped ticket is not released on the date label or outside blocker an earlier release left" '[ "$(field S-1 held_outside)" = null ] && ! echo "$out" | grep -qE "(date|outside) hold: S-1"'
# needs-you's start runs desk-env's releaseCommand: these two writes.
q set S-1 state=triaged park=null held_by=null; q front S-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-742 AC3 let start, it gets a worker in its worktree on its branch, at the stage it was stopped in" 'spawned_for S-1 | grep -q "^S-1 [0-9a-f-]* stage=5 branch=fix/S-1 " && brief S-1 | grep -qF "## Last round: this session resumes at Stage 5" && brief S-1 | grep -qF "work in progress when queue.mjs stop ended its worker"'
q set S-1 state=done

# ---- DS-191: a triage record from before epics were recorded gets its epic read by the next pass
tracker_on
for k in T-50 T-51 T-52 T-53 T-54; do q add $k; done
q set T-52 state=done; q set T-50 state=triaged; q set T-51 state=triaged; q set T-53 state=triaged; q set T-54 state=triaged
# Their blocker links count as read, so only the epic lookup reaches Jira here.
for k in T-50 T-51 T-53 T-54; do q set $k outside_blockers_read=2099-01-01T00:00:00.000Z; done
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

echo "pass: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
