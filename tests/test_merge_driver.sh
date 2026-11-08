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
git config --global user.email t@example.com; git config --global user.name t
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
// A shell command run once, so the queue changes mid-loop: gh.midloop at the review read, between a PR's
// gate and its merge; gh.atlist at the PR list, once the queue's tickets are read and before any gate.
const hook = a[0] === 'api' && a.includes('graphql') ? '$T/gh.midloop' : a[1] === 'list' ? '$T/gh.atlist' : null;
if (hook && fs.existsSync(hook)) {
  const c = fs.readFileSync(hook, 'utf8');
  fs.rmSync(hook);
  require('child_process').execSync(c, { stdio: 'ignore' });
}
const prs = JSON.parse(fs.readFileSync(F, 'utf8'));
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x));
if (a[0] === 'pr' && a[1] === 'list') {
  out(Object.entries(prs).filter(([, p]) => p.state === at('--state') && (!a.includes('--base') || p.base === at('--base'))
      && (!a.includes('--author') || (p.author ?? 'tester') === at('--author')))
    .map(([n, p]) => ({ number: Number(n), title: 't', headRefName: p.head, baseRefName: p.base, isDraft: p.draft })));
} else if (a[0] === 'pr' && a[1] === 'view' && at('--json') === 'state') {
  out(String(prs[a[2]]?.state ?? '').toUpperCase());
} else if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs[a[2]];
  out({ number: Number(a[2]), title: p.title ?? 't', headRefOid: p.sha, headRefName: p.head, baseRefName: p.base, isDraft: p.draft,
    state: p.state.toUpperCase(), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: (p.feedback ?? '').split(' ')[0], autoMergeRequest: null,
    statusCheckRollup: p.checks.map(([name, conclusion, run, job]) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, workflowName: 'ci',
      detailsUrl: run ? 'https://github.com/acme/widgets/actions/runs/' + run + '/job/' + (job ?? run) : undefined })) });
} else if (a[0] === 'api' && /check-runs\/\d+\/annotations/.test(a[1] ?? '')) {
  // A job's annotations: annotations.json maps a job id to the error its run gave.
  const id = /check-runs\/(\d+)/.exec(a[1])[1];
  const m = fs.existsSync('$T/annotations.json') ? JSON.parse(fs.readFileSync('$T/annotations.json', 'utf8'))[id] : null;
  out(m ? [{ annotation_level: 'failure', message: m }] : []);
} else if (a[0] === 'run' && a[1] === 'list') {
  out([]);
} else if (a[0] === 'run' && a[1] === 'rerun') {
  // recorded in gh.log above; run 9116 is one GitHub refuses to rerun
  if (a[2] === '9116') { console.error('run 9116 cannot be rerun'); process.exit(1); }
} else if (a[0] === 'api' && a.includes('graphql') && a.some((x) => x.includes('resolveReviewThread'))) {
  // Resolving a thread: recorded in resolved.log; an id with REFUSED in it is one GitHub refuses.
  const id = (a.find((x) => x.startsWith('id=')) ?? '').slice(3);
  if (id.includes('REFUSED')) { console.error('Resource not accessible by integration'); process.exit(1); }
  fs.appendFileSync('$T/resolved.log', id + '\n');
  out('true');
} else if (a[0] === 'api' && a.includes('graphql')) {
  // A PR's review decision, reviews and threads. "payload" is a recorded GraphQL response (its threads
  // plus "extra" ones), its ids prefixed with the PR number; "feedback" ("<decision> <n>") is n
  // threads someone else opened. A thread id in resolved.log reads as resolved.
  const n = (a.find((x) => x.startsWith('n=')) ?? '').slice(2), p = prs[n] ?? {};
  const done = new Set(fs.existsSync('$T/resolved.log') ? fs.readFileSync('$T/resolved.log', 'utf8').split('\n') : []);
  let pr;
  if (p.payload) {
    pr = JSON.parse(fs.readFileSync(p.payload, 'utf8')).data.repository.pullRequest;
    pr.reviewThreads.nodes.push(...(p.extra ?? []));
  } else {
    const [dec, count] = (p.feedback ?? 'NONE 0').split(' ');
    pr = { reviewDecision: dec === 'NONE' ? null : dec, reviews: { nodes: [] }, reviewThreads: { nodes: Array.from({ length: Number(count) }, (_, i) => ({
      id: 'T' + i, isResolved: false, path: 'src/a.txt', line: 1, comments: { nodes: [{ author: { login: 'someone' }, body: 'a comment', pullRequestReview: null }] } })) } };
  }
  pr.headRefOid = p.sha;
  for (const t of pr.reviewThreads.nodes) { t.id = n + '-' + t.id; if (done.has(t.id)) t.isResolved = true; }
  out({ data: { repository: { pullRequest: pr } } });
} else if (a[0] === 'api' && a.join(' ').includes('/contents/')) {
  // A file at a ref, from contents/<path>; one with no file there is GitHub's 404.
  const f = '$T/contents/' + decodeURIComponent(/contents\/([^?]+)/.exec(a.join(' '))[1]);
  if (!fs.existsSync(f)) { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  process.stdout.write(fs.readFileSync(f, 'utf8'));
} else if (a[0] === 'api') {
  const n = /pulls\/(\d+)\/files/.exec(a.join(' '))?.[1];
  out(((n && prs[n]?.files) || ['src/a.txt']).join('\n'));
} else if (a[0] === 'pr' && a[1] === 'comment') {
  // recorded in gh.log above
} else if (a[0] === 'issue' && a[1] === 'view') {
  // An issue's state: issues.json maps a number to OPEN or CLOSED; any other issue is open.
  const f = '$T/issues.json', is = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  out({ state: is[a[2]] ?? 'OPEN' });
} else if (a[0] === 'issue' && a[1] === 'close') {
  const f = '$T/issues.json', is = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  is[a[2]] = 'CLOSED'; fs.writeFileSync(f, JSON.stringify(is));
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

# ---- pass.mjs: a release due with no driver running is released by the pass, as the driver would ---
q set T-3 state=done
q add T-6 Task A; q set T-6 state=triaged branch=fix/T-6; q hold T-6 T-2
pj
check "DS-397 AC4: every blocker merged and no driver running, the pass releases it, not the person" '[ "$(qf T-6 .state)" = triaged ] && [ "$(qf T-6 .held_by)" = null ] && [ "$(js ".release_due | length")" = 0 ] && ! js ".waiting[]" | grep -q "RELEASE DUE" && js .message | grep -q "^released: T-6, every blocker merged (T-2) and no merge driver is running; "'
check "DS-397 AC4: and moves it to the front of the spawn order"   '[ "$(jq -r ".tickets | keys_unsorted | .[0]" "$DESK_QUEUE")" = T-6 ]'

q drop T-6
q add T-9 Task A; q set T-9 state=triaged branch=fix/T-9; q hold T-9 T-2; q set T-9 open_questions=1
loop
check "the driver releases a ticket whose every blocker merged"     '[ "$(qf T-9 .state)" = triaged ] && echo "$out" | grep -q "RELEASED T-9"'
check "DS-189 AC3: the release line says a question is still open and it will not spawn" 'echo "$out" | grep "RELEASED T-9" | grep -q "still has 1 question(s) open and will not spawn until they are answered: answer with answer.mjs T-9"'

# ---- a blocker whose PR is older than the merged listing: the queue's record of the merge counts ----
# gh lists the newest 100 merged PRs, so an old PR (a long-lived draft merged today) is missing from it;
# the fake gh here never lists T-11's PR at all. T-13's blocker has no recorded merge and stays held.
q add T-11 Task A; q set T-11 state=done branch=fix/T-11 pr_status.pr=426; q merged T-11 2026-11-02T02:20:59.000Z
q add T-12 Task A; q set T-12 state=triaged branch=fix/T-12; q hold T-12 T-11
q add T-14 Task A; q set T-14 state=done branch=fix/T-14
q add T-13 Task A; q set T-13 state=triaged branch=fix/T-13; q hold T-13 T-14
loop
check "a blocker GitHub does not list but the queue records as merged releases its successor" '[ "$(qf T-12 .state)" = triaged ] && [ "$(qf T-12 .held_by)" = null ] && echo "$out" | grep -q "merged: T-11#426 -> RELEASED T-12"'
check "a blocker with no recorded merge and no merged PR still holds its successor" '[ "$(qf T-13 .state)" = parked ] && ! echo "$out" | grep -q "RELEASED T-13"'
q drop T-11; q drop T-12; q drop T-13; q drop T-14
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
q set T-21 merge_after=OPS-9
mpj "$T/config-ask.md"
check "DS-407 AC1: with no merge driver, a green PR waiting on the person's step is held, never put to them to merge" 'js ".waiting[]" | grep -qF "T-21: MERGE HELD — PR #121 is out of draft and green, but it merges only after your step OPS-9 is Done in Jira: do not merge it yet" && ! js ".waiting[]" | grep -q "T-21: READY TO MERGE"'
q set T-21 merge_after=null

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

# ---- DS-336: a ticket whose last open PR the driver merges goes to §4 Done state -------------------
sed -e 's/| Tracker | `none` |/| Tracker | `jira` |/' "$T/config.md" \
  | awk '{ print } /^\| `pr-ready`/ { print "| `jira-close-own-merged` | Close own merged | `yes` | `yes` |"; print "| `gh-close-linked-issue` | Close linked issue | `yes` | `yes` |" } /^\| Tracker/ { print "| Done state | `Done` |"; print "| Jira project | `T` |" }' > "$T/config-close.md"
sed -e 's/| `jira-close-own-merged` | Close own merged | `yes` | `yes` |/| `jira-close-own-merged` | Close own merged | `yes` | `ask` |/' "$T/config-close.md" > "$T/config-noclose.md"
# The fake desk-jira: each ticket's status in jira-status/<key>, In Progress until a transition moves it;
# its web links in jira-links/<key> (none without one). A search finds no other ticket.
mkdir -p "$T/jira-status" "$T/jira-links"
cat > "$T/stub/desk-jira" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$T/jira-close.log"
f="$T/jira-status/\$2"
case "\$1" in
  get) st="In Progress"; [ -f "\$f" ] && st="\$(cat "\$f")"; jq -n --arg s "\$st" '{fields: {status: {name: \$s}}}' ;;
  transition) printf '%s' "\$3" > "\$f"; echo "\$2 -> \$3" ;;
  api) k="\${2#api/2/issue/}"
    case "\$k" in
      *'?fields=status') k="\${k%%\?*}"; st="In Progress"; [ -f "$T/jira-status/\$k" ] && st="\$(cat "$T/jira-status/\$k")"
        jq -n --arg k "\$k" --arg s "\$st" '{key: \$k, fields: {status: {name: \$s, statusCategory: {key: (if \$s == "Done" then "done" else "indeterminate" end)}}}}' ;;
      *) k="\${k%%/*}"; if [ -f "$T/jira-links/\$k" ]; then cat "$T/jira-links/\$k"; else echo '[]'; fi ;;
    esac ;;
  search) echo '{"issues": []}' ;;
  *) exit 1 ;;
