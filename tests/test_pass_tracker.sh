#!/usr/bin/env bash
# suite: pass: tracker (preflight cost, the test lock, PR status and merges, outside blockers, undraft, evidence)
# layer: L3
# pass.mjs with Jira as the tracker: each spawn's preflight cost, a worker quiet under the test lock,
# a done ticket's PR status and merge, blockers outside the batch, a draft leaving draft, a supervised
# batch admitting a held ticket's blocker, and evidence runs that fail the same way. Runs the real
# pass.mjs, queue.mjs, harvest.mjs, batch-state.mjs, briefing.mjs and ticket-facts.mjs with stub claude,
# gh, desk-jira, intake, setup-worktree and spawn-worker (tests/pass_setup.sh). Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
# shellcheck source=pass_setup.sh
. "$(dirname "$0")/pass_setup.sh"
pick_up

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
# A skipped preflight spends nothing, so a fresh ticket with no log yet spawns with none.
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ] && [ "$1" = P-4 ]; then printf '[preflight] %s\n[preflight] skipped: its last pass had this fingerprint\n[preflight] pass\n' "$1"; exit 0; fi
if [ "$3" = preflight ] && [ "$1" = P-2 ]; then printf '[preflight] %s\n[preflight] cost=0.05 turns=2\n  W_IN   BLOCKED  FAIL (wanted OK)\n' "$1"; exit 1; fi
if [ "$3" = preflight ]; then printf '[preflight] %s\n[preflight] cost=0.4321 turns=9\n[preflight] pass\n' "$1"; exit 0; fi
echo "[spawn] ticket=$1"
EOF
q add P-4; q set P-4 state=triaged lane=A branch=fix/P-4
out=$(node "$B/pass.mjs" 2>&1)
check "DS-451 AC1 the spawn line says the preflight was skipped on a matching fingerprint" 'echo "$out" | grep -q "^spawned: P-4 port=.*; preflight skipped on a matching fingerprint"'
check "DS-451 AC1 and no preflight line reaches the log, so nothing reads as an unknown cost" '[ "$(field P-4 state)" = "\"running\"" ] && [ "$(field P-4 log_bytes)" = 0 ] && ! grep -qs desk_preflight "$T/state-p/logs/P-4.log"'
q set P-4 state=done
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

# ---- DS-109: a worker quiet only because its suite runs under the test lock, or waits for it, is not wedged
export DESK_QUEUE="$T/queue-w.json" DESK_AUTOPILOT_STATE="$T/state-w" DESK_LOCK_DIR="$T/locks"
mkdir -p "$T/state-w/logs" "$T/locks/desk-test.lock.d" "$T/locks/desk-test.lock.2.d" "$T/elsewhere"
# W-1 holds a mkdir slot (wrapper and suite); W-2's wrapper waits, polling with sleep; W-3's worktree
# runs only a dev server and its worker, whose prompt quotes the lock commands, while another
# session's suite holds slot 2; W-4's suite holds a flock slot.
cat > "$T/ps.out" <<'EOF'
 4101     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh
 4102  4101 bash tests/run.sh
 4201     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh tsc --cwd . -- pnpm typecheck
 4202  4201 sleep 2
 4301     1 node server.js
 4302     1 claude -p Your ticket is W-3. Run ~/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh, and flock /tmp/desk-test.lock is refused
 4401     1 bash tests/run.sh
 4501     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh test -- bash tests/run.sh
EOF
echo "4101 4102" > "$T/locks/desk-test.lock.d/pid"; echo "4501" > "$T/locks/desk-test.lock.2.d/pid"; echo 4401 > "$T/locks/desk-test.lock.3.pid"
for p in 4101:W-1 4102:W-1 4201:W-2 4202:W-2 4301:W-3 4302:W-3 4401:W-4; do mkdir -p "$T/wt/${p#*:}"; printf 'p%s\ncbash\nn%s\n' "${p%%:*}" "$T/wt/${p#*:}"; done > "$T/lsof.out"
printf 'p4501\ncbash\nn%s\n' "$T/elsewhere" >> "$T/lsof.out"
q init w
for k in W-1 W-2 W-3 W-4; do
  q add "$k"; say "AUTOPILOT_STAGE: 4/9 verify" > "$T/state-w/logs/$k.log"
  q set "$k" state=running lane=A "branch=feat/$k" session_id=live-1 "worktree=$T/wt/$k" idle_passes=5 "log_bytes=$(wc -c < "$T/state-w/logs/$k.log" | tr -d ' ')"
done
q set W-4 "suite_wait_since=$(( ($(date +%s) - 31 * 60) * 1000 ))"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-109 AC1 a quiet worker running its own suite is not stopped, and is quiet running its suite" '[ "$(field W-1 state)" = "\"running\"" ] && echo "$out" | grep -q "W-1: quiet for 6 passes, running its suite" && field W-1 suite_wait_since | grep -qE "^[0-9]+$"'
check "DS-109 AC2 a quiet worker waiting on the test lock is not stopped, and says so" '[ "$(field W-2 state)" = "\"running\"" ] && echo "$out" | grep -q "W-2: quiet for 6 passes, waiting on the test lock"'
check "DS-109 AC3 a quiet worker with no suite and no wait of its own is stopped as wedged" '[ "$(field W-3 state)" = "\"parked\"" ] && field W-3 park | grep -q "wedged — no output for 6 passes, worker stopped"'
check "DS-109 AC4 one exempted past the ceiling is stopped as wedged, naming the ceiling" '[ "$(field W-4 state)" = "\"parked\"" ] && field W-4 park | grep -q "wedged — no output for 6 passes, running its suite for over the 30-minute ceiling"'
# With ps unreadable, a quiet worker is held as one running its suite would be, and the pass says why.
q add W-5; say "AUTOPILOT_STAGE: 4/9 verify" > "$T/state-w/logs/W-5.log"; mkdir -p "$T/wt/W-5"
q set W-5 state=running lane=A branch=feat/W-5 session_id=live-1 "worktree=$T/wt/W-5" idle_passes=5 "log_bytes=$(wc -c < "$T/state-w/logs/W-5.log" | tr -d ' ')"
touch "$T/ps.fail"
out=$(node "$B/pass.mjs" 2>&1)
check "a quiet worker is not stopped while ps cannot be read, and the pass says ps could not be read" '[ "$(field W-5 state)" = "\"running\"" ] && echo "$out" | grep -q "W-5: quiet for 6 passes, ps could not be read, so whether it is running its suite is unknown"'
rm -f "$T/ps.fail" "$T/ps.out" "$T/lsof.out"; export DESK_LOCK_DIR="$T/lockdir"

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

# ---- A failed check keeps the error its job gave, read once per job, and the PR who approved its head
export DESK_QUEUE="$T/queue-ga.json" DESK_AUTOPILOT_STATE="$T/state-ga"
mkdir -p "$T/state-ga/logs"
FIX="$S/fixtures/review-gate-annotations.json"
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr view 310 "*) echo '{"state":"OPEN","headRefOid":"abc","reviews":[{"state":"APPROVED","author":{"login":"old"},"commit":{"oid":"zzz"}},{"state":"APPROVED","author":{"login":"mousedown"},"commit":{"oid":"abc"}},{"state":"COMMENTED","author":{"login":"me"},"commit":{"oid":"abc"}}],"statusCheckRollup":[{"__typename":"CheckRun","name":"Review gate","workflowName":"gate","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-10-23T10:00:00Z","detailsUrl":"https://github.com/acme/widgets/actions/runs/7/job/70"},{"__typename":"CheckRun","name":"tests","workflowName":"ci","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-10-23T10:00:00Z","detailsUrl":"https://github.com/acme/widgets/actions/runs/8/job/80"},{"__typename":"CheckRun","name":"Lint","workflowName":"ci","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-10-23T10:00:00Z","detailsUrl":"https://github.com/acme/widgets/actions/runs/8/job/81"}]}' ;;
  "api repos/"*"/check-runs/70/annotations?per_page=100") jq -c '.protected' "$FIX" ;;
  "api repos/"*"/check-runs/81/annotations?per_page=100") if [ -f "$T/annotations-ok" ]; then echo '[]'; else exit 1; fi ;;
  "run view 8 "*"--job 81 --log-failed") printf 'Lint\tRun\t2026-10-23T10:00:00.000Z ReferenceError: React is not defined\n' ;;
  "run view 7 "*"--job 70 --log-failed") printf 'Review gate\tRun\t2026-10-23T10:00:00.000Z ##[group]Run bash scripts/gate.sh\nReview gate\tRun\t2026-10-23T10:00:00.000Z ##[endgroup]\nReview gate\tRun\t2026-10-23T10:00:01.000Z ##[error]Error: approval required for .github/workflows/ci.yml\n' ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
