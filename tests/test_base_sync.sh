#!/usr/bin/env bash
# suite: base sync (a batch base's worktree, synced from the default branch before a pass spawns)
# layer: L3
# pass.mjs with a batch base: every pass makes the base its own worktree, and a pass that will spawn,
# or finds the base behind main, first merges main into the base and pushes it. A conflict pushes
# nothing and is reported; in feature mode it also holds the spawns. Here: the base worktree, a clean
# sync, a conflict, the conflict fix worker's first try, the lag a blocked sync may spawn at, and the
# worker slot a live base fix holds. Set up by base_sync_setup.sh; the other tests/test_base_sync_*.sh
# suites cover the rest of the base sync.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=base_sync_setup.sh
. "$S/base_sync_setup.sh"

# AC9: no base, no base worktree, no sync.
fresh nobase yes -; pass
check "no base: a pass spawns as before"              '[[ "$out" == *"spawned: T-1"* ]]'
check "no base: no base worktree is made"            '[ -z "$(ls "$C/wt" | grep base-)" ]'
check "no base: no sync is attempted"                '[[ "$out" != *"base sync"* ]]'

# AC1, AC3: the first pass makes the base worktree. DS-542 AC1: a pass that spawns nothing still syncs a
# base behind main, and a later one, with the base current, says nothing about it.
fresh idle; node "$B/queue.mjs" set T-1 state=done >/dev/null; pass
check "DS-594 the first pass makes the base worktree on a detached HEAD at origin's base" "! git -C $BWT symbolic-ref -q HEAD && [ \"\$(git -C $BWT rev-parse HEAD)\" = \"\$(origin_tip)\" ]"
check "it is a worktree of the primary checkout"     'git -C "$C/repo" worktree list | grep -q "base-feat-x .*(detached HEAD)"'
check "the report says it was made"                  '[[ "$out" == *"base worktree for feat/x made at $C/wt/base-feat-x"* ]]'
check "DS-542 AC1 a pass that spawns nothing syncs a base behind main" 'origin_has_main && [[ "$out" == *"base sync: merged 2 commit(s) from main into feat/x and pushed"* ]] && [[ "$out" != *"spawned:"* ]]'
tip=$(origin_tip); pass
check "DS-594 AC4 a second pass reuses the detached worktree, quietly" '[[ "$out" != *"base worktree"* ]] && [ -d "$C/wt/base-feat-x" ] && [ "$(git -C "$C/repo" worktree list | grep -c base-feat-x)" = 1 ]'
check "DS-542 a current base on a pass that spawns nothing is left, quietly" '[ "$(origin_tip)" = "$tip" ] && [[ "$out" != *"base sync"* ]]'

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
check "DS-756 AC6 the base sync's conflicting files go on the conflict record, with no PR" \
  '[ "$(jq -c "[.file, .ticket, .pr, .head, .source]" "$C/state/conflicts.jsonl")" = "[\"a.txt\",\"base-feat-x\",null,\"$tip\",\"$(git -C "$C/repo" rev-parse origin/main)\"]" ]'
pass
check "DS-756 AC6 the same conflict met again on a later pass is not recorded twice" '[ "$(grep -c . "$C/state/conflicts.jsonl")" = 1 ]'

# AC6: in feature mode a conflict spawns nothing.
fresh fconflict; feature; conflict; pass
check "feature mode: a conflict spawns nothing"      '[[ "$out" != *"spawned:"* ]] && [[ "$out" == *"feature mode, so nothing spawns this pass"* ]]'
check "DS-320 AC5 pr-conflict-unreviewed unset: no conflict fix worker starts" '! grep -q "^base-" "$T/spawns" && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ]'

# DS-320: where §3 pr-conflict-unreviewed is yes, a base conflict goes to a conflict fix worker in the
# base worktree (fixrow, ended, live and resolve are base_sync_setup.sh's).
rm -f "$T/agents.json"; : > "$T/spawns"
fresh bfix; feature; fixrow yes; conflict; tip=$(origin_tip); pass
check "DS-320 AC1 a pass that would spawn starts a conflict fix worker for the base" \
  '[[ "$out" == *"base-feat-x port="*"(conflict fix try 1 of 2 on feat/x)"* ]] && grep -q "^base-feat-x $C/wt/base-feat-x feat/x .*Your task is conflict fix try 1 of 2 on feat/x" "$T/spawns"'
