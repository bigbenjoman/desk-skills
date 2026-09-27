#!/usr/bin/env bash
# Serial merge driver for an autopilot batch. Start it at Stage 4, before the first worker finishes:
#   nohup ~/.claude/desk/bin/merge-driver.sh --tickets "SV-1 SV-2 SV-3" --deps "SV-3:SV-1,SV-2" \
#     >> ~/.desk-autopilot/merge-driver.log 2>&1 &
#
# --tickets  the batch's keys (whitespace- or comma-separated, each exactly SV-<digits>); only PRs
#            whose title carries one of them are touched
# --deps     space-separated succ:pred[,pred] — succ is released (state=triaged, moved to the front of
#            the spawn order) once EVERY pred's PR has merged. Chain only real file collisions.
#
# Per loop, over the batch's READY (non-draft) PRs authored by config §1's GitHub handle, ONE AT A TIME:
#   - skips a PR with outstanding review feedback where §3 merge-feedback-first is yes (a
#     CHANGES_REQUESTED decision or an unresolved thread), and disarms its auto-merge
#   - arms `gh pr merge --squash --auto` where §3 pr-auto-merge is yes, and merges outright when
#     `🏁 CI gate` is green
#   - skips a DIRTY PR (a conflict needs resolving and a fresh review, not a merge)
#   - where §3 ci-rerun is yes, reruns `--failed` only on a CI run that has reached `completed`, with a
#     12-minute cooldown. Per-PR cancel-in-progress kills a run in flight, and a loop that re-reads too
#     soon after a rerun sees the stale `completed` and fires again, starving the PR forever.
# It NEVER undrafts: that happens only after the review at the current head is clean (see SKILL.md).
#
# Refuses to start unless config §3 autopilot-merge AND pr-merge-green are both `yes`, or while another
# merge driver is running. Where the grants are missing, the orchestrator reports green PRs and the
# user merges.
#
# Exit codes: 2 bad arguments · 1 not permitted, missing tool, or another driver running.
set -uo pipefail

usage(){ echo "usage: merge-driver.sh --tickets \"SV-1 SV-2\" [--deps \"SV-3:SV-1,SV-2\"]" >&2; exit 2; }

# ---- arguments: validated before anything else runs ---------------------------------------------
TICKETS=""; DEPS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tickets) [ "$#" -ge 2 ] || usage; TICKETS="$2"; shift 2 ;;
    --deps)    [ "$#" -ge 2 ] || usage; DEPS="$2"; shift 2 ;;
    *) usage ;;
  esac
done

# Every key is checked on its own. A stray separator builds `(SV-1|SV-2|)`, whose empty
# alternative matches every open PR by the author.
set -f
KEY_LIST=()
for t in $(printf '%s' "$TICKETS" | tr ',\n\t' '   '); do
  if ! printf '%s' "$t" | grep -Eq '^SV-[0-9]+$'; then
    echo "FAIL: --tickets entry '$t' is not a ticket key (want SV-<digits>)" >&2; exit 2
  fi
  KEY_LIST+=("$t")
done
[ "${#KEY_LIST[@]}" -gt 0 ] || { echo "FAIL: --tickets is required and must name at least one SV-<digits> key" >&2; exit 2; }
DEP_LIST=()
for pair in $(printf '%s' "$DEPS" | tr '\n\t' '  '); do
  if ! printf '%s' "$pair" | grep -Eq '^SV-[0-9]+:SV-[0-9]+(,SV-[0-9]+)*$'; then
    echo "FAIL: --deps entry '$pair' is malformed (want SV-3:SV-1,SV-2)" >&2; exit 2
  fi
  DEP_LIST+=("$pair")
done
set +f
KEYS="($(IFS='|'; printf '%s' "${KEY_LIST[*]}"))([^0-9]|\$)"

# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"

