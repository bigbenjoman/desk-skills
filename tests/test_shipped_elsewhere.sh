#!/usr/bin/env bash
# suite: pass (a ticket shipped outside its worker is recorded done, not spawned)
# Before a spawn, resume or handoff the pass looks for a PR merged since the ticket joined the queue
# whose branch names its key, and for the ticket done in Jira with no PR of its own. Either is
# recorded done and spawns nothing; a ticket with neither, or whose reads fail, spawns as before. Runs
# the real pass.mjs with stub claude, gh, desk-jira, setup-worktree and spawn-worker. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt" "$T/jira"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_START_STAGE DESK_GITHUB_HANDLE
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

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`DS-[0-9]+\` |
EOF

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1" >> "$T/spawned"; echo "[spawn] ticket=\$1"; fi
EOF
printf '#!/bin/sh\necho "[]"\n' > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/lsof"
# gh pr list --search <s>: $T/merged.json, every search logged to $T/searches. Anything else answers nothing.
cat > "$T/stub/gh" <<EOF
#!/bin/sh
[ "\$1 \$2" = "pr list" ] || exit 0
s=""; while [ \$# -gt 0 ]; do [ "\$1" = --search ] && s="\$2"; shift; done
echo "\$s" >> "$T/searches"; cat "$T/merged.json" 2>/dev/null || echo "[]"
EOF
# desk-jira get <KEY> --json: $T/jira/<KEY>.json, or unreachable.
cat > "$T/stub/desk-jira" <<EOF
#!/bin/sh
[ -f "$T/jira/\$2.json" ] && { cat "$T/jira/\$2.json"; exit 0; }; echo "desk-jira: unreachable" >&2; exit 1
EOF
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/desk-jira" "$T/stub/lsof"
jira(){ printf '{"key":"%s","fields":{"status":{"name":"%s","statusCategory":{"key":"%s"}}}}\n' "$1" "$2" "$3" > "$T/jira/$1.json"; }

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
spawned(){ grep -qx "$1" "$T/spawned" 2>/dev/null; }
# queued <KEY> <branch> [<field=value> ...]: triaged, joined the queue on 2026-10-31 at 10:00Z.
queued(){ k=$1 b=$2; shift 2; q add "$k" Bug A; q set "$k" state=triaged "branch=$b" added_at=2026-10-31T10:00:00Z "$@"; }

q init se
# DS-371's timeline: queued 10:00, its worker handed off to Stage 7, and a session's PR #337 from
# fix/DS-371-evidence-workflow merged at 11:49:54Z. DS-376: a killed worker waiting to resume, whose
# key a merged PR's branch carries too.
mkdir -p "$T/wt/DS-371" "$T/wt/DS-376"
queued DS-371 fix/DS-371-own handoff=pending handoff_stage=7 "worktree=$T/wt/DS-371" draft_pr=336
queued DS-376 fix/DS-376-own resume=pending "worktree=$T/wt/DS-376" session_id=s-376
# A PR whose title names the key, from a branch that does not: another ticket's PR often names it.
queued DS-377 fix/DS-377-own
# Done once, its own PR #341 merged at 10:20, then requeued for more work: its own merge is not news.
queued DS-378 fix/DS-378-own result.pr=341 merged_at=2026-10-31T10:20:00Z
# AC2: done in Jira, no PR anywhere.
queued DS-373 fix/DS-373-x; jira DS-373 Done "done"
# AC3: neither. DS-40's key is only a prefix of DS-404's branch; DS-372's PR merged before it was
# queued; DS-374 is done in Jira but has a PR of its own still open; DS-40's Jira read fails.
queued DS-40 fix/DS-40-x
queued DS-372 fix/DS-372-x; jira DS-372 "To Do" new
queued DS-374 fix/DS-374-x draft_pr=900; jira DS-374 Done "done"
cat > "$T/merged.json" <<'EOF'
[{"number":330,"headRefName":"fix/DS-371-first-go","mergedAt":"2026-10-31T10:30:00Z"},
 {"number":337,"headRefName":"fix/DS-371-evidence-workflow","mergedAt":"2026-10-31T11:49:54Z"},
 {"number":341,"headRefName":"fix/DS-378-own","mergedAt":"2026-10-31T10:20:00Z"},
 {"number":338,"headRefName":"fix/DS-404-something","mergedAt":"2026-10-31T12:00:00Z"},
 {"number":301,"headRefName":"feat/DS-372-part-one","mergedAt":"2026-10-30T09:00:00Z"},
 {"number":339,"headRefName":"chore/DS-376-by-hand","mergedAt":"2026-10-31T13:00:00Z"},
 {"number":340,"title":"fix(pass): DS-377 save it","headRefName":"claude/save-abc","mergedAt":"2026-10-31T14:00:00Z"}]
EOF
q set-batch concurrency=3

out=$(node "$B/pass.mjs" 2>&1)
check "DS-404 AC1 DS-371: the PR merged from another branch is recorded as its result, newest first" \
  '[ "$(field DS-371 state)" = "\"done\"" ] && [ "$(field DS-371 result.pr)" = 337 ] && [ "$(field DS-371 handoff)" = null ]'
check "DS-404 AC1 DS-371: no Stage 7 session is spawned, and the report says why" \
  '! spawned DS-371 && grep -q "DS-371: PR #337 merged from fix/DS-371-evidence-workflow, outside its worker: recorded done, no worker spawned" <<< "$out"'
check "DS-404 AC1 a killed worker whose key a merged branch carries is not resumed" \
  '[ "$(field DS-376 state)" = "\"done\"" ] && [ "$(field DS-376 result.pr)" = 339 ] && [ "$(field DS-376 resume)" = null ] && ! spawned DS-376'
check "DS-404 AC2 done in Jira with no PR: recorded done, nothing spawned, no PR recorded" \
  '[ "$(field DS-373 state)" = "\"done\"" ] && [ "$(field DS-373 result.pr)" = null ] && ! spawned DS-373 && grep -q "DS-373: done in Jira with no PR, outside its worker: recorded done, no worker spawned" <<< "$out"'
# The machine caps this batch at 3 workers, and five tickets remain: the three shipped took no slot.
check "DS-404 tickets recorded done take no slot: the cap's three workers spawned" '[ "$(wc -l < "$T/spawned" | tr -d " ")" = 3 ]'
check "DS-404 the search asks GitHub only for PRs merged since the ticket was queued" 'grep -qx "merged:>=2026-10-31" "$T/searches"'
# Those three finish, and a second pass spawns the other two.
while read -r k; do q set "$k" state=done; done < "$T/spawned"
out=$(node "$B/pass.mjs" 2>&1)
unshipped(){ spawned "$1" && [ "$(field "$1" result.summary)" = null ]; }
check "DS-404 AC3 a merged PR that names the key only in its title does not count" 'unshipped DS-377'
check "DS-404 AC3 a ticket requeued after its own PR merged spawns, its own merge not counted" 'unshipped DS-378'
check "DS-404 AC3 a key that is only a prefix of a merged branch's spawns as today" 'unshipped DS-40'
check "DS-404 AC3 a PR merged before the ticket was queued does not count" 'unshipped DS-372'
check "DS-404 AC3 done in Jira with an open PR of its own spawns as today" 'unshipped DS-374'

# A failed GitHub read spawns as before.
q add DS-380 Bug A; q set DS-380 state=triaged branch=fix/DS-380-x added_at=2026-10-31T10:00:00Z
printf '#!/bin/sh\necho "gh: HTTP 502" >&2; exit 1\n' > "$T/stub/gh"
for k in DS-40 DS-372 DS-374 DS-377 DS-378; do q set "$k" state=done; done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-404 a merged-PR search that fails spawns as before" '[ "$(field DS-380 state)" = "\"running\"" ] && spawned DS-380'

echo "shipped elsewhere: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
