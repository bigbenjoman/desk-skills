#!/usr/bin/env bash
# Serial merge driver for an autopilot batch. Start it at Stage 4, before the first worker finishes:
#   nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2 ABC-3" --deps "ABC-3:ABC-1,ABC-2" \
#     >> ~/.desk-autopilot/<slug>/merge-driver.log 2>&1 &
# Run it from inside the repo (or with DESK_REPO_DIR set): the repo decides which config applies.
#
# --tickets  the batch's keys (whitespace- or comma-separated). Each must match config §4 Ticket key
#            pattern in full; with §4 Tracker `none`, each is `issue-<n>` (GitHub issue n, which also
#            matches `#<n>` in a title) or the batch's lowercase kebab slug. Only PRs whose title or head
#            branch carries one of them are touched
# --deps     space-separated succ:pred[,pred] — succ is released (state=triaged, moved to the front of
#            the spawn order) once EVERY pred's PR has merged. Chain only real file collisions.
#
# Per loop, over the batch's READY (non-draft) PRs authored by config §1's GitHub handle, ONE AT A TIME:
#   - skips a PR with outstanding review feedback where §3 merge-feedback-first is yes (a
#     CHANGES_REQUESTED decision or an unresolved thread), and disarms its auto-merge
#   - arms `gh pr merge --<§4 Merge method> --auto` where §3 pr-auto-merge is yes, and merges outright
#     when green: every check §4 Required checks names has passed (with `none`, every check on the PR)
#   - skips a DIRTY PR (a conflict needs resolving and a fresh review, not a merge)
#   - where §3 ci-rerun is yes, reruns `--failed` only on a workflow run that has reached `completed`, with a
#     12-minute cooldown. Per-PR cancel-in-progress kills a run in flight, and a loop that re-reads too
#     soon after a rerun sees the stale `completed` and fires again, starving the PR forever.
# It NEVER undrafts: that happens only after the review at the current head is clean (see SKILL.md).
#
# Refuses to start unless config §3 autopilot-merge AND pr-merge-green are both `yes`, or while another
# merge driver is running. Where the grants are missing, the orchestrator reports green PRs and the
# user merges.
#
# Exit codes: 2 bad arguments · 1 not permitted, missing tool or config row, or another driver running.
set -uo pipefail

usage(){ echo "usage: merge-driver.sh --tickets \"<TICKET> <TICKET>\" [--deps \"<succ>:<pred>[,<pred>]\"]" >&2; exit 2; }

# ---- arguments: validated before anything else runs ---------------------------------------------
TICKETS=""; DEPS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tickets) [ "$#" -ge 2 ] || usage; TICKETS="$2"; shift 2 ;;
    --deps)    [ "$#" -ge 2 ] || usage; DEPS="$2"; shift 2 ;;
    *) usage ;;
  esac
done

# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"

# What a key looks like in this repo: §4 Ticket key pattern, or a kebab slug when there is no tracker.
# Matched in full with JavaScript regex semantics (the pattern may use \d), never with grep -E.
TRACKER="$(desk_cfg tracker 2>/dev/null | tr 'A-Z' 'a-z' || true)"
if [ "$TRACKER" = none ]; then
  PATTERN='[a-z0-9]+(?:-[a-z0-9]+)*'; KIND="issue-<n> or a lowercase kebab slug"; EDGE='A-Za-z0-9-'
else
  PATTERN="$(desk_cfg ticket-pattern 2>/dev/null || true)"
  [ -n "$PATTERN" ] || { echo "FAIL: config §4 Ticket key pattern is not set — run /desk-setup. Refusing to guess which PRs are the batch's." >&2; exit 1; }
  KIND="a key matching config §4 Ticket key pattern ($PATTERN)"; EDGE='A-Za-z0-9'
fi
is_key(){ node -e 'const [p,t]=process.argv.slice(1); process.exit(new RegExp(`^(?:${p})$`).test(t) ? 0 : 1)' "$PATTERN" "$1"; }

# Every key is checked on its own. A stray separator builds `(K1|K2|)`, whose empty
# alternative matches every open PR by the author.
set -f
KEY_LIST=()
for t in $(printf '%s' "$TICKETS" | tr ',\n\t' '   '); do
  if ! is_key "$t"; then
    echo "FAIL: --tickets entry '$t' is not $KIND" >&2; exit 2
  fi
  KEY_LIST+=("$t")
