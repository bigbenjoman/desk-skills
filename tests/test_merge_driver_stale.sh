#!/usr/bin/env bash
# suite: merge driver: §4 Stale-check paths update a green PR's branch before it merges (offline, fake gh)
# layer: L3
# The real merge-driver.sh and gate.mjs, one loop at a time, set up by merge_driver_setup.sh, against a
# scratch origin whose main changes a listed path, an unlisted path, or nothing since a PR branched.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

git init -q --bare "$T/st-origin.git"
git -C "$T/repo" remote add origin "$T/st-origin.git"
echo v1 > "$T/repo/pnpm-lock.yaml"; echo v1 > "$T/repo/README.md"
git -C "$T/repo" add pnpm-lock.yaml README.md; git -C "$T/repo" commit -q -m m0; git -C "$T/repo" push -q origin main
M0=$(git -C "$T/repo" rev-parse HEAD)
# st_branch <branch> [<from>] -> its head sha: one commit of its own on top of <from> (M0 by default)
st_branch(){
  git -C "$T/repo" switch -q -c "$1" "${2:-$M0}"; echo "$1" > "$T/repo/src-${1#fix/}.txt"
  git -C "$T/repo" add .; git -C "$T/repo" commit -q -m "$1"; git -C "$T/repo" push -q origin "$1"
  git -C "$T/repo" rev-parse HEAD; git -C "$T/repo" switch -q main
}
# main_change <file>: a commit on origin's main changing <file>
main_change(){ echo "$RANDOM" >> "$T/repo/$1"; git -C "$T/repo" commit -q -am "main $1"; git -C "$T/repo" push -q origin main; }

UPDATE_YES='| `pr-update-branch` | Update | `yes` | `yes` |'
UPDATE_NO='| `pr-update-branch` | Update | `yes` | `no` |'
HOLDS_ROW='| Merge holds | `none` |'
# st_config <name> <permission row> <stale-check row value, or "" for no row>
st_config(){
  local c; c=$(cat "$T/config.md")
  c=${c/'| `pr-ready` | Undraft | `yes` | `yes` |'/'| `pr-ready` | Undraft | `yes` | `yes` |'$'\n'"$2"}
  [ -n "$3" ] && c=${c/"$HOLDS_ROW"/"$HOLDS_ROW"$'\n'"| Stale-check paths | $3 |"}
  printf '%s\n' "$c" > "$T/config-$1.md"
}
st_config yes "$UPDATE_YES" '`pnpm-lock.yaml` `prisma/schema.prisma`'
st_config no "$UPDATE_NO" '`pnpm-lock.yaml` `prisma/schema.prisma`'
st_config none "$UPDATE_YES" '`none`'
st_config unset "$UPDATE_YES" ''
stloop(){ out=$(DESK_CONFIG="$T/config-$1.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$2" 2>&1); rc=$?; }
# st_pr <n> <key> <sha> [<conclusion>]: the one open PR, its ticket queued
st_pr(){
  : > "$T/merges.log"; : > "$T/gh.log"; rm -f "$SD"/green-* "$SD"/updated-*
  jq -n --arg n "$1" --arg h "fix/$2" --arg s "$3" --arg c "${4:-SUCCESS}" \
    '{ ($n): { head: $h, base: "main", sha: $s, state: "open", draft: false, checks: [["test", $c]] } }' > "$T/prs.json"
  q add "$2" Task A; q set "$2" "branch=fix/$2" state=done "result.pr=$1"
}
updates(){ grep -c "^pr update-branch $1" "$T/gh.log"; }
q init stale

# Nothing changed on main since the PR branched: it merges as it stands.
S701=$(st_branch fix/T-701); st_pr 701 T-701 "$S701"
stloop yes T-701; stloop yes T-701
check "a green PR whose base has not moved merges with no update" '[ "$(merged)" = 701 ] && [ "$(updates 701)" = 0 ]'