q init ga
q add GA-1; q set GA-1 state=done result.pr=310
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-499 AC1 a failed check keeps its gate's error line, not GitHub's exit code line" 'field GA-1 pr_status | jq -r ".checks[] | select(.name == \"Review gate\") | .error" | grep -q "^Approval required — 2 protected file(s): "'
check "#831 the error lines keep each failure annotation's path and title beside them, exit-code lines aside" '[ "$(field GA-1 pr_status | jq -c "[.checks[] | select(.name == \"Review gate\") | .error_notes[] | [.path, .title, (.message | startswith(\"Approval required\"))]]")" = "[[\".github\",\"\",true]]" ]'
check "DS-499 a passing check is not read, and one whose annotations could not be read keeps no error" '[ "$(field GA-1 pr_status | jq -c "[.checks[] | select(.name != \"Review gate\") | has(\"error\")]")" = "[false,false]" ] && ! grep -q "check-runs/80" "$T/gh-calls"'
check "DS-499 AC2 who approved the head is recorded, and an approval of an older commit is not" '[ "$(field GA-1 pr_status.approvals | jq -c .)" = "[\"mousedown\"]" ]'
touch "$T/annotations-ok"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-499 the next pass keeps a job's error without reading it again, and reads one it could not" '! grep -q "check-runs/70" "$T/gh-calls" && grep -q "check-runs/81" "$T/gh-calls" && field GA-1 pr_status | jq -r ".checks[] | select(.name == \"Review gate\") | .error" | grep -q "^Approval required"'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-499 a job with no error line is not read again" '! grep -q "check-runs/" "$T/gh-calls"'
check "DS-494 AC1 a job with no annotated error keeps what its failed log names" 'field GA-1 pr_status | jq -r ".checks[] | select(.name == \"Lint\") | .log_errors[0]" | grep -q "^ReferenceError: React is not defined$"'
check "DS-494 and its log is not read again" '! grep -q "log-failed" "$T/gh-calls"'
check "#1640 a failed job with annotated errors keeps every path its log names too, less the echoed step script" '[ "$(field GA-1 pr_status | jq -c ".checks[] | select(.name == \"Review gate\") | [.log_paths, .log_fail_paths, has(\"log_errors\")]")" = "[[\".github/workflows/ci.yml\"],[\".github/workflows/ci.yml\"],false]" ]'

# ---- DS-175: a merge is recorded however the PR was merged, and a missing eta history is built once
ago(){ node -e 'console.log(new Date(Date.now() - Number(process.argv[1]) * 3600e3).toISOString())' "$1"; }
SPAWNED=$(ago 5); MERGED=$(ago 2)
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr view 400 "*) echo '{"state":"MERGED","url":"https://github.com/acme/widgets/pull/400","mergedAt":"$MERGED","statusCheckRollup":[]}' ;;
  "pr view 402 "*) echo '{"state":"MERGED","url":"https://github.com/acme/widgets/pull/402","mergedAt":"$MERGED","headRefName":"feat/co-4-renamed","statusCheckRollup":[]}' ;;
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
check "#1396 AC1 a hand-merged PR with no merge log is recorded as the merge's PR, at its merge time" \
  "[ \"\$(field M-1 merge.pr)\" = 400 ] && [ \"\$(field M-1 merge.at)\" = '\"$MERGED\"' ] && ! echo \"\$out\" | grep -q 'PR missing'"
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-175 AC1 the next pass records nothing again and reads no PR" '[ "$(lines)" = 2 ] && [ ! -s "$T/gh-calls" ] && ! echo "$out" | grep -q "merge recorded"'
# The gap line is printed once per merge, and M-1 is archived by now, so its output alone proves
# nothing: the merge the next pass reads must still name its PR (the line reads merge.pr == null).
check "#1396 AC2 and reports no merge recorded with the PR missing, its merge still naming the PR" \
  '! echo "$out" | grep -q "recorded with the PR missing" && [ "$(field M-1 merge.pr)" = 400 ]'
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
q add CO-4; q set CO-4 branch=feat/co-4; q park CO-4 "which flow?"; node "$B/closeout.mjs" CO-4 --pr 402 >/dev/null
out=$(node "$B/closeout.mjs" CO-1 --pr 400 2>&1)
check "DS-180 AC8 closing out a parked ticket leaves a note for the batch and says so" '[ -f "$T/state-co/closed-out/CO-1.json" ] && echo "$out" | grep -q "^CO-1 is parked in batch co: noted for its orchestrator"'
out=$(node "$B/closeout.mjs" NOPE-1 --how "done" 2>&1)
check "DS-180 AC10 closing out a ticket in no batch writes nothing and says nothing" '[ -z "$out" ] && [ ! -f "$T/state-co/closed-out/NOPE-1.json" ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-180 AC9 the next pass records it done with its PR, and clears the note" \
  '[ "$(field CO-1 state)" = "\"done\"" ] && [ "$(field CO-1 result.pr)" = 400 ] && [ "$(field CO-1 park)" = null ] && [ ! -f "$T/state-co/closed-out/CO-1.json" ] && echo "$out" | grep -q "CO-1: closed out from an interactive session (merged, PR #400)"'
check "#1396 a merge closed out with --pr is recorded naming that PR" '[ "$(field CO-1 merge.pr)" = 400 ] && ! echo "$out" | grep -q "PR missing"'
check "DS-180 AC9 a ticket nobody closed out stays parked" '[ "$(field CO-2 state)" = "\"parked\"" ]'
out=$(node "$B/pass.mjs" 2>&1)
check "a merge closed out with its PR stays done though the PR was opened from another branch" \
  '[ "$(field CO-4 state)" = "\"done\"" ] && [ "$(field CO-4 shipped_pr)" = 402 ] && [ "$(field CO-4 park)" = null ] && ! echo "$out" | grep -q "CO-4.*not its own"'
check "DS-180 a note older than the ticket's place in the queue is stale: dropped, and the ticket stays parked" '[ "$(field CO-3 state)" = "\"parked\"" ] && [ ! -f "$T/state-co/closed-out/CO-3.json" ]'
# DS-757: a close-out whose write is refused (the queue locked past its wait) keeps its note, and the
# next pass records it.
node "$B/closeout.mjs" CO-2 --pr 401 >/dev/null
sleep 30 & holder=$!
mkdir "$DESK_QUEUE.lock"; echo "$holder" > "$DESK_QUEUE.lock/pid"
out=$(DESK_QUEUE_LOCK_WAIT_MS=200 node "$B/pass.mjs" 2>&1)
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null; rm -rf "$DESK_QUEUE.lock"
check "DS-757 a close-out the queue refused keeps its note and is not reported done" \
  '[ "$(field CO-2 state)" = "\"parked\"" ] && [ -f "$T/state-co/closed-out/CO-2.json" ] && echo "$out" | grep -q "CO-2: queue write refused, not recorded" && ! echo "$out" | grep -q "CO-2: closed out from"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-757 and the next pass records it done and clears the note" \
  '[ "$(field CO-2 state)" = "\"done\"" ] && [ "$(field CO-2 result.pr)" = 401 ] && [ ! -f "$T/state-co/closed-out/CO-2.json" ]'

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
# A search answers `key in (...)` with each key's $T/jira/<KEY>.json that exists, as Jira leaves out an
# issue it does not show.
cat > "$T/jira-search.mjs" <<'EOF'
import { existsSync, readFileSync } from 'node:fs';
const [dir, jql] = process.argv.slice(2);
const keys = (/key in \(([^)]*)\)/.exec(jql)?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean);
const issues = keys.filter((k) => existsSync(`${dir}/${k}.json`)).map((k) => ({ key: k, ...JSON.parse(readFileSync(`${dir}/${k}.json`, 'utf8')) }));
console.log(JSON.stringify({ issues }));
EOF
cat > "$T/stub/desk-jira" <<EOF
#!/bin/sh
echo "\$*" >> "$T/jira-calls"
[ -f "$T/jira-down" ] && { echo "jira: 503 Service Unavailable" >&2; exit 1; }
[ -f "$T/jira-blockers-down" ] && case "\$*" in *--fields=resolution*) echo "jira: 503 Service Unavailable" >&2; exit 1 ;; esac
[ "\$1" = get ] && cat "$T/jira/\$2.json"
[ "\$1" = search ] && exec node "$T/jira-search.mjs" "$T/jira" "\$2"
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
pass_rec(){ jq -c --arg p "$1" "$JQ_AT"' .pass | at($p)' "$DESK_QUEUE"; }
q init j
q add J-1; q set J-1 state=triaged open_questions=1
q add J-2; q set J-2 state=triaged open_questions=1
q add J-4; q set J-4 state=done result.pr=600
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-9","category":"new"},{"key":"J-2","category":"new"}]}' > "$T/state-j/triage/J-1.json"
printf '%s\n' '{"epic":null,"blockers":[]}' > "$T/state-j/triage/J-2.json"
blocked indeterminate
printf '%s\n' '{"fields":{"assignee":null}}' > "$T/jira/X-9.json"
printf '%s\n' '{"fields":{"issuelinks":[]}}' > "$T/jira/J-2.json"
: > "$T/jira-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC1 a draft PR records isDraft, reviewDecision and mergeable as GitHub reports them" \
  '[ "$(field J-4 pr_status | jq -c "[.isDraft, .reviewDecision, .mergeable]")" = "[true,\"REVIEW_REQUIRED\",\"MERGEABLE\"]" ]'
check "DS-221 AC2 (DS-599) an open blocker outside the batch is recorded with its status category and assignee, read again from Jira; one inside the batch is not" \
  '[ "$(field J-1 outside_blockers | jq -c .)" = "[{\"key\":\"X-9\",\"category\":\"indeterminate\",\"assignee\":null}]" ] && [ "$(cat "$T/jira-calls")" = "$(printf "search key in (J-1, J-2) 2 --fields=issuelinks,parent --json\nsearch key in (X-9, J-2) 2 --fields=resolution,resolutiondate --json")" ] || { echo "     calls: $(tr "\n" "," < "$T/jira-calls")"; false; }'
check "DS-221 a ticket with no outside blockers records none" '[ "$(field J-2 outside_blockers)" = "[]" ]'
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
  '[ "$(field J-1 outside_blockers | jq -c "[.[].key]")" = "[\"X-9\"]" ] && echo "$out" | grep -q "blocker links: J-1 not read, holds kept as they were"'
rm -f "$T/jira-down"; q set J-1 outside_blockers_read=null
out=$(node "$B/pass.mjs" 2>&1)
check "DS-221 AC3 a blocker now Done is no longer among the outside blockers" '[ "$(field J-1 outside_blockers)" = "[]" ]'
: > "$T/jira-calls"; q set J-1 outside_blockers_read=null; out=$(node "$B/pass.mjs" 2>&1)
check "DS-656 a queued ticket left with no outside blockers is still read from Jira, for links added since" 'grep -q "^search key in (.*J-1[,)]" "$T/jira-calls"'
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
  q set J-7 outside_blockers_read=null outside_read=null; }
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
# A ticket plan-batch held behind a blocker in no batch that triage found it needs is
# released the same way, once the blocker is Done and on the base.
{ cat "$T/config.md"; printf '\n## 1. Who you are\n| Field | Value |\n|---|---|\n| Jira display name | `Me` |\n\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `[A-Z]+-[0-9]+` |\n'; } > "$T/config-pb.md"
printf '%s\n' '{"ticket":"J-7","type":"Task","lane":"A","size":"S","summary":"s","branch":"feat/J-7","change_kind":"surface","files_in_scope":["src/j7"],"unknowns":[],"epic":null,"blockers":[{"key":"X-7","category":"indeterminate"}],"blocker_needs":{"X-7":{"needs":true,"why":"builds what it calls"}}}' > "$T/state-j/triage/J-7.json"
x7 indeterminate OPEN; out=$(AUTOPILOT_WRITE_QUEUE=1 DESK_CONFIG="$T/config-pb.md" node "$B/plan-batch.mjs" J-7 2>&1); rc=$?
check "DS-598 AC3: plan-batch holds a ticket behind a needed blocker in no batch, with no question" \
  '[ $rc -eq 0 ] && [ "$(field J-7 state)" = "\"parked\"" ] && [ "$(field J-7 held_outside)" = "\"X-7\"" ] && [ "$(field J-7 open_questions)" = 0 ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-598 AC5: while the blocker is in progress the ticket stays held, and not STUCK" '[ "$(field J-7 state)" = "\"parked\"" ] && ! echo "$out" | grep -q "J-7: STUCK"'
x7 'done' MERGED; out=$(node "$B/pass.mjs" 2>&1)
check "DS-598 AC5: once the blocker is Done and on the base, the pass releases it and it can start" \
  '[ "$(field J-7 state)" = "\"triaged\"" ] && [ "$(field J-7 held_outside)" = null ] && echo "$out" | grep -q "outside hold: J-7: X-7 Done and on main; RELEASED"'
