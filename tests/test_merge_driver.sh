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
// gh.signedout: what gh says, and its exit code, signed out; gh.broken: any other failure.
if (fs.existsSync('$T/gh.signedout')) { console.error('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4); }
if (fs.existsSync('$T/gh.broken')) { console.error('error connecting to api.github.com'); process.exit(1); }
const prs = JSON.parse(fs.readFileSync(F, 'utf8'));
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x));
if (a[0] === 'pr' && a[1] === 'list') {
  out(Object.entries(prs).filter(([, p]) => p.state === at('--state') && (!a.includes('--base') || p.base === at('--base')))
    .map(([n, p]) => ({ number: Number(n), title: 't', headRefName: p.head, baseRefName: p.base, isDraft: p.draft })));
} else if (a[0] === 'pr' && a[1] === 'view' && at('--json') === 'state') {
  out(String(prs[a[2]]?.state ?? '').toUpperCase());
} else if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs[a[2]];
  out({ number: Number(a[2]), headRefOid: p.sha, headRefName: p.head, baseRefName: p.base, isDraft: p.draft,
    state: p.state.toUpperCase(), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: (p.feedback ?? '').split(' ')[0], autoMergeRequest: null,
    statusCheckRollup: p.checks.map(([name, conclusion, run]) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, workflowName: 'ci',
      detailsUrl: run ? 'https://github.com/acme/widgets/actions/runs/' + run + '/job/1' : undefined })) });
} else if (a[0] === 'run' && a[1] === 'list') {
  out([]);
} else if (a[0] === 'run' && a[1] === 'rerun') {
  // recorded in gh.log above; run 9116 is one GitHub refuses to rerun
  if (a[2] === '9116') { console.error('run 9116 cannot be rerun'); process.exit(1); }
} else if (a[0] === 'api' && a.includes('graphql')) {
  // A PR's review decision and unresolved threads, as the driver's --jq gives them.
  out(prs[(a.find((x) => x.startsWith('n=')) ?? '').slice(2)]?.feedback ?? 'NONE 0');
} else if (a[0] === 'api') {
  const n = /pulls\/(\d+)\/files/.exec(a.join(' '))?.[1];
  out(((n && prs[n]?.files) || ['src/a.txt']).join('\n'));
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
pj(){ out=$(AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off node "$B/pass.mjs" --json 2>/dev/null); rc=$?; }
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

q set T-6 open_questions=1
loop
check "the driver releases the ticket pass.mjs reported due"         '[ "$(qf T-6 .state)" = triaged ] && echo "$out" | grep -q "RELEASED T-6"'
check "DS-189 AC3: the release line says a question is still open and it will not spawn" 'echo "$out" | grep "RELEASED T-6" | grep -q "still has 1 question(s) open and will not spawn until they are answered: answer with answer.mjs T-6"'
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
check "AC1: a loop with no ready PRs exits 0 without sleeping"       '[ $rc -eq 0 ] && [ ! -e "$T/sleeps" ] && echo "$out" | grep -q "no ready batch PRs$"'
cat > "$T/prs.json" <<EOF
{
  "131": { "head": "fix/T-1", "base": "release", "sha": "$SHA1", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "132": { "head": "fix/T-2", "base": "release", "sha": "$SHA2", "state": "open", "draft": true,  "checks": [["test", "SUCCESS"]] },
  "133": { "head": "fix/other", "base": "release", "sha": "$SHA4", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
loop
check "DS-313 AC2: batch PRs open on another base are named with their base, not just 'no ready'" '[ $rc -eq 0 ] && echo "$out" | grep -q "no ready batch PRs on main, the only base this driver watches; batch PRs open on another base: #131 (T-1) on release, #132 (T-2) on release$"'
check "DS-313 AC2: a PR that is not the batch'\''s is not named, and nothing merges" '! echo "$out" | grep -q "#133" && ! grep -qE "^13[123] " "$T/merges.log"'
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

# ---- DS-141: the written waiver for §4 Known flaky checks -----------------------------------------
# A config that reruns, files tickets in Jira, and names `e2e` (and the required `test`) as flaky.
sed -e 's/| `ci-rerun` | Rerun CI | `yes` | `no` |/| `ci-rerun` | Rerun CI | `yes` | `yes` |/' -e 's/| Tracker | `none` |/| Tracker | `jira` |/' "$T/config.md" \
  | awk '{ print } /^\| `pr-ready`/ { print "| `jira-create` | File tickets | `yes` | `yes` |" }' > "$T/config-flaky.md"
cp "$T/config-flaky.md" "$T/config-bad.md"
echo '| Known flaky checks | `e2e: e2e/** playwright.config.ts` `test: src/**` `smoke: smoke/**` |' >> "$T/config-flaky.md"
echo '| Known flaky checks | `e2e: e2e/**` `lint` |' >> "$T/config-bad.md"
cat > "$T/stub/desk-jira" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$T/jira.log"; cp "\$4" "$T/jira-body.md"; echo "created DS-999  https://example.atlassian.net/browse/DS-999"
EOF
chmod +x "$T/stub/desk-jira"
SHA11=a111111111111111111111111111111111111111; SHA12=a222222222222222222222222222222222222222
SHA13=a333333333333333333333333333333333333333; SHA14=a444444444444444444444444444444444444444
SHA15=a555555555555555555555555555555555555555; SHA16=a666666666666666666666666666666666666666
SHA17=a777777777777777777777777777777777777777
cat > "$T/prs.json" <<EOF
{
  "111": { "head": "fix/T-11", "base": "main", "sha": "$SHA11", "state": "open", "draft": false, "files": ["src/x.ts"],
           "checks": [["test", "SUCCESS", 9001], ["e2e", "FAILURE", 9111]] },
  "112": { "head": "fix/T-12", "base": "main", "sha": "$SHA12", "state": "open", "draft": false, "files": ["src/y.ts", "e2e/login.spec.ts"],
           "checks": [["test", "SUCCESS", 9002], ["e2e", "FAILURE", 9112]] },
  "113": { "head": "fix/T-13", "base": "main", "sha": "$SHA13", "state": "open", "draft": false, "files": ["docs/readme.md"],
           "checks": [["test", "FAILURE", 9113], ["e2e", "SUCCESS", 9003]] },
  "114": { "head": "fix/T-14", "base": "main", "sha": "$SHA14", "state": "open", "draft": false, "files": ["src/z.ts"],
           "checks": [["test", "SUCCESS", 9004], ["lint", "FAILURE", 9114]] },
  "115": { "head": "fix/T-15", "base": "main", "sha": "$SHA15", "state": "open", "draft": false, "files": ["src/w.ts"],
           "checks": [["test", "SUCCESS", 9005], ["e2e", "FAILURE", 9115]] },
  "116": { "head": "fix/T-16", "base": "main", "sha": "$SHA16", "state": "open", "draft": false, "files": ["src/v.ts"],
           "checks": [["test", "SUCCESS", 9006], ["e2e", "FAILURE", 9116]] },
  "117": { "head": "fix/T-17", "base": "main", "sha": "$SHA17", "state": "open", "draft": false, "files": ["src/u.ts"],
           "checks": [["test", "SUCCESS", 9007], ["smoke", "FAILURE", 9117], ["e2e", "FAILURE", 9116]] }
}
EOF
for k in T-11 T-12 T-13 T-14 T-15 T-16 T-17; do q add "$k" Task A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
SD="$T/state/merge-driver"; mkdir -p "$SD"
# The driver's two reruns already spent and accepted at these heads (12 minutes apart for real).
for f in reruns reruns-ok; do
  printf 'e2e\ne2e\n' > "$SD/$f-111-$SHA11"; printf 'e2e\ne2e\n' > "$SD/$f-112-$SHA12"
  printf 'test\ntest\n' > "$SD/$f-113-$SHA13"; printf 'lint\nlint\n' > "$SD/$f-114-$SHA14"
  printf 'e2e\n' > "$SD/$f-115-$SHA15"
done
printf 'e2e\n' > "$SD/reruns-116-$SHA16"   # one rerun tried and refused: none accepted
: > "$T/merges.log"
DESK_CONFIG="$T/config-flaky.md" loop
check "AC4: the driver starts with the flaky row read"                 '[ $rc -eq 0 ] && echo "$out" | grep -q "flaky=\[e2e,test,smoke\]"'
check "AC4: a waivable head is held a loop like a green one, not merged yet" '[ -z "$(merged)" ] && echo "$out" | grep -q "#111 green but for WAIVED \"e2e\" at a11111111 — confirming on the next loop"'
check "AC6: a diff touching the check'\''s paths is not waived, and says so" 'echo "$out" | grep -q "#112 the waiver for \"e2e\" does not apply: the diff touches e2e/login.spec.ts (e2e/\*\*, for \"e2e\")"'
check "AC7: a required check is never waived, and the PR is reported"   'echo "$out" | grep -q "#113 \"test\" is in §4 Known flaky checks but is a §4 Required check" && [ "$(qf T-13 .merge_blocked)" != null ]'
check "AC8: an unlisted red check waives nothing and reads red as today" 'echo "$out" | grep -q "#114 red at a44444444: \"lint\" failure" && ! echo "$out" | grep -q "#114.*waive"'
check "AC4: one rerun is not enough to waive"                          'echo "$out" | grep -q "#115 \"e2e\" is a known flaky check: waived only once still red after 2 accepted reruns at a55555555 (1 so far)"'
check "AC4: a refused rerun counts toward the cap but never toward the waiver" 'echo "$out" | grep -q "#116 \"e2e\" is a known flaky check: waived only once still red after 2 accepted reruns at a66666666 (0 so far)" && echo "$out" | grep -q "#116 rerun of 9116 refused" && [ "$(wc -l < "$SD/reruns-116-$SHA16" | tr -d " ")" = 2 ] && [ ! -e "$SD/reruns-ok-116-$SHA16" ]'
check "AC4: an accepted rerun counts toward the waiver"                '[ "$(wc -l < "$SD/reruns-ok-115-$SHA15" | tr -d " ")" = 2 ]'
check "AC4: an accepted run credits only its own checks, not one whose run was refused" '[ "$(cat "$SD/reruns-ok-117-$SHA17")" = smoke ] && [ "$(wc -l < "$SD/reruns-117-$SHA17" | tr -d " ")" = 2 ]'
DESK_CONFIG="$T/config-flaky.md" loop
check "AC4: the waived PR merges pinned to its head and logs WAIVED"   '[ "$(merged)" = 111 ] && grep -qx "111 main $SHA11" "$T/merges.log" && echo "$out" | grep -q "#111 WAIVED \"e2e\" at a11111111"'
check "AC5: a ticket is filed naming the check, PR, head SHA and failing run" 'grep -q "^create Bug Flaky check \"e2e\" waived to merge PR #111 " "$T/jira.log" && grep -q "\`e2e\`" "$T/jira-body.md" && grep -q "https://github.com/acme/widgets/pull/111" "$T/jira-body.md" && grep -q "$SHA11" "$T/jira-body.md" && grep -q "https://github.com/acme/widgets/actions/runs/9111" "$T/jira-body.md" && echo "$out" | grep -q "#111 WAIVED: filed DS-999"'
# A third loop reaches every other PR with #111 gone: none of them may merge.
DESK_CONFIG="$T/config-flaky.md" loop
check "AC4: two accepted reruns still wait out the last one's cooldown" 'echo "$out" | grep -q "#115 \"e2e\" is a known flaky check: waiting out the last rerun'\''s cooldown"'
check "AC6-8: nothing else merged once the others were all tried"      '[ "$(merged)" = 111 ] && echo "$out" | grep -q "#116 "'
# The same PR and head merging again (reopened) files no second ticket.
jq '."111".state = "open"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
DESK_CONFIG="$T/config-flaky.md" loop; DESK_CONFIG="$T/config-flaky.md" loop
check "AC5: the ticket is filed once per PR and head"                  '[ "$(merged)" = "111 111" ] && [ "$(wc -l < "$T/jira.log" | tr -d " ")" = 1 ]'

out=$(DESK_CONFIG="$T/config-bad.md" MERGE_DRIVER_ONE_LOOP=1 bash "$B/merge-driver.sh" --tickets "T-11" 2>&1); rc=$?
check "AC9: a row that does not parse stops the driver, naming the row" '[ $rc -eq 1 ] && echo "$out" | grep -q "FAIL: config §4 Known flaky checks does not parse: \`lint\`" && ! echo "$out" | grep -q "merge driver up"'

# ---- DS-225 AC2: gh signed out stops the driver, saying so -------------------------------------
: > "$FAKE_SLEEPS"; touch "$T/gh.signedout"
loop; rm -f "$T/gh.signedout"
check "DS-225 AC2: a signed-out gh is logged as signed out and the driver exits non-zero" '[ $rc -eq 1 ] && echo "$out" | grep -q "FAIL: gh is signed out (To get started with GitHub CLI, please run:  gh auth login)" && echo "$out" | tail -1 | grep -q "merge driver exited 1$"'
check "DS-225 AC2: the refused list is not read as empty, and the driver does not wait to retry" '! echo "$out" | grep -q "no ready batch PRs" && [ ! -s "$FAKE_SLEEPS" ]'
touch "$T/gh.broken"; loop; rm -f "$T/gh.broken"
check "DS-225 AC2: any other gh failure is retried as before" '! echo "$out" | grep -q "signed out" && echo "$out" | grep -q "could not list PRs" && [ $rc -eq 1 ]'

# ---- DS-203: merging asked once per batch at Stage 3, where §3 says ask --------------------------
sed -e 's/| `autopilot-merge` | Merge batch PRs | `no` | `yes` |/| `autopilot-merge` | Merge batch PRs | `no` | `ask` |/' \
  -e 's/| `pr-merge-green` | Merge on green | `no` | `yes` |/| `pr-merge-green` | Merge on green | `no` | `ask` |/' "$T/config.md" > "$T/config-ask.md"
sed -e 's/| `autopilot-merge` | Merge batch PRs | `no` | `yes` |/| `autopilot-merge` | Merge batch PRs | `no` | `no` |/' \
  -e 's/| `pr-merge-green` | Merge on green | `no` | `yes` |/| `pr-merge-green` | Merge on green | `no` | `ask` |/' "$T/config.md" > "$T/config-no.md"
SHA21=b111111111111111111111111111111111111111; SHA22=b222222222222222222222222222222222222222; SHA23=b333333333333333333333333333333333333333
cat > "$T/prs.json" <<EOF
{
  "121": { "head": "fix/T-21", "base": "main", "sha": "$SHA21", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "122": { "head": "fix/T-22", "base": "main", "sha": "$SHA22", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]], "feedback": "CHANGES_REQUESTED 0" },
  "123": { "head": "fix/T-23", "base": "main", "sha": "$SHA23", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]], "feedback": "APPROVED 1" }
}
EOF
q init merge-ask
for k in T-21 T-22 T-23; do q add "$k" Task A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; rm -f "$T/state/batch-notes.md"
mloop(){ out=$(DESK_CONFIG="$1" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-21 T-22 T-23" 2>&1); rc=$?; }
mpj(){ out=$(DESK_CONFIG="$1" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off node "$B/pass.mjs" --json 2>/dev/null); rc=$?; }
ASKED='config §3 autopilot-merge is "ask" and pr-merge-green is "ask"'

mloop "$T/config-ask.md"
check "DS-203: with merging at ask and never asked, the driver refuses to start" '[ $rc -eq 1 ] && echo "$out" | grep -qF "FAIL: $ASKED with no batch approval" && ! echo "$out" | grep -q "merge driver up"'
q set-batch approved.merge=false
mloop "$T/config-ask.md"
check "DS-203 AC3: declined at Stage 3, the driver refuses to start and merges nothing" '[ $rc -eq 1 ] && echo "$out" | grep -qF "FAIL: $ASKED, and merging was declined for this batch at Stage 3" && [ ! -s "$T/merges.log" ]'
mpj "$T/config-ask.md"
check "DS-203 AC3: declined, the pass reports a green PR as ready to merge" 'js ".waiting[]" | grep -qF "T-21: READY TO MERGE — PR #121 is out of draft and green, and no merge driver merges it ($ASKED, and merging was declined for this batch at Stage 3): merge it yourself once no review thread is left unresolved"'
check "DS-203 AC3: a green PR with changes requested is put as feedback to work, never as ready to merge" 'js ".waiting[]" | grep -qF "T-22: CHANGES REQUESTED — PR #122 is out of draft and green, but changes are requested on it" && ! js ".waiting[]" | grep -q "T-22: READY TO MERGE"'
js '{waiting: [.waiting[] | select(startswith("T-21: READY TO MERGE"))]}' > "$T/ready.json"
hand=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { deciderItems, presort } from '$B/decider.mjs';
const { hand } = presort(deciderItems(JSON.parse(readFileSync('$T/ready.json', 'utf8')), JSON.parse(readFileSync('$DESK_QUEUE', 'utf8'))));
console.log(hand.map((h) => h.item.ticket + ' ' + h.why).join('\n'));")
check "DS-203 AC8: under a supervisor that line goes to the check-in digest without a decider session" '[ "$hand" = "T-21 needs config §3 autopilot-merge, which is \"ask\"" ]'

q set-batch approved.merge=true
mloop "$T/config-no.md"
check "DS-203 AC4: a batch approval never outranks a §3 no" '[ $rc -eq 1 ] && echo "$out" | grep -qF "FAIL: config §3 autopilot-merge is \"no\"" && [ ! -s "$T/merges.log" ]'
out=$(DESK_CONFIG="$T/config-no.md" node "$B/desk-env.mjs" merge-grant); rc=$?
check "DS-203 AC4: at no nothing merges, and the reason names the row at no" '[ $rc -eq 1 ] && [ "$out" = "$(printf "none\tconfig §3 autopilot-merge is \"no\"")" ]'
mpj "$T/config-ask.md"
check "DS-203 AC2: approved, the pass leaves green PRs to the merge driver" '! js ".waiting[]" | grep -q "READY TO MERGE"'
mloop "$T/config-ask.md"
check "DS-203 AC2: approved at Stage 3, the driver starts though both rows are ask" '[ $rc -eq 0 ] && echo "$out" | grep -q "merge-by=batch" && echo "$out" | grep -q "#121 green at b11111111 — confirming"'
mloop "$T/config-ask.md"
check "DS-203 AC2: the green PR merges with no further question, pinned to its head" '[ "$(merged)" = 121 ] && grep -qx "121 main $SHA21" "$T/merges.log"'
check "DS-203 AC2: the merge is noted in batch-notes.md" 'grep -qxF -- "- [T-21] merged #121 at $SHA21: $ASKED, and merging was approved for this batch at Stage 3" "$T/state/batch-notes.md"'
mloop "$T/config-ask.md"
check "DS-203 AC5: changes requested or an unresolved thread still hold a PR under the approval" '[ "$(merged)" = 121 ] && echo "$out" | grep -q "#122 has outstanding review feedback (CHANGES_REQUESTED, 0 unresolved)" && echo "$out" | grep -q "#123 has outstanding review feedback (APPROVED, 1 unresolved)"'
q init merge-ask-2
q add T-21 Task A; q set T-21 branch=fix/T-21 state=done result.pr=121
jq '."121".state = "open"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
mloop "$T/config-ask.md"
check "DS-203 AC6: a new batch carries no approval, so it is asked again" '[ $rc -eq 1 ] && echo "$out" | grep -qF "with no batch approval" && [ "$(merged)" = 121 ]'

echo "merge driver: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