for id in autopilot-merge pr-merge-green; do
  p="$(studia_perm "$id")"
  if [ "$p" != "yes" ]; then
    echo "FAIL: config §3 $(node "$DESK_ENV_MJS" key "$id") is $p — the driver merges nothing." >&2
    echo "      Report green PRs to the user instead, or run /desk-setup to grant it." >&2
    exit 1
  fi
done
AUTO_PERM="$(studia_perm pr-auto-merge)"
RERUN_PERM="$(studia_perm ci-rerun)"
FEEDBACK_PERM="$(studia_perm merge-feedback-first)"

studia_load_paths || exit 1
studia_load_identity || exit 1
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "FAIL: gh is required" >&2; exit 1; }

# ---- one driver at a time --------------------------------------------------------------------
# Two drivers would each arm, merge and rerun the same PRs, and double reruns cancel each other.
mkdir -p "$DESK_STATE"
LOCKD="$DESK_STATE/merge-driver.lock.d"
while ! mkdir "$LOCKD" 2>/dev/null; do
  holder="$(cat "$LOCKD/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    echo "FAIL: another merge driver is running (pid $holder, lock $LOCKD). Stop it first; if it is dead, remove the lock." >&2
    exit 1
  fi
  if [ -z "$holder" ] && [ -z "$(find "$LOCKD" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then sleep 1; continue; fi
  mv "$LOCKD" "$LOCKD.stale.$$" 2>/dev/null && rm -rf "$LOCKD.stale.$$"   # atomic takeover of a dead holder's lock
done
echo "$$" > "$LOCKD/pid"
trap 'rm -rf "$LOCKD"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$DESK_REPO_ROOT" || exit 1
log(){ echo "$(date -u +%H:%M:%SZ) $*"; }
Q="$DESK_BIN/queue.mjs"
REPO="$DESK_GH_REPO"
AUTHOR="$DESK_GITHUB_HANDLE"

prs(){ # prs <true|false>  — draft or ready batch PRs
  gh pr list --repo "$REPO" --state open --author "$AUTHOR" --limit 100 --json number,title,isDraft \
    --jq ".[] | select(.isDraft==$1) | select(.title | test(\"$KEYS\")) | .number" 2>/dev/null | sort -n
}
merged_for(){
  gh pr list --repo "$REPO" --state merged --author "$AUTHOR" --search "$1 in:title" --limit 5 --json number,title \
    --jq ".[] | select(.title | test(\"$1([^0-9]|\$)\")) | .number" 2>/dev/null | head -1
}
# `gh pr checks` is tab-separated and the name column carries an emoji: split on tabs, never whitespace,
# or the verdict column silently reads as `CI` and nothing ever merges.
gate(){ gh pr checks "$1" --repo "$REPO" 2>/dev/null | awk -F'\t' '$1 ~ /CI gate/ {print $2; exit}'; }
# Resolve the run from the PR's head SHA, never from the top of `gh run list`.
ci_run(){ local sha; sha=$(gh pr view "$1" --repo "$REPO" --json headRefOid -q .headRefOid 2>/dev/null)
  gh run list --repo "$REPO" --commit "$sha" --limit 20 --json databaseId,name -q '.[] | select(.name=="CI") | .databaseId' 2>/dev/null | head -1; }
run_status(){ gh run view "$1" --repo "$REPO" --json status -q .status 2>/dev/null; }
# Prints "<reviewDecision> <unresolved thread count>". An empty reviewDecision is not an approval.
feedback(){
  gh api graphql -f owner="${REPO%%/*}" -f name="${REPO#*/}" -F n="$1" -f query='
    query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
      reviewDecision reviewThreads(first:100){nodes{isResolved}}}}}' \
    --jq '.data.repository.pullRequest | "\(.reviewDecision // "NONE") \([.reviewThreads.nodes[] | select(.isResolved|not)] | length)"' 2>/dev/null
}

