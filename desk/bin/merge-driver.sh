#!/usr/bin/env bash
# Serial merge driver for an autopilot batch. Start it at Stage 4, before the first worker finishes:
#   nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2 ABC-3" --deps "ABC-3:ABC-1,ABC-2" \
#     >> ~/.desk-autopilot/<slug>/merge-driver.log 2>&1 &
# Run it from inside the repo (or with DESK_REPO_DIR set): the repo decides which config applies.
#
# --tickets  the batch's ids (whitespace- or comma-separated), each one `desk-env ticket-kind` accepts:
#            a §4 Ticket key pattern key, a §4 Other work id patterns id, or with §4 Tracker `none`
#            `issue-<n>` or a lower-case kebab slug. Case-sensitive as written. These are the starting
#            set: every loop also takes in each ticket in the queue (`queue.mjs admit`, a requeue), so a
#            ticket that joins the batch mid-run is merged with no restart.
# --deps     space-separated succ:pred[,pred] — succ is released (state=triaged, moved to the front of
#            the spawn order) once EVERY pred's PR has merged. Chain only real file collisions.
#
# Which PRs are the batch's: open, authored by config §1's GitHub handle, based on §0 Default branch
# (never a promotion PR such as main -> production), and whose head branch is the branch recorded in
# the queue for that ticket (setup-worktree.sh made it). Only where no branch is recorded does the
# driver fall back to the id in the title or branch, bounded so `BUG-119` never matches `BUG-119-5`
# or `BUG-1190` while `fix/BUG-119-login` does.
#
# Per loop, every ready (non-draft) batch PR is considered in turn, and the first that is mergeable
# is merged; one merge per loop, because a merge moves the default branch under every other PR. A
# PR that cannot merge is skipped with its reason logged and never blocks the others:
#   - touches a §4 Merge holds path          held for a person, with the hold's reason
#   - review feedback outstanding            a CHANGES_REQUESTED decision or an unresolved thread,
#                                            unless §3 merge-feedback-first is explicitly `no`
#                                            (unset, ask and yes are all the strict default)
#   - DIRTY                                  a conflict needs resolving and a fresh review
#   - BEHIND                                 updated with `gh pr update-branch` where §3 pr-update-branch
#                                            is yes (once per head), else parked for a person
#   - not green                              "green" is desk-config.md's one definition, evaluated by
#                                            gate.mjs (shared with desk-clearance); a head must stay
#                                            green across two loops before it merges, so a check that
#                                            passes before the rest of CI has even queued cannot land it
#   - refused by `gh pr merge`               backed off for 10 minutes, then retried
# The merge is pinned with `--match-head-commit <the sha the gate evaluated>`.
# Where §3 ci-rerun is yes, a red PR whose runs have all completed gets `gh run rerun --failed` on
# the runs behind its failing non-advisory checks, at most twice per check per head, 12 minutes apart.
# It NEVER undrafts, and never arms auto-merge (the platform's idea of green is not this one); an
# armed auto-merge on a held PR, or one with feedback outstanding, is disarmed.
#
# Refuses to start unless config §3 autopilot-merge AND pr-merge-green are both `yes`, or while another
# merge driver is running. Where the grants are missing, the orchestrator reports green PRs and the
# user merges.
#
# Environment, for tests and for checking by hand:
#   MERGE_DRIVER_RELEASE_ONLY=1  one release pass, then exit 0
#   MERGE_DRIVER_ONE_LOOP=1      one full loop (join, release, at most one merge), then exit instead of
#                                sleeping: 0, or 1 when the PR list could not be read
#   MERGE_DRIVER_GREEN_SECS=<n>  how long a head must stay green before it merges (default 60)
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
is_key(){ node "$DESK_ENV_MJS" ticket-kind "$1" >/dev/null 2>&1; }
key_error(){ node "$DESK_ENV_MJS" ticket-kind "$1" 2>&1 >/dev/null | sed 's/^desk: //'; }

