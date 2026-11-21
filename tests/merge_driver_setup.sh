# shellcheck shell=bash
# Sourced by every tests/test_merge_driver_*.sh suite: the setup they share. Each suite runs the real
# merge-driver.sh and gate.mjs with MERGE_DRIVER_ONE_LOOP=1 against a fake gh that keeps its PRs in a
# JSON file: `pr merge` flips one to merged, so the next loop and release_chain see it. The fake sleep
# records the call and stops the driver, so a loop that sleeps cannot hang a suite. A suite needs
# nothing but this: a throwaway HOME, repo, queue and state of its own.
# shellcheck disable=SC2034  # the variables and helpers here are read by the suite that sources this
set -u
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
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
# finish <name>: the suite's last line, and its exit status.
finish(){ echo "merge driver $1: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; }
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
    .map(([n, p]) => ({ number: Number(n), title: 't', headRefName: p.head, baseRefName: p.base, isDraft: p.draft, headRefOid: p.sha, mergeStateStatus: p.mergeState ?? 'CLEAN' })));
} else if (a[0] === 'pr' && a[1] === 'view' && at('--json') === 'state') {
  out(String(prs[a[2]]?.state ?? '').toUpperCase());
} else if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs[a[2]];
  out({ number: Number(a[2]), title: p.title ?? 't', headRefOid: p.sha, headRefName: p.head, baseRefName: p.base, isDraft: p.draft,
    state: p.state.toUpperCase(), mergeable: p.mergeState === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: p.mergeState ?? 'CLEAN', reviewDecision: (p.feedback ?? '').split(' ')[0], autoMergeRequest: null,
    statusCheckRollup: p.checks.map(([name, conclusion, run, job, startedAt]) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, workflowName: 'ci', startedAt,
      detailsUrl: run ? 'https://github.com/acme/widgets/actions/runs/' + run + '/job/' + (job ?? run) : undefined })) });
} else if (a[0] === 'api' && /check-runs\/\d+\/annotations/.test(a[1] ?? '')) {
  // A job's annotations: annotations.json maps a job id to the error its run gave, or to its annotations.
  const id = /check-runs\/(\d+)/.exec(a[1])[1];
  const m = fs.existsSync('$T/annotations.json') ? JSON.parse(fs.readFileSync('$T/annotations.json', 'utf8'))[id] : null;
  out(Array.isArray(m) ? m : m ? [{ annotation_level: 'failure', message: m }] : []);
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
  // "refuse": a PR GitHub will not merge, whatever its head.
  if (!p || p.state !== 'open' || p.refuse || at('--match-head-commit') !== p.sha) { console.error('merge refused'); process.exit(1); }
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
# The driver's own state: its reruns, cooldowns and green confirmations.
SD="$T/state/merge-driver"

# The fake desk-jira that moves tickets: each ticket's status in jira-status/<key>, In Progress until a
# transition moves it; its web links in jira-links/<key> (none without one). A search finds no other ticket.
stub_jira_close(){
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
  chmod +x "$T/stub/desk-jira"
}

# config-rv.md merges a PR only on a clean desk-review verdict at its head.
CLEAN='p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'
write_rv_config(){
  cp "$T/config.md" "$T/config-rv.md"
  echo '| Local review command | `/desk-review` |' >> "$T/config-rv.md"
  echo '| Clean review verdict | `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0` |' >> "$T/config-rv.md"
}
# vp <n> <sha> <counts, or "-" for no review> [<a line of the body>]: PR #n's GraphQL read, with tester's desk-review.
vp(){
  node -e 'const [f, sha, counts, line] = process.argv.slice(1);
    const reviews = counts === "-" ? [] : [{ id: "PRR_1", author: { login: "tester" }, commit: { oid: sha }, body: ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${sha} ${counts} vendor=codex round=2 -->`, "**desk-review, round 2**", ...(line ? [line] : [])].join("\n") }];
    require("fs").writeFileSync(f, JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null, reviews: { nodes: reviews }, reviewThreads: { nodes: [] } } } } }));' "$T/vp-$1.json" "$2" "$3" "${4:-}"
}
rvloop(){ out=$(DESK_CONFIG="${RV_CONFIG:-$T/config-rv.md}" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$RV_TICKETS" 2>&1); rc=$?; }
