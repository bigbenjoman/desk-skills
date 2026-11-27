#!/usr/bin/env bash
# suite: pass: orphaned lock holders (a whole pass names a test lock holder whose caller is gone, ends it past the grace, and leaves a live one)
# layer: L3
# covers: desk/bin/lock-orphans.mjs desk/bin/pass.mjs
# The real pass.mjs with the lock queue reading on, over a scratch lock dir that two real processes
# hold: an orphan in a worktree, re-parented to init, holding the test lock, and a child of this suite
# holding the light lock. The first pass names the orphan and leaves it in its grace; with its first
# sighting backdated past 5 minutes, the next ends it, frees the lock and raises nothing for the person,
# and the live holder runs on throughout. Scratch HOME and lock dir only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
# shellcheck source=pass_setup.sh
. "$(dirname "$0")/pass_setup.sh"

# Config §3 autopilot-reclaim yes, a row added to the shared config's permissions table.
awk '{ print } /`pr-images`/ { print "| `autopilot-reclaim` | Reclaim orphaned processes | `yes` | `yes` |" }' "$T/config.md" > "$T/config-or.md"
export DESK_CONFIG="$T/config-or.md" DESK_QUEUE="$T/queue-or.json" DESK_AUTOPILOT_STATE="$T/state-or" \
  DESK_LEASE_DIR="$T/lease-or" DESK_TEST_LOCK_SLOTS=1
mkdir -p "$T/state-or/logs" "$T/lease-or" "$T/wt/OR-1" "$T/wt/OR-2"
q init or
L="$DESK_LOCK_DIR"

# The orphan: a shell that starts the holder and exits, so init adopts it. Where flock(1) is installed
# it really holds the flock file with-lock.sh takes, else the mkdir slot with-lock.sh takes without it.
if command -v flock >/dev/null 2>&1; then
  orphan=$(cd "$T/wt/OR-1" && sh -c '( exec 9>>"$0/desk-test.lock"; flock 9; exec sleep 300 ) </dev/null >/dev/null 2>&1 & echo $!' "$L")
  sleep 1; echo "$orphan" > "$L/desk-test.lock.pid"
else
  orphan=$(cd "$T/wt/OR-1" && sh -c 'sleep 300 </dev/null >/dev/null 2>&1 & echo $!')
  mkdir "$L/desk-test.lock.d"; echo "$orphan" > "$L/desk-test.lock.d/pid"
fi
# The live holder: this suite's own child, holding the light lock, in another worktree.
(cd "$T/wt/OR-2" && exec sleep 300) </dev/null >/dev/null 2>&1 &
kept=$!
echo "$kept" > "$L/desk-light.lock.pid"
# Where each works, as the lsof stub tells the pass.
printf 'p%s\ncsleep\nfcwd\nn%s\np%s\ncsleep\nfcwd\nn%s\n' "$orphan" "$T/wt/OR-1" "$kept" "$T/wt/OR-2" > "$T/lsof.out"
trap 'kill -9 "$orphan" "$kept" 2>/dev/null; rm -rf "$T"' EXIT
alive(){ kill -0 "$1" 2>/dev/null; }
lock_free(){ bash "$B/with-lock.sh" test --timeout 3 -- true >/dev/null 2>&1; }
named="orphaned lock holder pid $orphan ("

check "the orphan holds the test lock to begin with" '! lock_free'
out=$(AUTOPILOT_LOCK_QUEUE=on node "$B/pass.mjs" 2>&1)
check "DS-1011 AC1 a pass names the orphaned holder, where it runs, its age and why" \
  'echo "$out" | grep -F "$named" | grep -F "$T/wt/OR-1" | grep -F "held " | grep -qF "re-parented to init"'
check "DS-1011 AC2 within the grace the pass leaves it running, and says when it ends it" \
  'alive "$orphan" && echo "$out" | grep -F "$named" | grep -qF "ended once it has been orphaned 5m"'
check "DS-1011 AC2 the pass keeps the orphan's first sighting for the next pass" \
  '[ "$(jq length "$T/state-or/lock-orphans.json")" = 1 ]'

# Five minutes on: the first sighting backdated past the grace.
jq -c 'map_values(. - 301000)' "$T/state-or/lock-orphans.json" > "$T/lo.json" && mv "$T/lo.json" "$T/state-or/lock-orphans.json"
out=$(AUTOPILOT_LOCK_QUEUE=on node "$B/pass.mjs" 2>&1)
for _ in 1 2 3 4 5 6 7 8 9 10; do alive "$orphan" || break; sleep 0.5; done
check "DS-1011 AC2 past the grace the pass ends the orphan and logs it" \
  '! alive "$orphan" && echo "$out" | grep -F "$named" | grep -qF "ended it and its process group under config §3 autopilot-reclaim, freeing its lock"'
check "DS-1011 AC2 the lock is free again, and the orphan no longer tracked" \
  'lock_free && [ ! -f "$T/state-or/lock-orphans.json" ]'
check "DS-1011 AC2 nothing reaches needs-you: no ask and no park" \
  '! grep -qF "lock holder" "$T/state-or/asks.json" 2>/dev/null && [ -z "$(ls "$T/state-or/parks" 2>/dev/null)" ]'
check "DS-1011 AC3 the live holder is left running, and not named" \
  'alive "$kept" && ! echo "$out" | grep -qF "pid $kept ("'

echo "pass lock orphans: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
