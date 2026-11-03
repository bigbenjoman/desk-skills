#!/usr/bin/env bash
# Serial merge driver for an autopilot batch. Start it at Stage 4, before the first worker finishes:
#   nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2 ABC-3" --deps "ABC-3:ABC-1,ABC-2" \
#     --log &          # appends to ~/.desk-autopilot/<slug>/merge-driver.log
# Run it from inside the repo (or with DESK_REPO_DIR set): the repo decides which config applies.
#
# --tickets  the batch's ids (whitespace- or comma-separated), each one `desk-env ticket-kind` accepts:
#            a §4 Ticket key pattern key, a §4 Other work id patterns id, or with §4 Tracker `none`
#            `issue-<n>` or a lower-case kebab slug. Case-sensitive as written. These are the starting
#            set: every loop also takes in each ticket in the queue (`queue.mjs admit`, a requeue), so a
#            ticket that joins the batch mid-run is merged with no restart.
# --deps     space-separated succ:pred[,pred] — succ is released (state=triaged, moved to the front of
#            the spawn order) once EVERY pred's PR has merged. Chain only real file collisions.
# --log      append stdout and stderr to <state>/merge-driver.log (no value: the file is fixed).
# --batch    the named batch whose queue and state it drives, as DESK_BATCH=<name> does.
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
#   - touches a §4 Merge holds path          held for a person, with the hold's reason, when its base
#                                            is §0 Default branch; into any other base it merges, and
#                                            the hold falls on that base's own PR. A hold whose reason
#                                            is a code-owner approval is met, and holds nothing, where
#                                            the base's CODEOWNERS gives every held file to §1's handle
#                                            alone (gate.mjs codeOwnerHolds); any other owner is named.
#                                            Where every hold it
#                                            touches names a routine (`<why>; desk runs: <command>`)
#                                            and §3 merge-hold-routine is yes, it goes through the rest
#                                            of the gate, then the driver runs each routine once at the
#                                            head, in a detached checkout of it, and merges pinned to
#                                            that head only if all exit 0 and the head has not moved. A
#                                            routine that fails is recorded (`merge hold: …; routine
#                                            `<command>` failed at <sha> (exit <n>): <its last line>`)
#                                            and never run again at that head
#   - review feedback outstanding            a CHANGES_REQUESTED decision or an unresolved thread,
#                                            unless §3 merge-feedback-first is explicitly `no`
#                                            (unset, ask and yes are all the strict default). A
#                                            thread an earlier desk-review of the author's opened is
#                                            resolved once the latest desk-review verdict is clean
#                                            (§4 Clean review verdict) at the head (review-threads.mjs);
#                                            anyone else's stays. Held so on two loops, green or red
#                                            (a red one is not rerun), it is recorded as merge_blocked
#                                            (`review feedback: …`, naming the first thread); pass.mjs
#                                            sends the feedback to a fix worker (fix-tries.mjs
#                                            feedbackFix), and to the person once no try is left
#   - a feature with no approval             a PR titled feat… merges only once a person approves it:
#                                            green and past the feedback check, it is recorded as
#                                            merge_blocked (`approval: …`) for the person
#   - DIRTY                                  a conflict needs resolving and a fresh review: pass.mjs
#                                            sends it to a fix worker (fix-tries.mjs)
#   - BEHIND                                 updated with `gh pr update-branch` where §3 pr-update-branch
#                                            is yes (once per head), else parked for a person
#   - an approving review required           GitHub's review decision is REVIEW_REQUIRED: recorded as
#                                            merge_blocked (`approval: …`) for the person, red or
#                                            green; a red one is still rerun and repaired
#   - a red approval state check             a §4 State check of kind approval is red: recorded as
#                                            merge_blocked (`approval: …`) for the person, and never
#                                            rerun, so no cooldown is scheduled for it
#   - not green                             "green" is desk-config.md's one definition, evaluated by
#                                            gate.mjs (shared with desk-clearance); a head must stay
#                                            green across two loops before it merges, so a check that
#                                            passes before the rest of CI has even queued cannot land it
#   - waits on the person's step             its ticket's merge_after names blockers in no batch that are
#                                            steps only the person takes: held, green or not, until
#                                            pass.mjs reads each Done in Jira and lifts it
#   - refused by `gh pr merge`               backed off for 10 minutes, then retried
# The one red that merges is a written waiver: every failing check is named in §4 Known flaky checks,
# none is a §4 Required check (merging past one is a bypass, and §3 merge-bypass is never), the PR's
# files touch none of the paths the row gives for it, each is still red after two reruns the driver
# had accepted at this head (the last given its cooldown to report), and the rest of the gate passes. It is logged `WAIVED <check>`, confirmed across two
# loops like a green head, and once merged a ticket naming the check, the PR, the head SHA and the
# failing run is filed with `desk-jira create` where §3 jira-create is yes (otherwise the log names
# its body file). A row that does not parse stops the driver at start.
# The merge is pinned with `--match-head-commit <the sha the gate evaluated>`. Once it lands,
# `queue.mjs merged <TICKET>` records merged_at on the ticket and its line in <state>/eta-history.jsonl,
# and puts the merge time beside the ticket's first ship estimate in <state>/eta.jsonl. Where §4 Tracker
# is jira and §3 jira-close-own-merged is yes, a ticket with no other PR still open on its key, by
# anyone, is then moved to §4 Done state and read back; this is the only close anywhere in the batch.
# Where §3 ci-rerun is yes, a red PR whose runs have all completed gets `gh run rerun --failed` on
# the runs behind its failing non-advisory checks, at most twice per check per head, 12 minutes apart.
# A check still red after both goes back to a fix worker: pass.mjs reads reruns-<n>-<sha> and
# cooldown-<n> in <state>/merge-driver for that, so their names and contents are shared with it.
# A red §4 State check reads the PR's state, not its code, so it is never rerun: each is logged with
# the error its run gave. One of kind `approval` is recorded as merge_blocked (`approval: …`) for the
# person; one of kind `verdict` the pass sends to a review worker (fix-tries.mjs verdictTry).
# It NEVER undrafts, and never arms auto-merge (the platform's idea of green is not this one); an
# armed auto-merge on a held PR, or one with feedback outstanding, is disarmed.
#
# Refuses to start unless config §3 autopilot-merge AND pr-merge-green are both `yes`, or each is `yes`
# or `ask` and the user approved merging this batch at Stage 3 (`queue.mjs set-batch approved.merge=true`),
# or while another merge driver is running. It reads that again before every merge and stops once it no
# longer holds (a new batch carries no approval). A merge made under the batch's approval is noted in
# <state>/batch-notes.md. Where nothing grants it, the orchestrator reports green PRs and the user merges.
#
# Environment, for tests and for checking by hand:
#   MERGE_DRIVER_RELEASE_ONLY=1  one release pass, then exit 0
#   MERGE_DRIVER_ONE_LOOP=1      one full loop (join, release, at most one merge), then exit instead of
#                                sleeping: 0, or 1 when the PR list could not be read
#   MERGE_DRIVER_GREEN_SECS=<n>  how long a head must stay green before it merges (default 60)
#
# Exit codes: 2 bad arguments · 1 not permitted, missing tool or config row, another driver running, or
# gh signed out (a PR list it refuses for that is logged and stops the driver, never read as empty).
# Once its arguments are accepted, the last line it writes is always `merge driver exited <code>`.
set -uo pipefail