release_chain(){
  local pair succ preds st all got pred n
  for pair in ${DEP_LIST[@]+"${DEP_LIST[@]}"}; do
    succ=${pair%%:*}; preds=${pair##*:}
    st=$(node "$Q" get "$succ" 2>/dev/null | jq -r '.state + "|" + (.park.question // "")')
    case "$st" in
      "parked|held by orchestrator"*)
        all=1; got=""
        for pred in ${preds//,/ }; do
          n=$(merged_for "$pred"); [ -z "$n" ] && { all=0; break; }; got="$got $pred#$n"
        done
        if [ "$all" = 1 ]; then
          node "$Q" set "$succ" state=triaged park=null collides_with=null >/dev/null \
            && node "$Q" front "$succ" >/dev/null && log "merged:$got -> RELEASED $succ (moved to front)"
        fi ;;
    esac
  done
}

log "merge driver up: repo=$REPO author=$AUTHOR tickets=[${KEY_LIST[*]}] deps=[${DEP_LIST[*]:-none}] auto-merge=$AUTO_PERM ci-rerun=$RERUN_PERM feedback-first=$FEEDBACK_PERM"
while true; do
  release_chain

  drafts=$(prs true | tr '\n' ' '); [ -n "${drafts// /}" ] && log "draft (still reviewing): $drafts"
  open=$(prs false)
  [ -z "$open" ] && { log "no ready batch PRs"; sleep 60; continue; }

  n=$(printf '%s\n' "$open" | head -1)
  log "focus #$n (serial)"

  if [ "$FEEDBACK_PERM" = "yes" ]; then
    fb=$(feedback "$n")
    if [ -z "$fb" ]; then log "#$n could not read review state - not merging this loop"; sleep 120; continue; fi
    decision=${fb% *}; unresolved=${fb##* }
    if [ "$decision" = "CHANGES_REQUESTED" ] || [ "${unresolved:-0}" -gt 0 ]; then
      gh pr merge "$n" --repo "$REPO" --disable-auto >/dev/null 2>&1
      log "#$n has outstanding review feedback ($decision, $unresolved unresolved) - work it first; not merging"
      sleep 120; continue
    fi
  fi

  [ "$AUTO_PERM" = "yes" ] && gh pr merge "$n" --repo "$REPO" --squash --auto >/dev/null 2>&1

  ms=$(gh pr view "$n" --repo "$REPO" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null)
  [ "$ms" = "DIRTY" ] && { log "#$n DIRTY - needs a conflict resolution and a fresh review"; sleep 120; continue; }

  g=$(gate "$n")
  if [ "$g" = "pass" ]; then
    log "#$n gate GREEN - merging"
    if gh pr merge "$n" --repo "$REPO" --squash >/dev/null 2>&1; then log "#$n MERGED"; release_chain; else log "#$n merge refused (ms=$ms)"; fi
    sleep 30; continue
  fi

  rid=$(ci_run "$n")
  if [ -z "$rid" ]; then log "#$n no CI run yet"; sleep 120; continue; fi
  st=$(run_status "$rid")
  if [ "$st" != "completed" ]; then log "#$n CI in flight ($st)"; sleep 120; continue; fi

  if [ "$g" = "fail" ]; then
    if [ "$RERUN_PERM" != "yes" ]; then
      log "#$n red + completed - config §3 ci-rerun is $RERUN_PERM, so not rerunning; report it"
    else
      cd_file="$DESK_STATE/.cooldown-$n"
      now=$(date +%s); last=0; [ -f "$cd_file" ] && last=$(cat "$cd_file" 2>/dev/null || echo 0)
      if [ $((now - last)) -lt 720 ]; then
        log "#$n red, cooling down ($(( (720 - (now - last)) / 60 ))m left)"
      else
        log "#$n red + completed -> rerun --failed on $rid"
        if gh run rerun "$rid" --repo "$REPO" --failed >/dev/null 2>&1; then echo "$now" > "$cd_file"; else log "#$n rerun refused"; fi
      fi
    fi
  fi
  sleep 120
done
