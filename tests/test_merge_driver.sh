#!/usr/bin/env bash
# suite: merge driver one loop at a time (offline, fake gh)
# The real merge-driver.sh and gate.mjs, run with MERGE_DRIVER_ONE_LOOP=1 against a fake gh that keeps
# its PRs in a JSON file: `pr merge` flips one to merged, so the next loop and release_chain see it.
# The fake sleep records the call and stops the driver, so a loop that sleeps cannot hang the suite.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
NODE="$(node -p process.execPath)"
T="$(mktemp -d)"; T="$(cd "$T" && pwd -P)"
mkdir -p "$T/home" "$T/state" "$T/stub"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_BIN DESK_QUEUE DESK_SKILLS_DIR DESK_MEMORY_DIR DESK_GH_REPO DESK_CONFIG_ROOT DESK_ENV_MJS DESK_ENV_DIR \
  DESK_GITHUB_HANDLE DESK_JIRA_NAME MERGE_DRIVER_RELEASE_ONLY MERGE_DRIVER_ONE_LOOP MERGE_DRIVER_GREEN_SECS GH_TOKEN GITHUB_TOKEN
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
trap 'rm -rf "$T"' EXIT

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 1. Who you are
| Field | Value |
|---|---|
| GitHub handle | \`tester\` |
| Name | \`Tester\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-merge\` | Merge batch PRs | \`no\` | \`yes\` |
| \`pr-merge-green\` | Merge on green | \`no\` | \`yes\` |
| \`ci-rerun\` | Rerun CI | \`yes\` | \`no\` |
| \`pr-ready\` | Undraft | \`yes\` | \`yes\` |

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`T-[0-9]+\` |
| Merge method | \`squash\` |
| Required checks | \`test\` |
| Merge holds | \`none\` |
EOF

# The fake gh. PRs live in prs.json: { "<n>": { head, base, sha, state, draft, checks: [[name, conclusion]] } }.
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const F = '$T/prs.json';
const a = process.argv.slice(2);
const at = (flag) => a[a.indexOf(flag) + 1];
fs.appendFileSync('$T/gh.log', a.join(' ') + '\n');
const prs = JSON.parse(fs.readFileSync(F, 'utf8'));
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x));
if (a[0] === 'pr' && a[1] === 'list') {
  out(Object.entries(prs).filter(([, p]) => p.state === at('--state') && p.base === at('--base'))
    .map(([n, p]) => ({ number: Number(n), title: 't', headRefName: p.head, baseRefName: p.base, isDraft: p.draft })));
} else if (a[0] === 'pr' && a[1] === 'view' && at('--json') === 'state') {
  out(String(prs[a[2]]?.state ?? '').toUpperCase());
} else if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs[a[2]];
  out({ number: Number(a[2]), headRefOid: p.sha, headRefName: p.head, baseRefName: p.base, isDraft: p.draft,
    mergeStateStatus: 'CLEAN', reviewDecision: '', autoMergeRequest: null,
    statusCheckRollup: p.checks.map(([name, conclusion]) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, workflowName: 'ci' })) });
} else if (a[0] === 'run' && a[1] === 'list') {
  out([]);
} else if (a[0] === 'api' && a.includes('graphql')) {
  out('NONE 0');
} else if (a[0] === 'api') {
  out('src/a.txt');
} else if (a[0] === 'pr' && a[1] === 'ready') {
  prs[a[2]].draft = false;
  fs.writeFileSync(F, JSON.stringify(prs));
} else if (a[0] === 'pr' && a[1] === 'merge') {
  const p = prs[a[2]];
  if (!p || p.state !== 'open' || at('--match-head-commit') !== p.sha) { console.error('merge refused'); process.exit(1); }
  p.state = 'merged';
  fs.writeFileSync(F, JSON.stringify(prs));
  fs.appendFileSync('$T/merges.log', a[2] + ' ' + p.base + ' ' + at('--match-head-commit') + '\n');
} else {
  console.error('fake gh: unhandled ' + a.join(' ')); process.exit(1);
}
EOF
cat > "$T/stub/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_SLEEPS"
kill -TERM "$PPID"
EOF
# pass.mjs runs beside the driver: the fake registry has no live session.
printf '#!/bin/sh\necho "[]"\n' > "$T/stub/claude"
chmod +x "$T/stub/gh" "$T/stub/sleep" "$T/stub/claude"

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" FAKE_SLEEPS="$T/sleeps"
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
qf(){ jq -r --arg k "$1" ".tickets[\$k]$2" "$DESK_QUEUE"; }
loop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2 T-4 T-5" 2>&1); rc=$?; }
# One orchestrator pass, its verdict as JSON on stdout.
pj(){ out=$(AUTOPILOT_MIN_AVAIL_GB=0 node "$B/pass.mjs" --json 2>/dev/null); rc=$?; }
js(){ printf '%s' "$out" | jq -r "$1" 2>/dev/null; }
merged(){ cut -d' ' -f1 "$T/merges.log" 2>/dev/null | paste -sd' ' -; }
SHA1=1111111111111111111111111111111111111111; SHA2=2222222222222222222222222222222222222222
SHA4=4444444444444444444444444444444444444444; SHA5=5555555555555555555555555555555555555555
cat > "$T/prs.json" <<EOF
{
  "101": { "head": "fix/T-1", "base": "main",    "sha": "$SHA1", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "102": { "head": "fix/T-2", "base": "main",    "sha": "$SHA2", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "104": { "head": "fix/T-4", "base": "main",    "sha": "$SHA4", "state": "open", "draft": false, "checks": [["test", "SUCCESS"], ["lint", "FAILURE"]] },
  "105": { "head": "fix/T-5", "base": "release", "sha": "$SHA5", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
q init merge-driver
for k in T-1 T-2 T-3 T-4 T-5; do q add "$k" Task A; q set "$k" "branch=fix/$k"; done
for k in T-1 T-2 T-4 T-5; do q set "$k" state=done "result.pr=10${k#T-}"; done
q set T-3 state=triaged; q hold T-3 T-1
q set T-1 spawned_at=2026-01-01T00:00:00.000Z

# ---- loop 1: every PR is evaluated, nothing merges yet ------------------------------------------
loop
check "AC1: one loop exits 0 instead of sleeping"                   '[ $rc -eq 0 ] && [ ! -e "$T/sleeps" ] && echo "$out" | grep -q "merge driver up"'
check "AC5: the driver targets the default branch with no batch base" 'echo "$out" | grep -q "base=main"'
check "AC2: a first green loop records the heads and merges nothing" '[ -z "$(merged)" ] && echo "$out" | grep -q "#101 green at 111111111" && echo "$out" | grep -q "#102 green at 222222222"'
check "AC3: the red PR is not merged and the log names its failing check" 'echo "$out" | grep -q "#104 red at 444444444: \"lint\" failure"'
check "AC4: the held ticket stays held while its blocker is open"   '[ "$(qf T-3 .state)" = parked ]'
pj
check "pass: held behind an open PR, nothing else left, exits 10"  '[ $rc -eq 10 ] && [ "$(js .status)" = nothing_yet ] && [ "$(js "[.release_due, .stuck] | flatten | length")" = 0 ]'

# ---- loop 2: the first green PR merges, pinned, and its held ticket is released -----------------
loop
check "AC1: the second loop also exits without sleeping"            '[ $rc -eq 0 ] && [ ! -e "$T/sleeps" ]'
check "AC2: one merge in the loop, the first PR, pinned to its head" '[ "$(merged)" = 101 ] && grep -qx "101 main $SHA1" "$T/merges.log" && grep -q -- "--match-head-commit $SHA1" "$T/gh.log"'
check "AC4: the held ticket is released to triaged"                  '[ "$(qf T-3 .state)" = triaged ] && [ "$(qf T-3 .held_by)" = null ] && echo "$out" | grep -q "RELEASED T-3"'
check "AC4: the released ticket is at the front of the queue"        '[ "$(jq -r ".tickets | keys_unsorted | .[0]" "$DESK_QUEUE")" = T-3 ]'
check "the merge is recorded on the ticket and in the eta history"   '[ "$(qf T-1 .merged_at)" != null ] && [ "$(jq -r .key "$T/state/eta-history.jsonl")" = T-1 ] && [ "$(jq -r .merged_at "$T/state/eta-history.jsonl")" = "$(qf T-1 .merged_at)" ]'

# ---- loop 3: the second green PR merges ---------------------------------------------------------
loop
check "AC2: both green PRs merged within three loops, one per loop" '[ "$(merged)" = "101 102" ] && grep -qx "102 main $SHA2" "$T/merges.log"'
check "a merged ticket with no spawn record gets its merge time and no history line" '[ "$(qf T-2 .merged_at)" != null ] && [ "$(wc -l < "$T/state/eta-history.jsonl" | tr -d " ")" = 1 ] && echo "$out" | grep -q "no spawn record: T-2"'

# ---- pass.mjs: a release due with no driver running is the person's; the next loop releases it -----
q set T-3 state=done
q add T-6 Task A; q set T-6 state=triaged branch=fix/T-6; q hold T-6 T-2
pj
check "pass: every blocker merged and no driver running exits 11, release due" '[ $rc -eq 11 ] && [ "$(js .notify)" = true ] && [ "$(js ".release_due | join(\",\")")" = T-6 ] && js ".waiting[]" | grep -q "^T-6: RELEASE DUE"'

loop
check "the driver releases the ticket pass.mjs reported due"         '[ "$(qf T-6 .state)" = triaged ] && echo "$out" | grep -q "RELEASED T-6"'
check "AC3: the red PR is never merged"                              '! grep -q "^104 " "$T/merges.log" && echo "$out" | grep -q "#104 red"'
check "AC5: every merge went into the default branch"                '[ "$(cut -d" " -f2 "$T/merges.log" | sort -u)" = main ]'
check "AC5: a PR on another base is never the batch'\''s"            '! grep -q "^105 " "$T/merges.log" && ! echo "$out" | grep -q "#105"'

# ---- a feature spine: only an approved spine releases, and approved it merges like any other ------
SHA7=7777777777777777777777777777777777777777
jq --arg s "$SHA7" '. + { "107": { head: "fix/T-7", base: "main", sha: $s, state: "merged", draft: true, checks: [["test", "SUCCESS"]] } }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
q add T-7 Task A; q set T-7 branch=fix/T-7 state=done result.pr=107 'spine_check={"ok":true,"problems":[]}'
q park T-7 "spine awaiting approval: PR #107"
q add T-8 Task A; q set T-8 state=triaged branch=fix/T-8; q hold T-8 T-7
q set-batch feature=true spine=T-7
loop
check "a spine PR merged without approval releases nothing"          '[ "$(qf T-8 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-8"'
jq '."107".state = "open"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
loop
check "the spine's draft PR is not merged before approval"           '! grep -q "^107 " "$T/merges.log" && echo "$out" | grep -q "draft (still reviewing): #107"'
out=$(node "$B/queue.mjs" approve T-7 2>&1); rc=$?
check "approve undrafts the spine PR and hands it to the merge driver, exit 0" '[ $rc -eq 0 ] && [ "$(qf T-7 .state)" = done ] && [ "$(jq -r ".\"107\".draft" "$T/prs.json")" = false ] && echo "$out" | grep -q "the merge driver merges PR #107 once it is green; T-8 is released once it merges"'
loop; loop
check "the approved spine merges, pinned, and its child is released" 'grep -qx "107 main $SHA7" "$T/merges.log" && [ "$(qf T-8 .state)" = triaged ] && echo "$out" | grep -q "RELEASED T-8"'

# ---- one loop with nothing ready, and one whose PR list fails -----------------------------------
echo '{}' > "$T/prs.json"
loop
check "AC1: a loop with no ready PRs exits 0 without sleeping"       '[ $rc -eq 0 ] && [ ! -e "$T/sleeps" ] && echo "$out" | grep -q "no ready batch PRs"'
echo 'not json' > "$T/prs.json"
loop
check "AC1: a loop that cannot list PRs exits 1 without sleeping"    '[ $rc -eq 1 ] && [ ! -e "$T/sleeps" ] && echo "$out" | grep -q "could not list PRs"'

# ---- --log: the driver appends its own output, so it is started with no shell redirect -----------
echo '{}' > "$T/prs.json"
echo "earlier run" > "$T/state/merge-driver.log"
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1" --log 2>&1); rc=$?
check "--log: nothing on the terminal, the loop appended to <state>/merge-driver.log" '[ $rc -eq 0 ] && [ -z "$out" ] && [ "$(head -n 1 "$T/state/merge-driver.log")" = "earlier run" ] && grep -q "merge driver up" "$T/state/merge-driver.log" && grep -q "no ready batch PRs" "$T/state/merge-driver.log"'
out=$(bash "$B/merge-driver.sh" --tickets "T-1" --log "$T/elsewhere.log" 2>&1); rc=$?
check "--log takes no path: one is a usage error on the terminal, and nothing is written there" '[ $rc -eq 2 ] && echo "$out" | grep -q "\[--log\]" && [ ! -e "$T/elsewhere.log" ]'

echo "merge driver: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
