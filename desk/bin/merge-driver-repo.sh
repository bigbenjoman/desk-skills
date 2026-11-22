# shellcheck shell=bash
# Sourced by merge-driver.sh for --all-batches: one merge driver for every batch of the repo, so GitHub
# is asked for the open PRs once per sweep however many batches there are. Each sweep:
#   - lists the repo's batches (batches.mjs listBatches, or only the one an explicit DESK_BATCH,
#     DESK_QUEUE or DESK_AUTOPILOT_STATE names) and covers each that is handed over, has tickets and a
#     merge grant, and has no driver of its own running; a batch the archive told its driver to stop
#     for (batch.mjs archiveCheck) is left to be archived;
#   - reads the author's open PRs on every base in one `gh pr list`, into <state>/merge-driver/open-prs.json;
#   - runs one loop of each covered batch's own driver in turn (merge-driver.sh --tickets <its tickets>,
#     with --batch for a named batch), which reads that list instead of asking GitHub again, and merges
#     onto that batch's base as a driver of its own would. A red base holds only its own batch's loop.
# Then it waits 30s after any merge, 120s while any batch has ready PRs waiting, and otherwise backs off
# as an idle driver does, ending the wait once a worker exits or any covered batch's PR leaves draft.
# It holds the standing batch's lock (or the one named batch's) for the repo, and writes its pid into
# each covered named batch's lock, so whatever reads a batch's lock sees the driver that merges it.
# Every lock it holds or points goes when it exits. TERM stops the batch loop running, as it stops a
# driver mid-loop, then this one.

# A batch loop's exit, in a sweep: what the sweep did for that batch.
SWEEP_MERGED=10; SWEEP_BUSY=11

if ! R="$(desk_load_paths >/dev/null && desk_load_identity >/dev/null \
  && printf '%s\t%s\t%s\t%s\t%s' "$DESK_STATE" "$DESK_GH_REPO" "$DESK_GITHUB_HANDLE" "$DESK_RUN_BIN" "$DESK_EXITS_DIR")"; then
  echo "FAIL: --all-batches: could not resolve the repo's paths" >&2; exit 1
fi
IFS="$(printf '\t')" read -r R_STATE R_REPO R_AUTHOR R_BIN R_EXITS <<EOF_R
$R
EOF_R
mkdir -p "$R_STATE/merge-driver" || exit 1
if [ -n "$LOG" ]; then exec >>"$R_STATE/merge-driver.log" 2>&1; fi
r_log(){ echo "$(date -u +%H:%M:%SZ) $*"; }

TAB="$(printf '\t')"; NL=$'\n'
R_LOCK="$R_STATE/merge-driver.lock.d"; R_HELD=""; POINTED=""; CHILD=""; SLEEP_PID=""; STOP=""; COVER=""
r_exit(){
  local rc=$? d
  [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null && wait "$CHILD" 2>/dev/null
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  while IFS= read -r d; do [ -n "$d" ] && unpoint "$d"; done <<EOF_P
$POINTED
EOF_P
  while IFS="$TAB" read -r _ d _; do [ -n "$d" ] && rm -rf "$d/merge-driver/said.$$"; done <<EOF_C
$COVER
EOF_C
  rm -rf "$R_STATE/merge-driver/said.$$"
  [ -n "$R_HELD" ] && rm -rf "$R_LOCK"
  r_log "merge driver exited $rc"
}
trap r_exit EXIT
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "FAIL: gh is required" >&2; exit 1; }
IDLE_SECS="${MERGE_DRIVER_IDLE_SECS:-60}"; IDLE_MAX_SECS="${MERGE_DRIVER_IDLE_MAX_SECS:-600}"; WAKE_SECS="${MERGE_DRIVER_WAKE_SECS:-60}"
for v in IDLE_SECS IDLE_MAX_SECS WAKE_SECS; do
  case "${!v}" in ''|0*|*[!0-9]*) echo "FAIL: MERGE_DRIVER_$v is '${!v}' — want a whole number of seconds above 0" >&2; exit 2 ;; esac
done