esac
EOF
printf '[{"object": {"url": "https://github.com/acme/widgets/issues/7"}}, {"object": {"url": "https://github.com/other/repo/issues/8"}}]' > "$T/jira-links/T-31"
chmod +x "$T/stub/desk-jira"
SHA31=c111111111111111111111111111111111111111; SHA32=c222222222222222222222222222222222222222
SHA33=c333333333333333333333333333333333333333; SHA34=c444444444444444444444444444444444444444
cat > "$T/prs.json" <<EOF
{
  "131": { "head": "fix/T-31", "base": "main", "sha": "$SHA31", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "132": { "head": "fix/T-32", "base": "main", "sha": "$SHA32", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "133": { "head": "fix/T-32-more", "base": "release", "author": "colleague", "sha": "$SHA33", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
q init merge-close
for k in T-31 T-32 T-34; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
q add T-33 Bug A; q set T-33 state=done
: > "$T/merges.log"; : > "$T/jira-close.log"
cloop(){ out=$(DESK_CONFIG="$1" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-31" 2>&1); rc=$?; }
cloop "$T/config-close.md"; cloop "$T/config-close.md"
check "DS-336 AC1: the merged ticket is moved to Done and read back"  '[ "$(merged)" = 131 ] && grep -qx "transition T-31 Done" "$T/jira-close.log" && [ "$(cat "$T/jira-status/T-31")" = Done ] && echo "$out" | grep -q "#131 T-31 moved to Done (read back; §3 jira-close-own-merged)"'
check "DS-336 AC1: the status is read again after the transition"     '[ "$(grep -c "^get T-31 --json" "$T/jira-close.log")" = 2 ]'
check "DS-502 AC1: once Done, the issue the ticket links is closed naming it and its PR" 'grep -qxF "issue close 7 --repo acme/widgets --comment Closed by desk: every ticket filed for this issue is done: T-31 (#131)." "$T/gh.log" && echo "$out" | grep -qF "#131 T-31 acme/widgets#7 closed: "'
check "DS-502 AC4: the issue it links in another repo is not touched" '! grep -qE "issue (view|close) 8" "$T/gh.log"'
cloop "$T/config-close.md"
check "DS-336 AC2: another PR open on the key, by anyone and on any base, leaves the ticket as it is" '[ "$(merged)" = "131 132" ] && ! grep -q "transition T-32" "$T/jira-close.log" && echo "$out" | grep -q "#132 T-32 left as it is: #133 still open on the key"'
jq --arg s "$SHA34" '. + { "134": { head: "fix/T-34", base: "main", sha: $s, state: "open", draft: false, checks: [["test", "SUCCESS"]] } }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
cloop "$T/config-noclose.md"; cloop "$T/config-noclose.md"
check "DS-336 AC3: with jira-close-own-merged not yes, a merge moves nothing" '[ "$(merged)" = "131 132 134" ] && ! grep -q "T-34" "$T/jira-close.log" && echo "$out" | grep -q "#134 T-34 left as it is: config §3 jira-close-own-merged is ask"'
mpj "$T/config-close.md"
check "DS-336 AC4: a ticket done with no PR merged (a triage already-fixed) is never closed" '! grep -q "T-33" "$T/jira-close.log" && [ "$(grep -c "^transition" "$T/jira-close.log")" = 1 ]'

# ---- DS-347: a clean desk-review verdict at the head settles the desk-review threads before it -----
# The payloads are #282 and #271's real GraphQL responses (review-threads.mjs query): a round-4 P0
# thread, fixed, with clean verdicts since. They were recorded after the threads were resolved by
# hand on 2026-10-30, so this copy reads them unresolved, as they stood when the merges stuck.
sed -e 's/| GitHub handle | `tester` |/| GitHub handle | `bigbenjoman` |/' "$T/config.md" > "$T/config-threads.md"
echo '| Clean review verdict | `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0` |' >> "$T/config-threads.md"
FX="$T/fixtures"; H282=3cdbb0d2756940c6579c70f60fea68b36f8d19a7; H271=1088c7a85aa3ec1c8ed4ce97114412c4e57168bd
mkdir -p "$FX"
jq '.data.repository.pullRequest.reviewThreads.nodes[].isResolved = false' "$S/fixtures/review-threads-282.json" > "$FX/review-threads-282.json"
jq '.data.repository.pullRequest.reviewThreads.nodes[].isResolved = false' "$S/fixtures/review-threads-271.json" > "$FX/review-threads-271.json"
SHA43=d333333333333333333333333333333333333333
cat > "$T/prs.json" <<EOF
{
  "141": { "head": "fix/T-41", "base": "main", "author": "bigbenjoman", "sha": "$H282", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]],
           "payload": "$FX/review-threads-282.json" },
  "142": { "head": "fix/T-42", "base": "main", "author": "bigbenjoman", "sha": "$H271", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]],
           "payload": "$FX/review-threads-271.json",
           "extra": [{ "id": "human", "isResolved": false, "isOutdated": false, "path": "desk/bin/pass.mjs", "line": 970,
                       "comments": { "nodes": [{ "author": { "login": "colleague" }, "body": "Why does this hold not show in desk-q?\nIt reads as merging.", "pullRequestReview": { "id": "PRR_colleague" } }] } }] },
  "143": { "head": "fix/T-43", "base": "main", "author": "bigbenjoman", "sha": "$SHA43", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]],
           "payload": "$FX/review-threads-282.json" }
}
EOF
q init merge-threads
for k in T-41 T-42 T-43; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; : > "$T/gh.log"; rm -f "$T/resolved.log"
tloop(){ out=$(DESK_CONFIG="$T/config-threads.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-41 T-42 T-43" 2>&1); rc=$?; }
tloop
check "DS-347 AC1: #282's fixed P0 thread is resolved once the clean verdict is at its head" 'grep -qx "141-PRRT_kwDOUtzuUs6xubre" "$T/resolved.log" && echo "$out" | grep -qF "#141 resolved desk-review thread desk/bin/desk-q.mjs:1227 \"**P0** This reads the raw cache." && echo "$out" | grep -q "settles it$"'
check "DS-347 AC1: with it resolved, the driver counts nothing unresolved and holds #282 as green" '! echo "$out" | grep -q "#141 has outstanding review feedback" && echo "$out" | grep -q "#141 green at 3cdbb0d27 — confirming"'
check "DS-347 AC1: #271's outdated P0 thread is resolved too"         'grep -qx "142-PRRT_kwDOUtzuUs6xoZmC" "$T/resolved.log" && echo "$out" | grep -qF "#142 resolved desk-review thread desk/bin/pass.mjs:968"'
check "DS-347 AC2: a thread a colleague opened stays unresolved and still holds the PR" '! grep -q "142-human" "$T/resolved.log" && echo "$out" | grep -q "#142 has outstanding review feedback (NONE, 1 unresolved)"'
check "DS-347: a clean verdict for an older head settles nothing"     '! grep -q "^143-" "$T/resolved.log" && echo "$out" | grep -q "#143 has outstanding review feedback (NONE, 1 unresolved)"'
check "DS-347 AC3: one refusal is not yet the person'\''s"            '[ "$(qf T-42 .merge_blocked)" = null ]'
tloop
check "DS-347 AC1: #282 merges, and its thread is not resolved twice" '[ "$(merged)" = 141 ] && [ "$(grep -c "resolveReviewThread" "$T/gh.log")" = 2 ]'
tloop
check "DS-347 AC3: refused on two loops while green, the PR is recorded for the person with the thread" '[ "$(qf T-42 .merge_blocked)" = "review feedback: 1 unresolved thread on a green PR, first desk/bin/pass.mjs:970 \"Why does this hold not show in desk-q?\"" ]'
echo "142-human" >> "$T/resolved.log"
tloop
check "DS-347 AC3: once the thread is resolved, the record is cleared and the PR goes on to merge" '[ "$(qf T-42 .merge_blocked)" = null ] && echo "$out" | grep -q "#142 green at 1088c7a85 — confirming"'
# A thread GitHub refuses to resolve still holds the PR, and says so.
jq '."143".sha = "'"$H282"'" | ."143".extra = [{ id: "REFUSED", isResolved: false, path: "src/b.ts", line: 2, comments: { nodes: [{ author: { login: "bigbenjoman" }, body: "**P1**: x", pullRequestReview: { id: "PRR_kwDOUtzuUs8AAAABU_uh9Q" } }] } }]' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
tloop; tloop   # the first merges #142, so only the second reaches #143
check "DS-347: a thread GitHub refuses to resolve still holds the PR"  'echo "$out" | grep -qF "#143 could not resolve desk-review thread src/b.ts:2" && echo "$out" | grep -q "#143 has outstanding review feedback (NONE, 1 unresolved)"'

