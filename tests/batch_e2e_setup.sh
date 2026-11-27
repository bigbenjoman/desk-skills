# shellcheck shell=bash
# Shared setup for the end-to-end batch suites (tests/test_batch_e2e.sh, tests/test_batch_e2e_spine.sh),
# which each source it first, then init their own queue: a scratch HOME, a repo whose origin is a local
# bare repo, its config, the fake claude and gh on a PATH of nothing else, and the helpers both use.
# Not a suite: tests/run.sh runs only tests/test_*.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
NODE="$(node -p process.execPath)"   # the binary itself, never a version manager's shim
JQ="$(command -v jq)" || { echo "FAIL jq is needed to read the queue"; exit 1; }   # by path: PATH below drops Homebrew's
T="$(mktemp -d)"; T="$(cd "$T" && pwd -P)"
mkdir -p "$T/home" "$T/state/triage" "$T/stub" "$T/wt" "$T/live" "$T/runs" "$T/scripts" "$T/go"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
# No network for git: every transport but a local file is refused.
git config --global protocol.allow never; git config --global protocol.file.allow always
# The named review agents, installed user-level as install.sh puts them: spawn-worker.sh builds every
# worker's --agents file from these and refuses a spawn with one missing.
mkdir -p "$T/home/.claude/agents"; cp "$SRC"/agents/*.md "$T/home/.claude/agents/"
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_BIN DESK_QUEUE DESK_SKILLS_DIR DESK_MEMORY_DIR DESK_GH_REPO DESK_CONFIG_ROOT DESK_ENV_MJS DESK_ENV_DIR \
  DESK_AUTOPILOT_WORKER CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_TASK AUTOPILOT_RESUME \
  AUTOPILOT_PREFLIGHT AUTOPILOT_BATCH_BUDGET_USD AUTOPILOT_USER_APPROVED DESK_UPLOAD_APPROVED GH_TOKEN GITHUB_TOKEN \
  GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
cleanup(){ for f in "$T"/live/*.json; do [ -f "$f" ] && kill "$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$f")" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT

# A repo whose origin is a local bare repo.
git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin main
# config [<Worker models row value>]: no value leaves the row out, which reads as `default`. $SLICE, when
# set, is the Promotion slice size row. $AUTHOR is the §1 Git author name / email cell.
AUTHOR='`Pat Tester <pat@example.com>` (from recent commits)'
# The suites that source this file pass config its argument, which shellcheck cannot see from here.
# shellcheck disable=SC2120
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
| Git author name / email | $AUTHOR |

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
| Per-file collision budget | \`3 over 1000 lines, else 2; serial: none\` | \`3 over 1000 lines, else 1; serial: none\` |
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

# The fake claude. `agents --json` lists the fake workers whose process is alive, at once. `-p` with the
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
  const live = fs.readdirSync(T + '/live').map((f) => { try { return JSON.parse(fs.readFileSync(T + '/live/' + f, 'utf8')); } catch { return null; } })
    .filter((x) => x && alive(x.pid));
  console.log(JSON.stringify(live));
  process.exit(0);
}
// The version spawn-worker.sh records on each start's spawn line: not a call, so not logged.
if (a[0] === '--version') {
  console.log('2.1.0 (Claude Code)');
  process.exit(0);
}
// The sign-in check: each config folder is its own account.
if (a[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, email: (process.env.CLAUDE_CONFIG_DIR ?? 'default').split('/').pop() + '@example.com' }));
  process.exit(0);
}
// The model list (model-list.mjs): the initialize control request on stdin, answered with the models
// this login offers and no turn, as the real CLI does. nosuchalias and no-such-model are not among them.
if (a.includes('--input-format')) {
  fs.appendFileSync(T + '/calls.log', 'claude model-list\n');
  let s = '';
  process.stdin.on('data', (d) => {
    s += d;
    const req = s.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((d) => d?.type === 'control_request');
    if (!req) return;
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id,
      response: { models: ['default', 'opus', 'sonnet', 'haiku'].map((value) => ({ value, displayName: value, description: '' })) } } }));
    process.exit(0);
  });
  return;
}
const prompt = at('-p') ?? '';
const onLogin = (what) => fs.appendFileSync(T + '/logins.log', what + ' ' + (process.env.CLAUDE_CONFIG_DIR ?? 'default') + '\n');
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
// The usage probe: refused at the weekly limit while T/probe-429 exists, as a real call is.
if (prompt === 'Reply with: ok') {
  fs.appendFileSync(T + '/calls.log', 'claude probe\n');
  if (fs.existsSync(T + '/probe-429')) {
    console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: Math.floor(Date.now() / 1000) + 86400 } }));
    console.log(JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', result: "You've hit your weekly limit" }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
  process.exit(0);
}
if (prompt.startsWith('Perform these')) {
  fs.appendFileSync(T + '/calls.log', 'claude preflight model=' + model + '\n');
  onLogin('preflight');
  // Refused at the usage limit: the json result the real CLI writes for HTTP 429, and no checks.
  if (fs.existsSync(T + '/preflight-429')) {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', num_turns: 1, total_cost_usd: 0, result: "You've hit your weekly limit · resets Nov 1 at 3pm" }));
    process.exit(1);
  }
  // AGENTS is OK only when the --agents file it was given defines every seat the check names, as
  // a real session offers exactly the subagent types that file holds.
  const seats = (/^AGENTS=OK or AGENTS=BLOCKED[^\n]*: ([^\n]*)/m.exec(prompt)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const offered = (() => { try { return JSON.parse(fs.readFileSync(at('--agents'), 'utf8')); } catch { return {}; } })();
  const agentsOk = a.includes('--agents') && seats.length > 0 && seats.every((n) => offered[n]?.prompt);
  const reply = [...prompt.matchAll(/^(\w+)=OK or \1=BLOCKED/gm)].map((m) => m[1] + '=' + (/^(W_IN|TOOL\d+|JIRA)\$/.test(m[1]) || (m[1] === 'AGENTS' && agentsOk) ? 'OK' : 'BLOCKED')).join('\n');
  if (at('--output-format') === 'json' && !fs.existsSync(T + '/preflight-text')) console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 9, total_cost_usd: 0.4321, result: reply }));
  else console.log(reply);
  process.exit(0);
}
const ticket = /Your ticket is (\S+?)\./.exec(prompt)?.[1];
const sid = at('--session-id');
fs.appendFileSync(T + '/calls.log', 'claude worker ' + ticket + '\n');
onLogin('worker');
const round = fs.readdirSync(T + '/runs').filter((f) => f.startsWith(ticket + '.')).length + 1;
const gitEnv = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map((k) => process.env[k] ?? '-').join('|');
fs.writeFileSync(T + '/runs/' + ticket + '.' + round, JSON.stringify({ prompt, git: gitEnv, compileCache: process.env.NODE_COMPILE_CACHE ?? null, system: at('--append-system-prompt'), cwd: process.cwd(), sid, model, partial: a.includes('--include-partial-messages'), agents: a.includes('--agents') ? Object.keys(JSON.parse(fs.readFileSync(at('--agents'), 'utf8'))) : null, sources: a.includes('--setting-sources') ? at('--setting-sources') : null, settings: a.filter((x) => x === '--settings').length }));
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
# shellcheck source=age_probes.sh
. "$S/age_probes.sh"
pass(){ age_probes; out=$(node "$B/pass.mjs" 2>&1); rc=$?; }
# shellcheck source=jq_at.sh
. "$S/jq_at.sh"
# A ticket the pass moved to the archive beside the queue (queue-store.mjs) is found as a queue read finds it.
field(){ local a="${DESK_QUEUE%.json}.archive.json"; [ -f "$a" ] || a=/dev/null
  "$JQ" -cn --arg t "$1" --arg p "$2" --slurpfile live "$DESK_QUEUE" --slurpfile arc "$a" "$JQ_AT"' $live[0].tickets as $l
  | (if $l | has($t) then $l[$t] else ($arc[0].tickets // {})[$t] end) | at($p)'; }
state(){ field "$1" state | tr -d '"'; }
# A batch-level field of the queue, as JSON.
bfield(){ "$JQ" -c --arg p "$1" "$JQ_AT"' at($p)' "$DESK_QUEUE"; }
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
# run_has <run file> <prompt|system> <text>: the round's recorded prompt or system prompt holds the text.
run_has() { node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((r[process.argv[2]] ?? "").includes(process.argv[3]) ? 0 : 1)' "$1" "$2" "$3"; }

out=$(command -v claude gh codex desk-jira 2>&1)
check "only the fakes are on PATH: no real claude, gh, codex or desk-jira" '[ "$out" = "$(printf "%s\n%s" "$T/stub/claude" "$T/stub/gh")" ]'
