# shellcheck shell=bash
# Sourced by merge-driver.sh for --all-batches: one merge driver for every batch of the repo, so GitHub
# is asked for the open PRs once per sweep however many batches there are. Each sweep:
#   - lists the repo's batches (batches.mjs runBatches: every batch, or only the one an explicit
#     DESK_BATCH, DESK_QUEUE or DESK_AUTOPILOT_STATE names) and covers each that is handed over, has
#     tickets and a merge grant, and has no driver of its own running; a batch the archive told its
#     driver to stop for (batch.mjs archiveCheck) is left to be archived;
#   - reads the author's open PRs on every base in one `gh pr list`, into <state>/merge-driver/open-prs.json;
#   - runs one loop of each covered batch's own driver in turn (merge-driver.sh --tickets <its tickets>,
#     with --batch for a named batch), which reads that list instead of asking GitHub again, and merges
#     onto that batch's base as a driver of its own would. A red base holds only its own batch's loop.
# Then it waits 30s after any merge, 120s while any batch has ready PRs waiting, and otherwise backs off
# as an idle driver does, ending the wait once a worker exits or any covered batch's PR leaves draft.
# It holds the repo's lock, <state>/merge-driver/repo.lock.d of the standing batch (or of the one batch
# named), and writes its pid into the lock of each batch it covers, and only while it covers it, so
# whatever reads a batch's lock sees the driver that merges it. Every lock it holds or points goes when
# it exits. TERM stops the batch loop running, as it stops a driver mid-loop, then this one.

# A batch loop's exit, in a sweep: what the sweep did for that batch.
SWEEP_MERGED=10; SWEEP_BUSY=11
# A list as long as its limit may have left PRs out: each batch then lists its own, as before.
LIST_LIMIT="${MERGE_DRIVER_LIST_LIMIT:-1000}"

if ! R="$(desk_load_paths >/dev/null && desk_load_identity >/dev/null \
  && printf '%s\t%s\t%s\t%s\t%s' "$DESK_STATE" "$DESK_GH_REPO" "$DESK_GITHUB_HANDLE" "$DESK_RUN_BIN" "$DESK_EXITS_DIR")"; then
  echo "FAIL: --all-batches: could not resolve the repo's paths" >&2; exit 1
fi
IFS="$(printf '\t')" read -r R_STATE R_REPO R_AUTHOR R_BIN R_EXITS <<EOF_R
$R
EOF_R
mkdir -p "$R_STATE/merge-driver" || exit 1
if [ -n "$LOG" ]; then exec >>"$R_STATE/merge-driver.log" 2>&1; fi
log(){ echo "$(date -u +%H:%M:%SZ) $*"; }

TAB="$(printf '\t')"; NL=$'\n'
R_LOCK="$R_STATE/merge-driver/repo.lock.d"; R_HELD=""; POINTED=""; CHILD=""; SLEEP_PID=""; STOP=""; COVER=""
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
  # Only while the lock is still this driver's: one moved or taken over is another driver's now.
  [ -n "$R_HELD" ] && [ "$(cat "$R_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$R_LOCK"
  log "merge driver exited $rc"
}
trap r_exit EXIT
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "FAIL: gh is required" >&2; exit 1; }
idle_settings

lock_take "$R_LOCK" || { echo "FAIL: another merge driver for the repo is running (pid $LOCK_HOLDER, lock $R_LOCK). Stop it first; if it is dead, remove the lock." >&2; exit 1; }
R_HELD=1
node "$R_BIN/installed.mjs" running > "$R_LOCK/version" 2>/dev/null || true
trap 'exit 130' INT
trap 'STOP=143; [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null' TERM
stop_if_asked(){ if [ -n "$STOP" ]; then exit "$STOP"; fi; }
pause(){ pause_for "$1"; }