# ---- DS-377: a §4 Merge holds path holds a PR into the default branch, never one into a feature base --
sed -e 's/| Merge holds | `none` |/| Merge holds | `infra\/**: deploys the infrastructure on merge` |/' "$T/config.md" > "$T/config-holds.md"
SHA51=e111111111111111111111111111111111111111; SHA52=e222222222222222222222222222222222222222
cat > "$T/prs.json" <<EOF
{
  "151": { "head": "fix/T-51", "base": "feat/epics", "sha": "$SHA51", "state": "open", "draft": false, "files": ["infra/main.tf"], "checks": [["test", "SUCCESS"]] },
  "152": { "head": "fix/T-52", "base": "main", "sha": "$SHA52", "state": "open", "draft": false, "files": ["infra/main.tf", "src/a.ts"], "checks": [["test", "SUCCESS"]] }
}
EOF
hloop(){ out=$(DESK_CONFIG="$T/config-holds.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$1" 2>&1); rc=$?; }
# set-batch asks origin for the base, and this repo has none, so the base is written as set-batch would.
q init merge-holds-feature; jq '.base = "feat/epics"' "$DESK_QUEUE" > "$T/q.tmp" && mv "$T/q.tmp" "$DESK_QUEUE"
q add T-51 Bug A; q set T-51 branch=fix/T-51 state=done result.pr=151
: > "$T/merges.log"
hloop T-51; hloop T-51
check "DS-377 AC1: a held path into a feature base merges, pinned to its head" '[ "$(merged)" = 151 ] && grep -qx "151 feat/epics $SHA51" "$T/merges.log"'
check "DS-377 AC1: the log says the hold falls on the base'\''s own PR, and nothing is left for the person" 'echo "$out" | grep -q "#151 touches §4 Merge holds (deploys the infrastructure on merge — infra/\*\*, 1 file(s), e.g. infra/main.tf), but its base feat/epics is not main, so merging it deploys nothing" && [ "$(qf T-51 .merge_blocked)" = null ]'
check "DS-377 the hold it merged past goes with the ticket, for the base'\''s own PR into main" '[ "$(qf T-51 .promotion_hold)" = "deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf" ] && echo "$out" | grep -q "#151 §4 Merge holds recorded for feat/epics'\''s own PR"'
q init merge-holds-main
q add T-52 Bug A; q set T-52 branch=fix/T-52 state=done result.pr=152
hloop T-52; hloop T-52
check "DS-377 AC2: a held path into the default branch is still held for a person" '[ "$(merged)" = 151 ] && echo "$out" | grep -q "#152 HELD by §4 Merge holds — a person merges it"'
check "DS-377 AC2: the record leads with the hold'\''s reason from the row" '[ "$(qf T-52 .merge_blocked)" = "merge hold: deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf" ]'

# ---- a code-owner hold whose every owner is the merging account holds nothing --------------------
sed -e 's/| Merge holds | `none` |/| Merge holds | `frontend\/**: CODEOWNERS path, needs your code-owner approval` |/' "$T/config.md" > "$T/config-co.md"
mkdir -p "$T/contents/.github"; printf '* @Tester\nfrontend/b/ @tester @alice\n' > "$T/contents/.github/CODEOWNERS"
SHA71=a711111111111111111111111111111111111111; SHA72=a722222222222222222222222222222222222222
cat > "$T/prs.json" <<EOF
{
  "171": { "head": "fix/T-71", "base": "main", "sha": "$SHA71", "state": "open", "draft": false, "files": ["frontend/a.ts", "frontend/c/d.ts"], "checks": [["test", "SUCCESS"]] },
  "172": { "head": "fix/T-72", "base": "main", "sha": "$SHA72", "state": "open", "draft": false, "files": ["frontend/b/x.ts"], "checks": [["test", "SUCCESS"]] }
}
EOF
coloop(){ out=$(DESK_CONFIG="$T/config-co.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$1" 2>&1); rc=$?; }
q init merge-holds-codeowners
q add T-72 Bug A; q set T-72 branch=fix/T-72 state=done result.pr=172
: > "$T/merges.log"
coloop T-72; coloop T-72
check "DS-413 AC2: a code-owner hold another person owns stays held" '[ -z "$(merged)" ] && echo "$out" | grep -q "#172 HELD by §4 Merge holds — a person merges it"'
check "DS-413 AC2: the record names that owner'\''s approval" '[ "$(qf T-72 .merge_blocked)" = "merge hold: CODEOWNERS path, needs your code-owner approval (code-owner approval from @alice) — frontend/**, 1 file(s), e.g. frontend/b/x.ts" ]'
q add T-71 Bug A; q set T-71 branch=fix/T-71 state=done result.pr=171 "merge_blocked=merge hold: CODEOWNERS path, needs your code-owner approval — frontend/**, 2 file(s), e.g. frontend/a.ts"
coloop T-71
check "DS-413 AC1: a code-owner hold the merging account alone owns is met, and says so" 'echo "$out" | grep -q "#171 §4 Merge holds met with no person: CODEOWNERS path, needs your code-owner approval (every code owner is @tester, the merging account) — frontend/\*\*" && ! echo "$out" | grep -q "#171 HELD"'
check "DS-413 AC1: its old merge-hold record is cleared, so needs-you lists nothing" '[ "$(qf T-71 .merge_blocked)" = null ]'
coloop T-71
check "DS-413 AC1: it merges pinned to its head" '[ "$(merged)" = 171 ] && grep -qx "171 main $SHA71" "$T/merges.log"'
check "DS-413 AC1: CODEOWNERS is read from the PR'\''s base" 'grep -q "contents/.github/CODEOWNERS?ref=main" "$T/gh.log"'
SHA73=a733333333333333333333333333333333333333
cat > "$T/prs.json" <<EOF
{ "173": { "head": "fix/T-73", "base": "feat/epics", "sha": "$SHA73", "state": "open", "draft": false, "files": ["frontend/a.ts"], "checks": [["test", "SUCCESS"]] } }
EOF
q init merge-holds-codeowners-feature; jq '.base = "feat/epics"' "$DESK_QUEUE" > "$T/q.tmp" && mv "$T/q.tmp" "$DESK_QUEUE"
q add T-73 Bug A; q set T-73 branch=fix/T-73 state=done result.pr=173
: > "$T/gh.log"
coloop T-73; coloop T-73
check "DS-413 a code-owner hold into a batch base is carried whole for the base'\''s own PR, never met against the batch base" '[ "$(qf T-73 .promotion_hold)" = "CODEOWNERS path, needs your code-owner approval — frontend/**, 1 file(s), e.g. frontend/a.ts" ] && ! grep -q "contents/.github/CODEOWNERS" "$T/gh.log"'