# Every id is checked on its own. A stray separator must never build an empty alternative that
# matches every open PR by the author.
set -f
KEY_LIST=()
for t in $(printf '%s' "$TICKETS" | tr ',\n\t' '   '); do
  is_key "$t" || { echo "FAIL: --tickets entry: $(key_error "$t")" >&2; exit 2; }
  KEY_LIST+=("$t")
done
[ "${#KEY_LIST[@]}" -gt 0 ] || { echo "FAIL: --tickets is required and must name at least one ticket" >&2; exit 2; }
DEP_LIST=()
for pair in $(printf '%s' "$DEPS" | tr '\n\t' '  '); do
  succ=${pair%%:*}; preds=${pair#*:}
  ok=1
  case "$pair" in *:*:*|:*|*:|*,,*|*:,*|*,) ok=0 ;; *:*) ;; *) ok=0 ;; esac
  if [ "$ok" = 1 ]; then
    is_key "$succ" || ok=0
    for pred in $(printf '%s' "$preds" | tr ',' ' '); do is_key "$pred" || ok=0; done
  fi
  [ "$ok" = 1 ] || { echo "FAIL: --deps entry '$pair' is malformed (want <succ>:<pred>[,<pred>], each an accepted ticket id)" >&2; exit 2; }
  DEP_LIST+=("$pair")
done
set +f

for id in autopilot-merge pr-merge-green; do
  p="$(desk_perm "$id")"
  if [ "$p" != "yes" ]; then
    echo "FAIL: config §3 $(node "$DESK_ENV_MJS" key "$id") is $p — the driver merges nothing." >&2
    echo "      Report green PRs to the user instead, or run /desk-setup to grant it." >&2
    exit 1
  fi
done

# How this repo merges, and what "green" means here — both from config §4, never assumed.
MERGE_METHOD="$(desk_cfg merge-method 2>/dev/null | tr 'A-Z' 'a-z' | awk '{print $1}' || true)"
case "$MERGE_METHOD" in
  squash|merge|rebase) ;;
  *) echo "FAIL: config §4 Merge method is '${MERGE_METHOD:-unset}' — want squash, merge or rebase. Run /desk-setup." >&2; exit 1 ;;
esac
if ! REQUIRED="$(node "$DESK_ENV_MJS" list required-checks 2>/dev/null)"; then
  echo "FAIL: config §4 Required checks is not set — run /desk-setup (\`none\` when nothing is required; every non-advisory check must still pass)." >&2; exit 1
fi
node "$DESK_ENV_MJS" list merge-holds >/dev/null 2>&1 \
  || { echo "FAIL: config §4 Merge holds is not set — run /desk-setup (\`none\` if no path needs a person to merge it). Refusing to guess." >&2; exit 1; }
RERUN_PERM="$(desk_perm ci-rerun)"
UPDATE_PERM="$(desk_perm pr-update-branch)"
# Strict unless explicitly relaxed: unset, ask and yes all mean feedback is worked before merging.
FEEDBACK_RAW="$(node "$DESK_ENV_MJS" perm-or-unset merge-feedback-first 2>/dev/null || echo unset)"
if [ "$FEEDBACK_RAW" = no ]; then FEEDBACK_STRICT=""; else FEEDBACK_STRICT=1; fi

desk_apply_batch_base || exit 1
desk_load_paths || exit 1
desk_load_identity || exit 1
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "FAIL: gh is required" >&2; exit 1; }

# ---- one driver at a time --------------------------------------------------------------------
# Two drivers would each merge and rerun the same PRs, and double reruns cancel each other.
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
GATE="$DESK_BIN/gate.mjs"
REPO="$DESK_GH_REPO"
AUTHOR="$DESK_GITHUB_HANDLE"
BASE_BRANCH="$DESK_DEFAULT_BRANCH"
SD="$DESK_STATE/merge-driver"; mkdir -p "$SD"
GREEN_HOLD_SECS="${MERGE_DRIVER_GREEN_SECS:-60}"