usage(){ echo "usage: merge-driver.sh --tickets \"<TICKET> <TICKET>\" [--deps \"<succ>:<pred>[,<pred>]\"] [--log] [--batch <name>]" >&2; exit 2; }

# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"

# ---- arguments: validated before anything else runs ---------------------------------------------
desk_take_batch "$@" || exit 2
set -- ${DESK_ARGS[@]+"${DESK_ARGS[@]}"}
TICKETS=""; DEPS=""; LOG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tickets) [ "$#" -ge 2 ] || usage; TICKETS="$2"; shift 2 ;;
    --deps)    [ "$#" -ge 2 ] || usage; DEPS="$2"; shift 2 ;;
    --log)     LOG=1; shift ;;
    *) usage ;;
  esac
done

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

# --log appends everything from here on to <state>/merge-driver.log, so the driver is started without
# a shell redirect (one outside the working directory prompts every time, whatever the allow rules
# say). The file is fixed, never an argument: the allow rule that starts the driver must not also let
# it append to any path. The paths are read in a subshell, because the batch base is applied first below.
if [ -n "$LOG" ]; then
  if ! LOG_STATE="$(desk_load_paths && printf '%s' "$DESK_STATE")" || [ -z "$LOG_STATE" ] || ! mkdir -p "$LOG_STATE"; then
    echo "FAIL: --log: could not resolve the batch state directory" >&2; exit 1
  fi
  exec >>"$LOG_STATE/merge-driver.log" 2>&1
fi
# The last line is always the exit code, so the supervisor can tell a driver that failed from one it
# never saw stop. The lock is removed only once this driver holds it, never another driver's.
LOCK_HELD=""
on_exit(){ rc=$?; [ -n "$LOCK_HELD" ] && rm -rf "$LOCKD"; echo "$(date -u +%H:%M:%SZ) merge driver exited $rc"; }
trap on_exit EXIT

# Who lets this driver merge: config §3 (`config`), or the batch's Stage 3 approval (`batch`). It is
# read again before every merge, so a new batch that was not approved stops a driver still running.
TAB="$(printf '\t')"
if ! GRANT="$(node "$DESK_ENV_MJS" merge-grant 2>&1)"; then
  echo "FAIL: ${GRANT#*"$TAB"} — the driver merges nothing." >&2
  echo "      Report green PRs to the user instead, ask once at Stage 3 for the batch, or run /desk-setup to grant it." >&2
  exit 1
fi
GRANT_BY="${GRANT%%"$TAB"*}"

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
# Unset, ask and no all leave a hold's routine unrun: only `yes` lets the driver run it unattended.
ROUTINE_PERM="$(desk_perm merge-hold-routine)"
# Strict unless explicitly relaxed: unset, ask and yes all mean feedback is worked before merging.
FEEDBACK_RAW="$(node "$DESK_ENV_MJS" perm-or-unset merge-feedback-first 2>/dev/null || echo unset)"
if [ "$FEEDBACK_RAW" = no ]; then FEEDBACK_STRICT=""; else FEEDBACK_STRICT=1; fi

desk_apply_batch_base || exit 1
desk_load_paths || exit 1
desk_load_identity || exit 1
# §4 Known flaky checks: what may be waived, and how a waiver's ticket is filed. Unset waives nothing.
if ! FLAKY="$(node "$DESK_BIN/gate.mjs" flaky 2>&1)"; then
  echo "FAIL: $(printf '%s' "$FLAKY" | sed 's/^gate: //') — the driver waives nothing until it does." >&2; exit 1
fi
# §4 State checks: the checks a rerun cannot turn green, since they read the PR's state, not its code.
if ! STATE_CHECKS="$(node "$DESK_BIN/gate.mjs" state 2>&1)"; then
  echo "FAIL: $(printf '%s' "$STATE_CHECKS" | sed 's/^gate: //') — the driver cannot tell which red checks a rerun could fix until it does." >&2; exit 1
fi
TRACKER="$(desk_cfg tracker 2>/dev/null | tr 'A-Z' 'a-z' || true)"
JIRA_CREATE_PERM="$(desk_perm jira-create)"
CLOSE_PERM="$(desk_perm jira-close-own-merged)"
DONE_STATE="$(desk_cfg done-state 2>/dev/null || true)"
SIZE_FIELD="$(desk_cfg jira-size-field 2>/dev/null || true)"
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
echo "$$" > "$LOCKD/pid"; LOCK_HELD=1
# The desk version this driver runs, so the supervisor can tell it started before the last install.
node "$DESK_BIN/installed.mjs" version > "$LOCKD/version" 2>/dev/null || true
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$DESK_REPO_ROOT" || exit 1
log(){ echo "$(date -u +%H:%M:%SZ) $*"; }
Q="$DESK_BIN/queue.mjs"
GATE="$DESK_BIN/gate.mjs"
THREADS="$DESK_BIN/review-threads.mjs"
THREADS_QUERY="$(node "$THREADS" query)" || { log "FAIL: review-threads.mjs could not be read"; exit 1; }
# §4 Clean review verdict: the verdict at a head that settles the desk-review threads opened before it.
CLEAN_ROW="$(desk_cfg clean-verdict 2>/dev/null || true)"
REPO="$DESK_GH_REPO"
AUTHOR="$DESK_GITHUB_HANDLE"
BASE_BRANCH="$DESK_DEFAULT_BRANCH"
SD="$DESK_STATE/merge-driver"; mkdir -p "$SD"
GREEN_HOLD_SECS="${MERGE_DRIVER_GREEN_SECS:-60}"