# AC2: main changed only an unlisted path since the PR branched.
main_change README.md
S702=$(st_branch fix/T-702); st_pr 702 T-702 "$S702"
stloop yes T-702; stloop yes T-702
check "AC2 a green PR behind main where no listed path changed merges without updating the branch" \
  '[ "$(merged)" = 702 ] && [ "$(updates 702)" = 0 ] && ! echo "$out" | grep -q "stale"'

# AC1: main changed pnpm-lock.yaml since the PR branched.
main_change pnpm-lock.yaml
S703=$(st_branch fix/T-703); st_pr 703 T-703 "$S703"
stloop yes T-703; stloop yes T-703
check "AC1 a green PR whose base changed a listed path is not merged: its branch is updated" \
  '[ -z "$(merged)" ] && [ "$(updates 703)" = 1 ] && echo "$out" | grep -q "#703 green at ${S703:0:9}, but main changed pnpm-lock.yaml since it branched at ${M0:0:9} -> gh pr update-branch"'
stloop yes T-703
check "AC1 the update is asked once per head" '[ -z "$(merged)" ] && [ "$(updates 703)" = 1 ] && echo "$out" | grep -q "#703 its checks are stale (main changed pnpm-lock.yaml); update already requested"'
# GitHub's update: main merged into the branch, a new head whose checks start red.
git -C "$T/repo" switch -q fix/T-703; git -C "$T/repo" merge -q --no-edit main; git -C "$T/repo" push -q origin fix/T-703
S703B=$(git -C "$T/repo" rev-parse HEAD); git -C "$T/repo" switch -q main
jq --arg s "$S703B" '."703".sha = $s | ."703".checks = [["test", "FAILURE"]]' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
stloop yes T-703; stloop yes T-703
check "AC1 the new head does not merge before its required checks are green" '[ -z "$(merged)" ] && [ "$(updates 703)" = 1 ]'
jq '."703".checks = [["test", "SUCCESS"]]' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
stloop yes T-703; stloop yes T-703
check "AC1 green at the new head, it merges pinned to that head with no second update" \
  '[ "$(cat "$T/merges.log")" = "703 main $S703B" ] && [ "$(updates 703)" = 1 ]'

# AC1, §3 pr-update-branch not yes: parked for a person, no update.
S704=$(st_branch fix/T-704); st_pr 704 T-704 "$S704"
stloop no T-704; stloop no T-704
check "AC1 where §3 pr-update-branch is not yes, the PR is parked for a person and not updated" \
  '[ -z "$(merged)" ] && [ "$(updates 704)" = 0 ] && qf T-704 .merge_blocked | grep -q "^stale checks: main changed pnpm-lock.yaml since #704 branched at ${M0:0:9}; §3 pr-update-branch is no"'

# AC3: the row `none`, or unset, merges a stale PR as it stands; the note goes.
stloop none T-704; stloop none T-704
check "AC3 with the row none, the PR merges with no update and its note is cleared" \
  '[ "$(merged)" = 704 ] && [ "$(updates 704)" = 0 ] && [ "$(qf T-704 .merge_blocked)" = null ]'
S705=$(st_branch fix/T-705); st_pr 705 T-705 "$S705"
stloop unset T-705; stloop unset T-705
check "AC3 with the row unset, the PR merges with no update" '[ "$(merged)" = 705 ] && [ "$(updates 705)" = 0 ]'

# AC4: main's run red after a merge halts every merge, a current PR's included.
S706=$(st_branch fix/T-706 main); st_pr 706 T-706 "$S706"
R0=c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0
printf '{"tip":"%s","commits":{"%s":{"parent":null,"runs":[["test","completed","failure","https://github.com/acme/widgets/actions/runs/860"]]}}}\n' "$R0" "$R0" > "$T/base.json"
stloop yes T-706; stloop yes T-706
check "AC4 on a red main nothing merges, as before" \
  '[ -z "$(merged)" ] && echo "$out" | grep -qF "HOLDING on red main" && [ "$(updates 706)" = 0 ]'
rm -f "$T/base.json"

finish stale