# A person's step in no batch has no PR: the first pass that reads it Done in Jira releases the ticket held behind it.
q set J-7 state=parked held_by=X-7 held_outside=X-7 'park={"question":"held by orchestrator: blocked by X-7 — starts once X-7 is Done in Jira"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-7","category":"done","labels":["ben-input"]}]}' > "$T/state-j/triage/J-7.json"
printf '[]\n' > "$T/prs-x7.json"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-685 AC4: a person's step in no batch read Done releases the ticket waiting to start on it" \
  '[ "$(field J-7 state)" = "\"triaged\"" ] && [ "$(field J-7 held_outside)" = null ] && echo "$out" | grep -q "outside hold: J-7: X-7 Done and on main; RELEASED"'
# A blocker whose Jira Repository is another configured repo lands there, never on this base: the first
# pass that reads it Done in Jira releases the ticket, with no PR of its on main here.
mkdir -p "$HOME/.config/desk/repos/acme__web"; git init -q -b main "$T/web"; git -C "$T/web" commit -q --allow-empty -m init
printf '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/web` |\n| Default branch | `main` |\n\n## 2. Paths\n| Field | Value |\n|---|---|\n| Primary repo root | `%s` |\n' "$T/web" > "$HOME/.config/desk/repos/acme__web/config.md"
printf '%s\n' '{"ticket":"X-7","repository":"web"}' > "$T/state-j/triage/X-7.json"
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-7","category":"indeterminate"}]}' > "$T/state-j/triage/J-7.json"
q set J-7 state=parked held_by=X-7 held_outside=X-7 'park={"question":"held by orchestrator: blocked by X-7 — starts once X-7 is Done in Jira"}'
x7 indeterminate OPEN; out=$(node "$B/pass.mjs" 2>&1)
check "DS-591 AC3: a blocker in another repo that is not Done keeps the ticket held" '[ "$(field J-7 state)" = "\"parked\"" ] && [ "$(field J-7 held_outside)" = "\"X-7\"" ] || { echo "     J-7: $(field J-7 state) $(field J-7 held_outside) $(jq -c .blockers "$T/state-j/triage/J-7.json")"; false; }'
x7 'done' OPEN; out=$(node "$B/pass.mjs" 2>&1)
check "DS-591 AC3: once the pass reads that blocker Done in Jira it releases the ticket, though nothing landed on main" \
  '[ "$(field J-7 state)" = "\"triaged\"" ] && [ "$(field J-7 held_outside)" = null ] && echo "$out" | grep -q "outside hold: J-7: X-7 Done in Jira, in another repo; RELEASED"'
rm -rf "$HOME/.config/desk/repos/acme__web" "$T/web" "$T/state-j/triage/X-7.json"
q drop J-7
# A link to the ticket's own epic, the batch's or its Jira parent, never holds it: an epic is Done only
# once its children are. The record here predates ticket-facts.mjs leaving such a link out.
blocked_by(){ printf '{"fields":{"issuelinks":[{"type":{"inward":"is blocked by"},"inwardIssue":{"key":"%s","fields":{"status":{"statusCategory":{"key":"indeterminate"}}}}}]}}\n' "$2" > "$T/jira/$1.json"; }
q set-batch epic=E-1
q add J-9; q set J-9 state=parked open_questions=1 held_by=E-1 held_outside=E-1 'park={"question":"held by orchestrator: blocked by E-1 — starts once their PRs merge"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"E-1","category":"indeterminate"}]}' > "$T/state-j/triage/J-9.json"
blocked_by J-9 E-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-541 AC1 a ticket linked as blocked by its batch's epic is not held, and its outside blockers do not list the epic" \
  '[ "$(field J-9 held_by)" = null ] && [ "$(field J-9 held_outside)" = null ] && [ "$(field J-9 park)" = null ] && [ "$(field J-9 outside_blockers)" = "[]" ] && echo "$out" | grep -q "outside hold: J-9: E-1 its own epic, so its link is ignored; RELEASED"'
check "DS-541 AC1 the pass prints one line saying the ticket is linked as blocked by its own epic and the link is ignored" \
  '[ "$(echo "$out" | grep -c "lint: J-9 is linked as blocked by its own epic E-1, .*: the link is ignored")" = 1 ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-541 AC1 the next pass does not say it again" '! echo "$out" | grep -q "J-9 is linked as blocked by its own epic"'
node "$B/ticket-facts.mjs" --blockers J-9 >/dev/null 2>&1
check "DS-541 a re-read of the ticket's blockers leaves its batch's epic out of them, kept as own_epic_blockers" \
  '[ "$(jq -c "[.blockers, .own_epic_blockers]" "$T/state-j/triage/J-9.json")" = "[[],[\"E-1\"]]" ]'
printf '%s\n' '{"fields":{"issuelinks":[],"priority":{"name":"P1"}}}' > "$T/jira/J-9.json"
node "$B/ticket-facts.mjs" --blockers J-9 >/dev/null 2>&1
check "#1624 a re-read of the ticket's blockers records its tracker priority as Jira has it now" '[ "$(jq -r .priority "$T/state-j/triage/J-9.json")" = P1 ]'
printf '%s\n' '{"fields":{"issuelinks":[]}}' > "$T/jira/J-9.json"
node "$B/ticket-facts.mjs" --blockers J-9 >/dev/null 2>&1
check "#1624 a search that returns no priority field leaves the recorded priority as it was" '[ "$(jq -r .priority "$T/state-j/triage/J-9.json")" = P1 ]'
q set-batch epic=null; q drop J-9
q add J-10; q set J-10 state=parked open_questions=1 held_by=E-2 held_outside=E-2 'park={"question":"held by orchestrator: blocked by E-2 — starts once their PRs merge"}'
printf '%s\n' '{"epic":{"key":"E-2","summary":"the epic"},"blockers":[{"key":"E-2","category":"indeterminate"}]}' > "$T/state-j/triage/J-10.json"
blocked_by J-10 E-2
q add J-11; q set J-11 state=parked open_questions=1 held_by=X-11 held_outside=X-11 'park={"question":"held by orchestrator: blocked by X-11 — starts once their PRs merge"}'
printf '%s\n' '{"epic":{"key":"E-2","summary":"the epic"},"blockers":[{"key":"X-11","category":"indeterminate"}]}' > "$T/state-j/triage/J-11.json"
blocked_by J-11 X-11
out=$(node "$B/pass.mjs" 2>&1)
check "DS-541 AC2 in the standing batch, a ticket linked as blocked by its Jira parent epic is not held behind it" \
  '[ "$(field J-10 held_outside)" = null ] && [ "$(field J-10 outside_blockers)" = "[]" ] && echo "$out" | grep -q "lint: J-10 is linked as blocked by its own epic E-2"'
check "DS-541 AC3 a ticket blocked by an open ticket outside the batch that is not its epic is still held behind it" \
  '[ "$(field J-11 state)" = "\"parked\"" ] && [ "$(field J-11 held_outside)" = "\"X-11\"" ] && [ "$(field J-11 outside_blockers | jq -c "[.[].key]")" = "[\"X-11\"]" ] && ! echo "$out" | grep -q "J-11 is linked as blocked by its own epic"'
q drop J-10; q drop J-11
# A blocker in no batch closed as Won't Do never lands, so its link is raised once as a triage
# item (wont_do_link) rather than held in silence; removing the link lifts the hold and clears it.
# links <KEY> <BLOCKER> <category> <status> [<BLOCKER2> ...] writes the ticket's links; none with no blocker.
links(){ k=$1; shift; s=''; while [ $# -ge 3 ]; do s="$s${s:+,}{\"type\":{\"inward\":\"is blocked by\"},\"inwardIssue\":{\"key\":\"$1\",\"fields\":{\"status\":{\"name\":\"$3\",\"statusCategory\":{\"key\":\"$2\"}}}}}"; shift 3; done
  printf '{"fields":{"issuelinks":[%s]}}\n' "$s" > "$T/jira/$k.json"; q set "$k" outside_blockers_read=null outside_read=null; }
resolved(){ printf '{"fields":{"assignee":null,"resolution":{"name":"%s"}}}\n' "$2" > "$T/jira/$1.json"; }
q add J-13; q set J-13 state=parked held_by=X-13 held_outside=X-13 'park={"question":"held by orchestrator: blocked by X-13 — starts once X-13 is Done and on the base"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-13","category":"indeterminate"}]}' > "$T/state-j/triage/J-13.json"
resolved X-13 "Won't Do"; links J-13 X-13 'done' "Won't Do"
: > "$T/jira-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 AC1 a blocker in no batch closed as Won't Do is raised once as a triage item naming both tickets, and the hold stays" \
  '[ "$(echo "$out" | grep -c "triage: J-13 is blocked by X-13, closed without landing (Won'"'"'t Do): is the link still right?")" = 1 ] && [ "$(field J-13 wont_do_link)" = "\"X-13\"" ] && [ "$(field J-13 held_outside)" = "\"X-13\"" ] && [ "$(field J-13 state)" = "\"parked\"" ]'
check "DS-717 AC1 the blocker record keeps the resolution read from it" \
  '[ "$(jq -c ".blockers[0].resolution" "$T/state-j/triage/J-13.json")" = "\"Won'"'"'t Do\"" ] && grep -q "^search key in (.*X-13[,)].* --fields=resolution" "$T/jira-calls"'
links J-13 X-13 'done' "Won't Do"; : > "$T/jira-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 AC2 the next pass raises no second item for that link, and does not read the resolution again" \
  '! echo "$out" | grep -q "triage: J-13" && [ "$(field J-13 wont_do_link)" = "\"X-13\"" ] && grep -q "^search key in (.*J-13[,)]" "$T/jira-calls" && ! grep -q "X-13" "$T/jira-calls"'
links J-13; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 AC3 once the blockers no longer list it, the hold lifts and the item clears" \
  '[ "$(field J-13 state)" = "\"triaged\"" ] && [ "$(field J-13 held_outside)" = null ] && [ "$(field J-13 wont_do_link)" = null ] && echo "$out" | grep -q "outside hold: J-13: X-13 no longer linked as a blocker; RELEASED"'
q drop J-13
q add J-7; q set J-7 state=parked held_by=X-7 held_outside=X-7 'park={"question":"held by orchestrator: blocked by X-7 — starts once X-7 is Done and on the base"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-7","category":"indeterminate"}]}' > "$T/state-j/triage/J-7.json"
resolved X-7 Done; x7 'done' MERGED; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 AC4 a blocker in no batch Done as Done and on the base lifts the hold as before, and raises no item" \
  '[ "$(field J-7 state)" = "\"triaged\"" ] && [ "$(field J-7 wont_do_link)" = null ] && echo "$out" | grep -q "outside hold: J-7: X-7 Done and on main; RELEASED" && ! echo "$out" | grep -q "triage: J-7"'
