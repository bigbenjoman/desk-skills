#!/usr/bin/env bash
# suite: date hold (blocked-until-<date> labels hold a ticket until that day)
# pass.mjs with triage records labelled blocked-until-<date>: a date after today holds the ticket and
# spawns nothing, today or earlier spawns it, a held ticket is released on the first pass on or after
# its day, and a label whose date cannot be read holds it for the person, who can let it start. Runs the
# real pass.mjs with stub claude, gh, setup-worktree and spawn-worker. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/state/logs" "$T/state/triage" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_START_STAGE DESK_GITHUB_HANDLE CLAUDE_CONFIG_DIR CODEX_HOME DESK_AUTOPILOT_WORKER
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
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
for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
printf '#!/bin/sh\necho %s\n' "'[]'" > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/lsof"
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/lsof"
export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
labels(){ k=$1; shift; node -e 'const [f, ...l] = process.argv.slice(1); require("fs").writeFileSync(f, JSON.stringify({ ticket: "x", epic: null, labels: l }))' "$T/state/triage/$k.json" "$@"; }
# This machine's local day, and the days either side of it.
day(){ node -e 'const d = new Date(); d.setDate(d.getDate() + Number(process.argv[1])); console.log(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)' -- "$1"; }
TODAY=$(day 0); TOMORROW=$(day 1); YESTERDAY=$(day -1)

q init t
q set-batch concurrency=3
q add D-1; q set D-1 state=triaged lane=A; labels D-1 Flagged "blocked-until-$TOMORROW"
q add D-2; q set D-2 state=triaged lane=A; labels D-2 "blocked-until-$TODAY"
q add D-3; q set D-3 state=triaged lane=A; labels D-3 "blocked-until-$YESTERDAY"
q add D-4; q set D-4 state=triaged lane=A; labels D-4 blocked-until-soon
out=$(node "$B/pass.mjs" 2>&1)
check "DS-555 AC1 a date after today holds the ticket and spawns no worker" '[ "$(field D-1 state)" = "\"parked\"" ] && [ "$(field D-1 held_label)" = "\"blocked-until-$TOMORROW\"" ] && [ "$(field D-1 session_id)" = null ]'
check "DS-555 AC1 the pass shows it HELD until that date" 'grep -q "^HELD: D-1 (until $TOMORROW)$" <<< "$out"'
check "DS-555 AC1 it is not reported stuck or waiting on a merge" '! grep -qE "D-1: STUCK|WAITING ON MERGE: .*D-1" <<< "$out"'
check "DS-555 AC2 a label naming today spawns as usual" '[ "$(field D-2 state)" = "\"running\"" ]'
check "DS-555 AC2 a label naming a past day spawns as usual" '[ "$(field D-3 state)" = "\"running\"" ]'
check "DS-555 AC3 a label whose date cannot be read holds the ticket" '[ "$(field D-4 state)" = "\"parked\"" ] && [ "$(field D-4 session_id)" = null ]'
check "DS-555 AC3 the pass names the bad label for the person" 'grep -q "D-4: HELD — its label blocked-until-soon names no date" <<< "$out" && ! grep -q "D-4: STUCK" <<< "$out"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-555 a second pass before the day keeps it held, and says so once" '[ "$(field D-1 state)" = "\"parked\"" ] && [ "$(grep -c "^HELD: D-1 " <<< "$out")" = 1 ] && ! grep -q "date hold: D-1" <<< "$out"'
check "DS-555 the batch table shows it HELD until its date, and the bad label as HELD, not STUCK" 'grep -qE "HELD +D-1 +until $TOMORROW \(label blocked-until-$TOMORROW\)" <<< "$out" && grep -qE "HELD +D-4 +its label blocked-until-soon" <<< "$out" && ! grep -q STUCK <<< "$out"'

# The day comes: the held label now names today.
q set D-2 state=done; q set D-3 state=done
labels D-1 Flagged "blocked-until-$TODAY"
# The person lets D-4 start, as desk-q's release command does.
q set D-4 state=triaged park=null held_by=null
out=$(node "$B/pass.mjs" 2>&1)
check "DS-555 AC2 the first pass on its day releases it and spawns it" '[ "$(field D-1 state)" = "\"running\"" ] && [ "$(field D-1 held_label)" = null ] && grep -q "date hold: D-1: $TODAY has come; RELEASED" <<< "$out"'
check "DS-555 AC3 a ticket the person let start is not held on the same label again" '[ "$(field D-4 state)" = "\"running\"" ]'

