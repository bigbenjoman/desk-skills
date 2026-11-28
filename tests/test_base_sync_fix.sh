#!/usr/bin/env bash
# suite: base sync: a base fix try kept, stopped, wedged or at the usage limit
# layer: L3
# The base sync's conflict fix worker past its first try, set up by base_sync_setup.sh: a try that
# leaves the base where it was, a merge kept on a ref, the push row, the base gate's conflict, a worker
# live after its park or quiet, the usage limit, the maintenance window and a fresh session per try.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=base_sync_setup.sh
. "$S/base_sync_setup.sh"

# AC4: a try whose worker left the base where it was is the last at that head: the person, with the
# files and what the try did.
: > "$T/spawns"; fresh bstuck; feature; fixrow yes; conflict; pass
ended "AUTOPILOT_PARK: both sides rewrite a.txt and neither can be kept"; pass
check "DS-320 AC4 a try that left the base where it was: put to the person" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"Conflicting files: a.txt. Still in conflict after 1 fix try; the last try parked: both sides rewrite a.txt and neither can be kept: resolve it by hand in $C/wt/base-feat-x and push"* ]]'
check "DS-320 AC4 and no second try starts" '[ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = null ]'
check "DS-663 AC5 a try that committed no merge keeps nothing, and the worktree is reset" \
  "[ \"\$(jq -r '.base_fix.tries[0].kept' \"\$DESK_QUEUE\")\" = null ] && [ -z \"\$(git -C \"\$C/repo\" for-each-ref refs/desk)\" ] && [ \"\$(git -C $BWT rev-parse HEAD)\" = \"\$(origin_tip)\" ]"

# A try that commits its merge in the base worktree and parks before pushing. keepmerge: what
# that worker does there; lockpark: its park, only on the busy test lock.
keepmerge(){
  git -C "$C/wt/base-feat-x" merge -q --no-edit origin/main >/dev/null 2>&1; printf 'ours\ntheirs\n' > "$C/wt/base-feat-x/a.txt"
  git -C "$C/wt/base-feat-x" add a.txt; git -C "$C/wt/base-feat-x" commit -q --no-edit; git -C "$C/wt/base-feat-x" rev-parse HEAD
}
lockpark(){ ended "$(printf 'AUTOPILOT_PARK_WAIT: test-lock\nAUTOPILOT_PARK: merge committed, but the test lock is busy')"; }
: > "$T/spawns"; fresh bkeep; feature; fixrow yes; conflict; tip=$(origin_tip); pass
kept=$(keepmerge); lockpark; pass
check "DS-663 AC1 the merge the try committed is kept on a named ref, which its record names" \
  '[ "$(jq -r ".base_fix.tries[0].kept.ref" "$DESK_QUEUE")" = refs/desk/base-fix/base-feat-x/1 ] && [ "$(git -C "$C/repo" rev-parse refs/desk/base-fix/base-feat-x/1)" = "$kept" ] && [ "$(jq -r ".base_fix.tries[0].kept.sha" "$DESK_QUEUE")" = "$kept" ]'
check "DS-663 AC1 the report names the ref" '[[ "$out" == *"try 1 of 2 on feat/x parked: merge committed, but the test lock is busy; its unpushed ${kept:0:12} is kept on refs/desk/base-fix/base-feat-x/1"* ]]'
check "DS-663 AC4 a try that parked only on the busy test lock spends no try" \
  '[ "$(jq -r ".base_fix.tries[0].lock_wait" "$DESK_QUEUE")" = true ] && [[ "$out" == *"spends no try"* ]] && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 2 ] && [ "$(jq -r ".base_fix.tries[1].try" "$DESK_QUEUE")" = 1 ] && [[ "$out" != *"by hand"* ]]'
check "DS-663 AC2 the next try starts from the kept merge, in the base worktree" \
  "[ \"\$(git -C $BWT rev-parse HEAD)\" = \"\$kept\" ] && [ \"\$(jq -r '.base_fix.tries[1].from.sha' \"\$DESK_QUEUE\")\" = \"\$kept\" ] && [[ \"\$out\" == *\"try 1 starts from try 1's kept merge\"* ]]"