# ---- DS-411: a hold that names its routine is run by the driver, then merged pinned to the head --
# The PR heads are real commits, so the routine's checkout is of the head itself.
git -C "$T/repo" checkout -q -b fix/T-91; echo up > "$T/repo/up.sql"; git -C "$T/repo" add up.sql; git -C "$T/repo" commit -q -m T-91
SHA91=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" checkout -q main; git -C "$T/repo" checkout -q -b fix/T-92; git -C "$T/repo" commit -q --allow-empty -m T-92
SHA92=$(git -C "$T/repo" rev-parse HEAD); git -C "$T/repo" checkout -q main
cat > "$T/routine.sh" <<EOF
#!/usr/bin/env bash
echo "snapshot taken"
echo "\$DESK_PR \$DESK_HEAD_SHA \$(git rev-parse HEAD) \$([ -f up.sql ] && echo has-file)" >> "$T/routine.ran"
echo "applying to staging"
[ "\$DESK_PR" = 192 ] && { echo "staging refused the migration" >&2; exit 3; }
echo "applied to production"
EOF
sed -e "s#| Merge holds | \`none\` |#| Merge holds | \`db/**: apply the migration to staging and production first; desk runs: bash $T/routine.sh\` \`infra/**: deploys the infrastructure on merge\` |#" "$T/config.md" > "$T/config-routine-off.md"
sed -e '/^| `pr-ready` |/a\
| `merge-hold-routine` | Run hold routines | `no` | `yes` |
' "$T/config-routine-off.md" > "$T/config-routine.md"
cat > "$T/prs.json" <<EOF
{ "191": { "head": "fix/T-91", "base": "main", "sha": "$SHA91", "state": "open", "draft": false, "files": ["db/up.sql"], "checks": [["test", "SUCCESS"]] },
  "192": { "head": "fix/T-92", "base": "main", "sha": "$SHA92", "state": "open", "draft": false, "files": ["db/down.sql"], "checks": [["test", "SUCCESS"]] },
  "193": { "head": "fix/T-93", "base": "main", "sha": "$SHA92", "state": "open", "draft": false, "files": ["db/up.sql", "infra/main.tf"], "checks": [["test", "SUCCESS"]] } }
EOF
rloop(){ out=$(DESK_CONFIG="$T/$1" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$2" 2>&1); rc=$?; }
q init merge-hold-routine
for k in T-91 T-92 T-93; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; rm -f "$T/routine.ran"
rloop config-routine-off.md T-91; rloop config-routine-off.md T-91
check "DS-411 AC3: with §3 merge-hold-routine unset, the routine is not run and the PR is not merged" '[ -z "$(merged)" ] && [ ! -f "$T/routine.ran" ] && echo "$out" | grep -q "#191 HELD by §4 Merge holds — its routine is not run, §3 merge-hold-routine is no"'
check "DS-411 AC3: the record names the hold'\''s step and its routine" '[ "$(qf T-91 .merge_blocked)" = "merge hold: apply the migration to staging and production first — db/**, 1 file(s), e.g. db/up.sql; routine \`bash $T/routine.sh\` not run: §3 merge-hold-routine is no" ]'
rloop config-routine.md T-91
check "DS-411 AC1: green and held a first loop, the routine waits for the head to be confirmed" '[ -z "$(merged)" ] && [ ! -f "$T/routine.ran" ] && [ "$(qf T-91 .merge_blocked)" = null ] && echo "$out" | grep -q "#191 green at .* — confirming on the next loop"'
rloop config-routine.md T-91
check "DS-411 AC1: the routine runs once, in a checkout of the head, with the PR and head set" '[ "$(cat "$T/routine.ran")" = "191 $SHA91 $SHA91 has-file" ]'
check "DS-411 AC1: then the PR merges, pinned to that head, with nothing left for the person" '[ "$(merged)" = 191 ] && grep -qx "191 main $SHA91" "$T/merges.log" && [ "$(qf T-91 .merge_blocked)" = null ]'
check "DS-411 AC1: the routine'\''s checkout is removed" '[ ! -d "$T/state/merge-driver/routine-191-checkout" ] && ! git -C "$T/repo" worktree list | grep -q routine-191'
rloop config-routine.md T-92; o1=$out; rloop config-routine.md T-92; out="$o1
$out"
check "DS-411 AC2: a routine that exits non-zero leaves the PR unmerged" '[ "$(merged)" = 191 ] && echo "$out" | grep -q "#192 its §4 Merge holds routine FAILED at ${SHA92:0:9} (exit 3)"'
check "DS-411 AC2: the record names the routine and the step it failed at" '[ "$(qf T-92 .merge_blocked)" = "merge hold: apply the migration to staging and production first — db/**, 1 file(s), e.g. db/down.sql; routine \`bash $T/routine.sh\` failed at ${SHA92:0:9} (exit 3): staging refused the migration" ]'
rloop config-routine.md T-92
check "DS-411 AC2: a routine that failed is not run again at the same head" '[ "$(grep -c "^192 " "$T/routine.ran")" = 1 ] && [ "$(merged)" = 191 ] && qf T-92 .merge_blocked | grep -q "failed at ${SHA92:0:9} (exit 3)"'
rloop config-routine.md T-93; rloop config-routine.md T-93
check "DS-411: a PR that also touches a hold with no routine is the person'\''s, and no routine runs" '! grep -q "^193 " "$T/routine.ran" && [ "$(merged)" = 191 ] && echo "$out" | grep -q "#193 HELD by §4 Merge holds — a person merges it, after its step: apply the migration"'
check "DS-411 AC3: its record still leads with the routine hold'\''s step, and names the hold with no routine" '[ "$(qf T-93 .merge_blocked)" = "merge hold: apply the migration to staging and production first — db/**, 1 file(s), e.g. db/up.sql; routine \`bash $T/routine.sh\` not run: it also touches a hold no routine clears: deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf" ]'

# ---- DS-407: the person's step in no batch holds a green PR's merge, and lifting it lets it merge --
SHA61=f111111111111111111111111111111111111111
cat > "$T/prs.json" <<EOF
{ "161": { "head": "fix/T-61", "base": "main", "sha": "$SHA61", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] } }
EOF
q init merge-after-step
q add T-61 Story A; q set T-61 branch=fix/T-61 state=done result.pr=161 merge_after=KAN-729
: > "$T/merges.log"
sloop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets T-61 2>&1); rc=$?; }
sloop; sloop
check "DS-407 AC2: a clean, green PR whose ticket waits on the person's step is not merged" '[ -z "$(merged)" ] && echo "$out" | grep -q "#161 green at f11111111, HELD until the person.s step KAN-729 is Done in Jira"'
check "DS-407 AC2: and it is not left for a person to merge by hand"     '[ "$(qf T-61 .merge_blocked)" = null ]'
q set T-61 merge_after=null
sloop; sloop
check "DS-407 AC3: once the step is lifted, it merges with no other answer, pinned to its head" '[ "$(merged)" = 161 ] && grep -qx "161 main $SHA61" "$T/merges.log"'

# ---- The person's instruction on a ready PR holds its merge until a worker has carried it out --------
SHA62=a611111111111111111111111111111111111111; SHA63=a622222222222222222222222222222222222222
SHA64=a633333333333333333333333333333333333333; SHA65=a644444444444444444444444444444444444444
green_pr(){ # green_pr <n> <sha>: the one PR, ready and green, on fix/T-<n - 100>
  printf '{ "%s": { "head": "fix/T-%s", "base": "main", "sha": "%s", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] } }\n' "$1" "$(($1 - 100))" "$2" > "$T/prs.json"
}
instruction(){ printf '{"try":1,"of":1,"kind":"instruction","pr":%s,"head":null,"ready":true,"what":"your instruction","answer":"rename it"}' "$1"; }
iloop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$1" 2>&1); rc=$?; }
green_pr 162 $SHA62
q init merge-instruction
q add T-62 Story A; q set T-62 branch=fix/T-62 state=queued result.pr=162 "fix=$(instruction 162)"
: > "$T/merges.log"
iloop T-62; iloop T-62
check "a green PR is not merged while the person's instruction waits for a worker" '[ -z "$(merged)" ] && echo "$out" | grep -q "#162 HELD: a worker has still to carry out the person.s instruction"'
check "and it is held before the green confirmation, so that starts again once the hold lifts" '! echo "$out" | grep -q "#162 green" && [ ! -f "$T/state/merge-driver/green-162" ]'
q set T-62 state=parked
iloop T-62; iloop T-62
check "a worker that parked on it has not carried it out, so the PR is still held" '[ -z "$(merged)" ] && echo "$out" | grep -q "#162 HELD: a worker"'
q set T-62 state=done fix.finished=2026-11-07T00:00:00Z
iloop T-62; iloop T-62
check "once its fix is finished, it merges pinned to its head" '[ "$(merged)" = 162 ] && grep -qx "162 main $SHA62" "$T/merges.log"'