check "DS-320 AC1 it is told to merge, never rebase, and to push the base" 'grep -q "merge origin/main into feat/x (git merge, never a rebase or a force push)" "$T/spawns" && grep -q "git push origin HEAD:refs/heads/feat/x" "$T/spawns" && grep -q "on a detached HEAD at origin/feat/x: never check feat/x out" "$T/spawns"'
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

# Outside feature mode, a blocked sync holds every spawn once the base is more than
# AUTOPILOT_BASE_BEHIND_MAX commits behind main. The conflict leaves feat/x 3 behind.
fresh lagheld; conflict; AUTOPILOT_BASE_BEHIND_MAX=2 pass
check "DS-668 AC1 a blocked sync on a base past the threshold spawns nothing" '[[ "$out" != *"spawned:"* ]] && [[ "${out#*WAITING ON YOU}" == *"Conflicting files: a.txt"* ]]'
check "DS-668 AC1 and says how far behind the base is" '[[ "$out" == *"feat/x is 3 commit(s) behind main, more than the 2 it may lag and still spawn, so nothing spawns this pass"* ]]'
AUTOPILOT_BASE_BEHIND_MAX=3 pass
check "DS-668 AC2 a base at the threshold spawns as before" '[[ "$out" == *"spawned: T-1"* ]] && [[ "$out" == *"spawning carries on from the base as it stands (feat/x is 3 commit(s) behind main, within the 3 it may lag)"* ]]'
fresh laghold2; conflict; AUTOPILOT_BASE_BEHIND_MAX=0 pass
check "DS-668 AC4 any lag holds at a threshold of 0" '[[ "$out" != *"spawned:"* ]] && [[ "$out" == *"more than the 0 it may lag"* ]]'
resolve; AUTOPILOT_BASE_BEHIND_MAX=0 pass
check "DS-668 AC4 a held batch spawns once its base syncs" '[[ "$out" == *"spawned: T-1"* ]] && [[ "$out" == *"feat/x already has everything on main"* ]] && [[ "$out" != *"nothing spawns"* ]]'
fresh lagclean; AUTOPILOT_BASE_BEHIND_MAX=0 pass
check "DS-668 AC3 a sync that lands spawns whatever the threshold" '[[ "$out" == *"spawned: T-1"* ]] && origin_has_main'
fresh lagfeature; feature; conflict; AUTOPILOT_BASE_BEHIND_MAX=100 pass
check "DS-668 AC5 feature mode holds whatever the threshold" '[[ "$out" != *"spawned:"* ]] && [[ "$out" == *"feature mode, so nothing spawns this pass"* ]]'
# A base origin no longer has, and was never fetched: its lag cannot be counted, so it is not read as 0.
fresh lagunread; git -C "$C/origin.git" branch -q -D feat/x; git -C "$C/repo" update-ref -d refs/remotes/origin/feat/x; AUTOPILOT_BASE_BEHIND_MAX=0 pass
check "a lag that cannot be counted is said so, never as 0, and holds nothing" '[[ "$out" == *"spawned: T-1"* ]] && [[ "$out" == *"spawning carries on from the base as it stands (how far feat/x is behind main could not be read)"* ]] && [[ "$out" != *"0 commit(s) behind"* ]]'
rm -f "$T/agents.json"; : > "$T/spawns"; fresh lagfix; fixrow yes; conflict; AUTOPILOT_BASE_BEHIND_MAX=2 pass
check "DS-668 a sync left to a fix try holds too, past the threshold" '[[ "$out" == *"Conflict fix try 1 of 2 starts this pass"* ]] && [[ "$out" == *"more than the 2 it may lag and still spawn, so nothing else spawns this pass"* ]] && [ "$(grep -c "^T-1 " "$T/spawns")" = 0 ]'

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

finish sync