check "DS-663 AC2 and is told not to resolve the conflict again" \
  'tail -n 1 "$T/spawns" | grep -q "carry on from your HEAD, which already holds try 1.s merge of origin/main into feat/x" && grep -q "do not merge or resolve the conflicts again" "$C/state/briefings/base-feat-x.md"'
live; pass; rm -f "$T/agents.json"
check "DS-663 AC4 while it runs it is still try 1 of 2" '[[ "$out" == *"conflict fix try 1 of 2 is merging main into feat/x"* ]] && [[ "$out" != *"try 2 of 2"* ]]'
git -C "$C/wt/base-feat-x" push -q origin HEAD:refs/heads/feat/x; ended "AUTOPILOT_DONE: pr=none jira=none"; pass
check "DS-663 once the base is current, the kept ref goes with the tries" \
  '[ "$(jq -r .base_fix "$DESK_QUEUE")" = null ] && [ -z "$(git -C "$C/repo" for-each-ref refs/desk)" ] && origin_has_main'
check "DS-663 AC4 and the lock wait is not counted among the tries it took" '[[ "$out" == *"current with main again, after 1 fix try"* ]]'

: > "$T/spawns"; fresh bkeepstale; feature; fixrow yes; conflict; pass
kept=$(keepmerge); lockpark
git -C "$C/repo" commit -q --allow-empty -m three; git -C "$C/repo" push -q origin main; pass
check "DS-663 AC3 a kept merge main has moved past: the next try starts from the base" \
  "[ \"\$(git -C $BWT rev-parse HEAD)\" = \"\$(origin_tip)\" ] && [ \"\$(jq -r '.base_fix.tries[1].from' \"\$DESK_QUEUE\")\" = null ] && ! tail -n 1 \"\$T/spawns\" | grep -q 'carry on from your HEAD'"
check "DS-663 AC3 and its record says the kept merge was stale" \
  '[[ "$(jq -r ".base_fix.tries[1].kept_stale" "$DESK_QUEUE")" == "refs/desk/base-fix/base-feat-x/1 at ${kept:0:12}: origin/main has moved since it was kept" ]] && [[ "$out" == *"kept merge (refs/desk/base-fix/base-feat-x/1 at ${kept:0:12}) is stale"* ]]'

# A worker that may not push the base could only park, so without §3 batch-base-push none starts.
: > "$T/spawns"; fresh bnopush no; feature; fixrow yes; conflict; pass
check "DS-320 a worker that may not push the base is not started: the person, naming the row" \
  '! grep -q "^base-" "$T/spawns" && [ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"Config §3 batch-base-push is \"no\", so no worker may push the resolved base: resolve it by hand"* ]]'

# AC3: the base gate met the conflict at the base's head: the same worker takes it, and the gate's
# failure is not put to the person.
: > "$T/spawns"; fresh bgate; feature; fixrow yes; conflict; node "$B/queue.mjs" set T-1 state=done >/dev/null
node "$B/queue.mjs" set-batch "gate={\"state\":\"failed\",\"sha\":\"$(origin_tip)\",\"failures\":[\"merging main into feat/x conflicts (a.txt)\"],\"conflict\":[\"a.txt\"]}" >/dev/null
pass
check "DS-320 AC3 a gate that met the conflict starts the conflict fix worker" 'grep -q "^base-feat-x .*conflict fix try 1 of 2 on feat/x" "$T/spawns"'
check "DS-320 AC3 the gate waits on it, and is not put to the person" \
  '[[ "$out" == *"BASE GATE: waits on the conflict fix worker on feat/x"* ]] && [[ "$out" != *"WAITING ON YOU"*"BASE GATE"* ]] && [[ "$out" != *"by hand"* ]]'
live; pass
check "DS-320 AC3 while it runs, the gate still waits on it" '[ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [[ "$out" == *"BASE GATE: waits on the conflict fix worker on feat/x"* ]]'
rm -f "$T/agents.json"

