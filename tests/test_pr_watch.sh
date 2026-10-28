#!/usr/bin/env bash
# suite: pr watch (waiting on one PR's checks, head or merge under Monitor)
# pr-watch.mjs against a fake gh whose PR is a JSON file the test rewrites: each watch is quiet while
# nothing it waits on has happened, prints one line when it does, and exits; an unreadable PR prints
# its error once and exits non-zero.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
W=
trap '[ -n "$W" ] && kill "$W" 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME" "$T/bin"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# The fake gh answers `pr view <n>` from $T/pr-<n>.json, logs each call, and fails like gh for a PR
# with no file. `run list` answers from $T/runs.json, else no runs.
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "run list" ]; then cat "$GH_DIR/runs.json" 2>/dev/null || echo '[]'; exit 0; fi
[ "$1 $2" = "pr view" ] || { echo "fake gh: unexpected $*" >&2; exit 2; }
f="$GH_DIR/pr-$3.json"
[ -f "$f" ] || { echo "GraphQL: Could not resolve to a PullRequest with the number of $3. (repository.pullRequest)" >&2; exit 1; }
cat "$f"
EOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" GH_DIR="$T" GH_LOG="$T/gh.log"

# pr <n> <state> <sha> <checks json>: write the fake PR.
pr(){ printf '{"number":%s,"state":"%s","headRefOid":"%s","mergedAt":%s,"statusCheckRollup":%s}\n' \
  "$1" "$2" "$3" "$([ "$2" = MERGED ] && echo '"2026-10-26T09:00:00Z"' || echo null)" "$4" > "$T/pr-$1.json.tmp"
  mv "$T/pr-$1.json.tmp" "$T/pr-$1.json"; }