# A held ticket whose triage record no longer carries the label is released.
q add D-5; q set D-5 state=triaged lane=A; labels D-5 "blocked-until-$TOMORROW"
q set D-1 state=done; q set D-4 state=done
node "$B/pass.mjs" >/dev/null 2>&1
labels D-5
out=$(node "$B/pass.mjs" 2>&1)
check "DS-555 a held ticket whose label is gone is released" '[ "$(field D-5 state)" = "\"running\"" ] && grep -q "date hold: D-5: no longer labelled blocked-until; RELEASED" <<< "$out"'

# A label moved to a later day, or a bad label fixed, moves the hold with it.
LATER=$(day 2)
q set D-5 state=done
q add D-6; q set D-6 state=triaged lane=A; labels D-6 "blocked-until-$TOMORROW"
q add D-7; q set D-7 state=triaged lane=A; labels D-7 blocked-until-soon
node "$B/pass.mjs" >/dev/null 2>&1
labels D-6 "blocked-until-$LATER"; labels D-7 "blocked-until-$TOMORROW"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-555 a held ticket whose label moves to a later day is held on the new one" '[ "$(field D-6 state)" = "\"parked\"" ] && [ "$(field D-6 held_label)" = "\"blocked-until-$LATER\"" ] && grep -q "^HELD: .*D-6 (until $LATER)" <<< "$out"'
check "DS-555 AC3 a bad label fixed to a later day holds it until that day" '[ "$(field D-7 state)" = "\"parked\"" ] && [ "$(field D-7 held_label)" = "\"blocked-until-$TOMORROW\"" ] && ! grep -q "D-7: HELD — its label" <<< "$out"'
labels D-6 "blocked-until-$TOMORROW"; labels D-7 "blocked-until-$TODAY"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-555 a held ticket whose label moves to today is released" '[ "$(field D-7 state)" = "\"running\"" ] && grep -q "date hold: D-7: $TODAY has come; RELEASED" <<< "$out"'

# A date-held ticket put behind a blocker waits on the blocker first, then on its date.
q set D-7 state=done
q add D-8; q set D-8 state=triaged lane=A
q hold D-6 D-8
check "DS-555 a blocker added to a date-held ticket holds it behind the blocker" '[ "$(field D-6 state)" = "\"parked\"" ] && [ "$(field D-6 held_by)" = "\"D-8\"" ] && [ "$(field D-6 held_label)" = null ]'
labels D-6 "blocked-until-$TODAY"
node "$B/pass.mjs" >/dev/null 2>&1
check "DS-555 its date coming does not release it while the blocker is unmerged" '[ "$(field D-6 state)" = "\"parked\"" ] && [ "$(field D-6 held_by)" = "\"D-8\"" ]'
labels D-6 "blocked-until-$TOMORROW"
# The blocker merges and the merge driver releases it, as release_chain does.
q set D-6 state=triaged park=null held_by=null
out=$(node "$B/pass.mjs" 2>&1)
check "DS-555 released by its blocker before its date, it is held on its date again" '[ "$(field D-6 state)" = "\"parked\"" ] && [ "$(field D-6 held_label)" = "\"blocked-until-$TOMORROW\"" ] && [ "$(field D-6 session_id)" = null ]'

# The label's reading, and a batch that waits on a date is not settled.
out=$(node --input-type=module -e "
import { untilDay, dateHoldOf, batchSettled } from '$B/batch-state.mjs';
const held = { state: 'parked', held_label: 'blocked-until-2026-11-14', park: { question: 'held by orchestrator: x' } };
console.log([untilDay('blocked-until-2026-11-14'), untilDay('Blocked-Until-2026-02-30'), untilDay('blocked-until-14-11-2026'),
  JSON.stringify(dateHoldOf(['blocked-until-2026-11-14', 'blocked-until-2026-12-01', 'x'])), JSON.stringify(dateHoldOf(['blocked-until-2026-11-14', 'blocked-until-'])),
  dateHoldOf(['milestone']), batchSettled({ tickets: { A: held } }), batchSettled({ tickets: { A: { ...held, held_label: 'blocked-until-x' } } })].map(String).join(' '));
" 2>&1)
check "DS-555 a label's day is a real YYYY-MM-DD day, the latest wins, and a bad one wins over all" '[ "$out" = "2026-11-14 null null {\"label\":\"blocked-until-2026-12-01\",\"until\":\"2026-12-01\"} {\"label\":\"blocked-until-\",\"bad\":true} null false true" ]'

echo "$PASS checks passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