q drop J-7
# A lane C park held behind a blocker in no batch loses only the hold once it is Done and on the base.
q add J-715; q set J-715 state=parked lane=C held_by=X-7 held_outside=X-7 'park={"question":"lane C — the plan needs agreeing"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-7","category":"done","resolution":"Done"}]}' > "$T/state-j/triage/J-715.json"
links J-715 X-7 'done' Done; x7 'done' OPEN; out=$(node "$B/pass.mjs" 2>&1)
check "DS-715 AC4 a lane C park behind a blocker in no batch Done whose PR has not merged keeps the hold" \
  '[ "$(field J-715 held_by)" = "\"X-7\"" ] && [ "$(field J-715 held_outside)" = "\"X-7\"" ] && [ "$(field J-715 state)" = "\"parked\"" ] && ! echo "$out" | grep -q "outside hold: J-715"'
links J-715 X-7 'done' Done; x7 'done' MERGED; out=$(node "$B/pass.mjs" 2>&1)
check "DS-715 AC6 once that blocker is Done and on the base, the hold leaves held_by and held_outside and the lane C park stays" \
  '[ "$(field J-715 held_by)" = null ] && [ "$(field J-715 held_outside)" = null ] && [ "$(field J-715 state)" = "\"parked\"" ] && [ "$(field J-715 park.question)" = "\"lane C — the plan needs agreeing\"" ] && echo "$out" | grep -q "outside hold: J-715: X-7 Done and on main; hold lifted, and it stays parked: lane C — the plan needs agreeing" || { echo "     J-715: $(field J-715 held_by) $(field J-715 held_outside) $(field J-715 state); $(echo "$out" | grep "J-715")"; false; }'
check "DS-715 AC6 and the ticket is not sent to a worker" '! echo "$out" | grep -q "J-715 port=" && ! echo "$out" | grep -q "J-715.*RELEASED"'
q drop J-715; rm -f "$T/jira/X-7.json"
q add J-15; q set J-15 state=parked lane=C 'park={"question":"lane C: the plan needs agreeing"}' 'outside_blockers=[{"key":"X-15","category":"indeterminate"}]'
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-15","category":"indeterminate"}]}' > "$T/state-j/triage/J-15.json"
resolved X-15 Duplicate; links J-15 X-15 'done' Closed; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 AC5 a lane C park blocked by a ticket in no batch closed as Duplicate raises one item, and the park stays" \
  '[ "$(echo "$out" | grep -c "triage: J-15 is blocked by X-15, closed without landing (Duplicate)")" = 1 ] && [ "$(field J-15 wont_do_link)" = "\"X-15\"" ] && [ "$(field J-15 state)" = "\"parked\"" ] && [ "$(field J-15 park.question)" = "\"lane C: the plan needs agreeing\"" ]'
links J-15 X-15 'done' Closed; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 AC5 with no outside blocker left open, it is still read while the link stands, and not raised again" \
  '[ "$(field J-15 outside_blockers)" = "[]" ] && [ "$(field J-15 outside_blockers_read)" != null ] && ! echo "$out" | grep -q "triage: J-15"'
q drop J-15
# A record that read its blocker Done before resolutions were read has none: it is read again once.
q add J-16; q set J-16 state=parked held_by=X-16 held_outside=X-16 'outside_blockers=[]' 'park={"question":"held by orchestrator: blocked by X-16 — starts once X-16 is Done and on the base"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-16","category":"done"}]}' > "$T/state-j/triage/J-16.json"
resolved X-16 "Won't Do"; links J-16 X-16 'done' "Won't Do"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 a blocker read Done before its resolution was is read again, raised once, and the hold stays" \
  '[ "$(echo "$out" | grep -c "triage: J-16 is blocked by X-16, closed without landing")" = 1 ] && [ "$(field J-16 held_outside)" = "\"X-16\"" ] && [ "$(jq -c ".blockers[0].resolution" "$T/state-j/triage/J-16.json")" = "\"Won'"'"'t Do\"" ]'
q drop J-16
# A Blocks link added in Jira after a ticket was admitted is read by the next pass, before it
# spawns, and held as intake would have held it; a started ticket only has the late link said.
no_links(){ printf '%s\n' '{"epic":null,"blockers":[]}' > "$T/state-j/triage/$1.json"; }
q add J-61; q set J-61 state=parked 'park={"question":"which colour should it be?"}' outside_blockers_read=2099-01-01T00:00:00.000Z
q add J-60; q set J-60 state=triaged; no_links J-60; links J-60 J-61 new Open
out=$(node "$B/pass.mjs" 2>&1)
check "DS-656 AC1 a link to an open ticket in the batch added after admission holds the queued ticket behind it, and it is not spawned" \
  '[ "$(field J-60 held_by)" = "\"J-61\"" ] && [ "$(field J-60 state)" = "\"parked\"" ] && [ "$(field J-60 held_outside)" = null ] && echo "$out" | grep -q "blocker link: J-60: newly linked as blocked by J-61: HELD behind J-61" || { echo "     J-60: $(field J-60 state) $(field J-60 held_by); $(echo "$out" | grep "J-60")"; false; }'
q drop J-60
q add J-62; q set J-62 state=triaged; no_links J-62; links J-62 X-62 new Open
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-656 AC2 a link to an open ticket in no batch holds it in held_by and held_outside, and the report names the hold" \
  '[ "$(field J-62 held_by)" = "\"X-62\"" ] && [ "$(field J-62 held_outside)" = "\"X-62\"" ] && echo "$out" | grep -q "blocker link: J-62: newly linked as blocked by X-62 (X-62 in no batch, lifted once Done and on main): HELD behind X-62"'
q drop J-62
q add J-63; q set J-63 state=parked worktree="$T/wt-j63" 'park={"question":"which size should it be?"}'; no_links J-63; links J-63 J-61 new Open
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-656 AC3 a link added once the worker started leaves held_by as it was and says it arrived late" \
  '[ "$(field J-63 held_by)" = null ] && [ "$(field J-63 park.question)" = "\"which size should it be?\"" ] && echo "$out" | grep -q "blocker link: J-63: linked as blocked by J-61 after its worker started: no hold added"'
q drop J-63
q add J-64; q set J-64 state=triaged; no_links J-64; links J-64 X-64 'done' Done; resolved X-64 Done
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-656 AC4 a link to a blocker already Done and on the base adds no hold" \
  '[ "$(field J-64 held_by)" = null ] && [ "$(field J-64 state)" = "\"triaged\"" ] && ! echo "$out" | grep -q "blocker link: J-64"'
q drop J-64; rm -f "$T/jira/X-64.json"
q add J-65; q set J-65 state=triaged; no_links J-65
q add J-66; q set J-66 state=parked held_by=J-65 'park={"question":"held by orchestrator: blocked by J-65 — starts once their PRs merge"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"J-65","category":"new"}]}' > "$T/state-j/triage/J-66.json"
links J-66 J-65 new Open; links J-65 J-66 new Open
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-656 AC5 a link that would hold a ticket behind one already held behind it adds no hold, and the report names the cycle" \
  '[ "$(field J-65 held_by)" = null ] && [ "$(field J-65 state)" = "\"triaged\"" ] && echo "$out" | grep -q "blocker link: J-65: linked as blocked by J-66, which waits behind it: not held, as that is a cycle"'
check "DS-656 AC5 the ticket already held keeps its hold, its link unchanged" '[ "$(field J-66 held_by)" = "\"J-65\"" ] && ! echo "$out" | grep -q "blocker link: J-66"'
q drop J-65; q drop J-66
q add J-67; q set J-67 state=parked held_by=J-61 'park={"question":"held by orchestrator: blocked by J-61 — starts once their PRs merge"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"J-61","category":"new"}]}' > "$T/state-j/triage/J-67.json"
links J-67
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-656 AC6 a link removed from an in-batch hold keeps the hold and says the link went" \
  '[ "$(field J-67 held_by)" = "\"J-61\"" ] && [ "$(field J-67 state)" = "\"parked\"" ] && echo "$out" | grep -q "blocker link: J-67: no longer linked as blocked by J-61, and still held behind it"'
q drop J-67
q add J-69; q set J-69 state=triaged 'links_seen=[]'; links J-69 J-61 new Open
printf '%s\n' '{"epic":null,"blockers":[{"key":"J-61","category":"new"}]}' > "$T/state-j/triage/J-69.json"
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-656 a link a cut-off read already wrote into the triage record still holds the queued ticket, and is recorded as seen" \
  '[ "$(field J-69 held_by)" = "\"J-61\"" ] && [ "$(field J-69 links_seen | jq -c .)" = "[\"J-61\"]" ] && echo "$out" | grep -q "blocker link: J-69: newly linked as blocked by J-61: HELD behind J-61"'
q drop J-69
q add J-70; q set J-70 state=triaged; links J-70 J-61 new Open
printf '%s\n' '{"epic":null,"blockers":[{"key":"J-61","category":"new"}]}' > "$T/state-j/triage/J-70.json"
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-656 a ticket released by hand from a hold its record still links is not held again on its first read" \
  '[ "$(field J-70 held_by)" = null ] && [ "$(field J-70 links_seen | jq -c .)" = "[\"J-61\"]" ] && ! echo "$out" | grep -q "blocker link: J-70"'
q drop J-70
q add J-68; q set J-68 state=triaged; no_links J-68; links J-68 J-61 new Open; touch "$T/jira-down"
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-656 AC7 a blockers read that fails leaves held_by as it was and says when it is tried again" \
  '[ "$(field J-68 held_by)" = null ] && [ "$(field J-68 state)" = "\"triaged\"" ] && echo "$out" | grep -q "blocker links: J-68 not read, holds kept as they were and tried again in [0-9]* minutes"'
rm -f "$T/jira-down"; q drop J-68; q drop J-61
# Every due ticket's links are read in one Jira search, a lane C park gains a hold beside its
# park, and a link no hold settles (a dropped sibling, one closed as Won't Do, a cycle) is raised once.
batch718="J-100 J-101 J-102 J-103 J-104 J-105 J-106 J-107 J-108 J-109 J-110 J-111 J-112 J-113"
for k in $batch718; do q add "$k"; q set "$k" state=triaged; no_links "$k"; links "$k"; done
: > "$T/jira-calls"; out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC1 a pass reads the links of 14 queued tickets in one Jira search" \
  '[ "$(grep -c -- "--fields=issuelinks" "$T/jira-calls")" = 1 ] && ! grep -q "^get " "$T/jira-calls" && [ "$(for k in $batch718; do grep -q "^search key in (.*$k[,)].*--fields=issuelinks" "$T/jira-calls" || echo "$k"; done)" = "" ] || { echo "     calls: $(tr "\n" "," < "$T/jira-calls")"; false; }'