# The gate's conflict with no ticket to spawn still counts under the shared lock: with a running
# sibling batch in this repo and the lock unmakeable, the try waits rather than count a slot unlocked.
: > "$T/spawns"; fresh bgatelock; feature; fixrow yes; conflict; node "$B/queue.mjs" set T-1 state=done >/dev/null
node "$B/queue.mjs" set-batch "gate={\"state\":\"failed\",\"sha\":\"$(origin_tip)\",\"failures\":[\"merging main into feat/x conflicts (a.txt)\"],\"conflict\":[\"a.txt\"]}" >/dev/null
SIB="$DESK_HOME/repos/acme__widgets/queue.json"; mkdir -p "$(dirname "$SIB")"
echo '{"tickets":{"S-1":{"key":"S-1","state":"running"}}}' > "$SIB"; : > "$T/not-a-dir"
out=$(DESK_REPO_OVERRIDE=acme/widgets DESK_LOCK_DIR="$T/not-a-dir" node "$B/pass.mjs" 2>&1); rc=$?
check "DS-320 a gate conflict with a running sibling batch and no lock starts no fix worker" \
  '! grep -q "^base-" "$T/spawns" && [[ "$out" == *"repo workers: nothing starts this pass"*"cannot be made"* ]] && [[ "$out" == *"starts once a worker may"* ]]'
rm -f "$SIB" "$T/not-a-dir"

# A worker whose session hangs on after its park has finished: it is stopped, and the base goes to the
# person, rather than every later pass waiting on it.
: > "$T/spawns"; : > "$T/kills"; fresh bhang; feature; fixrow yes; conflict; pass; live
ended "AUTOPILOT_PARK: both sides rewrite a.txt"; pass
check "DS-320 a worker live after its park is stopped, and its try ends" \
  '[ "$(cat "$T/kills")" = 1 ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = null ] && [[ "$out" == *"try 1 of 2 on feat/x parked: both sides rewrite a.txt (session still live, stopped pid 1)"* ]]'
check "DS-320 and the base goes to the person" '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"the last try parked: both sides rewrite a.txt"* ]]'
rm -f "$T/agents.json"

# A worker whose session stays live and writes nothing: quiet, then after six passes wedged and stopped.
: > "$T/kills"; fresh bwedge; feature; fixrow yes; conflict; pass; live
for _ in 1 2 3; do pass; done
check "DS-320 a quiet base fix worker is reported quiet, and still waited on" \
  '[[ "$out" == *"base-feat-x: quiet for 3 passes"* ]] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" != null ] && [ ! -s "$T/kills" ]'
for _ in 4 5 6; do pass; done
check "DS-320 six quiet passes: stopped as wedged, and the base goes to the person" \
  '[ "$(cat "$T/kills")" = 1 ] && [ $rc -eq 11 ] && [[ "$out" == *"the last try was stopped as wedged, with no output for 6 passes"* ]]'
rm -f "$T/agents.json"

# A worker at a usage limit: never stopped or failed for it, paused rather than wedged, and
# resumed in its own session once the limit lifts, as a ticket's worker is. The claude stub answers the
# pass's one probe call with no answer, so a probe never lifts a limit here unless probe_ok is set.
: > "$T/kills"; fresh bpause; feature; fixrow yes
conflict; pass; live; limit_event "$(( $(date +%s) + 3600 ))"
for _ in 1 2 3 4 5 6 7; do pass; done
check "DS-320 a worker paused on the usage limit is waited on, not wedged" \
  '[ ! -s "$T/kills" ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" != null ] && [[ "$out" == *"base-feat-x on the 5-hour usage limit until "*"then it resumes, or sooner once a probe call succeeds"* ]] && [[ "$out" != *"by hand"* ]]'
rm -f "$T/agents.json"
# Its session exits at the limit, as a headless worker's does: held until the limit lifts, never ended
# as no marker, then resumed in its own session as the same try, once per limit. The log is aged so the
# exit is not read as a worker the registry has not caught up with.
: > "$T/spawns"; fresh bexit; feature; fixrow yes
conflict; pass; sid=$(jq -r .base_fix.running "$DESK_QUEUE"); limit_event "$(( $(date +%s) + 3600 ))"; age_log; pass
check "DS-320 a worker whose session exited at the limit is held until it lifts, not ended as no marker" \
  '[ "$(jq -r .base_fix.running "$DESK_QUEUE")" = "$sid" ] && [[ "$out" == *"base-feat-x on the 5-hour usage limit until "*"then it resumes"* ]] && [[ "$out" != *"no marker"* ]] && [[ "$out" != *"by hand"* ]] && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ]'