# The id -> (branch, regex) map, rebuilt each loop because the queue learns branches as tickets spawn.
# A recorded branch is matched exactly; only an id with none falls back to the bounded regex.
ticket_map(){   # ticket_map <key>...
  node --input-type=module - "$DESK_BIN/batch-state.mjs" "$DESK_QUEUE" "$@" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [mod, qf, ...keys] = process.argv.slice(2);
const { keyPattern } = await import(pathToFileURL(mod).href);
let q = {};
try { q = JSON.parse(readFileSync(qf, 'utf8')).tickets || {}; } catch { /* no queue: regex only */ }
console.log(JSON.stringify(keys.map((k) => ({ key: k, branch: (q[k] && q[k].branch) || '', re: keyPattern(k) }))));
NODE
}
# prs <state> [<key>...] -> lines `<number>\t<isDraft>\t<key>\t<base>` for the batch's PRs (or those
# keys') based on the default branch, or on any base with PRS_BASE set empty. PRS_ANY set lists every
# author's PRs and matches the key's regex even where a branch is recorded: every PR on the key, not
# only the batch's. A list gh could not give returns 1, or 4 when gh is signed out (gh's own exit code
# for it, or a 401), with gh's error in $GH_ERR: it runs in a $( ), so it cannot log.
GH_ERR="$SD/gh-pr-list.err"
prs(){
  local st="$1"; shift
  local base="${PRS_BASE-$BASE_BRANCH}" any="${PRS_ANY:-}" author="$AUTHOR"
  [ -n "$any" ] && author=""
  local map raw rc; if [ "$#" -gt 0 ]; then map="$(ticket_map "$@")"; else map="$(ticket_map "${KEY_LIST[@]}")"; fi || return 1
  raw="$(gh pr list --repo "$REPO" --state "$st" ${author:+--author "$author"} ${base:+--base "$base"} --limit 100 \
      --json number,title,headRefName,baseRefName,isDraft 2>"$GH_ERR")"; rc=$?
  if [ "$rc" -ne 0 ]; then
    { [ "$rc" -eq 4 ] || grep -qiE 'gh auth login|not logged in|HTTP 401|bad credentials' "$GH_ERR"; } && return 4
    return 1
  fi
  printf '%s' "$raw" \
    | jq -r --argjson m "$map" --arg base "$base" --arg any "$any" '
        .[] | select($base == "" or .baseRefName == $base) | . as $p
        | [ $m[] | .re as $re | select((.branch != "" and $p.headRefName == .branch)
                          or ((.branch == "" or $any != "") and (($p.title + " " + $p.headRefName) | test($re)))) | .key ] as $k
        | select(($k | length) > 0)
        | "\($p.number)\t\($p.isDraft)\t\($k[0])\t\($p.baseRefName)"' 2>/dev/null | sort -n
}
# The PR's review decision and unresolved threads, as review-threads.mjs reads them (one JSON line):
# those a clean desk-review verdict at the head settles are in `resolve`, the rest in `left`. Nothing
# when GitHub could not be read. An empty reviewDecision is not an approval.
feedback(){
  gh api graphql -f owner="${REPO%%/*}" -f name="${REPO#*/}" -F n="$1" -f query="$THREADS_QUERY" 2>/dev/null \
    | node "$THREADS" read --handle "$AUTHOR" --clean "$CLEAN_ROW" 2>/dev/null
}
# Prints true once GitHub has resolved the thread.
resolve_thread(){
  gh api graphql -f id="$1" -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' \
    --jq '.data.resolveReviewThread.thread.isResolved' 2>/dev/null
}
queue_note(){ node "$Q" set "$1" "merge_blocked=$2" >/dev/null 2>&1 || true; }
# A PR held for unresolved threads on two loops in a row, green or not, is recorded naming the first
# thread: the hold is why it is not merging (a red one is not rerun either), so desk-q and needs-you say
# so rather than its checks. Cleared once it is not held for them.
feedback_stall(){ # feedback_stall <n> <key> <gate state> <count> <thread>
  local f="$SD/feedback-$1" c s=s on="a PR not yet green"
  case "$3" in pass) on="a green PR" ;; fail) on="a red PR" ;; esac
  c=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$f"
  [ "$4" -eq 1 ] && s=""
  [ "$c" -ge 2 ] && queue_note "$2" "review feedback: $4 unresolved thread$s on $on, first $5"
}
# Clears the ticket's merge_blocked note when it is the one this reason wrote.
blocked_clear(){ # blocked_clear <key> <reason prefix>
  case "$(jq -r --arg k "$1" '.tickets[$k].merge_blocked // ""' "$DESK_QUEUE" 2>/dev/null)" in
    "$2"*) queue_note "$1" null ;;
  esac
}
feedback_clear(){ rm -f "$SD/feedback-$1"; blocked_clear "$2" "review feedback:"; }
# A feature (a PR titled feat…) merges only once a person has approved it. Green, past the feedback
# check and with no approval, the queue asks the person for one; cleared once it is approved, or once it
# is not green and past the feedback check (review feedback goes to a fix worker, a conflict or a red
# check to the fix tries).
is_feature(){ case "$1" in feat:*|feat\(*|feat!:*) return 0 ;; esac; return 1; }
approval_clear(){ blocked_clear "$1" "approval:"; }

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
// Only an approval from the person releases what a feature spine holds: a spine PR merged without it does not.
// No apostrophes in this heredoc: bash 3.2 matches quotes inside a heredoc within a command substitution.
const unapproved = (p) => p === spine && q[p]?.approved !== true;
// A blocker in no batch (held_outside) waits on Jira as well as a merge: pass.mjs lifts it, not this.
for (const [s, ps] of Object.entries(m)) if (held(q[s]) && !q[s].held_outside && ps.size && ![...ps].some(unapproved)) console.log(`${s} ${[...ps].join(',')}`);
NODE
) || return 0
  [ -n "$plan" ] || return 0
  # A predecessor whose queue entry records a merge (merged_at, set by pass.mjs from that PR itself, or
  # by this driver) has merged, whatever GitHub lists: `prs` sees only the newest 100 merged PRs, so a
  # blocker whose PR is older than that (a long-lived draft, rebased and merged today) was never found
  # and held its successors forever. Lines in the shape `prs` prints; the PR is "?" when none is recorded.
  local merged known
  known=$(node - "$DESK_QUEUE" <<'NODE'
const fs = require('fs');
let q = {};
try { q = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).tickets || {}; } catch { /* no queue: nothing recorded */ }
for (const [k, t] of Object.entries(q)) if (t && t.merged_at) console.log(`${t.pr_status?.pr ?? t.result?.pr ?? '?'}\tfalse\t${k}\tqueue`);
NODE
) || known=""
  # One merged-PR listing for every predecessor at once, not one per predecessor per loop. A listing gh
  # could not give still releases what the queue already knows merged.
  # Each predecessor key is its own argument: ticket keys hold no spaces or glob characters.
  # shellcheck disable=SC2046
  merged=$(prs merged $(printf '%s\n' "$plan" | awk '{ print $2 }' | tr ',' '\n' | sort -u) </dev/null) || merged=""
  merged="$known${known:+$'\n'}$merged"
  [ -n "$merged" ] || return 0
  while read -r succ preds; do
    [ -n "$succ" ] || continue
    all=1; got=""
    for pred in ${preds//,/ }; do
      n=$(printf '%s\n' "$merged" | awk -F'\t' -v k="$pred" '$3 == k { print $1; exit }')
      [ -z "$n" ] && { all=0; break; }; got="$got $pred#$n"
    done
    if [ "$all" = 1 ]; then
      node "$Q" set "$succ" state=triaged park=null held_by=null >/dev/null </dev/null \
        && placed=$(node "$Q" front "$succ" </dev/null) && log "merged:$got -> RELEASED $placed"
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

# Reruns per check per head (RERUNS_MAX, RERUN_COOLDOWN, reruns_at, rerun), shared with pass.mjs.
# shellcheck source=rerun.sh
. "$DESK_ENV_DIR/rerun.sh"

# waivable <n> <sha> <gate json> <key> -> 0 when the red head may merge on the written waiver (header),
# with WAIVED set to its check names, quoted and comma-joined. Otherwise says why and returns 1.
# Only reruns GitHub accepted count, and the last must have had its cooldown to report.
WAIVED=""
waivable(){
  local w reason checks name cnt short last
  WAIVED=""
  w=$(printf '%s' "$3" | jq -c '.waiver // empty'); [ -n "$w" ] || return 1
  reason=$(printf '%s' "$w" | jq -r '.reason // ""')
  checks=$(printf '%s' "$w" | jq -r '.checks[]')
  short=$(printf '%s' "$w" | jq -r '[.checks[] | "\"\(.)\""] | join(", ")')
  case "$reason" in
    unlisted) return 1 ;;   # a red check nobody has written a waiver for: red, as ever
    required)
      log "#$1 $short is in §4 Known flaky checks but is a §4 Required check: branch protection enforces it, so it is never waived (a bypass is never used) — report it"
      queue_note "$4" "red on required check $short, listed as flaky: never waived; a person merges it once it passes"
      return 1 ;;
    paths) log "#$1 the waiver for $short does not apply: the diff touches $(printf '%s' "$w" | jq -r '[.hits[] | "\(.files[0]) (\(.glob), for \"\(.check)\")"] | join("; ")')"; return 1 ;;
    files) log "#$1 the waiver for $short does not apply: the PR's file list could not be read"; return 1 ;;
    gate) log "#$1 the waiver for $short does not apply: $(printf '%s' "$w" | jq -r '(.reasons // [])[:2] | join("; ")')"; return 1 ;;
    "") ;;
    *) return 1 ;;
  esac
  [ "$RERUN_PERM" = yes ] || { log "#$1 $short is a known flaky check, but it is waived only after the driver's two reruns and §3 ci-rerun is $RERUN_PERM — report it"; return 1; }
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    cnt=$(reruns_at "$1" "$2" "$name" ok)
    if [ "${cnt:-0}" -lt "$RERUNS_MAX" ]; then log "#$1 \"$name\" is a known flaky check: waived only once still red after $RERUNS_MAX accepted reruns at ${2:0:9} (${cnt:-0} so far)"; return 1; fi
  done <<EOF_WAIVE