done
[ "${#KEY_LIST[@]}" -gt 0 ] || { echo "FAIL: --tickets is required and must name at least one ticket ($KIND)" >&2; exit 2; }
DEP_LIST=()
for pair in $(printf '%s' "$DEPS" | tr '\n\t' '  '); do
  succ=${pair%%:*}; preds=${pair#*:}
  ok=1
  case "$pair" in *:*:*|:*|*:|*,,*|*:,*|*,) ok=0 ;; *:*) ;; *) ok=0 ;; esac
  if [ "$ok" = 1 ]; then
    is_key "$succ" || ok=0
    for pred in $(printf '%s' "$preds" | tr ',' ' '); do is_key "$pred" || ok=0; done
  fi
  [ "$ok" = 1 ] || { echo "FAIL: --deps entry '$pair' is malformed (want <succ>:<pred>[,<pred>], each $KIND)" >&2; exit 2; }
  DEP_LIST+=("$pair")
done
set +f
# Keys are literal: escape them before they become a regex, then bound them so ABC-1 never matches ABC-12.
re_escape(){ printf '%s' "$1" | sed 's/[][\.*^$+?(){}|/]/\\&/g'; }
# Each key carries its own bounds. With no tracker, issue-<n> is bounded by digits only (so the branch
# `fix/issue-12-login` matches and `issue-120` does not) and also matches the `#<n>` a PR title uses.
key_re(){ local n; n="$(printf '%s' "$1" | sed -nE 's/^issue-([0-9]+)$/\1/p')"
  if [ "$TRACKER" = none ] && [ -n "$n" ]; then
    printf '(^|[^A-Za-z0-9-])issue-%s([^0-9]|$)|#%s([^0-9]|$)' "$n" "$n"
  else
    printf '(^|[^%s])%s([^%s]|$)' "$EDGE" "$(re_escape "$1")" "$EDGE"
  fi; }
KEY_RES=()
for t in "${KEY_LIST[@]}"; do KEY_RES+=("($(key_re "$t"))"); done
KEYS="$(IFS='|'; printf '%s' "${KEY_RES[*]}")"

for id in autopilot-merge pr-merge-green; do
  p="$(desk_perm "$id")"
  if [ "$p" != "yes" ]; then
    echo "FAIL: config §3 $(node "$DESK_ENV_MJS" key "$id") is $p — the driver merges nothing." >&2
    echo "      Report green PRs to the user instead, or run /desk-setup to grant it." >&2
    exit 1
  fi
done
AUTO_PERM="$(desk_perm pr-auto-merge)"

# How this repo merges, and what "green" means here — both from config §4, never assumed.
MERGE_METHOD="$(desk_cfg merge-method 2>/dev/null | tr 'A-Z' 'a-z' | awk '{print $1}' || true)"
case "$MERGE_METHOD" in
  squash|merge|rebase) ;;
  *) echo "FAIL: config §4 Merge method is '${MERGE_METHOD:-unset}' — want squash, merge or rebase. Run /desk-setup." >&2; exit 1 ;;
esac
if ! REQUIRED_RAW="$(desk_cfg required-checks 2>/dev/null)"; then
  echo "FAIL: config §4 Required checks is not set — run /desk-setup (\`none\` means every check on the PR must pass)." >&2; exit 1
fi
REQUIRED=""   # newline-separated check names; empty = every check on the PR
case "$(printf '%s' "$REQUIRED_RAW" | tr 'A-Z' 'a-z')" in
  none|none\ *) ;;
  *) REQUIRED="$(printf '%s' "$REQUIRED_RAW" | tr ',;' '\n\n' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | grep -v '^$' || true)" ;;
esac
RERUN_PERM="$(desk_perm ci-rerun)"
FEEDBACK_PERM="$(desk_perm merge-feedback-first)"

desk_load_paths || exit 1
desk_load_identity || exit 1
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