green_pr 163 $SHA63
q init merge-instruction-other-fix
q add T-63 Story A; q set T-63 branch=fix/T-63 state=done result.pr=163 'fix={"try":1,"of":3,"kind":"conflict","pr":163,"what":"a conflict"}'
: > "$T/merges.log"
iloop T-63; iloop T-63
check "another kind of unfinished fix is not held by this" '[ "$(merged)" = 163 ] && ! echo "$out" | grep -q "HELD: a worker"'

green_pr 164 $SHA64
q init merge-instruction-race
q add T-64 Story A; q set T-64 branch=fix/T-64 state=done result.pr=164
: > "$T/merges.log"
iloop T-64
printf '%s' "node '$B/queue.mjs' set T-64 'fix=$(instruction 164)'" > "$T/gh.midloop"
iloop T-64
check "an instruction recorded after the PR's gate read still stops the merge" '[ -z "$(merged)" ] && [ ! -e "$T/gh.midloop" ] && echo "$out" | grep -q "#164 HELD: a worker" && ! echo "$out" | grep -q "#164 gate GREEN"'

green_pr 165 $SHA65
q init merge-instruction-unreadable
q add T-65 Story A; q set T-65 branch=fix/T-65 state=done result.pr=165
: > "$T/merges.log"
printf '%s' "printf '{' > '$DESK_QUEUE'" > "$T/gh.atlist"
iloop T-65
check "a queue that cannot be read holds the merge" '[ -z "$(merged)" ] && echo "$out" | grep -q "#165 could not read the queue for the person.s instruction"'

# ---- DS-419 / DS-433: a green feature merges with no GitHub approval; review feedback goes to a worker --
SHA71=a711111111111111111111111111111111111111; SHA72=a722222222222222222222222222222222222222
cat > "$T/prs.json" <<EOF
{ "171": { "head": "feat/T-71", "base": "main", "sha": "$SHA71", "state": "open", "draft": false, "title": "feat(rail): T-71 live classes", "checks": [["test", "SUCCESS"]] },
  "172": { "head": "feat/T-72", "base": "main", "sha": "$SHA72", "state": "open", "draft": false, "title": "feat: T-72 sign-in", "feedback": "NONE 1", "checks": [["test", "SUCCESS"]] } }
EOF
q init merge-approval
q add T-71 Story A; q set T-71 branch=feat/T-71 state=done result.pr=171
q add T-72 Story A; q set T-72 branch=feat/T-72 state=done result.pr=172 "merge_blocked=approval: stale"
: > "$T/merges.log"
aloop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-71 T-72" 2>&1); rc=$?; }
aloop
check "DS-419 AC10: a feat PR with an unresolved thread is held for the feedback, and its approval request is cleared" 'echo "$out" | grep -q "#172 has outstanding review feedback (NONE, 1 unresolved)" && ! echo "$out" | grep -q "#172 .*a feature with no approval" && [ "$(qf T-72 .merge_blocked)" = null ]'
# Loop 2 holds the confirm window open, so #171 (confirming, not held) is still open while #172 is read.
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=3600 bash "$B/merge-driver.sh" --tickets "T-71 T-72" 2>&1); rc=$?
check "DS-433: a green feat PR with no thread open and no GitHub approval is not held for one" '! echo "$out" | grep -q "a feature with no approval" && echo "$out" | grep -q "#171 green at a71111111 — confirming" && [ "$(qf T-71 .merge_blocked)" = null ]'
check "DS-419 AC10: held a second loop, its feedback is recorded for the fix worker, with no approval asked" '! echo "$out" | grep -q "#172 .*a feature with no approval" && qf T-72 .merge_blocked | grep -q "^review feedback: 1 unresolved thread on a green PR, first "'
aloop
check "DS-433: confirmed green on the next loop, it merges, pinned to its head, with no approval asked" '[ "$(merged)" = 171 ] && grep -qx "171 main $SHA71" "$T/merges.log" && [ "$(qf T-71 .merge_blocked)" = null ]'

# ---- DS-420: why the driver is not merging a red PR is recorded too: its review threads, or an approval --
SHA81=b811111111111111111111111111111111111111; SHA82=b822222222222222222222222222222222222222
SHA83=b833333333333333333333333333333333333333; SHA84=b844444444444444444444444444444444444444
cat > "$T/prs.json" <<EOF
{ "181": { "head": "fix/T-81", "base": "main", "sha": "$SHA81", "state": "open", "draft": false, "feedback": "NONE 1", "checks": [["test", "SUCCESS", 9081], ["build", "FAILURE", 9181]] },
  "182": { "head": "fix/T-82", "base": "main", "sha": "$SHA82", "state": "open", "draft": false, "feedback": "REVIEW_REQUIRED 0", "checks": [["test", "SUCCESS", 9082], ["build", "FAILURE", 9182]] },
  "183": { "head": "fix/T-83", "base": "main", "sha": "$SHA83", "state": "open", "draft": false, "feedback": "REVIEW_REQUIRED 0", "checks": [["test", "SUCCESS", 9083]] },
  "184": { "head": "fix/T-84", "base": "main", "sha": "$SHA84", "state": "open", "draft": false, "feedback": "REVIEW_REQUIRED 0", "checks": [["test", "FAILURE", 9084]] } }
EOF
q init merge-declines
for k in T-81 T-82 T-83 T-84; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; : > "$T/gh.log"
dloop(){ out=$(DESK_CONFIG="$T/config-flaky.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-81 T-82 T-83 T-84" 2>&1); rc=$?; }
dloop
check "DS-420 AC1: one refusal of a red PR for its thread is not yet recorded" '[ "$(qf T-81 .merge_blocked)" = null ] && echo "$out" | grep -q "#181 has outstanding review feedback (NONE, 1 unresolved)"'
dloop
check "DS-420 AC1: held a second loop, a red PR's thread is recorded as why, and it is not rerun" 'qf T-81 .merge_blocked | grep -q "^review feedback: 1 unresolved thread on a red PR, first " && ! grep -q "run rerun 9181" "$T/gh.log"'
check "DS-420 AC2: a red PR that needs an approving review is recorded for the person, and still rerun so its fix tries come" '[ "$(qf T-82 .merge_blocked)" = "approval: an approving review is required at b82222222: a person approves it before desk merges it" ] && grep -q "run rerun 9182" "$T/gh.log" && echo "$out" | grep -q "#182 at b82222222 needs an approving review (review decision REVIEW_REQUIRED) — not merging"'
check "DS-420 AC2: a red required check listed as flaky does not replace the approval request" '[ "$(qf T-84 .merge_blocked)" = "approval: an approving review is required at b84444444: a person approves it before desk merges it" ] && ! echo "$out" | grep -q "#184 \"test\" is in §4 Known flaky checks"'
check "DS-420 AC2: so is a green one, and it is not merged" '[ "$(qf T-83 .merge_blocked)" = "approval: an approving review is required at b83333333: a person approves it before desk merges it" ] && [ -z "$(merged)" ]'
jq '."182".feedback = "APPROVED 0" | ."183".feedback = "APPROVED 0"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
dloop
check "DS-420 AC2: once approved, the request is cleared: the red one reads red, the green one is confirmed" '[ "$(qf T-82 .merge_blocked)" = null ] && [ "$(qf T-83 .merge_blocked)" = null ] && echo "$out" | grep -q "#182 red at b82222222" && echo "$out" | grep -q "#183 green at b83333333 — confirming"'