# The repo's lock, as a driver of one batch takes its own.
while ! mkdir "$R_LOCK" 2>/dev/null; do
  holder="$(cat "$R_LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    echo "FAIL: another merge driver is running (pid $holder, lock $R_LOCK). Stop it first; if it is dead, remove the lock." >&2
    exit 1
  fi
  if [ -z "$holder" ] && [ -z "$(find "$R_LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then sleep 1; continue; fi
  mv "$R_LOCK" "$R_LOCK.stale.$$" 2>/dev/null && rm -rf "$R_LOCK.stale.$$"
done
echo "$$" > "$R_LOCK/pid"; R_HELD=1
node "$R_BIN/installed.mjs" running > "$R_LOCK/version" 2>/dev/null || true
trap 'exit 130' INT
trap 'STOP=143; [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null' TERM
r_stop_if_asked(){ if [ -n "$STOP" ]; then exit "$STOP"; fi; }

# point <state>: this driver's pid in a named batch's lock. Fails, with POINT_HOLDER set, while a
# driver of that batch's own holds it (or one is starting).
POINT_HOLDER=""
point(){
  local d="$1/merge-driver.lock.d" holder
  POINT_HOLDER=""
  mkdir -p "$1" || return 1
  if ! mkdir "$d" 2>/dev/null; then
    holder="$(cat "$d/pid" 2>/dev/null || true)"
    [ "$holder" = "$$" ] && return 0
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then POINT_HOLDER="$holder"; return 1; fi
    if [ -z "$holder" ] && [ -z "$(find "$d" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then return 1; fi
    mv "$d" "$d.stale.$$" 2>/dev/null && rm -rf "$d.stale.$$"
    mkdir "$d" 2>/dev/null || return 1
  fi
  echo "$$" > "$d/pid"
  cp "$R_LOCK/version" "$d/version" 2>/dev/null || true
}
unpoint(){ if [ "$(cat "$1/merge-driver.lock.d/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$1/merge-driver.lock.d"; fi; }

# The batches to cover, as lines `<name, or : for the standing batch>\t<state>\t<tickets>`.
batches(){
  node --input-type=module - "$R_BIN" <<'NODE'
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [bin] = process.argv.slice(2);
const at = (f) => import(pathToFileURL(join(bin, f)).href);
const E = await at('desk-env.mjs');
const { listBatches, batchPinned } = await at('batches.mjs');
const { readQueue } = await at('batch-state.mjs');
const all = batchPinned() ? [{ name: E.batchName(), queue: E.queueFile(), state: E.stateDir() }] : listBatches();
for (const b of all) {
  let q;
  try { q = readQueue(b.queue); } catch { continue; }
  const keys = Object.keys(q.tickets ?? {});
  if (q.supervised !== true || !keys.length || existsSync(join(b.state, 'archive-driver-stopped.json')) || !E.mergeGrant(q).by) continue;
  console.log([b.name ?? ':', b.state, keys.join(' ')].join('\t'));
}
NODE
}

# A line is logged only when the sweep before did not log it, so a repo at rest stays quiet.
SAID_LAST=""; SAID_NOW=""
say(){
  SAID_NOW="$SAID_NOW$*$NL"
  case "$NL$SAID_LAST" in *"$NL$*$NL"*) return 0 ;; esac
  r_log "$*"
}
r_pause(){
  r_stop_if_asked
  sleep "$1" & SLEEP_PID=$!
  wait "$SLEEP_PID"; kill "$SLEEP_PID" 2>/dev/null; SLEEP_PID=""
  r_stop_if_asked
}
# As an idle driver of one batch backs off (merge-driver.sh idle_pause), woken by a worker's exit or a
# PR out of draft in any covered batch.
IDLE_RUN=0; R_MARK="$R_STATE/merge-driver/sweep-began"
r_idle_pause(){
  local secs="$IDLE_SECS" i=0 left slice woke d wakes=()
  while [ "$i" -lt "$IDLE_RUN" ] && [ "$secs" -lt "$IDLE_MAX_SECS" ]; do secs=$((secs * 2)); i=$((i + 1)); done
  [ "$secs" -le "$IDLE_MAX_SECS" ] || secs="$IDLE_MAX_SECS"
  IDLE_RUN=$((IDLE_RUN + 1))
  [ "$IDLE_RUN" -eq 1 ] || r_log "idle sweep $IDLE_RUN in a row: next look in ${secs}s, sooner once a worker exits or a PR leaves draft"
  while IFS="$TAB" read -r _ d _; do if [ -n "$d" ]; then wakes+=("$d/merge-driver/wake"); fi; done <<EOF_W
$COVER
EOF_W
  left="$secs"
  while [ "$left" -gt 0 ]; do
    slice="$WAKE_SECS"; [ "$slice" -le "$left" ] || slice="$left"
    r_pause "$slice"
    left=$((left - slice))
    [ "$left" -gt 0 ] || break
    woke=$(find "${R_EXITS:-$R_STATE/no-exits}" ${wakes[@]+"${wakes[@]}"} -maxdepth 0 -newer "$R_MARK" 2>/dev/null | head -1)
    if [ -n "$woke" ]; then
      case "$woke" in */merge-driver/wake) r_log "woken: a PR left draft — looking again now" ;; *) r_log "woken: a worker exited — looking again now" ;; esac
      return 0
    fi
  done
}

r_log "merge driver up for every batch: repo=$R_REPO author=$R_AUTHOR"
OPEN_PRS="$R_STATE/merge-driver/open-prs.json"; GH_ERR="$R_STATE/merge-driver/gh-pr-list.err"
SWEEP=0
while true; do
  r_stop_if_asked
  SWEEP=$((SWEEP + 1)); touch "$R_MARK"
  SAID_LAST="$SAID_NOW"; SAID_NOW=""
  if [ -n "$LOG" ] && ! [ /dev/fd/1 -ef "$R_STATE/merge-driver.log" ]; then exec >>"$R_STATE/merge-driver.log" 2>&1; fi
  list=$(batches </dev/null) || { say "could not list the repo's batches"; list=""; }
  COVER=""; kept=""
  while IFS="$TAB" read -r name state keys; do
    [ -n "$state" ] || continue
    if [ "$state" != "$R_STATE" ]; then
      if ! point "$state"; then
        if [ -n "$POINT_HOLDER" ]; then say "batch $name: its own merge driver (pid $POINT_HOLDER) runs it, so this one leaves it"
        else say "batch $name: a merge driver of its own is starting, so this one leaves it"; fi
        continue
      fi
      kept="$kept$state$NL"
    fi
    COVER="$COVER$name$TAB$state$TAB$keys$NL"
  done <<EOF_L
$list
EOF_L
  # A batch no longer covered (archived, idle of tickets, its grant gone) loses its pointer.
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$NL$kept" in *"$NL$d$NL"*) ;; *) unpoint "$d" ;; esac
  done <<EOF_P
$POINTED
EOF_P
  POINTED="$kept"
  if [ -z "$COVER" ]; then say "no batch has tickets to merge"; r_idle_pause; continue; fi
  say "batches: $(printf '%s' "$COVER" | cut -f1 | sed 's/^:$/standing/' | paste -sd ' ' -)"

  raw=$(gh pr list --repo "$R_REPO" --state open --author "$R_AUTHOR" --limit 100 \
      --json number,title,headRefName,baseRefName,isDraft,headRefOid,mergeStateStatus 2>"$GH_ERR"); rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 4 ] || grep -qiE 'gh auth login|not logged in|HTTP 401|bad credentials' "$GH_ERR"; then
      r_log "FAIL: gh is signed out ($(tail -1 "$GH_ERR" 2>/dev/null)) — nothing can merge until \`gh auth login\`; stopping"; exit 1
    fi
    say "could not list PRs"; r_pause 120; continue
  fi
  printf '%s' "$raw" > "$OPEN_PRS"

  merged=""; busy=""
  while IFS="$TAB" read -r name state keys; do
    [ -n "$state" ] || continue
    set -- --tickets "$keys"
    [ "$name" = : ] || set -- --batch "$name" "$@"
    MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_SWEEP=$$ MERGE_DRIVER_LOOP=$SWEEP MERGE_DRIVER_OPEN_PRS="$OPEN_PRS" \
      "$DESK_ENV_DIR/merge-driver.sh" "$@" ${LOG:+--log} </dev/null &
    CHILD=$!
    wait "$CHILD"; rc=$?
    while kill -0 "$CHILD" 2>/dev/null; do wait "$CHILD"; rc=$?; done
    CHILD=""
    case "$rc" in
      0) ;;
      "$SWEEP_MERGED") merged=1 ;;
      "$SWEEP_BUSY") busy=1 ;;
      *) [ -n "$STOP" ] || say "batch ${name/#:/standing}: its loop stopped with exit $rc; its merge-driver.log says why" ;;
    esac
    r_stop_if_asked
  done <<EOF_C
$COVER
EOF_C
  if [ -n "$merged" ]; then IDLE_RUN=0; r_pause 30
  elif [ -n "$busy" ]; then IDLE_RUN=0; r_pause 120
  else r_idle_pause; fi
done
