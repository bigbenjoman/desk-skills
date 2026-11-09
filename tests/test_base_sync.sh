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
  AUTOPILOT_USER_APPROVED AUTOPILOT_BASE_PUSH_APPROVED DESK_GH_REPO DESK_GITHUB_HANDLE CLAUDE_CONFIG_DIR DESK_SUBSCRIPTIONS
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

# A live base conflict fix holds one worker, counted once. holding <case> <concurrency row> <batch's
# number> [machine cap] [another running ticket's session]: not feature mode, one ready ticket, the
# fix's session live, borrowing on.
holding(){
  : > "$T/spawns"; fresh "$1"
  printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `%s` |\n| Borrow idle workers | `off` | `on` |\n' "$2" >> "$C/config.md"
  node "$B/queue.mjs" set-batch "concurrency=$3" 'base_fix={"tries":[{"try":1,"head":"abc"}],"running":"sid-fix","port":3510}' >/dev/null
  mkdir -p "$C/state/logs"; : > "$C/state/logs/base-feat-x.log"
  [ -z "${5:-}" ] || { node "$B/queue.mjs" add T-0 >/dev/null; node "$B/queue.mjs" set T-0 state=running branch=feat/T-0 "session_id=$5" >/dev/null; }
  jq -n --arg s "${5:-}" '[{sessionId: "sid-fix", pid: 1}] + (if $s == "" then [] else [{sessionId: $s, pid: 1}] end)' > "$T/agents.json"
  printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / %s` | x |\n' "${4:-10}" > "$C/machine.md"
  DESK_MACHINE="$C/machine.md" pass
  rm -f "$T/agents.json"
}
holding bslot '3 / 3' 2
check "DS-519 AC1 a live base fix and one free repo slot: the ready ticket starts" '[ "$(grep -c "^T-1 " "$T/spawns")" = 1 ] && [[ "$out" == *"spawned: T-1"* ]]'
holding bborrow '2 / 3' 2 10 sid-t0
check "DS-519 AC1 a slot borrowed above the batch's own number starts it too" '[ "$(grep -c "^T-1 " "$T/spawns")" = 1 ]'
check "DS-519 AC1 and the report counts it as borrowed, the base fix among the running" '[[ "$out" == *"borrowing: 1 worker borrowed this pass, 1 above the batch'"'"'s own number of 2 (machine 10: 2 running"* ]]'
holding bone '1 / 1' 1
check "DS-519 AC2 a batch of 1: the base fix holds its one worker, and no ticket starts" '[ ! -s "$T/spawns" ] && [[ "$out" == *"conflict fix try 1 of 2 is merging main into feat/x"* ]]'
holding bonecap '1 / 2' 1
check "DS-519 AC2 a batch of 1 with room to borrow: still no ticket, and no borrowing reported" '[ ! -s "$T/spawns" ] && [[ "$out" != *"may be borrowed"* ]] && [[ "$out" != *"borrowed this pass"* ]]'
: > "$T/spawns"; fresh bstartone; fixrow yes; conflict
printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `1 / 2` |\n| Borrow idle workers | `off` | `on` |\n' >> "$C/config.md"
node "$B/queue.mjs" add T-2 >/dev/null; node "$B/queue.mjs" set T-2 state=triaged branch=feat/T-2 >/dev/null
node "$B/queue.mjs" set-batch concurrency=1 >/dev/null
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n' > "$C/machine.md"
DESK_MACHINE="$C/machine.md" pass
check "DS-519 AC2 the pass that starts the fix in a batch of 1: the fix starts, and no ticket borrows beside it" 'grep -q "^base-feat-x " "$T/spawns" && ! grep -q "^T-" "$T/spawns"'
holding bmachine '3 / 3' 2 1
check "DS-519 AC3 a machine cap with no room: no ticket starts" '[ ! -s "$T/spawns" ]'
: > "$T/spawns"; fresh bnofix
node "$B/queue.mjs" add T-2 >/dev/null; node "$B/queue.mjs" set T-2 state=triaged branch=feat/T-2 >/dev/null
node "$B/queue.mjs" add T-3 >/dev/null; node "$B/queue.mjs" set T-3 state=triaged branch=feat/T-3 >/dev/null
node "$B/queue.mjs" set-batch concurrency=2 >/dev/null; pass
check "DS-519 AC4 with no base fix a batch of 2 starts 2 of 3 ready" '[ "$(grep -c "^T-" "$T/spawns")" = 2 ]'

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
limit_event(){ node -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); e.rate_limit_info.resetsAt = Number(process.argv[2]); console.log(JSON.stringify(e))' "$S/fixtures/usage-limit-five-hour.json" "$1" >> "$C/state/logs/base-feat-x.log"; }
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

# DS-521: with more than one login, a base worker try (a conflict fix or an epic PR review) whose
# session exited at one login's limit carries on as a fresh session on another, in the base worktree,
# as the same try. logins <names>: the subscriptions file lists each (`default` is ~/.claude, `b` is
# ~/.claude-logins/b), all in rotation. A folder listed in $LIM, as `<folder> <reset>`, is at its
# limit: its preflight and its probe are refused. The spawn line records the login it was given.
LB="$HOME/.claude-logins/b"; LD="$HOME/.claude"; LIM="$T/limited"
mkdir -p "$LD" "$T/usage"
export DESK_USAGE_DIR="$T/usage"
# Only the listed logins' folders exist: a folder under ~/.claude-logins is a login whether listed or not.
logins(){
  rm -rf "$HOME/.claude-logins"
  printf '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n' > "$T/subs.md"
  for n in "$@"; do [ "$n" = default ] || mkdir -p "$HOME/.claude-logins/$n"; printf '| `claude` | `%s` | `%s` | `in rotation` |\n' "$n" "$([ "$n" = default ] && echo '~/.claude' || echo "~/.claude-logins/$n")" >> "$T/subs.md"; done
  export DESK_SUBSCRIPTIONS="$T/subs.md"
}
cat > "$T/stub/claude" <<EOF
#!/bin/sh
d="\${CLAUDE_CONFIG_DIR:-$LD}"
case "\$1" in
  auth) printf '{"loggedIn":true,"email":"%s@example.com"}\n' "\$(basename "\$d")" ;;
  -p) r=\$(grep -F "\$d " "$LIM" 2>/dev/null | head -n 1 | cut -d' ' -f2)
    if [ -n "\$r" ]; then printf '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":%s}}\n' "\$r"; echo '{"type":"result","is_error":true}'; exit 1; fi
    echo '{"type":"result","is_error":false}' ;;
  *) cat "$T/agents.json" 2>/dev/null || echo "[]" ;;
esac
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
ld="\${AUTOPILOT_LOGIN_DIR:-$LD}"
if [ "\$3" = preflight ]; then if grep -qF "\$ld " "$LIM" 2>/dev/null; then echo "[preflight] usage-limit: the account is at its usage limit"; else echo "[preflight] pass"; fi
else echo "\$1 \$2 login=\${AUTOPILOT_LOGIN_DIR-unset} \${AUTOPILOT_TASK:-}\${AUTOPILOT_RESUME:+RESUME session=\$3}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF
# A try of each kind, as base_fix records it, running as session sid-old.
TRY_conflict='{"try":1,"head":"abc","source":"def","files":["a.txt"],"at":"2026-11-09T00:00:00Z","session":"sid-old"}'
TRY_review='{"kind":"review","try":1,"head":"abc","pr":300,"at":"2026-11-09T00:00:00Z","session":"sid-old"}'
WHAT_conflict='conflict fix try 1 of 2 on feat/x'; WHAT_review='epic PR review try 1 of 2 on feat/x, PR #300'
TASK_conflict='Your task is conflict fix try 1 of 2 on feat/x'; TASK_review='It is epic PR #300'
HEAD_conflict='## Base conflict fix try 1 of 2: feat/x'; HEAD_review='## Epic PR review try 1 of 2: #300'
# stopped <case> <kind> [login folder]: the try's session, on login b unless given, exited at that
# login's 5-hour limit, an hour off, in the base worktree on feat/x.
stopped(){
  : > "$T/spawns"; rm -f "$T/agents.json"; fresh "$1"; feature; fixrow yes
  git -C "$C/repo" fetch -q origin; git -C "$C/repo" worktree add -q --track -b feat/x "$C/wt/base-feat-x" origin/feat/x
  local try="TRY_$2"
  node "$B/queue.mjs" set-batch "base_fix={\"tries\":[${!try}],\"running\":\"sid-old\",\"port\":3510}" >/dev/null
  mkdir -p "$C/state/logs" "$C/state/workers"
  local on=${3:-$LB}
  [ "$on" = "$LD" ] || printf '{"login":"b","config_dir":"%s"}\n' "$on" > "$C/state/workers/base-feat-x.login.json"
  limit_event "$(( $(date +%s) + 3600 ))"; age_log
  echo "$on $(( $(date +%s) + 3600 ))" > "$LIM"
}
bench_default(){ node "$B/queue.mjs" set-batch "benched={\"default\":{\"login\":\"default\",\"config_dir\":null,\"type\":\"five_hour\",\"resets_at\":$(( $(date +%s) + 7200 )),\"since\":\"2026-11-09T00:00:00Z\",\"by\":\"T-9\"}}" >/dev/null; echo "$LD $(( $(date +%s) + 7200 ))" >> "$LIM"; }
for kind in conflict review; do
  what="WHAT_$kind"; task="TASK_$kind"; head="HEAD_$kind"; what=${!what}; task=${!task}; head=${!head}
  # AC1, AC2: login b at its limit, the default login with room.
  logins default b; stopped "m1$kind" "$kind"; pass
  check "DS-521 AC1 $kind: a fresh session carries on the try on the other login, in the base worktree" \
    '[ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && grep -q "^base-feat-x $C/wt/base-feat-x login=unset .*$task" "$T/spawns" && ! grep -q RESUME "$T/spawns" && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" != sid-old ]'
  check "DS-521 AC1 $kind: its briefing says it moved logins, with the try's own brief" \
    'grep -q "^## Moved logins: this session starts its task again" "$C/state/briefings/base-feat-x.md" && grep -q "stopped at the 5-hour usage limit on login b" "$C/state/briefings/base-feat-x.md" && grep -qF "$head" "$C/state/briefings/base-feat-x.md"'
  check "DS-521 AC1 $kind: the base fix record names the login, and b stays benched" \
    '[ "$(jq -r .base_fix.login.name "$DESK_QUEUE")" = default ] && [ "$(jq -r ".benched.b.login" "$DESK_QUEUE")" = b ]'
  check "DS-521 AC1 $kind: the pass report says it moved logins" \
    '[[ "$out" == *"base-feat-x port="*" login=default ($what), moved logins from b, at the 5-hour usage limit;"* ]]'
  check "DS-521 AC2 $kind: the move is not a try, and the try number stays the same" \
    '[ "$(jq -r ".base_fix.tries | length" "$DESK_QUEUE")" = 1 ] && [ "$(jq -r ".base_fix.tries[0].try" "$DESK_QUEUE")" = 1 ] && [ "$(jq -r ".base_fix.tries[0].session" "$DESK_QUEUE")" = "$(jq -r .base_fix.running "$DESK_QUEUE")" ] && [ "$(jq -r ".base_fix.tries[0].outcome" "$DESK_QUEUE")" = null ]'
  # AC3: uncommitted changes in the base worktree stay, and the briefing names them.
  logins default b; stopped "m3$kind" "$kind"; echo half > "$C/wt/base-feat-x/a.txt"; echo new > "$C/wt/base-feat-x/new.txt"; pass
  check "DS-521 AC3 $kind: the worktree keeps the changes" '[ "$(cat "$C/wt/base-feat-x/a.txt")$(cat "$C/wt/base-feat-x/new.txt")" = halfnew ]'
  check "DS-521 AC3 $kind: the briefing and the report say they are there" \
    'grep -q "^### Uncommitted changes in your worktree" "$C/state/briefings/base-feat-x.md" && grep -qF -- "- \` M a.txt\`" "$C/state/briefings/base-feat-x.md" && grep -qF -- "- \`?? new.txt\`" "$C/state/briefings/base-feat-x.md" && [[ "$out" == *"keeping 2 uncommitted change(s)"* ]]'
  # AC4: every other login benched. It waits on its own, then resumes its own session there once b is back.
  logins default b; stopped "m4$kind" "$kind"; bench_default; pass
  check "DS-521 AC4 $kind: with every other login benched it waits on its own" \
    '[ ! -s "$T/spawns" ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = sid-old ] && [ "$(jq -r ".benched | keys | join(\",\")" "$DESK_QUEUE")" = b,default ] && [[ "$out" == *"base-feat-x on the 5-hour usage limit until "* ]]'
  echo "$LD $(( $(date +%s) + 7200 ))" > "$LIM"; limit_event "$(( $(date +%s) - 60 ))"; age_log; pass
  check "DS-521 AC4 $kind: once b is back it resumes its own session there, as today" \
    'grep -q "^base-feat-x $C/wt/base-feat-x login=$LB .*RESUME session=sid-old" "$T/spawns" && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [ "$(jq -r ".base_fix.tries | length" "$DESK_QUEUE")" = 1 ]'
  # The login it would move to is refused at its preflight: it goes back to waiting on its own.
  logins default b; stopped "m6$kind" "$kind"; echo "$LD $(( $(date +%s) + 7200 ))" >> "$LIM"; pass
  check "DS-521 $kind: a move refused on the other login waits on its own, with no try ended" \
    '[ ! -s "$T/spawns" ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = sid-old ] && [ "$(jq -r ".base_fix.tries[0].outcome" "$DESK_QUEUE")" = null ] && [[ "$out" == *"base-feat-x: not moved off login b, as login default was refused at the limit too"* ]]'
  # AC5: one login. It is held and resumed exactly as today.
  logins default; stopped "m5$kind" "$kind" "$LD"; pass
  check "DS-521 AC5 $kind: one login: it waits, nothing benched or moved" \
    '[ ! -s "$T/spawns" ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = sid-old ] && [ "$(jq -r .benched "$DESK_QUEUE")" = null ] && [[ "$out" == *"base-feat-x on the 5-hour usage limit until "* ]]'
  : > "$LIM"; limit_event "$(( $(date +%s) - 60 ))"; age_log; pass
  check "DS-521 AC5 $kind: one login: once the limit lifts it resumes its own session" 'grep -q "^base-feat-x .* login=unset .*RESUME session=sid-old" "$T/spawns"'
done
unset DESK_SUBSCRIPTIONS; rm -f "$LIM"; probe_off
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1 \$2 \${AUTOPILOT_BRANCH:-} \${AUTOPILOT_TASK:-}\${AUTOPILOT_RESUME:+RESUME session=\$3 \$AUTOPILOT_RESUME}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF

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

# A supervised batch under ask is asked once on the queue (needs-you's base-push item), never
# listed as waiting, so no decider is handed it each pass. Its approval syncs this and every later pass.
spass(){ out=$(node "$B/pass.mjs" --json --by supervisor 2>/dev/null); }
waits_base(){ jq -e '[.waiting[] | select(test("base sync"))] | length > 0' <<<"$out" >/dev/null; }
fresh supask ask; feature; tip=$(origin_tip); spass; since=$(jq -r .base_push_ask.since "$DESK_QUEUE")
check "DS-403 AC1 a supervised pass under ask records one ask on the queue" '[ "$(origin_tip)" = "$tip" ] && [ "$(jq -r .base_push_ask.base "$DESK_QUEUE")" = feat/x ] && [ "$(jq -r .base_push_ask.source "$DESK_QUEUE")" = main ]'
check "DS-403 AC1 nothing waits on you for it, and the report says where it is asked" '! waits_base && [[ "$(jq -r .message <<<"$out")" == *"asked once for the batch in /desk-needs-you"* ]]'
check "DS-403 AC1 feature mode still spawns nothing on it"  '[[ "$(jq -r .message <<<"$out")" != *"spawned:"* ]]'
spass
check "DS-403 AC1 the next pass keeps the same ask"   '[ "$(jq -r .base_push_ask.since "$DESK_QUEUE")" = "$since" ] && ! waits_base && [ "$(origin_tip)" = "$tip" ]'
node "$B/queue.mjs" set-batch "gate={\"state\":\"failed\",\"sha\":\"$tip\",\"failures\":[\"feat/x is behind main, so it was not synced\"]}" >/dev/null
spass
check "DS-403 AC1 a failed base gate waits on the ask, not in the waiting list" \
  '[[ "$(jq -r .message <<<"$out")" == *"BASE GATE: waits on the base sync, asked once for the batch in /desk-needs-you"* ]] && [ "$(jq "[.waiting[] | select(startswith(\"BASE GATE\"))] | length" <<<"$out")" = 0 ]'
node "$B/queue.mjs" set-batch gate=null >/dev/null
node "$B/queue.mjs" set-batch approved.base_push=true >/dev/null
out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" --json --by supervisor 2>/dev/null)
check "DS-403 AC2 approved, the next pass merges main in" 'origin_has_main && [[ "$(jq -r .message <<<"$out")" == *"merged 2 commit(s)"* ]]'
check "DS-403 AC2 the approval stays on the queue and the ask is cleared" '[ "$(jq -r .approved.base_push "$DESK_QUEUE")" = true ] && [ "$(jq -r .base_push_ask "$DESK_QUEUE")" = null ]'
git -C "$C/repo" commit -q --allow-empty -m three; git -C "$C/repo" push -q origin main
node "$B/queue.mjs" set T-1 state=triaged >/dev/null
out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" --json --by supervisor 2>/dev/null)
check "DS-403 AC3 behind again, it syncs with no new ask" 'origin_has_main && [[ "$(jq -r .message <<<"$out")" == *"merged 1 commit(s)"* ]] && [ "$(jq -r .base_push_ask "$DESK_QUEUE")" = null ]'
fresh supno no; feature; tip=$(origin_tip); spass
check "DS-403 AC4 batch-base-push no: nothing synced and no ask raised" '[ "$(origin_tip)" = "$tip" ] && [ "$(jq -r .base_push_ask "$DESK_QUEUE")" = null ] && waits_base'
fresh sesask ask; tip=$(origin_tip); out=$(node "$B/pass.mjs" --json 2>/dev/null)
check "DS-403 a session's pass under ask still waits on its session, with no queue ask" '[ "$(jq -r .base_push_ask "$DESK_QUEUE")" = null ] && waits_base'

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

# DS-416: a base cut before main added feat/** to the CI trigger. gh serves PR #801 into feat/x with
# its required check "tests" unreported, and ci.yml at three refs: the PR's head as written below,
# the base from $T/basewf and main from $T/mainwf. The base head is $T/bhead. Every gh call is logged to $T/ghlog.
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/ghlog"
case "\$1 \$2" in
  "pr view") printf '{"state":"%s","url":null,"isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","headRefOid":"h1","headRefName":"feat/T-1","baseRefName":"feat/x","baseRefOid":"%s","statusCheckRollup":[{"name":"Vercel","status":"COMPLETED","conclusion":"SUCCESS"}]}\n' "\$(cat "$T/prstate" 2>/dev/null || echo OPEN)" "\$(cat "$T/bhead")"; exit 0 ;;
  "pr close") echo CLOSED > "$T/prstate"; exit 0 ;;
  "pr reopen") [ -e "$T/reopenfail" ] && { echo "HTTP 502" >&2; exit 1; }; echo OPEN > "$T/prstate"; exit 0 ;;
esac
case "\$*" in
  *"workflows?ref="*--jq*) echo .github/workflows/ci.yml ;;
  *"ci.yml?ref=h1"*) printf 'on:\n  pull_request:\n    branches: [main]\njobs:\n  tests:\n    runs-on: x\n' ;;
  *"ci.yml?ref=feat%2Fx"*) printf 'on:\n  pull_request:\n    branches: %s\njobs:\n  tests:\n    runs-on: x\n' "\$(cat "$T/basewf")" ;;
  *"ci.yml?ref=main"*) printf 'on:\n  pull_request:\n    branches: %s\njobs:\n  tests:\n    runs-on: x\n' "\$(cat "$T/mainwf")" ;;
esac
exit 0
EOF
chmod +x "$T/stub/gh"
reopens(){ grep -c "^pr reopen 801" "$T/ghlog" 2>/dev/null || true; }
fresh stale416; echo "[main, 'feat/**']" > "$T/mainwf"
printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Required checks | `tests` |\n' >> "$C/config.md"
node "$B/queue.mjs" set T-1 state=done result.pr=801 >/dev/null
echo '[main]' > "$T/basewf"; echo b1 > "$T/bhead"; : > "$T/ghlog"; tip=$(origin_tip); pass
check "DS-416 the PR's check only main's workflow runs on the base is recorded as behind" \
  '[ "$(jq -r ".tickets[\"T-1\"].pr_status.behind.tests" "$DESK_QUEUE")" != null ] && [ "$(jq -r ".tickets[\"T-1\"].pr_status.untriggered" "$DESK_QUEUE")" = null ] && [ "$(reopens)" = 0 ]'
check "DS-416 nothing synced before the pass that read it" '[ "$(origin_tip)" = "$tip" ]'
# The sync brings main's trigger to the base, which gh's base copy stands in for.
echo "[main, 'feat/**']" > "$T/basewf"; pass
check "DS-416 AC2 with nothing to spawn, the base syncs for the PR's CI" 'origin_has_main && [[ "$out" == *"merged 2 commit(s) from main into feat/x and pushed; PR #801 is reopened so CI runs"* ]] && [[ "$out" != *"spawned:"* ]]'
check "DS-416 AC4 the PR is closed and reopened, and the base head recorded" \
  'grep -q "^pr close 801" "$T/ghlog" && [ "$(reopens)" = 1 ] && [ "$(jq -r .reopened_at "$DESK_QUEUE")" = b1 ] && [[ "$out" == *"closed and reopened PR #801 (T-1)"* ]]'
pass
check "DS-416 AC4 once per base head: the next pass at b1 does not reopen it again" '[ "$(reopens)" = 1 ]'
echo b2 > "$T/bhead"; pass
check "DS-416 AC4 a new base head reopens it once more" '[ "$(reopens)" = 2 ] && [ "$(jq -r .reopened_at "$DESK_QUEUE")" = b2 ]'
check "DS-416 a reopened PR is marked so until the next pass reads it" \
  '[ "$(jq -r ".tickets[\"T-1\"].pr_status.reopened" "$DESK_QUEUE")" = true ] && [ "$(jq -r ".tickets[\"T-1\"].reopening" "$DESK_QUEUE")" = null ]'
closes(){ grep -c "^pr close 801" "$T/ghlog" 2>/dev/null || true; }
# A reopen that fails leaves the PR closed: the ticket owes it, and the next pass reopens it.
echo b3 > "$T/bhead"; touch "$T/reopenfail"; pass
check "DS-416 a failed reopen is owed on the ticket and said, the head still recorded" \
  '[ "$(cat "$T/prstate")" = CLOSED ] && [ "$(jq -r ".tickets[\"T-1\"].reopening" "$DESK_QUEUE")" = 801 ] && [ "$(jq -r .reopened_at "$DESK_QUEUE")" = b3 ] && [[ "$out" == *"PR #801 (T-1) is closed, to start its CI, and did not reopen"* ]]'
c=$(closes); out=$(node "$B/pass.mjs" --json 2>/dev/null)
check "DS-416 a second failed reopen records the PR closed and still owed" \
  '[ "$(jq -r ".tickets[\"T-1\"].pr_status.state" "$DESK_QUEUE")" = CLOSED ] && [ "$(jq -r ".tickets[\"T-1\"].reopening" "$DESK_QUEUE")" = 801 ] && [ "$(closes)" = "$c" ]'
check "DS-416 a batch whose last PR is closed and owed its reopen is not idle" '[ "$(printf "%s" "$out" | jq -r .status)" = show_person ]'
rm -f "$T/reopenfail"; pass
check "DS-416 the next pass reads the closed PR again and reopens it without closing it again" \
  '[ "$(cat "$T/prstate")" = OPEN ] && [ "$(closes)" = "$c" ] && [ "$(jq -r ".tickets[\"T-1\"].reopening" "$DESK_QUEUE")" = null ] && [[ "$out" == *"closed and reopened PR #801 (T-1)"* ]]'
c=$(closes); r=$(reopens); pass
check "DS-416 once reopened, the same base head does not close it again" '[ "$(closes)" = "$c" ] && [ "$(reopens)" = "$r" ]'
fresh trig416 yes; printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Required checks | `tests` |\n' >> "$C/config.md"
node "$B/queue.mjs" set T-1 state=done result.pr=801 >/dev/null
echo '[main]' > "$T/basewf"; echo '[main]' > "$T/mainwf"; : > "$T/ghlog"; tip=$(origin_tip); pass; pass
check "DS-416 AC5 a check main's workflow does not run on the base either is untriggered: no sync, no reopen" \
  '[ "$(jq -r ".tickets[\"T-1\"].pr_status.untriggered.tests" "$DESK_QUEUE")" != null ] && [ "$(origin_tip)" = "$tip" ] && [ "$(reopens)" = 0 ]'

# DS-508: an epic batch not in feature mode lands its base through one epic PR, opened once every child
# has merged. gh serves each PR from $T/ep/<n>.json and its GraphQL review read from $T/ep/<n>.graphql;
# `pr create` opens #300 (refused while $T/ep/create.fail exists), and `pr ready` takes it out of draft.
mkdir -p "$T/ep"
cat > "$T/stub/gh" <<EOF
#!$(node -p process.execPath)
const fs = require('fs');
const a = process.argv.slice(2);
const at = (f) => a[a.indexOf(f) + 1];
fs.appendFileSync('$T/ghlog', a.join(' ') + '\n');
const file = (n, ext = 'json') => '$T/ep/' + n + '.' + ext;
if (a[0] === 'pr' && a[1] === 'view' && fs.existsSync(file(a[2]))) {
  const p = JSON.parse(fs.readFileSync(file(a[2]), 'utf8'));
  console.log(at('--jq') === '.state' ? p.state : JSON.stringify(p));
} else if (a[0] === 'pr' && a[1] === 'create') {
  if (fs.existsSync('$T/ep/create.fail')) { console.error('GraphQL: Resource not accessible by integration'); process.exit(1); }
  fs.writeFileSync(file(300), JSON.stringify({ state: 'OPEN', isDraft: a.includes('--draft'), headRefOid: 'e'.repeat(40) }));
  console.log('https://github.com/acme/widgets/pull/300');
} else if (a[0] === 'pr' && a[1] === 'ready') {
  const p = JSON.parse(fs.readFileSync(file(a[2]), 'utf8')); p.isDraft = false; fs.writeFileSync(file(a[2]), JSON.stringify(p));
} else if (a[0] === 'api' && a.includes('graphql')) {
  const n = (a.find((x) => x.startsWith('n=')) ?? '').slice(2);
  if (fs.existsSync(file(n, 'graphql'))) process.stdout.write(fs.readFileSync(file(n, 'graphql'), 'utf8'));
}
EOF
chmod +x "$T/stub/gh"
# review <counts, or - for none>: PR #300's GraphQL read, with the user's desk-review at its head.
EH=$(printf 'e%.0s' $(seq 1 40))
review(){ node -e 'const [f, sha, c] = process.argv.slice(1);
  const nodes = c === "-" ? [] : [{ id: "R1", author: { login: "tester" }, commit: { oid: sha }, body: ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${sha} ${c} vendor=codex round=1 -->`].join("\n") }];
  require("fs").writeFileSync(f, JSON.stringify({ data: { repository: { pullRequest: { headRefOid: sha, reviewDecision: null, reviews: { nodes }, reviewThreads: { nodes: [] } } } } }));' "$T/ep/300.graphql" "$EH" "$1"; }
