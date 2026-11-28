# shellcheck shell=bash
# Sourced by merge-driver.sh, before it reads its arguments, so a batch's driver and the repo's one
# driver (merge-driver-repo.sh) share their lock, their waits and their reading of a signed-out gh.
# The caller defines log, stop_if_asked and pause (which ends in pause_for), and keeps SLEEP_PID.

# lock_take <dir> [point]: makes the lock <dir> holding this shell's pid. A dead holder's lock is taken
# over; a lock with no pid yet is a driver starting up, waited on for up to a minute, or with point
# left to it at once. Fails, with LOCK_HOLDER set, while a live holder other than this shell has it
# (LOCK_HOLDER empty: one is starting).
LOCK_HOLDER=""
lock_take(){
  local d="$1" holder
  LOCK_HOLDER=""
  while ! mkdir "$d" 2>/dev/null; do
    holder="$(cat "$d/pid" 2>/dev/null || true)"
    [ "$holder" = "$$" ] && return 0
    # shellcheck disable=SC2034  # read by the scripts that source this file, in their lock-held message
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then LOCK_HOLDER="$holder"; return 1; fi
    if [ -z "$holder" ] && [ -z "$(find "$d" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      [ "${2:-}" = point ] && return 1
      sleep 1; continue
    fi
    mv "$d" "$d.stale.$$" 2>/dev/null && rm -rf "$d.stale.$$"   # atomic takeover of a dead holder's lock
  done
  echo "$$" > "$d/pid"
}

# signed_out <rc> <gh's stderr file>: whether a gh call failed because gh is signed out (gh's own exit
# code for it, or a 401).
signed_out(){ [ "$1" -eq 4 ] || grep -qiE 'gh auth login|not logged in|HTTP 401|bad credentials' "$2" 2>/dev/null; }

# pause_for <secs>: the wait itself. The sleep runs in the background, since `wait` returns as soon as
# TERM arrives where a foreground sleep would not.
pause_for(){
  stop_if_asked
  sleep "$1" & SLEEP_PID=$!
  wait "$SLEEP_PID"; kill "$SLEEP_PID" 2>/dev/null; SLEEP_PID=""
  stop_if_asked
}

# hold_left <epoch>: the seconds from now until a confirmation hold ends at <epoch>, at least 1 and at
# most the 120s a loop with ready PRs waits anyway.
hold_left(){ local left=$(( $1 - $(date +%s) )); [ "$left" -ge 1 ] || left=1; [ "$left" -le 120 ] || left=120; echo "$left"; }

# The pause after a loop with no ready PR: MERGE_DRIVER_IDLE_SECS, doubled on each such loop in a row
# (IDLE_RUN) up to MERGE_DRIVER_IDLE_MAX_SECS, in slices of MERGE_DRIVER_WAKE_SECS.
IDLE_SECS="${MERGE_DRIVER_IDLE_SECS:-60}"; IDLE_MAX_SECS="${MERGE_DRIVER_IDLE_MAX_SECS:-600}"; WAKE_SECS="${MERGE_DRIVER_WAKE_SECS:-60}"
IDLE_RUN=0
idle_settings(){
  local v
  for v in IDLE_SECS IDLE_MAX_SECS WAKE_SECS; do
    case "${!v}" in ''|0*|*[!0-9]*) echo "FAIL: MERGE_DRIVER_$v is '${!v}' — want a whole number of seconds above 0" >&2; exit 2 ;; esac
  done
}
# idle_pause <mark> <loop|sweep> <path>...: ends early once any <path> (the repo's exits folder, where a
# worker's exit lands, or a batch's merge-driver/wake, which the pass touches as a PR leaves draft) has
# changed since <mark> was touched, as the loop began.
idle_pause(){
  local mark="$1" what="$2" secs="$IDLE_SECS" i=0 left slice woke
  shift 2
  while [ "$i" -lt "$IDLE_RUN" ] && [ "$secs" -lt "$IDLE_MAX_SECS" ]; do secs=$((secs * 2)); i=$((i + 1)); done
  [ "$secs" -le "$IDLE_MAX_SECS" ] || secs="$IDLE_MAX_SECS"
  IDLE_RUN=$((IDLE_RUN + 1))
  [ "$IDLE_RUN" -eq 1 ] || log "idle $what $IDLE_RUN in a row: next look in ${secs}s, sooner once a worker exits or a PR leaves draft"
  left="$secs"
  while [ "$left" -gt 0 ]; do
    slice="$WAKE_SECS"; [ "$slice" -le "$left" ] || slice="$left"
    pause "$slice"
    left=$((left - slice))
    [ "$left" -gt 0 ] || break
    woke=$(find "$@" -maxdepth 0 -newer "$mark" 2>/dev/null | head -1)
    if [ -n "$woke" ]; then
      case "$woke" in */wake) log "woken: a PR left draft — looking again now" ;; *) log "woken: a worker exited — looking again now" ;; esac
      return 0
    fi
  done
}