# point <state>: this driver's pid in a batch's lock. Fails, with LOCK_HOLDER set, while a driver of
# that batch's own holds it (empty: one is starting).
point(){
  mkdir -p "$1" && lock_take "$1/merge-driver.lock.d" point || return 1
  cp "$R_LOCK/version" "$1/merge-driver.lock.d/version" 2>/dev/null || true
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
const { runBatches } = await at('batches.mjs');
const { readQueue } = await at('batch-state.mjs');
for (const b of runBatches()) {
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
  log "$*"
}

log "merge driver up for every batch: repo=$R_REPO author=$R_AUTHOR"
OPEN_PRS="$R_STATE/merge-driver/open-prs.json"; GH_ERR="$R_STATE/merge-driver/gh-pr-list.err"; R_MARK="$R_STATE/merge-driver/sweep-began"
SWEEP=0
while true; do
  stop_if_asked
  SWEEP=$((SWEEP + 1)); touch "$R_MARK"
  SAID_LAST="$SAID_NOW"; SAID_NOW=""
  if [ -n "$LOG" ] && ! [ /dev/fd/1 -ef "$R_STATE/merge-driver.log" ]; then exec >>"$R_STATE/merge-driver.log" 2>&1; fi
  list=$(batches </dev/null) || { say "could not list the repo's batches"; list=""; }
  COVER=""; kept=""; wakes=("${R_EXITS:-$R_STATE/no-exits}")
  while IFS="$TAB" read -r name state keys; do
    [ -n "$state" ] || continue
    if ! point "$state"; then
      if [ -n "$LOCK_HOLDER" ]; then say "batch ${name/#:/standing}: its own merge driver (pid $LOCK_HOLDER) runs it, so this one leaves it"
      else say "batch ${name/#:/standing}: a merge driver of its own is starting, so this one leaves it"; fi
      continue
    fi
    kept="$kept$state$NL"
    COVER="$COVER$name$TAB$state$TAB$keys$NL"; wakes+=("$state/merge-driver/wake")
  done <<EOF_L
$list
EOF_L
  # A batch no longer covered (archived, out of tickets, its grant gone) loses its pointer.
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$NL$kept" in *"$NL$d$NL"*) ;; *) unpoint "$d" ;; esac
  done <<EOF_P
$POINTED
EOF_P
  POINTED="$kept"
  if [ -z "$COVER" ]; then say "no batch has tickets to merge"; idle_pause "$R_MARK" sweep "${wakes[@]}"; continue; fi
  say "batches: $(printf '%s' "$COVER" | cut -f1 | sed 's/^:$/standing/' | paste -sd ' ' -)"

  raw=$(gh pr list --repo "$R_REPO" --state open --author "$R_AUTHOR" --limit "$LIST_LIMIT" \
      --json number,title,headRefName,baseRefName,isDraft,headRefOid,mergeStateStatus 2>"$GH_ERR"); rc=$?
  if [ "$rc" -ne 0 ]; then
    if signed_out "$rc" "$GH_ERR"; then
      log "FAIL: gh is signed out ($(tail -1 "$GH_ERR" 2>/dev/null)) — nothing can merge until \`gh auth login\`; stopping"; exit 1
    fi
    say "could not list PRs"; pause 120; continue
  fi
  printf '%s' "$raw" > "$OPEN_PRS"; shared="$OPEN_PRS"
  if [ "$(jq length "$OPEN_PRS" 2>/dev/null || echo 0)" -ge "$LIST_LIMIT" ]; then
    say "the open PR list reached its limit of $LIST_LIMIT, so each batch lists its own this sweep"; shared=""
  fi

  merged=""; busy=""
  while IFS="$TAB" read -r name state keys; do
    [ -n "$state" ] || continue
    set -- --tickets "$keys"
    [ "$name" = : ] || set -- --batch "$name" "$@"
    MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_SWEEP=$$ MERGE_DRIVER_LOOP=$SWEEP MERGE_DRIVER_OPEN_PRS="$shared" \
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
    stop_if_asked
  done <<EOF_C
$COVER
EOF_C
  # shellcheck disable=SC2034  # IDLE_RUN is read by idle_pause in merge-driver-lib.sh
  if [ -n "$merged" ]; then IDLE_RUN=0; pause 30
  elif [ -n "$busy" ]; then IDLE_RUN=0; pause 120
  else idle_pause "$R_MARK" sweep "${wakes[@]}"; fi
done