$checks
EOF_WAIVE
  last=$(cat "$SD/cooldown-$1" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - last )) -lt "$RERUN_COOLDOWN" ]; then log "#$1 $short is a known flaky check: waiting out the last rerun's cooldown before reading it as still red"; return 1; fi
  WAIVED="$short"
}

# flaky_ticket <n> <sha> <gate json> <key> <waived checks>: once a waived PR has merged, the ticket that
# gets the flake fixed. Filed once per PR and head; the body stays in <state>/merge-driver for whoever
# files it by hand.
flaky_ticket(){
  local body="$SD/flaky-$1-$2.md" summary="Flaky check $5 waived to merge PR #$1" out size=() sizeline=""
  [ -f "$SD/flaky-filed-$1-$2" ] && return 0
  # desk-jira's lint wants a size: the §4 Size field where there is one, else the body's first line.
  if [ -n "$SIZE_FIELD" ] && [ "$SIZE_FIELD" != none ]; then size=("$SIZE_FIELD=S"); else sizeline="Size: S"; fi
  printf '%s' "$3" | jq -r --arg repo "$REPO" --arg n "$1" --arg sha "$2" --arg key "$4" --arg size "$sizeline" '
    def run: "https://github.com/\($repo)/actions/runs/\(.)";
    (if $size != "" then $size, "" else empty end),
    "## Outcome",
    "The merge driver merged [PR #\($n)](https://github.com/\($repo)/pull/\($n)) (\($key)) at head `\($sha)` past a red check named in config §4 Known flaky checks. It was still red after two reruns and the PR touched none of the paths the row gives for it. This ticket is the cost of that waiver: make the check pass reliably, so nothing is merged past it again.",
    "",
    "- Check: \(.waiver.checks | map("`\(.)`") | join(", "))",
    "- PR: https://github.com/\($repo)/pull/\($n)",
    "- Head SHA: `\($sha)`",
    "- Failing run: \(if (.waiver.runs | length) > 0 then (.waiver.runs | map(run) | join(", ")) else "(no run id reported)" end)",
    "",
    "## Acceptance criteria",
    "1. AC1: Given the check named above, when it runs on a change that does not touch the paths its §4 Known flaky checks row gives, then it passes on the first run.",
    "",
    "## Verification",
    "- The failing run above, read for the cause before any fix.",
    "",
    "## Design",
    "No UI.",
    "",
    "## Out of scope",
    "- Changing the code PR #\($n) merged."' > "$body" || { log "#$1 waiver ticket body could not be written"; return 1; }
  if [ "$TRACKER" != jira ]; then
    log "#$1 WAIVED: no tracker (§4 Tracker is ${TRACKER:-unset}), so no ticket filed — the flake's details are in $body"; touch "$SD/flaky-filed-$1-$2"; return 0
  fi
  if [ "$JIRA_CREATE_PERM" != yes ]; then
    log "#$1 WAIVED: ticket not filed, config §3 jira-create is $JIRA_CREATE_PERM — ask, then: desk-jira create Bug \"$summary\" $body"; touch "$SD/flaky-filed-$1-$2"; return 0
  fi
  if out=$(desk-jira create Bug "$summary" "$body" ${size[@]+"${size[@]}"} 2>&1); then
    touch "$SD/flaky-filed-$1-$2"; log "#$1 WAIVED: filed $(printf '%s' "$out" | grep -m1 '^created' | sed 's/^created //')"
  else
    log "#$1 WAIVED: the ticket was not filed ($(printf '%s' "$out" | tail -1)) — file it by hand: desk-jira create Bug \"$summary\" $body"
    touch "$SD/flaky-filed-$1-$2"
  fi
}