limit_event "$(( $(date +%s) - 60 ))"; age_log
# A lifted limit still waits while anything holds spawns, as a ticket's resume does.
sed -i.bak 's/Run detached headless workers | `yes` | `yes`/Run detached headless workers | `yes` | `no`/' "$C/config.md"; pass
check "DS-320 a lifted limit's resume waits while spawns are held" \
  '! grep -q "RESUME" "$T/spawns" && [[ "$out" == *"base-feat-x: exited at the 5-hour usage limit, which lifted"*"it resumes once nothing holds spawns (config §3 autopilot-workers is \"no\")"* ]] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = "$sid" ]'
sed -i.bak 's/Run detached headless workers | `yes` | `no`/Run detached headless workers | `yes` | `yes`/' "$C/config.md"; pass
check "DS-320 after the reset it is resumed in its own session, as the same try" \
  'grep -q "^base-feat-x .*RESUME session=$sid " "$T/spawns" && [[ "$out" == *"base-feat-x resumed — exited at the 5-hour usage limit, which lifted (its reset at "*"passed)"* ]] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = "$sid" ] && [ "$(jq -r ".base_fix.tries | length" "$DESK_QUEUE")" = 1 ] && [ "$(jq -r .base_fix.resume_limits "$DESK_QUEUE")" = 2 ]'
age_log; pass
check "DS-320 once per limit: a resume that ends at the same limit ends the try" \
  '[ "$(grep -c "RESUME" "$T/spawns")" = 1 ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = null ] && [[ "$out" == *"try 1 of 2 on feat/x ended with no marker"* ]]'
# A try the maintenance window stopped (maintenance.mjs stopForWindow) is resumed as the same try once
# nothing holds spawns, never ended or spent.
: > "$T/spawns"; fresh bmaint; feature; fixrow yes
conflict; pass; sid=$(jq -r .base_fix.running "$DESK_QUEUE"); age_log
node "$B/queue.mjs" set-batch "base_fix=$(jq -c '.base_fix + {resume: "maintenance"}' "$DESK_QUEUE")" >/dev/null
sed -i.bak 's/Run detached headless workers | `yes` | `yes`/Run detached headless workers | `yes` | `no`/' "$C/config.md"; pass
check "DS-320 a try stopped for the maintenance window waits while spawns are held, its try open" \
  '! grep -q "RESUME" "$T/spawns" && [[ "$out" == *"base-feat-x: stopped for the maintenance window; it resumes once nothing holds spawns"* ]] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = "$sid" ] && [ "$(jq -r ".base_fix.tries[0].outcome" "$DESK_QUEUE")" = null ]'
sed -i.bak 's/Run detached headless workers | `yes` | `no`/Run detached headless workers | `yes` | `yes`/' "$C/config.md"; pass
check "DS-320 then it is resumed in its own session as the same try, and the flag cleared" \
  'grep -q "^base-feat-x .*RESUME session=$sid " "$T/spawns" && [[ "$out" == *"base-feat-x resumed — stopped for the maintenance window"* ]] && [ "$(jq -r .base_fix.resume "$DESK_QUEUE")" = null ] && [ "$(jq -r ".base_fix.tries | length" "$DESK_QUEUE")" = 1 ] && [ "$(jq -r ".base_fix.tries[0].outcome" "$DESK_QUEUE")" = null ]'
# The retired autopilot-usage-resume row stops nothing: a worker at the limit is paused whatever it says.
: > "$T/kills"; fresh bnoresume; feature; fixrow yes; echo '| `autopilot-usage-resume` | Resume across the usage limit | `no` | `no` |' >> "$C/config.md"
conflict; pass; live; limit_event "$(( $(date +%s) + 3600 ))"; pass
check "DS-344 a base fix worker at the limit is paused, never stopped, whatever the retired row says" \
  '[ ! -s "$T/kills" ] && [ $rc -ne 11 ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" != null ] && [[ "$out" == *"base-feat-x on the 5-hour usage limit until "* ]] && [[ "$out" != *"by hand"* ]]'