cr(){ printf '{"__typename":"CheckRun","name":"%s","status":"%s","conclusion":"%s","workflowName":"ci","startedAt":"2026-10-26T08:00:00Z","detailsUrl":"https://github.com/acme/widgets/actions/runs/%s/job/1"}' "$1" "$2" "$3" "$4"; }
# watch_bg <args>: start a watch in the background, writing to watch.out.
watch_bg(){ : > "$T/watch.out"; node "$B/pr-watch.mjs" "$@" --repo acme/widgets --interval 0.2 > "$T/watch.out" 2>&1 & W=$!; }
# wait_exit: wait up to 10s for the watch to exit; rc is its exit code, or 124 if it was still running.
wait_exit(){ n=0; while kill -0 "$W" 2>/dev/null && [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done
  if kill -0 "$W" 2>/dev/null; then kill "$W" 2>/dev/null; wait "$W" 2>/dev/null; rc=124; else wait "$W"; rc=$?; fi; W=
  out=$(cat "$T/watch.out"); }
running(){ kill -0 "$W" 2>/dev/null; }
SHA1=1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; SHA2=2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

# AC1: checks running, then one fails and one passes.
pr 12 OPEN $SHA1 "[$(cr lint COMPLETED SUCCESS 101),$(cr test IN_PROGRESS '' 102),$(cr e2e QUEUED '' 103)]"
watch_bg checks 12
sleep 0.8
out=$(cat "$T/watch.out")
check "AC1 checks still running: the watch prints nothing and keeps running" 'running && [ -z "$out" ]'
pr 12 OPEN $SHA1 "[$(cr lint COMPLETED SUCCESS 101),$(cr test COMPLETED FAILURE 102),$(cr e2e COMPLETED CANCELLED 103)]"
wait_exit
check "AC1 every check done: one line naming each failed check, exit 0" '[ $rc -eq 0 ] && [ "$(printf "%s\n" "$out" | grep -c .)" = 1 ] && [[ "$out" == "PR #12 checks done on 1111111: 2 of 3 failed: test (failure), e2e (cancelled)" ]]'

pr 13 OPEN $SHA1 "[$(cr lint COMPLETED SUCCESS 101),$(cr test COMPLETED SKIPPED 102)]"
watch_bg checks 13; wait_exit
check "AC1 all done and none failed says so" '[ $rc -eq 0 ] && [[ "$out" == "PR #13 checks done on 1111111: none failed (2 checks)" ]]'

# A check that failed and was then rerun green counts by its latest run, as gate.mjs reads it.
pr 14 OPEN $SHA1 "[$(cr test COMPLETED FAILURE 201),$(cr test COMPLETED SUCCESS 202 | sed 's/08:00/08:30/')]"
watch_bg checks 14; wait_exit
check "AC1 a rerun check is read by its latest run" '[ $rc -eq 0 ] && [[ "$out" == *"none failed (1 checks)"* ]]'

# Every reported check done while a workflow run is still in flight: a job that `needs` another has
# not reported yet, so the watch waits for the run.
pr 16 OPEN $SHA1 "[$(cr 'tests (ubuntu)' COMPLETED SUCCESS 301)]"
echo '[{"databaseId":301,"name":"tests","workflowName":"tests","status":"in_progress","conclusion":""}]' > "$T/runs.json"
watch_bg checks 16
sleep 0.8
out=$(cat "$T/watch.out")
check "AC1 a workflow run still in flight: keeps waiting" 'running && [ -z "$out" ]'
pr 16 OPEN $SHA1 "[$(cr 'tests (ubuntu)' COMPLETED SUCCESS 301),$(cr tests COMPLETED FAILURE 301)]"
echo '[{"databaseId":301,"name":"tests","workflowName":"tests","status":"completed","conclusion":"failure"}]' > "$T/runs.json"
wait_exit
check "AC1 the run done: the late check is counted and named" '[ $rc -eq 0 ] && [[ "$out" == "PR #16 checks done on 1111111: 1 of 2 failed: tests (failure)" ]]'
rm -f "$T/runs.json"

pr 15 OPEN $SHA1 "[]"
watch_bg checks 15
sleep 0.8
out=$(cat "$T/watch.out")
check "AC1 no checks reported yet: keeps waiting" 'running && [ -z "$out" ]'
pr 15 CLOSED $SHA1 "[]"
wait_exit
check "checks: a PR closed while waiting ends the watch saying so" '[ $rc -eq 0 ] && [[ "$out" == "PR #15 closed without merging" ]]'

# AC2: the head moves.
pr 20 OPEN $SHA1 "[]"
watch_bg head 20 $SHA1
sleep 0.8
out=$(cat "$T/watch.out")
check "AC2 head unchanged: prints nothing and keeps running" 'running && [ -z "$out" ]'
pr 20 OPEN $SHA2 "[]"
wait_exit
check "AC2 the head moves: one line with the new sha, exit 0" '[ $rc -eq 0 ] && [[ "$out" == "PR #20 head moved: 1111111 -> $SHA2" ]]'
pr 21 OPEN $SHA1 "[]"
watch_bg head 21 1111111
sleep 0.6
check "AC2 a short sha that the head starts with is the same head" 'running'
pr 21 MERGED $SHA1 "[]"
wait_exit
check "head: a merge with the head unchanged ends the watch saying so" '[ $rc -eq 0 ] && [[ "$out" == "PR #21 merged at 2026-10-26T09:00:00Z, head still 1111111" ]]'

# AC3: merges or closes.
pr 30 OPEN $SHA1 "[]"
watch_bg merged 30
sleep 0.8
out=$(cat "$T/watch.out")
check "AC3 still open: prints nothing and keeps running" 'running && [ -z "$out" ]'
pr 30 MERGED $SHA1 "[]"
wait_exit
check "AC3 merged: one line, exit 0" '[ $rc -eq 0 ] && [[ "$out" == "PR #30 merged at 2026-10-26T09:00:00Z" ]]'
pr 31 OPEN $SHA1 "[]"
watch_bg merged 31
sleep 0.4
pr 31 CLOSED $SHA1 "[]"
wait_exit
check "AC3 closed: one line, exit 0" '[ $rc -eq 0 ] && [[ "$out" == "PR #31 closed without merging" ]]'

# AC4: no such PR, for each watch.
for w in "checks 999" "head 999 $SHA1" "merged 999"; do
  : > "$GH_LOG"
  # shellcheck disable=SC2086
  watch_bg $w; wait_exit
  check "AC4 ${w%% *}: no such PR prints the error once and exits non-zero" '[ $rc -ne 0 ] && [ $rc -ne 124 ] && [ "$(printf "%s\n" "$out" | grep -c .)" = 1 ] && [[ "$out" == "pr-watch: PR #999 in acme/widgets: GraphQL: Could not resolve to a PullRequest"* ]] && [ "$(grep -c . "$GH_LOG")" = 1 ]'
done

# A PR that becomes unreadable mid-watch is retried, and ends only after five failed reads in a row.
pr 40 OPEN $SHA1 "[]"
watch_bg merged 40
sleep 0.4
mv "$T/pr-40.json" "$T/pr-40.away"
sleep 0.3
check "a read that fails mid-watch is retried, not fatal" 'running'
pr 40 MERGED $SHA1 "[]"
wait_exit
check "the watch carries on after a failed read" '[ $rc -eq 0 ] && [[ "$out" == "PR #40 merged"* ]]'
pr 41 OPEN $SHA1 "[]"
watch_bg merged 41
sleep 0.4
rm "$T/pr-41.json"
wait_exit
check "five failed reads in a row end the watch, non-zero, naming them" '[ $rc -eq 1 ] && [[ "$out" == "pr-watch: PR #41 in acme/widgets (5 reads in a row): GraphQL"* ]]'

node "$B/pr-watch.mjs" head 12 > "$T/watch.out" 2>&1; rc=$?; out=$(cat "$T/watch.out")
check "head with no sha prints the usage, exit 2" '[ $rc -eq 2 ] && [[ "$out" == usage:* ]]'

# AC5: the command is allowed by the autopilot-workers row, as the skill writes it.
ROWS="$S/../skills/desk-setup/references/permission-rows.md"
out=$(grep -E '^\| `autopilot-workers` \|' "$ROWS")
check "AC5 autopilot-workers allows pr-watch.mjs" '[[ "$out" == *"\`Bash(node ~/.claude/desk/bin/pr-watch.mjs *)\`"* ]]'

# AC6: the skill names the watches and forbids the loops.
# The core and its reference files: the watches moved to references/ with DS-202's split.
SK="$S/../skills/desk-autopilot"
out=$(cat "$SK/SKILL.md" "$SK"/references/*.md)
named=1
for w in "pr-watch.mjs checks <n>" "pr-watch.mjs head <n> <sha>" "pr-watch.mjs merged <n>" "node ~/.claude/desk/bin/pr-watch.mjs checks" "node ~/.claude/desk/bin/queue.mjs watch"; do
  [[ "$out" == *"$w"* ]] || named=0
done
check "AC6 the skill names each watch in its allowed form" '[ $named = 1 ]'
check "AC6 the skill says never to loop on render, gh pr checks or gh pr view" '[[ "$out" == *"Never wrap a loop around"*"queue.mjs render"*"gh pr checks"*"gh pr view"* ]]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