for k in $batch718; do q drop "$k"; done
q add J-81; q set J-81 state=triaged outside_blockers_read=2099-01-01T00:00:00.000Z
q add J-80; q set J-80 state=parked lane=C 'park={"question":"lane C — the plan needs agreeing"}'; no_links J-80; links J-80 J-81 new Open
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC2 a lane C park with no holds newly linked as blocked by an open sibling is held behind it, its park unchanged" \
  '[ "$(field J-80 held_by)" = "\"J-81\"" ] && [ "$(field J-80 state)" = "\"parked\"" ] && [ "$(field J-80 park.question)" = "\"lane C — the plan needs agreeing\"" ] && echo "$out" | grep -q "blocker link: J-80: newly linked as blocked by J-81: held behind J-81, and it stays parked: lane C" || { echo "     J-80: $(field J-80 state) $(field J-80 held_by); $(echo "$out" | grep "J-80")"; false; }'
q drop J-80
q add J-82; q set J-82 state=parked held_by=J-83 'park={"question":"held by orchestrator: blocked by J-83 — starts once their PRs merge"}' outside_blockers_read=2099-01-01T00:00:00.000Z
q add J-83; q drop J-83
out=$(node "$B/pass.mjs" 2>&1)
check "DS-718 AC3 a ticket held behind a sibling dropped from the batch raises one triage item asking whether the link is still right" \
  '[ "$(echo "$out" | grep -c "triage: J-82 is held behind J-83, no longer in this batch, so nothing releases it: is the link still right?")" = 1 ] && [ "$(field J-82 dropped_link)" = "\"J-83\"" ] && [ "$(field J-82 state)" = "\"parked\"" ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-718 AC4 the next pass raises no second item for that link" '! echo "$out" | grep -q "triage: J-82" && [ "$(field J-82 dropped_link)" = "\"J-83\"" ]'
q set J-82 held_by=null state=triaged park=null; out=$(node "$B/pass.mjs" 2>&1)
check "DS-718 once nothing holds it behind the dropped sibling, the marker clears" '[ "$(field J-82 dropped_link)" = null ]'
q drop J-82
q add J-85; q set J-85 state=triaged outside_blockers_read=2099-01-01T00:00:00.000Z
q add J-84; q set J-84 state=parked held_by=J-85 'park={"question":"held by orchestrator: blocked by J-85 — starts once their PRs merge"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"J-85","category":"new"}]}' > "$T/state-j/triage/J-84.json"
resolved J-85 "Won't Do"; links J-84 J-85 'done' "Won't Do"
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC5 a sibling in the batch closed as Won't Do with its PR unmerged raises one triage item, and the hold stays" \
  '[ "$(echo "$out" | grep -c "triage: J-84 is blocked by J-85, closed without landing (Won'"'"'t Do): is the link still right?")" = 1 ] && [ "$(field J-84 wont_do_link)" = "\"J-85\"" ] && [ "$(field J-84 held_by)" = "\"J-85\"" ] || { echo "     J-84: $(field J-84 held_by) $(field J-84 wont_do_link); $(echo "$out" | grep "J-84")"; false; }'
links J-84 J-85 'done' "Won't Do"; out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC5 the next pass raises it no second time" '! echo "$out" | grep -q "triage: J-84" && [ "$(field J-84 wont_do_link)" = "\"J-85\"" ]'
q drop J-84; q drop J-85; rm -f "$T/jira/J-85.json"
q add J-86; q set J-86 state=triaged; no_links J-86
q add J-87; q set J-87 state=triaged; no_links J-87
links J-86 J-87 new Open; links J-87 J-86 new Open
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC6 two queued tickets now linked as blocking each other keep DS-656's line and raise one triage item naming the cycle" \
  '[ "$(echo "$out" | grep -c "blocker link: J-87: linked as blocked by J-86, which waits behind it: not held, as that is a cycle")" = 1 ] && [ "$(echo "$out" | grep -c "^triage: .*J-8[67] ↔ J-8[67] block each other in Jira, so neither is released")" = 1 ] && [ "$(field J-87 cycle_link)" = "\"J-86\"" ] && [ "$(field J-86 cycle_link)" = null ] || { echo "     $(echo "$out" | grep "J-8[67]")"; false; }'
check "DS-718 AC6 neither ticket is released: the one held stays held, the other is not held" \
  '[ "$(field J-86 held_by)" = "\"J-87\"" ] && [ "$(field J-86 state)" = "\"parked\"" ] && [ "$(field J-87 held_by)" = null ]'
check "DS-718 AC6 neither ticket is released: the one not held does not spawn while the cycle stands" \
  'echo "$out" | grep -q "not spawning J-87 (linked in Jira as blocked by J-86, which is held behind it): which comes first is asked in needs-you"'
# links_seen emptied, so the next read sees J-86 as newly linked again and only cycle_link stops a second item.
links J-86 J-87 new Open; links J-87 J-86 new Open; q set J-87 'links_seen=[]'; out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC6 the next pass raises no second item for the cycle" 'echo "$out" | grep -q "blocker link: J-87: linked as blocked by J-86, which waits behind it" && ! echo "$out" | grep -q "block each other" && [ "$(field J-87 cycle_link)" = "\"J-86\"" ]'
links J-87; out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC6 once the link is gone the cycle clears" '[ "$(field J-87 cycle_link)" = null ]'
q drop J-86; q drop J-87
q add J-88; q set J-88 state=parked held_by=J-81 'park={"question":"held by orchestrator: blocked by J-81 — starts once their PRs merge"}'
printf '%s\n' '{"epic":null,"blockers":[{"key":"J-81","category":"new"}]}' > "$T/state-j/triage/J-88.json"
q add J-89; q set J-89 state=parked lane=D 'park={"question":"lane D — the design needs a canvas"}'; no_links J-89
links J-88; links J-89 J-81 new Open; touch "$T/jira-down"
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC7 a search that fails keeps every hold and says when it is tried again" \
  '[ "$(field J-88 held_by)" = "\"J-81\"" ] && [ "$(field J-88 state)" = "\"parked\"" ] && [ "$(field J-89 held_by)" = null ] && echo "$out" | grep -q "blocker links: .*J-88.* not read, holds kept as they were and tried again in [0-9]* minutes" && echo "$out" | grep -q "blocker links: .*J-89.* not read"'
rm -f "$T/jira-down"; touch "$T/jira-blockers-down"; q set J-88 outside_blockers_read=null; q set J-89 outside_blockers_read=null
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-718 AC7 the blockers' search failing keeps every hold the same way" \
  '[ "$(field J-89 held_by)" = null ] && echo "$out" | grep -q "blocker links: .*J-89.* not read, holds kept as they were and tried again in [0-9]* minutes: .*blockers. search failed" || { echo "     $(echo "$out" | grep "J-89")"; false; }'
rm -f "$T/jira-blockers-down"; q drop J-88; q drop J-89; q drop J-81
# A done ticket whose PR waits on the person's step (merge_after) is read from Jira again, and the step
# is lifted once Jira has it Done.
ops1(){ printf '{"fields":{"issuelinks":[{"type":{"inward":"is blocked by"},"inwardIssue":{"key":"OPS-1","fields":{"summary":"Apply the migration","issuetype":{"name":"Task"},"status":{"statusCategory":{"key":"%s"}}}}}]}}\n' "$1" > "$T/jira/J-8.json"
  q set J-8 outside_blockers_read=null; }
q add J-8; q set J-8 state=done result.pr=600 merge_after=OPS-1
printf '%s\n' '{"epic":null,"blockers":[{"key":"OPS-1","category":"new","type":"Task","summary":"Apply the migration"}]}' > "$T/state-j/triage/J-8.json"
ops1 new; out=$(node "$B/pass.mjs" 2>&1)
check "DS-407 AC2 while the person's step is open, the done ticket's merge stays held" '[ "$(field J-8 merge_after)" = "\"OPS-1\"" ] && ! echo "$out" | grep -q "merge hold: J-8"'
ops1 'done'; out=$(node "$B/pass.mjs" 2>&1)
check "DS-407 AC3 once Jira has the step Done, the next pass lifts the hold with no answer" '[ "$(field J-8 merge_after)" = null ] && echo "$out" | grep -q "merge hold: J-8: OPS-1 Done; free to merge"'
# A step admitted to this batch since is still read from Jira through the ticket waiting on it.
q set J-8 merge_after=OPS-1; q add OPS-1
ops1 new; out=$(node "$B/pass.mjs" 2>&1)
check "DS-407 a step that joined the batch still holds the merge while it is open" '[ "$(field J-8 merge_after)" = "\"OPS-1\"" ]'
ops1 'done'; out=$(node "$B/pass.mjs" 2>&1)
check "DS-407 a step that joined the batch is lifted once Jira has it Done" '[ "$(field J-8 merge_after)" = null ] && echo "$out" | grep -q "merge hold: J-8: OPS-1 Done; free to merge"'
q drop OPS-1; q drop J-8
# A blocker triage called needed only to merge is another ticket's code, not a step: Done in Jira lifts
# its merge gate only once its PR is on the base, as an outside hold is lifted.
x7gate(){ printf '{"fields":{"issuelinks":[{"type":{"inward":"is blocked by"},"inwardIssue":{"key":"X-7","fields":{"summary":"Ship the flag","issuetype":{"name":"Story"},"status":{"statusCategory":{"key":"%s"}}}}}]}}\n' "$1" > "$T/jira/J-12.json"
  printf '[{"number":70,"state":"%s","title":"fix(x): X-7 a thing","headRefName":"fix/X-7-thing","baseRefName":"main","mergeCommit":null}]\n' "$2" > "$T/prs-x7.json"
  q set J-12 outside_blockers_read=null; }
q add J-12; q set J-12 state=done result.pr=612 merge_after=X-7
printf '%s\n' '{"epic":null,"blockers":[{"key":"X-7","category":"new","type":"Story","summary":"Ship the flag"}],"blocker_needs":{"X-7":{"needs":"merge","why":"lands the flag it ships behind"}}}' > "$T/state-j/triage/J-12.json"
x7gate 'done' OPEN; out=$(node "$B/pass.mjs" 2>&1)
check "DS-687 a triage merge gate Done in Jira whose PR has not merged to the base still holds the merge" '[ "$(field J-12 merge_after)" = "\"X-7\"" ] && ! echo "$out" | grep -q "merge hold: J-12"'
q add X-7; x7gate 'done' OPEN; out=$(node "$B/pass.mjs" 2>&1)
check "DS-687 one that joined the batch since still holds the merge until its PR is on the base" '[ "$(field J-12 merge_after)" = "\"X-7\"" ] && ! echo "$out" | grep -q "merge hold: J-12"'
q drop X-7
x7gate 'done' MERGED; out=$(node "$B/pass.mjs" 2>&1)
check "DS-687 once it is Done and its PR merged to the base, the pass lifts the gate" '[ "$(field J-12 merge_after)" = null ] && echo "$out" | grep -q "merge hold: J-12: X-7 Done; free to merge"'
# A merge gate closed as Won't Do with no PR never lands: it holds, raised once, until its link goes.
q set J-12 merge_after=X-7; resolved X-7 "Won't Do"; x7gate 'done' OPEN; printf '[]\n' > "$T/prs-x7.json"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 a triage merge gate closed as Won't Do with no PR still holds the merge, and is raised once" \
  '[ "$(field J-12 merge_after)" = "\"X-7\"" ] && ! echo "$out" | grep -q "merge hold: J-12" && [ "$(echo "$out" | grep -c "triage: J-12 is blocked by X-7, closed without landing")" = 1 ]'
