#!/usr/bin/env bash
# suite: base sync (a batch base's worktree, synced from the default branch before a pass spawns)
# pass.mjs with a batch base: every pass makes the base its own worktree, and a pass that will spawn
# first merges main into the base and pushes it. A conflict, a refused push or the §3 batch-base-push
# row pushes nothing and is reported; in feature mode it also holds the spawns. A non-fast-forward
# push is fetched, merged and retried once. A primary checkout on the base gets no worktree and no
# sync. Each case has its own throwaway origin; the real pass.mjs runs with stub claude, gh,
# setup-worktree and spawn-worker. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/desk/bin" "$T/stub"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
git config --global init.defaultBranch main
# An autopilot worker inherits spawn-worker's exports, which would point this suite at the real repo.
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_USER_APPROVED AUTOPILOT_BASE_PUSH_APPROVED
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/setup-worktree.sh" <<'EOF'
mkdir -p "$DESK_WORKTREES_DIR/$2"; echo "[setup-worktree] worktree=$DESK_WORKTREES_DIR/$2"; echo "[setup-worktree] branch=$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1 \$2 \${AUTOPILOT_BRANCH:-} \${AUTOPILOT_TASK:-}\${AUTOPILOT_RESUME:+RESUME session=\$3 \$AUTOPILOT_RESUME}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF
# The session registry: $T/agents.json when it exists, else empty.
printf '#!/bin/sh\ncat "%s/agents.json" 2>/dev/null || echo "[]"\n' "$T" > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
# kill records the pid it was asked to stop, and stops nothing.
printf '#!/bin/sh\necho "$@" >> "%s/kills"\n' "$T" > "$T/stub/kill"
# git, but the first push to feat/x first moves origin's feat/x on (what the merge driver does when it
# merges a PR into the base between the sync's fetch and its push). Armed by $T/race.arm, which holds the clone to push from.
REAL_GIT=$(command -v git)
cat > "$T/stub/git" <<EOF
#!/bin/sh
case " \$* " in *" push "*"refs/heads/feat/x"*)
  if [ -f "$T/race.arm" ]; then d=\$(cat "$T/race.arm"); rm -f "$T/race.arm"
    "$REAL_GIT" -C "\$d" commit -q --allow-empty -m "merged by the driver" && "$REAL_GIT" -C "\$d" push -q origin HEAD:feat/x; fi ;;
esac
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/git" "$T/stub/kill"
export PATH="$T/stub:$PATH" DESK_HOME="$T/desk" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test