# ---- DS-422: a red §4 State check reads the PR's state, so it is never rerun ------------------------
cp "$T/config-flaky.md" "$T/config-state.md"
echo '| State checks | `🌿 Local Adversarial Code Review: verdict` `🔐 Review gate: approval` `🏁 CI gate` |' >> "$T/config-state.md"
cp "$T/config-flaky.md" "$T/config-state-bad.md"
echo '| State checks | `🔐 Review gate: approve` |' >> "$T/config-state-bad.md"
SHA91=c911111111111111111111111111111111111111; SHA92=c922222222222222222222222222222222222222; SHA93=c933333333333333333333333333333333333333; SHA94=c944444444444444444444444444444444444444
cat > "$T/prs.json" <<EOF
{ "191": { "head": "fix/T-91", "base": "main", "sha": "$SHA91", "state": "open", "draft": false,
           "checks": [["test", "SUCCESS", 9090], ["🌿 Local Adversarial Code Review", "FAILURE", 9191], ["🔐 Review gate", "FAILURE", 9192], ["🏁 CI gate", "FAILURE", 9195]] },
  "192": { "head": "fix/T-92", "base": "main", "sha": "$SHA92", "state": "open", "draft": false,
           "checks": [["test", "SUCCESS", 9090], ["build", "FAILURE", 9193], ["🏁 CI gate", "FAILURE", 9194]] },
  "193": { "head": "fix/T-93", "base": "main", "sha": "$SHA93", "state": "open", "draft": false,
           "checks": [["test", "SUCCESS", 9090], ["build", "FAILURE", 9196, 96001], ["🌿 Local Adversarial Code Review", "FAILURE", 9196, 96002]] },
  "194": { "head": "fix/T-94", "base": "main", "sha": "$SHA94", "state": "open", "draft": false,
           "checks": [["test", "SUCCESS", 9090], ["build", "FAILURE", 9197, 97001], ["lint", "FAILURE", 9197, 97002], ["🌿 Local Adversarial Code Review", "FAILURE", 9197, 97003]] } }
EOF
cat > "$T/annotations.json" <<'EOF'
{ "9191": "The review at 135ce1536 is not in the current form: it claims cross-provider but its providers line does not say codex read the diff.",
  "9192": "Approval required — a feat(portal): title, and only fix, docs, chore merge without an approval." }
EOF
q init merge-state
for k in T-91 T-92 T-93 T-94; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; : > "$T/gh.log"
stloop(){ out=$(DESK_CONFIG="$T/config-state.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-91 T-92 T-93 T-94" 2>&1); rc=$?; }
stloop
check "DS-422: the driver starts with the state row read" '[ $rc -eq 0 ] && echo "$out" | grep -q "state=\[🌿 Local Adversarial Code Review,🔐 Review gate,🏁 CI gate\]"'
check "DS-422 AC1: red only on state checks, none is rerun" '! grep -q "run rerun 919[125]" "$T/gh.log" && [ ! -e "$SD/reruns-191-$SHA91" ]'
check "DS-422 AC1: each is logged with the gate and why" 'echo "$out" | grep -qF "#191 \"🌿 Local Adversarial Code Review\" failed (verdict state): The review at 135ce1536 is not in the current form" && echo "$out" | grep -qF "#191 \"🔐 Review gate\" failed (approval state): Approval required — a feat(portal): title" && echo "$out" | grep -qF "#191 \"🏁 CI gate\" failed (state) — a state check: a rerun reads the same PR state, so it is not rerun"'
check "DS-422 AC4: a red approval check puts the PR to the person, with no rerun and no cooldown" '[ "$(qf T-91 .merge_blocked)" = "approval: \"🔐 Review gate\" needs approval from a human reviewer at c91111111: a person approves it before desk merges it" ] && [ ! -e "$SD/cooldown-191" ] && ! echo "$out" | grep -q "#191 red, cooling down"'
check "DS-422 AC2: a red build beside a state check is rerun as today, and only it is counted" 'grep -q "run rerun 9193 --repo acme/widgets --failed" "$T/gh.log" && ! grep -q "run rerun 9194" "$T/gh.log" && [ "$(cat "$SD/reruns-192-$SHA92")" = build ] && [ -e "$SD/cooldown-192" ]'
check "DS-422 AC1: a red build sharing a run with a red state check is rerun by its job, not the run, so the state check is not" 'grep -q "run rerun --job 96001 --repo acme/widgets" "$T/gh.log" && ! grep -q "run rerun 9196" "$T/gh.log" && ! grep -q "96002 --repo" "$T/gh.log" && [ "$(cat "$SD/reruns-193-$SHA93")" = build ] && [ "$(cat "$SD/reruns-ok-193-$SHA93")" = build ]'
check "DS-422 AC2: two red checks sharing a run with a state check rerun the run, and the log says the state check goes with it" 'grep -q "run rerun 9197 --repo acme/widgets --failed" "$T/gh.log" && ! grep -q "run rerun --job 9700" "$T/gh.log" && echo "$out" | grep -qF "#194 \"🌿 Local Adversarial Code Review\" failed (verdict state) — a state check: a rerun reads the same PR state, so it is not rerun for itself, though rerunning run 9197 for the check beside it reruns it too"'
stloop
check "DS-422 AC1: a later loop reruns no state check either" '! grep -q "run rerun 919[12]" "$T/gh.log" && ! echo "$out" | grep -q "#191 red, cooling down"'
out=$(DESK_CONFIG="$T/config-state-bad.md" MERGE_DRIVER_ONE_LOOP=1 bash "$B/merge-driver.sh" --tickets "T-91" 2>&1); rc=$?
check "DS-422: a state row that does not parse stops the driver, naming the row" '[ $rc -eq 1 ] && echo "$out" | grep -qF "FAIL: config §4 State checks does not parse: \`🔐 Review gate: approve\`" && ! echo "$out" | grep -q "merge driver up"'

