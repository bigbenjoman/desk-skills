#!/usr/bin/env bash
# pass.mjs after a requeue: screenshots go to the PR the current log names, not the one an earlier
# round stored, and a respawn clears the stored PR and image flags and starts a fresh log. Runs the
# real pass.mjs with stub claude, gh, upload-images, setup-worktree and spawn-worker. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

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
| \`pr-images\` | Upload PR screenshots | \`yes\` | \`yes\` |
EOF

# A DESK_HOME whose bin holds the real queue and harvest scripts beside stubs for everything that
# would touch GitHub, a browser, a worktree or a worker.
for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/upload-images.mjs" <<EOF
import { appendFileSync } from 'node:fs';
appendFileSync('$T/uploads', \`\${process.argv[2]} \${process.argv[3]}\\n\`);
console.log('done: 1 image(s) in the body, 0 placeholder(s) left');
EOF
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}]'" > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
chmod +x "$T/stub/claude" "$T/stub/gh"

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
# One assistant turn of a worker's stream-json log, carrying the given marker lines.
say(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv.slice(1).join("\n") }] } }))' "$@"; }

q init t
# T-1: a requeued round whose log names PR 2 while the queue still holds round one's PR 1.
q add T-1; q set T-1 state=running branch=fix/T-1 session_id=gone result.pr=1
say "AUTOPILOT_IMAGES: $T/state/images/T-1/" "AUTOPILOT_DONE: pr=2 jira=none" > "$T/state/logs/T-1.log"
# T-2: a log with screenshots and no AUTOPILOT_DONE yet, so the stored PR is all there is.
q add T-2; q set T-2 state=running branch=fix/T-2 session_id=gone result.pr=5
say "AUTOPILOT_IMAGES: $T/state/images/T-2/" > "$T/state/logs/T-2.log"

out=$(node "$B/pass.mjs" 2>&1)
check "the log's PR wins over the stored one"           'grep -qx "2 $T/state/images/T-1/" "$T/uploads"'
check "nothing goes to the stored PR when the log has one" '! grep -q "^1 " "$T/uploads"'
check "the stored PR is used when the log has none"     'grep -qx "5 $T/state/images/T-2/" "$T/uploads"'
check "the finished round records the log's PR"         '[ "$(field T-1 result.pr)" = 2 ]'

# T-3: round one finished with PR 1 and uploaded; it is requeued for a deliberate re-run.
q add T-3; q set T-3 state=triaged branch=fix/T-3 result.pr=1 result.summary=old images_uploaded=true images_reported=true
say "AUTOPILOT_IMAGES: $T/state/images/T-3/" "AUTOPILOT_DONE: pr=1 jira=none" > "$T/state/logs/T-3.log"
echo older > "$T/state/logs/T-3.log.round1"
: > "$T/uploads"
out=$(AUTOPILOT_RERUN=T-3 node "$B/pass.mjs" 2>&1)
check "the requeued ticket spawns"                      '[ "$(field T-3 state)" = "\"running\"" ]'
check "spawn clears result"                             '[ "$(field T-3 result)" = null ]'
check "spawn clears images_uploaded"                    '[ "$(field T-3 images_uploaded)" = null ]'
check "spawn clears images_reported"                    '[ "$(field T-3 images_reported)" = null ]'
check "spawn moves the log to the next free round"      '[ ! -e "$T/state/logs/T-3.log" ] && grep -q "pr=1" "$T/state/logs/T-3.log.round2" && grep -qx older "$T/state/logs/T-3.log.round1"'

# The respawned worker (live, as far as the stub registry says) opens PR 2: its screenshots go there.
q set T-3 session_id=live-1
say "AUTOPILOT_IMAGES: $T/state/images/T-3/" > "$T/state/logs/T-3.log"
out=$(node "$B/pass.mjs" 2>&1)
check "no upload before the new round names its PR"     '[ ! -s "$T/uploads" ]'
say "AUTOPILOT_DONE: pr=2 jira=none" >> "$T/state/logs/T-3.log"
out=$(node "$B/pass.mjs" 2>&1)
check "the new round's screenshots go to its PR"        '[ "$(cat "$T/uploads")" = "2 $T/state/images/T-3/" ]'

echo "pass: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