links J-12; out=$(node "$B/pass.mjs" 2>&1)
check "DS-717 once its link is removed, the gate lifts and the item clears" \
  '[ "$(field J-12 merge_after)" = null ] && [ "$(field J-12 wont_do_link)" = null ] && echo "$out" | grep -q "merge hold: J-12: X-7 no longer linked as a blocker; free to merge"'
q drop J-12; rm -f "$T/jira/X-7.json"
# DS-683: every pass reads a full hold on a blocker in no batch again. J-13 is the KAN-529 shape:
# admitted fully held on OPS-3 on triage's 'build' call, a step no row named yet, then the label row set.
# The step decides, so the call does not keep it held.
cat "$T/config-j.md" > "$T/config-jl.md"
printf '| Person-step labels | `ben-step` |\n| Person-input labels | `ben-input` |\n' >> "$T/config-jl.md"
# step <TICKET> <BLOCKER> <label>: the ticket's Jira links, its triage record, and the blocker's labels.
step(){ printf '{"fields":{"issuelinks":[{"type":{"inward":"is blocked by"},"inwardIssue":{"key":"%s","fields":{"summary":"Set up the account","issuetype":{"name":"Task"},"status":{"statusCategory":{"key":"new"}}}}}]}}\n' "$2" > "$T/jira/$1.json"
  printf '{"fields":{"labels":["%s"]}}\n' "$3" > "$T/jira/$2.json"
  printf '{"epic":null,"blockers":[{"key":"%s","category":"new","type":"Task","summary":"Set up the account","labels":["%s"]}],"blocker_needs":{"%s":{"needs":"build","why":"the account it reads"}}}\n' "$2" "$3" "$2" > "$T/state-j/triage/$1.json"; }
held_on(){ q add "$1"; q set "$1" state=parked held_by="$2" held_outside="$2" "park={\"question\":\"held by orchestrator: blocked by $2 — starts once $2 is Done in Jira\"}"; }
held_on J-13 OPS-3; step J-13 OPS-3 ben-step
out=$(node "$B/pass.mjs" 2>&1)
check "DS-683 AC4 a full hold on a blocker that is no person's step stays as it is" \
  '[ "$(field J-13 state)" = "\"parked\"" ] && [ "$(field J-13 held_outside)" = "\"OPS-3\"" ] && [ "$(field J-13 merge_after)" = null ] && ! echo "$out" | grep -q "RECLASSIFIED J-13"'
# With no label row, that pass's blocker re-read kept no labels: a re-read with the row set reads them.
step J-13 OPS-3 ben-step; out=$(DESK_CONFIG="$T/config-jl.md" node "$B/pass.mjs" 2>&1)
check "DS-683 AC1 once its label row is set, the full hold becomes a merge-only gate, logged" \
  '[ "$(field J-13 held_outside)" = null ] && [ "$(field J-13 held_by)" = null ] && [ "$(field J-13 merge_after)" = "\"OPS-3\"" ] && [ "$(echo "$out" | grep -c "RECLASSIFIED J-13: OPS-3 is a person step: build now, merge after")" = 1 ]'
check "DS-683 AC2 its last full hold gone, it is released and spawned in the same pass" \
  '[ "$(field J-13 state)" = "\"running\"" ] && [ "$(field J-13 park)" = null ] && echo "$out" | grep -q "person-step hold: J-13: RELEASED"'
out=$(DESK_CONFIG="$T/config-jl.md" node "$B/pass.mjs" 2>&1)
check "DS-683 AC5 the next pass changes nothing and logs nothing again" \
  '[ "$(field J-13 merge_after)" = "\"OPS-3\"" ] && ! echo "$out" | grep -q "J-13: OPS-3\|person-step hold: J-13"'
step J-13 OPS-3 ben-input; out=$(DESK_CONFIG="$T/config-jl.md" node "$B/pass.mjs" 2>&1)
check "DS-683 a ticket already started keeps its merge-only gate when the step gains an input label" \
  '[ "$(field J-13 merge_after)" = "\"OPS-3\"" ] && [ "$(field J-13 held_outside)" = null ] && ! echo "$out" | grep -q "person-step hold: J-13"'
q drop J-13
held_on J-14 OPS-4; step J-14 OPS-4 ben-input
out=$(DESK_CONFIG="$T/config-jl.md" node "$B/pass.mjs" 2>&1)
check "DS-683 AC3 a full hold on a Person-input blocker stays as it is, with nothing logged" \
  '[ "$(field J-14 state)" = "\"parked\"" ] && [ "$(field J-14 held_outside)" = "\"OPS-4\"" ] && [ "$(field J-14 merge_after)" = null ] && ! echo "$out" | grep -q "RECLASSIFIED J-14\|person-step hold: J-14"'
q drop J-14
q add J-15; q set J-15 state=triaged merge_after=OPS-5; step J-15 OPS-5 ben-input
q add J-16; q set J-16 state=triaged merge_after=OPS-6; step J-16 OPS-6 ben-step
out=$(DESK_CONFIG="$T/config-jl.md" node "$B/pass.mjs" 2>&1)
check "DS-683 AC6 a not-yet-started gate whose blocker gained an input label is a full hold again, logged once" \
  '[ "$(field J-15 state)" = "\"parked\"" ] && [ "$(field J-15 held_outside)" = "\"OPS-5\"" ] && [ "$(field J-15 held_by)" = "\"OPS-5\"" ] && [ "$(field J-15 merge_after)" = null ] && [ "$(echo "$out" | grep -c "person-step hold: J-15: OPS-5 now labelled as your input")" = 1 ] && field J-15 park.question | grep -q "^\"held by orchestrator: blocked by OPS-5"'
check "DS-683 AC7 a merge-only gate on a blocker with no input label is never moved back" \
  '[ "$(field J-16 merge_after)" = "\"OPS-6\"" ] && [ "$(field J-16 held_outside)" = null ] && ! echo "$out" | grep -q "person-step hold: J-16"'
out=$(DESK_CONFIG="$T/config-jl.md" node "$B/pass.mjs" 2>&1)
check "DS-683 AC6 the next pass leaves it held and says nothing more" '[ "$(field J-15 state)" = "\"parked\"" ] && [ "$(field J-15 held_outside)" = "\"OPS-5\"" ] && ! echo "$out" | grep -q "RECLASSIFIED J-15\|person-step hold: J-15"'
q drop J-15; q drop J-16
held_on J-17 OPS-7; step J-17 OPS-7 ben-step
out=$(AUTOPILOT_DRY_RUN=1 DESK_CONFIG="$T/config-jl.md" node "$B/pass.mjs" 2>&1)
check "DS-683 AC9 a dry run reports the change and writes nothing" \
  '[ "$(field J-17 state)" = "\"parked\"" ] && [ "$(field J-17 held_outside)" = "\"OPS-7\"" ] && [ "$(field J-17 merge_after)" = null ] && echo "$out" | grep -q "RECLASSIFIED J-17: OPS-7 is a person step: build now, merge after (dry run)"'
q drop J-17
# A person's release (held_by=null) leaves held_outside behind. Date-held since, the stale key is no hold
# to lift, so the date hold stands.
q add J-18; q set J-18 state=parked held_outside=OPS-8 held_label=blocked-until-2099-01-01 'park={"question":"held by orchestrator: blocked until 2099-01-01 (label blocked-until-2099-01-01) — starts on that date by itself"}'
step J-18 OPS-8 ben-step
printf '{"epic":null,"labels":["blocked-until-2099-01-01"],"blockers":[{"key":"OPS-8","category":"new","type":"Task","summary":"Set up the account","labels":["ben-step"]}]}\n' > "$T/state-j/triage/J-18.json"
out=$(DESK_CONFIG="$T/config-jl.md" node "$B/pass.mjs" 2>&1)
check "DS-683 a held_outside key a release left behind does not lift a date hold" \
  '[ "$(field J-18 state)" = "\"parked\"" ] && [ "$(field J-18 held_label)" = "\"blocked-until-2099-01-01\"" ] && [ "$(field J-18 merge_after)" = null ] && ! echo "$out" | grep -q "RECLASSIFIED J-18\|person-step hold: J-18"'
q drop J-18
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
mkdir -p "$T/u"
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/gh-calls', a.join(' ') + '\n');
const n = a[2]; const has = (f) => fs.existsSync('$T/u/' + n + f);
const fields = a[a.indexOf('--json') + 1] ?? '';
const green = [{ __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }];
// #712 is also red on "Review gate", which reads the PR's reviews rather than its code.
const checks = n === '712' ? [...green, { __typename: 'CheckRun', name: 'Review gate', status: 'COMPLETED', conclusion: 'FAILURE' }] : green;
const mergeable = n === '705' ? 'CONFLICTING' : n === '708' ? 'UNKNOWN' : 'MERGEABLE';
const verdict ='<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=$HEAD_A p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->\n**desk-review, round 1: clean at \`aaaaaaa\`**';
if (a[0] === 'pr' && a[1] === 'view' && fields.startsWith('state,')) {
  console.log(JSON.stringify({ state: 'OPEN', url: 'https://github.com/acme/widgets/pull/' + n, isDraft: !has('.ready'), mergeable,
    statusCheckRollup: checks }));
} else if (a[0] === 'pr' && a[1] === 'view' && fields.startsWith('headRefOid,')) {
  console.log(JSON.stringify({ headRefOid: n === '704' ? '$HEAD_B' : '$HEAD_A', mergeable, mergeStateStatus: n === '705' ? 'DIRTY' : n === '708' ? 'UNKNOWN' : 'DRAFT', body: '## Summary',
    reviews: [{ author: { login: 'ben' }, body: verdict }], statusCheckRollup: checks }));
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
# DS-578: #712 is clean and red only on "Review gate". Unlisted, it is a code check; listed in §4
# State checks, it reaches the undraft step, which undrafts the PR as it would a green one.
q add U-12; q set U-12 state=done result.pr=712
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-578 a red check §4 State checks does not name keeps the draft" '[ "$(readied 712)" = 0 ] && [ "$(field U-12 undraft.call)" = "\"checks\"" ]'
printf '| State checks | `Review gate: approval` |\n' >> "$T/config-u.md"
q set U-12 undraft=null; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-578 AC1 a clean draft red only on a §4 State check is undrafted" '[ "$(readied 712)" = 1 ] && [ "$(field U-12 undraft.call)" = "\"ready\"" ]'