rm -f "$T/agents.json"
# A probe call that succeeds lifts the limit before its reset (a subscription switch): the exited
# worker is resumed then, not at the reset.
: > "$T/spawns"; fresh bprobe; feature; fixrow yes
conflict; pass; sid=$(jq -r .base_fix.running "$DESK_QUEUE"); limit_event "$(( $(date +%s) + 86400 ))"; age_log; probe_ok; pass; probe_off
check "DS-344 a probe call that succeeds resumes an exited base fix worker before its reset" \
  'grep -q "^base-feat-x .*RESUME session=$sid " "$T/spawns" && [[ "$out" == *"which lifted (a probe call succeeded)"* ]]'
# A base fix whose preflight the usage limit refused: no try is spent, nothing else spawns, and the
# batch holds on the limit rather than failing the try.
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ] && [ -f "$T/preflight.limit" ]; then echo "[preflight] usage-limit: the account is at its usage limit"; exit 1; fi
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1 \$2 \${AUTOPILOT_BRANCH:-} \${AUTOPILOT_TASK:-}\${AUTOPILOT_RESUME:+RESUME session=\$3 \$AUTOPILOT_RESUME}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF
: > "$T/spawns"; fresh bprelimit; feature; fixrow yes; conflict; touch "$T/preflight.limit"; pass; rm -f "$T/preflight.limit"
check "DS-344 a base fix preflight refused at the limit spends no try and holds the batch" \
  '! grep -q "^base-feat-x " "$T/spawns" && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ] && [ "$(jq -r .usage_hold.preflight "$DESK_QUEUE")" = base-feat-x ] && [[ "$out" == *"base-feat-x: its preflight was refused at"* ]] && [[ "$out" != *"failed its preflight"* ]] && [ "$(grep -c "^T-1 " "$T/spawns")" = 0 ]'
# Each try is a fresh session: an earlier try's resume file and handoff briefing are moved aside.
: > "$T/spawns"; fresh bresume; feature; fixrow yes; conflict
mkdir -p "$C/state/resume" "$C/state/handoffs"; echo '{"branch":"feat/x"}' > "$C/state/resume/base-feat-x.json"; echo '{}' > "$C/state/handoffs/base-feat-x.json"
pass
check "DS-339 a base fix try moves an earlier try's resume file and handoff aside" \
  'grep -q "^base-feat-x " "$T/spawns" && [ ! -e "$C/state/resume/base-feat-x.json" ] && [ -e "$C/state/resume/base-feat-x.json.old" ] && [ ! -e "$C/state/handoffs/base-feat-x.json" ]'

# A base try runs suites, so it takes a unit of the test lock gate's room. One run holds the
# lock and one waits, under the hold at 1 x 2 = 2: room for 1. The base fix takes it, and T-1, a handoff
# to Stage 4b whose next step is a suite, is held. A fresh T-2 takes no room (#1544) and starts.
mkdir -p "$T/stub-lq" "$T/locks-lq/desk-test.lock.d"; echo "9101 9102" > "$T/locks-lq/desk-test.lock.d/pid"
printf ' 9101     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh\n 9102  9101 bash tests/run.sh\n 9201     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh tsc --cwd . -- pnpm typecheck\n' > "$T/ps-lq.out"
printf '#!/bin/sh\n[ "$*" = "-ww -axo pid=,ppid=,args=" ] && exec cat "%s/ps-lq.out"\n[ "$*" = "-ww -axo pid=,etime=" ] && exit 0\nexec "%s" "$@"\n' "$T" "$(command -v ps)" > "$T/stub-lq/ps"
printf '#!/bin/sh\nexit 0\n' > "$T/stub-lq/lsof"; chmod +x "$T/stub-lq/ps" "$T/stub-lq/lsof"
: > "$T/spawns"; fresh blockroom; fixrow yes; conflict; age_probes
git -C "$C/repo" worktree add -q -b feat/T-1 "$C/wt/T-1"; mkdir -p "$C/state/handoffs"
echo '{"ticket":"T-1","stage":"4b","criteria":["AC1: the widget saves"],"lane":"A","verification":["typecheck: pass"],"review":[],"evidence":[]}' > "$C/state/handoffs/T-1.json"
node "$B/queue.mjs" set T-1 "worktree=$C/wt/T-1" handoff=pending handoff_stage=4b >/dev/null
node "$B/queue.mjs" add T-2 >/dev/null; node "$B/queue.mjs" set T-2 state=triaged branch=feat/T-2 >/dev/null
out=$(PATH="$T/stub-lq:$PATH" AUTOPILOT_LOCK_QUEUE=on DESK_LOCK_DIR="$T/locks-lq" node "$B/pass.mjs" 2>&1); rc=$?
check "DS-958 with room for one on the test lock, the base fix starts and the suite-bound ticket is held" \
  'grep -q "^base-feat-x " "$T/spawns" && ! grep -q "^T-1 " "$T/spawns" && [[ "$out" == *"Stage 4 (T-1), past the 1 this pass had room for"* ]]'
