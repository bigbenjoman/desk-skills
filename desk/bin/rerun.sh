#!/usr/bin/env bash
# CI reruns, one implementation for both callers: merge-driver.sh sources it for a ready PR, and
# pass.mjs runs it for a draft whose red checks were all cancelled or timed out (undraft.mjs):
#   RERUN_PERM=<§3 ci-rerun> rerun.sh <driver state dir> <owner/repo> <n> <sha>   with the gate JSON on stdin,
#   { "gate": { "pending": [...], "failedRuns": [...], "failing": [{ name, runId }], "reasons": [...] } }
# RERUN_PERM unset reruns nothing, as `no` does.
#
# Reruns per check per head: at most RERUNS_MAX tried, RERUN_COOLDOWN seconds apart. reruns-<n>-<sha>
# lists every check a rerun was tried for, reruns-ok-<n>-<sha> only those GitHub accepted.
# fix-tries.mjs holds the same two numbers for the pass.
RERUNS_MAX=2; RERUN_COOLDOWN=720
reruns_at(){ grep -cxF "$3" "$SD/reruns${4:+-$4}-$1-$2" 2>/dev/null || true; }   # reruns_at <n> <sha> <check> [ok]

rerun(){ # rerun <n> <sha> <gate json>
  local g="$3" pend ids names rid name cnt cd_file now last all_ok=1 ok=""
  [ "$RERUN_PERM" = yes ] || { log "#$1 red at ${2:0:9} — config §3 ci-rerun is $RERUN_PERM, so not rerunning; report it"; return; }
  pend=$(printf '%s' "$g" | jq -r '.gate.pending | length')
  [ "$pend" = 0 ] || { log "#$1 red, but $pend check(s) still running — waiting for them before any rerun"; return; }
  ids=$(printf '%s' "$g" | jq -r '.gate.failedRuns[]?')
  names=$(printf '%s' "$g" | jq -r '.gate.failing[].name')
  [ -n "$ids" ] || { log "#$1 red with nothing a rerun could fix ($(printf '%s' "$g" | jq -r '.gate.reasons[:2] | join("; ")')) — report it"; return; }
  # At most twice per check per head: a check red after two reruns is red, not flaky.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    cnt=$(reruns_at "$1" "$2" "$name")
    if [ "${cnt:-0}" -ge "$RERUNS_MAX" ]; then log "#$1 \"$name\" still red after $RERUNS_MAX reruns at ${2:0:9} — not rerunning again; the pass sends it to a fix worker, or reports it stuck"; return; fi
  done <<EOF_NAMES
$names
EOF_NAMES
  cd_file="$SD/cooldown-$1"; now=$(date +%s); last=$(cat "$cd_file" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$RERUN_COOLDOWN" ]; then log "#$1 red, cooling down ($(( (RERUN_COOLDOWN - (now - last)) / 60 ))m left)"; return; fi
  for rid in $ids; do
    log "#$1 red + completed -> rerun --failed on run $rid"
    # An accepted rerun credits only the checks of that run; one with no run id, only if every rerun was accepted.
    if gh run rerun "$rid" --repo "$REPO" --failed >/dev/null 2>&1; then
      echo "$now" > "$cd_file"
      ok="$ok$(printf '%s' "$g" | jq -r --arg r "$rid" '.gate.failing[] | select(.runId == $r) | .name')
"
    else log "#$1 rerun of $rid refused"; all_ok=""; fi
  done
  [ -n "$all_ok" ] && ok="$ok$(printf '%s' "$g" | jq -r '.gate.failing[] | select(.runId == null) | .name')"
  printf '%s\n' "$names" >> "$SD/reruns-$1-$2"
  ok=$(printf '%s\n' "$ok" | awk 'NF && !seen[$0]++')
  if [ -n "$ok" ]; then printf '%s\n' "$ok" >> "$SD/reruns-ok-$1-$2"; fi
}

# Run rather than sourced: the pass's call for one draft.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  [ "$#" = 4 ] || { echo "usage: rerun.sh <driver state dir> <owner/repo> <n> <sha>  (gate JSON on stdin)" >&2; exit 2; }
  command -v jq >/dev/null 2>&1 || { echo "rerun.sh: jq is required" >&2; exit 1; }
  SD="$1"; REPO="$2"; RERUN_PERM="${RERUN_PERM:-no}"
  mkdir -p "$SD" || exit 1
  log(){ echo "$*"; }
  rerun "$3" "$4" "$(cat)"
fi