# ---- DS-569: a supervised batch's pass admits a held ticket's open blocker in no batch into the batch
# intake.mjs is a fake that records each admit and adds the ticket to this queue, or refuses one
# $T/refuse-<key> names, or one $T/limit-<key> names as real intake does when that ticket's own triage
# stops at a usage limit. It answers --json as intake does. Each held ticket's blockers were read just
# now, so Jira is not read again.
{ cat "$T/config-j.md"; printf '| Jira project | `J` |\n| Person-input labels | `ben-input` |\n'; } > "$T/config-a.md"
CONFIG_WAS=$DESK_CONFIG; export DESK_CONFIG="$T/config-a.md" DESK_QUEUE="$T/queue-a.json" DESK_AUTOPILOT_STATE="$T/state-a"
mkdir -p "$T/state-a/logs" "$T/state-a/triage"; : > "$T/admits-a"
rm -f "$T/desk/bin/intake.mjs"
cat > "$T/desk/bin/intake.mjs" <<EOF
import { appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const key = process.argv[3];
const args = process.argv.slice(2).filter((a) => a !== '--json');
appendFileSync('$T/admits-a', args.join(' ') + '\n');
const say = (lines, r) => { console.log(process.argv.includes('--json') ? JSON.stringify({ ran: true, lines, admitted: [], refused: [], limited: [], ...r }) : lines.join('\n')); };
if (existsSync('$T/limit-' + key)) { say(['triage: done ' + key + ' no record (1s)', 'not admitted ' + key + ': triage stopped at the usage limit, which resets at 3pm: run /desk-admit ' + key + ' again once the limit lifts', 'summary: 0 of 1 admitted, 1 not admitted (1s)'], { refused: [key], limited: [key] }); process.exit(11); }
if (existsSync('$T/refuse-' + key)) { say(['triage: done ' + key + ' lane C (1s)', 'not admitted ' + key + ': lane C: needs a plan', 'summary: 0 of 1 admitted, 1 not admitted (1s)'], { refused: [key] }); process.exit(11); }
execFileSync('node', ['$B/queue.mjs', 'add', key], { stdio: 'ignore' });
say(['admitted ' + key + ' by pass into batch a (lane A, S)'], { admitted: [key] });
EOF
printf '#!/bin/sh\ncase "$*" in\n  "pr list "*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n' > "$T/stub/gh"; chmod +x "$T/stub/gh"
q init a; q set-batch supervised=true
held_on(){ q add "$1"; q set "$1" state=parked held_by="$2" held_outside="$2" outside_blockers_read=2099-01-01T00:00:00.000Z "park={\"question\":\"held by orchestrator: blocked by $2 — starts once their PRs merge\"}"
  printf '{"epic":null,"blockers":[{"key":"%s","category":"%s"%s}]}\n' "$2" "$3" "${4:-}" > "$T/state-a/triage/$1.json"; }
held_on J-60 J-61 new
held_on J-64 J-65 new ',"labels":["ben-input"]'
held_on J-66 J-67 'done'
held_on J-68 X-69 indeterminate
held_on J-70 J-71 new
held_on J-72 J-73 new; touch "$T/refuse-J-73"
# J-70's held item is put off on the inputs needs-you keys it to now, in the form entries took before
# blockers were settled: its blocker's Jira status since moving in flight leaves it put off. J-80's was
# put off while another blocker held it, so the blocker that holds it now has brought it back.
held_on J-80 J-81 new
node -e 'import(process.argv[1]).then((m) => { const off = (t, b, cat) => console.log(JSON.stringify(m.putOffEntry({ question: `${t} held`, ticket: t,
  inputs: { ticket: t, need: `held by ${b} (${cat}, in no batch), outside this batch`, blockers: `${b}:${cat === "to do" ? "new" : "indeterminate"}@none` } })));
  off("J-70", "J-71", "to do"); off("J-80", "J-82", "in progress"); })' "$B/not-now.mjs" > "$T/state-a/not-now.jsonl"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-569 AC1 the held ticket's open blocker in no batch is admitted to its batch, and its hold is an ordinary one" \
  'grep -qx "admit J-61 --by pass" "$T/admits-a" && [ "$(field J-61 state)" != null ] && [ "$(field J-60 held_by)" = "\"J-61\"" ] && [ "$(field J-60 held_outside)" = null ] && [ "$(field J-60 outside_blockers)" = "[]" ] && echo "$out" | grep -q "outside blockers: J-61, holding J-60, admitted to this batch"'
check "DS-569 AC2 a blocker that is the person's step is not admitted, and its ticket stays held outside" \
  '! grep -q "J-65" "$T/admits-a" && [ "$(field J-65 state)" = null ] && [ "$(field J-64 held_outside)" = "\"J-65\"" ]'
check "DS-569 AC3 a Done blocker admits nothing, and the held ticket is released to start" \
  '! grep -q "J-67" "$T/admits-a" && [ "$(field J-66 state)" = "\"triaged\"" ] && [ "$(field J-66 held_by)" = null ]'
check "DS-569 a blocker in another Jira project, and one whose held item was put off, are not admitted" \
  '! grep -q "X-69" "$T/admits-a" && ! grep -q "J-71" "$T/admits-a" && [ "$(field J-70 held_outside)" = "\"J-71\"" ]'
check "DS-569 a held item put off before its blockers changed is back, so its blocker is admitted" \
  'grep -qx "admit J-81 --by pass" "$T/admits-a" && [ "$(field J-80 held_outside)" = null ]'
check "DS-569 a blocker intake refuses is said with its reason, and the ticket stays held outside" \
  'grep -qx "admit J-73 --by pass" "$T/admits-a" && [ "$(field J-72 held_outside)" = "\"J-73\"" ] && [ "$(field J-72 outside_admit_tried)" = "\"J-73\"" ] && echo "$out" | grep -qF "outside blockers: J-73, holding J-72, not admitted to this batch (not admitted J-73: lane C: needs a plan): admit it with /desk-admit J-73"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-569 a refused blocker is not tried again on the next pass" '[ "$(grep -c "J-73" "$T/admits-a")" = 1 ] && [ "$(wc -l < "$T/admits-a" | tr -d " ")" = 3 ]'
held_on J-74 J-75 new
out=$(DESK_BATCH=a node "$B/pass.mjs" 2>&1)
check "DS-569 in a named batch the blocker is admitted into that batch" 'grep -qx "admit J-75 --by pass --into a" "$T/admits-a" && [ "$(field J-74 held_outside)" = null ]'
held_on J-78 J-79 new; touch "$T/limit-J-79"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-569 a blocker whose triage a usage limit cut off is not counted as tried" '[ "$(field J-78 outside_admit_tried)" = null ] && [ "$(field J-79 state)" = null ]'
rm -f "$T/limit-J-79"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-569 once the limit lifts, the next pass admits it" '[ "$(grep -c "^admit J-79 " "$T/admits-a")" = 2 ] && [ "$(field J-79 state)" != null ]'
q set-batch supervised=false; held_on J-76 J-77 new
out=$(node "$B/pass.mjs" 2>&1)
check "DS-569 a batch the supervisor does not run admits nothing" '! grep -q "J-77" "$T/admits-a" && [ "$(field J-76 held_outside)" = "\"J-77\"" ]'
export DESK_CONFIG="$CONFIG_WAS"

