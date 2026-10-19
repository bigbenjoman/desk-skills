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
mkdir -p "$T/home" "$T/state/triage" "$T/stub" "$T/wt" "$T/live" "$T/runs" "$T/scripts" "$T/go" "$T/gh/prs"
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
| \`codex-review\` | Codex | \`yes\` | \`no\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Autopilot worker concurrency | \`2 / 3\` | \`3 / 3\` |
| Autopilot per-worker budget (USD) | \`25\` | \`none\` |
| Preferred dev-server port | \`3000\` | \`$((20000 + RANDOM % 20000))\` |

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`T-[0-9]+\` |
| Project subagents sync | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Unit tests | \`bash tests/run.sh\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
EOF

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
if (prompt.startsWith('Perform these')) {
  fs.appendFileSync(T + '/calls.log', 'claude preflight\n');
  for (const m of prompt.matchAll(/^(\w+)=OK or \1=BLOCKED/gm)) console.log(m[1] + '=' + (/^(W_IN|TOOL\d+|JIRA)\$/.test(m[1]) ? 'OK' : 'BLOCKED'));
  process.exit(0);
}
const ticket = /Your ticket is (\S+?)\./.exec(prompt)?.[1];
const sid = at('--session-id');
fs.appendFileSync(T + '/calls.log', 'claude worker ' + ticket + '\n');
const round = fs.readdirSync(T + '/runs').filter((f) => f.startsWith(ticket + '.')).length + 1;
fs.writeFileSync(T + '/runs/' + ticket + '.' + round, JSON.stringify({ prompt, system: at('--append-system-prompt'), cwd: process.cwd(), sid }));
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
fs.unlinkSync(reg);
EOF
# The fake gh: \`pr list --head <branch>\` prints gh/prs/<branch>'s PR number if the test wrote one,
# and \`pr view <n>\` says the PR is open.
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('$T/calls.log', 'gh ' + a.join(' ') + '\n');
if (a[0] === 'pr' && a[1] === 'list') {
  const f = '$T/gh/prs/' + String(a[a.indexOf('--head') + 1]).replace(/\//g, '_');
  if (fs.existsSync(f)) console.log(fs.readFileSync(f, 'utf8').trim());
} else if (a[0] === 'pr' && a[1] === 'view') console.log('OPEN');
EOF
chmod +x "$T/stub/claude" "$T/stub/gh"
ln -s "$NODE" "$T/stub/node"

export PATH="$T/stub:/usr/bin:/bin:/usr/sbin:/sbin" DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" \
  DESK_SKILLS_DIR="$SRC/skills" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" \
  AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_ORCHESTRATOR=test-orchestrator
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
pass(){ out=$(node "$B/pass.mjs" 2>&1); }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
state(){ field "$1" state | tr -d '"'; }
# A triage record as triage.sh writes one: the fields queue.mjs admit reads.
record(){ printf '{"ticket": "%s", "type": "Bug", "lane": "A", "size": "S", "branch": "fix/%s", "files_in_scope": ["%s"], "unknowns": []}\n' "$1" "$1" "$2" > "$T/state/triage/$1.json"; }
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
check "the first pass spawns both independent tickets"       '[ "$(state T-1)" = running ] && [ "$(state T-2)" = running ] && live T-1 && live T-2'
check "the colliding ticket does not spawn beside its blocker" '[ "$(state T-3)" = triaged ] && [ ! -e "$T/runs/T-3.1" ] && echo "$out" | grep -q "held back by a collision: T-3"'
check "each worker runs in its own worktree on its own branch"  'grep -q "\"cwd\":\"$T/wt/T-1\"" "$T/runs/T-1.1" && [ "$(git -C "$T/wt/T-1" branch --show-current)" = fix/T-1 ]'
check "each worker passed a real preflight first"               '[ "$(grep -c "^claude preflight" "$T/calls.log")" = 2 ]'

pass
check "a pass while both run spawns nothing more"               '[ "$(state T-3)" = triaged ] && [ ! -e "$T/runs/T-3.1" ]'

finish T-1; finish T-2
pass
check "both tickets reach done with the PRs their workers printed" '[ "$(state T-1)" = done ] && [ "$(field T-1 result.pr)" = 101 ] && [ "$(state T-2)" = done ] && [ "$(field T-2 result.pr)" = 102 ]'
check "the stage a worker printed is recorded"                  '[ "$(field T-1 stage)" = "\"4/9\"" ]'
check "the held ticket spawns once its blocker has finished"    '[ "$(state T-3)" = running ] && live T-3'

finish T-3
pass
check "the held ticket reaches done"                            '[ "$(state T-3)" = done ] && [ "$(field T-3 result.pr)" = 103 ]'
check "the batch stops spawning: IDLE"                          'echo "$out" | grep -q "^IDLE"'
pass
check "a further pass spawns nothing"                           '[ "$(grep -c "^claude worker" "$T/calls.log")" = 3 ] && echo "$out" | grep -q "^IDLE"'

# ---- AC2: a ticket held behind another's PR does not spawn while its blocker runs -----------------
record T-4 src/c.txt; record T-5 src/d.txt
printf 'WAIT\nAUTOPILOT_DONE: pr=104 jira=none\n' > "$T/scripts/T-4.1"
q admit T-4; q admit T-5; q hold T-5 T-4
pass
check "the held ticket stays parked while its blocker runs"     '[ "$(state T-4)" = running ] && [ "$(state T-5)" = parked ] && [ ! -e "$T/runs/T-5.1" ]'
finish T-4
pass
check "a finished blocker with an open PR keeps the batch waiting on its merge" '[ "$(state T-4)" = done ] && [ "$(state T-5)" = parked ] && echo "$out" | grep -q "WAITING ON MERGE: T-5 (T-4)" && ! echo "$out" | grep -q "^IDLE"'
q drop T-5

# ---- AC3: a worker parks with a question; answered and requeued, a second worker finishes it ------
record T-6 src/e.txt
printf 'WAIT\nAUTOPILOT_STAGE: 2/9 understand\nAUTOPILOT_PARK: which fixture helper should the spec use?\n' > "$T/scripts/T-6.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=106 jira=none\n' > "$T/scripts/T-6.2"
q admit T-6
pass; finish T-6
pass
check "a worker that parks leaves the ticket parked with its question" '[ "$(state T-6)" = parked ] && field T-6 park | grep -q "which fixture helper"'
out=$(node "$B/answer.mjs" T-6 "use makeFixture from tests/helpers" 2>&1)
out=$(node "$B/queue.mjs" requeue T-6 2>&1)
check "the answered ticket requeues"                            '[ "$(state T-6)" = triaged ]'
pass
check "a second worker spawns for the requeued ticket"          '[ "$(state T-6)" = running ] && [ -e "$T/runs/T-6.2" ]'
check "the second worker's briefing carries the answer"         'grep -q "use makeFixture from tests/helpers" "$T/runs/T-6.2"'
finish T-6
pass
check "the requeued ticket reaches done with the second worker's PR" '[ "$(state T-6)" = done ] && [ "$(field T-6 result.pr)" = 106 ]'

# ---- AC4: a worker that exits with no done marker is not done ------------------------------------
record T-7 src/f.txt
printf 'WAIT\nAUTOPILOT_STAGE: 3/9 implement\n' > "$T/scripts/T-7.1"
q admit T-7
pass; finish T-7
pass
check "a worker with no done marker and no PR is reported failed" '[ "$(state T-7)" = failed ] && [ "$(field T-7 result)" = null ] && echo "$out" | grep -q "T-7: exited with no marker and no open PR"'

# ---- AC5: nothing left the machine ---------------------------------------------------------------
check "every claude call was the fake's: agents, preflight or a scripted worker" '! grep "^claude" "$T/calls.log" | grep -vqE "^claude (agents|preflight|worker T-[0-9]+)$"'
check "no worktree has a network remote"                        '! git -C "$T/repo" remote -v | grep -qvF "$T/origin.git"'

echo "batch e2e: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