# close_merged <n> <key>: once #n has merged, its ticket goes to §4 Done state where §3
# jira-close-own-merged is yes and no other PR on the key is still open, by anyone, on any base; read
# back after. #n itself never counts, so a listing that still shows it open cannot hold the ticket back.
# Nothing else in the batch closes a ticket. A failure is logged and never undoes the merge.
close_merged(){
  local n="$1" key="$2" open st out
  [ "$TRACKER" = jira ] && [ "$(node "$DESK_ENV_MJS" ticket-kind "$key" 2>/dev/null)" = tracker ] || return 0
  if [ "$CLOSE_PERM" != yes ]; then log "#$n $key left as it is: config §3 jira-close-own-merged is $CLOSE_PERM"; return 0; fi
  case "$DONE_STATE" in ''|TODO*|none) log "#$n $key not moved: config §4 Done state is not set — run /desk-setup"; return 0 ;; esac
  if ! open=$(PRS_BASE='' PRS_ANY=1 prs open "$key"); then
    log "#$n $key not moved to $DONE_STATE: open PRs could not be listed ($(tail -1 "$GH_ERR" 2>/dev/null))"; return 0
  fi
  open=$(printf '%s\n' "$open" | awk -F'\t' -v n="$n" '$1 != "" && $1 != n { printf "%s#%s", s, $1; s = " " }')
  if [ -n "$open" ]; then log "#$n $key left as it is: $open still open on the key"; return 0; fi
  st=$(desk-jira get "$key" --json 2>/dev/null | jq -r '.fields.status.name // empty')
  if [ "$st" = "$DONE_STATE" ]; then log "#$n $key already $DONE_STATE"; return 0; fi
  if ! out=$(desk-jira transition "$key" "$DONE_STATE" 2>&1); then
    log "#$n $key not moved to $DONE_STATE: $(printf '%s' "$out" | head -1) — move it by hand"; return 0
  fi
  st=$(desk-jira get "$key" --json 2>/dev/null | jq -r '.fields.status.name // empty')
  if [ "$st" = "$DONE_STATE" ]; then log "#$n $key moved to $DONE_STATE (read back; §3 jira-close-own-merged)"
  else log "#$n $key transition sent but it reads ${st:-unreadable}, not $DONE_STATE — check it by hand"; fi
}

# A §4 Merge holds routine is run once per PR head, recorded in <state>/merge-driver/routine-<n>-<sha>.*:
# .log (everything each command printed), .ok once every command exited 0, .failed (`<exit>\t<routine>\t
# <hold>\t<step>`, the step being the failing command's last line of output) once one did not. A failed
# head is never run again; a new head runs it afresh.
routine_failed_note(){ # routine_failed_note <key> <failed record> <sha>
  local rc cmd hold step
  IFS="$TAB" read -r rc cmd hold step < "$2" || return 0
  queue_note "$1" "merge hold: $hold; routine \`$cmd\` failed at ${3:0:9} (exit $rc): ${step:-it printed nothing}"
}
# routine_off_note <key> <routines> <why not run>: the first routine hold's step and command, and every
# other routine the PR's holds name, so none of them is left out of the person's item.
routine_off_note(){
  local first more
  first=$(printf '%s\n' "$2" | head -1)
  more=$(printf '%s\n' "$2" | tail -n +2 | cut -f1 | awk 'NF { printf "%s`%s`", s, $0; s = ", " }')
  queue_note "$1" "merge hold: $(printf '%s' "$first" | cut -f2); routine \`$(printf '%s' "$first" | cut -f1)\` not run: $3${more:+ (it also names $more)}"
}
# run_routines <n> <sha> <key> <routines> -> 0 once each routine has exited 0 at <sha> and the PR's head is
# still <sha>. <routines> is lines `<command>\t<hold>`. Each runs with bash in a detached checkout of
# <sha> (removed after), with DESK_PR, DESK_HEAD_SHA and DESK_REPO set, stdin closed.
run_routines(){
  local n="$1" sha="$2" key="$3" rec="$SD/routine-$1-$2" dir="$SD/routine-$1-checkout" cmd hold rc step head
  if [ ! -f "$rec.ok" ]; then
    if ! git cat-file -e "$sha^{commit}" 2>/dev/null && ! git fetch -q origin "pull/$n/head" 2>/dev/null; then
      log "#$n its §4 Merge holds routine is not run: head ${sha:0:9} could not be fetched — retrying next loop"; return 1
    fi
    git worktree remove --force "$dir" >/dev/null 2>&1; rm -rf "$dir"
    if ! git worktree add -q --detach "$dir" "$sha" >/dev/null 2>&1; then
      log "#$n its §4 Merge holds routine is not run: no checkout of ${sha:0:9} could be made at $dir — retrying next loop"; return 1
    fi
    : > "$rec.log"
    while IFS="$TAB" read -r cmd hold; do
      [ -n "$cmd" ] || continue
      log "#$n running the §4 Merge holds routine at ${sha:0:9} (§3 merge-hold-routine): $cmd"
      printf '$ %s\n' "$cmd" >> "$rec.log"
      : > "$rec.step"
      (cd "$dir" && DESK_PR="$n" DESK_HEAD_SHA="$sha" DESK_REPO="$REPO" bash -c "$cmd" </dev/null 2>&1) | tee -a "$rec.log" > "$rec.step"
      rc=${PIPESTATUS[0]}
      if [ "$rc" -ne 0 ]; then
        step=$(grep -v '^[[:space:]]*$' "$rec.step" | tail -1 | cut -c1-300)
        printf '%s\t%s\t%s\t%s\n' "$rc" "$cmd" "$hold" "$step" > "$rec.failed"
        rm -f "$rec.step"; git worktree remove --force "$dir" >/dev/null 2>&1
        log "#$n its §4 Merge holds routine FAILED at ${sha:0:9} (exit $rc): $cmd — ${step:-it printed nothing}; not merging, and not run again at this head (output: $rec.log)"
        routine_failed_note "$key" "$rec.failed" "$sha"
        return 1
      fi
      log "#$n routine done at ${sha:0:9}: $cmd"
    done <<EOF_ROUTINES
$4
EOF_ROUTINES
    rm -f "$rec.step"; git worktree remove --force "$dir" >/dev/null 2>&1
    touch "$rec.ok"
  fi
  # The routine ran against this commit: a head that moved meanwhile is a different change.
  head=$(gh pr view "$n" --repo "$REPO" --json headRefOid 2>/dev/null | jq -r '.headRefOid // empty')
  if [ "$head" != "$sha" ]; then log "#$n head is ${head:-unreadable}, not ${sha:0:9} where its routine ran — not merging"; return 1; fi
}