# The id -> (branch, regex) map, rebuilt each loop because the queue learns branches as tickets spawn.
# A recorded branch is matched exactly; only an id with none falls back to the bounded regex.
ticket_map(){   # ticket_map <key>...
  node - "$DESK_QUEUE" "$@" <<'NODE'
const fs = require('fs');
const [qf, ...keys] = process.argv.slice(2);
let q = {};
try { q = JSON.parse(fs.readFileSync(qf, 'utf8')).tickets || {}; } catch { /* no queue: regex only */ }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const re = (k) => {
  const n = /^issue-([0-9]+)$/.exec(k)?.[1];
  if (n) return `(^|[^A-Za-z0-9-])issue-${n}([^0-9]|$)|#${n}([^0-9]|$)`;
  // Right edge: end, a character that cannot continue an id, or `-` followed by a non-digit — so the
  // slug after a key (`fix/BUG-119-login`) matches and a longer id (`BUG-119-5`, `BUG-1190`) does not.
  return `(^|[^A-Za-z0-9-])${esc(k)}($|[^A-Za-z0-9-]|-[^0-9])`;
};
console.log(JSON.stringify(keys.map((k) => ({ key: k, branch: (q[k] && q[k].branch) || '', re: re(k) }))));
NODE
}
# prs <state> [<key>...] -> lines `<number>\t<isDraft>\t<key>` for the batch's PRs (or those keys')
# based on the default branch.
prs(){
  local st="$1"; shift
  local map; if [ "$#" -gt 0 ]; then map="$(ticket_map "$@")"; else map="$(ticket_map "${KEY_LIST[@]}")"; fi || return 1
  gh pr list --repo "$REPO" --state "$st" --author "$AUTHOR" --base "$BASE_BRANCH" --limit 100 \
      --json number,title,headRefName,baseRefName,isDraft 2>/dev/null \
    | jq -r --argjson m "$map" --arg base "$BASE_BRANCH" '
        .[] | select(.baseRefName == $base) | . as $p
        | [ $m[] | .re as $re | select((.branch != "" and $p.headRefName == .branch)
                          or (.branch == "" and (($p.title + " " + $p.headRefName) | test($re)))) | .key ] as $k
        | select(($k | length) > 0)
        | "\($p.number)\t\($p.isDraft)\t\($k[0])"' 2>/dev/null | sort -n
}
# Prints "<reviewDecision> <unresolved thread count>". An empty reviewDecision is not an approval.
feedback(){
  gh api graphql -f owner="${REPO%%/*}" -f name="${REPO#*/}" -F n="$1" -f query='
    query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
      reviewDecision reviewThreads(first:100){nodes{isResolved}}}}}' \
    --jq '.data.repository.pullRequest | "\(.reviewDecision // "NONE") \([.reviewThreads.nodes[] | select(.isResolved|not)] | length)"' 2>/dev/null
}
queue_note(){ node "$Q" set "$1" "merge_blocked=$2" >/dev/null 2>&1 || true; }

# Tickets join the batch after the driver starts, so each loop adds every queue ticket not yet in
# KEY_LIST, checked as a --tickets entry is. A refused id is logged once and never retried.
REFUSED_KEYS=" "
join_queue_tickets(){
  local k keys known=" ${KEY_LIST[*]} "
  keys=$(node - "$DESK_QUEUE" <<'NODE'
const fs = require('fs');
try { for (const k of Object.keys(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).tickets || {})) console.log(k); }
catch { /* no queue yet: nothing to join */ }
NODE
) || return 0
  set -f
  for k in $keys; do
    case "$known$REFUSED_KEYS" in *" $k "*) continue ;; esac
    if is_key "$k"; then KEY_LIST+=("$k"); known="$known$k "; log "$k joined the batch in the queue — its PR is merged with the rest"
    else REFUSED_KEYS="$REFUSED_KEYS$k "; log "queue ticket $k is not merged by this driver: $(key_error "$k")"; fi
  done
  set +f
}