# fresh <case> [batch-base-push value] [base]: an origin holding main and feat/x, with main two commits
# ahead, a primary checkout on main, and a queue with one triaged ticket. No base when <base> is -.
fresh(){
  C="$T/$1"; mkdir -p "$C/state" "$C/wt"
  git init -q --bare "$C/origin.git"
  git init -q "$C/repo"; git -C "$C/repo" remote add origin "$C/origin.git"
  echo base > "$C/repo/a.txt"; git -C "$C/repo" add a.txt; git -C "$C/repo" commit -q -m init
  git -C "$C/repo" push -q origin main main:feat/x
  git -C "$C/repo" commit -q --allow-empty -m one; git -C "$C/repo" commit -q --allow-empty -m two
  git -C "$C/repo" push -q origin main
  local perm=${2:-yes}
  cat > "$C/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$C/repo\` |
| Worktrees directory | \`$C/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`batch-base-push\` | Push to a batch base | \`ask\` | \`$perm\` |
EOF
  [ "$perm" = unset ] && grep -v batch-base-push "$C/config.md" > "$C/c" && command cat "$C/c" > "$C/config.md"
  export DESK_CONFIG="$C/config.md" DESK_AUTOPILOT_STATE="$C/state" DESK_QUEUE="$C/queue.json" DESK_WORKTREES_DIR="$C/wt"
  cd "$C/repo" || exit 1
  node "$B/queue.mjs" init t >/dev/null
  [ "${3:-feat/x}" = - ] || node "$B/queue.mjs" set-batch "base=${3:-feat/x}" >/dev/null
  node "$B/queue.mjs" add T-1 >/dev/null; node "$B/queue.mjs" set T-1 state=triaged branch=feat/T-1 >/dev/null
}
# feature: plan-batch seeded the batch in feature mode (the queue's epic has a filed spine).
feature(){ node "$B/queue.mjs" set-batch epic=E-1 feature=true >/dev/null; echo '{"epic":"E-1","spine":"T-0"}' > "$C/state/feature.json"; }
# conflict: main and feat/x both change a.txt.
conflict(){
  git -C "$C/repo" fetch -q origin; git -C "$C/repo" switch -q -c side origin/feat/x
  echo theirs > a.txt; git -C "$C/repo" commit -q -am base-side; git -C "$C/repo" push -q origin HEAD:feat/x
  git -C "$C/repo" switch -q main; echo ours > a.txt; git -C "$C/repo" commit -q -am main-side; git -C "$C/repo" push -q origin main
  git -C "$C/repo" branch -q -D side
}
pass(){ out=$(node "$B/pass.mjs" 2>&1); rc=$?; }
origin_has_main(){ git -C "$C/origin.git" merge-base --is-ancestor main feat/x; }
origin_tip(){ git -C "$C/origin.git" rev-parse feat/x; }
BWT='$C/wt/base-feat-x'

# AC9: no base, no base worktree, no sync.
fresh nobase yes -; pass
check "no base: a pass spawns as before"              '[[ "$out" == *"spawned: T-1"* ]]'
check "no base: no base worktree is made"            '[ -z "$(ls "$C/wt" | grep base-)" ]'
check "no base: no sync is attempted"                '[[ "$out" != *"base sync"* ]]'

# AC1, AC3: the first pass makes the base worktree; a pass that spawns nothing does not sync.
fresh idle; node "$B/queue.mjs" set T-1 state=done >/dev/null; tip=$(origin_tip); pass
check "the first pass makes the base worktree"       "[ \"\$(git -C $BWT symbolic-ref --short HEAD)\" = feat/x ]"
check "it is a worktree of the primary checkout"     'git -C "$C/repo" worktree list | grep -q "base-feat-x .*\[feat/x\]"'
check "the report says it was made"                  '[[ "$out" == *"base worktree for feat/x made at $C/wt/base-feat-x"* ]]'
check "a pass that spawns nothing does not sync"     '[ "$(origin_tip)" = "$tip" ] && [[ "$out" != *"base sync"* ]]'
pass
check "a second pass keeps the worktree, quietly"    '[[ "$out" != *"base worktree"* ]] && [ -d "$C/wt/base-feat-x" ]'

# AC2: a base behind main that merges cleanly is merged, pushed and counted before the spawn.
fresh clean; pass
check "a clean sync merges main into the base"       'origin_has_main'
check "it is a merge commit, not a rebase"           '[ "$(git -C "$C/origin.git" rev-list --parents -n 1 feat/x | wc -w | tr -d " ")" = 3 ]'
check "the report counts the commits"                '[[ "$out" == *"merged 2 commit(s) from main into feat/x and pushed"* ]]'
check "and the pass still spawns"                    '[[ "$out" == *"spawned: T-1"* ]]'
node "$B/queue.mjs" add T-2 >/dev/null; node "$B/queue.mjs" set T-2 state=triaged >/dev/null; pass
check "a base already current says so"               '[[ "$out" == *"feat/x already has everything on main"* ]]'

# AC4, AC7: a conflict pushes nothing and lists its files; an ordinary batch still spawns.
fresh conflict; conflict; tip=$(origin_tip); pass
check "a conflict pushes nothing"                    '[ "$(origin_tip)" = "$tip" ]'
check "it lists the files under WAITING ON YOU"      '[[ "${out#*WAITING ON YOU}" == *"Conflicting files: a.txt"* ]]'
check "it leaves the base worktree clean"            "[ -z \"\$(git -C $BWT status --porcelain)\" ] && [ \"\$(git -C $BWT rev-parse HEAD)\" = \"$tip\" ]"
check "not feature mode: spawning carries on"        '[[ "$out" == *"spawned: T-1"* ]] && [[ "$out" == *"spawning carries on"* ]]'
check "a conflict needs the person"                  '[ $rc -eq 11 ]'

# AC6: in feature mode a conflict spawns nothing.
fresh fconflict; feature; conflict; pass
check "feature mode: a conflict spawns nothing"      '[[ "$out" != *"spawned:"* ]] && [[ "$out" == *"feature mode, so nothing spawns this pass"* ]]'
check "DS-320 AC5 pr-conflict-unreviewed unset: no conflict fix worker starts" '! grep -q "^base-" "$T/spawns" && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ]'

# DS-320: where §3 pr-conflict-unreviewed is yes, a base conflict goes to a conflict fix worker in the
# base worktree. fixrow <value> adds the row; ended <marker line> writes the worker's last turn.
fixrow(){ printf '| `pr-conflict-unreviewed` | Resolve a merge conflict before any human has reviewed it | `yes` | `%s` |\n' "$1" >> "$C/config.md"; }
ended(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv[1] }] } })); console.log(JSON.stringify({ type: "result" }))' "$1" >> "$C/state/logs/base-feat-x.log"; }
live(){ jq -n --arg s "$(jq -r .base_fix.running "$DESK_QUEUE")" '[{sessionId: $s, pid: 1}]' > "$T/agents.json"; }
# resolve: what the worker does, from a clone: merge main into feat/x, keep both sides, push.
resolve(){
  git clone -q "$C/origin.git" "$C/fixer"; git -C "$C/fixer" switch -q feat/x
  git -C "$C/fixer" merge -q --no-edit origin/main >/dev/null 2>&1; printf 'ours\ntheirs\n' > "$C/fixer/a.txt"
  git -C "$C/fixer" add a.txt; git -C "$C/fixer" commit -q --no-edit; git -C "$C/fixer" push -q origin feat/x
}
rm -f "$T/agents.json"; : > "$T/spawns"
fresh bfix; feature; fixrow yes; conflict; tip=$(origin_tip); pass
check "DS-320 AC1 a pass that would spawn starts a conflict fix worker for the base" \
  '[[ "$out" == *"base-feat-x port="*"(conflict fix try 1 of 2 on feat/x)"* ]] && grep -q "^base-feat-x $C/wt/base-feat-x feat/x .*Your task is conflict fix try 1 of 2 on feat/x" "$T/spawns"'
check "DS-320 AC1 it is told to merge, never rebase, and to push the base" 'grep -q "merge origin/main into feat/x (git merge, never a rebase or a force push)" "$T/spawns" && grep -q "git push origin feat/x" "$T/spawns"'
check "DS-320 AC1 and the conflict is not put to the person" '[[ "$out" != *"by hand"* ]] && [ $rc -ne 11 ]'
check "DS-320 AC1 feature mode: nothing else spawns until the base is synced" '[ "$(grep -c "^T-1 " "$T/spawns")" = 0 ] && [[ "$out" == *"Conflict fix try 1 of 2 starts this pass"* ]]'
check "DS-320 AC1 the try is kept on the queue, with its files" \
  '[ "$(jq -r ".base_fix.tries | length" "$DESK_QUEUE")" = 1 ] && [ "$(jq -r ".base_fix.tries[0].files[0]" "$DESK_QUEUE")" = a.txt ] && [ "$(jq -r ".base_fix.tries[0].head" "$DESK_QUEUE")" = "$tip" ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" != null ]'
check "DS-320 AC1 its ticket file and briefing name the files" \
  'grep -q "Conflicting files: a.txt" "$C/state/tickets/base-feat-x.md" && grep -q "^## Base conflict fix try 1 of 2: feat/x" "$C/state/briefings/base-feat-x.md" && grep -q "Conflicting files: a.txt" "$C/state/briefings/base-feat-x.md"'
live; pass
check "DS-320 while the worker runs: no second try, the base is left to it" \
  '[ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [[ "$out" == *"conflict fix try 1 of 2 is merging main into feat/x"* ]] && [[ "$out" != *"by hand"* ]] && [ "$(origin_tip)" = "$tip" ]'
check "DS-320 while the worker runs: still nothing else spawns" '[ "$(grep -c "^T-1 " "$T/spawns")" = 0 ]'
rm -f "$T/agents.json"; resolve; ended "AUTOPILOT_DONE: pr=none jira=none"; pass
check "DS-320 AC2 the next pass finds the base current and clears the tries" \
  '[[ "$out" == *"try 1 of 2 on feat/x finished: pr=none jira=none"* ]] && [[ "$out" == *"feat/x is current with main again, after 1 fix try"* ]] && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ]'
check "DS-320 AC2 and spawns resume" '[ "$(grep -c "^T-1 " "$T/spawns")" = 1 ] && origin_has_main'

# AC4: a try whose worker left the base where it was is the last at that head: the person, with the
# files and what the try did.
: > "$T/spawns"; fresh bstuck; feature; fixrow yes; conflict; pass
ended "AUTOPILOT_PARK: both sides rewrite a.txt and neither can be kept"; pass
check "DS-320 AC4 a try that left the base where it was: put to the person" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"Conflicting files: a.txt. Still in conflict after 1 fix try; the last try parked: both sides rewrite a.txt and neither can be kept: resolve it by hand in $C/wt/base-feat-x and push"* ]]'
check "DS-320 AC4 and no second try starts" '[ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = null ]'

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
limit_event(){ node -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); e.rate_limit_info.resetsAt = Number(process.argv[2]); console.log(JSON.stringify(e))' "$S/fixtures/usage-limit-five-hour.provisional.json" "$1" >> "$C/state/logs/base-feat-x.log"; }
: > "$T/kills"; fresh bpause; feature; fixrow yes
conflict; pass; live; limit_event "$(( $(date +%s) + 3600 ))"
for _ in 1 2 3 4 5 6 7; do pass; done
check "DS-320 a worker paused on the usage limit is waited on, not wedged" \
  '[ ! -s "$T/kills" ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" != null ] && [[ "$out" == *"base-feat-x on the 5-hour usage limit until "*"then it resumes, or sooner once a probe call succeeds"* ]] && [[ "$out" != *"by hand"* ]]'
rm -f "$T/agents.json"
# Its session exits at the limit, as a headless worker's does: held until the limit lifts, never ended
# as no marker, then resumed in its own session as the same try, once per limit. The log is aged so the
# exit is not read as a worker the registry has not caught up with.
age_log(){ touch -t 202001010000 "$C/state/logs/base-feat-x.log"; }
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
probe_ok(){ printf '#!/bin/sh\nif [ "$1" = -p ]; then echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"ok\\"}"; exit 0; fi\ncat "%s/agents.json" 2>/dev/null || echo "[]"\n' "$T" > "$T/stub/claude"; }
probe_off(){ printf '#!/bin/sh\ncat "%s/agents.json" 2>/dev/null || echo "[]"\n' "$T" > "$T/stub/claude"; }
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

# An ordinary batch plan-batch seeded while feature.json still names the epic and a spine (here §4
# Acceptance specs is unset, so feature mode is off): a failed sync holds no spawns.
fresh planned; conflict; node "$B/queue.mjs" set-batch epic=E-1 >/dev/null; node "$B/queue.mjs" drop T-1 >/dev/null
echo '{"epic":"E-1","spine":"T-1"}' > "$C/state/feature.json"; mkdir -p "$C/state/triage"
echo '{"ticket":"T-1","type":"Task","lane":"A","branch":"feat/T-1","files_in_scope":["b.txt"],"unknowns":[],"links":"n/a"}' > "$C/state/triage/T-1.json"
printf '\n## 1. Identity\n| Field | Value |\n|---|---|\n| GitHub handle | `me` |\n| Jira display name | `Me` |\n' >> "$C/config.md"
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" T-1 2>&1)
check "plan-batch records an ordinary batch on the queue" '[ "$(jq -r .feature "$DESK_QUEUE")" = false ] && [ "$(jq -r ".tickets[\"T-1\"].state" "$DESK_QUEUE")" = triaged ]'
pass
check "feature.json naming a spine does not hold its spawns" '[[ "$out" == *"spawned: T-1"* ]] && [[ "$out" == *"spawning carries on"* ]]'

# AC6, AC7: a push refused by branch protection rolls back, and holds spawns only in feature mode.
fresh refused; printf '#!/bin/sh\necho "error: GH006: Protected branch update failed for refs/heads/feat/x." >&2\nexit 1\n' > "$C/origin.git/hooks/pre-receive"
chmod +x "$C/origin.git/hooks/pre-receive"; tip=$(origin_tip); pass
check "a refused push leaves origin alone"           '[ "$(origin_tip)" = "$tip" ]'
check "and names the reason"                         '[[ "$out" == *"the push to feat/x was refused"* ]] && [[ "$out" == *"GH006"* ]]'
check "and rolls the merge back locally"             "[ \"\$(git -C $BWT rev-parse HEAD)\" = \"$tip\" ]"
check "not feature mode: a refused push still spawns" '[[ "$out" == *"spawned: T-1"* ]]'
node "$B/queue.mjs" set T-1 state=triaged >/dev/null; feature; pass
check "feature mode: a refused push spawns nothing"  '[[ "$out" != *"spawned:"* ]] && [[ "$out" == *"refused"* ]]'

# AC6, AC7: the permission row.
fresh denied no; feature; tip=$(origin_tip); pass
check "batch-base-push no: nothing pushed"           '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"config §3 batch-base-push is \"no\""* ]]'
check "feature mode: the row refusing spawns nothing" '[[ "$out" != *"spawned:"* ]]'
fresh askit unset; tip=$(origin_tip); pass
check "unset reads as ask, and asks for the approval" '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"is \"ask\""* ]] && [[ "$out" == *"AUTOPILOT_BASE_PUSH_APPROVED=1"* ]]'
check "not feature mode: the row refusing still spawns" '[[ "$out" == *"spawned: T-1"* ]]'
fresh approved ask; out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" 2>&1)
check "ask with the approval syncs"                  'origin_has_main && [[ "$out" == *"merged 2 commit(s)"* ]]'
fresh typo nope; tip=$(origin_tip); out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" 2>&1)
check "a value the row cannot read is no, not ask"   '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"batch-base-push is \"no\""* ]]'

# A production base written into the queue by hand is refused on read, before anything is pushed.
fresh prod; git -C "$C/repo" push -q origin origin/feat/x:refs/heads/production
tip=$(git -C "$C/origin.git" rev-parse production)
node -e 'const f = process.argv[1]; const q = JSON.parse(require("fs").readFileSync(f, "utf8")); q.base = "production"; require("fs").writeFileSync(f, JSON.stringify(q))' "$DESK_QUEUE"
pass
check "a production base in the queue is refused"    '[ $rc -eq 11 ] && [[ "$out" == *"is a production branch"* ]] && [ "$(git -C "$C/origin.git" rev-parse production)" = "$tip" ] && [ ! -e "$C/wt/base-production" ]'

# AC5: a push refused as non-fast-forward is fetched, merged again and retried once.
fresh race; git clone -q "$C/origin.git" "$C/other"; git -C "$C/other" switch -q feat/x; echo "$C/other" > "$T/race.arm"; pass
check "a non-fast-forward push is retried and lands" 'origin_has_main && git -C "$C/origin.git" log --format=%s feat/x | grep -qx "merged by the driver"'
check "the report says it retried"                   '[[ "$out" == *"fetched, merged again, retried once"* ]] && [[ "$out" == *"spawned: T-1"* ]]'

# AC8: a primary checkout on the base gets no worktree and no sync.
fresh primary; git -C "$C/repo" switch -q feat/x; tip=$(origin_tip); pass
check "primary on the base: no base worktree"        '[ ! -e "$C/wt/base-feat-x" ]'
check "and no sync"                                   '[ "$(origin_tip)" = "$tip" ]'
check "and the report says to switch it off"         '[[ "$out" == *"switch the primary checkout off feat/x"* ]]'
node "$B/queue.mjs" set T-1 state=done >/dev/null; pass
check "it is reported even on a pass that spawns nothing" '[[ "$out" == *"switch the primary checkout off feat/x"* ]]'

# Baseline checks: tc.sh stands in for §4 Typecheck, printing errors.txt as tsc would and failing when it
# holds any error. baseline <case> [on|off] [base]: fresh, with that row and the toolchain rows set.
baseline(){
  fresh "$1" yes "${3:-feat/x}"
  printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Install | `none` |\n| Typecheck | `sh tc.sh` |\n| Lint | `none` |\n| Baseline checks | `%s` |\n' "${2:-on}" >> "$C/config.md"
  git clone -q "$C/origin.git" "$C/seed"; git -C "$C/seed" switch -q feat/x
  printf 'cat errors.txt\n! grep -q error errors.txt\n' > "$C/seed/tc.sh"
  printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n" > "$C/seed/errors.txt"
  git -C "$C/seed" add tc.sh errors.txt; git -C "$C/seed" commit -q -m "a base with an error"; git -C "$C/seed" push -q origin feat/x
}
mkdir -p "$T/lock"; export DESK_LOCK_DIR="$T/lock"; ln -s "$B/with-lock.sh" "$T/desk/bin/with-lock.sh"
DESK_ENV="node $B/desk-env.mjs"

# AC1: the first pass that spawns records the base's errors, gives the count, and briefs the worker.
baseline record; pass
check "AC1 the base's errors are recorded"            '[ "$(jq -r ".checks.typecheck[0].count" "$C/state/baseline.json")" = 1 ] && [ "$(jq -r .base "$C/state/baseline.json")" = feat/x ]'
check "AC1 at the synced base's head"                 "[ \"\$(jq -r .sha \"\$C/state/baseline.json\")\" = \"\$(git -C $BWT rev-parse HEAD)\" ]"
check "AC1 the report gives the counts"               '[[ "$out" == *"baseline: recorded feat/x at "*": typecheck 1 error(s)"* ]]'
check "the worker is told to check against it"        'grep -q "## Baseline checks" "$C/state/briefings/T-1.md" && grep -q "desk-env baseline typecheck" "$C/state/briefings/T-1.md"'
check "the base worktree is left clean"               "[ -z \"\$(git -C $BWT status --porcelain)\" ]"
node "$B/queue.mjs" add T-2 >/dev/null; node "$B/queue.mjs" set T-2 state=triaged >/dev/null; pass
check "a base that has not moved is not recorded again" '[[ "$out" == *"spawned: T-2"* ]] && [[ "$out" != *"baseline: recorded"* ]]'

# AC2, AC3, AC4: a worker's check, in its own clone of the base.
git clone -q "$C/origin.git" "$C/w1"; git -C "$C/w1" switch -q feat/x; cd "$C/w1" || exit 1
wcheck(){ out=$(DESK_DEFAULT_BRANCH=feat/x $DESK_ENV baseline typecheck 2>&1); rc=$?; }
printf "src/a.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n" > errors.txt; wcheck
check "AC2 only the recorded error, moved: the check passes" '[ $rc -eq 0 ] && [[ "$out" == *"PASS sh tc.sh: only the 1 error(s) the base already has"* ]]'
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nlib/other.ts(1,1): error TS2304: Cannot find name 'x'.\nFound 2 errors.\n" > errors.txt; wcheck
check "AC3 a new error in another file fails and is named" '[ $rc -eq 1 ] && [[ "$out" == *"FAIL sh tc.sh: 1 new error(s)"* ]] && [[ "$out" == *"lib/other.ts:1  TS2304  Cannot find name '"'x'"'."* ]]'
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/a.ts(4,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 2 errors.\n" > errors.txt; wcheck
check "AC4 a second identical error fails on the extra one" '[ $rc -eq 1 ] && [[ "$out" == *"src/a.ts:4  TS2322"* ]] && [[ "$out" != *"src/a.ts:3"* ]]'
printf 'tsc: out of memory\n' > errors.txt; printf 'cat errors.txt\nexit 134\n' > tc.sh; wcheck
check "AC6 unreadable output runs the full check and says so" '[ $rc -eq 1 ] && [[ "$out" == *"FULL sh tc.sh: this run'"'"'s output could not be read"* ]] && [[ "$out" == *"tsc: out of memory"* ]]'
git checkout -q -- .; cd "$C/repo" || exit 1

# AC5: a sync that brings commits into the base takes the baseline again before the next spawn.
git -C "$C/repo" fetch -q origin; git -C "$C/repo" switch -q main; git -C "$C/repo" merge -q --no-edit origin/feat/x
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(1,1): error TS2304: Cannot find name 'y'.\nFound 2 errors.\n" > "$C/repo/errors.txt"
git -C "$C/repo" commit -q -am "main adds an error"; git -C "$C/repo" push -q origin main
node "$B/queue.mjs" set T-1 state=done >/dev/null; node "$B/queue.mjs" set T-2 state=done >/dev/null
node "$B/queue.mjs" add T-3 >/dev/null; node "$B/queue.mjs" set T-3 state=triaged >/dev/null; pass
check "AC5 the sync merged"                           '[[ "$out" == *"base sync: merged"* ]]'
check "AC5 and the baseline is taken again first"     '[[ "$out" == *"baseline: recorded feat/x at "*": typecheck 2 error(s)"* ]] && [ "$(jq -r ".checks.typecheck[0].count" "$C/state/baseline.json")" = 2 ]'
check "AC5 the worker is briefed on the new baseline" 'grep -q "typecheck 2 error(s)" "$C/state/briefings/T-3.md"'

# The base moved on origin (the merge driver merged a PR into it) while a stray file kept the base
# worktree from catching up: it is not recorded, and leaves no baseline to compare against.
echo stray > "$C/wt/base-feat-x/stray.txt"
git -C "$C/seed" pull -q --no-rebase origin feat/x; git -C "$C/seed" commit -q --allow-empty -m "merged by the driver"; git -C "$C/seed" push -q origin feat/x
node "$B/queue.mjs" set T-3 state=done >/dev/null
node "$B/queue.mjs" add T-4 >/dev/null; node "$B/queue.mjs" set T-4 state=triaged >/dev/null; pass
check "a base worktree behind origin drops the baseline" '[ ! -e "$C/state/baseline.json" ] && [[ "${out#*WAITING ON YOU}" == *"baseline: not recorded"*"is not at origin'"'"'s feat/x"* ]] && ! grep -q "## Baseline checks" "$C/state/briefings/T-4.md"'

# AC7: off, or no base, checks as today.
baseline off off; pass
check "AC7 off: nothing is recorded"                  '[ ! -e "$C/state/baseline.json" ] && [[ "$out" != *"baseline"* ]] && [[ "$out" == *"spawned: T-1"* ]]'
check "AC7 off: no baseline section in the briefing"  '! grep -q "## Baseline checks" "$C/state/briefings/T-1.md"'
cd "$C/seed" || exit 1; out=$(DESK_DEFAULT_BRANCH=feat/x $DESK_ENV baseline typecheck 2>&1); rc=$?; cd "$C/repo" || exit 1
check "AC7 off: the worker's check is the full check" '[ $rc -eq 1 ] && [[ "$out" == *"baseline: off (config §4 Baseline checks is \"off\", not on): the full check"* ]] && [[ "$out" == *"FAIL sh tc.sh (exit 1)"* ]]'
fresh nobase-on yes -; printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Typecheck | `sh tc.sh` |\n| Baseline checks | `on` |\n' >> "$C/config.md"; pass
check "AC7 no base: nothing is recorded"              '[ ! -e "$C/state/baseline.json" ] && [[ "$out" == *"spawned: T-1"* ]] && ! grep -q "## Baseline checks" "$C/state/briefings/T-1.md"'

# A dry run probes and pushes nothing.
fresh dry; tip=$(origin_tip); out=$(AUTOPILOT_DRY_RUN=1 node "$B/pass.mjs" 2>&1)
check "a dry run pushes nothing and says what it would merge" '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"would merge 2 commit(s)"* ]]'

echo "base sync: $PASS passed, $FAIL failed"; cd /; rm -rf "$T"; [ "$FAIL" -eq 0 ]