epicrows(){ printf '| `pr-open` | Open a draft PR | `yes` | `yes` |\n| `pr-ready` | Undraft | `yes` | `yes` |\n| `pr-conflict-unreviewed` | Resolve a conflict | `yes` | `yes` |\n' >> "$C/config.md"
  printf '\n## 1. Who you are\n| Field | Value |\n|---|---|\n| GitHub handle | `tester` |\n\n## 4. Tools\n| Field | Value |\n|---|---|\n| Local review command | `/desk-review` |\n| Clean review verdict | `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0` |\n' >> "$C/config.md"; }
fresh epic508; epicrows; rm -f "$T/ep"/*; : > "$T/spawns"; : > "$T/ghlog"; rm -f "$T/agents.json"
node "$B/queue.mjs" set-batch epic=E-8 feature=false >/dev/null
node "$B/queue.mjs" set T-1 state=done result.pr=801 merged_at=2026-11-06T10:00:00Z >/dev/null
echo '{"state":"MERGED","mergedAt":"2026-11-06T10:00:00Z"}' > "$T/ep/801.json"
node "$B/queue.mjs" add T-2 >/dev/null
node "$B/queue.mjs" set T-2 state=parked 'park={"question":"held by orchestrator: behind T-1, E-8"}' 'held_by=T-1|E-8' held_outside=E-8 >/dev/null
touch "$T/ep/create.fail"; pass
check "DS-508 AC4 an epic PR that cannot be opened is put to the person with the reason, exit 11, never 10" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"epic PR: not opened — gh pr create failed: GraphQL: Resource not accessible by integration. Every child has merged into feat/x, and nothing lands on main until it is open"* ]]'
check "DS-508 AC5 a ticket held behind the epic waits on the epic PR, saying why there is none, not on a merge" \
  '[[ "$out" == *"WAITING ON EPIC PR: T-2 (E-8: no epic PR: gh pr create failed"* ]] && [[ "$out" != *"WAITING ON MERGE"* ]]'
pass
check "DS-508 AC4 it is tried again, and said again, on the next pass" '[ $rc -eq 11 ] && [ "$(grep -c "^pr create" "$T/ghlog")" = 2 ] && [[ "$out" == *"epic PR: not opened"* ]]'
rm "$T/ep/create.fail"; pass
check "DS-508 AC1 once every child has merged, the epic PR opens as a draft from the base, and is recorded" \
  'grep -q "^pr create --repo acme/widgets --draft --base main --head feat/x --title E-8: promote feat/x to main" "$T/ghlog" && [ "$(jq -r .promotion.pr "$DESK_QUEUE")" = 300 ] && [[ "$out" == *"epic PR #300 opened as a draft, feat/x → main"* ]]'
check "DS-508 AC1 and the batch is not idle" '[[ "$out" != *"IDLE"* ]]'
review -; pass
check "DS-508 AC2 a draft epic PR with no clean review gets a review try in the base worktree" \
  'grep -q "^base-feat-x $C/wt/base-feat-x feat/x .*It is epic PR #300, which merges this batch.s base feat/x into main" "$T/spawns" && [ "$(jq -r ".base_fix.tries[0].kind" "$DESK_QUEUE")" = review ] && [[ "$out" == *"epic PR review try 1 of 2 on feat/x, PR #300"* ]]'
check "DS-508 AC5 and the held ticket says it waits on the epic PR by number" '[[ "$out" == *"WAITING ON EPIC PR: T-2 (E-8: epic PR #300, in draft until a clean review stands at its head)"* ]]'
live; pass
check "DS-508 AC2 a live review try is waited on, not doubled" '[ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [[ "$out" == *"epic PR #300: review try 1 of 2 is at it"* ]]'
ended "AUTOPILOT_DONE: pr=300 jira=none"; rm -f "$T/agents.json"; pass
check "DS-508 AC2 a try that ended with no clean review at the same head goes to the person, exit 11" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"EPIC PR: #300 stays draft: no clean review at eeeeeeeeeeee after 1 review try; the last try finished: pr=300 jira=none"* ]] && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ]'
review "p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0"; pass
check "DS-508 AC2 a clean review at its head takes it out of draft" 'grep -q "^pr ready 300 --repo acme/widgets" "$T/ghlog" && [ "$(jq -r .isDraft "$T/ep/300.json")" = false ]'
pass
check "DS-508 AC3 out of draft with no merge driver granted, it is put to the person naming the rows, exit 11" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"EPIC PR: #300 is out of draft, but no merge driver merges it (config §3 autopilot-merge"* ]]'
echo '{"state":"MERGED","mergedAt":"2026-11-07T09:00:00Z"}' > "$T/ep/300.json"; pass
check "DS-508 AC6 once the epic PR merges, it is recorded and the epic is lifted from the held ticket" \
  '[ "$(jq -r .promotion.merged_at "$DESK_QUEUE")" = 2026-11-07T09:00:00Z ] && [[ "$(jq -r ".tickets[\"T-2\"].held_by // \"\"" "$DESK_QUEUE")" != *E-8* ]] && [[ "$out" == *"outside hold: T-2: E-8 landed on main through its epic PR"* ]]'
pass
check "DS-508 AC6 and with its other blocker merged, it is released" '[ "$(jq -r ".tickets[\"T-2\"].state" "$DESK_QUEUE")" != parked ]'
node "$B/queue.mjs" drop T-2 >/dev/null; pass
check "DS-508 AC6 with the epic PR merged and nothing left, the batch reads idle" '[[ "$out" == *"IDLE"* ]] && [ "$(grep -c "^pr create" "$T/ghlog")" = 3 ]'
# Held behind another epic whose batch the supervisor archived as its epic PR merged by hand, before its
# own pass could record the merge: read from GitHub in the archived copy.
SQ=$(node --input-type=module -e "const E = await import('$B/desk-env.mjs'); console.log(E.batchPaths(E.repoSlug()).queue)")
mkdir -p "$(dirname "$SQ")/batches/.done/E-9"
echo '{"epic":"E-9","base":"feat/y","feature":false,"promotion":{"pr":900},"tickets":{}}' > "$(dirname "$SQ")/batches/.done/E-9/queue.json"
echo '{"state":"MERGED","mergedAt":"2026-11-07T10:00:00Z"}' > "$T/ep/900.json"
node "$B/queue.mjs" add T-3 >/dev/null
node "$B/queue.mjs" set T-3 state=parked 'park={"question":"held by orchestrator: behind E-9"}' held_by=E-9 held_outside=E-9 >/dev/null
pass
check "DS-508 AC6 a ticket held behind an epic whose batch was archived with its epic PR merged is released" \
  '[[ "$out" == *"outside hold: T-3: E-9 landed on main through its epic PR"* ]] && [ "$(jq -r ".tickets[\"T-3\"].state" "$DESK_QUEUE")" != parked ]'
# Held behind the epic of another batch, whose epic PR could not be opened: said as that, not as a merge.
mkdir -p "$(dirname "$SQ")/batches/E-7"
echo '{"epic":"E-7","base":"feat/z","feature":false,"promotion":{"pr":null,"why":"gh pr create failed: nope"},"tickets":{"T-70":{"key":"T-70","state":"done","merged_at":"2026-11-06T10:00:00Z","result":{"pr":700}}}}' > "$(dirname "$SQ")/batches/E-7/queue.json"
node "$B/queue.mjs" add T-4 >/dev/null
node "$B/queue.mjs" set T-4 state=parked 'park={"question":"held by orchestrator: behind E-7"}' held_by=E-7 held_outside=E-7 >/dev/null
pass
check "DS-508 AC5 a ticket held behind another batch's epic waits on that epic PR, saying why there is none" \
  '[[ "$out" == *"WAITING ON EPIC PR: T-4 (E-7: no epic PR: gh pr create failed: nope)"* ]] && [[ "$out" != *"WAITING ON MERGE"* ]]'

# §4 Merged-tree check: a stubbed check that fails on a repeated revision number in migrations/, and
# leaves a stray file behind as a real tool can.
ln -sf "$B/with-lock.sh" "$T/desk/bin/with-lock.sh"
cat > "$T/check.sh" <<'EOF'
d=$(ls migrations 2>/dev/null | cut -d_ -f1 | sort | uniq -d)
[ -z "$d" ] && exit 0
touch stray.tmp; echo "Revision $d is present more than once"; exit 1
EOF
treerow(){ printf '\n## 4. Tools\n| Field | Value |\n|---|---|\n| Merged-tree check | `%s` |\n' "$1" >> "$C/config.md"; }
# clash: main and feat/x each add a migration numbered 121, under different filenames.
clash(){
  git -C "$C/repo" fetch -q origin; git -C "$C/repo" switch -q -c side origin/feat/x
  mkdir -p "$C/repo/migrations"; echo a > "$C/repo/migrations/121_a.py"; git -C "$C/repo" add migrations; git -C "$C/repo" commit -q -m base-side; git -C "$C/repo" push -q origin HEAD:feat/x
  git -C "$C/repo" switch -q main; mkdir -p "$C/repo/migrations"; echo b > "$C/repo/migrations/121_b.py"; git -C "$C/repo" add migrations; git -C "$C/repo" commit -q -m main-side; git -C "$C/repo" push -q origin main
  git -C "$C/repo" branch -q -D side
}
# renumber: what the fix worker does, from a clone: merge main, move the base's own migration after it.
renumber(){
  git clone -q "$C/origin.git" "$C/fixer"; git -C "$C/fixer" switch -q feat/x
  git -C "$C/fixer" merge -q --no-edit origin/main; git -C "$C/fixer" mv migrations/121_a.py migrations/122_a.py
  git -C "$C/fixer" commit -q -m renumber; git -C "$C/fixer" push -q origin feat/x
}
rm -f "$T/agents.json"; : > "$T/spawns"

fresh tree1; feature; fixrow yes; treerow "sh $T/check.sh"; clash; tip=$(origin_tip); pass
check "DS-441 AC1 a clean merge that fails the check pushes nothing" '[ "$(origin_tip)" = "$tip" ]'
check "DS-441 AC1 a base fix worker is sent, with the check's output" \
  'grep -q "^base-feat-x .*Your task is merged-tree fix try 1 of 2 on feat/x" "$T/spawns" && grep -q "Revision 121 is present more than once" "$C/state/briefings/base-feat-x.md" && [ "$(jq -r ".base_fix.tries[0].check.output" "$DESK_QUEUE")" = "Revision 121 is present more than once" ]'
check "DS-441 AC1 the report says it is the check, and not the person's yet" '[[ "$out" == *"fails §4 Merged-tree check"* ]] && [[ "$out" == *"Merged-tree fix try 1 of 2 starts this pass"* ]] && [ $rc -ne 11 ]'
check "DS-441 AC1 the worktree is left clean at the base's head" "[ -z \"\$(git -C $BWT status --porcelain)\" ] && [ \"\$(git -C $BWT rev-parse HEAD)\" = \"\$tip\" ]"
renumber; ended "AUTOPILOT_DONE: pr=none jira=none"; pass
check "DS-441 AC2 once the worker has pushed, the next pass finds the base current and clears the tries" \
  '[[ "$out" == *"merged-tree fix: try 1 of 2 on feat/x finished"* ]] && [[ "$out" == *"feat/x is current with main again"* ]] && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ] && origin_has_main'

rm -f "$T/agents.json"; : > "$T/spawns"
fresh tree5; feature; fixrow yes; treerow "sh $T/check.sh"; clash; tip=$(origin_tip); pass
# The worker merged locally, could not make the check pass, and parked without pushing.
git -C "$C/wt/base-feat-x" merge -q --no-edit origin/main; ended "AUTOPILOT_PARK: the check still fails"; pass
check "DS-441 AC5 a fix that still fails is put to the person, quoting the check" \
  '[[ "${out#*WAITING ON YOU}" == *"nothing pushed. Its output: Revision 121 is present more than once"* ]] && [[ "${out#*WAITING ON YOU}" == *"Still failing the check after 1 fix try; the last try parked: the check still fails"* ]]'
check "DS-441 AC5 nothing was pushed and no second try starts" '[ "$(origin_tip)" = "$tip" ] && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ]'

: > "$T/spawns"
fresh tree4; treerow none; clash; pass
check "DS-441 AC4 with the row none, a clean merge pushes as before" 'origin_has_main && [[ "$out" == *"and pushed"* ]]'
fresh treeunset; clash; pass
check "DS-441 AC4 with no row at all, likewise" 'origin_has_main'
fresh treepass; treerow "sh $T/check.sh"; pass
check "DS-441 negative: a merge the check passes is pushed" 'origin_has_main && [[ "$out" == *"and pushed"* ]] && [ -z "$(git -C "$C/wt/base-feat-x" status --porcelain)" ]'

# A batch whose every child has merged, its draft epic PR's review due, beside a live sibling batch in
# the repo with one worker running and ready tickets. epicbeside <case> <concurrency row>.
SIB="$DESK_HOME/repos/acme__widgets/queue.json"
epicbeside(){
  fresh "$1"; epicrows; rm -f "$T/ep"/*; : > "$T/spawns"; rm -f "$T/agents.json"
  printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `%s` |\n' "$2" >> "$C/config.md"
  node "$B/queue.mjs" set-batch epic=E-8 feature=false 'promotion={"pr":300}' >/dev/null
  node "$B/queue.mjs" set T-1 state=done result.pr=801 merged_at=2026-11-06T10:00:00Z >/dev/null
  echo '{"state":"MERGED","mergedAt":"2026-11-06T10:00:00Z"}' > "$T/ep/801.json"
  echo "{\"state\":\"OPEN\",\"isDraft\":true,\"headRefOid\":\"$EH\"}" > "$T/ep/300.json"; review -
  mkdir -p "$(dirname "$SIB")" "$HOME/.desk-autopilot/acme__widgets/orchestrators"
  echo '{"concurrency":3,"tickets":{"S-1":{"key":"S-1","state":"running"},"S-2":{"key":"S-2","state":"triaged"},"S-3":{"key":"S-3","state":"triaged"},"S-4":{"key":"S-4","state":"triaged"}}}' > "$SIB"
  jq -n --arg q "$SIB" --arg at "$(node -p 'new Date().toISOString()')" '{queue: $q, at: $at}' > "$HOME/.desk-autopilot/acme__widgets/orchestrators/sibling.json"
  out=$(DESK_REPO_OVERRIDE=acme/widgets node "$B/pass.mjs" 2>&1); rc=$?
}
epicbeside eslot '2 / 3'
check "DS-520 AC2 with a free slot beside a sibling batch's ready work, the epic review starts" 'grep -q "^base-feat-x .*It is epic PR #300" "$T/spawns" && [ "$(jq -r ".base_fix.tries[0].kind" "$DESK_QUEUE")" = review ]'
check "DS-520 AC1 the review counts as wanting one slot, and the sibling keeps the rest" '[[ "$out" == *"repo workers: 1 of the §3b cap of 3 running"*"1 kept for the standing batch, which has 3 ready and 1 running"* ]]'
epicbeside efull '1 / 1'
check "DS-520 AC3 with the §3b cap full, the review waits" '! grep -q "^base-feat-x " "$T/spawns" && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ]'
check "DS-520 AC3 and the pass says why" '[[ "$out" == *"epic PR #300: review try 1 of 2 starts once a worker may (none may this pass: repo workers: 1 of the §3b cap of 1 running"* ]]'
rm -f "$SIB"

echo "base sync: $PASS passed, $FAIL failed"; cd /; rm -rf "$T"; [ "$FAIL" -eq 0 ]