# Release a held ticket once EVERY predecessor has merged. Its predecessors are the union of all its
# --deps entries (a successor named twice, e.g. a collision chain and a Jira chain, waits for both) and
# the queue's held_by (so a blocker added mid-batch counts without a restart). Only a ticket still
# parked "held by orchestrator" is ever released.
release_chain(){
  local plan succ preds got n pred all
  plan=$(node - "$DESK_QUEUE" ${DEP_LIST[@]+"${DEP_LIST[@]}"} <<'NODE'
const fs = require('fs');
const [qf, ...pairs] = process.argv.slice(2);
let q = {}; let spine = null;
try { const all = JSON.parse(fs.readFileSync(qf, 'utf8')); q = all.tickets || {}; spine = all.feature === true ? all.spine : null; } catch { /* no queue: nothing is held */ }
const held = (t) => t && t.state === 'parked' && String(t.park?.question ?? '').startsWith('held by orchestrator');
const m = {};
const add = (s, ps) => { m[s] ??= new Set(); for (const p of ps) if (p) m[s].add(p); };
for (const pair of pairs) { const i = pair.indexOf(':'); add(pair.slice(0, i), pair.slice(i + 1).split(',')); }
for (const [k, t] of Object.entries(q)) if (held(t) && t.held_by) add(k, String(t.held_by).split('|'));
// Only the person's approval releases what a feature spine holds: a spine PR merged without it does not.
const unapproved = (p) => p === spine && q[p]?.approved !== true;
for (const [s, ps] of Object.entries(m)) if (held(q[s]) && ps.size && ![...ps].some(unapproved)) console.log(`${s} ${[...ps].join(',')}`);
NODE
) || return 0
  [ -n "$plan" ] || return 0
  # One merged-PR listing for every predecessor at once, not one per predecessor per loop.
  local merged
  # Each predecessor key is its own argument: ticket keys hold no spaces or glob characters.
  # shellcheck disable=SC2046
  merged=$(prs merged $(printf '%s\n' "$plan" | awk '{ print $2 }' | tr ',' '\n' | sort -u) </dev/null) || return 0
  while read -r succ preds; do
    [ -n "$succ" ] || continue
    all=1; got=""
    for pred in ${preds//,/ }; do
      n=$(printf '%s\n' "$merged" | awk -F'\t' -v k="$pred" '$3 == k { print $1; exit }')
      [ -z "$n" ] && { all=0; break; }; got="$got $pred#$n"
    done
    if [ "$all" = 1 ]; then
      node "$Q" set "$succ" state=triaged park=null held_by=null >/dev/null </dev/null \
        && node "$Q" front "$succ" >/dev/null </dev/null && log "merged:$got -> RELEASED $succ (moved to front)"
    fi
  done <<EOF_PLAN
$plan
EOF_PLAN
}

backed_off(){ local f="$SD/backoff-$1"; [ -f "$f" ] && [ "$(date +%s)" -lt "$(cat "$f" 2>/dev/null || echo 0)" ]; }
back_off(){ echo $(( $(date +%s) + ${2:-600} )) > "$SD/backoff-$1"; }

behind(){ # behind <n> <sha> <key>
  if [ "$UPDATE_PERM" = yes ]; then
    if [ -f "$SD/updated-$1-$2" ]; then log "#$1 BEHIND; update already requested at ${2:0:9} — waiting for it"; return; fi
    if out=$(gh pr update-branch "$1" --repo "$REPO" 2>&1); then touch "$SD/updated-$1-$2"; log "#$1 BEHIND -> gh pr update-branch (new head and fresh checks follow)"
    else log "#$1 BEHIND and update-branch refused: $(printf '%s' "$out" | tail -1)"; back_off "$1"; fi
  else
    log "#$1 BEHIND and §3 pr-update-branch is $UPDATE_PERM — parked for a person to update"
    queue_note "$3" "behind $BASE_BRANCH; §3 pr-update-branch is $UPDATE_PERM"
  fi
}

rerun(){ # rerun <n> <sha> <gate json>
  local g="$3" pend ids names rid name cnt cd_file now last
  [ "$RERUN_PERM" = yes ] || { log "#$1 red at ${2:0:9} — config §3 ci-rerun is $RERUN_PERM, so not rerunning; report it"; return; }
  pend=$(printf '%s' "$g" | jq -r '.gate.pending | length')
  [ "$pend" = 0 ] || { log "#$1 red, but $pend check(s) still running — waiting for them before any rerun"; return; }
  ids=$(printf '%s' "$g" | jq -r '.gate.failedRuns[]?')
  names=$(printf '%s' "$g" | jq -r '.gate.failing[].name')
  [ -n "$ids" ] || { log "#$1 red with nothing a rerun could fix ($(printf '%s' "$g" | jq -r '.gate.reasons[:2] | join("; ")')) — report it"; return; }
  # At most twice per check per head: a check red after two reruns is red, not flaky.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    cnt=$(grep -cxF "$name" "$SD/reruns-$1-$2" 2>/dev/null || true)
    if [ "${cnt:-0}" -ge 2 ]; then log "#$1 \"$name\" still red after 2 reruns at ${2:0:9} — not rerunning again; report it"; return; fi
  done <<EOF_NAMES
$names
EOF_NAMES
  cd_file="$SD/cooldown-$1"; now=$(date +%s); last=$(cat "$cd_file" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 720 ]; then log "#$1 red, cooling down ($(( (720 - (now - last)) / 60 ))m left)"; return; fi
  for rid in $ids; do
    log "#$1 red + completed -> rerun --failed on run $rid"
    if gh run rerun "$rid" --repo "$REPO" --failed >/dev/null 2>&1; then echo "$now" > "$cd_file"
    else log "#$1 rerun of $rid refused"; fi
  done
  printf '%s\n' "$names" >> "$SD/reruns-$1-$2"
}

try_pr(){ # try_pr <n> <key> -> 0 when it merged
  local n="$1" key="$2" g sha ms state holds fb decision unresolved green_at out
  backed_off "$n" && { log "#$n backed off after a refused merge — retrying later"; return 1; }
  g=$(node "$GATE" pr "$n" --repo "$REPO" 2>&1) || { log "#$n could not be evaluated: $(printf '%s' "$g" | tail -1)"; return 1; }
  sha=$(printf '%s' "$g" | jq -r .sha); ms=$(printf '%s' "$g" | jq -r .mergeState); state=$(printf '%s' "$g" | jq -r .gate.state)
  [ "$(printf '%s' "$g" | jq -r .base)" = "$BASE_BRANCH" ] || { log "#$n is not based on $BASE_BRANCH — not the batch's to merge"; return 1; }

  holds=$(printf '%s' "$g" | jq -r '.holds[] | "\(.glob) (\(.why); \(.count) file(s), e.g. \(.files[0] // "?"))"')
  if [ -n "$holds" ]; then
    [ "$(printf '%s' "$g" | jq -r .autoMerge)" = true ] && gh pr merge "$n" --repo "$REPO" --disable-auto >/dev/null 2>&1
    log "#$n HELD by §4 Merge holds — a person merges it: $(printf '%s' "$holds" | paste -sd ';' -)"
    queue_note "$key" "merge hold: $(printf '%s' "$holds" | head -1)"
    return 1
  fi

  if [ -n "$FEEDBACK_STRICT" ]; then
    fb=$(feedback "$n")
    if [ -z "$fb" ]; then log "#$n could not read review state — not merging it this loop"; return 1; fi
    decision=${fb% *}; unresolved=${fb##* }
    if [ "$decision" = "CHANGES_REQUESTED" ] || [ "${unresolved:-0}" -gt 0 ]; then
      [ "$(printf '%s' "$g" | jq -r .autoMerge)" = true ] && gh pr merge "$n" --repo "$REPO" --disable-auto >/dev/null 2>&1
      log "#$n has outstanding review feedback ($decision, $unresolved unresolved) — work it first; not merging (§3 merge-feedback-first: $FEEDBACK_RAW)"
      return 1
    fi
  fi

  case "$ms" in
    DIRTY) log "#$n DIRTY — needs a conflict resolution and a fresh review"; return 1 ;;
    BEHIND) behind "$n" "$sha" "$key"; return 1 ;;
  esac

  case "$state" in
    pass) ;;
    fail) log "#$n red at ${sha:0:9}: $(printf '%s' "$g" | jq -r '.gate.reasons[:3] | join("; ")')"; rerun "$n" "$sha" "$g"; return 1 ;;
    *) log "#$n not green yet ($state): $(printf '%s' "$g" | jq -r '.gate.reasons[:2] | join("; ")')"; return 1 ;;
  esac

  # Green now. It must still be green at the same head on a later loop before it merges.
  green_at=$(awk -v s="$sha" '$1 == s { print $2 }' "$SD/green-$n" 2>/dev/null)
  if [ -z "$green_at" ]; then echo "$sha $(date +%s)" > "$SD/green-$n"; log "#$n green at ${sha:0:9} — confirming on the next loop before merging"; return 1; fi
  if [ $(( $(date +%s) - green_at )) -lt "$GREEN_HOLD_SECS" ]; then log "#$n green at ${sha:0:9} — confirming"; return 1; fi

  log "#$n gate GREEN at ${sha:0:9} — merging (pinned to that commit)"
  if out=$(gh pr merge "$n" --repo "$REPO" "--$MERGE_METHOD" --match-head-commit "$sha" 2>&1); then
    log "#$n MERGED ($key)"; rm -f "$SD/green-$n"; return 0
  fi
  if printf '%s' "$out" | grep -qiE 'not up to date|behind|out of date|update the branch'; then behind "$n" "$sha" "$key"
  else log "#$n merge refused: $(printf '%s' "$out" | tail -1) — backing off 10m, the rest carry on"; back_off "$n"; fi
  return 1
}

