#!/usr/bin/env bash
# suite: batch end to end (triage records to done, offline, scripted workers)
# One autopilot batch driven through the real queue.mjs admit, pass.mjs, setup-worktree.sh,
# spawn-worker.sh (preflight included), harvest.mjs and answer.mjs. Only `claude` and `gh` are
# replaced, by scripts on PATH: the fake claude answers the preflight checks and
# `claude agents --json`, and plays each worker from tests' own script, one per ticket and round.
# PATH holds nothing but the fakes and the system directories, git refuses every network protocol,
# and origin is a local bare repo, so a real claude, gh, codex or desk-jira is never reachable.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
NODE="$(node -p process.execPath)"   # the binary itself, never a version manager's shim
T="$(mktemp -d)"; T="$(cd "$T" && pwd -P)"
mkdir -p "$T/home" "$T/state/triage" "$T/stub" "$T/wt" "$T/live" "$T/runs" "$T/scripts" "$T/go"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
# No network for git: every transport but a local file is refused.
git config --global protocol.allow never; git config --global protocol.file.allow always
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_BIN DESK_QUEUE DESK_SKILLS_DIR DESK_MEMORY_DIR DESK_GH_REPO DESK_CONFIG_ROOT DESK_ENV_MJS DESK_ENV_DIR \
  DESK_AUTOPILOT_WORKER CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_TASK AUTOPILOT_RESUME \
  AUTOPILOT_PREFLIGHT AUTOPILOT_BATCH_BUDGET_USD AUTOPILOT_USER_APPROVED DESK_UPLOAD_APPROVED GH_TOKEN GITHUB_TOKEN
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
cleanup(){ for f in "$T"/live/*.json; do [ -f "$f" ] && kill "$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$f")" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT

# A repo whose origin is a local bare repo.
git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin main
# config [<Worker models row value>]: no value leaves the row out, which reads as `default`. $SLICE, when
# set, is the Promotion slice size row.
config(){ local models="" slice=""; [ -n "${1:-}" ] && models="| Worker models | \`default\` | \`$1\` |"
  [ -n "${SLICE:-}" ] && slice="| Promotion slice size (children) | \`8\` | \`$SLICE\` |"
  [ -n "$slice" ] && models="${models:+$models
}$slice"
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

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`git-commit\` | Commit | \`yes\` | \`yes\` |
| \`git-push\` | Push | \`yes\` | \`yes\` |
| \`pr-open\` | Open a draft PR | \`yes\` | \`yes\` |
| \`pr-edit\` | Edit a PR | \`yes\` | \`yes\` |
| \`codex-review\` | Codex | \`yes\` | \`no\` |
| \`pr-ready\` | Undraft | \`yes\` | \`yes\` |
| \`batch-base-push\` | Push to a batch base | \`ask\` | \`yes\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Autopilot worker concurrency | \`2 / 3\` | \`3 / 3\` |
| Autopilot per-worker budget (USD) | \`25\` | \`none\` |
| Preferred dev-server port | \`3000\` | \`$DEV_PORT\` |
$models

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`T-[0-9]+\` |
| Project subagents sync | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Typecheck | \`sh tc.sh\` |
| Lint | \`sh lint.sh\` |
| Unit tests | \`bash tests/run.sh\` |
| Acceptance specs | \`tests/acceptance/\` \`bash tests/acceptance/run.sh {ids}\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
EOF
}
DEV_PORT=$((20000 + RANDOM % 20000))
config

# The fake claude. `agents --json` lists the fake workers whose process is alive. `-p` with the
# preflight prompt answers each check the way an isolated worker does. Any other `-p` is a worker:
# it records its round (prompt, system prompt, cwd), registers its session, then plays
# scripts/<TICKET>.<round> one line at a time: WAIT blocks until go/<TICKET> appears, and every other
# line is printed as one assistant turn, the way a real worker's stream-json log carries markers.
cat > "$T/stub/claude" <<EOF
#!$NODE
const fs = require('fs');
const T = '$T';
const a = process.argv.slice(2);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const at = (flag) => a[a.indexOf(flag) + 1];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (a[0] === 'agents') {
  fs.appendFileSync(T + '/calls.log', 'claude agents\n');
  nap(150);
  const live = fs.readdirSync(T + '/live').map((f) => { try { return JSON.parse(fs.readFileSync(T + '/live/' + f, 'utf8')); } catch { return null; } })
    .filter((x) => x && alive(x.pid));
  console.log(JSON.stringify(live));
  process.exit(0);
}
const prompt = at('-p') ?? '';
// --model, as the real CLI takes it: a model it does not know fails the call before any turn.
const model = a.includes('--model') ? at('--model') : 'none';
if (model === 'no-such-model' || model === 'nosuchalias') {
  console.error("There's an issue with the selected model (" + model + "). It may not exist or you may not have access to it.");
  process.exit(1);
}
if (prompt.startsWith('Reply with exactly one word: MODEL_OK')) {
  fs.appendFileSync(T + '/calls.log', 'claude model-check model=' + model + '\n');
  console.log('MODEL_OK');
  process.exit(0);
}
// The preflight's reply, as one json result carrying its cost and turns with --output-format json, as
// the real CLI writes it. While T/preflight-text exists it replies in plain text: a result with no cost.
if (prompt.startsWith('Perform these')) {
  fs.appendFileSync(T + '/calls.log', 'claude preflight model=' + model + '\n');
  const reply = [...prompt.matchAll(/^(\w+)=OK or \1=BLOCKED/gm)].map((m) => m[1] + '=' + (/^(W_IN|TOOL\d+|JIRA)\$/.test(m[1]) ? 'OK' : 'BLOCKED')).join('\n');
  if (at('--output-format') === 'json' && !fs.existsSync(T + '/preflight-text')) console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 9, total_cost_usd: 0.4321, result: reply }));
  else console.log(reply);
  process.exit(0);
}
const ticket = /Your ticket is (\S+?)\./.exec(prompt)?.[1];
const sid = at('--session-id');
fs.appendFileSync(T + '/calls.log', 'claude worker ' + ticket + '\n');
const round = fs.readdirSync(T + '/runs').filter((f) => f.startsWith(ticket + '.')).length + 1;
fs.writeFileSync(T + '/runs/' + ticket + '.' + round, JSON.stringify({ prompt, system: at('--append-system-prompt'), cwd: process.cwd(), sid, model, partial: a.includes('--include-partial-messages') }));
const reg = T + '/live/' + sid + '.json';
fs.writeFileSync(reg, JSON.stringify({ sessionId: sid, pid: process.pid }));
const script = fs.readFileSync(T + '/scripts/' + ticket + '.' + round, 'utf8').split('\n').filter(Boolean);
const deadline = Date.now() + 60000;
for (const line of script) {
  if (line === 'WAIT') {
    const go = T + '/go/' + ticket;
    while (!fs.existsSync(go) && Date.now() < deadline) nap(50);
    try { fs.unlinkSync(go); } catch {}
  } else {
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: line }] } }));
  }
}
// A session that ends on its own closes its log with a result event, as the real CLI does.
console.log(JSON.stringify({ type: 'result', is_error: false, num_turns: script.length, result: '' }));
fs.unlinkSync(reg);
EOF
# The fake gh: `pr view <n>` says the PR is open, or what pr/<n> holds, `pr list` finds no PR, and
# `pr create` opens PR #200, or the number in pr/next. A PR's comments are pr/<n>.comments (JSON), added by `pr comment` and
# edited by `api -X PATCH .../issues/comments/<id>`, and unreadable while pr/<n>.unreadable exists.
# A PR's body is pr/<n>.body, written by `pr edit --body-file -` or `api -X PATCH .../pulls/<n>`, so a
# body write shows up in the ledger checks. Every call is logged to gh.log.
mkdir -p "$T/pr"
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/gh.log', a.join(' ') + '\n');
const cf = (n) => '$T/pr/' + n + '.comments';
const cs = (n) => { try { return JSON.parse(fs.readFileSync(cf(n), 'utf8')); } catch { return []; } };
const url = (id) => 'https://github.com/acme/widgets/pull/200#issuecomment-' + id;
if (a[0] === 'pr' && a[1] === 'view' && a.includes('comments')) {
  if (fs.existsSync('$T/pr/' + a[2] + '.unreadable')) { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
  console.log(JSON.stringify({ comments: cs(a[2]) })); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'comment') {
  const c = cs(a[2]); const id = 900 + c.length;
  c.push({ viewerDidAuthor: true, body: fs.readFileSync(0, 'utf8'), url: url(id) });
  fs.writeFileSync(cf(a[2]), JSON.stringify(c)); console.log(url(id)); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'edit' && a.includes('--body-file')) { fs.writeFileSync('$T/pr/' + a[2] + '.body', fs.readFileSync(0, 'utf8')); process.exit(0); }
if (a[0] === 'api' && a[1] === '-X' && a[2] === 'PATCH' && /\/pulls\/\d+$/.test(a[3])) {
  fs.writeFileSync('$T/pr/' + a[3].split('/').pop() + '.body', JSON.parse(fs.readFileSync(0, 'utf8')).body ?? ''); console.log('{}'); process.exit(0);
}
if (a[0] === 'api' && a[1] === '-X' && a[2] === 'PATCH' && a[3].includes('/issues/comments/')) {
  const id = a[3].split('/').pop(); const c = cs(200); const hit = c.find((x) => x.url === url(id));
  if (!hit) { console.error('HTTP 404: Not Found'); process.exit(1); }
  hit.body = JSON.parse(fs.readFileSync(0, 'utf8')).body; fs.writeFileSync(cf(200), JSON.stringify(c)); console.log('{}'); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'view') {
  let s = 'OPEN'; try { s = fs.readFileSync('$T/pr/' + a[2], 'utf8').trim(); } catch {}
  let m; try { m = fs.readFileSync('$T/pr/' + a[2] + '.merged_at', 'utf8').trim(); } catch {}
  console.log(a.includes('--json') && !a.includes('--jq') ? JSON.stringify({ state: s, url: 'https://github.com/acme/widgets/pull/' + a[2], statusCheckRollup: [], mergedAt: m, isDraft: fs.existsSync('$T/pr/' + a[2] + '.draft') ? true : fs.existsSync('$T/pr/' + a[2] + '.ready') ? false : undefined }) : s);
}
// A PR opened as a draft, or marked ready, says so; one this stub never opened reads as before.
const mark = (n, k) => { for (const x of ['draft', 'ready']) fs.rmSync('$T/pr/' + n + '.' + x, { force: true }); fs.writeFileSync('$T/pr/' + n + '.' + k, ''); };
if (a[0] === 'pr' && a[1] === 'ready') mark(a[2], a.includes('--undo') ? 'draft' : 'ready');
if (a[0] === 'pr' && a[1] === 'create') { let n = '200'; try { n = fs.readFileSync('$T/pr/next', 'utf8').trim(); } catch {} if (a.includes('--draft')) mark(n, 'draft'); console.log('https://github.com/acme/widgets/pull/' + n); }
EOF
chmod +x "$T/stub/claude" "$T/stub/gh"
# The bodies of PR #200's ledger comments, and how many there are.
ledger() { "$NODE" -e 'let c = []; try { c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {} for (const x of c) if (x.body.startsWith("<!-- desk-autopilot:ledger -->")) console.log(x.body);' "$T/pr/200.comments"; }
ledgers() { ledger | grep -c "^<!-- desk-autopilot:ledger -->"; }
ln -s "$NODE" "$T/stub/node"

export PATH="$T/stub:/usr/bin:/bin:/usr/sbin:/sbin" DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" \
  DESK_SKILLS_DIR="$SRC/skills" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" \
  AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test-orchestrator \
  DESK_LOCK_DIR="$T/locks"   # pass.mjs runs a child's specs under the test lock: never the box's, which this suite may be under
mkdir -p "$T/locks"
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
pass(){ out=$(node "$B/pass.mjs" 2>&1); rc=$?; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
state(){ field "$1" state | tr -d '"'; }
# A batch-level field of the queue, as JSON.
bfield(){ node -e 'const q = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify(process.argv[2].split(".").reduce((o, k) => o?.[k], q) ?? null))' "$DESK_QUEUE" "$1"; }
# A triage record as triage.sh writes one: the fields queue.mjs admit reads, and pass.mjs's size.
# record <TICKET> <file> [lane, default A] [size, default S; - for none]
record(){ local size="\"${4:-S}\""; [ "${4:-}" = - ] && size=null
  printf '{"ticket": "%s", "type": "Bug", "lane": "%s", "size": %s, "branch": "fix/%s", "files_in_scope": ["%s"], "unknowns": []}\n' "$1" "${3:-A}" "$size" "$1" "$2" > "$T/state/triage/$1.json"; }
# The model a ticket's worker was started with, by round.
ran_on(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).model)' "$T/runs/$1.$2"; }
# Let a scripted worker past its WAIT, then wait for its process to end.
finish(){ local sid; sid=$(field "$1" session_id | tr -d '"'); touch "$T/go/$1"
  for _ in $(seq 1 100); do [ -e "$T/live/$sid.json" ] || return 0; sleep 0.1; done; echo "worker $1 did not exit"; }
live(){ local sid; sid=$(field "$1" session_id | tr -d '"'); [ -e "$T/live/$sid.json" ]; }

out=$(command -v claude gh codex desk-jira 2>&1)
check "only the fakes are on PATH: no real claude, gh, codex or desk-jira" '[ "$out" = "$(printf "%s\n%s" "$T/stub/claude" "$T/stub/gh")" ]'
q init e2e

# ---- AC1 + AC2: two independent tickets and a third that collides with the first ------------------
record T-1 src/a.txt; record T-2 src/b.txt; record T-3 src/a.txt
printf 'WAIT\nAUTOPILOT_STAGE: 4/9 verify\nAUTOPILOT_DONE: pr=101 jira=none\n' > "$T/scripts/T-1.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=102 jira=none\n' > "$T/scripts/T-2.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=103 jira=none\n' > "$T/scripts/T-3.1"
for k in T-1 T-2 T-3; do q admit "$k"; done
check "admit reads the fixture records and marks the collision" '[ "$(state T-3)" = triaged ] && [ "$(field T-3 collides_with)" = "\"T-1\"" ]'

pass
check "the first pass spawns both independent tickets, and exits 0" '[ $rc -eq 0 ] && [ "$(state T-1)" = running ] && [ "$(state T-2)" = running ] && live T-1 && live T-2'
check "the colliding ticket does not spawn beside its blocker" '[ "$(state T-3)" = triaged ] && [ ! -e "$T/runs/T-3.1" ] && echo "$out" | grep -q "held back by a collision: T-3"'
check "each worker runs in its own worktree on its own branch"  'grep -q "\"cwd\":\"$T/wt/T-1\"" "$T/runs/T-1.1" && [ "$(git -C "$T/wt/T-1" branch --show-current)" = fix/T-1 ]'
check "each worker passed a real preflight first"               '[ "$(grep -c "^claude preflight" "$T/calls.log")" = 2 ]'
check "DS-158 AC1 each spawn line shows its preflight's cost and turns" '[ "$(echo "$out" | grep "^spawned: " | grep -o "preflight \$0.43, 9 turn(s)" | wc -l | tr -d " ")" = 2 ]'
check "DS-158 AC1 and the ticket's log holds them, ahead of the worker" 'head -1 "$T/state/logs/T-1.log" | grep -q "\"type\":\"desk_preflight\",\"total_cost_usd\":0.4321,\"num_turns\":9"'
check "DS-158 AC4 a worker is started with no partial messages" 'grep -q "\"partial\":false" "$T/runs/T-1.1" && grep -q "\"partial\":false" "$T/runs/T-2.1"'
REFS="$SRC/skills/desk-autopilot/references"
check "a ticket worker's system prompt holds the core contract and its briefing" 'grep -q "Stage sections: read each one when you reach it" "$T/runs/T-1.1" && grep -q "# Briefing for this ticket" "$T/runs/T-1.1"'
check "and no stage section: verification, command forms, the orchestrator's part, Jira, the task" '! grep -qE "## 3\. Verification|### Self-review|## 6\. Command forms|## 5\. What the orchestrator|### Jira comments|## 0\. If you were given a task|## Review-sweep" "$T/runs/T-1.1"'
check "and the directory its stage sections are read from" 'grep -q "in \`$REFS\`" "$T/runs/T-1.1" && ! grep -q "{{STAGE_DIR}}" "$T/runs/T-1.1"'
check "with no Worker models row, no worker or preflight is passed a model" '[ "$(ran_on T-1 1)" = none ] && [ "$(ran_on T-2 1)" = none ] && [ "$(grep -c "^claude preflight model=none$" "$T/calls.log")" = 2 ] && [ "$(field T-1 model)" = "\"default\"" ]'

pass
check "a pass while both run spawns nothing more, and exits 10" '[ $rc -eq 10 ] && [ "$(state T-3)" = triaged ] && [ ! -e "$T/runs/T-3.1" ]'

finish T-1; finish T-2
touch "$T/preflight-text"
pass
rm -f "$T/preflight-text"
check "DS-158 AC3 a preflight that gives no result says its cost is unknown, not zero" 'echo "$out" | grep "^spawned: " | grep -q "T-3 .*; preflight cost unknown, turns unknown"'
check "both tickets reach done with the PRs their workers printed" '[ "$(state T-1)" = done ] && [ "$(field T-1 result.pr)" = 101 ] && [ "$(state T-2)" = done ] && [ "$(field T-2 result.pr)" = 102 ]'
check "the stage a worker printed is recorded"                  '[ "$(field T-1 stage)" = "\"4/9\"" ]'
check "the held ticket spawns once its blocker has finished"    '[ $rc -eq 0 ] && [ "$(state T-3)" = running ] && live T-3'

finish T-3
for n in 101 102 103; do echo MERGED > "$T/pr/$n"; done
pass
check "the held ticket reaches done"                           '[ "$(state T-3)" = done ] && [ "$(field T-3 result.pr)" = 103 ]'
check "the batch stops spawning: IDLE, and the finished batch exits 11" '[ $rc -eq 11 ] && echo "$out" | grep -q "^IDLE"'
pass
check "a further pass spawns nothing"                           '[ "$(grep -c "^claude worker" "$T/calls.log")" = 3 ] && echo "$out" | grep -q "^IDLE"'

# ---- AC2: a ticket held behind another's PR does not spawn while its blocker runs -----------------
record T-4 src/c.txt; record T-5 src/d.txt
printf 'WAIT\nAUTOPILOT_DONE: pr=104 jira=none\n' > "$T/scripts/T-4.1"
q admit T-4; q admit T-5; q hold T-5 T-4
pass; finish T-4
pass
check "a finished blocker with an open PR keeps the batch waiting on its merge, exit 10" '[ $rc -eq 10 ] && [ "$(state T-4)" = done ] && [ "$(state T-5)" = parked ] && [ ! -e "$T/runs/T-5.1" ] && echo "$out" | grep -q "WAITING ON MERGE: T-5 (T-4)" && ! echo "$out" | grep -q "^IDLE"'
q drop T-5

# ---- AC3: a worker parks with a question; answered and requeued, a second worker finishes it ------
record T-6 src/e.txt
printf 'WAIT\nAUTOPILOT_STAGE: 2/9 understand\nAUTOPILOT_PARK: which fixture helper should the spec use?\n' > "$T/scripts/T-6.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=106 jira=none\n' > "$T/scripts/T-6.2"
q admit T-6
pass; finish T-6
pass
check "a worker that parks leaves the ticket parked with its question, exit 11" '[ $rc -eq 11 ] && [ "$(state T-6)" = parked ] && field T-6 park | grep -q "which fixture helper"'
out=$(node "$B/answer.mjs" T-6 "use makeFixture from tests/helpers" 2>&1); arc=$?
out=$(node "$B/queue.mjs" requeue T-6 2>&1); rc=$?
check "the answered ticket requeues, answer and requeue exit 0" '[ $arc -eq 0 ] && [ $rc -eq 0 ] && [ "$(state T-6)" = triaged ]'
pass
check "a second worker spawns for the requeued ticket, exit 0"  '[ $rc -eq 0 ] && [ "$(state T-6)" = running ] && [ -e "$T/runs/T-6.2" ]'
check "the second worker's briefing carries the answer"         'grep -q "use makeFixture from tests/helpers" "$T/runs/T-6.2"'
finish T-6
pass
check "the requeued ticket reaches done with the second worker's PR" '[ "$(state T-6)" = done ] && [ "$(field T-6 result.pr)" = 106 ]'

# ---- DS-155: a worker hands off at the end of Stage 4, and a fresh session takes Stage 4b ---------
# Its 4b session fails, the requeue raises it to the high model, and the next 4b session hands off to 7.
# The row names a text model, which only the Stage 7 session runs on.
config "standard=sonnet high=opus text=haiku"
record T-80 src/h.txt
printf 'WAIT\nAUTOPILOT_STAGE: 4/9 verify\nAUTOPILOT_HANDOFF: 4b\n' > "$T/scripts/T-80.1"
printf 'WAIT\nAUTOPILOT_STAGE: 4b/9 self-review\n' > "$T/scripts/T-80.2"
printf 'WAIT\nAUTOPILOT_STAGE: 6/9 hygiene\nAUTOPILOT_HANDOFF: 7\n' > "$T/scripts/T-80.3"
printf 'WAIT\nAUTOPILOT_DONE: pr=180 jira=none\n' > "$T/scripts/T-80.4"
q admit T-80
pass
mkdir -p "$T/state/handoffs"
printf '{"ticket": "T-80", "stage": "4b", "criteria": ["AC1: h saves"], "lane": "A", "verification": ["bash tests/run.sh: pass"], "review": [], "evidence": []}\n' > "$T/state/handoffs/T-80.json"
finish T-80
pass
check "DS-155 AC2 after a handoff the real spawn-worker starts a new session in the same worktree, told to start at Stage 4b" '[ "$(state T-80)" = running ] && [ -e "$T/runs/T-80.2" ] && grep -q "This session starts at Stage 4b" "$T/runs/T-80.2" && grep -q "\"cwd\":\"$T/wt/T-80\"" "$T/runs/T-80.2" && [ "$(node -e "const r = (n) => JSON.parse(require(\"fs\").readFileSync(process.argv[1] + n, \"utf8\")).sid; console.log(r(1) !== r(2))" "$T/runs/T-80.")" = true ]'
check "DS-155 AC2 with the handoff briefing in its system prompt" 'grep -q "# Briefing for this ticket" "$T/runs/T-80.2" && grep -q "## Handoff: this session starts at Stage 4b" "$T/runs/T-80.2" && grep -q "AC1: h saves" "$T/runs/T-80.2" && grep -q "fix/T-80" "$T/runs/T-80.2" && [ "$(ran_on T-80 2)" = sonnet ]'
finish T-80
pass
out=$(node "$B/queue.mjs" requeue T-80 2>&1)
pass
check "DS-155 AC8 a failed handoff session, requeued, starts at Stage 4b again, on the model the requeue raised it to" '[ "$(state T-80)" = running ] && grep -q "This session starts at Stage 4b" "$T/runs/T-80.3" && [ "$(ran_on T-80 3)" = opus ] && [ "$(field T-80 model)" = "\"opus\"" ]'
printf '{"ticket": "T-80", "stage": "7", "criteria": ["AC1: h saves"], "lane": "A", "verification": ["bash tests/run.sh: pass"], "review": ["P2 src/h.txt:1 fixed in abc1234"], "evidence": []}\n' > "$T/state/handoffs/T-80.json"
finish T-80
pass
check "DS-155 AC3 a handoff at the end of Stage 6 starts a new session at Stage 7 through the real spawn-worker" '[ "$(state T-80)" = running ] && grep -q "This session starts at Stage 7" "$T/runs/T-80.4" && grep -q "## Handoff: this session starts at Stage 7" "$T/runs/T-80.4" && grep -q "P2 src/h.txt:1 fixed in abc1234" "$T/runs/T-80.4"'
check "DS-157 AC3 the Stage 7 session runs on the text model, and the batch report shows it" '[ "$(ran_on T-80 4)" = haiku ] && [ "$(field T-80 model)" = "\"haiku\"" ] && echo "$out" | grep -q "T-80 fresh session from Stage 7 (handed off) .*model=haiku"'
check "DS-157 every preflight proved the text model on its own" '[ "$(grep -c "^claude model-check model=haiku$" "$T/calls.log")" = 4 ]'
finish T-80
pass
check "DS-155 the handoff session's DONE finishes the ticket, and a later rework requeue starts from Stage 0" '[ "$(state T-80)" = done ] && [ "$(field T-80 result.pr)" = 180 ] && [ "$(field T-80 handoff_stage)" = null ] && node "$B/queue.mjs" requeue T-80 >/dev/null 2>&1 && [ "$(field T-80 handoff)" = null ]'
q drop T-80
config

# ---- AC4: a worker that exits with no done marker is not done ------------------------------------
record T-7 src/f.txt
printf 'WAIT\nAUTOPILOT_STAGE: 3/9 implement\n' > "$T/scripts/T-7.1"
q admit T-7
pass; finish T-7
pass
check "a worker with no done marker and no PR is reported failed, exit 11 naming it" '[ $rc -eq 11 ] && echo "$out" | grep -q "^NOTIFY: .*T-7" && [ "$(state T-7)" = failed ] && [ "$(field T-7 result)" = null ] && echo "$out" | grep -q "T-7: exited with no marker and no open PR"'
out=$(node "$B/queue.mjs" requeue T-7 2>&1)
check "with no Worker models row, a requeue after a failure claims no model change" '[ "$(field T-7 model_tier)" = null ] && [ "$(field T-7 model_note)" = null ] && ! echo "$out" | grep -q "high model"'
q drop T-7

# ---- a task instead of a ticket: its worker gets the task section and every stage section up front --
record T-60 src/t.txt
printf 'WAIT\nAUTOPILOT_DONE: pr=160 jira=none\n' > "$T/scripts/T-60.1"
q admit T-60
export AUTOPILOT_TASK='Review the open PR for this ticket. Your ticket is $TICKET. Your worktree is $WT.'
pass; unset AUTOPILOT_TASK
check "a task worker is spawned with the task as its prompt" 'grep -q "Review the open PR for this ticket. Your ticket is T-60. Your worktree is $T/wt/T-60" "$T/runs/T-60.1"'
check "its system prompt holds the core, the task section and the review-sweep rules" 'grep -q "Stage sections: read each one when you reach it" "$T/runs/T-60.1" && grep -q "## 0. If you were given a task instead of a ticket" "$T/runs/T-60.1" && grep -q "## Review-sweep tasks: the comment is the deliverable" "$T/runs/T-60.1"'
check "and every stage section, self-review included"                'grep -q "## 3. Verification must cover what CI covers" "$T/runs/T-60.1" && grep -q "### Self-review" "$T/runs/T-60.1" && grep -q "## 6. Command forms that are silently denied" "$T/runs/T-60.1" && grep -q "## 5. What the orchestrator owns, not you" "$T/runs/T-60.1" && grep -q "### Jira comments and transitions follow config" "$T/runs/T-60.1"'
check "the task section sits where section 0 always did: after the header, before section 1" '[ "$(node -e '"'"'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).system; const at = (h) => s.indexOf(h); console.log(at("Read config values with") < at("## 0. If you were given") && at("## 0. If you were given") < at("## 1. You cannot ask"))'"'"' "$T/runs/T-60.1")" = true ]'
finish T-60; pass
q drop T-60

# ---- worker models: a standard and a high model, picked per ticket from its triage ----------------
config "standard=sonnet high=opus"
record T-8 src/g.txt A S; record T-9 src/h.txt B S; record T-10 src/i.txt A M
printf 'WAIT\nAUTOPILOT_STAGE: 3/9 implement\n' > "$T/scripts/T-8.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=108 jira=none\n' > "$T/scripts/T-8.2"
printf 'WAIT\nAUTOPILOT_DONE: pr=109 jira=none\n' > "$T/scripts/T-9.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=110 jira=none\n' > "$T/scripts/T-10.1"
q admit T-8; q admit T-9; q admit T-10
pass
check "a lane A ticket sized S runs on the standard model, and so does its preflight" '[ "$(ran_on T-8 1)" = sonnet ] && [ "$(field T-8 model_tier)" = "\"standard\"" ] && grep -q "^claude preflight model=sonnet$" "$T/calls.log"'
check "a lane B ticket runs on the high model"                  '[ "$(ran_on T-9 1)" = opus ] && [ "$(field T-9 model_tier)" = "\"high\"" ]'
check "a ticket sized M runs on the high model"                 '[ "$(ran_on T-10 1)" = opus ]'
check "the status table shows each running worker's model"      'echo "$out" | grep -qE "RUNNING +T-8 +stage .*model sonnet" && echo "$out" | grep -qE "RUNNING +T-9 +stage .*model opus"'
finish T-8; finish T-9; finish T-10
pass
check "the standard-model worker with no marker is failed"      '[ "$(state T-8)" = failed ]'
out=$(node "$B/queue.mjs" requeue T-8 2>&1)
check "requeueing a failed standard-model ticket raises it to high" '[ "$(field T-8 model_tier)" = "\"high\"" ] && echo "$out" | grep -q "runs on the high model"'
out=$(node "$B/queue.mjs" render 2>&1)
check "the status table shows the change"                       'echo "$out" | grep -qE "TRIAGED +T-8 .*standard → high after a failed worker"'
pass
check "its next worker runs on the high model"                  '[ "$(ran_on T-8 2)" = opus ] && echo "$out" | grep -qE "RUNNING +T-8 .*model opus .*standard → high"'
finish T-8
pass
check "the raised ticket finishes"                              '[ "$(state T-8)" = done ] && [ "$(field T-8 result.pr)" = 108 ]'

# An unsized ticket runs on high; a standard ticket that parks with a question keeps its model.
record T-11 src/j.txt A -; record T-12 src/k.txt A XS
printf 'WAIT\nAUTOPILOT_DONE: pr=111 jira=none\n' > "$T/scripts/T-11.1"
printf 'WAIT\nAUTOPILOT_PARK: which helper should the spec use?\n' > "$T/scripts/T-12.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=112 jira=none\n' > "$T/scripts/T-12.2"
q admit T-11; q admit T-12
pass
check "a ticket with no size runs on the high model"            '[ "$(ran_on T-11 1)" = opus ]'
check "a lane A ticket sized XS runs on the standard model"     '[ "$(ran_on T-12 1)" = sonnet ]'
finish T-11; finish T-12
pass
out=$(node "$B/answer.mjs" T-12 "use makeFixture" 2>&1)
out=$(node "$B/queue.mjs" requeue T-12 2>&1)
check "a requeue after a park with a question keeps the model"  '[ "$(field T-12 model_tier)" = "\"standard\"" ] && [ "$(field T-12 model_note)" = null ] && ! echo "$out" | grep -q "high model"'
pass
check "its next worker runs on the same model"                  '[ "$(ran_on T-12 2)" = sonnet ]'
finish T-12
pass

# A standard-model worker that pass.mjs stops as stalled (six passes with no log growth) is raised
# too, through the park the stall killer itself writes.
record T-13 src/l.txt A S
printf 'WAIT\n' > "$T/scripts/T-13.1"
q admit T-13
pass
check "the silent worker spawns on the standard model"          '[ "$(ran_on T-13 1)" = sonnet ] && live T-13'
for _ in 1 2 3 4 5 6; do pass; done
check "pass.mjs stops the silent worker and parks it as stalled" '[ "$(state T-13)" = parked ] && echo "$out" | grep -q "T-13: no output for 6 passes"'
out=$(node "$B/queue.mjs" requeue T-13 2>&1)
check "requeueing a stalled standard-model ticket raises it to high" '[ "$(field T-13 model_tier)" = "\"high\"" ] && [ "$(field T-13 model_note)" = "\"standard → high after a stalled worker\"" ]'
q drop T-13

# A model the CLI rejects fails that ticket's preflight, naming the value; no worker ran, so a
# requeue keeps the tier.
config "standard=no-such-model high=opus"
record T-14 src/m.txt A S; q admit T-14; q set T-14 model_tier=standard
pass
check "a rejected model fails the preflight with a message naming the value" '[ "$(state T-14)" = failed ] && [ ! -e "$T/runs/T-14.1" ] && echo "$out" | grep -q "T-14: preflight failed" && echo "$out" | grep -q "MODEL .*no-such-model"'
out=$(node "$B/queue.mjs" requeue T-14 2>&1)
check "a requeue after a failed preflight keeps the model"      '[ "$(field T-14 model_tier)" = "\"standard\"" ] && [ "$(field T-14 model_note)" = null ]'
q drop T-14

# DS-157 AC4: a finder or text model the CLI rejects fails the preflight too, though the worker's
# own model is fine, naming the row and the value, and no worker spawns.
config "standard=sonnet high=opus finder=nosuchalias"
record T-16 src/o.txt A S; q admit T-16
pass
check "DS-157 AC4 a rejected finder model fails the preflight, naming the row and the value" '[ "$(state T-16)" = failed ] && [ ! -e "$T/runs/T-16.1" ] && echo "$out" | grep -q "T-16: preflight failed" && echo "$out" | grep -q "FINDER  FAIL .*Worker models names finder=\"nosuchalias\""'
q drop T-16
config "default text=no-such-model"
record T-17 src/p.txt A S; q admit T-17
pass
check "DS-157 AC4 a rejected text model fails it too"            '[ "$(state T-17)" = failed ] && [ ! -e "$T/runs/T-17.1" ] && echo "$out" | grep -q "TEXT  FAIL .*Worker models names text=\"no-such-model\""'
q drop T-17

# A malformed row holds every spawn rather than reading as default.
config "standard=sonnet"
record T-15 src/n.txt A S; q admit T-15
pass
check "a malformed Worker models row holds spawns, naming the row" '[ "$(state T-15)" = triaged ] && [ ! -e "$T/runs/T-15.1" ] && echo "$out" | grep -q "Worker models"'
q drop T-15

# ---- feature spine: checked, parked draft for approval, approved, merged, children released --------
config
q set-batch feature=true spine=T-20 'spine_ids=["AC1","AC2","AC3"]'
record T-20 tests/acceptance/feature.spec.ts; record T-21 src/s.txt; record T-22 src/t.txt
printf 'WAIT\nAUTOPILOT_DONE: pr=120 jira=none\n' > "$T/scripts/T-20.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=120 jira=none\n' > "$T/scripts/T-20.2"
printf 'WAIT\nAUTOPILOT_DONE: pr=120 jira=none\n' > "$T/scripts/T-20.3"
printf 'WAIT\nAUTOPILOT_DONE: pr=121 jira=none\n' > "$T/scripts/T-21.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=122 jira=none\n' > "$T/scripts/T-22.1"
q admit T-20; q admit T-21; q admit T-22; q hold T-21 T-20; q hold T-22 T-20
# spec <path> <content>: the spine worker's commit on its branch.
spec(){ mkdir -p "$(dirname "$T/wt/T-20/$1")"; printf '%s\n' "$2" > "$T/wt/T-20/$1"
  git -C "$T/wt/T-20" add -A && git -C "$T/wt/T-20" commit -q -m "spec $1"; }
pass
check "the spine spawns first and the children it holds do not" '[ "$(state T-20)" = running ] && [ "$(state T-21)" = parked ] && [ ! -e "$T/runs/T-21.1" ]'

# AC2: a spec that is not expected-fail, and an id with no spec.
spec tests/acceptance/feature.spec.ts "import { test } from 'vitest';
test.fails('AC1: a finished spine parks for approval', () => {});
test('AC2: incomplete specs park', () => {});
test.describe('AC3 group', () => {});
// test.fails('AC3: commented out, so not a spec', () => {});"
finish T-20
pass
check "AC2: incomplete specs park the spine naming each problem, exit 11" '[ $rc -eq 11 ] && [ "$(state T-20)" = parked ] && field T-20 park | grep -q "spine specs incomplete" && field T-20 park | grep -q "AC2: .*not marked strict expected-fail" && field T-20 park | grep -q "AC3: no spec titled with it"'
check "AC2: no approval is offered"                             '! field T-20 park | grep -q "approve" && ! echo "$out" | grep -q "queue.mjs approve"'
out=$(node "$B/queue.mjs" approve T-20 2>&1); rc=$?
check "AC2: approve refuses a spine whose specs failed the check" '[ $rc -eq 11 ] && echo "$out" | grep -q "failed the check" && [ "$(state T-20)" = parked ]'
check "AC2: the children wait on the spine, not STUCK"          '! echo "$(node "$B/queue.mjs" render)" | grep -q STUCK && [ "$(state T-21)" = parked ]'
out=$(node "$B/queue.mjs" reject T-20 "AC2 must be marked expected-fail and AC3 needs a spec" 2>&1); rc=$?
check "the spine is sent back with a note"                      '[ $rc -eq 0 ] && [ "$(state T-20)" = triaged ] && [ "$(state T-21)" = parked ]'
pass
check "a new spine worker gets the note"                        '[ "$(state T-20)" = running ] && grep -q "AC3 needs a spec" "$T/runs/T-20.2"'

# AC1 + AC3: one strict expected-fail spec per id, in TypeScript and in Python.
spec tests/acceptance/feature.spec.ts "import { test, it } from 'vitest';
test.fails('AC1: a finished spine parks for approval', () => {});
it.fails('AC2: incomplete specs park', () => {});"
spec tests/acceptance/test_feature.py "import pytest

@pytest.mark.xfail(
    strict=True, reason='not built yet')
def test_ac3_children_wait():
    assert False"
finish T-20
pass
check "AC1: complete specs park the spine for approval"          '[ "$(state T-20)" = parked ] && field T-20 park | grep -q "spine awaiting approval" && [ "$(field T-20 result.pr)" = 120 ]'
check "AC1: its PR stays draft"                                  '! grep -q "pr ready" "$T/gh.log"'
check "AC3: the children show as waiting on approval, not STUCK, and the pass exits 11" '[ $rc -eq 11 ] && echo "$out" | grep -q "WAITING ON APPROVAL: T-21 (spine T-20), T-22 (spine T-20)" && ! echo "$out" | grep -q STUCK && echo "$out" | grep -q "T-20: SPINE APPROVAL"'
check "AC3: the batch is not reported idle"                      '! echo "$out" | grep -q "^IDLE" && ! echo "$out" | grep -q "batch is finished"'

# AC7: rejected with a note from the approval park: a new worker gets it, and nothing is released.
out=$(node "$B/queue.mjs" reject T-20 "AC1's spec checks the wrong state" 2>&1); rc=$?
# Even with its PR merged by hand, a rejected spine releases nothing.
echo MERGED > "$T/pr/120"
pass
check "AC7: a new spine worker gets the note"                    '[ $rc -eq 0 ] && [ "$(state T-20)" = running ] && [ "$(field T-20 approved)" = null ] && grep -q "checks the wrong state" "$T/runs/T-20.3"'
check "AC7: nothing is released"                                 '[ "$(state T-21)" = parked ] && [ "$(state T-22)" = parked ] && [ ! -e "$T/runs/T-21.1" ] && ! echo "$out" | grep -q "RELEASE DUE"'
rm "$T/pr/120"
finish T-20
pass
check "the reworked spine parks for approval again"             '[ "$(state T-20)" = parked ] && field T-20 park | grep -q "spine awaiting approval"'

# AC4 + AC5: approved, the spine is done and its PR leaves draft; with no merge grant the person merges.
out=$(node "$B/queue.mjs" approve T-20 2>&1); rc=$?
check "AC4: approve marks the spine done and undrafts its PR"    '[ "$(state T-20)" = done ] && [ "$(field T-20 approved)" = true ] && grep -q "^pr ready 120 --repo acme/widgets" "$T/gh.log"'
check "AC5: with no merge grant, approve asks the person to merge the spine PR" '[ $rc -eq 11 ] && echo "$out" | grep -q "merge PR #120 yourself" && echo "$out" | grep -q "T-21, T-22 are released once it merges"'
pass
check "AC5: the pass report asks for the merge too, and the children are not released" '[ $rc -eq 11 ] && echo "$out" | grep -q "T-20: SPINE APPROVED — merge PR #120" && [ "$(state T-21)" = parked ] && echo "$out" | grep -q "WAITING ON MERGE: T-21 (T-20)"'

# AC6: once the spine PR merges, the children are released and spawn on a later pass.
echo MERGED > "$T/pr/120"
pass
check "AC6: a merged spine makes the children due for release" 'echo "$out" | grep -q "T-21: RELEASE DUE" && echo "$out" | grep -q "T-22: RELEASE DUE" && ! echo "$out" | grep -q "SPINE APPROVED"'
for k in T-21 T-22; do q set "$k" state=triaged park=null held_by=null; q front "$k"; done
pass
check "AC6: the released children spawn"                         '[ "$(state T-21)" = running ] && [ "$(state T-22)" = running ]'
finish T-21; finish T-22
pass

# An approved spine sent back again needs a fresh approval, and its PR back in draft.
out=$(node "$B/queue.mjs" requeue T-20 2>&1)
check "requeueing an approved spine clears its approval and says its PR left draft" '[ "$(field T-20 approved)" = null ] && echo "$out" | grep -q "gh pr ready 120 --repo acme/widgets --undo"'
q drop T-20

# ---- feature children: each makes the specs it owns pass and leaves the others alone ----------------
# The merged spine's specs on main, and an acceptance runner that logs the ids it was given and fails
# any id listed in tests/acceptance/failing on the branch.
mkdir -p "$T/repo/tests/acceptance"
SPECS="import { test } from 'vitest';
test.fails('AC1: an owner makes its spec pass', () => {});
test.fails('AC2: a failing spec parks', () => {});
test.fails('AC3: other specs are left alone', () => {});"
printf '%s\n' "$SPECS" > "$T/repo/tests/acceptance/feature.spec.ts"
cat > "$T/repo/tests/acceptance/run.sh" <<EOF
echo "\$1" >> "$T/specs-run.log"
grep -qx "\$1" tests/acceptance/failing 2>/dev/null && { echo "\$1 failed: expected true, got false"; exit 1; }
exit 0
EOF
git -C "$T/repo" add -A && git -C "$T/repo" commit -q -m "spine specs" && git -C "$T/repo" push -q origin main
q set-batch 'owners={"AC1":"T-31","AC2":"T-32","AC3":"T-33"}'
record T-31 src/u.txt; record T-32 src/v.txt; record T-33 src/w.txt; record T-34 src/x.txt
for k in T-31 T-32 T-33 T-34; do printf 'WAIT\nAUTOPILOT_DONE: pr=1%s jira=none\n' "${k#T-}" > "$T/scripts/$k.1"; q admit "$k"; done
printf 'WAIT\nAUTOPILOT_DONE: pr=132 jira=none\n' > "$T/scripts/T-32.2"
printf 'WAIT\nAUTOPILOT_DONE: pr=132 jira=none\n' > "$T/scripts/T-32.3"
# commit_in <TICKET> <path> <content>: the child worker's commit on its branch; content - deletes it.
commit_in(){ if [ "$3" = - ]; then git -C "$T/wt/$1" rm -q "$2"; else mkdir -p "$(dirname "$T/wt/$1/$2")"; printf '%s\n' "$3" > "$T/wt/$1/$2"; fi
  git -C "$T/wt/$1" add -A && git -C "$T/wt/$1" commit -q -m "$1 $2"; }
# unmark <id> [<spec text>]: the spec text with that id's expected-fail marker removed.
unmark(){ printf '%s\n' "${2:-$SPECS}" | sed "s/test.fails('$1:/test('$1:/"; }
pass
brief31="$T/state/briefings/T-31.md"
check "AC1: a child that owns a criterion is told which spec it owns and to make it pass" 'grep -q "^## Acceptance specs you own" "$brief31" && grep -qF -- "- AC1: \"AC1: an owner makes its spec pass\" in tests/acceptance/feature.spec.ts" "$brief31" && grep -q "remove the marker that makes it strict expected-fail" "$brief31" && grep -q "make it pass" "$brief31"'
check "AC1: it is told only its own spec, and the run that checks it" '! grep -q "AC2: a failing spec parks" "$brief31" && grep -qF "bash tests/acceptance/run.sh AC1" "$brief31"'
check "AC1: the worker gets that section in its instructions" 'grep -q "Acceptance specs you own" "$T/runs/T-31.1"'

# AC2: T-31 unmarks its spec, and it passes.
commit_in T-31 tests/acceptance/feature.spec.ts "$(unmark AC1)"
# AC3: T-32 leaves its spec marked expected-fail.
commit_in T-32 src/v.txt "built"
# AC4: T-33 makes its own spec pass but also changes AC1's, which T-31 owns.
commit_in T-33 tests/acceptance/feature.spec.ts "$(unmark AC3 | sed "s/'AC1: an owner makes its spec pass', () => {}/'AC1: an owner makes its spec pass', () => { expect(1).toBe(1); }/")"
finish T-31; finish T-32; finish T-33
pass
check "AC2: an owner whose spec is unmarked and passes is done, as today" '[ "$(state T-31)" = done ] && [ "$(field T-31 result.pr)" = 131 ] && [ "$(field T-31 spec_check.ok)" = true ]'
check "the pass runs only the child's own specs" 'grep -qx "AC1" "$T/specs-run.log" && ! grep -q "AC2\|AC3" "$T/specs-run.log"'
check "AC3: an owned spec still marked expected-fail parks naming it" '[ "$(state T-32)" = parked ] && field T-32 park | grep -q "acceptance specs not done: AC2: .*AC2: a failing spec parks.* in tests/acceptance/feature.spec.ts is still marked expected-fail" && echo "$out" | grep -q "^PARKED:"'
check "AC4: a child that changed a spec another child owns parks naming the spec and its owner" '[ "$(state T-33)" = parked ] && field T-33 park | grep -q "AC1: an owner makes its spec pass.* in tests/acceptance/feature.spec.ts is AC1'\''s spec, owned by T-31: T-33 changed it"'
check "AC4: its own spec passing is not what parked it" '! field T-33 park | grep -q "AC3:"'
check "a child that owns nothing has no section, and runs as today" 'live T-34 && ! grep -q "Acceptance specs you own" "$T/state/briefings/T-34.md"'
finish T-34
pass
check "a child that owns nothing is done without a spec check"  '[ "$(state T-34)" = done ] && [ "$(field T-34 spec_check)" = null ]'

# AC3: unmarked but failing when run parks too, naming the spec; fixed, it is done.
node "$B/answer.mjs" T-32 "remove the marker on AC2's spec and make it pass" >/dev/null 2>&1; q requeue T-32
pass
commit_in T-32 tests/acceptance/feature.spec.ts "$(unmark AC2)"
commit_in T-32 tests/acceptance/failing "AC2"
finish T-32
pass
check "AC3: an owned spec that fails when run parks naming it"  '[ "$(state T-32)" = parked ] && field T-32 park | grep -q "acceptance specs not done: AC2: .*AC2: a failing spec parks.* in tests/acceptance/feature.spec.ts fails when run (bash tests/acceptance/run.sh AC2): AC2 failed"'
node "$B/answer.mjs" T-32 "AC2 still fails" >/dev/null 2>&1; q requeue T-32
pass
commit_in T-32 tests/acceptance/failing -
finish T-32
pass
check "AC3: once it passes the child is done"                   '[ "$(state T-32)" = done ] && [ "$(field T-32 spec_check.ok)" = true ] && [ "$(field T-32 park)" = null ]'

# ---- feature mode on a batch base: a draft promotion PR at the start, the base gate at the end ------
# tc.sh, lint.sh and tests/run.sh stand in for §4 Typecheck, Lint and Unit tests: each logs where it
# ran to checks.log, and fails while a broken-<name> file is on the branch.
check_script(){ mkdir -p "$(dirname "$T/repo/$2")"
  printf 'echo "%s $(pwd)" >> "%s/checks.log"\n[ ! -e broken-%s ] || { echo "%s failed: broken-%s is here"; exit 1; }\n' "$1" "$T" "$1" "$1" "$1" > "$T/repo/$2"; }
check_script tc tc.sh; check_script lint lint.sh; check_script tests tests/run.sh
git -C "$T/repo" add -A && git -C "$T/repo" commit -q -m "base checks" && git -C "$T/repo" push -q origin main
# Wait for the background gate to write its result.
wait_gate(){ for _ in $(seq 1 300); do [ "$(bfield gate.state)" = '"running"' ] || return 0; sleep 0.1; done; echo "the base gate did not finish"; }

# AC2: a base protected against the empty commit: no promotion PR, the refusal reported, the batch carries on.
git -C "$T/repo" push -q origin main:feat/R
printf '#!/bin/sh\nwhile read -r old new ref; do [ "$ref" = refs/heads/feat/R ] && { echo "error: GH006: Protected branch update failed for $ref." >&2; exit 1; }; done\nexit 0\n' > "$T/origin.git/hooks/pre-receive"
chmod +x "$T/origin.git/hooks/pre-receive"
q init refused; q set-batch base=feat/R epic=E-1 feature=true
record T-50 src/r.txt; printf 'WAIT\nAUTOPILOT_DONE: pr=150 jira=none\n' > "$T/scripts/T-50.1"; q admit T-50
: > "$T/gh.log"
pass
check "AC2: a refused empty-commit push opens no promotion PR" '! grep -q "^pr create" "$T/gh.log" && [ "$(git -C "$T/origin.git" rev-parse feat/R)" = "$(git -C "$T/origin.git" rev-parse main)" ] && [ "$(bfield promotion.pr)" = null ]'
check "AC2: the report names the refusal under WAITING ON YOU" 'echo "${out#*WAITING ON YOU}" | grep -q "promotion PR: not opened — the push of an empty commit to feat/R was refused: .*GH006"'
check "AC2: the batch carries on: the child spawns"              '[ "$(state T-50)" = running ]'
pass
check "AC2: it is tried once, not on every pass"                '! grep -q "^pr create" "$T/gh.log" && ! echo "$out" | grep -q "promotion PR: not opened"'
rm "$T/origin.git/hooks/pre-receive"
finish T-50
pass
check "a child whose PR is still open keeps the gate waiting, and the batch not idle" 'echo "$out" | grep -q "BASE GATE: waits on T-50 (PR #150) merging into feat/R, and no merge driver is running" && ! echo "$out" | grep -q "^IDLE" && [ "$(bfield gate)" = null ]'
echo CLOSED > "$T/pr/150"
pass
check "a child PR closed without merging: the gate does not run, and the batch reaches the person" 'echo "${out#*WAITING ON YOU}" | grep -q "BASE GATE: not run, since T-50 (PR #150 closed without merging) cannot merge into feat/R" && echo "$out" | grep -q "^IDLE" && [ "$(bfield gate)" = null ]'

# AC1: a base with nothing beyond main gets one empty commit and a draft promotion PR titled with the epic key.
git -C "$T/repo" push -q origin main:feat/E
q init feature; q set-batch base=feat/E epic=E-1 feature=true 'spine_ids=["AC1","AC2"]'
printf '{"parent": "E-1", "containers": {}, "criteria": [{"id": "AC1", "text": "one"}, {"id": "AC2", "text": "two"}, {"id": "AC3", "text": "three"}]}\n' > "$T/state/expansion.json"
record T-51 src/p.txt; record T-52 src/q.txt
printf 'WAIT\nAUTOPILOT_PARK: which helper should the spec use?\n' > "$T/scripts/T-51.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=151 jira=none\n' > "$T/scripts/T-51.2"
printf 'WAIT\nAUTOPILOT_DONE: pr=152 jira=none\n' > "$T/scripts/T-52.1"
q admit T-51; q admit T-52
: > "$T/gh.log"
# What the person and a reviewer will have written on PR #200: its body, and a comment.
printf 'Notes from the person: check the summary screen.\n\n## After merge\n- tell support\n' > "$T/pr/200.body"; cp "$T/pr/200.body" "$T/pr/200.body.orig"
printf '%s' '[{"viewerDidAuthor":false,"body":"A reviewer: <!-- desk-autopilot:ledger --> looks odd","url":"https://github.com/acme/widgets/pull/200#issuecomment-1"}]' > "$T/pr/200.comments"
pass
check "AC1: one empty commit is pushed to the base"              '[ "$(git -C "$T/origin.git" rev-list --count main..feat/E)" = 1 ] && [ -z "$(git -C "$T/origin.git" diff main feat/E)" ]'
check "AC1: a draft promotion PR from the base to main is open, titled with the epic key" 'grep -q "^pr create --repo acme/widgets --draft --base main --head feat/E --title E-1: " "$T/gh.log" && [ "$(bfield promotion.pr)" = 200 ] && echo "$out" | grep -q "promotion PR #200 opened as a draft, feat/E → main"'
check "AC1: the children spawn"                                  '[ "$(state T-51)" = running ] && [ "$(state T-52)" = running ]'
pass
check "AC1: it is opened once"                                   '[ "$(grep -c "^pr create" "$T/gh.log")" = 1 ]'
check "ledger: one ledger comment on the promotion PR, one row per child, with its state and model" '[ "$(ledgers)" = 1 ] && ledger | grep -qE "^\| T-51 \| running \| — \| default \|$" && ledger | grep -qE "^\| T-52 \| running \| — \| default \|$" && [ "$(ledger | grep -c "^| T-")" = 2 ]'
check "ledger: it is created once, and an unchanged one is not written again" '[ "$(grep -c "^pr comment 200" "$T/gh.log")" = 1 ] && ! grep -q "^api -X PATCH" "$T/gh.log"'

# AC6: a parked child: the gate does not run, and the report lists it.
echo MERGED > "$T/pr/152"
finish T-51; finish T-52
pass
check "AC6: with a child parked the gate does not run, and the report names it" '[ $rc -eq 11 ] && [ "$(bfield gate)" = null ] && echo "${out#*WAITING ON YOU}" | grep -q "BASE GATE: not run, since 1 child(ren) did not finish: T-51 (parked: which helper"'
node "$B/answer.mjs" T-51 "use makeFixture" >/dev/null 2>&1; q requeue T-51
pass; finish T-51
pass
check "ledger: a child merging into the base rewrites its row in the same comment, with its PR" '[ "$(ledgers)" = 1 ] && ledger | grep -qE "^\| T-52 \| merged \| #152 \| default \|$" && ledger | grep -qE "^\| T-51 \| in review \| #151 \| default \|$" && grep -q "^api -X PATCH repos/acme/widgets/issues/comments/901 --input -" "$T/gh.log" && [ "$(grep -c "^pr comment 200" "$T/gh.log")" = 1 ]'
check "ledger: the PR body is never read or written, so the person's text is unchanged" 'cmp -s "$T/pr/200.body" "$T/pr/200.body.orig" && ! grep -q "^pr edit 200" "$T/gh.log" && ! grep -q "^api .*/pulls/200" "$T/gh.log" && ! grep -qE "^pr view 200 .*--json [^ ]*body" "$T/gh.log"'
check "ledger: the reviewer's comment is left alone"            'grep -q "A reviewer: <!-- desk-autopilot:ledger --> looks odd" "$T/pr/200.comments"'

# AC3 + AC5: every child merged into the base, with a spec still expected-fail, one failing when run,
# and a failing typecheck. main moved on meanwhile.
git clone -q "$T/origin.git" "$T/basework"; git -C "$T/basework" switch -q feat/E
mkdir -p "$T/basework/tests/acceptance"
printf "import { test } from 'vitest';\ntest('AC1: one', () => {});\ntest.fails('AC2: two', () => {});\n" > "$T/basework/tests/acceptance/feature.spec.ts"
printf "import { test } from 'vitest';\ntest('DoD4: an earlier epic', () => {});\n" > "$T/basework/tests/acceptance/older.spec.ts"
printf 'def test_dod5_an_earlier_python_spec():\n    assert True\n' > "$T/basework/tests/acceptance/test_older.py"
echo AC1 >"$T/basework/tests/acceptance/failing"; touch "$T/basework/broken-tc"
git -C "$T/basework" add -A && git -C "$T/basework" commit -q -m "the children, merged" && git -C "$T/basework" push -q origin feat/E
git -C "$T/repo" commit -q --allow-empty -m "main moved" && git -C "$T/repo" push -q origin main
echo MERGED > "$T/pr/151"
: > "$T/checks.log"; : > "$T/specs-run.log"
touch "$T/pr/200.unreadable"
pass
check "AC3: once every child has merged, the gate starts in the background" '[ $rc -eq 10 ] && echo "$out" | grep -q "BASE GATE: started on feat/E" && ! echo "$out" | grep -q "^IDLE"'
check "ledger: comments that cannot be read are reported, and the batch carries on" 'echo "$out" | grep -q "promotion PR #200: ledger not updated, since its comments could not be read (HTTP 502: Bad Gateway). The batch carries on" && ledger | grep -qE "^\| T-51 \| in review "'
rm "$T/pr/200.unreadable"
wait_gate
pass
check "ledger: the next pass writes it, in the same comment"     '[ "$(ledgers)" = 1 ] && ledger | grep -qE "^\| T-51 \| merged \| #151 \| default \|$" && cmp -s "$T/pr/200.body" "$T/pr/200.body.orig"'
BWT="$T/wt/base-feat-E"
check "AC3: the gate merged main into the base first"            'git -C "$T/origin.git" merge-base --is-ancestor main feat/E'
check "AC3: it ran every acceptance spec in the base worktree, an earlier epic's included" 'grep -qx AC1 "$T/specs-run.log" && grep -qx AC2 "$T/specs-run.log" && grep -qx DoD4 "$T/specs-run.log" && grep -qx DoD5 "$T/specs-run.log"'
check "AC3: and the typecheck, lint and unit tests there"        'grep -qx "tc $BWT" "$T/checks.log" && grep -qx "lint $BWT" "$T/checks.log" && grep -qx "tests $BWT" "$T/checks.log"'
check "AC5: a failed gate leaves the promotion PR draft"         '[ "$(bfield gate.state)" = "\"failed\"" ] && ! grep -q "^pr ready 200" "$T/gh.log"'
check "AC5: each failure is named under WAITING ON YOU, exit 11" '[ $rc -eq 11 ] && w="${out#*WAITING ON YOU}" && echo "$w" | grep -q "BASE GATE: \"AC2: two\" in tests/acceptance/feature.spec.ts is still marked expected-fail" && echo "$w" | grep -q "BASE GATE: AC1: \"AC1: one\" in tests/acceptance/feature.spec.ts fails when run (bash tests/acceptance/run.sh AC1)" && echo "$w" | grep -q "BASE GATE: §4 Typecheck (sh tc.sh) failed with exit 1: tc failed" && echo "$w" | grep -q "promotion PR #200 stays draft"'
check "AC5: the batch is idle, and the close-out is not offered" 'echo "$out" | grep -q "^IDLE" && ! echo "$out" | grep -q "close-out:"'
pass
check "a failed gate does not run again while the base stands still" '! echo "$out" | grep -q "BASE GATE: started"'

# AC4 + AC7: fixed on the base, the gate runs again, passes, and marks the promotion PR ready.
git -C "$T/basework" pull -q --no-rebase origin feat/E
printf "import { test } from 'vitest';\ntest('AC1: one', () => {});\ntest('AC2: two', () => {});\n" > "$T/basework/tests/acceptance/feature.spec.ts"
git -C "$T/basework" rm -q tests/acceptance/failing broken-tc
git -C "$T/basework" add -A && git -C "$T/basework" commit -q -m "fixed on the base" && git -C "$T/basework" push -q origin feat/E
pass
check "the gate runs again once the base moves"                 'echo "$out" | grep -q "BASE GATE: started on feat/E again"'
wait_gate
pass
check "AC4: a passing gate marks the promotion PR ready"         '[ "$(bfield gate.state)" = "\"passed\"" ] && grep -q "^pr ready 200 --repo acme/widgets" "$T/gh.log"'
check "AC4: and the report gives its link"                       '[ $rc -eq 11 ] && echo "$out" | grep -q "Promotion PR #200 is ready for review: https://github.com/acme/widgets/pull/200" && echo "$out" | grep -q "^IDLE"'
check "AC7: the close-out checks only the criterion with no spec" 'echo "$out" | grep -q "close-out: check only AC3 per criterion"'

# ---- promotion slices: the base gate runs every N children merged, or at a milestone ---------------
# Seven children, finished straight into the queue rather than through workers. A child "merges" when
# its pr/<n> says MERGED and a commit lands on the base, as a merge into it would.
SLICE=5 config
git -C "$T/repo" push -q origin main:feat/S
git clone -q "$T/origin.git" "$T/slicework"; git -C "$T/slicework" switch -q feat/S
# The spine's specs on main are still expected-fail; on this base its children have made them pass.
printf "import { test } from 'vitest';\ntest('AC1: one', () => {});\n" > "$T/slicework/tests/acceptance/feature.spec.ts"
git -C "$T/slicework" commit -q -am "the specs pass on the base" && git -C "$T/slicework" push -q origin feat/S
land(){ for k in "$@"; do echo MERGED > "$T/pr/1${k#T-}"; git -C "$T/slicework" commit -q --allow-empty -m "$k"; done; git -C "$T/slicework" push -q origin feat/S; }
q init slices; q set-batch base=feat/S epic=E-2 feature=true
for k in 61 62 63 64 65 66 67; do record "T-$k" "src/s$k.txt"; q admit "T-$k"; q set "T-$k" state=done "result.pr=1$k"; done
q set T-67 state=parked 'park={"question":"which copy should the banner use?"}'
: > "$T/gh.log"
pass
check "slices: the batch opens its promotion PR as before"      '[ "$(bfield promotion.pr)" = 200 ] && [ "$(bfield gate)" = null ]'
land T-61 T-62 T-63 T-64
pass
check "AC1: below the slice size the gate does not run"         '[ "$(bfield gate)" = null ] && ! echo "$out" | grep -q "BASE GATE: started"'
land T-65
pass
check "AC1: the fifth child merging starts the gate, with a child still open and one parked" 'echo "$out" | grep -q "BASE GATE: started on feat/S for slice 1: 5 of 7 children, since 5 children merged since the last promotion" && [ "$(bfield gate.slice.keys)" = "[\"T-61\",\"T-62\",\"T-63\",\"T-64\",\"T-65\"]" ]'
check "AC7: the parked child is named as not in this slice"     'echo "$out" | grep -q "BASE GATE: not in this slice: T-67 (parked: which copy"'
wait_gate
pass
check "AC3: a passing slice gate marks the promotion PR ready, and names the slice" '[ "$(bfield gate.state)" = "\"passed\"" ] && grep -q "^pr ready 200 --repo acme/widgets" "$T/gh.log" && echo "$out" | grep -q "BASE GATE: passed on feat/S at [0-9a-f]* (slice 1: 5 of 7 children): .*Promotion PR #200 is ready for review"'
check "AC6: a slice that is not the last offers no close-out"   '! echo "$out" | grep -q "close-out:"'
printf '{"ticket": "T-66", "type": "Story", "lane": "A", "size": "S", "branch": "feat/T-66", "files_in_scope": ["src/s66.txt"], "unknowns": [], "labels": ["milestone"]}\n' > "$T/state/triage/T-66.json"
land T-66
pass
check "AC2: a milestone child merging starts the gate whatever the count" 'echo "$out" | grep -q "BASE GATE: started on feat/S again (it moved since the last run, at [0-9a-f]*) for slice 1: 6 of 7 children, since milestone T-66 merged"'
check "a ready promotion PR goes back to draft once the base moves past its gate" 'grep -q "^pr ready 200 --repo acme/widgets --undo" "$T/gh.log" && echo "$out" | grep -q "Promotion PR #200 is back in draft until it passes"'
wait_gate
echo MERGED > "$T/pr/200"; echo 201 > "$T/pr/next"
pass
check "AC5: once the promotion PR merges, the next one opens as a draft and is recorded" 'echo "$out" | grep -q "promotion PR #200 (slice 1) merged into main" && grep -q "^pr create --repo acme/widgets --draft --base main --head feat/S --title E-2: promote feat/S to main (slice 2)" "$T/gh.log" && [ "$(bfield promotion.pr)" = 201 ] && [ "$(bfield promotion.slice)" = 2 ] && [ "$(bfield promotion.merged.0.pr)" = 200 ]'
check "AC5: the ledger comment is carried over to the new PR"    'grep -q "^pr comment 201" "$T/gh.log"'
check "AC5: the count starts again from that merge"             '[ "$(bfield gate)" = null ] && echo "$out" | grep -q "BASE GATE: not run, since 1 child(ren) did not finish: T-67"'
pass
check "AC5: a merged promotion PR is followed once"             '[ "$(grep -c "^pr create" "$T/gh.log")" = 2 ]'
q set T-67 state=done result.pr=167 park=null
land T-67
pass
check "AC6: the last child merging runs the last slice"         'echo "$out" | grep -q "BASE GATE: started on feat/S for slice 2: 1 of 7 children, the last"'
wait_gate
pass
check "AC6: the last slice passing offers the epic close-out"   'grep -q "^pr ready 201 --repo acme/widgets" "$T/gh.log" && echo "$out" | grep -q "close-out:"'
# A promotion PR that merged before the last child merged into the base leaves that child to promote.
echo MERGED > "$T/pr/201"; echo 2000-01-01T00:00:00Z > "$T/pr/201.merged_at"; echo 202 > "$T/pr/next"
pass
check "AC5: a child merged after the promotion PR merged is promoted by the next one, even with every child merged" 'grep -q "^pr create --repo acme/widgets --draft --base main --head feat/S --title E-2: promote feat/S to main (slice 3)" "$T/gh.log" && [ "$(bfield promotion.pr)" = 202 ]'
wait_gate
pass
echo MERGED > "$T/pr/202"; echo 2999-01-01T00:00:00Z > "$T/pr/202.merged_at"
pass
check "AC6: a promotion PR merged after every child opens no further one" '[ "$(grep -c "^pr create" "$T/gh.log")" = 3 ] && [ "$(bfield promotion.merged.2.pr)" = 202 ]'

echo "batch e2e: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