# ---- DS-415: evidence runs that failed the same way on three drafts start one fix, not three items
# The fake gh: #801-#803 are clean, green drafts with two screenshot cells and an evidence block. Each
# one's recorded run (9<n>) failed, and its log has the same error with its own run id, time and SHA.
# A run the pass starts again is 77<n>, still running. intake.mjs is a fake that records what it admits.
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/gh-calls', a.join(' ') + '\n');
const fields = a[a.indexOf('--json') + 1] ?? '';
const green = [{ __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const verdict = '<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=$HEAD_A p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->\n**clean**';
const body = 'Before | After\n_drag a-before.png_ | _drag a-after.png_\n\n\`\`\`evidence\na-before.png | before | /x | 1280\n\`\`\`\n';
if (a[0] === 'pr' && a[1] === 'view' && fields.startsWith('state,')) console.log(JSON.stringify({ state: 'OPEN', url: 'https://github.com/acme/widgets/pull/' + a[2], isDraft: true, mergeable: 'MERGEABLE', statusCheckRollup: green }));
else if (a[0] === 'pr' && a[1] === 'view') console.log(JSON.stringify({ headRefOid: '$HEAD_A', mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT', body, reviews: [{ author: { login: 'ben' }, body: verdict }], statusCheckRollup: green }));
else if (a[0] === 'pr' && a[1] === 'list') console.log('[]');
else if (a[0] === 'api') { /* no convert_to_draft events */ }
else if (a[0] === 'run' && a[1] === 'view' && a.includes('--log-failed')) {
  const id = a[2], sha = id + 'abcdef0';
  console.log(['evidence\tShoot\t2026-11-01T19:29:0' + id.slice(-1) + '.1Z node scripts/evidence.mjs', 'evidence\tShoot\t2026-11-01T19:29:1' + id.slice(-1) + '.1Z Error: did not set a _vercel_jwt cookie for the bypass secret (run ' + id + '00000, ' + sha + ')', 'evidence\tShoot\t2026-11-01T19:29:2' + id.slice(-1) + '.1Z ##[error]Process completed with exit code 1.'].join('\n'));
}
else if (a[0] === 'run' && a[1] === 'view') console.log(JSON.stringify(a[2].startsWith('77') ? { status: 'in_progress', conclusion: null } : { status: 'completed', conclusion: 'failure' }));
else if (a[0] === 'workflow' && a[1] === 'run' && fs.existsSync('$T/wf-refuse-' + a[a.length - 1].replace('pr=', ''))) { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
else if (a[0] === 'workflow' && a[1] === 'run') console.log('https://github.com/acme/widgets/actions/runs/77' + a[a.length - 1].replace('pr=', ''));
else process.exit(1);
EOF
cat > "$T/desk/bin/intake.mjs" <<EOF
import { appendFileSync, existsSync } from 'node:fs';
appendFileSync('$T/admits', process.argv.slice(2).join(' ') + '\n');
if (existsSync('$T/admit-refuse')) { console.log('triage: done ' + process.argv[3] + ' lane A (1s)\nnot admitted ' + process.argv[3] + ': batch ev is run by a session, not the supervisor\nsummary: 0 of 1 admitted, 1 not admitted (1s)'); process.exit(1); }
console.log('admitted ' + process.argv[3]);
EOF
uconfig yes; printf '| Evidence workflow | `pr-evidence.yml` |\n' >> "$T/config-u.md"
export DESK_QUEUE="$T/queue-ev.json" DESK_AUTOPILOT_STATE="$T/state-ev"
mkdir -p "$T/state-ev/logs" "$T/state-ev/evidence-runs"; : > "$T/admits"
q init ev
for n in 801 802 803; do
  q add "E-$n"; q set "E-$n" state=done "result.pr=$n"
  printf '{"workflow":"pr-evidence.yml","runId":"9%s","url":"https://github.com/acme/widgets/actions/runs/9%s","at":"2026-11-01T19:28:00Z","cells":2}\n' "$n" "$n" > "$T/state-ev/evidence-runs/$n-$HEAD_A.json"
done
: > "$T/gh-calls"; touch "$T/admit-refuse"; out=$(node "$B/pass.mjs" 2>&1)
fixkey=$(node -e 'const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.values(f).map((r) => r.fix).join(" "))' "$T/state-ev/evidence-runs/fixes.json" 2>/dev/null)
check "DS-415 AC2 three drafts failing the same way file one fix and try to admit it" \
  '[ "$(echo "$fixkey" | wc -w | tr -d " ")" = 1 ] && [ "$(wc -l < "$T/admits" | tr -d " ")" = 1 ] && grep -q "^admit $fixkey --by evidence$" "$T/admits" && [ -f "$T/state-ev/tickets/$fixkey.md" ]'
check "DS-415 AC2 its ticket names the run and the error line" 'grep -q "Error: did not set a _vercel_jwt cookie for the bypass secret" "$T/state-ev/tickets/$fixkey.md" && grep -q "#801 (E-801), #802 (E-802), #803 (E-803)" "$T/state-ev/tickets/$fixkey.md"'
check "DS-415 a fix the batch refuses is one item, on the lowest PR, naming the others, not one per PR" \
  '[ "$(field E-801 undraft.call)" = "\"person\"" ] && [ "$(field E-802 undraft.call)" = "\"evidence-fix\"" ] && [ "$(field E-803 undraft.call)" = "\"evidence-fix\"" ] && [ "$(echo "$out" | grep -c "DRAFT — PR #80")" = 1 ] && echo "$out" | grep "DRAFT — PR #801" | grep -q "/desk-admit $fixkey. PR(s) #802, #803 fail the same way"'
check "a refused fix keeps the refusal's reason, not the summary line after it" \
  'echo "$out" | grep -q "but it was not admitted (not admitted $fixkey: batch ev is run by a session, not the supervisor)" && ! echo "$out" | grep -q "summary: 0 of 1"'
rm -f "$T/admit-refuse"; : > "$T/gh-calls"; : > "$T/admits"; out=$(node "$B/pass.mjs" 2>&1)
q add "$fixkey"
check "DS-415 AC1 AC2 once the fix is admitted, each PR waits on it, and none goes to the person" \
  'grep -q "^admit $fixkey --by evidence$" "$T/admits" && for n in 801 802 803; do [ "$(field E-$n undraft.call)" = "\"evidence-fix\"" ] || exit 1; done; ! echo "$out" | grep -q "DRAFT — PR #80"'
check "DS-415 AC1 the run's log was read once per run" '[ "$(grep -c "^run view 9801 .*--log-failed" "$T/gh-calls")" = 1 ]'
: > "$T/gh-calls"; : > "$T/admits"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-415 AC2 the next pass files no other fix, and the PRs still wait" \
  '[ ! -s "$T/admits" ] && [ "$(field E-801 undraft.call)" = "\"evidence-fix\"" ] && ! grep -q "^workflow run" "$T/gh-calls"'
q set "$fixkey" state=done result.pr=900 merged_at=2026-11-02T10:00:00Z
: > "$T/gh-calls"; touch "$T/wf-refuse-803"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-415 AC3 once the fix merged, the evidence workflow is started again on each waiting PR" \
  'for n in 801 802 803; do grep -q "^workflow run pr-evidence.yml --repo acme/widgets --ref main -f pr=$n$" "$T/gh-calls" || exit 1; done; for n in 801 802; do [ "$(field E-$n undraft.call)" = "\"evidence\"" ] || exit 1; done'
rm -f "$T/wf-refuse-803"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-415 AC3 and the next pass waits on those runs, starting none again" \
  '! grep -q "^workflow run pr-evidence.yml .* -f pr=80[12]$" "$T/gh-calls" && [ "$(field E-801 undraft.call)" = "\"wait\"" ]'
check "DS-415 a run GitHub refused to start again is started at the next pass, not read as failing after the fix" \
  'grep -q "^workflow run pr-evidence.yml --repo acme/widgets --ref main -f pr=803$" "$T/gh-calls" && [ "$(field E-803 undraft.call)" = "\"evidence\"" ]'

# ---- A batch on its own base: the evidence workflow runs from §0 Default branch, not the base --------
# The base goes straight onto the queue: set-batch asks origin for it, and this repo has no origin.
export DESK_QUEUE="$T/queue-eb.json" DESK_AUTOPILOT_STATE="$T/state-eb"
mkdir -p "$T/state-eb/logs" "$T/state-eb/evidence-runs"; : > "$T/admits"
q init eb; q add E-804; q set E-804 state=done result.pr=804
q add E-805; q set E-805 state=done result.pr=805
printf '{"workflow":"pr-evidence.yml","runId":"9805","url":"https://github.com/acme/widgets/actions/runs/9805","at":"2026-11-01T19:28:00Z","cells":2}\n' > "$T/state-eb/evidence-runs/805-$HEAD_A.json"
node -e 'const fs = require("fs"), f = process.argv[1], q = JSON.parse(fs.readFileSync(f, "utf8")); q.base = "feat/x"; fs.writeFileSync(f, JSON.stringify(q))' "$DESK_QUEUE"
: > "$T/gh-calls"; out=$(AUTOPILOT_DRY_RUN=1 node "$B/pass.mjs" 2>&1)
check "DS-373 AC1 a dry-run pass on a batch base prints the dispatch with --ref the default branch" \
  'echo "$out" | grep -q "would run \`gh workflow run pr-evidence.yml --repo acme/widgets --ref main -f pr=804\`" && ! grep -q "^workflow run" "$T/gh-calls"'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-373 AC1 the pass starts it there too" \
  'grep -q "^workflow run pr-evidence.yml --repo acme/widgets --ref main -f pr=804$" "$T/gh-calls" && ! grep -q "^workflow run .*--ref feat/x" "$T/gh-calls"'
ebfix=$(node -e 'const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.values(f).map((r) => r.fix).join(" "))' "$T/state-eb/evidence-runs/fixes.json" 2>/dev/null)
check "DS-373 the fix ticket for a failed run reproduces it where the pass runs it" \
  'grep -qF -- "--ref main -f pr=805" "$T/state-eb/tickets/$ebfix.md" && ! grep -q "feat/x" "$T/state-eb/tickets/$ebfix.md"'

# ---- DS-854: with Jira, the fix ticket's body is sent from the batch state dir, which desk-jira accepts
# The fake desk-jira applies desk-jira's path check to the body, with $DESK_STATE as the only allowed
# root ($T is itself a temp dir, which the real check would also allow). $T/jira-refuse refuses it anyway,
# and $T/jira-lint refuses it as a lint block does, with findings above a last line naming no file.
cat > "$T/stub/desk-jira" <<EOF
#!/bin/sh
echo "\$*" >> "$T/jira-calls"
[ "\$1" = create ] || exit 0
if [ -f "$T/jira-lint" ]; then printf 'desk-jira: not created: the ticket has blocking findings (ticket-template.md):\nERROR  Acceptance criteria: none found\nFix the body, or pass --no-lint to file it as it is\n' >&2; exit 1; fi
real=\$(cd "\$(dirname "\$4")" && pwd -P)/\$(basename "\$4")
st=\$(cd "\${DESK_STATE:-/nonexistent}" 2>/dev/null && pwd -P)
if [ ! -f "$T/jira-refuse" ] && [ -n "\$st" ]; then case "\$real" in "\$st"/*) echo "created J-900"; exit 0 ;; esac; fi
echo "desk-jira: refusing to send \$4 (\$real): a body, field=@file or attachment must be inside this repo's worktree (none here), \\\$DESK_STATE or a temp dir (\\\$TMPDIR, /tmp)" >&2; exit 1
EOF
chmod +x "$T/stub/desk-jira"
jconfig(){
  uconfig yes
  awk -v g="$1" '{ print } /^\| `pr-ready`/ { print "| `jira-create` | File tickets | `yes` | `" g "` |" }' "$T/config-u.md" > "$T/config-ej.md"
  printf '| Evidence workflow | `pr-evidence.yml` |\n\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `[A-Z]+-[0-9]+` |\n' >> "$T/config-ej.md"
}
export DESK_CONFIG="$T/config-ej.md" DESK_QUEUE="$T/queue-ej.json" DESK_AUTOPILOT_STATE="$T/state-ej"
mkdir -p "$T/state-ej/logs" "$T/state-ej/evidence-runs"; : > "$T/admits"; : > "$T/jira-calls"
q init ej; q add E-806; q set E-806 state=done result.pr=806
printf '{"workflow":"pr-evidence.yml","runId":"9806","url":"https://github.com/acme/widgets/actions/runs/9806","at":"2026-11-01T19:28:00Z","cells":2}\n' > "$T/state-ej/evidence-runs/806-$HEAD_A.json"
bodies(){ find "$T/state-ej/evidence-runs" -name 'fix-*.md' | wc -l | tr -d ' '; }
jconfig ask; out=$(node "$B/pass.mjs" 2>&1)
check "DS-854 AC2 jira-create ask: no ticket is created and the item names the setting" \
  '! grep -q "^create " "$T/jira-calls" && [ "$(field E-806 undraft.call)" = "\"person\"" ] && field E-806 undraft.why | grep -q "jira-create.* to be .*yes.* (it is .*ask"'
jconfig yes; touch "$T/jira-refuse"; out=$(node "$B/pass.mjs" 2>&1)
body=$(find "$T/state-ej/evidence-runs" -name 'fix-*.md')
check "DS-854 AC3 a refused create is quoted with the body file's real path, its id included" \
  '[ "$(bodies)" = 1 ] && echo "$out" | grep -qF "refusing to send $body" && field E-806 undraft.why | grep -qF "$(basename "$body")"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-854 AC4 the next refused try reuses the body file rather than leaving another" '[ "$(bodies)" = 1 ] && [ "$(grep -c "^create " "$T/jira-calls")" = 2 ]'
rm -f "$T/jira-refuse"; touch "$T/jira-lint"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-854 AC3 a refusal whose last line names no file still quotes its findings and the body file's path" \
  'field E-806 undraft.why | grep -qF "Acceptance criteria: none found" && field E-806 undraft.why | grep -qF "its body is $body"'
rm -f "$T/jira-lint"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-854 AC1 desk-jira accepts the body from the batch state dir and the fix is admitted" \
  'grep -q "^admit J-900 --by evidence$" "$T/admits" && echo "$out" | grep -q "evidence: filed J-900 .*admitted to the batch" && [ "$(field E-806 undraft.call)" = "\"evidence-fix\"" ] && ! echo "$out" | grep -q "DRAFT — PR #806"'
check "DS-854 AC4 and once filed, the body file is removed" '[ "$(bodies)" = 0 ]'

echo "pass: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
