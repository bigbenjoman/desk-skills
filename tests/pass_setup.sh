# shellcheck shell=bash
# Shared setup for the pass suites (tests/test_pass_*.sh), which each source it first: a scratch HOME,
# a git repo and its config, a DESK_HOME whose bin holds the real desk/bin scripts beside stubs
# for everything that would touch GitHub, a browser, a worktree or a worker, and the helpers more than
# one suite uses. Not a suite: tests/run.sh runs only tests/test_*.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_START_STAGE DESK_GITHUB_HANDLE CLAUDE_CONFIG_DIR CODEX_HOME DESK_AUTOPILOT_WORKER
# As tests/run.sh does, so a suite run on its own reads no real test lock queue; DS-662's checks turn it on.
export AUTOPILOT_LOCK_QUEUE=off
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

# A DESK_HOME whose bin holds the real scripts (link_bin, after the stubs) beside stubs for everything
# that would touch GitHub, a browser, a worktree or a worker.
cat > "$T/desk/bin/upload-images.mjs" <<EOF
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync('$T/uploads', \`\${process.argv[2]} \${process.argv[3]}\\n\`);
appendFileSync('$T/upload-args', \`\${process.argv.slice(2).join(' ')}\\n\`);
// \$T/upload-left, when it exists, is an upload that left cells: what upload-images says, and its exit 4.
if (existsSync('$T/upload-left')) { process.stdout.write(readFileSync('$T/upload-left', 'utf8')); process.exit(4); }
// \$T/upload-busy-<pr>, when it exists, is the shared profile in use: the uploader's exit 2.
if (existsSync('$T/upload-busy-' + process.argv[2])) { console.error('[upload] the shared profile is in use — refusing:'); process.exit(2); }
// \$T/upload-throttle-<pr>, when it exists, is GitHub's rate limit: its contents are the retry_after, then exit 7.
if (existsSync('$T/upload-throttle-' + process.argv[2])) { console.error('[upload] throttled: an earlier stall has not passed, so nothing is uploaded before ' + readFileSync('$T/upload-throttle-' + process.argv[2], 'utf8').trim()); process.exit(7); }
// \$T/upload-page-<pr>, when it exists, is GitHub's PR page with no comment composer: exit 7 saying so.
if (existsSync('$T/upload-page-' + process.argv[2])) { console.error("[upload] GitHub's PR page changed: no comment composer found by role, placeholder or legacy id"); process.exit(7); }
// \$T/upload-fillcrash-<pr>, when it exists, fills the first cell of the fake gh's PR body, then crashes.
const frc = '$T/fr/' + process.argv[2] + '.json';
if (existsSync('$T/upload-fillcrash-' + process.argv[2])) { const j = JSON.parse(readFileSync(frc, 'utf8')); j.body = j.body.replace(/_drag (\S+?)\.png_/, '<img alt="\$1" src="https://github.com/user-attachments/assets/1">'); writeFileSync(frc, JSON.stringify(j)); console.error('Error: page closed'); process.exit(1); }
// \$T/upload-crash, when it exists, is an uncaught exception: a stack, then node's version banner last.
if (existsSync('$T/upload-crash')) { console.error('file:///up.mjs:9\nError: profile locked\n    at main (file:///up.mjs:9:9)\n\nNode.js v22.23.1'); process.exit(1); }
// \$T/upload-fills, when it exists, swaps the cells of the fake gh's PR \$T/fr/<pr>.json as the real one does.
const fr = '$T/fr/' + process.argv[2] + '.json';
if (existsSync('$T/upload-fills') && existsSync(fr)) { const j = JSON.parse(readFileSync(fr, 'utf8')); j.body = j.body.replace(/_drag (\S+?)\.png_/g, '<img alt="\$1" src="https://github.com/user-attachments/assets/1">'); writeFileSync(fr, JSON.stringify(j)); }
console.log('done: 1 image(s) in the body, 0 placeholder(s) left');
EOF
# shellcheck source=link_bin.sh
. "$S/link_bin.sh"; link_bin "$B" "$T/desk/bin"
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}]'" > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
# In front of whichever gh stub a case writes: a fix try's last read of its PR before it spawns gets
# that stub's answer, or, where it prints nothing, the PR open at the head "x".
mkdir -p "$T/stub0"
cat > "$T/stub0/gh" <<EOF
#!/bin/sh
case "\$*" in
  "pr view "*" --json state,headRefOid,mergedAt")
    o=\$("$T/stub/gh" "\$@"); c=\$?
    [ "\$c" -ne 0 ] && { printf '%s\n' "\$o"; exit "\$c"; }
    [ -n "\$o" ] && { printf '%s\n' "\$o"; exit 0; }
    echo '{"state":"OPEN","headRefOid":"x"}'; exit 0 ;;
esac
exec "$T/stub/gh" "\$@"
EOF
chmod +x "$T/stub0/gh"
# The process listing a pass reads for each kept worktree: what $T/lsof.out says, else nothing.
printf '#!/bin/sh\ncat "%s/lsof.out" 2>/dev/null\nexit 0\n' "$T" > "$T/stub/lsof"
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/lsof"
# The process table the pass reads: what $T/ps.out says, else the real ps; with $T/ps.out, the ages
# it reads are what $T/ps-ages.out says, else none, so a fake pid never reads a real process's age.
printf '#!/bin/sh\n[ -f "%s/ps.fail" ] && exit 1\n[ -f "%s/ps.out" ] && [ "$*" = "-ww -axo pid=,ppid=,args=" ] && exec cat "%s/ps.out"\n[ -f "%s/ps.out" ] && [ "$*" = "-ww -axo pid=,etime=" ] && { cat "%s/ps-ages.out" 2>/dev/null; exit 0; }\nexec "%s" "$@"\n' "$T" "$T" "$T" "$T" "$T" "$(command -v ps)" > "$T/stub/ps"; chmod +x "$T/stub/ps"
# Finishes the batch: every ticket done and every PR merged, so the next pass reports it idle.
all_done(){ jq -c '.tickets |= map_values(.state = "done" | if .result.pr != null then .merged_at //= "2026-10-23T10:00:00Z" | .pr_status = { pr: .result.pr, state: "MERGED", merged_at: .merged_at, checks: [] } else . end)' "$DESK_QUEUE" > "$DESK_QUEUE.all-done" && mv "$DESK_QUEUE.all-done" "$DESK_QUEUE"; }

# A signed-in browser profile, as the upload queue runs no upload without one.
printf '{"user":"t","cookies":[{"name":"user_session","domain":"github.com","expires":%s}],"origins":[]}\n' "$(( $(date +%s) + 31536000 ))" > "$T/profile.github-session.json"
export PATH="$T/stub0:$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test \
  DESK_BROWSER_PROFILE="$T/profile"
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
# shellcheck source=jq_at.sh
. "$S/jq_at.sh"
# A ticket the pass moved to the archive beside the queue (queue-store.mjs) is found as a queue read finds it.
field(){ local a="${DESK_QUEUE%.json}.archive.json"; [ -f "$a" ] || a=/dev/null
  jq -cn --arg t "$1" --arg p "$2" --slurpfile live "$DESK_QUEUE" --slurpfile arc "$a" "$JQ_AT"' $live[0].tickets as $l
  | (if $l | has($t) then $l[$t] else ($arc[0].tickets // {})[$t] end) | at($p)'; }
bfield(){ jq -c --arg p "$1" "$JQ_AT"' at($p)' "$DESK_QUEUE"; }
# One assistant turn of a worker's stream-json log, carrying the given marker lines.
say(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv.slice(1).join("\n") }] } }))' "$@"; }
# The end of a worker's session in its log.
result_event(){ node -e 'console.log(JSON.stringify({ type: "result", is_error: false, num_turns: 3, total_cost_usd: 0.5, result: "ended" }))'; }
# Node by full path, for stub scripts' #! lines.
NODE=$(command -v node)
# The 5-hour usage limit's rejection, recorded from a real worker, with its reset moved to suit each case.
limit_event(){ node -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); e.rate_limit_info.resetsAt = Number(process.argv[2]); if (process.argv[3]) e.rate_limit_info.rateLimitType = process.argv[3]; console.log(JSON.stringify(e))' "$S/fixtures/usage-limit-five-hour.json" "$1" "${2:-}"; }
# The registry stub also answers the probe call (claude -p): what the probe says is $T/probe.out.
# probe_says limited <resetsAt> [type] | ok
probe_says(){ if [ "$1" = ok ]; then { say "ok"; echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'; } > "$T/probe.out"
  else { limit_event "$2" "${3:-}"; echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"api_error":"usage_limit_reached","result":"usage limit reached"}'; } > "$T/probe.out"; fi; }
stub_claude(){ printf '#!/bin/sh\nif [ "$1" = -p ]; then echo "$*" >> "%s/probes"; cat "%s/probe.out"; exit 0; fi\necho %s\n' "$T" "$T" "'$1'" > "$T/stub/claude"; }
# hfile <TICKET> <stage> <verification line> [review line]: the handoff briefing a worker writes, with
# one field no briefing holds.
hfile(){ node -e 'const [k, s, v, r] = process.argv.slice(1); require("fs").writeFileSync(`${process.env.DESK_AUTOPILOT_STATE}/handoffs/${k}.json`, JSON.stringify({ ticket: k, stage: s, criteria: ["AC1: the widget saves"], lane: "A", verification: [v], review: r ? [r] : [], evidence: [], scratch: "SCRATCH-FIELD" }))' "$@"; }

# Jira as the tracker: config §4, the ticket-facts script, and a desk-jira that knows T-50 and T-51
# and the epic T-9, logging every call to $JIRA_CALLS.
tracker_on(){
cat >> "$T/config.md" <<'EOF'

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | `jira` |
| Ticket key pattern | `T-[0-9]+` |
EOF
cat > "$T/stub/desk-jira" <<'EOF'
#!/bin/sh
echo "$*" >> "$JIRA_CALLS"
case "$1 $2" in
  "get T-50") echo '{"key":"T-50","fields":{"parent":{"key":"T-9","fields":{"summary":"The epic","issuetype":{"name":"Epic","hierarchyLevel":1}}}}}' ;;
  "children T-9") echo '[{"key":"T-50","fields":{"status":{"statusCategory":{"key":"new"}}}},{"key":"T-49","fields":{"status":{"statusCategory":{"key":"done"}}}}]' ;;
  "get T-51") echo '{"key":"T-51","fields":{}}' ;;
  *) echo "desk-jira: 404 for $2" >&2; exit 1 ;;
esac
EOF
chmod +x "$T/stub/desk-jira"
export JIRA_CALLS="$T/jira-calls"; : > "$JIRA_CALLS"
}
# Where a suite after the first picks up: Jira as the tracker, worker ports from 47701, and the
# check-in digest already sent, so no pass builds one.
pick_up(){
  tracker_on
  export DESK_DIGEST_DIR="$T/digest" AUTOPILOT_PORT_FLOOR=47701; mkdir -p "$T/digest"
  echo '{"slot":"9999-01-01T00:00","through":"9999-01-01T00:00:00.000Z"}' > "$T/digest/last.json"
}

# A repo config whose §3 lets a worker resolve an unreviewed conflict and whose §4 names a check
# workers can't fix.
config_f(){
cat > "$T/config-f.md" <<EOF
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
| \`pr-conflict-unreviewed\` | Resolve a merge conflict on your PR before any human has reviewed it | \`yes\` | \`yes\` |

## 1. Identity
| Field | Value |
|---|---|
| GitHub handle | \`me\` |

## 4. Checks
| Field | Value |
|---|---|
| Required checks | \`tests\` |
| Checks workers can't fix | \`Flows image missing: build it: ensure-flows-image.sh\` |
EOF
}
# fx <n> <head> <mergeable> <check>:<conclusion>[:<run id>]...: PR #n open and out of draft, in $T/fx.
fx(){
  mkdir -p "$T/fx"
  node -e 'const [dir, n, head, mergeable, ...cs] = process.argv.slice(1);
    const checks = cs.map((c) => { const [name, conclusion, run] = c.split(":"); return { __typename: "CheckRun", name, status: "COMPLETED", conclusion, detailsUrl: run ? `https://github.com/acme/widgets/actions/runs/${run}/job/1` : "" }; });
    require("fs").writeFileSync(`${dir}/${n}.json`, JSON.stringify({ state: "OPEN", url: `https://github.com/acme/widgets/pull/${n}`, isDraft: false, mergeable, mergeStateStatus: mergeable === "CONFLICTING" ? "DIRTY" : "BLOCKED", headRefOid: head, statusCheckRollup: checks, commits: [{ oid: "0000000000000000000000000000000000000000", committedDate: "2025-10-01T09:00:00Z" }, { oid: head, committedDate: "2025-10-20T09:00:00Z" }] }))' "$T/fx" "$@"
}
H0=0000000000000000000000000000000000000000; H1=1111111111111111111111111111111111111111; H2=2222222222222222222222222222222222222222; H3=3333333333333333333333333333333333333333