check "#1544 AC1 beside them a fresh Stage 0 start takes no lock-queue room and starts" \
  'grep -q "^T-2 " "$T/spawns" && [[ "$out" != *"Stage 4 (T-1, T-2)"* ]]'

# DS-1034 AC1: the sync meets the conflict with no ticket to spawn and no failed gate, beside a sibling
# batch with a worker running: the fix takes the lock nothing else wanted, counts again under it, finds
# room under the repo's cap and starts.
: > "$T/spawns"; fresh broom; feature; fixrow yes; conflict; node "$B/queue.mjs" set T-1 state=done >/dev/null
SIB="$DESK_HOME/repos/acme__widgets/queue.json"; mkdir -p "$(dirname "$SIB")" "$T/locks-room"
echo '{"tickets":{"S-1":{"key":"S-1","state":"running"}}}' > "$SIB"; age_probes
out=$(DESK_REPO_OVERRIDE=acme/widgets DESK_LOCK_DIR="$T/locks-room" node "$B/pass.mjs" 2>&1); rc=$?
check "DS-1034 AC1 a sync conflict with nothing to spawn and a live sibling batch starts its fix worker that pass" \
  'grep -q "^base-feat-x .*conflict fix try 1 of 2 on feat/x" "$T/spawns" && [[ "$out" != *"starts once a worker may"* ]]'
rm -f "$SIB"

# DS-1034 AC2: a spawn of the fix worker that is refused spends no try, and the next pass tries again;
# after 3 refused starts the conflict is the person's, naming the file and why.
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1" >> "$T/refused"; echo "spawn-worker: no seat for \$1"; exit 1; fi
EOF
: > "$T/spawns"; : > "$T/refused"; fresh brefuse; feature; fixrow yes; conflict; pass
check "DS-1034 AC2 a refused spawn spends no try, and counts one failed start" \
  '[ "$(jq -r ".base_fix.tries | length" "$DESK_QUEUE")" = 0 ] && [ "$(jq -r .base_fix.start.failed "$DESK_QUEUE")" = 1 ] && [[ "$(jq -r .base_fix.start.why "$DESK_QUEUE")" == "could not be spawned: spawn refused — "*"no seat for base-feat-x"* ]] && [[ "$out" != *"by hand"* ]]'
pass
check "DS-1034 AC2 the next pass tries again" '[ "$(grep -c "^base-feat-x$" "$T/refused")" = 2 ] && [ "$(jq -r .base_fix.start.failed "$DESK_QUEUE")" = 2 ] && [[ "$out" != *"by hand"* ]]'
pass; pass
check "DS-1034 AC2 after 3 refused starts no fourth is tried, and it is the person's, naming the file and why" \
  '[ "$(grep -c "^base-feat-x$" "$T/refused")" = 3 ] && [ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"Conflicting files: a.txt. Its fix worker could not be started in 3 tries; the last: could not be spawned: spawn refused"*"resolve it by hand"* ]]'

finish fix