# ---- DS-433: every PR merges on a clean desk-review at its head, whatever its title, with no approval --
cp "$T/config.md" "$T/config-rv.md"
echo '| Local review command | `/desk-review` |' >> "$T/config-rv.md"
echo '| Clean review verdict | `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0` |' >> "$T/config-rv.md"
# vp <n> <sha> <counts, or "-" for no review> [<a line of the body>]: PR #n's GraphQL read, with tester's desk-review.
vp(){
  node -e 'const [f, sha, counts, line] = process.argv.slice(1);
    const reviews = counts === "-" ? [] : [{ id: "PRR_1", author: { login: "tester" }, commit: { oid: sha }, body: ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${sha} ${counts} vendor=codex round=2 -->`, "**desk-review, round 2**", ...(line ? [line] : [])].join("\n") }];
    require("fs").writeFileSync(f, JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null, reviews: { nodes: reviews }, reviewThreads: { nodes: [] } } } } }));' "$T/vp-$1.json" "$2" "$3" "${4:-}"
}
# rv_prs "<n> <branch> <sha> <title> [<feedback>]"...: open, ready, green PRs read from vp-<n>.json, each a ticket T-<n>.
CLEAN='p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'
rv_prs(){
  : > "$T/merges.log"; : > "$T/gh.log"; rm -f "$SD"/green-*; echo '{}' > "$T/prs.json"; q init "merge-rv-$1"; shift; RV_TICKETS=""
  local row n br sha title fb
  for row in "$@"; do
    IFS='|' read -r n br sha title fb <<EOF_ROW
$row
EOF_ROW
    jq --arg n "$n" --arg br "$br" --arg sha "$sha" --arg t "$title" --arg fb "$fb" --arg pl "$T/vp-$n.json" \
      '.[$n] = { head: $br, base: "main", sha: $sha, state: "open", draft: false, title: $t, feedback: $fb, payload: $pl, checks: [["test", "SUCCESS"]] }' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
    q add "T-$n" Story A; q set "T-$n" "branch=$br" state=done "result.pr=$n"
    RV_TICKETS="$RV_TICKETS T-$n"
  done
}
rvloop(){ out=$(DESK_CONFIG="${RV_CONFIG:-$T/config-rv.md}" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$RV_TICKETS" 2>&1); rc=$?; }
SHA201=d201111111111111111111111111111111111111; SHA202=d202222222222222222222222222222222222222; SHA203=d203333333333333333333333333333333333333

vp 201 "$SHA201" "$CLEAN"
rv_prs ac1 "201|feat/T-201|$SHA201|feat(rail): T-201 live classes|"
rvloop; rvloop
check "DS-433 AC1: a green feat PR with a clean verdict at its head and no approval merges, pinned to that head" '[ "$(merged)" = 201 ] && grep -qx "201 main $SHA201" "$T/merges.log"'
check "DS-433 AC1: and nothing is left for needs-you" '[ "$(qf T-201 .merge_blocked)" = null ]'

vp 201 "$SHA202" "$CLEAN"
rv_prs ac2 "201|feat/T-201|$SHA201|feat(rail): T-201 live classes|"
rvloop; rvloop
check "DS-433 AC2: a clean verdict for an older head does not merge it, and it is held for the review" '[ -z "$(merged)" ] && echo "$out" | grep -q "#201 green at d20111111, HELD with no clean review at its head: its review verdict is for d20222222, not the head d20111111" && [ ! -e "$SD/green-201" ]'
vp 201 "$SHA201" "$CLEAN"
rvloop; rvloop
check "DS-433 AC2: once a clean verdict is posted at the head, it merges with no other answer" '[ "$(merged)" = 201 ] && grep -qx "201 main $SHA201" "$T/merges.log"'

vp 201 "$SHA201" -
vp 202 "$SHA202" 'p0=0 p1=0 p2=1 deferred=0 gaps=0 unrefuted=0 partial=0'
vp 203 "$SHA203" 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0' '<!-- desk-review:carried v=1 p2=2 since=d200000000000000000000000000000000000000 -->'
rv_prs p2 "201|fix/T-201|$SHA201|fix: T-201 no review|" "202|fix/T-202|$SHA202|fix: T-202 an open P2|" "203|fix/T-203|$SHA203|fix: T-203 carried P2s|"
rvloop; rvloop
check "DS-433: a PR with no verdict at all is held" 'echo "$out" | grep -q "#201 green at d20111111, HELD with no clean review at its head: no desk-review verdict is posted on it"'
check "DS-433: an uncarried P2 at the head holds it" 'echo "$out" | grep -q "#202 green at d20222222, HELD with no clean review at its head: its review verdict at d20222222 is not clean (p2=1)"'
check "DS-433: P2s carried on the carried line do not hold it, and only it merges" '[ "$(merged)" = 203 ] && grep -qx "203 main $SHA203" "$T/merges.log"'

vp 201 "$SHA201" "$CLEAN"
rv_prs ac3 "201|feat/T-201|$SHA201|feat(rail): T-201 live classes|REVIEW_REQUIRED 0"
rvloop; rvloop
check "DS-433 AC3: where GitHub requires an approving review, a green cleanly reviewed feat PR stays held and needs-you asks" '[ -z "$(merged)" ] && [ "$(qf T-201 .merge_blocked)" = "approval: an approving review is required at d20111111: a person approves it before desk merges it" ]'

sed 's/| `autopilot-merge` | Merge batch PRs | `no` | `yes` |/| `autopilot-merge` | Merge batch PRs | `no` | `no` |/' "$T/config-rv.md" > "$T/config-rv-no.md"
vp 201 "$SHA201" "$CLEAN"
rv_prs ac4 "201|feat/T-201|$SHA201|feat(rail): T-201 live classes|"
RV_CONFIG="$T/config-rv-no.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-433 AC4: under §3 autopilot-merge no, a green cleanly reviewed feat PR is not merged" '[ -z "$(merged)" ] && [ $rc -eq 1 ] && echo "$out" | grep -q "the driver merges nothing"'

vp 201 "$SHA201" "$CLEAN"; vp 202 "$SHA202" "$CLEAN"
rv_prs ac5 "201|fix/T-201|$SHA201|fix: T-201 a bug|" "202|feat/T-202|$SHA202|feat: T-202 a feature|"
rvloop
check "DS-433 AC5: a fix PR and a feat PR both green and clean are confirmed the same way" 'echo "$out" | grep -q "#201 green at d20111111 — confirming" && echo "$out" | grep -q "#202 green at d20222222 — confirming"'
rvloop; rvloop
check "DS-433 AC5: and both merge, pinned to their heads, with nothing left for a person" '[ "$(merged)" = "201 202" ] && grep -qx "201 main $SHA201" "$T/merges.log" && grep -qx "202 main $SHA202" "$T/merges.log" && [ "$(qf T-201 .merge_blocked)" = null ] && [ "$(qf T-202 .merge_blocked)" = null ]'
vp 201 "$SHA201" -; vp 202 "$SHA202" -
rv_prs ac5b "201|fix/T-201|$SHA201|fix: T-201 a bug|" "202|feat/T-202|$SHA202|feat: T-202 a feature|"
rvloop; rvloop
check "DS-433 AC5: and neither merges with no review" '[ -z "$(merged)" ] && echo "$out" | grep -q "#201 green at d20111111, HELD" && echo "$out" | grep -q "#202 green at d20222222, HELD"'

# The hold reads the row: `none` waits on nothing, and a plain-text row and §3 merge-feedback-first no still hold.
sed 's/| Local review command | `\/desk-review` |/| Local review command | `none` |/' "$T/config-rv.md" > "$T/config-rv-none.md"
vp 201 "$SHA201" -
rv_prs none "201|fix/T-201|$SHA201|fix: T-201 a bug|"
RV_CONFIG="$T/config-rv-none.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-433: §4 Local review command none waits on no verdict" '[ "$(merged)" = 201 ]'
sed 's/^| `pr-ready` .*/&\n| `merge-feedback-first` | Feedback first | `yes` | `no` |/' "$T/config-rv.md" > "$T/config-rv-fb.md"
rv_prs fbno "201|fix/T-201|$SHA201|fix: T-201 a bug|"
RV_CONFIG="$T/config-rv-fb.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-433: §3 merge-feedback-first no skips the threads, not the verdict" '[ -z "$(merged)" ] && echo "$out" | grep -q "#201 green at d20111111, HELD"'
sed 's/| Clean review verdict | .*/| Clean review verdict | `no findings` |/' "$T/config-rv.md" > "$T/config-rv-plain.md"
node -e 'const sha = process.argv[2]; require("fs").writeFileSync(process.argv[1], JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null, reviews: { nodes: [{ id: "PRR_1", author: { login: "tester" }, commit: { oid: sha }, body: "No findings.\nNothing deferred or carried." }] }, reviewThreads: { nodes: [] } } } } }));' "$T/vp-201.json" "$SHA201"
rv_prs plain "201|fix/T-201|$SHA201|fix: T-201 a bug|"
RV_CONFIG="$T/config-rv-plain.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-433: under a plain-text row, a review stating it at the head reads as clean, so it merges" '[ "$(merged)" = 201 ]'

# A verdict carried across a clean merge of the base holds at the head; commits of its own do not. Real commits, fetched.
git init -q --bare -b main "$T/origin.git"; git -C "$T/repo" remote add origin "file://$T/origin.git"
cmt(){ echo "$1" > "$T/repo/$1"; git -C "$T/repo" add "$1"; git -C "$T/repo" commit -q -m "$1"; }
git -C "$T/repo" checkout -q main; cmt base.txt; git -C "$T/repo" push -q origin main
git -C "$T/repo" checkout -q -b fix/T-211; cmt own.txt; RA=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" checkout -q main; cmt moved.txt
git -C "$T/repo" checkout -q fix/T-211; git -C "$T/repo" merge -q --no-edit main; RB=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" checkout -q -b fix/T-212 "$RA"; cmt other.txt; git -C "$T/repo" merge -q --no-edit main; RC=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" checkout -q main; git -C "$T/repo" push -q origin main "$RB:refs/pull/211/head" "$RC:refs/pull/212/head"
vp 211 "$RA" "$CLEAN"; vp 212 "$RA" "$CLEAN"
rv_prs carry "211|fix/T-211|$RB|fix: T-211 base merged|" "212|fix/T-212|$RC|fix: T-212 own commit|"
rvloop; rvloop
check "DS-433: a clean verdict carried across a clean merge of the base merges, with no new review" '[ "$(merged)" = 211 ] && grep -qx "211 main $RB" "$T/merges.log" && echo "$out" | grep -q "#211 its clean review at ${RA:0:9} holds at ${RB:0:9}: only clean merges of main came since"'
rvloop
check "DS-433: one its own commits moved past is held for a review" '! grep -q "^212 " "$T/merges.log" && echo "$out" | grep -q "#212 green at ${RC:0:9}, HELD with no clean review at its head: its review verdict is for ${RA:0:9}"'

# With the review-reuse lever on, the same clean merge carries only while the base moved none
# of the files the review rests on, and the PR says so once. moved.txt is what the base changed.
{ cat "$T/config-rv.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `review-reuse` |\n'; } > "$T/config-rv-reuse.md"
vp 211 "$RA" "$CLEAN" '<!-- desk-review:rests-on v=1 files=["own.txt"] -->'
rv_prs reuse "211|fix/T-211|$RB|fix: T-211 base merged|"
RV_CONFIG="$T/config-rv-reuse.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-448 AC2: lever on, a base merge over unrelated files carries the review, and the PR names the range" '[ "$(merged)" = 211 ] && echo "$out" | grep -q "#211 its clean review at ${RA:0:9} is carried to ${RB:0:9}, not reviewed there" && [ "$(grep -c "pr comment 211" "$T/gh.log")" = 1 ] && grep "pr comment 211" "$T/gh.log" | grep -q "which no review has read"'
vp 211 "$RA" "$CLEAN" '<!-- desk-review:rests-on v=1 files=["moved.txt","own.txt"] -->'
rv_prs reuse2 "211|fix/T-211|$RB|fix: T-211 base merged|"
RV_CONFIG="$T/config-rv-reuse.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-448 AC8: lever on, a clean merge over a recorded file is held for a review" '[ -z "$(merged)" ] && echo "$out" | grep -q "#211 green at ${RB:0:9}, HELD with no clean review at its head"'
vp 211 "$RA" "$CLEAN"
rv_prs reuse3 "211|fix/T-211|$RB|fix: T-211 base merged|"
RV_CONFIG="$T/config-rv-reuse.md"; rvloop; rvloop; RV_CONFIG=""
check "DS-448: lever on, a review that records no files is held for a review" '[ -z "$(merged)" ] && echo "$out" | grep -q "#211 green at ${RB:0:9}, HELD"'

# ---- DS-508: an epic batch not in feature mode lands its base through its epic PR into main ---------
# ep_q <case> <draft>: batch base feat/E for epic T-300, its one child merged, and epic PR #301
# (feat/E → main), green, recorded as the queue's promotion.
SHA301=e301111111111111111111111111111111111111
git -C "$T/repo" push -q origin main:feat/E
ep_q(){
  : > "$T/merges.log"; : > "$T/gh.log"; rm -f "$SD"/green-*; q init "merge-epic-$1"
  q set-batch base=feat/E epic=T-300 feature=false 'promotion={"pr":301}'
  q add T-31 Story A; q set T-31 branch=fix/T-31 state=done result.pr=310 merged_at=2026-11-06T10:00:00Z
  jq -n --arg s "$SHA301" --arg pl "$T/vp-301.json" --argjson d "$2" \
    '{ "301": { head: "feat/E", base: "main", sha: $s, state: "open", draft: $d, title: "T-300: promote feat/E to main", payload: $pl, checks: [["test", "SUCCESS"]] } }' > "$T/prs.json"
  RV_TICKETS="T-31"
}
vp 301 "$SHA301" "$CLEAN"
ep_q ready false; rvloop; rvloop
check "DS-508 AC2: a ready epic PR into main, green with a clean review at its head, is merged by the driver, pinned to its head" '[ "$(merged)" = 301 ] && grep -qx "301 main $SHA301" "$T/merges.log" && echo "$out" | grep -q "#301 MERGED (T-300)"'
check "DS-508 AC2: and its merge is recorded on the queue's promotion, not as a ticket" '[ "$(jq -r .promotion.merged_at "$DESK_QUEUE")" != null ] && [ "$(jq -r ".tickets[\"T-300\"]" "$DESK_QUEUE")" = null ]'
# GitHub shown as open again, so only the queue's promotion.merged_at can keep the driver off it.
: > "$T/merges.log"; jq '."301".state = "open"' "$T/prs.json" > "$T/prs.json.new" && mv "$T/prs.json.new" "$T/prs.json"
rvloop
check "DS-508 AC2: a merged epic PR is not tried again" '[ -z "$(merged)" ] && ! echo "$out" | grep -q "#301"'
ep_q draft true; rvloop; rvloop
check "DS-508 AC2: a draft epic PR is not merged" '[ -z "$(merged)" ] && echo "$out" | grep -q "epic PR #301 draft (still reviewing)"'
vp 301 "$SHA301" -
ep_q noreview false; rvloop; rvloop
check "DS-508 AC2: one with no clean review at its head is held for one" '[ -z "$(merged)" ] && echo "$out" | grep -q "#301 green at e30111111, HELD with no clean review at its head"'
vp 301 "$SHA301" "$CLEAN"
ep_q carried false; q set T-31 'promotion_hold=deploys the stack — infra/**'; rvloop; rvloop
check "DS-508 AC3: §4 Merge holds its children carried into the base leave the epic PR to a person" '[ -z "$(merged)" ] && echo "$out" | grep -q "epic PR #301 HELD: its children carried §4 Merge holds into feat/E"'
sed 's/| Merge holds | `none` |/| Merge holds | `infra\/**: deploys the stack` |/' "$T/config-rv.md" > "$T/config-rv-hold.md"
ep_q hold false; jq '."301".files = ["infra/x.tf"]' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
RV_CONFIG="$T/config-rv-hold.md"; rvloop; rvloop
check "DS-508 AC3: a §4 Merge hold the epic PR touches holds it, noted on the queue's promotion" '[ -z "$(merged)" ] && jq -r .promotion.merge_blocked "$DESK_QUEUE" | grep -q "^merge hold: deploys the stack — infra/\*\*, 1 file(s)"'
out=$(DESK_CONFIG="$T/config-rv-hold.md" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off node "$B/pass.mjs" --json 2>/dev/null); rc=$?; RV_CONFIG=""
check "DS-508 AC3: and the pass puts it to the person, naming the hold, exit 11" '[ $rc -eq 11 ] && js ".waiting[]" | grep -q "^EPIC PR: #301 is out of draft, but the merge driver holds it: merge hold: deploys the stack"'

# ---- a repaired PR merges before a ready PR changing the same file; the hold ends itself ------------
SHAR=abcabcabcabcabcabcabcabcabcabcabcabcabc1; SHAP=abcabcabcabcabcabcabcabcabcabcabcabcabc2
HEADR=dddddddddddddddddddddddddddddddddddddddd
rploop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-401 T-402" 2>&1); rc=$?; }
# rp_setup <repaired draft> <repaired check> <finished ms ago> <ready PR files> [<repaired head recorded>]
rp_setup(){
  local at; at=$("$NODE" -p "new Date(Date.now()-$3).toISOString()")
  : > "$T/merges.log"
  find "$T/state" -name 'green-41*' -delete
  q init repaired
  cat > "$T/prs.json" <<EOF
{
  "411": { "head": "fix/T-401", "base": "main", "sha": "$SHAP", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]], "files": $4 },
  "412": { "head": "fix/T-402", "base": "main", "sha": "$SHAR", "state": "open", "draft": $1, "checks": [["test", "$2"]], "files": ["src/shared.txt"] }
}
EOF
  q add T-401 Task A; q set T-401 branch=fix/T-401 state=done result.pr=411
  q add T-402 Task A; q set T-402 branch=fix/T-402 state=done result.pr=412
  q set T-402 "fix_tries=[{\"try\":1,\"head\":\"${5:-$HEADR}\",\"kind\":\"conflict\",\"at\":\"$at\",\"finished\":\"$at\"}]"
}
SHARED='["src/shared.txt"]'
rp_setup false SUCCESS 0 "$SHARED"; rploop; rploop
check "AC1 two ready PRs sharing a file: the repaired one, with the higher number, merges first" '[ "$(merged)" = 412 ] && echo "$out" | grep -q "#411 HELD: it changes src/shared.txt, as repaired #412 (T-402) does"'
rp_setup true SUCCESS 0 "$SHARED"; rploop; rploop
check "AC2 a ready PR behind a repaired PR not yet ready is not merged and names it" '[ -z "$(merged)" ] && echo "$out" | grep -q "#411 HELD: it changes src/shared.txt, as repaired #412"'
rp_setup true SUCCESS 7200000 "$SHARED"; rploop; rploop
check "AC3 past 60 minutes the hold ends, logged, and the ready PR merges" '[ "$(merged)" = 411 ] && echo "$out" | grep -q "#411 hold behind repaired #412 (T-402) ended: 60 minutes since its repair"'
rp_setup false FAILURE 0 "$SHARED"; rploop; rploop
check "AC4 behind a red repaired PR the ready PR merges" '[ "$(merged)" = 411 ] && echo "$out" | grep -q "ended: it is red"'
rp_setup true SUCCESS 0 "$SHARED"; q set T-402 state=parked; rploop; rploop
check "AC4 behind a parked repaired PR the ready PR merges" '[ "$(merged)" = 411 ] && echo "$out" | grep -q "ended: it is parked or stuck"'
rp_setup false SUCCESS 0 '["src/other.txt"]'; rploop; rploop
check "AC5 sharing no file, the ready PR merges in its usual order" '[ "$(merged)" = 411 ] && ! echo "$out" | grep -q "HELD"'
rp_setup true SUCCESS 0 "$SHARED" "$SHAR"; rploop; rploop
check "a repair that never moved the head holds nothing" '[ "$(merged)" = 411 ]'

echo "merge driver: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