# The fake gh for drafts under review: it answers each PR from $T/fr/<n>.json, a green draft with one
# review by ben, and records pr ready and pr comment. The review's inline comments (gh api graphql, by
# its id PRR_<n>) are $T/fr/<n>.comments, a JSON list, or the error gh prints when it holds ERROR.
fr_gh(){
mkdir -p "$T/fr"
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/gh-calls', a.join(' ') + '\n');
const f = '$T/fr/' + a[2] + '.json';
if (a[0] === 'api' && a[1] === 'graphql') {
  const id = a.find((x) => x.startsWith('id=PRR_'));
  let c = '[]';
  try { c = fs.readFileSync('$T/fr/' + (id ? id.slice(7) : 'none') + '.comments', 'utf8'); } catch {}
  if (c.startsWith('ERROR')) { process.stderr.write(c); process.exit(1); }
  // As gh does, the whole response unless --jq picks the list out of it.
  const jq = a[a.indexOf('--jq') + 1];
  process.stdout.write(a.includes('--jq') && jq === '.data.node.comments.nodes' ? c : JSON.stringify({ data: { node: { comments: { nodes: JSON.parse(c) } } } }));
}
else if (a[0] === 'pr' && a[1] === 'view') { try { process.stdout.write(fs.readFileSync(f, 'utf8')); } catch { process.exit(1); } }
else if (a[0] === 'pr' && a[1] === 'ready') fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), isDraft: false }));
else if (a[0] === 'pr' && a[1] === 'comment') { /* recorded in gh-calls */ }
else if (a[0] === 'pr' && a[1] === 'list') console.log('[]');
else if (a[0] === 'workflow' && a[1] === 'run' && fs.existsSync('$T/wf-refuse-' + a[a.length - 1].replace('pr=', ''))) { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
else if (a[0] === 'workflow' && a[1] === 'run') console.log('https://github.com/acme/widgets/actions/runs/77' + a[a.length - 1].replace('pr=', ''));
else if (a[0] === 'api' && /\/issues\/\d+\/events/.test(a[2])) { try { process.stdout.write(fs.readFileSync('$T/fr/' + a[2].match(/issues\/(\d+)\//)[1] + '.events', 'utf8')); } catch { /* not put back to draft */ } }
else if (a[0] === 'api' && /check-runs\/\d+\/annotations$/.test(a[1] ?? '')) { try { process.stdout.write(fs.readFileSync('$T/fr/notes-' + a[1].match(/check-runs\/(\d+)\//)[1] + '.json', 'utf8')); } catch { process.exit(1); } }
else process.exit(1);
EOF
chmod +x "$T/stub/gh"
}
# frx <n> <head> <reviewed sha> <counts> [inline]: PR #n for fr_gh, its review's verdict at <reviewed sha>.
# A P1 count lists one P1 finding in the body, or none with inline.
frx(){
  node -e 'const [dir, n, head, sha, counts, inline] = process.argv.slice(1);
    const p1 = /p1=[1-9]/.test(counts) && !inline ?["", "P1 (1)", " src/money.ts:12         second currency formatter", "", "P2 (1)", " src/pager.ts:1   no consumer"] : [];
    const body = ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${sha} ${counts} deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex round=1 -->`, "**desk-review, round 1**", ...p1].join("\n");
    require("fs").writeFileSync(`${dir}/${n}.json`, JSON.stringify({ state: "OPEN", url: `https://github.com/acme/widgets/pull/${n}`, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", headRefOid: head, body: "## Summary",
      reviews: [{ id: `PRR_${n}`, author: { login: "ben" }, body }], statusCheckRollup: [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }] }))' "$T/fr" "$@"
}
# A repo config whose §3 lets the pass undraft and whose §4 names desk-review's clean verdict.
config_r(){
cat > "$T/config-r.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 1. Identity
| Field | Value |
|---|---|
| GitHub handle | \`ben\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`pr-ready\` | Undraft PRs | \`yes\` | \`yes\` |

## 4. Checks
| Field | Value |
|---|---|
| Required checks | \`tests\` |
| Local review command | \`/desk-review\` |
| Clean review verdict | \`p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0\` |
EOF
}