log "merge driver up: repo=$REPO base=$BASE_BRANCH author=$AUTHOR tickets=[${KEY_LIST[*]}] deps=[${DEP_LIST[*]:-none}] method=$MERGE_METHOD required=[$(printf '%s' "$REQUIRED" | paste -sd ',' -)] ci-rerun=$RERUN_PERM update-branch=$UPDATE_PERM feedback-first=$FEEDBACK_RAW"
# One release pass and out: for tests, and for checking by hand what would be released now.
if [ -n "${MERGE_DRIVER_RELEASE_ONLY:-}" ]; then release_chain </dev/null; exit 0; fi
# pause <secs> [<one-loop exit code>]: the wait between loops, or the end of a one-loop run.
pause(){ if [ -n "${MERGE_DRIVER_ONE_LOOP:-}" ]; then exit "${2:-0}"; fi; sleep "$1"; }
while true; do
  join_queue_tickets
  release_chain

  list=$(prs open) || { log "could not list PRs"; pause 120 1; continue; }
  drafts=$(printf '%s\n' "$list" | awk -F'\t' '$2 == "true" { printf "#%s ", $1 }'); [ -n "$drafts" ] && log "draft (still reviewing): $drafts"
  ready=$(printf '%s\n' "$list" | awk -F'\t' '$2 == "false" { print $1 "\t" $3 }')
  [ -z "$ready" ] && { log "no ready batch PRs"; pause 60; continue; }

  merged=""
  while IFS="$(printf '\t')" read -r n key; do
    [ -n "$n" ] || continue
    # stdin from /dev/null: nothing inside may eat the list this loop is reading.
    if try_pr "$n" "$key" </dev/null; then merged=1; release_chain </dev/null; break; fi
  done <<EOF_READY
$ready
EOF_READY
  if [ -n "$merged" ]; then pause 30; else pause 120; fi
done