try_pr(){ # try_pr <n> <key> -> 0 when it merged
  local n="$1" key="$2" g sha ms state holds met carried="" bare routines="" fb decision unresolved held settled tid text green_at out waived label grant steps="" review_required awaiting
  backed_off "$n" && { log "#$n backed off after a refused merge — retrying later"; return 1; }
  g=$(node "$GATE" pr "$n" --repo "$REPO" --merger "$AUTHOR" 2>&1) || { log "#$n could not be evaluated: $(printf '%s' "$g" | tail -1)"; return 1; }
  sha=$(printf '%s' "$g" | jq -r .sha); ms=$(printf '%s' "$g" | jq -r .mergeState); state=$(printf '%s' "$g" | jq -r .gate.state)
  [ "$(printf '%s' "$g" | jq -r .base)" = "$BASE_BRANCH" ] || { log "#$n is not based on $BASE_BRANCH — not the batch's to merge"; return 1; }

  holds=$(printf '%s' "$g" | jq -r '.holds[] | "\(.why) — \(.glob), \(.count) file(s), e.g. \(.files[0] // "?")"')
  met=$(printf '%s' "$g" | jq -r '(.holdsMet // [])[] | "\(.why) — \(.glob)"' | paste -sd ';' -)
  [ -n "$met" ] && log "#$n §4 Merge holds met with no person: $met"
  [ -n "$holds" ] || blocked_clear "$key" "merge hold:"
  if [ -n "$holds" ] && [ "$(printf '%s' "$g" | jq -r .holdsApply)" = false ]; then
    carried=$(printf '%s' "$holds" | paste -sd ';' -)
    log "#$n touches §4 Merge holds ($carried), but its base $BASE_BRANCH is not $(printf '%s' "$g" | jq -r .defaultBranch), so merging it deploys nothing; once it merges, the hold is the pass's to report on $BASE_BRANCH's own PR"
  elif [ -n "$holds" ]; then
    [ "$(printf '%s' "$g" | jq -r .autoMerge)" = true ] && gh pr merge "$n" --repo "$REPO" --disable-auto >/dev/null 2>&1
    # A hold that names no routine is the person's step; one that does is run below, before the merge,
    # where §3 merge-hold-routine is yes. Each routine once, in the row's order.
    bare=$(printf '%s' "$g" | jq -r '.holds[] | select((.routine // "") == "") | "\(.why) — \(.glob), \(.count) file(s), e.g. \(.files[0] // "?")"')
    routines=$(printf '%s' "$g" | jq -r 'reduce (.holds[] | select((.routine // "") != "")) as $h ([]; if any(.[]; .routine == $h.routine) then . else . + [$h] end)
      | .[] | "\(.routine)\t\(.why) — \(.glob), \(.count) file(s), e.g. \(.files[0] // "?")"')
    if [ -n "$bare" ]; then
      log "#$n HELD by §4 Merge holds — a person merges it, after its step: $(printf '%s' "$holds" | paste -sd ';' -)"
      # A routine hold's step comes first in the note, so the person is never sent past it to the merge.
      if [ -n "$routines" ]; then routine_off_note "$key" "$routines" "it also touches a hold no routine clears: $(printf '%s' "$bare" | head -1)"
      else queue_note "$key" "merge hold: $(printf '%s' "$bare" | head -1)"; fi
      return 1
    fi
    if [ "$ROUTINE_PERM" != yes ]; then
      log "#$n HELD by §4 Merge holds — its routine is not run, §3 merge-hold-routine is $ROUTINE_PERM: $(printf '%s' "$holds" | paste -sd ';' -)"
      routine_off_note "$key" "$routines" "§3 merge-hold-routine is $ROUTINE_PERM"
      return 1
    fi
    if [ -f "$SD/routine-$n-$sha.failed" ]; then
      log "#$n HELD by §4 Merge holds — its routine already failed at ${sha:0:9}; a person settles it (a new head runs it again)"
      routine_failed_note "$key" "$SD/routine-$n-$sha.failed" "$sha"
      return 1
    fi
    blocked_clear "$key" "merge hold:"
    log "#$n touches §4 Merge holds whose routine desk runs before merging (§3 merge-hold-routine): $(printf '%s' "$holds" | paste -sd ';' -)"
  fi

  if [ -n "$FEEDBACK_STRICT" ]; then
    fb=$(feedback "$n")
    if [ -z "$fb" ]; then log "#$n could not read review state — not merging it this loop"; return 1; fi
    decision=$(printf '%s' "$fb" | jq -r .decision)
    held=$(printf '%s' "$fb" | jq -r '.left[].text')
    settled=$(printf '%s' "$fb" | jq -r '.resolve[] | "\(.id)\t\(.text)"')
    # The desk-review threads a clean verdict at the head settles are resolved; one GitHub refuses still holds.
    while IFS="$TAB" read -r tid text; do
      [ -n "$tid" ] || continue
      if [ "$(resolve_thread "$tid")" = true ]; then
        log "#$n resolved desk-review thread $text: the clean desk-review verdict at $(printf '%s' "$fb" | jq -r '.verdict[:9]') settles it"
      else
        log "#$n could not resolve desk-review thread $text"; held="$held${held:+$'\n'}$text"
      fi
    done <<EOF_RESOLVE
$settled
EOF_RESOLVE
    unresolved=$(printf '%s' "$held" | grep -c .)
    if [ "$decision" = "CHANGES_REQUESTED" ] || [ "$unresolved" -gt 0 ]; then
      [ "$(printf '%s' "$g" | jq -r .autoMerge)" = true ] && gh pr merge "$n" --repo "$REPO" --disable-auto >/dev/null 2>&1
      log "#$n has outstanding review feedback ($decision, $unresolved unresolved) — work it first; not merging (§3 merge-feedback-first: $FEEDBACK_RAW)"
      approval_clear "$key"
      if [ "$unresolved" -gt 0 ]; then feedback_stall "$n" "$key" "$state" "$unresolved" "$(printf '%s\n' "$held" | head -1)"
      else feedback_clear "$n" "$key"; fi
      return 1
    fi
    feedback_clear "$n" "$key"
  fi

  case "$ms" in
    DIRTY) approval_clear "$key"; log "#$n DIRTY — the pass sends it to a fix worker for the conflict, or reports it stuck"; return 1 ;;
    BEHIND) approval_clear "$key"; behind "$n" "$sha" "$key"; return 1 ;;
  esac

  # Branch protection wants an approving review the PR has not had, which no rerun or fix worker gives
  # it: the queue asks the person, red or green. A red one is still rerun, so its fix tries still come.
  review_required=""
  if [ "$(printf '%s' "$g" | jq -r .reviewDecision)" = REVIEW_REQUIRED ]; then
    review_required=1
    [ "$(printf '%s' "$g" | jq -r .autoMerge)" = true ] && gh pr merge "$n" --repo "$REPO" --disable-auto >/dev/null 2>&1
    rm -f "$SD/green-$n"
    log "#$n at ${sha:0:9} needs an approving review (review decision REVIEW_REQUIRED) — not merging until a person approves it"
    queue_note "$key" "approval: an approving review is required at ${sha:0:9}: a person approves it before desk merges it"
  fi

  waived=""
  case "$state" in
    pass) ;;
    fail)
      log "#$n red at ${sha:0:9}: $(printf '%s' "$g" | jq -r '.gate.reasons[:3] | join("; ")')"
      # A red §4 State check of kind approval reads a person's approval at the head: only a person
      # clears it, so the queue asks them, and rerun leaves it alone.
      awaiting=$(printf '%s' "$g" | jq -r '[.gate.stateFailing[]? | select(.kind == "approval") | "\"\(.name)\""] | join(", ")')
      if [ -n "$awaiting" ] && [ -z "$review_required" ]; then
        log "#$n at ${sha:0:9} waits on an approval: $awaiting — a person approves it; no rerun"
        queue_note "$key" "approval: $awaiting needs approval from a human reviewer at ${sha:0:9}: a person approves it before desk merges it"
      fi
      # A waiver only lets a head merge, which one awaiting an approval may not, and its note would replace the approval's.
      if [ -z "$review_required" ] && [ -z "$awaiting" ] && waivable "$n" "$sha" "$g" "$key"; then waived="$WAIVED"
      else [ -n "$review_required" ] || [ -n "$awaiting" ] || approval_clear "$key"; rerun "$n" "$sha" "$g"; return 1; fi ;;
    *) [ -n "$review_required" ] || approval_clear "$key"; log "#$n not green yet ($state): $(printf '%s' "$g" | jq -r '.gate.reasons[:2] | join("; ")')"; return 1 ;;
  esac
  [ -n "$review_required" ] && return 1
  # A waived head is held like a green one: the same head, still only red on its known flakes, a loop later.
  label="green"; [ -n "$waived" ] && label="green but for WAIVED $waived"

  # The person's steps in no batch (merge_after) hold the merge, not the build: pass.mjs lifts each once
  # Jira has it Done. A queue that is there but cannot be read holds it too.
  if [ -f "$DESK_QUEUE" ] && ! steps=$(jq -r --arg k "$key" '(.tickets[$k].merge_after // "") | split("|") | map(select(. != "")) | join(", ")' "$DESK_QUEUE" 2>/dev/null); then
    log "#$n could not read the queue for its merge holds — not merging it this loop"; return 1
  fi
  if [ -n "${steps:-}" ]; then
    [ "$(printf '%s' "$g" | jq -r .autoMerge)" = true ] && gh pr merge "$n" --repo "$REPO" --disable-auto >/dev/null 2>&1
    rm -f "$SD/green-$n"
    log "#$n $label at ${sha:0:9}, HELD until the person's step $steps is Done in Jira — the pass lifts the hold then"
    return 1
  fi

  if is_feature "$(printf '%s' "$g" | jq -r '.title // ""')" && [ "$(printf '%s' "$g" | jq -r .reviewDecision)" != APPROVED ]; then
    [ "$(printf '%s' "$g" | jq -r .autoMerge)" = true ] && gh pr merge "$n" --repo "$REPO" --disable-auto >/dev/null 2>&1
    rm -f "$SD/green-$n"
    log "#$n $label at ${sha:0:9}, a feature with no approval — not merging until a person approves it"
    queue_note "$key" "approval: a feature, $label at ${sha:0:9} with no approval: a person approves it before desk merges it"
    return 1
  fi
  approval_clear "$key"

  # Green now. It must still be green at the same head on a later loop before it merges.
  green_at=$(awk -v s="$sha" '$1 == s { print $2 }' "$SD/green-$n" 2>/dev/null)
  if [ -z "$green_at" ]; then echo "$sha $(date +%s)" > "$SD/green-$n"; log "#$n $label at ${sha:0:9} — confirming on the next loop before merging"; return 1; fi
  if [ $(( $(date +%s) - green_at )) -lt "$GREEN_HOLD_SECS" ]; then log "#$n $label at ${sha:0:9} — confirming"; return 1; fi

  if ! grant=$(node "$DESK_ENV_MJS" merge-grant 2>&1); then
    log "FAIL: ${grant#*"$TAB"} — not merging #$n; stopping"; exit 1
  fi
  # Last before the merge, so a routine never runs for a PR that would not merge after it. The row is
  # read again here, as the grant is, so revoking it stops a driver that is already running.
  if [ -n "$routines" ]; then
    ROUTINE_PERM="$(desk_perm merge-hold-routine)"
    if [ "$ROUTINE_PERM" != yes ]; then
      log "#$n HELD by §4 Merge holds — its routine is not run, §3 merge-hold-routine is now $ROUTINE_PERM"
      routine_off_note "$key" "$routines" "§3 merge-hold-routine is $ROUTINE_PERM"; rm -f "$SD/green-$n"; return 1
    fi
    if ! run_routines "$n" "$sha" "$key" "$routines"; then rm -f "$SD/green-$n"; return 1; fi
  fi
  if [ -n "$waived" ]; then log "#$n WAIVED $waived at ${sha:0:9}: §4 Known flaky checks, still red after 2 reruns, no listed path touched — merging (pinned to that commit)"
  else log "#$n gate GREEN at ${sha:0:9} — merging (pinned to that commit)"; fi
  if out=$(gh pr merge "$n" --repo "$REPO" "--$MERGE_METHOD" --match-head-commit "$sha" 2>&1); then
    log "#$n MERGED ($key)"; rm -f "$SD/green-$n"
    # A hold it merged past goes with the ticket to the base's own PR into the default branch (pass.mjs).
    if [ -n "$carried" ]; then
      if node "$Q" set "$key" "promotion_hold=$carried" >/dev/null 2>&1; then log "#$n §4 Merge holds recorded for $BASE_BRANCH's own PR: $carried"
      else log "#$n §4 Merge holds NOT recorded for $BASE_BRANCH's own PR — a person merges that PR only after: $carried"; fi
    fi
    # A merge only the batch's approval allowed is noted, as an undraft under it is.
    if [ "${grant%%"$TAB"*}" = batch ]; then
      [ -f "$DESK_STATE/batch-notes.md" ] || printf '# Batch notes\n\n' > "$DESK_STATE/batch-notes.md"
      printf -- '- [%s] merged #%s at %s: %s\n' "$key" "$n" "$sha" "${grant#*"$TAB"}" >> "$DESK_STATE/batch-notes.md"
    fi
    [ -n "$waived" ] && flaky_ticket "$n" "$sha" "$g" "$key" "$waived"
    # The merge time on the ticket, and its line in the eta history. A failure here never undoes the merge.
    if rec=$(node "$Q" merged "$key" 2>&1); then log "#$n $(printf '%s' "$rec" | paste -sd ';' -)"
    else log "#$n merge time not recorded: $(printf '%s' "$rec" | tail -1)"; fi
    close_merged "$n" "$key"
    return 0
  fi
  if printf '%s' "$out" | grep -qiE 'not up to date|behind|out of date|update the branch'; then behind "$n" "$sha" "$key"
  else log "#$n merge refused: $(printf '%s' "$out" | tail -1) — backing off 10m, the rest carry on"; back_off "$n"; fi
  return 1
}

