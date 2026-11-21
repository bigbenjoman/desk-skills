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
trap 'rm -rf "$T"' EXIT
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

# shellcheck source=link_bin.sh
. "$S/link_bin.sh"; link_bin "$B" "$T/desk/bin"
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
mkdir -p "$T/wt/DS-371" "$T/wt/DS-376" "$T/wt/DS-379" "$T/wt/DS-382" "$T/wt/DS-386"
queued DS-371 fix/DS-371-own handoff=pending handoff_stage=7 "worktree=$T/wt/DS-371" draft_pr=336
queued DS-376 fix/DS-376-own resume=pending "worktree=$T/wt/DS-376" session_id=s-376
# A PR whose title names the key, from a branch that does not: another ticket's PR often names it.
queued DS-377 fix/DS-377-own
# Done once, its own PR #341 merged at 10:20, then requeued for more work: its own merge is not news.
queued DS-378 fix/DS-378-own result.pr=341 merged_at=2026-10-31T10:20:00Z
# AC2: done in Jira, no PR anywhere.
queued DS-373 fix/DS-373-x; jira DS-373 Done "done"
# DS-796 AC2: its only PR, #345 built outside its worker, merged at 12:30:02Z, and the merge driver's
# clock stamped merged_at 1.4s later, with no PR recorded.
queued DS-755 fix/DS-755-x merged_at=2026-10-31T12:30:03.462Z; jira DS-755 Done "done"
# AC3: neither. DS-40's key is only a prefix of DS-404's branch; DS-372's PR merged before it was
# queued; DS-374 is done in Jira but has a PR of its own still open; DS-40's Jira read fails.
queued DS-40 fix/DS-40-x
queued DS-372 fix/DS-372-x; jira DS-372 "To Do" new
queued DS-374 fix/DS-374-x draft_pr=900; jira DS-374 Done "done"
cat > "$T/merged.json" <<'EOF'
[{"number":330,"headRefName":"fix/DS-371-first-go","mergedAt":"2026-10-31T10:30:00Z"},
 {"number":337,"headRefName":"fix/DS-371-evidence-workflow","mergedAt":"2026-10-31T11:49:54Z"},
 {"number":341,"headRefName":"fix/DS-378-own","mergedAt":"2026-10-31T10:20:00Z"},
 {"number":342,"headRefName":"fix/DS-379-own","mergedAt":"2026-10-31T10:25:00Z"},
 {"number":343,"headRefName":"claude/DS-382-session","mergedAt":"2026-10-31T10:27:00Z"},
 {"number":344,"headRefName":"fix/DS-383-own","mergedAt":"2026-10-31T10:29:00Z"},
 {"number":346,"headRefName":"fix/DS-384-own","mergedAt":"2026-10-31T10:31:00Z"},
 {"number":348,"headRefName":"claude/DS-385-session","mergedAt":"2026-10-31T10:33:00Z"},
 {"number":349,"headRefName":"fix/DS-386-own","mergedAt":"2026-10-31T10:35:00Z"},
 {"number":351,"headRefName":"fix/DS-387-own","mergedAt":"2026-10-31T10:37:00Z"},
 {"number":352,"headRefName":"fix/DS-387-two","mergedAt":"2026-10-31T10:37:30Z"},
 {"number":353,"headRefName":"fix/DS-388-own","mergedAt":"2026-10-31T10:39:00Z"},
 {"number":354,"headRefName":"fix/DS-388-two","mergedAt":"2026-10-31T10:41:00Z"},
 {"number":355,"headRefName":"fix/DS-389-session","mergedAt":"2026-10-31T10:43:00Z"},
 {"number":358,"headRefName":"fix/DS-390-session","mergedAt":"2026-10-31T10:48:00Z"},
 {"number":359,"headRefName":"fix/DS-390-two","mergedAt":"2026-10-31T10:49:00Z"},
 {"number":345,"headRefName":"fix/DS-755-x","mergedAt":"2026-10-31T12:30:02Z"},
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
# Done with its merge recorded, it is archived, so it is read with queue.mjs get.
got(){ node "$B/queue.mjs" get "$1" 2>/dev/null | jq -r "$2"; }
check "DS-796 AC2 a merge time a little after its only PR's records that PR, not \"no PR\"" \
  '[ "$(got DS-755 .state)" = done ] && [ "$(got DS-755 .result.pr)" = 345 ] && ! spawned DS-755 && [ "$(got DS-755 .result.summary)" = "shipped outside its worker: PR #345 merged from fix/DS-755-x" ]'
# The machine caps this batch at 3 workers, and five tickets remain: the shipped ones took no slot.
check "DS-404 tickets recorded done take no slot: the cap's three workers spawned" '[ "$(wc -l < "$T/spawned" | tr -d " ")" = 3 ]'
check "DS-404 the search asks GitHub only for PRs merged since the ticket was queued" 'grep -qx "merged:>=2026-10-31" "$T/searches"'
# Those three finish, and a second pass spawns the other two.
while read -r k; do q set "$k" state=done; done < "$T/spawned"
out=$(node "$B/pass.mjs" 2>&1)
unshipped(){ spawned "$1" && [ "$(field "$1" result.summary)" = null ]; }
check "DS-404 AC3 a merged PR that names the key only in its title does not count" 'unshipped DS-377'
check "DS-404 AC3 a ticket requeued after its own PR merged spawns, its own merge not counted" 'unshipped DS-378'

# DS-378's case after its new worker spawned, which cleared its result and kept #342 as merged_pr, and
# was killed: waiting to resume, its own merge is still not news.
while read -r k; do q set "$k" state=done; done < "$T/spawned"
queued DS-379 fix/DS-379-own merged_pr=342 merged_at=2026-10-31T10:25:00Z resume=pending "worktree=$T/wt/DS-379" session_id=s-379
out=$(node "$B/pass.mjs" 2>&1)
check "DS-796 a requeued ticket whose new worker cleared its result is resumed, its own merge (merged_pr) not counted" \
  'spawned DS-379 && [ "$(field DS-379 result.summary)" = null ]'
# The same row as a pre-upgrade pass left it: its spawn cleared the result and kept no merged_pr, its PR
# (#343, from a session's branch, not its own) is still named by its PR status, last read while it was
# open, and it is done in Jira.
# That merge is its own, so it is resumed.
while read -r k; do q set "$k" state=done; done < "$T/spawned"
queued DS-382 fix/DS-382-own merged_at=2026-10-31T10:27:00.500Z upload_round=u-382 resume=pending "worktree=$T/wt/DS-382" session_id=s-382 \
  'pr_status={"pr":343,"state":"OPEN","url":"https://github.com/acme/widgets/pull/343"}'
jira DS-382 Done "done"
# A worker ran (upload_round) with no PR, and a session shipped the ticket from the worker's own branch:
# the merge time it left is not the ticket's own PR, so that PR is still found.
queued DS-383 fix/DS-383-own merged_at=2026-10-31T10:29:00.500Z upload_round=u-383
# Its PR status names a PR of the same number in another repo: not this repo's PR, so #346 here is found.
queued DS-384 fix/DS-384-own merged_at=2026-10-31T10:31:00.500Z \
  'pr_status={"pr":346,"state":"MERGED","url":"https://github.com/o/other/pull/346"}'
# Its PR status names a PR it closed unmerged (#347), and a session's #348 is the merge merged_at
# records: GitHub lists no merge of #347, so #348 is found.
queued DS-385 fix/DS-385-own merged_at=2026-10-31T10:33:00.500Z \
  'pr_status={"pr":347,"state":"CLOSED","url":"https://github.com/acme/widgets/pull/347"}'
# A later round of its own: #349 merged (merged_at), its next round's #350 was read after that and never
# merged, then a pre-upgrade spawn cleared the result. Its own #349 is not news, so it is resumed.
queued DS-386 fix/DS-386-own merged_at=2026-10-31T10:35:00.500Z resume=pending "worktree=$T/wt/DS-386" session_id=s-386 \
  'pr_status={"pr":350,"state":"OPEN","url":"https://github.com/acme/widgets/pull/350","at":"2026-10-31T10:50:00Z"}'
jira DS-386 Done "done"
# The same, but that later round's #352 merged after the spawn: it shipped, so it is recorded on #352.
queued DS-387 fix/DS-387-own merged_at=2026-10-31T10:37:00.500Z \
  'pr_status={"pr":352,"state":"OPEN","url":"https://github.com/acme/widgets/pull/352","at":"2026-10-31T10:40:00Z"}'
# Its first PR #353 merged (merged_at, which keeps only the first merge), then a later round's own #354
# merged and the pass read it MERGED, then a pre-upgrade spawn cleared the result: #354 is its own.
queued DS-388 fix/DS-388-own merged_at=2026-10-31T10:39:00.500Z \
  'pr_status={"pr":354,"state":"MERGED","url":"https://github.com/acme/widgets/pull/354","at":"2026-10-31T10:45:00Z"}'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-796 a later round's own PR read MERGED after merged_at is its own, not shipped outside its worker" \
  'spawned DS-388 && [ "$(field DS-388 result.summary)" = null ] && [ "$(field DS-388 state)" != "\"done\"" ]'
check "DS-796 a status read after merged_at is a later round of its own: its earlier merge is not news" \
  'spawned DS-386 && [ "$(field DS-386 result.summary)" = null ] && [ "$(field DS-386 state)" != "\"done\"" ]'
check "DS-796 a later round's own PR that merged after merged_at is recorded as shipped" \
  '[ "$(got DS-387 .state)" = done ] && [ "$(got DS-387 .result.pr)" = 352 ] && ! spawned DS-387'
check "DS-796 a PR status for a PR that never merged does not hide the merge merged_at records" \
  '[ "$(got DS-385 .state)" = done ] && [ "$(got DS-385 .result.pr)" = 348 ] && ! spawned DS-385'
check "DS-796 a requeued row a pre-upgrade pass spawned (no merged_pr) is resumed, its own merge read from its PR status" \
  'spawned DS-382 && [ "$(field DS-382 result.summary)" = null ] && [ "$(field DS-382 state)" != "\"done\"" ]'
check "DS-796 a worker's earlier round is not a PR of its own: the PR merged from its branch is recorded" \
  '[ "$(got DS-383 .state)" = done ] && [ "$(got DS-383 .result.pr)" = 344 ] && ! spawned DS-383'
check "DS-796 a PR status naming another repo's PR is not this ticket's own PR here" \
  '[ "$(got DS-384 .state)" = done ] && [ "$(got DS-384 .result.pr)" = 346 ] && ! spawned DS-384'
check "DS-404 AC3 a key that is only a prefix of a merged branch's spawns as today" 'unshipped DS-40'
check "DS-404 AC3 a PR merged before the ticket was queued does not count" 'unshipped DS-372'
check "DS-404 AC3 done in Jira with an open PR of its own spawns as today" 'unshipped DS-374'

# Those three finish. DS-389 is DS-388's case with its own #357 missing from a capped search: the status's
# own merge time (10:44) still covers #355, merged at 10:43 between its two merges. DS-390 is the same
# with its later own #359 kept as merged_pr by a spawn: #358, merged between its two merges, is not news.
for k in DS-382 DS-386 DS-388; do q set "$k" state=done; done
queued DS-389 fix/DS-389-own merged_at=2026-10-31T10:42:00.500Z \
  'pr_status={"pr":357,"state":"MERGED","merged_at":"2026-10-31T10:44:00Z","url":"https://github.com/acme/widgets/pull/357","at":"2026-10-31T10:46:00Z"}'
queued DS-390 fix/DS-390-own merged_at=2026-10-31T10:47:00.500Z merged_pr=359
out=$(node "$B/pass.mjs" 2>&1)
check "DS-796 a MERGED status's own merge time counts when a capped search leaves its PR out" \
  'spawned DS-389 && [ "$(field DS-389 result.pr)" = null ] && [ "$(field DS-389 state)" != "\"done\"" ]'
check "DS-796 a later own PR kept as merged_pr covers what merged before it, not only merged_at" \
  'spawned DS-390 && [ "$(field DS-390 result.pr)" = null ] && [ "$(field DS-390 state)" != "\"done\"" ]'

# DS-391: its first PR merged (merged_at), its second round's own #361 merged after it and was kept as
# merged_pr, and its third round's #362 is still open (result.pr) when it is requeued: #361 is its own.
# DS-392: needs-you recorded it done on o/other's PR #363 (result.pr, with that repo's url), then it was
# requeued, and this repo's own #363, merged from its branch since, shipped it. DS-393 is the same with
# nothing merged here yet: it spawns. DS-394's repo was renamed to acme/renamed, so GitHub gives its PRs
# that url while the remote still says acme/widgets: its own merged #366 is not another repo's.
for k in DS-389 DS-390; do q set "$k" state=done; done
queued DS-391 fix/DS-391-own merged_at=2026-10-31T10:50:00.500Z merged_pr=361 result.pr=362
queued DS-392 fix/DS-392-own merged_at=2026-10-31T10:53:00Z result.pr=363 \
  'pr_status={"pr":363,"state":"MERGED","merged_at":"2026-10-31T10:53:00Z","url":"https://github.com/o/other/pull/363"}'
queued DS-393 fix/DS-393-own merged_at=2026-10-31T10:53:00Z result.pr=365 \
  'pr_status={"pr":365,"state":"MERGED","merged_at":"2026-10-31T10:53:00Z","url":"https://github.com/o/other/pull/365"}'
jira DS-393 "In Progress" indeterminate
# DS-395 kept this repo's own #372, then needs-you recorded it done on o/other's #372: its spawn keeps
# both, keyed by repo and number. DS-396 is the same with its own #373 kept as a bare number.
queued DS-395 fix/DS-395-own merged_at=2026-10-31T10:53:00Z result.pr=372 \
  'merged_pr=[{"pr":372,"url":"https://github.com/acme/widgets/pull/372"}]' \
  'pr_status={"pr":372,"state":"MERGED","merged_at":"2026-10-31T10:53:00Z","url":"https://github.com/o/other/pull/372"}'
jira DS-395 "In Progress" indeterminate
queued DS-396 fix/DS-396-own merged_at=2026-10-31T10:53:00Z result.pr=373 merged_pr=373 \
  'pr_status={"pr":373,"state":"MERGED","merged_at":"2026-10-31T10:53:00Z","url":"https://github.com/o/other/pull/373"}'
jira DS-396 "In Progress" indeterminate
queued DS-394 fix/DS-394-own merged_at=2026-10-31T10:56:00.500Z result.pr=366 \
  'pr_status={"pr":366,"state":"MERGED","merged_at":"2026-10-31T10:56:00Z","url":"https://github.com/acme/renamed/pull/366"}'
addmerged(){ node -e 'const f = process.argv[1], fs = require("fs"); const a = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const x of process.argv.slice(2)) { const [n, b, at] = x.split(" "); a.push({ number: Number(n), headRefName: b, mergedAt: at, url: `https://github.com/acme/renamed/pull/${n}` }); }
  fs.writeFileSync(f, JSON.stringify(a))' "$T/merged.json" "$@"; }
addmerged "361 fix/DS-391-two 2026-10-31T10:52:00Z" "363 fix/DS-392-own 2026-10-31T10:54:00Z" "366 fix/DS-394-own 2026-10-31T10:56:00Z"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-796 an open result.pr does not hide its own merged merged_pr: not shipped outside its worker" \
  'spawned DS-391 && [ "$(field DS-391 state)" != "\"done\"" ] && ! grep -q "DS-391: PR #361" <<< "$out"'
check "DS-796 its spawn keeps every PR of its own it recorded, the merged one and the open one" \
  '[ "$(field DS-391 merged_pr)" = "[361,362]" ] && [ "$(field DS-391 result)" = null ]'
check "DS-796 a result.pr from another repo is not this repo's PR of the same number: #363 here shipped it" \
  '[ "$(got DS-392 .state)" = done ] && [ "$(got DS-392 .result.pr)" = 363 ] && ! spawned DS-392'
check "DS-796 and the other repo's PR status is dropped, so this repo's #363 is read for itself" \
  '[ "$(got DS-392 .pr_status)" = null ] && [ "$(got DS-392 .shipped_pr)" = 363 ]'
check "DS-796 a repo renamed since its PR status was read: its own merged PR is its own, not shipped outside its worker" \
  'spawned DS-394 && [ "$(field DS-394 state)" != "\"done\"" ] && ! grep -q "DS-394: PR #366" <<< "$out"'
check "DS-796 another repo's PR with nothing merged here spawns, and its spawn keeps it with that repo's url" \
  'spawned DS-393 && [ "$(field DS-393 merged_pr)" = "[{\"pr\":365,\"url\":\"https://github.com/o/other/pull/365\"}]" ]'
check "DS-796 another repo's PR of the same number does not replace this repo's kept own PR" \
  'spawned DS-395 && [ "$(field DS-395 merged_pr)" = "[{\"pr\":372,\"url\":\"https://github.com/acme/widgets/pull/372\"},{\"pr\":372,\"url\":\"https://github.com/o/other/pull/372\"}]" ]'
check "DS-796 nor a kept bare own number, which stays bare" \
  'spawned DS-396 && [ "$(field DS-396 merged_pr)" = "[373,{\"pr\":373,\"url\":\"https://github.com/o/other/pull/373\"}]" ]'

# DS-391's worker parks and is requeued: it still has #361 kept, so it spawns again. DS-393's worker
# finishes on this repo's #370, whose status replaces the other repo's, and it is requeued. This repo's
# #365 has merged from its branch since: the kept other-repo PR of that number is not this one, so #365
# shipped it.
q set DS-394 state=done; q set DS-391 state=triaged
q set DS-393 state=triaged result.pr=370 'pr_status={"pr":370,"state":"OPEN","url":"https://github.com/acme/renamed/pull/370"}'
: > "$T/spawned"
addmerged "365 fix/DS-393-own 2026-10-31T10:57:00Z"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-796 a requeued ticket whose spawn kept its merged and open PRs is not shipped on its own merged one" \
  'spawned DS-391 && [ "$(field DS-391 state)" != "\"done\"" ] && ! grep -q "DS-391: PR #361" <<< "$out"'
check "DS-796 a kept other-repo PR is still judged that repo's after the spawn: #365 here shipped it" \
  '[ "$(got DS-393 .state)" = done ] && [ "$(got DS-393 .result.pr)" = 365 ] && ! spawned DS-393'

# A failed GitHub read spawns as before.
q add DS-380 Bug A; q set DS-380 state=triaged branch=fix/DS-380-x added_at=2026-10-31T10:00:00Z
printf '#!/bin/sh\necho "gh: HTTP 502" >&2; exit 1\n' > "$T/stub/gh"
for k in DS-40 DS-372 DS-374 DS-377 DS-378 DS-388 DS-389 DS-390 DS-391; do q set "$k" state=done; done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-404 a merged-PR search that fails spawns as before" '[ "$(field DS-380 state)" = "\"running\"" ] && spawned DS-380'

echo "shipped elsewhere: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