# The regex goes to jq with --arg, never spliced into a jq string, so no quoting layer can mangle it.
# A PR belongs to the batch if its title OR its head branch carries a key: branch names carry the
# ticket by convention (§5 Branch names) even where titles do not.
prs(){ # prs <true|false>  — draft or ready batch PRs
  gh pr list --repo "$REPO" --state open --author "$AUTHOR" --limit 100 --json number,title,headRefName,isDraft 2>/dev/null \
    | jq -r --argjson d "$1" --arg re "$KEYS" '.[] | select(.isDraft==$d) | select((.title + " " + .headRefName) | test($re)) | .number' 2>/dev/null | sort -n
}
merged_for(){
  gh pr list --repo "$REPO" --state merged --author "$AUTHOR" --limit 100 --json number,title,headRefName 2>/dev/null \
    | jq -r --arg re "$(key_re "$1")" '.[] | select((.title + " " + .headRefName) | test($re)) | .number' 2>/dev/null | head -1
}
# Green, from structured output (never by splitting the table, whose name column can carry emoji):
#   pass     every §4 Required check reported and passed (skipped counts as passed, as GitHub counts it);
#            with Required checks `none`, every check on the PR passed and there is at least one
#   fail     any of those checks failed or was cancelled
#   pending  anything else, including a required check that has not reported yet
gate(){
  gh pr checks "$1" --repo "$REPO" --json name,bucket 2>/dev/null | jq -r --arg req "$REQUIRED" '
    ($req | split("\n") | map(select(length > 0))) as $names
    | def bad: . == "fail" or . == "cancel";
      def good: . == "pass" or . == "skipping";
    if ($names | length) == 0 then
      if length == 0 then "pending"
      elif any(.[]; .bucket | bad) then "fail"
      elif all(.[]; .bucket | good) then "pass" else "pending" end
    else
      . as $all
      | [ $names[] as $n | [ $all[] | select(.name == $n) | .bucket ] ] as $b
      | if any($b[]; any(.[]; bad)) then "fail"
        elif all($b[]; length > 0 and all(.[]; good)) then "pass" else "pending" end
    end' 2>/dev/null
}
# Resolve runs from the PR's head SHA, never from the top of `gh run list`.
# Prints "<in-flight count> <failed completed run ids...>".
runs_for(){ local sha; sha=$(gh pr view "$1" --repo "$REPO" --json headRefOid -q .headRefOid 2>/dev/null)
  [ -n "$sha" ] || return 0
  gh run list --repo "$REPO" --commit "$sha" --limit 50 --json databaseId,status,conclusion 2>/dev/null \
    | jq -r 'if length == 0 then "" else
        "\([.[] | select(.status != "completed")] | length) \([.[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")) | .databaseId] | map(tostring) | join(" "))"
      end' 2>/dev/null; }
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

log "merge driver up: repo=$REPO author=$AUTHOR tickets=[${KEY_LIST[*]}] deps=[${DEP_LIST[*]:-none}] method=$MERGE_METHOD required=[$(printf '%s' "${REQUIRED:-every check}" | paste -sd ',' -)] auto-merge=$AUTO_PERM ci-rerun=$RERUN_PERM feedback-first=$FEEDBACK_PERM"
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

  [ "$AUTO_PERM" = "yes" ] && gh pr merge "$n" --repo "$REPO" "--$MERGE_METHOD" --auto >/dev/null 2>&1

  ms=$(gh pr view "$n" --repo "$REPO" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null)
  [ "$ms" = "DIRTY" ] && { log "#$n DIRTY - needs a conflict resolution and a fresh review"; sleep 120; continue; }

  g=$(gate "$n")
  if [ "$g" = "pass" ]; then
    log "#$n gate GREEN - merging"
    if gh pr merge "$n" --repo "$REPO" "--$MERGE_METHOD" >/dev/null 2>&1; then log "#$n MERGED"; release_chain; else log "#$n merge refused (ms=$ms)"; fi
    sleep 30; continue
  fi

  rr=$(runs_for "$n")
  if [ -z "$rr" ]; then log "#$n no workflow run yet (checks: ${g:-unreadable})"; sleep 120; continue; fi
  inflight=${rr%% *}; failed_ids=${rr#* }; [ "$failed_ids" = "$rr" ] && failed_ids=""
  if [ "$g" != "fail" ] || [ -z "${failed_ids// /}" ]; then
    log "#$n checks ${g:-unreadable}; $inflight run(s) in flight"; sleep 120; continue
  fi

  if [ "$g" = "fail" ]; then
    if [ "$RERUN_PERM" != "yes" ]; then
      log "#$n red + completed - config §3 ci-rerun is $RERUN_PERM, so not rerunning; report it"
    else
      cd_file="$DESK_STATE/.cooldown-$n"
      now=$(date +%s); last=0; [ -f "$cd_file" ] && last=$(cat "$cd_file" 2>/dev/null || echo 0)
      if [ $((now - last)) -lt 720 ]; then
        log "#$n red, cooling down ($(( (720 - (now - last)) / 60 ))m left)"
      else
        for rid in $failed_ids; do
          log "#$n red + completed -> rerun --failed on $rid"
          if gh run rerun "$rid" --repo "$REPO" --failed >/dev/null 2>&1; then echo "$now" > "$cd_file"; else log "#$n rerun of $rid refused"; fi
        done
      fi
    fi
  fi
  sleep 120
done