log "merge driver up: repo=$REPO base=$BASE_BRANCH author=$AUTHOR tickets=[${KEY_LIST[*]}] deps=[${DEP_LIST[*]:-none}] method=$MERGE_METHOD merge-by=$GRANT_BY required=[$(printf '%s' "$REQUIRED" | paste -sd ',' -)] ci-rerun=$RERUN_PERM update-branch=$UPDATE_PERM feedback-first=$FEEDBACK_RAW flaky=[$(printf '%s' "$FLAKY" | cut -f1 | paste -sd ',' -)] state=[$(printf '%s' "$STATE_CHECKS" | cut -f1 | paste -sd ',' -)]"
# One release pass and out: for tests, and for checking by hand what would be released now.
if [ -n "${MERGE_DRIVER_RELEASE_ONLY:-}" ]; then release_chain </dev/null; exit 0; fi
# pause <secs> [<one-loop exit code>]: the wait between loops, or the end of a one-loop run.
pause(){ if [ -n "${MERGE_DRIVER_ONE_LOOP:-}" ]; then exit "${2:-0}"; fi; sleep "$1"; }
while true; do
  join_queue_tickets
  release_chain

  list=$(prs open); rc=$?
  # Signed out, every later loop fails the same way, so the driver stops and says so: the supervisor
  # reads this line as the reason, rather than a driver that runs and never merges.
  if [ "$rc" -eq 4 ]; then log "FAIL: gh is signed out ($(tail -1 "$GH_ERR" 2>/dev/null)) — nothing can merge until \`gh auth login\`; stopping"; exit 1; fi
  [ "$rc" -eq 0 ] || { log "could not list PRs"; pause 120 1; continue; }
  drafts=$(printf '%s\n' "$list" | awk -F'\t' '$2 == "true" { printf "#%s ", $1 }'); [ -n "$drafts" ] && log "draft (still reviewing): $drafts"
  ready=$(printf '%s\n' "$list" | awk -F'\t' '$2 == "false" { print $1 "\t" $3 }')
  if [ -z "$ready" ]; then
    # A driver started on the wrong base lists nothing and would say only that, forever: name the batch
    # PRs open on any other base, so the mismatch shows in the log.
    elsewhere=$(PRS_BASE='' prs open </dev/null | awk -F'\t' -v b="$BASE_BRANCH" '$4 != b { printf "%s#%s (%s) on %s", s, $1, $3, $4; s = ", " }')
    if [ -n "$elsewhere" ]; then log "no ready batch PRs on $BASE_BRANCH, the only base this driver watches; batch PRs open on another base: $elsewhere"
    else log "no ready batch PRs"; fi
    pause 60; continue
  fi

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
