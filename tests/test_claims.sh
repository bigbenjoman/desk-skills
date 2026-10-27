#!/usr/bin/env bash
# suite: claims (a ticket an idle interactive session claimed goes back to the workers)
# queue.mjs park --claimed-by records the session and the claim time. Each pass reads how long the
# session's transcript under ~/.claude/projects has been still: past config §3b "Release idle claims
# after (hours)", a ticket whose worktree is clean is requeued with its branch kept and pushed once,
# and one with uncommitted changes stays claimed and says so once. A live session changes nothing, and
# the row at 0 never releases. Runs the real pass.mjs with stub claude and gh. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home/.claude/projects/-work-repo" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_START_STAGE DESK_GITHUB_HANDLE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
# config [<Release idle claims after (hours)>]: the row is left out when no value is given.
config(){
  cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
EOF
  [ $# -eq 0 ] || cat >> "$T/config.md" <<EOF

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Release idle claims after (hours) | \`12\` | \`$1\` |
EOF
}
config

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
printf 'echo "[spawn] ticket=$1"\n' > "$T/desk/bin/spawn-worker.sh"
printf '#!/bin/sh\necho "[]"\n' > "$T/stub/claude"
# Every PR reads as open and out of draft, so a park that clears when one is ready holds.
printf '#!/bin/sh\n[ "$1 $2" = "pr view" ] && echo %s\nexit 0\n' "'{\"state\":\"OPEN\",\"isDraft\":false}'" > "$T/stub/gh"
chmod +x "$T/stub/claude" "$T/stub/gh"

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
# session <id> old|now: a transcript last written on 1 Jan 2026, or just now.
session(){ : > "$T/home/.claude/projects/-work-repo/$1.jsonl"; [ "$2" = now ] || touch -t 202601010000 "$T/home/.claude/projects/-work-repo/$1.jsonl"; }
# claimed <KEY> <session>: lane A, its branch recorded, claimed by the session on 1 Jan 2026.
claimed(){ q add "$1" Story A; q set "$1" state=triaged "branch=feat/$1"; q park "$1" --claimed-by "$2"; q set "$1" park.claim.at=2026-01-01T00:00:00Z; }
# worktree <KEY> [<uncommitted file>]
worktree(){ git init -q -b "feat/$1" "$T/wt/$1"; git -C "$T/wt/$1" commit -q --allow-empty -m work; [ $# -lt 2 ] || echo x > "$T/wt/$1/$2"; }

# Nothing spawns, so a released ticket stays where the pass put it.
q init claims; q set-batch concurrency=0

# ---- AC1: the claim records the session and its time -------------------------------------------------
session sid-idle old; session sid-dirty old; session sid-live now; session sid-gone old
q add K-0 Story A; q set K-0 state=triaged
out=$(node "$B/queue.mjs" park K-0 --claimed-by voicepa-84 2>&1); rc=$?
check "DS-244 AC1 a claim by a session with no transcript here is refused, naming --claimed-by" '[ $rc -ne 0 ] && [ "$(field K-0 state)" = "\"triaged\"" ] && grep -q "no transcript for session voicepa-84" <<< "$out"'
out=$(node "$B/queue.mjs" park K-0 --claimed-by sid-live 2>&1)
check "DS-244 AC1 park --claimed-by records the session and the claim time" '[ "$(field K-0 state)" = "\"parked\"" ] && [ "$(field K-0 park.claim.session)" = "\"sid-live\"" ] && [ "$(field K-0 park.claim.at | cut -c2-5)" = "$(date -u +%Y)" ] && grep -q "K-0 parked, claimed by session sid-live" <<< "$out"'
check "DS-244 AC1 with no question given, the park says who claimed it" '[ "$(field K-0 park.question)" = "\"claimed by session sid-live: worked there, not by a worker\"" ]'

claimed K-1 sid-idle; worktree K-1
claimed K-2 sid-dirty; worktree K-2 notes.txt
claimed K-3 sid-live; worktree K-3
claimed K-4 sid-gone; worktree K-4; rm "$T/home/.claude/projects/-work-repo/sid-gone.jsonl"

# A park the ticket already had stays its question under a claim, so the requeue guards still read it.
q add K-5 Story D; q set K-5 state=triaged "branch=feat/K-5"; q park K-5 "lane D — its canvas is not on main: save it there"
q park K-5 --claimed-by sid-idle; q set K-5 park.claim.at=2026-01-01T00:00:00Z; worktree K-5
q add K-6 Story A; q set K-6 state=triaged "branch=feat/K-6"; q park K-6 "size XL: split it before a worker takes it"
q park K-6 --claimed-by sid-dirty; q set K-6 park.claim.at=2026-01-01T00:00:00Z; worktree K-6 draft.md
check "DS-244 claiming a parked ticket keeps its park's question and adds the claim" '[ "$(field K-5 park.question)" = "\"lane D — its canvas is not on main: save it there\"" ] && [ "$(field K-5 park.claim.session)" = "\"sid-idle\"" ]'
out=$(node "$B/queue.mjs" park K-5 --claimed-by sid-idle "new words" 2>&1); rc=$?
check "DS-244 a question given while claiming a parked ticket is refused, keeping its own" '[ $rc -ne 0 ] && grep -q "claim it with no question" <<< "$out" && [ "$(field K-5 park.question)" = "\"lane D — its canvas is not on main: save it there\"" ]'
q add K-7 Story A; q set K-7 state=parked "park.question=held by orchestrator behind K-1"
out=$(node "$B/queue.mjs" park K-7 --claimed-by sid-idle 2>&1); rc=$?
q add K-8 Story A; q set K-8 state=triaged "branch=feat/K-8"; q park K-8 "waiting on PR #7"; q clears-when K-8 pr 7 ready
q park K-8 --claimed-by sid-live; worktree K-8
check "DS-244 a held ticket cannot be claimed" '[ $rc -ne 0 ] && grep -q "cannot be claimed" <<< "$out" && [ "$(field K-7 park.claim)" = null ]'

# ---- AC5: the row at 0 never releases -----------------------------------------------------------------
config 0
out=$(node "$B/pass.mjs" 2>&1)
check "DS-244 AC5 at 0, an idle session's clean claim stays parked" '[ "$(field K-1 state)" = "\"parked\"" ] && ! grep -q "K-1 went back" <<< "$out"'
check "DS-244 AC5 at 0, nothing is noted on a dirty claim either" '[ "$(field K-2 park.claim.dirty_at)" = null ]'
config soon
out=$(node "$B/pass.mjs" 2>&1)
check "DS-244 a row that does not read releases nothing and is named" '[ "$(field K-1 state)" = "\"parked\"" ] && grep -q "Release idle claims after (hours)\" is \"soon\"" <<< "$out"'

# ---- AC2, AC3, AC4: unset is 12 hours ---------------------------------------------------------------
config
out=$(node "$B/pass.mjs" 2>&1)
check "DS-244 AC2 an idle session and a clean worktree: back to the queue, branch kept" '[ "$(field K-1 state)" = "\"triaged\"" ] && [ "$(field K-1 park)" = null ] && [ "$(field K-1 branch)" = "\"feat/K-1\"" ]'
check "DS-244 AC2 one push names the ticket and the session" '[ "$(grep -c "^PUSH: .*K-1 went back to the workers, since session sid-idle" <<< "$out")" = 1 ]'
check "DS-244 AC2 the report says why, under clears-when" 'grep -q "K-1: session sid-idle has been idle since .*, and its worktree is clean: back to the workers, branch feat/K-1 kept" <<< "$out"'
check "DS-244 AC3 uncommitted changes keep the claim, and the park names the files" '[ "$(field K-2 state)" = "\"parked\"" ] && [ "$(field K-2 park.claim.session)" = "\"sid-dirty\"" ] && grep -q "uncommitted changes (notes.txt)" <<< "$(field K-2 park.question)" && [ "$(field K-2 park.claim.dirty_at)" != null ]'
check "DS-244 AC3 it is reported as a park" 'grep -q "K-2: claimed by session sid-dirty, which has been idle past 12h, but its worktree $T/wt/K-2 has uncommitted changes (notes.txt)" <<< "$out"'
check "DS-244 AC4 a live session's claim is left as it was" '[ "$(field K-3 state)" = "\"parked\"" ] && [ "$(field K-3 park.claim.dirty_at)" = null ] && ! grep -q "K-3: \|K-3 went" <<< "$out"'
check "DS-244 a claim whose transcript is gone stays, and is named" '[ "$(field K-4 state)" = "\"parked\"" ] && grep -q "K-4: claimed by session sid-gone, whose transcript is gone: left claimed" <<< "$out"'
check "DS-244 a claimed park whose clears-when holds stays with its live session" '[ "$(field K-8 state)" = "\"parked\"" ] && [ "$(field K-8 park.claim.session)" = "\"sid-live\"" ] && ! grep -q "K-8: " <<< "$out"'
check "DS-244 a lane D parked on its design stays claimed however idle the session" '[ "$(field K-5 state)" = "\"parked\"" ] && [ "$(field K-5 park.claim.session)" = "\"sid-idle\"" ] && ! grep -q "K-5 went back" <<< "$out"'
check "DS-244 a dirty claim on a ticket parked for its size keeps that question in front" 'grep -q "^\"size XL: split it before a worker takes it; claimed by session sid-dirty, .*uncommitted changes (draft.md)" <<< "$(field K-6 park.question)"'
since=$(field K-2 park.since)

out=$(node "$B/pass.mjs" 2>&1)
check "DS-244 AC3 the dirty claim goes to the digest once: not reported or changed again" '! grep -q "K-2: claimed" <<< "$out" && [ "$(field K-2 park.since)" = "$since" ]'
check "DS-244 AC2 a released ticket is not pushed again" '! grep -q "K-1 went back" <<< "$out"'

git -C "$T/wt/K-2" clean -qf
out=$(node "$B/pass.mjs" 2>&1)
check "DS-244 a dirty claim made clean goes back to the workers" '[ "$(field K-2 state)" = "\"triaged\"" ] && grep -q "^PUSH: .*K-2 went back to the workers" <<< "$out"'
git -C "$T/wt/K-6" clean -qf
out=$(node "$B/pass.mjs" 2>&1)
check "DS-244 a claim on a ticket parked for its size is never released to a worker, made clean or not" '[ "$(field K-6 state)" = "\"parked\"" ] && ! grep -q "K-6 went back" <<< "$out"'

echo "claims: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
