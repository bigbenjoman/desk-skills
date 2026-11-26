#!/usr/bin/env bash
# suite: intake (standing intake admits a query's tickets into the running batch)
# layer: L2
# intake.mjs with a fake desk-jira search, a fake triage.sh that writes set lanes, lint, questions,
# sizes and blockers, the real queue.mjs on a scratch queue, and the supervisor with a fake pass and
# merge driver: what is admitted, held, handed to the digest, and what the report says. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin" "$T/fakes" "$T/repo" "$T/state/triage" "$T/recs" "$T/no-skills"
export HOME="$T/home"
unset DESK_CONFIG DESK_REPO_DIR DESK_REPO_ROOT DESK_SLUG DESK_STATE DESK_DEFAULT_BRANCH DESK_GH_REPO \
  AUTOPILOT_DRY_RUN AUTOPILOT_BASE_PUSH_APPROVED AUTOPILOT_USER_APPROVED DESK_DIGEST_DIR DESK_BATCH CLAUDE_CODE_SESSION_ID
export DESK_CONFIG_ROOT="$T/cfg" DESK_REPO_OVERRIDE=acme/widgets DESK_HOME="$T/desk" \
  DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" DESK_SKILLS_DIR="$T/no-skills" DESK_TRIAGE_RETRY_MS=0
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# config <autopilot-workers> [<intake query row>]
config(){ mkdir -p "$T/cfg/repos/acme__widgets"; cat > "$T/cfg/repos/acme__widgets/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`$1\` |
| \`autopilot-merge\` | The merge driver merges | \`ask\` | \`yes\` |
| \`pr-merge-green\` | Merge on green | \`ask\` | \`yes\` |
| \`git-push\` | Push a branch | \`ask\` | \`yes\` |
| \`jira-create\` | Create a ticket | \`ask\` | \`yes\` |
| \`jira-edit\` | Edit a ticket | \`ask\` | \`${JIRA_EDIT:-yes}\` |
${GH_ISSUE_EDIT:+| \`gh-issue-edit\` | Edit an issue body | \`ask\` | \`$GH_ISSUE_EDIT\` |
}${JUDGEMENT:+| \`autopilot-judgement\` | Take calls outside the ask categories | \`yes\` | \`$JUDGEMENT\` |}

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Intake query | \`none\` | ${2-\`project = ACME AND labels = autopilot\`} |
| Triage concurrency | \`1\` | \`${TRIAGE_K:-TODO}\` |
| Batches run by | \`supervisor\` | \`${RUN_BY:-supervisor}\` |
${WORKER_LOC:+| Worker location | \`local\` | \`$WORKER_LOC\` |}
EOF
}
config yes

# intake.mjs and the supervisor copied beside fakes, so each runs the fake triage.sh, pass and driver,
# and links to the real modules (link_bin, after the fakes).
# shellcheck source=link_bin.sh
. "$S/link_bin.sh"
cp "$B/intake.mjs" "$B/supervisor.mjs" "$B/epic-plan.mjs" "$T/bin/"
# The search: whatever $T/search.json holds, or a failure while $T/search.fails exists. A get of a key
# with a file in $T/get prints that file.
cat > "$T/fakes/desk-jira" <<EOF
#!/bin/sh
echo "\$*" >> "$T/jira.calls"
[ "\$1" = create ] && { echo "created E-11"; exit 0; }
[ "\$1" = get ] && [ -f "$T/get/\$2.json" ] && { cat "$T/get/\$2.json"; exit 0; }
[ "\$1" = get ] && [ -f "$T/get/\$2.fails" ] && { echo "desk-jira: HTTP 404 from Jira" >&2; exit 1; }
[ "\$1" = link ] && [ -f "$T/link.fails" ] && { echo "desk-jira: HTTP 400 from Jira" >&2; exit 1; }
[ "\$1" = link ] && { echo "linked: \$2 blocks \$4 (read back)"; exit 0; }
[ "\$1" = fields ] && { [ -f "$T/fields.fails" ] && { echo "desk-jira: HTTP 503 from Jira" >&2; exit 1; }; printf 'customfield_10208\tT-shirt\toption\ncustomfield_10207\tLaunch Priority\toption\ncustomfield_10513\tTeam / Squad (owner)\toption\ncustomfield_10300\tSize\toption\ncustomfield_10301\t2nd Approver\tstring\n'; exit 0; }
[ "\$1" = meta ] && { printf '== %s\n  customfield_10207 (Launch Priority) allows: P0, P1, P2\n  customfield_10513 (Team / Squad (owner)) allows: Core, Growth, None\n' "\$2"; exit 0; }
[ -f "$T/search.fails" ] && { echo "desk-jira: HTTP 503 from Jira" >&2; exit 1; }
cat "$T/search.json"
EOF
# Triage: copies the set record for the ticket into the state of the batch it runs in, or fails while
# $T/recs/<KEY>.fails exists. A run in a named batch is logged with that batch in $T/triage.batch.
# It fails its first run while $T/recs/<KEY>.failonce exists, and every run on a login refusal while
# $T/recs/<KEY>.authfails does, and leaves its record behind refused as malformed, as triage.sh can,
# while $T/recs/<KEY>.badrec does. It waits at its gate, $T/gates/<KEY> (in a named batch,
# $T/gates/<KEY>@<batch>), and logs `start <KEY> <tickets admitted so far>` and
# `end <KEY>` in $T/triage.events. It stops at the usage limit in $T/recs/<KEY>.limit, or in a named
# batch only, in $T/recs/<KEY>.batchlimit.
# A gate holds a run until what it waits for has happened, so the order a case needs is the order it
# gets, on a loaded machine as on an idle one, with no real triage time: each line of a gate file is
# `<file><TAB><extended regex>`, and the run goes on once every line's regex matches a line of its file.
# What it waits for is a line in triage.events, in admit.out (an admit's output, as it is printed), in
# claude.calls, or in release, which the test writes (release <KEY>). A gate still shut after 30 s lets
# the run go on and is logged in $T/gate.timeouts, which fails the suite's last check rather than hanging.
mkdir -p "$T/gates"
cat > "$T/gate.sh" <<'EOF'
#!/bin/sh
[ -f "$1" ] || exit 0
tab=$(printf '\t'); i=0
while [ $i -lt 600 ]; do
  shut=0
  while IFS="$tab" read -r f p; do grep -Eq -- "$p" "$f" 2>/dev/null || shut=1; done < "$1"
  [ $shut -eq 0 ] && exit 0
  sleep 0.05; i=$((i + 1))
done
echo "$1" >> "${1%/gates/*}/gate.timeouts"
EOF
# gate <run> <file in $T> <extended regex>: one more thing run <run> (a key, <KEY>@<batch>, or claude)
# waits for. ungate: opens every gate. release <KEY>: writes the line a gate on `release ^<KEY>$` waits for.
gate(){ printf '%s\t%s\n' "$T/$2" "$3" >> "$T/gates/$1"; }
ungate(){ rm -f "$T/gates/"* "$T/release"; }
release(){ echo "$1" >> "$T/release"; }
cat > "$T/bin/triage.sh" <<EOF
#!/bin/sh
echo "\$1" >> "$T/triage.calls"
echo "start \$1 \$(grep -o admitted_by "\$DESK_QUEUE" 2>/dev/null | wc -l | tr -d ' ')" >> "$T/triage.events"
trap 'echo "end \$1" >> "$T/triage.events"' EXIT
sh "$T/gate.sh" "$T/gates/\$1\${DESK_BATCH:+@\$DESK_BATCH}"
[ -n "\${DESK_BATCH:-}" ] && echo "\$1 \$DESK_BATCH \${DESK_DEFAULT_BRANCH:-unpinned}" >> "$T/triage.batch"
[ -f "$T/recs/\$1.fails" ] && { echo "triage: claude exited 1" >&2; exit 1; }
[ -f "$T/recs/\$1.failonce" ] && { rm -f "$T/recs/\$1.failonce"; echo "FAIL: \$1 produced no triage record at \$DESK_AUTOPILOT_STATE/triage/\$1.json" >&2; exit 1; }
[ -f "$T/recs/\$1.authfails" ] && { echo "FAIL: \$1 produced no triage record: HTTP 401. That is the login, not the session limit" >&2; exit 1; }
[ -f "$T/recs/\$1.badrec" ] && { mkdir -p "\$DESK_AUTOPILOT_STATE/triage"; cp "$T/recs/\$1.json" "\$DESK_AUTOPILOT_STATE/triage/\$1.json"; echo "FAIL: \$1 triage record is malformed" >&2; exit 1; }
[ -f "$T/recs/\$1.limit" ] && { echo "[triage] reading \$1" >&2; echo "USAGE LIMIT: \$1 \$(cat "$T/recs/\$1.limit") (log: \$DESK_AUTOPILOT_STATE/triage/\$1.log)" >&2; exit 3; }
[ -n "\${DESK_BATCH:-}" ] && [ -f "$T/recs/\$1.batchlimit" ] && { echo "USAGE LIMIT: \$1 \$(cat "$T/recs/\$1.batchlimit") (log: \$DESK_AUTOPILOT_STATE/triage/\$1.log)" >&2; exit 3; }
mkdir -p "\$DESK_AUTOPILOT_STATE/triage"; cp "$T/recs/\$1.json" "\$DESK_AUTOPILOT_STATE/triage/\$1.json"
EOF
cat > "$T/bin/pass.mjs" <<EOF
import { appendFileSync } from 'node:fs';
appendFileSync('$T/pass.calls', 'pass\\n');
console.log(JSON.stringify({ status: 'nothing_yet', code: 10, message: 'no change this pass', waiting: [], parked: [], notify: false, push: [] }));
process.exitCode = 10;
EOF
printf "import { appendFileSync } from 'node:fs';\nappendFileSync('%s/digest.calls', 'checkin\\\\n');\nconsole.log(JSON.stringify({ status: 'not_due', push: null }));\n" "$T" > "$T/bin/digest.mjs"
echo "console.log(JSON.stringify({ hold: false, lines: [] }));" > "$T/bin/maintenance.mjs"
link_bin "$B" "$T/bin"
printf '#!/bin/sh\necho "$@" >> "%s/driver.calls"\n' "$T" > "$T/bin/merge-driver.sh"
# A PR list is whatever $T/prs.json holds (none by default); one by --head and --base is the PRs in
# $T/promos.json with that head and base, or a failure while $T/promos.fails exists. The workflows at a
# ref are one ci.yml, $T/wf/<the ref, URL-encoded>.yml, while $T/wf exists; any other call reads OPEN.
cat > "$T/fakes/gh" <<EOF
#!/bin/sh
case "\$*" in
  "pr list "*"--head "*) [ -f "$T/promos.fails" ] && exit 1
    node -e 'const a = process.argv, h = a[a.indexOf("--head") + 1], b = a[a.indexOf("--base") + 1], s = a[a.indexOf("--state") + 1]; let v = []; try { v = JSON.parse(require("fs").readFileSync("$T/promos.json", "utf8")); } catch {} console.log(JSON.stringify(v.filter((p) => p.headRefName === h && p.baseRefName === b && (!p.state || p.state === s))))' -- "\$@" ;;
  "pr list "*) cat "$T/prs.json" 2>/dev/null || echo "[]" ;;
  "issue view "*) cat "$T/issues/\$3.md" ;;
  "issue edit "*) echo "\$*" >> "$T/issue-edit.calls"; cat "\$7" > "$T/issues/\$3.md" ;;
  "api repos/"*"/contents/.github/workflows?ref="*) [ -d "$T/wf" ] && echo .github/workflows/ci.yml || exit 1 ;;
  "api -H Accept: application/vnd.github.raw repos/"*"/contents/.github/workflows/ci.yml?ref="*) a="\$*"; cat "$T/wf/\${a##*ref=}.yml" ;;
  *) echo OPEN ;;
esac
EOF
printf '#!/bin/sh\nexit 1\n' > "$T/fakes/launchctl"
printf '#!/bin/sh\nexit 0\n' > "$T/fakes/osascript"
# No real notifier: on Linux notify.mjs tries notify-send, then WSL's powershell.exe, and neither may reach the desktop.
printf '#!/bin/sh\nexit 1\n' | tee "$T/fakes/notify-send" > "$T/fakes/powershell.exe"
chmod +x "$T/fakes/"* "$T/bin/triage.sh" "$T/bin/merge-driver.sh"
export PATH="$T/fakes:$PATH"

intake(){ (cd "$T/repo" && node "$T/bin/intake.mjs" run --force "$@" 2>&1); }
tick(){ (cd "$T/repo" && node "$T/bin/supervisor.mjs" tick --foreground 2>&1); }
search(){ printf '{"issues":[%s]}\n' "$(printf '{"key":"%s"},' "$@" | sed 's/,$//')" > "$T/search.json"; }
# rec <KEY> <lane> [extra json fields]
rec(){ printf '{"ticket":"%s","type":"Story","lane":"%s","lane_reason":"needs a plan","files_in_scope":["src/%s.js"],"unknowns":[],"size":"S","blockers":[],"lint":[]%s}\n' "$1" "$2" "$1" "${3:+,$3}" > "$T/recs/$1.json"; }
count(){ if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
# shellcheck source=jq_at.sh
. "$S/jq_at.sh"
# jget <file> <dot path>: the value there, read by jq (a node per read costs the suite seconds): a string
# bare, anything else as JSON, and undefined where the path leads nowhere (a null is a value: null).
jget(){ jq -r --arg p "$2" "$JQ_AT"' at_or($p; "undefined") | if type == "string" then . else tojson end' "$1"; }
qget(){ jget "$DESK_QUEUE" "$1"; }
handed(){ node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const e=r.tickets[process.argv[2]]; console.log(e?`${e.outcome}: ${e.text}`:"none")' "$T/state/intake.json" "$1"; }
running_batch(){ printf '{"version":1,"batch":"b1","supervised":true,"concurrency":2,"tickets":{"R":{"key":"R","state":"running"}}}\n' > "$DESK_QUEUE"; }

# ---- AC10: no query, no intake -------------------------------------------------------------------
config yes '`none`'; running_batch; search A-1
out=$(tick)
check "AC10: with the intake query row none, a tick runs no intake" '[ "$(count "$T/jira.calls")" = 0 ] && [ "$(count "$T/triage.calls")" = 0 ]'
config yes ''
out=$(intake --json)
check "AC10: with the row absent, intake does nothing" '[ "$(count "$T/jira.calls")" = 0 ] && grep -q "\"ran\":false" <<< "$out"'
config yes

# ---- AC9: autopilot-workers must be yes --------------------------------------------------------
for perm in ask no; do
  config "$perm"; out=$(intake)
  check "AC9: with autopilot-workers $perm, the report says intake needs it yes" 'grep -q "standing intake needs config §3 autopilot-workers to be \"yes\" (it is \"$perm\")" <<< "$out"'
  check "AC9: with autopilot-workers $perm, nothing is searched or admitted" '[ "$(count "$T/jira.calls")" = 0 ] && [ "$(qget tickets.A-1)" = undefined ]'
done
config yes

# ---- AC11: a failed search -----------------------------------------------------------------------
touch "$T/search.fails"
out=$(intake)
check "AC11: a failed search admits nothing and names the error" 'grep -q "the Jira search failed (desk-jira: HTTP 503 from Jira); the next intake tries again" <<< "$out" && [ "$(count "$T/triage.calls")" = 0 ]'
out=$(cd "$T/repo" && node "$T/bin/intake.mjs" run 2>&1)
check "AC11: the next run tries again without waiting out the interval" '[ "$(count "$T/jira.calls")" = 2 ]'
rm -f "$T/search.fails"

# ---- AC1: a clean lane A ticket joins the running batch ----------------------------------------
rec A-1 A; search A-1
out=$(tick)
check "AC1: the ticket is triaged" 'grep -qx A-1 "$T/triage.calls"'
check "AC1: it is admitted into the running batch" '[ "$(qget tickets.A-1.state)" = triaged ] && [ "$(qget batch)" = b1 ]'
check "AC1: the queue records it as admitted by intake" '[ "$(qget tickets.A-1.admitted_by)" = intake ]'
check "AC1: the pass report lists it as admitted by intake" 'grep -q "intake: admitted A-1 by intake into batch b1 (lane A, size S)" "$T/state/supervisor.log" && grep -A1 "intake: admitted A-1" "$T/state/supervisor.log" | grep -q "^no change this pass$"'
check "AC1: the search used the configured query" 'tail -1 "$T/jira.calls" | grep -q "^search project = ACME AND labels = autopilot 100 --json$"'

# ---- AC8: once only ------------------------------------------------------------------------------
n=$(count "$T/triage.calls")
out=$(intake)
check "AC8: an admitted ticket is not triaged or admitted again" '[ "$(count "$T/triage.calls")" = "$n" ] && ! grep -q "A-1" <<< "$out"'
full=(); while [ ${#full[@]} -lt 100 ]; do full+=(A-1); done
search "${full[@]}"; out=$(intake)
check "a full page of search results is reported, never silent" 'grep -q "the search returned its limit of 100 tickets" <<< "$out"'
check "the interval holds intake back: a tick soon after searches nothing" 'j=$(count "$T/jira.calls"); tick >/dev/null; [ "$(count "$T/jira.calls")" = "$j" ]'

# ---- AC3 to AC6: what goes to the digest --------------------------------------------------------
rec C-1 C; rec D-1 D
rec L-1 A '"lint":[{"severity":"blocking","rule":"ac","message":"no acceptance criteria"}]'
rec Q-1 A '"unknowns":["which plan tier?"]'
rec X-1 A '"size":"XL"'
search A-1 C-1 D-1 L-1; out=$(intake)
check "AC3: a lane C ticket is not admitted" '[ "$(qget tickets.C-1)" = undefined ]'
check "AC3: it goes to the digest with its lane and reason" '[ "$(handed C-1)" = "handed: lane C: needs a plan" ]'
check "AC3: so does lane D with no saved canvas, saying why" '[ "$(qget tickets.D-1)" = undefined ] && [ "$(handed D-1)" = "handed: lane D: its design was never read: re-run triage; needs a plan" ]'
check "AC4: a blocking lint finding is not admitted, and goes to the digest with the finding" '[ "$(qget tickets.L-1)" = undefined ] && [ "$(handed L-1)" = "handed: lint (blocking): no acceptance criteria" ]'
check "the report names each ticket handed on" 'grep -q "intake: handed C-1 to the digest: lane C: needs a plan" <<< "$out"'
search Q-1 X-1; out=$(intake)
check "AC5: open triage questions are not admitted, and go to the digest" '[ "$(qget tickets.Q-1)" = undefined ] && [ "$(handed Q-1)" = "handed: open question(s): which plan tier?" ]'
check "AC6: size XL is not admitted, and the digest item says it needs splitting" '[ "$(qget tickets.X-1)" = undefined ] && [ "$(handed X-1)" = "handed: size XL: it needs splitting before a worker takes it" ]'
n=$(count "$T/triage.calls")
# An epic whose triage names no branch has no feature batch to start: it goes to the digest with why.
rec E-1 A '"type":"Epic"'
echo '{"issues":[{"key":"E-1","fields":{"issuetype":{"name":"Epic","hierarchyLevel":1}}}]}' > "$T/search.json"; out=$(intake)
check "DS-351: an epic is triaged as an epic, never admitted into the standing batch" '[ "$(count "$T/triage.calls")" = $((n + 1)) ] && [ "$(qget tickets.E-1)" = undefined ]'
check "DS-351: an epic whose feature batch cannot start goes to the digest with why" '[ "$(handed E-1)" = "handed: an epic, and its feature batch was not started: its triage record names no branch for the feature batch: run /desk-autopilot E-1" ]'
n=$(count "$T/triage.calls")
search C-1 Q-1 X-1; out=$(intake)
check "AC8: a ticket already handed on is not triaged again" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$out" = "intake: nothing new" ]'

# The digest lists what intake handed on, with the way to try it again.
D=$(cd "$T/repo" && node --input-type=module -e "
import { openQuestions, renderPage } from '$B/digest.mjs';
const qs = openQuestions({ slug: 'acme__widgets', state: '$T/state', queue: '$DESK_QUEUE' });
console.log(renderPage({ slot: '2026-10-23T08:00', since: null, groups: [{ slug: 'acme__widgets', questions: qs, decisions: [] }], bin: '/b' }));")
check "the digest lists each ticket intake handed on, with why" 'grep -q "^- \[ \] \`C-1\` (intake): not admitted by intake: lane C: needs a plan$" <<< "$D" && grep -q "\`X-1\` (intake): not admitted by intake: size XL" <<< "$D"'
check "the digest says how to let intake try it again" 'grep -q "DESK_AUTOPILOT_STATE=$T/state node /b/intake.mjs forget C-1" <<< "$D"'
out=$(cd "$T/repo" && node "$T/bin/intake.mjs" forget X-1)
check "forget takes a ticket out of the register" '[ "$(handed X-1)" = none ] && grep -q "next intake triages it again" <<< "$out"'

# ---- AC7: blocked by a ticket not yet merged ----------------------------------------------------
rec B-2 A '"blockers":[{"key":"A-1","category":"indeterminate"}]'
search B-2; out=$(intake)
check "AC7: a ticket blocked by one in the batch is admitted and held behind it" '[ "$(qget tickets.B-2.held_by)" = A-1 ] && [ "$(qget tickets.B-2.state)" = parked ]'
check "AC7: the report says it is held" 'grep -q "admitted B-2 by intake into batch b1 (lane A, size S), held behind A-1" <<< "$out"'
# A blocker found in the same run is admitted first, whichever order the search gives.
rec B-4 A '"blockers":[{"key":"B-3","category":"new"}]'; rec B-3 A
search B-4 B-3; out=$(intake)
check "AC7: a blocker found in the same search is admitted first and the other held behind it" '[ "$(qget tickets.B-3.state)" = triaged ] && [ "$(qget tickets.B-4.held_by)" = B-3 ]'
rec B-6 A '"blockers":[{"key":"A-1","category":"done"}]'
search B-6; out=$(intake)
check "DS-391 AC4: a blocker in the batch that is Done in Jira but not merged there still holds it" '[ "$(qget tickets.B-6.state)" = parked ] && [ "$(qget tickets.B-6.held_by)" = A-1 ] && [ "$(qget tickets.B-6.held_outside)" = undefined ]'
# A blocker in no batch holds the ticket rather than keeping it out. DONE-2 is Done with its PR
# still open, DONE-3 Done with its PR merged to main; DONE-1 is Done with no PR.
printf '%s\n' '[{"number":5,"state":"OPEN","title":"fix: DONE-2 x","headRefName":"fix/DONE-2-x","baseRefName":"main"},{"number":6,"state":"MERGED","title":"fix: DONE-3 y","headRefName":"fix/DONE-3-y","baseRefName":"main"},{"number":7,"state":"OPEN","title":"fix: DONE-33 z","headRefName":"fix/DONE-33","baseRefName":"main"}]' > "$T/prs.json"
rec B-5 A '"blockers":[{"key":"OUT-9","category":"new"},{"key":"DONE-1","category":"done"},{"key":"DONE-2","category":"done"},{"key":"DONE-3","category":"done"}]'
search B-5; out=$(intake)
check "DS-391 AC1: a ticket blocked by an open ticket in no batch is admitted held by it" '[ "$(qget tickets.B-5.state)" = parked ] && [ "$(qget tickets.B-5.held_by)" = "OUT-9|DONE-2" ] && [ "$(qget tickets.B-5.held_outside)" = "OUT-9|DONE-2" ] && [ "$(handed B-5)" != none ] && ! grep -q "^handed" <<< "$(handed B-5)"'
check "DS-391 AC4: a blocker Done in Jira whose PR has not merged to the base holds it; one merged, or with no PR, does not" '! grep -q "DONE-1\|DONE-3" <<< "$(qget tickets.B-5.held_by)"'
check "DS-391 AC1: the report says what it waits for and until when" 'grep -q "admitted B-5 by intake into batch b1 (lane A, size S), waiting for OUT-9, DONE-2, outside the batch, until each is Done and on main" <<< "$out"'
rm -f "$T/prs.json"
# A blocker in no batch that is the person's step holds the merge, not the build. OPS-1 is a Task that
# says apply; OPS-2 is a Story naming the ticket's ben_steps; OUT-7 is an ordinary dev Task.
rec P-1 A '"blockers":[{"key":"OPS-1","category":"new","type":"Task","summary":"Apply the billing migration to staging and production"}]'
rec P-2 A '"blockers":[{"key":"OPS-2","category":"indeterminate","type":"Story","summary":"Run the cdk deploy for the queue stack"}],"ben_steps":[{"step":"cdk deploy","blocker":"Run the cdk deploy for the queue stack, unblocking P-2"}]'
rec P-3 A '"blockers":[{"key":"OUT-7","category":"new","type":"Task","summary":"Add the export endpoint"}]'
# P-4's ben_steps names its blocker's key; P-5's step is one word inside a code blocker's summary.
rec P-4 A '"blockers":[{"key":"OPS-4","category":"new","type":"Story","summary":"Queue stack"}],"ben_steps":[{"step":"a cdk deploy","blocker":"OPS-4, unblocking P-4"}]'
rec P-5 A '"blockers":[{"key":"OUT-8","category":"new","type":"Story","summary":"Deploy the search page"}],"ben_steps":[{"step":"deploy","blocker":"deploy"}]'
search P-4 P-5; intake >/dev/null
search P-1 P-2 P-3; out=$(intake)
check "DS-407 AC1: a ticket blocked only by the person's step in no batch is admitted runnable, its merge held" '[ "$(qget tickets.P-1.state)" = triaged ] && [ "$(qget tickets.P-1.held_by)" = null ] && [ "$(qget tickets.P-1.held_outside)" = undefined ] && [ "$(qget tickets.P-1.merge_after)" = OPS-1 ]'
check "DS-407 AC1: the report says it is built now and merged once the step is Done" 'grep -q "admitted P-1 by intake into batch b1 (lane A, size S), built now and merged only once OPS-1 (the person.s step) is Done" <<< "$out"'
check "DS-407 AC1: a blocker naming one of the ticket'\''s ben_steps is a person'\''s step too" '[ "$(qget tickets.P-2.state)" = triaged ] && [ "$(qget tickets.P-2.merge_after)" = OPS-2 ]'
check "DS-407 AC4: an ordinary dev ticket in no batch still holds the build, as DS-391 has it" '[ "$(qget tickets.P-3.state)" = parked ] && [ "$(qget tickets.P-3.held_outside)" = OUT-7 ] && [ "$(qget tickets.P-3.merge_after)" = undefined ]'
check "DS-682 AC4: a blocker whose key the ticket'\''s ben_steps names is a merge-only gate" '[ "$(qget tickets.P-4.state)" = triaged ] && [ "$(qget tickets.P-4.merge_after)" = OPS-4 ]'
check "DS-682 AC5: a step word inside a blocker'\''s summary no longer makes it a step: it is a full hold" '[ "$(qget tickets.P-5.state)" = parked ] && [ "$(qget tickets.P-5.held_outside)" = OUT-8 ] && [ "$(qget tickets.P-5.merge_after)" = undefined ]'

# DS-687: triage's call on an open blocker in no batch (blocker_needs) decides how it holds the ticket,
# as plan-batch decides it. OUT-21..OUT-26 are ordinary dev tickets in no batch.
needs(){ printf '"blockers":[{"key":"%s","category":"new","type":"Story","summary":"Add the export endpoint"}],"blocker_needs":{"%s":{"needs":%s,"why":"%s"}}' "$1" "$1" "$2" "$3"; }
JUDGEMENT=yes config yes
rec N-1 A "$(needs OUT-21 '"build"' 'builds the endpoint it calls')"
rec N-2 A "$(needs OUT-22 '"merge"' 'lands the flag it ships behind')"
rec N-3 A "$(needs OUT-23 '"none"' 'touches none of its files')"
rec N-4 A "$(needs OUT-24 true 'builds the endpoint it calls')"
rec N-5 A "$(needs OUT-25 false 'touches none of its files')"
search N-4 N-5; intake >/dev/null
search N-1 N-2 N-3; out=$(intake)
check "DS-687 AC2: a blocker in no batch triage calls needed to build holds the ticket fully" \
  '[ "$(qget tickets.N-1.state)" = parked ] && [ "$(qget tickets.N-1.held_outside)" = OUT-21 ] && [ "$(qget tickets.N-1.merge_after)" = undefined ]'
check "DS-687 AC3: one triage calls needed only to merge admits it unheld, as a merge-only gate" \
  '[ "$(qget tickets.N-2.state)" = triaged ] && [ "$(qget tickets.N-2.held_by)" = null ] && [ "$(qget tickets.N-2.held_outside)" = undefined ] && [ "$(qget tickets.N-2.merge_after)" = OUT-22 ]'
check "DS-687 AC3: the report says it is merged only once the blocker is Done, as triage called it" \
  'grep -q "admitted N-2 by intake into batch b1 (lane A, size S), built now and merged only once OUT-22 is Done, which triage found it needs only to merge" <<< "$out"'
check "DS-687 AC4: one triage calls not needed, under autopilot-judgement yes, holds nothing" \
  '[ "$(qget tickets.N-3.state)" = triaged ] && [ "$(qget tickets.N-3.held_by)" = null ] && [ "$(qget tickets.N-3.held_outside)" = undefined ] && [ "$(qget tickets.N-3.merge_after)" = undefined ]'
check "DS-687 AC4: and a start-without-it engineering call is logged" \
  'jq -e -s "map(select(.ticket == \"N-3\" and .category == \"engineering\" and .chose == \"start without OUT-23\")) | length == 1" "$T/state/decisions.jsonl" >/dev/null && grep -q "admitted N-3 .*started without OUT-23, outside the batch, which triage found it does not need, took 1 call(s)" <<< "$out"'
check "DS-687 AC7: a record from before the calls reads needs true as needed to build" \
  '[ "$(qget tickets.N-4.state)" = parked ] && [ "$(qget tickets.N-4.held_outside)" = OUT-24 ]'
check "DS-687 AC7: and needs false as not needed" \
  '[ "$(qget tickets.N-5.state)" = triaged ] && [ "$(qget tickets.N-5.held_outside)" = undefined ] && [ "$(qget tickets.N-5.merge_after)" = undefined ]'
config yes
rec N-6 A "$(needs OUT-26 '"none"' 'touches none of its files')"
search N-6; out=$(intake)
check "DS-687 AC4/AC5: without autopilot-judgement yes, a blocker called not needed is asked, as plan-batch asks it" \
  '[ "$(qget tickets.N-6)" = undefined ] && [[ "$(handed N-6)" == "handed: N-6 is blocked by OUT-26 (not started), which is not in this batch: add OUT-26 to the batch, or run /desk-admit N-6 again once OUT-26 is Done: triage found it is not needed (touches none of its files), but intake starts a ticket without its blocker only where §3 autopilot-judgement is yes" ]]'
# AC6: a person's step and triage's call pointing different ways hold as the one that holds more. OPS-21
# is a Task saying apply (a step: merge) that triage calls build; OPS-22 the same, called none.
rec N-7 A '"blockers":[{"key":"OPS-21","category":"new","type":"Task","summary":"Apply the billing migration"}],"blocker_needs":{"OPS-21":{"needs":"build","why":"the build reads the new table"}}'
rec N-8 A '"blockers":[{"key":"OPS-22","category":"new","type":"Task","summary":"Apply the billing migration"}],"blocker_needs":{"OPS-22":{"needs":"none","why":"touches none of its files"}}'
search N-7 N-8; out=$(intake)
check "DS-687 AC6: a step that holds the merge, called needed to build, is a full hold" \
  '[ "$(qget tickets.N-7.state)" = parked ] && [ "$(qget tickets.N-7.held_outside)" = OPS-21 ] && [ "$(qget tickets.N-7.merge_after)" = undefined ]'
check "DS-687 AC6: a step that holds the merge, called not needed, is still a merge-only gate" \
  '[ "$(qget tickets.N-8.state)" = triaged ] && [ "$(qget tickets.N-8.merge_after)" = OPS-22 ] && grep -q "admitted N-8 .*merged only once OPS-22 (the person.s step) is Done" <<< "$out"'

# DS-568: a ticket carrying one of §4 Person-step labels is admitted parked as the person's step, so no
# worker spawns, and a ticket it blocks, in the batch or out of it, is built now and merged after it.
steprow(){ printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Person-step labels | %s |\n' "$1" >> "$T/cfg/repos/acme__widgets/config.md"; }
steprow '`ben-step` `operator-task`'
rec S-1 A '"labels":["ben-step"],"files_in_scope":["infra/images.sh"],"blockers":[{"key":"OUT-6","category":"new"}]'
rec S-2 A '"files_in_scope":["infra/images.sh"],"blockers":[{"key":"S-1","category":"new","type":"Story","summary":"Rebuild the images"}]'
rec S-3 A '"blockers":[{"key":"OPS-9","category":"new","type":"Story","summary":"Create the Vercel project","labels":["Operator-Task"]}]'
search S-2 S-1 S-3; out=$(intake)
check "DS-568 AC1: a ticket labelled as the person's step is admitted parked on it, held by nothing" \
  '[ "$(qget tickets.S-1.state)" = parked ] && [[ "$(qget tickets.S-1.park.question)" == "the person'\''s step: labelled ben-step"* ]] && [ "$(qget tickets.S-1.held_by)" = null ] && [ "$(qget tickets.S-1.held_outside)" = undefined ]'
check "DS-568 AC1: the report names its park" 'grep -q "admitted S-1 by intake into batch b1 (lane A, size S), parked: the person.s step: labelled ben-step" <<< "$out"'
out=$(cd "$T/repo" && node "$T/bin/queue.mjs" requeue S-1 2>&1); rc=$?
check "DS-568 AC1: requeue refuses it, so no worker spawns" '[ $rc -ne 0 ] && grep -q "S-1 is the person.s own step" <<< "$out" && [ "$(qget tickets.S-1.state)" = parked ]'
check "DS-568 AC2: a ticket blocked by it in the batch is built now and merged after it" \
  '[ "$(qget tickets.S-2.state)" = triaged ] && [ "$(qget tickets.S-2.held_by)" = null ] && [ "$(qget tickets.S-2.merge_after)" = S-1 ]'
check "DS-568 AC2: sharing a file with the step holds nothing, since no worker ever merges the step" \
  '[ "$(qget tickets.S-2.collides_with)" = null ] && [ "$(qget tickets.S-1.collides_with)" = null ]'
check "DS-568 AC2: a blocker in no batch carrying the label is the person'\''s step whatever its summary" \
  '[ "$(qget tickets.S-3.state)" = triaged ] && [ "$(qget tickets.S-3.merge_after)" = OPS-9 ]'
rec S-7 A '"blockers":[{"key":"S-1","category":"done","type":"Story","summary":"Rebuild the images"}]'
search S-7; out=$(intake)
check "DS-568 AC2: once the step is Done, though still in the batch, a ticket it blocks is held by nothing" \
  '[ "$(qget tickets.S-7.state)" = triaged ] && [ "$(qget tickets.S-7.held_by)" = null ] && [ "$(qget tickets.S-7.merge_after)" = undefined ]'
rec S-8 A '"blockers":[{"key":"S-1","category":"new","type":"Story","summary":"Rebuild the images"}],"blocker_needs":{"S-1":{"needs":"build","why":"the build reads the images"}}'
search S-8; out=$(intake)
check "DS-687 AC6: a step in the batch that triage calls needed to build holds the build, not only the merge" \
  '[ "$(qget tickets.S-8.state)" = parked ] && [ "$(qget tickets.S-8.held_by)" = S-1 ] && [ "$(qget tickets.S-8.merge_after)" = undefined ]'
rec S-6 C '"labels":["ben-step"],"unknowns":["which region?"]'
search S-6; out=$(intake)
check "DS-568 AC1: whatever its lane or open questions, it is admitted parked as the person'\''s step, not handed on" \
  '[ "$(qget tickets.S-6.state)" = parked ] && [[ "$(qget tickets.S-6.park.question)" == "the person'\''s step: "* ]]'
config yes; steprow '`none`'
rec S-4 A '"labels":["ben-step"]'
rec S-5 A '"blockers":[{"key":"OPS-8","category":"new","type":"Story","summary":"Create the Vercel project","labels":["ben-step"]}]'
search S-4 S-5; out=$(intake)
check "DS-568 AC3: with Person-step labels none, a labelled ticket and one it blocks are triaged as today" \
  '[ "$(qget tickets.S-4.state)" = triaged ] && [ "$(qget tickets.S-5.held_outside)" = OPS-8 ] && [ "$(qget tickets.S-5.merge_after)" = undefined ]'

# A blocker carrying one of §4 Person-input labels makes something the build reads, so it holds
# the build; labelled both, the input wins; a ticket carrying one is parked as the person's step.
config yes; printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Person-step labels | `ben-step` |\n| Person-input labels | `ben-input` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
rec I-1 A '"blockers":[{"key":"OPS-11","category":"new","type":"Story","summary":"Walk through the checkout","labels":["ben-step"]}]'
rec I-2 A '"blockers":[{"key":"OPS-12","category":"new","type":"Story","summary":"Record the gateway response","labels":["ben-input"]}]'
rec I-3 A '"blockers":[{"key":"OPS-13","category":"new","type":"Task","summary":"Sign off the gateway key","labels":["ben-step","Ben-Input"]}]'
rec I-4 A '"labels":["ben-input"],"unknowns":["which account?"]'
rec I-5 A '"blockers":[{"key":"I-4","category":"new","type":"Story","summary":"Make the API key","labels":["ben-input"]}]'
search I-4 I-5; intake >/dev/null
search I-1 I-2 I-3; out=$(intake)
check "DS-682 AC1: a blocker in no batch labelled as the person's step is a merge-only gate" '[ "$(qget tickets.I-1.state)" = triaged ] && [ "$(qget tickets.I-1.merge_after)" = OPS-11 ] && [ "$(qget tickets.I-1.held_outside)" = undefined ]'
check "DS-682 AC2: a blocker in no batch labelled as an input holds the build" '[ "$(qget tickets.I-2.state)" = parked ] && [ "$(qget tickets.I-2.held_outside)" = OPS-12 ] && [ "$(qget tickets.I-2.merge_after)" = undefined ]'
check "DS-682 AC3: labelled both, the input label wins and it holds the build" '[ "$(qget tickets.I-3.state)" = parked ] && [ "$(qget tickets.I-3.held_outside)" = OPS-13 ] && [ "$(qget tickets.I-3.merge_after)" = undefined ]'
check "DS-682 AC9: a ticket carrying an input label is parked as the person's step, whatever its questions" \
  '[ "$(qget tickets.I-4.state)" = parked ] && [[ "$(qget tickets.I-4.park.question)" == "the person'\''s step: labelled ben-input (config §4 Person-input labels)"* ]] && [ "$(qget tickets.I-4.held_by)" = null ]'
check "DS-682 AC2: an input step in the batch holds the build of a ticket it blocks" '[ "$(qget tickets.I-5.state)" = parked ] && [ "$(qget tickets.I-5.held_by)" = I-4 ] && [ "$(qget tickets.I-5.merge_after)" = undefined ]'
out=$(cd "$T/repo" && node "$T/bin/queue.mjs" admit I-2 --hold-merge I-4 2>&1); rc=$?
check "DS-682 AC2: an input step in the batch cannot be made a merge gate by hand" '[ $rc -ne 0 ] && grep -q "I-4 is in this batch: hold I-2 behind it with --hold" <<< "$out"'
out=$(cd "$T/repo" && node "$T/bin/queue.mjs" drop I-4 2>&1)
check "DS-682 AC2: dropping the input step leaves the ticket it held behind it outside the batch, for the pass to lift on Done" \
  '[ "$(qget tickets.I-5.state)" = parked ] && [ "$(qget tickets.I-5.held_by)" = I-4 ] && [ "$(qget tickets.I-5.held_outside)" = I-4 ] && grep -q "I-5 is held behind it outside the batch until it is Done in Jira" <<< "$out"'
config yes

# ---- the triage cap, and a triage that fails ------------------------------------------------------
for k in M-1 M-2 M-3 M-4; do rec "$k" A; done
search M-1 M-2 M-3 M-4; out=$(intake)
check "at most three are triaged a run, and the report names the rest" '[ "$(qget tickets.M-3.state)" = triaged ] && [ "$(qget tickets.M-4)" = undefined ] && grep -q "1 more ticket(s) wait for the next intake (M-4)" <<< "$out"'
out=$(intake)
check "the rest are taken next run" '[ "$(qget tickets.M-4.state)" = triaged ]'
rec F-1 A; touch "$T/recs/F-1.fails"; search F-1
out=$(intake)
check "a triage that fails is not admitted, and is tried again next run" '[ "$(qget tickets.F-1)" = undefined ] && grep -q "F-1 not admitted: triage failed: triage: claude exited 1; the next intake tries again" <<< "$out"'
out=$(intake); out=$(intake)
check "after three failed triages it goes to the digest" 'grep -q "^handed: triage failed" <<< "$(handed F-1)"'
# Triage's exit 3 is the usage limit, named as triage's USAGE LIMIT line names it, with its reset time.
echo 'triage stopped at the weekly usage limit, which resets at 2027-01-15 08:00 UTC' > "$T/recs/U-1.limit"
search U-1; out=$(intake)
check "DS-505 AC4: a triage stopped at the usage limit says so with its reset, not as a failed triage" \
  'grep -q "U-1 not admitted: triage stopped at the weekly usage limit, which resets at 2027-01-15 08:00 UTC; the next intake tries again" <<< "$out" && ! grep -q "produced no triage record\|triage failed" <<< "$out" && [ "$(qget tickets.U-1)" = undefined ]'

# ---- a batch still being planned ---------------------------------------------------------------
printf '{"version":1,"batch":"p1","supervised":false,"tickets":{"P":{"key":"P","state":"triaged"}}}\n' > "$DESK_QUEUE"
rec A-9 A; search A-9; out=$(intake)
check "nothing joins a batch a session has not handed over" '[ "$(qget tickets.A-9)" = undefined ] && grep -q "admits nothing while batch p1 is not handed over" <<< "$out"'

# ---- AC2: no live batch ------------------------------------------------------------------------
# A session's batch between `queue.mjs init` and its plan has no tickets yet: still the session's.
printf '{"version":1,"batch":"p2","supervised":false,"tickets":{}}\n' > "$DESK_QUEUE"
out=$(intake)
check "nothing joins, or replaces, a session's batch that has no tickets yet" '[ "$(qget batch)" = p2 ] && [ "$(qget tickets.A-9)" = undefined ] && grep -q "admits nothing while batch p2 is not handed over" <<< "$out"'

# The register goes too, so the tick finds intake due.
rm -f "$DESK_QUEUE" "$T/state/supervisor.json" "$T/state/intake.json"
p=$(count "$T/pass.calls")
out=$(tick)
check "AC2: with no batch, intake starts a standing one for the ticket" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget tickets.A-9.state)" = triaged ]'
check "AC2: the standing batch is handed over to the supervisor" '[ "$(qget supervised)" = true ]'
check "AC2: the same tick runs a pass for it, reporting the start" '[ "$(count "$T/pass.calls")" = $((p + 1)) ] && grep -B1 "intake: started standing batch standing-" "$T/state/supervisor.log" | grep -q "pass: exit 10"'
i=0; while ! grep -q -- "--all-batches --log" "$T/driver.calls" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
check "AC2: the merge driver picks it up" 'grep -q -- "--all-batches --log" "$T/driver.calls"'
# A finished batch is not live either: the next ticket starts a new one. A blocker in it is outside the
# new one, so a ticket it blocks is held by it there.
printf '{"version":1,"batch":"old","supervised":true,"tickets":{"Z":{"key":"Z","state":"done","result":{"pr":null}}}}\n' > "$DESK_QUEUE"
rec A-7 A '"blockers":[{"key":"Z","category":"indeterminate"}]'
rec A-8 A; search A-8 A-7; out=$(intake)
check "AC2: a finished batch gets a new standing batch" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget tickets.A-8.state)" = triaged ] && [ "$(qget tickets.Z)" = undefined ]'
check "a blocker left in the finished batch holds its ticket in the new one" '[ "$(qget tickets.A-7.held_outside)" = Z ] && grep -q "^admitted: lane A, size S, waiting for Z, outside the batch" <<< "$(handed A-7)"'
# DS-757: a session's batch whose finished tickets all moved to the archive is finished, not one with
# no tickets yet: the next ticket starts a new standing batch.
printf '{"version":3,"batch":"arch","supervised":false,"tickets":{}}\n' > "$DESK_QUEUE"
printf '{"tickets":{"Z":{"key":"Z","state":"done","result":{"pr":7},"merged_at":"2026-11-16T10:00:00.000Z"}}}\n' > "${DESK_QUEUE%.json}.archive.json"
rec A-61 A; search A-61; out=$(intake)
check "DS-757 a batch whose tickets are all archived is finished: a new standing batch takes the ticket" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget tickets.A-61.state)" = triaged ]'
rm -f "${DESK_QUEUE%.json}.archive.json"
# Not finished: a failed ticket waits on the person, and a batch on a base has its gate to come.
printf '{"version":1,"batch":"f1","supervised":false,"tickets":{"Z":{"key":"Z","state":"failed"}}}\n' > "$DESK_QUEUE"
rec A-6 A; search A-6; out=$(intake)
check "a batch with a failed ticket is not replaced" '[ "$(qget batch)" = f1 ] && [ "$(qget tickets.A-6)" = undefined ] && grep -q "batch f1 is not handed over" <<< "$out"'
printf '{"version":1,"batch":"feat","base":"feat/x","supervised":true,"tickets":{"Z":{"key":"Z","state":"done","result":{"pr":null}}}}\n' > "$DESK_QUEUE"
out=$(intake)
check "nothing joins or replaces a batch on a base" '[ "$(qget batch)" = feat ] && [ "$(qget tickets.A-6)" = undefined ] && grep -q "runs on base feat/x" <<< "$out"'
# queue.mjs checks again under its lock: a batch that is no longer the finished one is left alone.
printf '{"version":1,"batch":"p3","supervised":false,"tickets":{}}\n' > "$DESK_QUEUE"
out=$(cd "$T/repo" && node "$T/bin/queue.mjs" init standing-x --standing --if-batch old 2>&1); rc=$?
check "init --standing refuses a queue that is not the batch intake found finished" '[ $rc -ne 0 ] && [ "$(qget batch)" = p3 ] && grep -q "left as it is" <<< "$out"'
out=$(cd "$T/repo" && node "$T/bin/queue.mjs" init named-batch 2>&1)
check "a plain init keeps the batch name it is given" '[ "$(qget batch)" = named-batch ]'

# ---- with no batch at all, what intake hands on still reaches the check-in ----------------------
rm -f "$DESK_QUEUE" "$T/state/intake.json"; search C-1; d=$(count "$T/digest.calls")
out=$(tick)
check "with no batch, a tick that hands a ticket on runs the check-in" '[ ! -f "$DESK_QUEUE" ] && [ "$(handed C-1)" = "handed: lane C: needs a plan" ] && [ "$(count "$T/digest.calls")" = $((d + 1)) ]'
mkdir -p "$T/sroot/acme__other"; echo '{}' > "$T/sroot/acme__other/intake.json"
R=$(node --input-type=module -e "import { repos } from '$B/digest.mjs'; console.log(repos({ home: '$T/nohome', root: '$T/sroot' }).map((r) => r.slug).join(','));")
check "the digest finds a repo whose only news is intake's" '[ "$R" = acme__other ]'

# ---- a Claude Design canvas no worker can read -------------------------------------------------
# design <url> <snapshot or null>: the design fact triage records for one linked canvas.
design(){ printf '"design":{"ref":"origin/main","canvases":[{"url":"%s","saved":null,"snapshot":%s}],"figma":false}' "$1" "$2"; }
config yes; running_batch; rec G-1 A "$(design https://claude.ai/artifact/G1 null)"; search G-1
out=$(intake)
check "DS-358 AC5: intake admits a ticket whose canvas has no snapshot parked, not runnable" '[ "$(qget tickets.G-1.state)" = parked ] && grep -q "^design not snapshotted: https://claude.ai/artifact/G1: snapshot it from a session" <<< "$(qget tickets.G-1.park.question)"'
check "DS-358 AC5: the report names the artifact" 'grep -q "intake: admitted G-1 by intake into batch b1 (lane A, size S), parked: design not snapshotted: https://claude.ai/artifact/G1" <<< "$out"'
# Triage's lint flags the same canvas as blocking; the design park names it, so intake parks rather
# than hands it on. Its blocker in the batch is kept, and a requeue once it is snapshotted holds it.
config yes; running_batch; rm -f "$T/state/intake.json"
rec G-2 A "$(design https://claude.ai/artifact/G2 null),\"lint\":[{\"severity\":\"blocking\",\"rule\":\"design\",\"message\":\"design: G-2's Design section links the Claude Design artifact https://claude.ai/artifact/G2, but no copy is saved under docs/design/\"}],\"blockers\":[{\"key\":\"R\",\"category\":\"new\"}]"; search G-2
out=$(intake)
check "DS-358 AC5: a blocking design lint on the unread canvas still parks the ticket on its design" '[ "$(qget tickets.G-2.state)" = parked ] && grep -q "^design not snapshotted: https://claude.ai/artifact/G2" <<< "$(qget tickets.G-2.park.question)"'
check "DS-358: the design-parked ticket keeps its blocker in the batch" '[ "$(qget tickets.G-2.held_by)" = R ]'
requeue(){ (cd "$T/repo" && node "$T/bin/queue.mjs" requeue "$1" 2>&1); }
out=$(requeue G-2)
check "DS-358: a requeue holds it behind its unmerged blocker, never straight to a worker" '[ "$(qget tickets.G-2.state)" = parked ] && grep -q "^held by orchestrator: blocked by R" <<< "$(qget tickets.G-2.park.question)" && grep -q "held behind R until they merge" <<< "$out"'
node -e 'const f=process.argv[1],fs=require("fs"),q=JSON.parse(fs.readFileSync(f,"utf8")); q.tickets.R={key:"R",state:"done",merged_at:"2026-10-01T00:00:00Z"}; Object.assign(q.tickets["G-2"],{park:{question:"design not snapshotted: x"}}); fs.writeFileSync(f,JSON.stringify(q))' "$DESK_QUEUE"
out=$(requeue G-2)
check "DS-358: with its blocker merged, a requeue sends it to a worker" '[ "$(qget tickets.G-2.state)" = triaged ] && [ "$(qget tickets.G-2.held_by)" = null ]'

# ---- by hand: intake.mjs admit (/desk-admit) -----------------------------------------------------
# Its output goes to admit.out as it is printed, where a gate can wait on it, and then to stdout.
admit(){ local rc; (cd "$T/repo" && node "$T/bin/intake.mjs" admit "$@" > "$T/admit.out" 2>&1); rc=$?; cat "$T/admit.out"; return $rc; }
config yes '`none`'; running_batch; rm -f "$T/state/intake.json"
rec H-1 A; n=$(count "$T/triage.calls")
out=$(admit H-1 --by ben); rc=$?
check "admit: a clean ticket joins the supervised batch with no intake query set" '[ $rc -eq 0 ] && [ "$(qget tickets.H-1.state)" = triaged ] && [ "$(qget tickets.H-1.admitted_by)" = ben ]'
check "admit: it is triaged afresh, and the line says who admitted it and that the tick picks it up" '[ "$(count "$T/triage.calls")" = $((n + 1)) ] && grep -q "^admitted H-1 by ben into batch b1 (lane A, size S)$" <<< "$out" && grep -q "next tick picks it up" <<< "$out"'
check "admit: the register records it, so intake never takes it again" 'grep -q "^admitted: lane A, size S, by ben$" <<< "$(handed H-1)"'
out=$(admit H-1); rc=$?
check "admit: a ticket already in the batch is said so, not triaged again" '[ $rc -eq 0 ] && grep -q "H-1 is already in batch b1 (triaged)" <<< "$out" && [ "$(count "$T/triage.calls")" = $((n + 1)) ]'
rec H-2 A '"unknowns":["which tier?"]'; rec H-3 C
out=$(admit H-2 H-3); rc=$?
check "admit: a ticket failing a check is refused to the person with why, exit 11" '[ $rc -eq 11 ] && grep -q "^not admitted H-2: open question(s): which tier?$" <<< "$out" && grep -q "^not admitted H-3: lane C: needs a plan$" <<< "$out"'
check "admit: a refused ticket is not queued or handed to the digest" '[ "$(qget tickets.H-2)" = undefined ] && [ "$(handed H-2)" = none ]'

# Another person's PR for a ticket: an open one refuses it, naming the PR and its author; one only merged
# reads as done. desk's own PRs, and a merged PR that only mentions it in its body, do not count.
pr_json(){ printf '{"number":%s,"state":"%s","title":"%s","headRefName":"%s","body":"%s","author":{"login":"%s"},"baseRefName":"main"}' "$@"; }
printf '[%s,%s,%s,%s,%s]\n' "$(pr_json 41 OPEN "feat: O-1 thing" feat/O-1 "" alice)" "$(pr_json 42 OPEN "Epic roll-up" epic/E "Children: O-2, O-9" alice)" \
  "$(pr_json 43 MERGED "fix: O-3 done" fix/O-3 "" bob)" "$(pr_json 44 OPEN "fix: O-4 mine" fix/O-4 "" me)" "$(pr_json 45 MERGED "chore: tidy" chore/x "follows O-5" bob)" > "$T/prs.json"
rec O-1 A; rec O-2 A; rec O-3 A; rec O-4 A; rec O-5 A; n=$(count "$T/triage.calls")
out=$(DESK_GITHUB_HANDLE=me admit O-1 O-2); rc=$?
check "admit: a ticket another person has an open PR for is refused, naming the PR and its author" '[ $rc -eq 11 ] && grep -qx "not admitted O-1: already in progress by alice in #41" <<< "$out"'
check "admit: so is one an open PR of theirs names in its body (an epic roll-up)" 'grep -qx "not admitted O-2: already in progress by alice in #42" <<< "$out"'
check "admit: neither is triaged or queued" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$(qget tickets.O-1)" = undefined ] && [ "$(qget tickets.O-2)" = undefined ]'
out=$(DESK_GITHUB_HANDLE=me admit O-3); rc=$?
check "admit: one another person's merged PR names reads as done, not admitted" '[ $rc -eq 0 ] && grep -qx "O-3 is already done by bob in #43 (merged): nothing triaged or admitted" <<< "$out" && [ "$(qget tickets.O-3)" = undefined ]'
out=$(DESK_GITHUB_HANDLE=me admit O-4 O-5)
check "admit: desk's own PR, or another person's merged PR only mentioning it, is no refusal" '! grep -q "already in progress\|already done by" <<< "$out" && [ "$(qget tickets.O-4.state)" = triaged ] && [ "$(qget tickets.O-5.state)" = triaged ]'
config yes; search O-9; rec O-9 A; n=$(count "$T/triage.calls")
out=$(DESK_GITHUB_HANDLE=me intake)
config yes '`none`'
check "intake: a ticket another person has an open PR for is handed to the digest with it, not triaged" 'grep -q "intake: handed O-9 to the digest: already in progress by alice in #42" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ] && [ "$(qget tickets.O-9)" = undefined ]'
printf '[%s]\n' "$(pr_json 46 MERGED "fix: O-8 done" fix/O-8 "" bob)" > "$T/prs.json"; config yes; search O-8; rec O-8 A
out=$(DESK_GITHUB_HANDLE=me intake); out2=$(DESK_GITHUB_HANDLE=me intake); config yes '`none`'
check "intake: a ticket another person's merged PR did is recorded done once, and not said again" 'grep -q "intake: O-8 already done by bob in #46 (merged): nothing triaged or admitted" <<< "$out" && ! grep -q "O-8" <<< "$out2" && grep -q "^done: already done by bob in #46" <<< "$(handed O-8)"'
rm -f "$T/prs.json"
echo 'triage stopped at the usage limit' > "$T/recs/U-2.limit"
cp "$T/recs/U-1.limit" "$T/recs/U-3.limit"
out=$(admit U-3); rc=$?
check "DS-505 AC4: /desk-admit refuses a ticket stopped at the usage limit with the limit, its reset, and to try once it lifts" \
  '[ $rc -eq 11 ] && grep -qx "not admitted U-3: triage stopped at the weekly usage limit, which resets at 2027-01-15 08:00 UTC: run /desk-admit U-3 again once the limit lifts" <<< "$out"'
out=$(admit U-2); rc=$?
check "DS-505 AC4: a limit with no reset time names the limit alone" \
  '[ $rc -eq 11 ] && grep -qx "not admitted U-2: triage stopped at the usage limit: run /desk-admit U-2 again once the limit lifts" <<< "$out"'
out=$(admit U-2 --json); out2=$(admit H-2 --json)
check "DS-569: --json names a ticket the usage limit stopped as limited, and one refused for its own reason as not" \
  '[ "$(jq -c "[.refused, .limited]" <<< "$out")" = "[[\"U-2\"],[\"U-2\"]]" ] && [ "$(jq -c "[.refused, .limited]" <<< "$out2")" = "[[\"H-2\"],[]]" ]'
rec H-5 A '"blockers":[{"key":"H-4","category":"new"}]'; rec H-4 A
out=$(admit H-5 H-4 --front)
check "admit: a blocker named in the same call goes first, and the other is held behind it" '[ "$(qget tickets.H-4.state)" = triaged ] && [ "$(qget tickets.H-5.held_by)" = H-4 ]'
# K-1 is refused (lane C); K-2 behind it and K-3 behind K-2 are not refused for it.
rec K-1 C; rec K-2 A '"blockers":[{"key":"K-1","category":"new"}]'; rec K-3 A '"blockers":[{"key":"K-2","category":"new"}]'
out2=$(admit K-3 K-2 K-1); rc=$?
check "DS-391 AC2: a dependant of a blocker refused in the call waits for it, and none is refused for not being in the batch" \
  '[ $rc -eq 11 ] && grep -q "^not admitted K-1: lane C" <<< "$out2" && ! grep -q "not in the batch" <<< "$out2" && [ "$(qget tickets.K-2.held_outside)" = K-1 ] && [ "$(qget tickets.K-3.held_by)" = K-2 ]'
check "DS-391 AC2: the line names the blocker as waited for and not admitted in this call, and admits nothing more for it" \
  'grep -q "^admitted K-2 by hand into batch b1 (lane A, size S), waiting for K-1 (not admitted in this call), outside the batch, until it is Done and on main$" <<< "$out2" && ! grep -q "^admit next" <<< "$out2"'
# A cascade: N-1 is blocked by NX, open and in no batch; N-2 and N-3 are blocked by N-1.
rec N-1 A '"blockers":[{"key":"NX","category":"new"}]'; rec N-2 A '"blockers":[{"key":"N-1","category":"new"}]'; rec N-3 A '"blockers":[{"key":"N-1","category":"indeterminate"}]'
out2=$(admit N-3 N-2 N-1); rc=$?
check "DS-391: the KAN-1292 cascade is admitted whole, the root held by its blocker in no batch and the rest behind the root" \
  '[ $rc -eq 0 ] && [ "$(qget tickets.N-1.held_outside)" = NX ] && [ "$(qget tickets.N-2.held_by)" = N-1 ] && [ "$(qget tickets.N-3.held_by)" = N-1 ] && ! grep -q "^not admitted" <<< "$out2"'
check "DS-391 AC5: an open blocker in no batch is named for /desk-admit to admit next" 'grep -qx "admit next: NX (open blockers in no batch)" <<< "$out2"'
rec P-4 A '"blockers":[{"key":"OPS-4","category":"new","type":"Task","summary":"Confirm the price list with finance"}]'
out2=$(admit P-4); rc=$?
check "DS-407 AC1: /desk-admit admits it runnable too, and never names the person'\''s step to admit next" '[ $rc -eq 0 ] && [ "$(qget tickets.P-4.merge_after)" = OPS-4 ] && [ "$(qget tickets.P-4.state)" = triaged ] && ! grep -q "^admit next" <<< "$out2"'
check "admit: --front moves each admitted ticket to the front" 'grep -q "H-4 moved to the front of the spawn order" <<< "$out" && [ "$(node -e "console.log(Object.keys(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).tickets)[0])" "$DESK_QUEUE")" = H-5 ]'
# The spawn order of a queue, and a ticket's state set in it by hand. The DS-510 AC2 check passes
# order a feature batch's queue from inside its eval'd condition string, which shellcheck cannot see.
# shellcheck disable=SC2120
order(){ node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tickets).join(" "))' "${1:-$DESK_QUEUE}"; }
qstate(){ node -e 'const f=require("fs"),p=process.argv[1],q=JSON.parse(f.readFileSync(p,"utf8")); q.tickets[process.argv[2]].state=process.argv[3]; f.writeFileSync(p,JSON.stringify(q))' "$DESK_QUEUE" "$1" "$2"; }
was=$(order); out=$(admit H-1); rc=$?
check "DS-510 AC4: without --front, a ticket already in the batch is said so and the order is unchanged" '[ $rc -eq 0 ] && grep -qx "H-1 is already in batch b1 (triaged)" <<< "$out" && ! grep -qE "front|stays at" <<< "$out" && [ "$(order)" = "$was" ]'
out=$(admit H-1 --front); rc=$?
check "DS-510 AC1: --front moves a ticket already in the batch to the front, and says so" '[ $rc -eq 0 ] && grep -qx "H-1 is already in batch b1 (triaged)" <<< "$out" && grep -qx "H-1 moved to the front of the spawn order" <<< "$out" && [ "$(order | cut -d" " -f1)" = H-1 ]'
qstate H-4 running; was=$(order); out=$(admit H-4 --front); rc=$?
check "DS-510 AC3: --front leaves a running ticket where it is, and says why" '[ $rc -eq 0 ] && grep -qx "H-4 not moved to the front: it is running, so it has no place left in the spawn order" <<< "$out" && [ "$(order)" = "$was" ]'
qstate H-4 triaged
(cd "$T/repo" && node "$T/bin/queue.mjs" move H-1 3 >/dev/null 2>&1); was=$(order); out=$(admit H-1 --front); rc=$?
check "DS-510 AC3: --front leaves a ticket the person placed where they put it, and says why" '[ $rc -eq 0 ] && grep -qx "H-1 stays at position 3 of the spawn order, where the user placed it" <<< "$out" && [ "$(order)" = "$was" ]'
rec H-9 A "$(design https://claude.ai/artifact/H9 null)"; rec H-10 A "$(design https://claude.ai/artifact/H10 '"/snap/H-10"')"
out=$(admit H-9 H-10 --by ben); rc=$?
check "DS-358 AC4: /desk-admit refuses a ticket whose canvas has no snapshot, naming the artifact" '[ $rc -eq 11 ] && grep -q "^not admitted H-9: design not snapshotted: https://claude.ai/artifact/H9: snapshot it into $T/state/designs/H-9/ and record it (desk-design write), import its HTML export (desk-design import), or have it shared" <<< "$out" && [ "$(qget tickets.H-9)" = undefined ]'
check "DS-358 AC1: a snapshotted canvas is admitted runnable" '[ "$(qget tickets.H-10.state)" = triaged ]'
steprow '`ben-step`'
rec H-11 A "$(design https://claude.ai/artifact/H11 null),\"labels\":[\"ben-step\"]"
out=$(admit H-11 --by ben); rc=$?
check "DS-568 AC1: /desk-admit admits the person's step parked on it, though its canvas has no snapshot: no worker reads it" \
  '! grep -q "not admitted H-11" <<< "$out" && [ "$(qget tickets.H-11.state)" = parked ] && [[ "$(qget tickets.H-11.park.question)" == "the person'\''s step: "* ]]'
# Without autopilot-workers yes, a session plans an epic with the person.
config ask '`none`'
rec H-6 A '"type":"Epic"'
out=$(admit H-6); rc=$?
check "DS-300 AC1: without autopilot-workers yes, an epic is reported as one to plan as a feature batch, not refused" '[ $rc -ne 11 ] && grep -q "^plan H-6 as a feature batch beside the standing batch: /desk-autopilot H-6$" <<< "$out" && ! grep -q "not admitted" <<< "$out" && [ "$(qget tickets.H-6)" = undefined ]'
rec H-8 A
out=$(admit H-6 H-8); rc=$?
check "DS-300 AC2: an epic and a ticket in one call: the ticket is admitted, the epic reported to plan" '[ $rc -ne 11 ] && [ "$(qget tickets.H-8.state)" = triaged ] && grep -q "^admitted H-8 by hand into batch b1" <<< "$out" && grep -q "^plan H-6 as a feature batch" <<< "$out"'
config yes '`none`'
SK="$S/../skills/desk-admit/SKILL.md"
check "DS-300: the desk-admit skill routes a plan line to the /desk-autopilot epic flow" 'grep -q "^Each \`plan <EPIC> as a feature batch beside the standing batch: /desk-autopilot <EPIC>\` line means" "$SK" && grep -q "Load \`desk-autopilot\` and run its epic flow" "$SK" && ! grep -q "| \`an epic\` | Plan it as a feature batch" "$SK"'
check "DS-391 AC5: the desk-admit skill admits an open blocker named by admit next with no question, and no longer asks to" \
  'grep -q "^\`admit next: <B>...\` line\*\* names the open blockers in no batch" "$SK" && grep -q "^again for exactly those, at once, with no question" "$SK" && ! grep -q "which is not done and not in the batch" "$SK"'
printf '{"version":1,"batch":"s1","supervised":false,"tickets":{"P":{"key":"P","state":"running"}}}\n' > "$DESK_QUEUE"
rec H-7 A; n=$(count "$T/triage.calls")
out=$(admit H-7); rc=$?
check "admit: a session-run batch is refused before any triage, pointing at that session" '[ $rc -eq 11 ] && [ "$(count "$T/triage.calls")" = "$n" ] && grep -q "is run by a session, not the supervisor: send these tickets to that session" <<< "$out"'
check "#877 the refusal names the command that session admits with" 'grep -q "let it admit them with node .*intake.mjs admit H-7 --session, or" <<< "$out"'
check "#824 and tells the session that runs the batch to run it itself, not message itself" 'grep -q "intake.mjs admit H-7 --session, or, if this session is the one that runs it, run that yourself$" <<< "$out"'
check "#824 desk-admit says the session that runs the batch admits with --session itself, never by messaging itself" 'grep -q "^- \`--session\`: only when this session runs the batch" "$SK" && grep -q "run the command the line names (\`… --session\`), never \`queue.mjs admit\` and never a message to yourself" "$SK"'
out=$(admit H-7 --session); rc=$?
check "#877 with --session, the session that runs the batch admits into it" '[ $rc -ne 11 ] && [ "$(qget tickets.H-7.state)" = triaged ] && [ "$(qget supervised)" = false ] && grep -q "^admitted H-7 by hand into batch s1" <<< "$out"'
check "#877 and says its own next pass picks it up, not the supervisor" 'grep -q "^this session.s next pass picks up H-7$" <<< "$out" && ! grep -q "supervisor.s next tick" <<< "$out"'
# A mid-batch admit says where each ticket runs, as the batch plan does, where workers run in the cloud.
WORKER_LOC=cloud; config yes '`none`'
printf '{"version":1,"batch":"s1","supervised":false,"tickets":{"P":{"key":"P","state":"running"}}}\n' > "$DESK_QUEUE"
rec H-21 A '"needs_local":false,"needs_db":false,"renders":false'; rec H-22 A '"needs_local":false,"needs_db":true,"renders":false'
out=$(admit H-21 H-22 --session); rc=$?
check "#1000 a mid-batch admit into a cloud batch says each ticket runs in the cloud" '[ $rc -ne 11 ] && grep -q "^admitted H-21 by hand into batch s1 .*; runs: cloud$" <<< "$out"'
check "#1000 or locally, with why" 'grep -q "^admitted H-22 by hand into batch s1 .*; runs: local — it needs a local database$" <<< "$out"'
WORKER_LOC=; config yes '`none`'
printf '{"version":1,"batch":"s1","supervised":false,"tickets":{"P":{"key":"P","state":"running"}}}\n' > "$DESK_QUEUE"
rec H-23 A
out=$(admit H-23 --session)
check "#1000 with workers local, no runs: line, as before" 'grep -q "^admitted H-23 by hand into batch s1" <<< "$out" && ! grep -q "runs:" <<< "$out"'
# #1332: a missing design on a ticket triage found renders nothing says so, naming its files, so
# desk-admit writes "No UI." with that reason and admits it again; one that may render keeps it as is.
rec H-41 A '"renders":false,"files_in_scope":["e2e/login.spec.ts","playwright.config.ts"],"lint":[{"severity":"blocking","rule":"design","message":"no design link and no \"No UI.\" line: put the Figma or Claude Design URL in a Design section, or write \"No UI.\" there"}]'
out=$(admit H-41 --session); rc=$?
check "#1332 a tests-only ticket's missing design says triage found nothing renders, naming its files and what to write" '[ $rc -eq 11 ] && grep -qF "lint (blocking): no design link and no \"No UI.\" line: put the Figma or Claude Design URL in a Design section, or write \"No UI.\" there — triage found nothing renders: it changes e2e/login.spec.ts, playwright.config.ts; write \"No UI.\" with that reason in its Design section, then admit it again" <<< "$out"'
rec H-42 A '"renders":true,"lint":[{"severity":"blocking","rule":"design","message":"no design link and no \"No UI.\" line: put the Figma or Claude Design URL in a Design section, or write \"No UI.\" there"}]'
out=$(admit H-42 --session)
check "#1332 one that may render keeps the finding as it was" 'grep -qF "no design link and no \"No UI.\" line" <<< "$out" && ! grep -q "triage found nothing renders" <<< "$out"'
check "#1332 desk-admit writes No UI. with the line's reason and admits it again, asking no one" 'grep -q "^- \*\*no design link\*\* where the line adds \`triage found nothing renders\`" "$SK" && grep -qF "(\`No UI. Triage found nothing renders: it changes …\`) as the Design section." "$SK"'
# #1383: on a GitHub-issues repo, admit writes what desk can draft from the issue itself (the criteria
# triage drafted, "No UI." where nothing renders, "None." and the test command) with gh issue edit under
# §3 gh-issue-edit, lints it again and admits it; a text with no testable outcome is one needs-you ask.
issues_cfg(){ GH_ISSUE_EDIT="$1" config yes '`none`'; printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `none` |\n| Unit tests | `bash tests/run.sh` |\n' >> "$T/cfg/repos/acme__widgets/config.md"; }
issue_body(){ mkdir -p "$T/issues"; printf '## Goal\nRefunds show in the ledger.\n\n## Proposal\nWrite a ledger row per refund.\n' > "$T/issues/$1.md"; }
LINT_AC='{"severity":"blocking","rule":"criteria","message":"no acceptance criteria: add an \"Acceptance criteria\" section (an Epic'\''s \"Definition of done\") of AC1: Given …, when …, then … items"}'
LINT_UI='{"severity":"blocking","rule":"design","message":"no design link and no \"No UI.\" line: put the Figma or Claude Design URL in a Design section, or write \"No UI.\" there"}'
DRAFTED='"drafted_criteria":["Given a refund, when it is issued, then the ledger has a row for it","AC2: Given two refunds, when both are issued, then the ledger has two rows"]'
issues_cfg yes
printf '{"version":1,"batch":"s1","supervised":false,"tickets":{"P":{"key":"P","state":"running"}}}\n' > "$DESK_QUEUE"
rm -f "$T/issue-edit.calls"; issue_body 71
rec issue-71 A "\"renders\":false,$DRAFTED,\"lint\":[$LINT_AC,$LINT_UI]"
out=$(admit issue-71 --session); rc=$?
B71="$(cat "$T/issues/71.md")"
check "#1383 AC1 a GitHub issue whose triage found nothing renders gets a Design section of No UI. and the reason, through gh issue edit" '[ "$(count "$T/issue-edit.calls")" = 1 ] && grep -q "^issue edit 71 --repo acme/widgets --body-file " "$T/issue-edit.calls" && grep -qxF "## Design" <<< "$B71" && grep -qxF "No UI. Triage found nothing renders: it changes src/issue-71.js." <<< "$B71"'
check "#1383 AC2 with no criteria, the ones triage drafted from the proposal are written as AC1… items noted as drafted by desk" 'grep -qxF "## Acceptance criteria" <<< "$B71" && grep -qxF "_Drafted by desk from the proposal: reviewed like any other criteria._" <<< "$B71" && grep -qxF -- "- AC1: Given a refund, when it is issued, then the ledger has a row for it" <<< "$B71" && grep -qxF -- "- AC2: Given two refunds, when both are issued, then the ledger has two rows" <<< "$B71" && grep -qxF "Write a ledger row per refund." <<< "$B71"'
check "#1383 AC4 a missing Out of scope and Verification are filled with None. and the repo test command" 'grep -A1 -xF "## Out of scope" <<< "$B71" | grep -qxF "None." && grep -A1 -xF "## Verification" <<< "$B71" | grep -qxF "\`bash tests/run.sh\`."'
check "#1383 AC1/AC2 the edit is printed as posted, the issue linted again, and it is admitted" '[ $rc -ne 11 ] && grep -qF "ISSUE EDIT issue-71 — posted" <<< "$out" && grep -q "^target : acme/widgets#71$" <<< "$out" && grep -q "^admitted issue-71 by hand into batch s1" <<< "$out" && [ "$(jget "$T/state/triage/issue-71.json" lint.length)" = 0 ]'
issues_cfg ask
rm -f "$T/issue-edit.calls"; issue_body 72
rec issue-72 A "\"renders\":false,$DRAFTED,\"lint\":[$LINT_AC,$LINT_UI]"
out=$(admit issue-72 --session); rc=$?
check "#1383 at gh-issue-edit ask nothing is written: the block awaits approval and the line names the gh issue edit to run" '[ $rc -eq 11 ] && [ "$(count "$T/issue-edit.calls")" = 0 ] && ! grep -q "## Design" "$T/issues/72.md" && grep -qF "ISSUE EDIT issue-72 — awaiting approval" <<< "$out" && grep -qF "desk drafted Acceptance criteria, Design, Out of scope, Verification for it but wrote nothing, as config §3 gh-issue-edit is \"ask\": once the person agrees, write it with gh issue edit 72 --repo acme/widgets --body-file $T/state/fills/issue-72.md, then admit it again" <<< "$out" && grep -qxF "No UI. Triage found nothing renders: it changes src/issue-72.js." "$T/state/fills/issue-72.md"'
check "#1383 and the criteria line lists what triage drafted, to write as they are" 'grep -qF "triage drafted 2 from its goal and proposal; write them as its Acceptance criteria, under \"Drafted by desk from the proposal: reviewed like any other criteria.\", then admit it again: AC1: Given a refund, when it is issued, then the ledger has a row for it · AC2: Given two refunds" <<< "$out"'
issues_cfg yes
rm -f "$T/issue-edit.calls" "$T/state/asks.json"; issue_body 73
rec issue-73 A '"renders":true,"drafted_criteria":[],"lint":['"$LINT_AC"']'
out=$(admit issue-73 --session); rc=$?
out2=$(admit issue-73 --session)
check "#1383 AC3 a text with no testable outcome drafts no criteria, writes nothing and is refused" '[ $rc -eq 11 ] && [ "$(count "$T/issue-edit.calls")" = 0 ] && grep -qF "not admitted issue-73: lint (blocking): no acceptance criteria" <<< "$out" && grep -qF "its text states no testable outcome, so desk drafted none" <<< "$out"'
check "#1383 AC3 and raises one needs-you ask for that ticket, however often it is admitted" '[ "$(node -e "const a=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).asks.filter((x)=>x.text.includes(\"acceptance criteria for issue-73\")); console.log(a.length+\" \"+a[0].until.join())" "$T/state/asks.json")" = "1 issue-73" ] && grep -q "^needs-you: already records writing acceptance criteria for issue-73$" <<< "$out2"'
# A ticket file (a slug, with no tracker) is written in place, with no grant needed.
mkdir -p "$T/state/tickets"; printf '# fix-ledger-rows\n\nSource: the user\n\nRefunds show in the ledger.\n\n## Acceptance criteria\n- AC1: Given a refund, when it is issued, then the ledger has a row\n' > "$T/state/tickets/fix-ledger-rows.md"
rec fix-ledger-rows A "\"renders\":false,\"lint\":[$LINT_UI]"
out=$(admit fix-ledger-rows --session); rc=$?
check "#1383 a ticket file gets No UI., None. and the test command written into it, and is admitted" '[ $rc -ne 11 ] && grep -qF "TICKET FILE EDIT fix-ledger-rows — posted" <<< "$out" && grep -qxF "No UI. Triage found nothing renders: it changes src/fix-ledger-rows.js." "$T/state/tickets/fix-ledger-rows.md" && grep -qxF "None." "$T/state/tickets/fix-ledger-rows.md" && [ "$(grep -c "^## Acceptance criteria" "$T/state/tickets/fix-ledger-rows.md")" = 1 ] && grep -q "^admitted fix-ledger-rows by hand" <<< "$out"'
check "#1488 AC3 criteria already labelled are left unchanged" 'grep -qxF -- "- AC1: Given a refund, when it is issued, then the ledger has a row" "$T/state/tickets/fix-ledger-rows.md"'
# #1488: Given/When/Then criteria with no AC labels, in a preformatted block outside any criteria heading,
# are numbered in order under one, keeping their text, and the ticket is admitted.
printf '# gwt-ledger\n\nSource: the user\n\nRefunds show in the ledger.\n\n```\nGiven a refund\nWhen it is issued\nThen the ledger has a row for it\n\nGiven two refunds\nwhen both are issued\nthen the ledger has two rows\n```\n\n## Design\nNo UI.\n' > "$T/state/tickets/gwt-ledger.md"
LINT_GWT='{"severity":"blocking","rule":"criteria","numbered":["Given a refund When it is issued Then the ledger has a row for it"],"message":"no acceptance criteria section, but 1 Given/When/Then criteria with no AC labels (line 8): move them under an \"Acceptance criteria\" heading as AC1: … items"}'
rec gwt-ledger A "\"renders\":false,\"drafted_criteria\":[],\"lint\":[$LINT_GWT]"
out=$(admit gwt-ledger --session); rc=$?
G="$T/state/tickets/gwt-ledger.md"
check "#1488 AC1 unlabelled Given/When/Then blocks in a preformatted block are numbered AC1, AC2 under an Acceptance criteria heading, keeping their text" 'grep -A2 -xF "## Acceptance criteria" "$G" | grep -qxF -- "- AC1: Given a refund When it is issued Then the ledger has a row for it" && grep -A2 -xF "## Acceptance criteria" "$G" | grep -qxF -- "- AC2: Given two refunds when both are issued then the ledger has two rows"'
check "#1488 AC1 they are moved, not copied, and the emptied block goes" '[ "$(grep -c "Given" "$G")" = 2 ] && ! grep -q "^\`\`\`" "$G" && grep -qxF "Refunds show in the ledger." "$G"'
check "#1488 AC1 the ticket is linted again and admitted, with no needs-you ask" '[ $rc -ne 11 ] && grep -qF "TICKET FILE EDIT gwt-ledger — posted" <<< "$out" && grep -q "^admitted gwt-ledger by hand" <<< "$out" && [ "$(jget "$T/state/triage/gwt-ledger.json" lint.length)" = 0 ] && ! grep -q "acceptance criteria for gwt-ledger" "$T/state/asks.json" 2>/dev/null'
# In a list in another section, under an empty criteria heading, they are numbered under that heading;
# prose and a shell block elsewhere stay as they are.
printf '# gwt-inline\n\nSource: the user\n\nGiven that the ledger is slow, we cache it.\n\n```\nif [ -f x ]\nthen echo ok\nfi\n```\n\n## Proposal\n- Given a refund, when it is issued, then the ledger has a row\n- Given two refunds, when both are issued, then it has two\n\n## Acceptance criteria\n\n## Design\nNo UI.\n\n## Verification\nGiven a checkout, when tests run, then they pass.\n' > "$T/state/tickets/gwt-inline.md"
rec gwt-inline A "\"renders\":false,\"lint\":[$LINT_GWT]"
out=$(admit gwt-inline --session); rc=$?
G="$T/state/tickets/gwt-inline.md"
check "#1488 AC1 unlabelled criteria in a list are numbered under the empty criteria heading, once" '[ "$(grep -c "^## Acceptance criteria" "$G")" = 1 ] && grep -A2 -xF "## Acceptance criteria" "$G" | grep -qxF -- "- AC1: Given a refund, when it is issued, then the ledger has a row" && grep -A2 -xF "## Acceptance criteria" "$G" | grep -qxF -- "- AC2: Given two refunds, when both are issued, then it has two" && [ "$(grep -c "^- Given" "$G")" = 0 ]'
check "#1488 a Given line with no then, a shell block and the Verification section are left alone" 'grep -qxF "Given that the ledger is slow, we cache it." "$G" && grep -qxF "then echo ok" "$G" && grep -A1 -xF "## Verification" "$G" | grep -qxF "Given a checkout, when tests run, then they pass." && grep -q "^admitted gwt-inline by hand" <<< "$out"'
# A ticket lint passed, its criteria section filled, is never rewritten for Given/When/Then lines: not
# under that heading, nor in its prose.
printf '# gwt-filled\n\nSource: the user\n\nGiven a slow page, when it loads, then it shows a spinner.\n\n## Acceptance criteria\n- Given a refund, when it is issued, then the ledger has a row\n- The page loads in 2s\n\n## Design\nNo UI.\n' > "$T/state/tickets/gwt-filled.md"
G="$T/state/tickets/gwt-filled.md"; before=$(cat "$G")
rec gwt-filled A '"renders":false'
out=$(admit gwt-filled --session); rc=$?
check "#1488 filled criteria and a Given/When/Then line in the prose are left as written, and the ticket is admitted" '[ "$(cat "$G")" = "$before" ] && ! grep -qF "TICKET FILE EDIT gwt-filled" <<< "$out" && grep -q "^admitted gwt-filled by hand" <<< "$out"'
check "#1383 desk-admit says admit writes what it drafted itself, and how to write it at gh-issue-edit ask" 'grep -q "^\*\*Admit has already written what it could.\*\*" "$SK" && grep -q "triage drafted <n> from its goal and proposal" "$SK" && grep -q "its text states no testable outcome" "$SK"'
config yes '`none`'
AO="$S/../skills/desk-autopilot/references/ask-or-take.md"
check "#877 desk-autopilot admits tickets the person already chose without asking again" 'grep -q "^\*\*Tickets the person already chose are not asked again.\*\*" "$AO" && grep -q "intake.mjs admit <TICKET>... --session" "$AO"'
check "#1317 desk-admit folds in a lint refusal a routed comment settles, then admits it again, asking only for the rest" \
  'grep -q "^\*\*Then fold in what a comment already settles.\*\*" "$SK" && grep -q "desk-jira comments <TICKET>" "$SK" && grep -q "product-owner designer" "$SK" && grep -q "^read it back. With none left, run step 1 again for it. Only a finding no comment settles goes to the$" "$SK" && grep -q "the designer (the product owner$" "$SK" && grep -q "Fix what no comment settled (above)" "$SK"'
check "#877 desk-admit runs the --session command when this session runs the batch" 'grep -q "If this session runs that batch, run the command the line names" "$S/../skills/desk-admit/SKILL.md"'
rm -f "$DESK_QUEUE"; config ask '`none`'
out=$(admit H-7); rc=$?
check "admit: with no batch and autopilot-workers not yes, it points at /desk-autopilot" '[ $rc -eq 11 ] && [ ! -f "$DESK_QUEUE" ] && grep -q "run /desk-autopilot H-7" <<< "$out"'
config yes '`none`'
out=$(admit H-7)
check "admit: with no batch and autopilot-workers yes, it starts a standing batch handed to the supervisor" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget supervised)" = true ] && [ "$(qget tickets.H-7.state)" = triaged ]'
# #1331: where §3b Batches run by is session, no supervisor runs a standing batch. The session that runs
# the batch (--session) joins a finished one; any other admit admits nothing, says so, and puts starting
# a session on needs-you. A pass heartbeat is no sign a session still loops: the last pass of a
# finished batch writes one as it tells its session to stop.
RUN_BY=session config yes '`none`'
done_q(){ printf '{"version":1,"batch":"s9","supervised":false,"tickets":{"Z":{"key":"Z","state":"done","result":{"pr":null}}}}\n' > "$DESK_QUEUE"; }
beat(){ mkdir -p "$T/state/orchestrators"; printf '{"queue":"%s","batch":"s9","pid":1,"at":"%s","pass":"%s"}\n' "$DESK_QUEUE" "$1" "$1" > "$T/state/orchestrators/$(printf '%s' "$DESK_QUEUE" | tr -c 'A-Za-z0-9' '-').json"; }
done_q; rm -rf "$T/state/asks.json"; beat "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; rec H-31 A
out=$(admit H-31); rc=$?
check "#1331 session-run, batch finished, a fresh heartbeat but no --session: nothing admitted, and no standing batch started" '[ $rc -eq 11 ] && [ "$(qget batch)" = s9 ] && [ "$(qget tickets.H-31)" = undefined ]'
check "#1331 it says so plainly, never that a supervisor picks it up" 'grep -qF "not admitted H-31: no supervisor runs this repo'"'"'s batches (config §3b \"Batches run by\" is session) and batch s9 is finished, so no batch is started for it: if a session runs this repo'"'"'s batches, admit it from that session with --session; else start /desk-autopilot in a session" <<< "$out" && ! grep -q "supervisor.s next tick" <<< "$out"'
check "#1331 and puts it on needs-you" 'jq -e ".asks[] | select(.text | startswith(\"start /desk-autopilot H-31 in a session\"))" "$T/state/asks.json" >/dev/null && grep -q "^needs-you: recorded starting /desk-autopilot for H-31$" <<< "$out"'
check "#1359 the ask waits on H-31 being admitted" '[ "$(jq -c ".asks[] | select(.text | startswith(\"start /desk-autopilot H-31\")) | [.until, .settles]" "$T/state/asks.json")" = "[[\"H-31\"],\"admit\"]" ]'
out=$(admit H-31 --session); rc=$?
check "#1331 the session that runs the batch (--session) joins the finished one, not a standing one" '[ $rc -eq 0 ] && [ "$(qget batch)" = s9 ] && [ "$(qget supervised)" = false ] && [ "$(qget tickets.H-31.state)" = triaged ] && grep -q "^this session.s next pass picks up H-31$" <<< "$out" && ! grep -q "supervisor" <<< "$out"'
check "#1359 admitting it drops the ask to start a session for it, saying so" '! jq -e ".asks[] | select(.text | startswith(\"start /desk-autopilot H-31\"))" "$T/state/asks.json" >/dev/null && grep -q "^needs-you: ask [0-9]* dropped, as H-31 is admitted, so no session needs starting for it$" <<< "$out"'
# #1359: the beat names the Claude Code session whose pass wrote it; an admit refused in that session
# says to run it again with --session and puts nothing on needs-you.
done_q; rm -rf "$T/state/asks.json"; beat "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; f=$(ls "$T/state/orchestrators/"*.json); jq -c '. + {session: "sess-9"}' "$f" > "$f.t" && mv "$f.t" "$f"; rec H-34 A
out=$(CLAUDE_CODE_SESSION_ID=sess-9 admit H-34); rc=$?
check "#1359 refused in the session that runs the batch: it says to admit it again with --session, and records no ask" '[ $rc -eq 11 ] && [ "$(qget tickets.H-34)" = undefined ] && grep -q "^this session runs this repo.s batches: admit H-34 again with --session (node .*intake.mjs admit H-34 --session); nothing is put on needs-you$" <<< "$out" && [ "$(jq ".asks | length" "$T/state/asks.json" 2>/dev/null || echo 0)" = 0 ]'
out=$(CLAUDE_CODE_SESSION_ID=sess-other admit H-34)
check "#1359 refused in any other session, the ask is recorded" 'jq -e ".asks[] | select(.text | startswith(\"start /desk-autopilot H-34 in a session\"))" "$T/state/asks.json" >/dev/null'
rm -f "$DESK_QUEUE"; rm -rf "$T/state/orchestrators"; rec H-33 A
out=$(admit H-33 --session); rc=$?
check "#1331 session-run with no batch at all: nothing admitted, even with --session, and it names /desk-autopilot" '[ $rc -eq 11 ] && [ ! -f "$DESK_QUEUE" ] && grep -qF "not admitted H-33: no supervisor runs this repo'"'"'s batches (config §3b \"Batches run by\" is session) and no batch is set up, so no batch is started for it" <<< "$out"'
check "#1331 desk-admit says what to do with that line" 'grep -q "^| \`no supervisor runs this repo.s batches\` (config §3b Batches run by is \`session\`) | If this session runs the repo.s batches, run step 1 again with \`--session\`" "$SK"'
rm -f "$DESK_QUEUE"; config yes '`none`'

# ---- two batches: a ticket is in one batch at most ----------------------------------------------
NB="$DESK_HOME/repos/acme__widgets/batches/X-1"; mkdir -p "$NB"
printf '{"version":1,"batch":"X-1","tickets":{"X-2":{"key":"X-2","state":"running"}}}\n' > "$NB/queue.json"
config yes; running_batch; rm -f "$T/state/intake.json"
rec X-2 A; rec X-3 A '"epic":{"key":"X-1","summary":"a feature"}'; rec X-4 A '"epic":{"key":"X-1","summary":"a feature"}'
# #1359: an ask to start a session for a ticket another live batch already holds is dropped by the admit
# that finds it there.
printf '{"next":2,"asks":[{"id":1,"text":"start /desk-autopilot X-2 in a session","at":"2026-01-01T00:00:00Z","until":["X-2"],"settles":"admit"}]}\n' > "$T/state/asks.json"
out=$(admit X-2)
check "#1359 an admit finding the ticket in another live batch drops the ask to start a session for it" 'grep -q "X-2 is in batch X-1" <<< "$out" && [ "$(jq ".asks | length" "$T/state/asks.json")" = 0 ] && grep -q "^needs-you: ask 1 dropped, as X-2 is admitted" <<< "$out"'
rm -f "$T/state/asks.json"
n=$(count "$T/triage.calls")
search X-2; out=$(intake)
check "DS-307 AC2: a ticket in another batch is not triaged, admitted or handed on" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$(qget tickets.X-2)" = undefined ] && [ "$(handed X-2)" = none ]'
search X-3; out=$(intake)
check "DS-307 AC3: a new child of an epic with a live feature batch is not admitted" '[ "$(qget tickets.X-3)" = undefined ] && grep -q "^elsewhere: " <<< "$(handed X-3)"'
check "DS-307 AC3: the intake line names the feature batch" 'grep -q "intake: X-3 not admitted: X-3 is a child of epic X-1, whose feature batch X-1 is running" <<< "$out"'
check "DS-300 AC5: the intake line for a running epic's child points at /desk-admit" 'grep -q "intake: X-3 not admitted: .*: /desk-admit X-3 adds it to that batch$" <<< "$out"'
n=$(count "$T/triage.calls"); out=$(intake)
check "DS-307 AC3: it is not triaged again while that batch is live" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$out" = "intake: nothing new" ]'
before=$(cat "$DESK_QUEUE")
NQ="$NB/queue.json"; NS="$HOME/.desk-autopilot/acme__widgets/batches/X-1"
nget(){ jget "$NQ" "$1"; }
# Pinned, as a session that has loaded its paths is: the child's triage in X-1 must not inherit it.
out=$(DESK_DEFAULT_BRANCH=main admit X-4 --by ben); rc=$?
check "DS-300 AC4: /desk-admit adds a live epic's child to its feature batch" '[ $rc -eq 0 ] && [ "$(nget tickets.X-4.state)" = triaged ] && [ "$(nget tickets.X-4.admitted_by)" = ben ] && grep -q "^admitted X-4 by ben into feature batch X-1 (lane A, size S)$" <<< "$out"'
check "DS-300 AC4: the standing queue is unchanged" '[ "$(cat "$DESK_QUEUE")" = "$before" ] && [ -f "$NS/triage/X-4.json" ]'
check "DS-300 AC4: the child is triaged again in its feature batch, on that batch's base rather than a pinned default" 'grep -qx "X-4 X-1 unpinned" "$T/triage.batch"'
# X-5 is blocked by X-4, now in the feature batch, and shares a file with X-2, running there.
mkdir -p "$NS/triage"; printf '{"ticket":"X-2","files_in_scope":["src/shared.js"]}\n' > "$NS/triage/X-2.json"
rec X-5 A '"epic":{"key":"X-1","summary":"a feature"},"files_in_scope":["src/shared.js"],"blockers":[{"key":"X-4","category":"new"}]'
out=$(admit X-5); rc=$?
check "DS-300 AC4 DS-755 AC8: a child is held behind its blocker there, and not behind an in-flight child it shares a file with" '[ $rc -eq 0 ] && [ "$(nget tickets.X-5.state)" = parked ] && [ "$(nget tickets.X-5.held_by)" = "X-4" ] && [ "$(nget tickets.X-5.collides_with)" = "X-2" ] && grep -q "into feature batch X-1 (lane A, size S), held behind X-4$" <<< "$out" && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
# In feature mode, X-2 is the spine: a child sharing nothing with it still waits for it.
node -e 'const f=require("fs"),p=process.argv[1],q=JSON.parse(f.readFileSync(p,"utf8")); q.feature=true; q.spine="X-2"; f.writeFileSync(p,JSON.stringify(q))' "$NQ"
rec X-6 A '"epic":{"key":"X-1","summary":"a feature"}'
out=$(admit X-6); rc=$?
check "DS-300 AC4: in feature mode a child is held behind the unfinished spine, as plan-batch holds every child" '[ $rc -eq 0 ] && [ "$(nget tickets.X-6.held_by)" = X-2 ] && grep -q "into feature batch X-1 (lane A, size S), held behind X-2$" <<< "$out"'
# Y-1 is in no epic, but its blocker X-4 is in feature batch X-1: it joins X-1, not b1.
rec Y-1 A '"blockers":[{"key":"X-4","category":"indeterminate"}]'
out=$(admit Y-1); rc=$?
check "DS-391 AC3: a ticket whose blocker is in another live batch is placed in that batch, held behind it there" \
  '[ $rc -eq 0 ] && [ "$(qget tickets.Y-1)" = undefined ] && [ "$(nget tickets.Y-1.held_by)" = "X-2|X-4" ] && [ "$(nget tickets.Y-1.held_outside)" = undefined ] && grep -q "^admitted Y-1 by hand into feature batch X-1 (lane A, size S), held behind X-2, X-4$" <<< "$out"'
# Z-9 belongs to no batch but the one named: --into places it there, as the pass admits a held ticket's blocker.
rec Z-9 A
out=$(admit Z-9 --by pass --into X-1); rc=$?
check "DS-569: admit --into joins the named live batch, wherever the ticket's record would place it" \
  '[ $rc -eq 0 ] && [ "$(qget tickets.Z-9)" = undefined ] && [ "$(nget tickets.Z-9.admitted_by)" = pass ] && grep -q "^admitted Z-9 by pass into feature batch X-1 (lane A, size S)" <<< "$out"'
node -e 'const f=require("fs"),p=process.argv[1],q=JSON.parse(f.readFileSync(p,"utf8")); delete q.tickets["Z-9"]; f.writeFileSync(p,JSON.stringify(q))' "$NQ"
rec E-2 A '"type":"Epic"'
config ask; out=$(admit E-2); rc=$?; config yes
check "DS-352 AC1: with a feature batch live, another epic is planned as its own feature batch, not refused" '[ $rc -eq 0 ] && grep -q "^plan E-2 as a feature batch beside the standing batch" <<< "$out" && ! grep -q "^not admitted E-2" <<< "$out"'
rec X-1 A '"type":"Epic"'
out=$(admit X-1); rc=$?
check "DS-352 AC1: an epic whose own feature batch is live is refused naming it" '[ $rc -eq 11 ] && grep -q "^not admitted X-1: an epic, and its feature batch X-1 is already running" <<< "$out" && ! grep -q "^plan X-1" <<< "$out"'
n=$(count "$T/triage.calls"); out=$(admit X-2); rc=$?
check "DS-307 AC4: /desk-admit refuses a ticket in another batch before any triage" '[ $rc -eq 11 ] && grep -q "^not admitted X-2: X-2 is in batch X-1" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ] && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
check "DS-400 AC2: the refusal of a ticket in a batch it does not belong to names the needs-you move" 'grep -q "^not admitted X-2: X-2 is in batch X-1: a ticket is in one batch at most; if it belongs elsewhere, move it from /desk-needs-you once it is parked or stopped" <<< "$out"'
n=$(count "$T/triage.calls"); out=$(admit X-4); rc=$?
check "DS-400 AC1: a child already in its epic's feature batch is said to be there with its state, exit 0, not triaged" '[ $rc -eq 0 ] && grep -qx "X-4 is already in batch X-1 (triaged)" <<< "$out" && ! grep -q "not admitted" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ] && [ "$(nget tickets.X-4.state)" = triaged ]'
out=$(admit Y-1); rc=$?
check "DS-400 AC1: a ticket already in the batch its blocker routes it to is said to be there, exit 0" '[ $rc -eq 0 ] && grep -qx "Y-1 is already in batch X-1 (parked)" <<< "$out"'
out=$(admit X-6 --front); rc=$?
check "DS-510 AC2: --front moves a ticket already in a feature batch to the front of that batch, not the standing one" '[ $rc -eq 0 ] && grep -qx "X-6 is already in batch X-1 (parked)" <<< "$out" && grep -q "^X-6 moved to the front of the spawn order" <<< "$out" && [ "$(order "$NQ" | cut -d" " -f1)" = X-6 ] && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
check "DS-400 AC3: the desk-admit skill asks nothing for a ticket already where it belongs" 'grep -q "is already in batch <B> (<state>)\`, its epic.s feature" "$SK" && grep -q "batch included: ask nothing about it" "$SK"'
mkdir -p "$DESK_HOME/repos/acme__widgets/batches/.done"; mv "$NB" "$DESK_HOME/repos/acme__widgets/batches/.done/X-1"
out=$(intake)
check "DS-307: once the feature batch is archived, its child is taken as any other" '[ "$(qget tickets.X-3.state)" = triaged ]'
YB="$DESK_HOME/repos/acme__widgets/batches/Y-1"; mkdir -p "$YB"
printf '{"version":1,"batch":"Y-1","tickets":{"Y-0":{"key":"Y-0","state":"done"}}}\n' > "$YB/queue.json"
rec Y-2 A '"epic":{"key":"Y-1","summary":"a shipped feature"}'
search Y-2; out=$(intake)
check "DS-307: a feature batch finished in place, never archived, does not hold its epic's new child" '[ "$(qget tickets.Y-2.state)" = triaged ]'
ZB="$DESK_HOME/repos/acme__widgets/batches/Z-1"; mkdir -p "$ZB"; printf '{ not json' > "$ZB/queue.json"
rec Z-2 A; rec Z-3 A
search Z-2 Z-3; out=$(intake); rc=$?
check "DS-307: another batch's unreadable queue is reported per ticket, and the run carries on" '[ $rc -eq 0 ] && grep -q "intake: not admitted: Z-2 cannot be checked against batch Z-1" <<< "$out" && grep -q "Z-3 cannot be checked" <<< "$out" && [ "$(qget tickets.Z-2)" = undefined ]'
rm -rf "$ZB"; out=$(intake)
check "DS-307: once that queue is fixed, the ticket is taken" '[ "$(qget tickets.Z-2.state)" = triaged ]'
# A feature batch past its last promotion, which a pass recorded, waits only to be archived: it takes
# nothing more. Its epic's child and a ticket blocked by one of its tickets go to the standing batch.
WB="$DESK_HOME/repos/acme__widgets/batches/W-1"; mkdir -p "$WB"
wq(){ printf '{"version":1,"batch":"W-1","epic":"W-1","base":"feat/w-1","supervised":true,"promotion":%s,"tickets":{"W-0":{"key":"W-0","state":"triaged"}}}\n' "$1" > "$WB/queue.json"; }
wq '{"pr":7,"merged":[{"pr":7,"slice":1}]}'
rec W-2 A '"epic":{"key":"W-1","summary":"a promoted feature"}'
rec W-3 A '"blockers":[{"key":"W-0","category":"new"}]'
search W-2 W-3; out=$(intake)
check "DS-523 AC1: a child of an epic whose last promotion merged is admitted into the standing batch" '[ "$(qget tickets.W-2.state)" = triaged ] && ! grep -q "W-2" "$WB/queue.json"'
check "DS-523 AC1: the report says the epic's batch has finished" 'grep -q "intake: admitted W-2 by intake into batch b1 .*: epic W-1.s feature batch has finished (its last promotion PR #7 merged), so it joins the standing batch$" <<< "$out"'
check "DS-523 AC2: a ticket blocked by one in that batch is placed in the standing batch" '[ "$(qget tickets.W-3)" != undefined ] && ! grep -q "W-3" "$WB/queue.json"'
# AC4: while its promotion PR is open (the fake gh reads OPEN), the batch is live and keeps its children.
wq '{"pr":7}'
rec W-4 A '"epic":{"key":"W-1","summary":"a feature"}'
search W-4; out=$(intake)
check "DS-523 AC4: with the promotion PR open, the epic's child is not admitted into the standing batch" '[ "$(qget tickets.W-4)" = undefined ] && grep -q "intake: W-4 not admitted: W-4 is a child of epic W-1, whose feature batch W-1 is running" <<< "$out"'
rm -rf "$WB"

# ---- DS-351: an epic admitted with no session ------------------------------------------------------
# The checkout gets an origin to push the feature branch to. expand-parent and plan-batch are fakes in
# the batch's state: the children named in $T/children/<EPIC>, and a feature-mode plan that wants a
# spine and owner table until feature.json holds one. The drafter is a fake claude answering as told.
git init -q --bare "$T/origin.git"
git -C "$T/repo" init -q -b main
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin main

# ---- DS-816: a blocker merged into an epic or integration branch, then promoted to main ------------
# Each L-n PR merged into its own branch on 11-01. epic/L1 was squash-promoted on 11-05 and epic/L2
# rebase-promoted on 11-06; epic/L3 has no promotion; epic/L4 was promoted only before L-4 merged;
# epic/L5 was promoted by a merge commit, so L-5's merge commit is on origin/main.
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m 'L-5 merge'
git -C "$T/repo" push -q origin main
L5SHA=$(git -C "$T/repo" rev-parse HEAD)
lpr(){ printf '{"number":%s,"state":"MERGED","title":"fix: %s x","headRefName":"fix/%s-x","baseRefName":"%s","mergeCommit":{"oid":"%s"},"mergedAt":"2026-11-01T10:00:00Z"}' "$1" "$2" "$2" "$3" "$4"; }
printf '[%s,%s,%s,%s,%s]\n' "$(lpr 81 L-1 epic/L1 1111111111111111111111111111111111111111)" "$(lpr 82 L-2 epic/L2 2222222222222222222222222222222222222222)" \
  "$(lpr 83 L-3 epic/L3 3333333333333333333333333333333333333333)" "$(lpr 84 L-4 epic/L4 4444444444444444444444444444444444444444)" "$(lpr 85 L-5 epic/L5 "$L5SHA")" > "$T/prs.json"
printf '%s\n' '[{"number":91,"headRefName":"epic/L1","baseRefName":"main","mergedAt":"2026-11-05T09:00:00Z"},{"number":92,"headRefName":"epic/L2","baseRefName":"main","mergedAt":"2026-11-06T09:00:00Z"},{"number":93,"headRefName":"epic/L3","baseRefName":"integration/x","mergedAt":"2026-11-05T09:00:00Z"},{"number":94,"headRefName":"epic/L4","baseRefName":"main","mergedAt":"2026-10-30T09:00:00Z"}]' > "$T/promos.json"
# The module path goes last: intake.mjs runs its CLI when argv[1] is itself.
landed(){ (cd "$T/repo" && node -e 'import(process.argv[2]).then((m) => console.log(String(m.landedOn(process.argv[1], "main"))))' "$1" "$T/bin/intake.mjs"); }
outside(){ (cd "$T/repo" && node -e 'const a = process.argv.slice(1); import(a.pop()).then((m) => console.log(m.holdsFor({ blockers: a.map((key) => ({ key, category: "done" })) }, {}, "main").outside.join()))' "$@" "$T/bin/intake.mjs"); }
check "DS-816 AC1: a blocker merged into an epic branch later squash-merged to main has landed" '[ "$(landed L-1)" = true ]'
check "DS-816 AC2: one whose epic branch was rebase-merged to main has landed" '[ "$(landed L-2)" = true ]'
check "DS-816 AC3: one whose epic branch has no merged PR into main has not" '[ "$(landed L-3)" = false ]'
check "DS-816 AC3: nor one whose epic branch merged into main only before it" '[ "$(landed L-4)" = false ]'
check "DS-816 a merge-commit promotion still lands it through the merge commit" '[ "$(landed L-5)" = true ]'
touch "$T/promos.fails"
check "DS-816 a promotion list GitHub cannot read is unread, not false" '[ "$(landed L-1)" = null ] && [ "$(landed L-5)" = true ]'
rm -f "$T/promos.fails"
check "DS-816 AC4: admit holds a blocker outside only while it is unpromoted" '[ "$(outside L-1 L-2 L-3 L-4 L-5)" = "L-3,L-4" ]'
# #1312: a blocker in the batch Done in Jira (its first merge moved it there) that went round again since
# is held while it has not merged its current work; one merged and not gone round again is not.
heldDone(){ (cd "$T/repo" && node -e 'import(process.argv[2]).then((m) => console.log(m.holdsFor({ blockers: [{ key: "B-1", category: "done" }] }, JSON.parse(process.argv[1]), "main").held.join()))' "$1" "$T/bin/intake.mjs"); }
reworkedB=$(heldDone '{"B-1":{"key":"B-1","state":"triaged","merged_at":"2026-11-02T00:00:00Z"}}')
mergedB=$(heldDone '{"B-1":{"key":"B-1","state":"done","merged_at":"2026-11-02T00:00:00Z","result":{"pr":5},"pr_status":{"pr":5,"state":"MERGED"}}}')
check "#1312 admit holds a Jira-Done blocker in the batch that went round again since its merge" '[ "$reworkedB" = B-1 ]'
check "#1312 and not one merged and not gone round again, as before" '[ -z "$mergedB" ]'
# DS-811: where an unlanded blocker's code waits: the branch its PR merged into, and that branch's open
# promotion PR into main, by state.
unpromoted(){ (cd "$T/repo" && node -e 'import(process.argv[2]).then((m) => console.log(JSON.stringify(m.unpromotedBase(process.argv[1], "main"))))' "$1" "$T/bin/intake.mjs"); }
check "DS-811 a blocker merged into a branch with no promotion PR names the branch and none" '[ "$(unpromoted L-3)" = "{\"branch\":\"epic/L3\",\"pr\":null,\"state\":\"none\"}" ]'
printf '%s\n' '[{"number":96,"headRefName":"epic/L3","baseRefName":"main","isDraft":false,"statusCheckRollup":[{"name":"lint","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"test","status":"COMPLETED","conclusion":"FAILURE"}]}]' > "$T/promos.json"
check "DS-811 a promotion PR with a failed check is red" '[ "$(unpromoted L-3)" = "{\"branch\":\"epic/L3\",\"pr\":96,\"state\":\"red\"}" ]'
printf '%s\n' '[{"number":96,"headRefName":"epic/L3","baseRefName":"main","isDraft":false,"statusCheckRollup":[{"name":"test","workflowName":"ci","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-11-18T10:00:00Z","detailsUrl":"https://github.com/a/b/actions/runs/1/job/1"},{"name":"test","workflowName":"ci","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-11-18T11:00:00Z","detailsUrl":"https://github.com/a/b/actions/runs/2/job/2"}]}]' > "$T/promos.json"
check "DS-811 a check that failed and then passed on a later run is not red" '[ "$(unpromoted L-3)" = "{\"branch\":\"epic/L3\",\"pr\":96,\"state\":\"open\"}" ]'
printf '%s\n' '[{"number":97,"headRefName":"epic/L3","baseRefName":"main","isDraft":true,"statusCheckRollup":[]}]' > "$T/promos.json"
check "DS-811 a draft one is draft" '[ "$(unpromoted L-3)" = "{\"branch\":\"epic/L3\",\"pr\":97,\"state\":\"draft\"}" ]'
printf '%s\n' '[{"number":98,"headRefName":"epic/L3","baseRefName":"main","isDraft":false,"statusCheckRollup":[{"context":"deploy","state":"SUCCESS"}]}]' > "$T/promos.json"
check "DS-811 a green one is open" '[ "$(unpromoted L-3)" = "{\"branch\":\"epic/L3\",\"pr\":98,\"state\":\"open\"}" ]'
touch "$T/promos.fails"
check "DS-811 a promotion PR GitHub cannot read is null" '[ "$(unpromoted L-3)" = null ]'
rm -f "$T/promos.fails"
# DS-947: a promotion PR from the branch into main that merged after the blocker did, and one that
# merged only before it, which still promotes nothing of it.
printf '%s\n' '[{"number":871,"state":"merged","headRefName":"epic/L3","baseRefName":"main","mergedAt":"2026-11-02T09:00:00Z"}]' > "$T/promos.json"
check "DS-947 AC1 a promotion PR merged after it reads as merged, its code on main" '[ "$(unpromoted L-3)" = "{\"branch\":\"epic/L3\",\"pr\":871,\"state\":\"merged\"}" ]'
# The next slice's promotion PR, opened from the same branch into main once 871 merged, hides nothing.
printf '%s\n' '[{"number":871,"state":"merged","headRefName":"epic/L3","baseRefName":"main","mergedAt":"2026-11-02T09:00:00Z"},{"number":872,"state":"open","headRefName":"epic/L3","baseRefName":"main","isDraft":true,"statusCheckRollup":[]}]' > "$T/promos.json"
check "DS-947 AC1 an open next-slice promotion PR does not hide the merged one" '[ "$(unpromoted L-3)" = "{\"branch\":\"epic/L3\",\"pr\":871,\"state\":\"merged\"}" ]'
printf '%s\n' '[{"number":870,"state":"merged","headRefName":"epic/L3","baseRefName":"main","mergedAt":"2026-10-30T09:00:00Z"}]' > "$T/promos.json"
check "DS-947 AC3 one merged only before it is still no promotion PR" '[ "$(unpromoted L-3)" = "{\"branch\":\"epic/L3\",\"pr\":null,\"state\":\"none\"}" ]'
# DS-947 AC2: read against a batch base, a squash promotion into main lands it once the base holds its
# commit, and not before.
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m 'epic/L3 squashed'
git -C "$T/repo" push -q origin main
SQSHA=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" push -q origin "$L5SHA:refs/heads/feat/b"
printf '[{"number":871,"state":"merged","headRefName":"epic/L3","baseRefName":"main","mergedAt":"2026-11-02T09:00:00Z","mergeCommit":{"oid":"%s"}}]\n' "$SQSHA" > "$T/promos.json"
landedvia(){ (cd "$T/repo" && git fetch -q origin && node -e 'import(process.argv[2]).then((m) => console.log(String(m.landedOn(process.argv[1], "feat/b", "main"))))' "$1" "$T/bin/intake.mjs"); }
check "DS-947 AC2 before the base syncs main the blocker has not landed on it" '[ "$(landedvia L-3)" = false ]'
git -C "$T/repo" push -q origin "$SQSHA:refs/heads/feat/b"
check "DS-947 AC2 once the base holds the promotion it has" '[ "$(landedvia L-3)" = true ]'
git -C "$T/repo" push -q origin --delete feat/b
printf '%s\n' '[{"number":5,"state":"MERGED","title":"fix: M-1 x","headRefName":"fix/M-1-x","baseRefName":"main","mergedAt":"2026-11-01T10:00:00Z"}]' > "$T/prs.json"
check "DS-811 one merged only into main is not elsewhere" '[ "$(unpromoted M-1)" = null ]'
rm -f "$T/prs.json" "$T/promos.json"
mkdir -p "$T/children"
rm -f "$T/bin/expand-parent.mjs" "$T/bin/plan-batch.mjs"
cat > "$T/bin/expand-parent.mjs" <<EOF
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const key = process.argv[2], s = process.env.DESK_AUTOPILOT_STATE;
mkdirSync(s, { recursive: true });
writeFileSync(s + '/expansion.json', JSON.stringify({ parent: key, containers: {}, criteria: [{ id: 'AC1', text: 'it works' }] }));
process.stdout.write(readFileSync('$T/children/' + key, 'utf8'));
EOF
# As plan-batch does, it asks on the epic when feature.json's AC1 owner is not a ticket it was given, and
# with AUTOPILOT_WRITE_QUEUE it seeds the named tickets, each held behind the spine where feature.json
# names one.
cat > "$T/bin/plan-batch.mjs" <<EOF
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const s = process.env.DESK_AUTOPILOT_STATE, epic = process.env.DESK_BATCH, seed = Boolean(process.env.AUTOPILOT_WRITE_QUEUE);
const keys = process.argv.slice(2).filter((a) => a !== '--json');
appendFileSync('$T/plan.calls', epic + ' ' + process.argv.slice(2).join(' ') + (seed ? ' (seed)' : '') + '\n');
const plan = existsSync(s + '/feature.json') ? JSON.parse(readFileSync(s + '/feature.json', 'utf8')) : null;
const owner = plan?.owners?.AC1;
const qs = owner && !keys.includes(owner) ? ["AC1's owner " + owner + ' is not a child this batch builds: name another owner'] : [];
const message = ['FEATURE MODE — on', plan ? '  AC1 owner ' + plan.owners.AC1 : '  no feature plan yet'];
// A key with a $T/refused.<key> file runs in another repo that refuses it: seeding takes it out of this
// queue and asks the person, as plan-batch's hand-over does.
const refused = keys.filter((k) => existsSync('$T/refused.' + k));
const needs = [...(plan?.spine && keys.includes(plan.spine) ? [] : [{ ticket: epic, why: 'feature_plan', detail: 'the plan' }]), ...qs.map((q) => ({ ticket: epic, why: 'question', detail: q })),
  ...(seed ? refused.map((k) => ({ ticket: k, why: 'question', detail: k + ' was not admitted in acme/web (the queue is locked): admit it there with node intake.mjs admit ' + k })) : [])];
if (seed) {
  const q = (...a) => execFileSync(process.execPath, ['$T/bin/queue.mjs', ...a], { stdio: 'ignore' });
  for (const k of refused) q('drop', k);
  const here = keys.filter((x) => !refused.includes(x));
  for (const k of here) { q('add', k, 'Story', 'A'); q('set', k, 'state=triaged', 'held_by=null'); }
  for (const k of here) if (plan?.spine && k !== plan.spine) q('hold', k, plan.spine);
}
console.log(JSON.stringify({ status: needs.length ? 'show_person' : 'go_on', code: needs.length ? 11 : 0, message, needs_person: needs }));
process.exitCode = needs.length ? 11 : 0;
EOF
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: one strict expected-fail spec for AC1\", \"owners\": {\"AC1\": \"E-6\"}}"}
EOF
printf '#!/bin/sh\nprintf "%%s\\n" "$1 $2" | head -1 >> "%s/claude.calls"\nsh "%s/gate.sh" "%s/gates/claude"\n[ -f "%s/claude.fails" ] && { echo "claude: session limit" >&2; exit 1; }\ncat "%s/claude.out"\n' "$T" "$T" "$T" "$T" "$T" > "$T/fakes/claude"
chmod +x "$T/fakes/claude"
EB="$DESK_HOME/repos/acme__widgets/batches"; ES="$HOME/.desk-autopilot/acme__widgets/batches"
eget(){ jget "$EB/$1/queue.json" "$2"; }
rec E-6 A '"summary":"the first child"'; rec E-7 A '"summary":"the second child"'
printf 'E-6\nE-7\n' > "$T/children/E-5"; printf 'E-6\n' > "$T/children/E-8"
rec E-5 A '"type":"Epic","branch":"feat/E-5-a-feature"'; rec E-8 A '"type":"Epic","branch":"feat/E-8-another"'

# ---- DS-412: a feature base no §4 Required check's workflow runs on is refused at admission --------
# ci.yml runs "tests" on pull requests into the branches given; a ref with no file has none to read.
ci(){ mkdir -p "$T/wf"; printf 'name: CI\non:\n  pull_request:\n    branches: [%s]\njobs:\n  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n' "$2" > "$T/wf/$1.yml"; }
printf '\n## 4. Toolchain\n| Field | Value |\n|---|---|\n| Required checks | `tests` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
rec E-12 A '"type":"Epic","branch":"feat/E-12-untriggered"'; rec E-13 A '"branch":"fix/E-13-a-child"'; printf 'E-13\n' > "$T/children/E-12"
ci main 'main, production'; ci feat%2FE-12-untriggered 'main, production'
out=$(admit E-12 --by ben); rc=$?
check "DS-412 AC1: an epic whose base no copy of the required check's workflow runs on is refused, naming the check and its workflow file" \
  '[ $rc -eq 11 ] && grep -q "^not admitted E-12: an epic, and its feature batch was not started: no batch started for E-12: a required check does not run on PRs into feat/E-12-untriggered, so no child PR could go green: \"tests\" never runs on PRs into feat/E-12-untriggered (workflow trigger: .github/workflows/ci.yml runs on pull requests only into main, production)\. Add feat/E-12-untriggered (or a pattern such as feat/\*\*) to the pull_request branches of that workflow, then admit the epic again$" <<< "$out"'
check "DS-412 AC1: before any worker starts: batch.mjs start makes no batch and nothing is drafted" '[ ! -e "$EB/E-12" ] && [ ! -e "$ES/E-12" ] && [ "$(count "$T/claude.calls")" = 0 ]'
# The base's copy lacks the trigger, the default branch's has it: the base sync starts it, so it is admitted
# (E-5, below, under these workflows).
ci main "main, 'feat/**'"; ci feat%2FE-5-a-feature 'main'

# A plan the drafter cannot write leaves no batch behind.
touch "$T/claude.fails"; before=$(cat "$DESK_QUEUE")
out=$(admit E-8 --by ben); rc=$?
check "DS-351: an epic whose plan cannot be drafted is refused with why, and its batch discarded" '[ $rc -eq 11 ] && grep -q "^not admitted E-8: an epic, and its feature batch was not started: the plan drafter failed (claude: session limit); batch E-8 discarded$" <<< "$out" && [ ! -e "$EB/E-8" ] && [ "$(ls "$ES/E-8")" = triage ] && [ -f "$ES/E-8/triage/E-6.json" ]'
rm -f "$T/claude.fails"

out=$(admit E-5 --by ben); rc=$?
check "DS-351 AC1: /desk-admit accepts an epic, not refused" '[ $rc -eq 0 ] && ! grep -q "not admitted" <<< "$out" && grep -q "^started feature batch E-5 on feat/E-5-a-feature, beside the standing batch$" <<< "$out"'
check "DS-351 AC1: its feature batch is created on the epic's branch, pushed to origin" '[ "$(eget E-5 epic)" = E-5 ] && [ "$(eget E-5 base)" = feat/E-5-a-feature ] && [ -n "$(git -C "$T/repo" ls-remote --heads origin feat/E-5-a-feature)" ]'
check "DS-351 AC1: the batch is handed to the supervisor, and the standing queue is untouched" '[ "$(eget E-5 supervised)" = true ] && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
check "DS-351 AC2: the spine and owner table are drafted headless into the batch" '[ "$(count "$T/claude.calls")" = 2 ] && grep -q -- "-p You are drafting the feature plan for epic E-5" "$T/claude.calls" && [ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).owners.AC1)" "$ES/E-5/feature.json")" = E-6 ]'
check "DS-351 AC2: the drafter is given the epic's criteria and its children" 'grep -q "^- AC1: it works$" "$ES/E-5/plan-draft.prompt.md" && grep -q "^- E-7: the second child" "$ES/E-5/plan-draft.prompt.md"'
check "DS-351 AC2: the plan is written for the person, as plan-batch gives it with the draft" 'grep -q "AC1 owner E-6" "$ES/E-5/plan.md"'
check "DS-351 AC2: the epic waits in its batch on one feature-plan park naming the plan" '[ "$(eget E-5 tickets.E-5.state)" = parked ] && [ "$(eget E-5 tickets.E-5.lane)" = epic ] && grep -q "^feature plan awaiting your answer: the spine and owner table for E-5 are drafted, with 2 children held behind it: read $ES/E-5/plan.md" <<< "$(eget E-5 tickets.E-5.park.question)"'
check "DS-351 AC2: its children are triaged in the batch and wait held behind the epic" '[ "$(eget E-5 tickets.E-6.held_by)" = E-5 ] && [ "$(eget E-5 tickets.E-7.held_by)" = E-5 ] && [ "$(eget E-5 tickets.E-7.admitted_by)" = ben ] && [ -f "$ES/E-5/triage/E-7.json" ]'
check "DS-351 AC2: the line says the plan waits in /desk-needs-you" 'grep -q "its plan waits for you in /desk-needs-you" <<< "$out" && grep -q "^admitted: feature batch E-5 started, 2 children held behind its plan, by ben$" <<< "$(handed E-5)"'
out=$(cd "$T/repo" && env -u DESK_QUEUE -u DESK_AUTOPILOT_STATE node "$T/bin/queue.mjs" requeue E-5 --batch E-5 2>&1); rc=$?
check "DS-351: no queue.mjs requeue sends the epic to a worker" '[ $rc -ne 0 ] && grep -q "E-5 is lane epic" <<< "$out" && [ "$(eget E-5 tickets.E-5.state)" = parked ]'
item=$(node -e 'console.log(JSON.stringify({ id: "p", ticket: "E-5", kind: "parked", lane: "epic", text: process.argv[1] }))' "$(eget E-5 tickets.E-5.park.question)")
check "DS-351: the decider hands the plan straight on, with no session" '[ "$(cd "$T/repo" && node --input-type=module -e "import { presort } from \"$B/decider.mjs\"; const r = presort([JSON.parse(process.argv[1])]); console.log(r.hand.length, r.ask.length)" "$item")" = "1 0" ]'
rec E-10 A '"epic":{"key":"E-5","summary":"a feature"}'
out=$(admit E-10 --by ben); rc=$?
check "DS-351 AC2: a child admitted later into the waiting batch is held behind the epic too" '[ $rc -eq 0 ] && [ "$(eget E-5 tickets.E-10.state)" = parked ] && [ "$(eget E-5 tickets.E-10.held_by)" = E-5 ]'
# Triaged three at a time, the child's triage done long before its epic's: it still waits for the epic.
rec EP-1 A '"type":"Epic","branch":"feat/EP-1-pool"'; rec EP-3 A '"summary":"a listed child"'; printf 'EP-3\n' > "$T/children/EP-1"
rec EP-2 A '"epic":{"key":"EP-1","summary":"a feature"}'; gate EP-1 admit.out '^triage: done EP-2 '
out=$(TRIAGE_K=3 config yes '`none`'; DESK_MEM_AVAIL_GB=64 admit EP-2 EP-1 --by ben); rc=$?
check "DS-506 AC7: an epic and its child in one call: the child joins the epic's feature batch, not the standing one" \
  '[ $rc -eq 0 ] && [ "$(eget EP-1 tickets.EP-2.admitted_by)" = ben ] && [ "$(qget tickets.EP-2)" = undefined ] && grep -q "^admitted EP-2 by ben into feature batch EP-1 " <<< "$out"'
ungate
# A child the epic's own start takes into its feature batch: listed by expand-parent, and named in the call too.
listed(){ rec "$1" A "\"type\":\"Epic\",\"branch\":\"feat/$1-listed\""; rec "$2" A "\"epic\":{\"key\":\"$1\",\"summary\":\"a feature\"}"; printf '%s\n' "$2" > "$T/children/$1"; rm -f "$T/triage.calls"; }
listed ER-1 ER-2; out=$(TRIAGE_K=1 config yes '`none`'; admit ER-1 ER-2 --by ben); rc=$?
check "DS-506 AC7: an epic named before its listed child: the child is already in its batch, exit 0, and not triaged a second time" \
  '[ $rc -eq 0 ] && grep -qx "ER-2 is already in batch ER-1 (parked)" <<< "$out" && ! grep -q "not admitted" <<< "$out" && [ "$(tr "\n" " " < "$T/triage.calls")" = "ER-1 ER-2 " ]'
listed ES-1 ES-2; out=$(TRIAGE_K=1 config yes '`none`'; admit ES-2 ES-1 --by ben); rc=$?
check "DS-506 AC7: a listed child named before its epic is said to be there too, exit 0" \
  '[ $rc -eq 0 ] && grep -qx "ES-2 is already in batch ES-1 (parked)" <<< "$out" && ! grep -q "not admitted" <<< "$out" && [ "$(eget ES-1 tickets.ES-2.admitted_by)" = ben ]'
listed ET-1 ET-2; out=$(TRIAGE_K=3 config yes '`none`'; DESK_MEM_AVAIL_GB=64 admit ET-1 ET-2 --by ben); rc=$?
check "DS-506 AC7: a listed child in triage while its epic starts is said to be there too, exit 0" \
  '[ $rc -eq 0 ] && grep -qx "ET-2 is already in batch ET-1 (parked)" <<< "$out" && ! grep -q "not admitted" <<< "$out"'
# A child's second triage, in its epic's feature batch, stops at the usage limit: no triage starts after it.
rec EP-4 A '"epic":{"key":"EP-1","summary":"a feature"}'; rec EP-5 A; rec EP-6 A; cp "$T/recs/U-1.limit" "$T/recs/EP-4.batchlimit"
rm -f "$T/triage.calls"; out=$(TRIAGE_K=1 config yes '`none`'; admit EP-4 EP-5 EP-6 --by ben); rc=$?
check "DS-506 AC4: a usage limit in a feature batch's triage starts no more triages" \
  '[ $rc -eq 11 ] && [ "$(tr "\n" " " < "$T/triage.calls")" = "EP-4 EP-4 " ] && grep -q "^not admitted EP-4: .*weekly usage limit.* in feature batch EP-1: run /desk-admit EP-4 again once the limit lifts$" <<< "$out" && grep -qx "not triaged (usage limit, resets 2027-01-15 08:00 UTC): EP-5 EP-6: run /desk-admit EP-5 EP-6 again once the limit lifts" <<< "$out"'
# After a usage limit, a child in flight is not triaged again to join its epic's feature batch: EP-7's
# triage ends only once EP-8's limit has been said.
rec EP-7 A '"epic":{"key":"EP-1","summary":"a feature"}'; gate EP-7 admit.out '^not admitted EP-8'; rec EP-8 A; cp "$T/recs/U-1.limit" "$T/recs/EP-8.limit"
rm -f "$T/triage.calls"; out=$(TRIAGE_K=2 config yes '`none`'; DESK_MEM_AVAIL_GB=64 admit EP-7 EP-8 --by ben); rc=$?
check "DS-506 AC4: after a usage limit, a child is not triaged again to join its epic's feature batch, and is named to admit again" \
  '[ $rc -eq 11 ] && [ "$(count "$T/triage.calls")" = 2 ] && [ "$(eget EP-1 tickets.EP-7)" = undefined ] && grep -qx "not triaged (usage limit, resets 2027-01-15 08:00 UTC): EP-7: run /desk-admit EP-7 again once the limit lifts" <<< "$out"'
# An epic's child, triaged in its new feature batch, stops at the usage limit: no triage starts after it.
rec EQ-1 A '"type":"Epic","branch":"feat/EQ-1-limited"'; rec EQ-2 A; printf 'EQ-2\n' > "$T/children/EQ-1"; cp "$T/recs/U-1.limit" "$T/recs/EQ-2.batchlimit"
rec EQ-3 A; rec EQ-4 A
rm -f "$T/triage.calls"; out=$(TRIAGE_K=1 config yes '`none`'; admit EQ-1 EQ-3 EQ-4 --by ben); rc=$?
check "DS-506 AC4: a usage limit in an epic's child triage starts no more triages, and the epic is named to admit again" \
  '[ $rc -eq 11 ] && [ "$(tr "\n" " " < "$T/triage.calls")" = "EQ-1 EQ-2 " ] && [ ! -e "$EB/EQ-1" ] && grep -q "^not admitted EQ-1: an epic, and its feature batch was not started: child EQ-2 could not be triaged (.*weekly usage limit.*); batch EQ-1 discarded: run /desk-admit EQ-1 again once the limit lifts$" <<< "$out" && grep -qx "not triaged (usage limit, resets 2027-01-15 08:00 UTC): EQ-3 EQ-4: run /desk-admit EQ-3 EQ-4 again once the limit lifts" <<< "$out"'
# Past a usage limit, a ticket another batch holds is still said to be there, not named to triage again.
rec EQ-5 A; rec EQ-6 A; cp "$T/recs/U-1.limit" "$T/recs/EQ-5.limit"
out=$(TRIAGE_K=1 config yes '`none`'; admit EQ-5 EP-3 EQ-6 --by ben); rc=$?
check "DS-506 AC4: after a usage limit, a ticket in another batch is told as ever, and only the rest are named" \
  '[ $rc -eq 11 ] && grep -q "^not admitted EP-3: EP-3 is in batch EP-1" <<< "$out" && grep -qx "not triaged (usage limit, resets 2027-01-15 08:00 UTC): EQ-6: run /desk-admit EQ-6 again once the limit lifts" <<< "$out"'
config yes '`none`'; ungate
config yes; rec E-9 A '"type":"Epic","branch":"feat/E-9-third"'; rec E-19 A '"summary":"the third epic child"'; printf 'E-19\n' > "$T/children/E-9"
echo '{"issues":[{"key":"E-9","fields":{"issuetype":{"name":"Epic","hierarchyLevel":1}}}]}' > "$T/search.json"; out=$(intake)
check "DS-352: standing intake starts another epic's feature batch beside a live one" '[ "$(eget E-9 base)" = feat/E-9-third ] && [ "$(eget E-5 base)" = feat/E-5-a-feature ] && grep -q "^intake: started feature batch E-9 on feat/E-9-third, beside the standing batch$" <<< "$out" && ! grep -q "E-9 not admitted" <<< "$out"'

# A start cut off before the hand-over (the supervisor's intake timeout) leaves its mark, by a pid
# that has exited: the next intake discards that batch and hands its epic on, rather than reading it
# as live forever.
mkdir -p "$EB/O-1" "$ES/O-1"; dead=$(sh -c 'echo $$')
printf '{"version":1,"batch":"O-1","epic":"O-1","base":"feat/O-1-cut","tickets":{}}\n' > "$EB/O-1/queue.json"
printf '{"pid":%s}\n' "$dead" > "$ES/O-1/epic-start.json"
out=$(intake)
check "DS-351: a feature batch whose start was cut off is discarded, and its epic handed on" '[ ! -e "$EB/O-1" ] && [ ! -e "$ES/O-1" ] && grep -q "^handed: an epic, and feature batch O-1.s start was cut off (pid $dead) before it was handed to the supervisor: discarded$" <<< "$(handed O-1)"'
check "DS-351: a finished start leaves no mark behind" '[ ! -e "$ES/E-5/epic-start.json" ]'

# ---- DS-354: the person's answer to the plan, acted on by the supervisor -------------------------
# Answered with the real answer.mjs, as /desk-needs-you records it; each tick runs every batch, with
# intake off. The editor is the fake claude, answering what $T/claude.out holds.
config yes '`none`'
answer(){ (cd "$T/repo" && env -u DESK_QUEUE -u DESK_AUTOPILOT_STATE node "$T/bin/answer.mjs" "$@" >/dev/null 2>&1); }
btick(){ (cd "$T/repo" && env -u DESK_QUEUE -u DESK_AUTOPILOT_STATE node "$T/bin/supervisor.mjs" tick --foreground 2>&1); }
pq(){ eget "$1" "tickets.$1.park.question"; }
editor(){ printf '{"type":"result","total_cost_usd":0.05,"result":"Done.\\nPLAN_EDIT: %s"}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')" > "$T/claude.out"; }
SL="$HOME/.desk-autopilot/acme__widgets/supervisor.log"

editor '{"cannot": "AC9 is not one of the criteria"}'
answer E-5 "make E-7 own AC9"; out=$(btick)
check "DS-354 AC3: an edit the editor cannot apply asks again in needs-you, naming what it could not apply" '[ "$(eget E-5 tickets.E-5.state)" = parked ] && [ "$(pq E-5)" = "feature plan awaiting your answer: the plan for E-5 was not started, because your edit could not be applied: AC9 is not one of the criteria: read $ES/E-5/plan.md, then start, edit or discard it" ]'
check "DS-354 AC3: nothing is started, and the children stay held behind the epic" '[ "$(eget E-5 tickets.E-6.held_by)" = E-5 ] && ! grep -q "(seed)" "$T/plan.calls" && ! grep -q "^create" "$T/jira.calls"'
check "DS-354 AC2: the editor is given the plan and the edit, verbatim" 'grep -q -- "-p You are applying the person.s edit to the plan for epic E-5" "$T/claude.calls" && grep -q "^make E-7 own AC9$" "$ES/E-5/plan-edit.prompt.md" && grep -q "AC1 owner E-6" "$ES/E-5/plan-edit.prompt.md" && grep -q "\"AC1\": \"E-6\"" "$ES/E-5/plan-edit.prompt.md"'
n=$(count "$T/claude.calls"); out=$(btick)
check "DS-354: an answer already acted on is not acted on again" '[ "$(count "$T/claude.calls")" = "$n" ] && grep -q "your edit could not be applied: AC9" <<< "$(pq E-5)"'

# An edit the editor applies, but that leaves the owner table with a question, is not applied either.
editor '{"plan": {"draft": "Spine: AC1", "owners": {"AC1": "E-12"}}, "drop": []}'
answer E-5 "make E-12 own AC1"; out=$(btick)
check "DS-354 AC3: an edit that leaves the owner table unsettled asks again, naming plan-batch's question" 'grep -q "because your edit could not be applied cleanly: AC1.s owner E-12 is not a child this batch builds: name another owner: read " <<< "$(pq E-5)" && ! grep -q "(seed)" "$T/plan.calls"'
check "DS-354 AC3: the plan is left as it was" '[ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).owners.AC1)" "$ES/E-5/feature.json")" = E-6 ]'

# A start on an owner table plan-batch questions asks again before its spine is filed; and while another
# live run holds the batch's supervisor.lock, the answer waits for it.
owner(){ node -e 'const fs=require("fs"),f=process.argv[1],p=JSON.parse(fs.readFileSync(f,"utf8")); p.owners.AC1=process.argv[2]; fs.writeFileSync(f, JSON.stringify(p))' "$ES/E-5/feature.json" "$1"; }
owner E-12; printf '{"pid":%s}\n' "$$" > "$ES/E-5/supervisor.lock"
q0=$(pq E-5); answer E-5 start; out=$(btick)
check "DS-354: an answer is not acted on while another run holds the batch's lock" '[ "$(pq E-5)" = "$q0" ]'
rm -f "$ES/E-5/supervisor.lock"; out=$(btick)
check "DS-354: a start the owner table cannot take asks again, and files no spine" 'grep -q "because plan-batch has questions on its owner table: AC1.s owner E-12 is not a child this batch builds" <<< "$(pq E-5)" && ! grep -q "^create" "$T/jira.calls" && [ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).spine)" "$ES/E-5/feature.json")" = null ]'
owner E-6
q0=$(pq E-5); answer E-5 "not now"; out=$(btick)
check "DS-354: a not-now answer leaves the plan waiting" '[ "$(pq E-5)" = "$q0" ] && [ -e "$EB/E-5" ]'

# AC4: discarded on the answer, and the children released.
answer E-5 discard; out=$(btick)
check "DS-354 AC4: a rejected plan discards the feature batch and its branch" '[ ! -e "$EB/E-5" ] && [ ! -e "$ES/E-5" ] && [ -z "$(git -C "$T/repo" ls-remote --heads origin feat/E-5-a-feature)" ]'
check "DS-354 AC4: the standing log says the children are released" 'grep -q "^discarded on your answer to its plan; E-6, E-7, E-10 are released: no batch holds them" "$SL"'
out=$(admit E-10 --by ben); rc=$?
check "DS-354 AC4: a released child can be admitted again" '[ $rc -eq 0 ] && [ "$(qget tickets.E-10.state)" = triaged ]'

# AC2: an edit applied as it stands, and the batch starts with no second needs-you round.
rec E-11 A '"summary":"the spine"'; rec E-13 A '"summary":"the third child"'; rec E-14 A '"summary":"the fourth child"'
printf 'E-13\nE-14\n' > "$T/children/E-12"; rec E-12 A '"type":"Epic","branch":"feat/E-12-edited"'
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: one strict expected-fail spec for AC1\", \"owners\": {\"AC1\": \"E-13\"}}"}
EOF
out=$(admit E-12 --by ben)
editor '{"plan": {"draft": "Spine: one strict expected-fail spec for AC1\nIt lands the AC1 spec.", "owners": {"AC1": "E-14"}}, "drop": []}'
answer E-12 "make E-14 own AC1, not E-13"; out=$(btick)
check "DS-354 AC2: the edit is applied to the plan" '[ "$(node -e "const f=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")); console.log(f.owners.AC1, f.spine)" "$ES/E-12/feature.json")" = "E-14 E-11" ] && grep -q "^Edited on your answer: make E-14 own AC1, not E-13$" "$ES/E-12/plan.md"'
check "DS-354 AC2: the spine is filed under the epic from the edited draft" 'grep -q "^create Story Spine: one strict expected-fail spec for AC1 $ES/E-12/spine.md parent=E-12$" "$T/jira.calls" && grep -q "^It lands the AC1 spec.$" "$ES/E-12/spine.md" && [ -f "$ES/E-12/triage/E-11.json" ]'
check "DS-354 AC2: the batch starts, seeded spine first, with no second needs-you round" 'grep -q "^E-12 --json E-11 E-13 E-14 (seed)$" "$T/plan.calls" && [ "$(eget E-12 tickets.E-12)" = undefined ] && [ "$(eget E-12 tickets.E-11.state)" = triaged ] && [ "$(eget E-12 tickets.E-11.park)" = null ] && [ "$(eget E-12 tickets.E-14.held_by)" = E-11 ]'
check "DS-354 AC2: the batch's log says what was done" 'grep -q "^your edit to E-12.s plan was applied$" "$ES/E-12/supervisor.log" && grep -q "^E-12.s feature batch started on feat/E-12-edited, with its spine E-11 first: 2 children seeded by plan-batch$" "$ES/E-12/supervisor.log"'

# AC1: approved as it stands. The edited batch above is cleared away, so a second epic can start.
rm -rf "$EB/E-12" "$ES/E-12"
rec E-16 A '"summary":"the only child"'; printf 'E-16\n' > "$T/children/E-15"; rec E-15 A '"type":"Epic","branch":"feat/E-15-approved"'
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: the AC1 spec\", \"owners\": {\"AC1\": \"E-16\"}}"}
EOF
out=$(admit E-15 --by ben); n=$(count "$T/claude.calls")
answer E-15 start; out=$(btick)
check "DS-354 AC1: an approved plan starts the feature batch on its feature branch" '[ "$(eget E-15 base)" = feat/E-15-approved ] && [ "$(eget E-15 tickets.E-15)" = undefined ] && [ "$(eget E-15 tickets.E-11.state)" = triaged ] && [ "$(eget E-15 tickets.E-16.held_by)" = E-11 ] && grep -q "^E-15 --json E-11 E-16 (seed)$" "$T/plan.calls"'
check "DS-354 AC1: no editor runs on a plain start" '[ "$(count "$T/claude.calls")" = "$n" ] && grep -q "^E-15.s feature batch started on feat/E-15-approved, with its spine E-11 first: 1 child seeded by plan-batch$" "$ES/E-15/supervisor.log"'

# DS-591: a child the seed takes out because its own repo refused it still reaches the person: the epic
# stays, parked on the refusal, where needs-you and the digest read it, and the rest of the batch starts.
rm -rf "$EB/E-15" "$ES/E-15"
rec E-92 A '"summary":"the child here"'; rec E-93 A '"summary":"the child in another repo"'; printf 'E-92\nE-93\n' > "$T/children/E-91"; rec E-91 A '"type":"Epic","branch":"feat/E-91-split"'
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: the AC1 spec\", \"owners\": {\"AC1\": \"E-92\"}}"}
EOF
out=$(admit E-91 --by ben); touch "$T/refused.E-93"
answer E-91 start; out=$(btick); rm -f "$T/refused.E-93"
check "DS-591: a start whose seed refused a child starts the rest, and the refused child is out of the queue" '[ "$(eget E-91 base)" = feat/E-91-split ] && [ "$(eget E-91 tickets.E-11.state)" = triaged ] && [ "$(eget E-91 tickets.E-92.held_by)" = E-11 ] && [ "$(eget E-91 tickets.E-93)" = undefined ]'
check "DS-591: the epic stays parked on the refusal, with the command, for needs-you and the digest" '[ "$(eget E-91 tickets.E-91.state)" = parked ] && [ "$(pq E-91)" = "E-91'"'"'s feature batch started without E-93, which needs you: E-93 was not admitted in acme/web (the queue is locked): admit it there with node intake.mjs admit E-93. Once settled, take E-91 out of this queue: no worker has work on it" ]'
kind=$(node --input-type=module -e "import * as s from '$B/batch-state.mjs'; const t = JSON.parse(process.argv[1]); console.log(!s.planPark(t) && s.noWorkerWork(t.park.question) ? 'no-worker-work' : 'other')" "$(eget E-91 tickets.E-91)")
check "DS-591: that park is no plan answer to act on again, and reads as no worker work" '[ "$kind" = no-worker-work ]'
check "DS-591: the batch's log names it" 'grep -q "^E-91 stays parked for you in /desk-needs-you: E-91.s feature batch started without E-93" "$ES/E-91/supervisor.log"'
rm -rf "$EB/E-91" "$ES/E-91"
filed=$(node --input-type=module -e "import { readEdit } from '$B/epic-plan.mjs'; const out = (plan) => JSON.stringify({ type: 'result', result: 'PLAN_EDIT: ' + JSON.stringify({ plan, drop: [] }) }); const plan = { spine: 'E-11', draft: 'Spine: AC1', owners: { AC1: 'E-6' } }; console.log(readEdit(out({ draft: 'Spine: AC1 and AC2', owners: { AC1: 'E-6' } }), { children: ['E-6'], plan }).cannot ?? 'applied'); console.log(readEdit(out({ draft: 'Spine: AC1', owners: { AC1: 'E-7' } }), { children: ['E-6', 'E-7'], plan }).plan?.owners.AC1)")
check "DS-354: an edit to a spine already filed cannot be applied, and one to its owner table can" '[ "$filed" = "$(printf "it changes the spine, which is already filed as E-11: edit E-11 in Jira, then answer start\nE-7")" ]'

# ---- DS-434: what a drafted spine files as ---------------------------------------------------------
parsed(){ node --input-type=module -e "import { parseDraft } from '$B/epic-plan.mjs'; const p = parseDraft(process.argv[1], { keys: process.argv[2] === 'nosize' ? [] : ['size'] }); console.log(JSON.stringify([p.summary, p.type, p.blocks, p.body]))" "$1" "${2:-}"; }
check "DS-434: a labelled line that names no field stays in the body, in its place, and headers after it are still read" '[ "$(parsed "The spine

Goal: specs first
Type: Task

Note: land it first
Blocks: E-1

## Outcome")" = "[\"The spine\",\"Task\",[\"E-1\"],\"Goal: specs first\\n\\nNote: land it first\\n\\n## Outcome\"]" ]'
check "DS-434: a first line that only opens with a template word, or with a heading, is still the summary" '[ "$(parsed "Context menu specs land first
Type: Task
## Outcome")" = "[\"Context menu specs land first\",\"Task\",[],\"## Outcome\"]" ] && [ "$(parsed "## The spine
Type: Task")" = "[\"The spine\",\"Task\",[],\"\"]" ]'
check "DS-434: a Blocks line per key is read as every key" '[ "$(parsed "The spine
Blocks: E-1
Blocks: E-2
## Outcome")" = "[\"The spine\",\"Story\",[\"E-1\",\"E-2\"],\"## Outcome\"]" ]'
check "DS-434: a first line naming no filing header is the summary, and a body with no headers is whole" '[ "$(parsed "Spine: the AC1 spec
It lands the spec.")" = "[\"Spine: the AC1 spec\",\"Story\",[],\"It lands the spec.\"]" ]'
check "DS-434: headers in bold, with a blank line before them, are read and stay out of the body" '[ "$(parsed "# The spine

**Type:** Task
**Blocks**: E-1, E-2 and E-2

_Context: under E-5_

## Outcome
Specs.")" = "[\"The spine\",\"Task\",[\"E-1\",\"E-2\"],\"_Context: under E-5_\\n\\n## Outcome\\nSpecs.\"]" ]'
check "DS-434: headers before a title or a Summary line still leave the summary" '[ "$(parsed "Type: Task
The spine
Parent: E-5

## Outcome")" = "[\"The spine\",\"Task\",[],\"## Outcome\"]" ] && [ "$(parsed "Launch Priority: P2
Summary: The spine
## Outcome")" = "[\"The spine\",\"Story\",[],\"## Outcome\"]" ]'
check "DS-434: a draft of headers and sections alone has no summary" '[ "$(parsed "Type: Task
## Outcome")" = "[\"\",\"Task\",[],\"## Outcome\"]" ]'
check "DS-434: with no §4 Size field a Size line opens the body; with one it does not" '[ "$(parsed "The spine
Type: Task
Blocked by: E-1
Size: M
## Outcome" nosize)" = "[\"The spine\",\"Task\",[],\"Size: M\\nBlocked by: E-1\\n## Outcome\"]" ] && [ "$(parsed "The spine
Size: M
## Outcome")" = "[\"The spine\",\"Story\",[],\"## Outcome\"]" ]'

# The whole flow, on a repo with §4 Required fields. Each batch is cleared so the next can start.
rm -rf "$EB/E-15" "$ES/E-15"
required(){ printf '\n## 4. Toolchain\n| Field | Value |\n|---|---|\n| Required fields | `Story: customfield_10208, customfield_10207` `Task: customfield_10208, customfield_10207, customfield_10513` |\n| Size field | `customfield_10208` |\n| Priority | `customfield_10207` |\n| Priorities only you set | `P0` |\n' >> "$T/cfg/repos/acme__widgets/config.md"; }
drafted(){ printf '{"type":"result","total_cost_usd":0.12,"result":"Drafted.\\nPLAN_RESULT: %s"}\n' "$(node -e 'console.log(JSON.stringify(JSON.stringify({ draft: process.argv[1], owners: { AC1: process.argv[2] } })).slice(1, -1))' "$1" "$2")" > "$T/claude.out"; }
startepic(){ rec "$1" A "\"type\":\"Epic\",\"branch\":\"feat/$1-required\""; rec "$2" A '"summary":"a child"'; printf '%s\n' "$2" > "$T/children/$1"; }
clear_calls(){ : > "$T/jira.calls"; }
cleared(){ rm -rf "${EB:?}/${1:?}" "${ES:?}/${1:?}"; }
ALL="Spine: the AC1 spec
Type: Task
Parent: E-30
Assignee: Ben Lavender
Impact: every child
Repository: acme/widgets
Blocks: E-31, E-32
Size: M
customfield_10207: P2
Team / Squad (owner): None

_Context: under E-30_

## Outcome
The specs land first."

config yes '`none`'; required; startepic E-30 E-31; drafted "$ALL" E-31; clear_calls
out=$(admit E-30 --by ben)
check "DS-434: the drafter is told each required field, without a priority only the person sets" 'grep -q "^- Launch Priority (customfield_10207), one of P1, P2$" "$ES/E-30/plan-draft.prompt.md" && grep -qF -- "- Team / Squad (owner) (customfield_10513), one of Core, Growth" "$ES/E-30/plan-draft.prompt.md" && grep -q "^- T-shirt (customfield_10208)$" "$ES/E-30/plan-draft.prompt.md"'
check "DS-434: a plan with every value asks nothing more than start, edit or discard" 'grep -q "held behind it: read .*, then start, edit or discard it$" <<< "$(eget E-30 tickets.E-30.park.question)" && ! grep -q "Before it can start" "$ES/E-30/plan.md"'
clear_calls; answer E-30 start; out=$(btick)
check "DS-434 AC1: the spine is filed with a value for each required field, read by Jira name, §4 row and id, and None where Jira offers it" 'grep -qF "create Task Spine: the AC1 spec $ES/E-30/spine.md parent=E-30 customfield_10208=M customfield_10207=P2 customfield_10513=None" "$T/jira.calls"'
check "DS-434 AC4: a draft naming a type is filed as that type" 'grep -q "^create Task " "$T/jira.calls" && ! grep -q "^create Story " "$T/jira.calls"'
check "DS-434 AC3: the description holds none of the draft's header lines" '[ "$(cat "$ES/E-30/spine.md")" = "$(printf "_Context: under E-30_\n\n## Outcome\nThe specs land first.")" ]'
check "DS-434 AC5: each ticket the Blocks line names gets a Blocks link from the spine" 'grep -q "^link E-11 Blocks E-31$" "$T/jira.calls" && grep -q "^link E-11 Blocks E-32$" "$T/jira.calls" && [ -f "$ES/E-30/triage/E-11.json" ] && [ "$(eget E-30 tickets.E-30)" = undefined ]'
cleared E-30

# AC2: a value the batch cannot work out is asked for with the plan, and a start files nothing.
PART="Spine: the AC1 spec
Size: M
Launch Priority: TBD

## Outcome
The specs land first."
startepic E-33 E-34; drafted "$PART" E-34; clear_calls
out=$(admit E-33 --by ben)
check "DS-434 AC2: the plan asks for a required field with no value, naming its allowed values" 'grep -q "^feature plan awaiting your answer: the spine and owner table for E-33 are drafted, with 1 child held behind it, but its spine has no value for Launch Priority (customfield_10207), one of P1, P2 (config §4 Required fields and Size field): answer with an edit naming each: read $ES/E-33/plan.md, then edit or discard it$" <<< "$(eget E-33 tickets.E-33.park.question)" && grep -q "^Before it can start, its spine has no value for Launch Priority" "$ES/E-33/plan.md"'
check "DS-434 AC2: nothing is filed when the plan is drafted" '! grep -q "^create" "$T/jira.calls"'
answer E-33 start; out=$(btick)
check "DS-434 AC2: a start with the value still missing asks again, and files nothing" '[ "$(eget E-33 tickets.E-33.state)" = parked ] && grep -q "was not started, because its spine has no value for Launch Priority" <<< "$(pq E-33)" && ! grep -q "^create" "$T/jira.calls" && [ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).spine)" "$ES/E-33/feature.json")" = null ]'
editor "$(node -e 'console.log(JSON.stringify({ plan: { draft: process.argv[1].replace("Launch Priority: TBD", "Launch Priority: P2"), owners: { AC1: "E-34" } }, drop: [] }))' "$PART")"
answer E-33 "Launch Priority is P2"; out=$(btick)
check "DS-434 AC2: an edit naming the value gets past it, and the editor is told the fields" 'grep -q "customfield_10208=M customfield_10207=P2$" "$T/jira.calls" && grep -q "^- Launch Priority (customfield_10207), one of P1, P2$" "$ES/E-33/plan-edit.prompt.md" && [ "$(eget E-33 tickets.E-33)" = undefined ]'
cleared E-33

# When Jira's field names cannot be read, a header by a name only they hold cannot be matched, and it says so.
startepic E-35 E-36; drafted "Spine: the AC1 spec
T-shirt: M
Priority: P2" E-36; touch "$T/fields.fails"
out=$(admit E-35 --by ben)
check "DS-434: a field name Jira could not give is a question naming why" 'grep -q "its spine has no value for customfield_10208 (config §4 Required fields and Size field, and Jira.s field names could not be read: desk-jira: HTTP 503 from Jira)" <<< "$(eget E-35 tickets.E-35.park.question)"'
rm -f "$T/fields.fails"; cleared E-35

# Blocks: refused before filing where it could never be linked, and retried after a failed link.
SPINE="Spine: the AC1 spec
Size: M
Priority: P2
Blocks: E-38

## Outcome
The specs land first."
JIRA_EDIT=ask config yes '`none`'; required; startepic E-37 E-38; drafted "$SPINE" E-38; clear_calls
out=$(admit E-37 --by ben); answer E-37 start; out=$(btick)
check "DS-434 AC5: a Blocks line §3 jira-edit does not cover asks again before anything is filed" 'grep -q "because linking its spine to E-38 needs config §3 jira-edit to be \"yes\" (it is \"ask\")" <<< "$(pq E-37)" && ! grep -q "^create" "$T/jira.calls"'
cleared E-37
config yes '`none`'; required; startepic E-39 E-40; drafted "$SPINE" E-40; mkdir -p "$T/get"; touch "$T/get/E-38.fails"; clear_calls
out=$(admit E-39 --by ben); answer E-39 start; out=$(btick)
check "DS-434 AC5: a Blocks key that cannot be read asks again before anything is filed" 'grep -q "because its spine draft blocks E-38, which could not be read (desk-jira: HTTP 404 from Jira)" <<< "$(pq E-39)" && ! grep -q "^create" "$T/jira.calls"'
rm -f "$T/get/E-38.fails"; touch "$T/link.fails"; clear_calls
answer E-39 start; out=$(btick)
check "DS-434 AC5: a refused link asks again, with the spine's key kept" 'grep -q "because its spine E-11 is filed, but its Blocks link to E-38 was refused (desk-jira: HTTP 400 from Jira): put the links right in Jira, then answer start" <<< "$(pq E-39)" && [ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).spine)" "$ES/E-39/feature.json")" = E-11 ] && [ ! -f "$ES/E-39/triage/E-11.json" ]'
rm -f "$T/link.fails"; clear_calls
answer E-39 start; out=$(btick)
check "DS-434 AC5: the next start finishes the link and does not file a second spine" '! grep -q "^create" "$T/jira.calls" && grep -q "^link E-11 Blocks E-38$" "$T/jira.calls" && [ "$(eget E-39 tickets.E-39)" = undefined ]'
cleared E-39

# The §4 Size field is carried with no Required fields rule for it, and asked for like one.
config yes '`none`'; printf '\n## 4. Toolchain\n| Field | Value |\n|---|---|\n| Size field | `customfield_10208` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
startepic E-41 E-42; drafted "Spine: the AC1 spec
Size: M

## Outcome" E-42; out=$(admit E-41 --by ben); clear_calls; answer E-41 start; out=$(btick)
check "DS-434: a Size line is sent as the §4 Size field, with no Required fields rule for it" 'grep -qF "create Story Spine: the AC1 spec $ES/E-41/spine.md parent=E-41 customfield_10208=M" "$T/jira.calls" && [ "$(cat "$ES/E-41/spine.md")" = "## Outcome" ]'
cleared E-41
startepic E-43 E-44; drafted "Spine: the AC1 spec

## Outcome" E-44; clear_calls; out=$(admit E-43 --by ben)
check "DS-434: a draft with no value for the §4 Size field asks for it" 'grep -q "but its spine has no value for T-shirt (customfield_10208)" <<< "$(eget E-43 tickets.E-43.park.question)" && ! grep -q "^create" "$T/jira.calls"'
cleared E-43

# A required field Jira names Size, on a repo with no §4 Size field row, is read by that name.
config yes '`none`'; printf '\n## 4. Toolchain\n| Field | Value |\n|---|---|\n| Required fields | `Story: customfield_10300` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
startepic E-45 E-46; drafted "Spine: the AC1 spec
Size: M

## Outcome" E-46; out=$(admit E-45 --by ben); clear_calls; answer E-45 start; out=$(btick)
check "DS-434: a required field named Size is sent by that name, and stays out of the body" 'grep -qF "create Story Spine: the AC1 spec $ES/E-45/spine.md parent=E-45 customfield_10300=M" "$T/jira.calls" && [ "$(cat "$ES/E-45/spine.md")" = "## Outcome" ]'
cleared E-45

# A field line above the Type and Blocks lines, on a name only that type's rule holds.
config yes '`none`'; printf '\n## 4. Toolchain\n| Field | Value |\n|---|---|\n| Required fields | `Task: customfield_10301` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
startepic E-47 E-48; drafted "2nd Approver: Ann
The spine
Type: Task
Blocks: E-48

## Outcome" E-48; out=$(admit E-47 --by ben); clear_calls; answer E-47 start; out=$(btick)
check "DS-434: a field line above Type and Blocks is sent, and both are read when filing and when linking" 'grep -qF "create Task The spine $ES/E-47/spine.md parent=E-47 customfield_10301=Ann" "$T/jira.calls" && grep -q "^link E-11 Blocks E-48$" "$T/jira.calls"'
cleared E-47
config yes '`none`'

# ---- DS-380: a ticket whose files are only on a running batch's base joins that batch -------------
# main and feat/k-1 both have src/both.js; only feat/k-1 has src/only-k.js. Batch K-1 runs on feat/k-1.
g(){ git -C "$T/repo" -c user.name=t -c user.email=t@t "$@"; }
g checkout -q main; mkdir -p "$T/repo/src"; echo x > "$T/repo/src/both.js"; g add src/both.js; g commit -q -m both; g push -q origin main
g checkout -q -b feat/k-1; echo y > "$T/repo/src/only-k.js"; g add src/only-k.js; g commit -q -m only-k; g push -q origin feat/k-1; g checkout -q main
mkdir -p "$EB/K-1"
printf '{"version":1,"batch":"K-1","base":"feat/k-1","supervised":true,"tickets":{"K-0":{"key":"K-0","state":"running"}}}\n' > "$EB/K-1/queue.json"
config yes; running_batch
rec K-2 A '"files_in_scope":["src/only-k.js","src/new.js"]'; rec K-3 A '"files_in_scope":["src/both.js","src/new.js"]'; rec K-4 A '"files_in_scope":["src/only-k.js"]'
search K-2; out=$(intake)
check "DS-380 AC3: intake queues a ticket naming a file only on a running batch's base in that batch" '[ "$(eget K-1 tickets.K-2.state)" = triaged ] && [ "$(qget tickets.K-2)" = undefined ] && grep -q "^intake: admitted K-2 by intake into batch K-1 (lane A, size S): K-2 names src/only-k.js, which is on batch K-1.s base feat/k-1 and not on main: it joins that batch$" <<< "$out"'
check "DS-380 AC3: it is triaged again in that batch, on its base" 'grep -qx "K-2 K-1 unpinned" "$T/triage.batch"'
search K-3; out=$(intake)
check "DS-380 AC4: a ticket whose files are on both bases is queued where it is today" '[ "$(qget tickets.K-3.state)" = triaged ] && [ "$(eget K-1 tickets.K-3)" = undefined ]'
out=$(admit K-4 --by ben); rc=$?
check "DS-380 AC3: /desk-admit routes it the same way" '[ $rc -eq 0 ] && [ "$(eget K-1 tickets.K-4.admitted_by)" = ben ] && [ "$(qget tickets.K-4)" = undefined ] && grep -q "^admitted K-4 by ben into feature batch K-1 " <<< "$out"'
# A batch a session runs (K-5 on feat/k-5, not handed over) gets its ticket once it is handed over.
g checkout -q -b feat/k-5; echo z > "$T/repo/src/only-k5.js"; g add src/only-k5.js; g commit -q -m only-k5; g push -q origin feat/k-5; g checkout -q main
mkdir -p "$EB/K-5"
printf '{"version":1,"batch":"K-5","base":"feat/k-5","tickets":{"K-0":{"key":"K-0","state":"running"}}}\n' > "$EB/K-5/queue.json"
rec K-6 A '"files_in_scope":["src/only-k5.js"]'
search K-6; out=$(intake)
check "DS-380 AC3: a ticket for a session-run batch waits for its handover, saying so" '[ "$(eget K-5 tickets.K-6)" = undefined ] && [ "$(qget tickets.K-6)" = undefined ] && grep -q "^intake: K-6 not admitted yet: K-6 names src/only-k5.js, which is on batch K-5.s base feat/k-5 and not on main: it joins that batch, once a session hands batch K-5 to the supervisor (queue.mjs set-batch supervised=true): /desk-admit K-6 adds it now$" <<< "$out"'
n=$(count "$T/triage.calls"); out=$(intake)
check "DS-380 AC3: it is not triaged again while that batch is still the session's" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$(eget K-5 tickets.K-6)" = undefined ]'
printf '{"version":1,"batch":"K-5","base":"feat/k-5","supervised":true,"tickets":{"K-0":{"key":"K-0","state":"running"}}}\n' > "$EB/K-5/queue.json"
out=$(intake)
check "DS-380 AC3: once handed over, the next intake queues it in that batch" '[ "$(eget K-5 tickets.K-6.state)" = triaged ] && [ "$(qget tickets.K-6)" = undefined ] && grep -q "^intake: admitted K-6 by intake into batch K-5 " <<< "$out"'
rm -rf "$EB/K-1" "$EB/K-5"

# ---- DS-383: an epic admitted from a checkout on another branch, with desk's pre-push hook ---------
# The real hook, with a Pre-push checks row that would fail if it ran.
mkdir -p "$T/desk"; ln -s "$B" "$T/desk/bin"
cp -R "$S/../desk/templates/.githooks" "$S/../desk/templates/scripts" "$T/repo/"; chmod +x "$T/repo/.githooks/pre-push"
printf '\n## 4. Tools\n| Field | Value |\n|---|---|\n| Pre-push checks | `false` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
g config core.hooksPath .githooks; g checkout -q -b side-work; echo w > "$T/repo/src/side.js"; g add src/side.js; g commit -q -m side; g checkout -q -b elsewhere HEAD~1
out=$(g push origin side-work:refs/heads/x 2>&1); rc=$?
check "DS-383: the hook is live, and refuses a new commit that is not HEAD" '[ $rc -ne 0 ] && grep -q "^pre-push: .* not HEAD" <<< "$out"'
rec E-21 A '"summary":"the side child"'; printf 'E-21\n' > "$T/children/E-20"; rec E-20 A '"type":"Epic","branch":"feat/E-20-side"'
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: the AC1 spec\", \"owners\": {\"AC1\": \"E-21\"}}"}
EOF
out=$(admit E-20 --by ben); rc=$?
check "DS-383 AC1: from a checkout on another branch, the feature branch is pushed at main's tip and the batch starts" '[ $rc -eq 0 ] && grep -q "^started feature batch E-20 on feat/E-20-side" <<< "$out" && [ "$(git -C "$T/repo" ls-remote --heads origin feat/E-20-side | cut -f1)" = "$(git -C "$T/repo" rev-parse origin/main)" ]'
mkdir -p "$T/refuse-hooks"; printf '#!/bin/sh\necho "pre-push: refused for the test" >&2\necho "pre-push: here is the fix" >&2\nexit 1\n' > "$T/refuse-hooks/pre-push"; chmod +x "$T/refuse-hooks/pre-push"
g config core.hooksPath "$T/refuse-hooks"; rec E-22 A '"type":"Epic","branch":"feat/E-22-refused"'
out=$(admit E-22 --by ben); rc=$?
check "DS-383 AC4: a refused push's reason carries the hook's pre-push lines and git's" '[ $rc -eq 11 ] && grep -q "^not admitted E-22: .*could not be read or pushed (pre-push: refused for the test pre-push: here is the fix error: failed to push some refs" <<< "$out"'
g config --unset core.hooksPath; g checkout -q main; rm -rf "$EB/E-20" "$T/desk/bin"

# ---- DS-394: only a reserved topic or no recommendation refuses; a done ticket is said done ---------
# tracker: the config with Jira keys, so /desk-admit reads each ticket's status before triage.
tracker(){ config yes "${1-\`none\`}"; printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `[A-Z]+-[0-9]+` |\n' >> "$T/cfg/repos/acme__widgets/config.md"; }
status(){ mkdir -p "$T/get"; printf '{"key":"%s","fields":{"status":{"name":"%s","statusCategory":{"key":"%s"}}}}\n' "$1" "$2" "$3" > "$T/get/$1.json"; }
# call <question> <category> <option> <option> <recommended as JSON>: one triage unknown.
call(){ printf '{"question":"%s","category":"%s","options":["%s","%s"],"recommended":%s}' "$1" "$2" "$3" "$4" "$5"; }
logged(){ jq -s -c "[.[] | select(.ticket == \"$1\") | [.question, .chose, .category, .source]]" "$T/state/decisions.jsonl" 2>/dev/null; }
tracker; running_batch; rm -f "$T/state/intake.json" "$T/state/decisions.jsonl"
status DN-1 Done "done"; rec DN-1 A; n=$(count "$T/triage.calls")
out=$(admit DN-1 --by ben); rc=$?
check "DS-394 AC1: /desk-admit says a ticket done in Jira is already done, exit 0" '[ $rc -eq 0 ] && grep -q "^DN-1 is already done in Jira (Done): nothing triaged or admitted$" <<< "$out" && ! grep -q "not admitted" <<< "$out"'
check "DS-394 AC1: nothing is triaged or admitted for it" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$(qget tickets.DN-1)" = undefined ] && ! grep -qs DN-1 "$T/state/intake.json"'
status DN-2 "In Progress" indeterminate; rec DN-2 A
out=$(admit DN-2 --by ben); rc=$?
check "DS-394 AC1: a ticket Jira has not done is triaged and admitted as before" '[ $rc -eq 0 ] && [ "$(count "$T/triage.calls")" = $((n + 1)) ] && [ "$(qget tickets.DN-2.state)" = triaged ]'
tracker '`project = ACME`'; rec DN-3 A; n=$(count "$T/triage.calls")
echo '{"issues":[{"key":"DN-3","fields":{"status":{"name":"Closed","statusCategory":{"key":"done"}}}}]}' > "$T/search.json"; out=$(intake)
check "DS-394 AC1: intake says a ticket the search shows done is already done, and triages nothing" 'grep -q "^intake: DN-3 already done in Jira (Closed): nothing triaged or admitted$" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ] && [ "$(qget tickets.DN-3)" = undefined ]'
out=$(intake)
check "DS-394 AC1: intake says it once" '[ "$out" = "intake: nothing new" ] && [ "$(count "$T/triage.calls")" = "$n" ]'
echo '{"issues":[{"key":"DN-3","fields":{"status":{"name":"To Do","statusCategory":{"key":"new"}}}}]}' > "$T/search.json"; out=$(intake)
check "DS-394: once reopened, intake takes it as any other" '[ "$(qget tickets.DN-3.state)" = triaged ]'
rec DN-4 A '"type":"Epic"'; n=$(count "$T/triage.calls")
echo '{"issues":[{"key":"DN-4","fields":{"issuetype":{"name":"Epic"},"status":{"name":"Done","statusCategory":{"key":"done"}}}}]}' > "$T/search.json"; out=$(intake)
check "DS-394 AC1: intake says an epic the search shows done is already done, and starts nothing for it" 'grep -q "^intake: DN-4 already done in Jira (Done): nothing triaged or admitted$" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ] && [ ! -e "$EB/DN-4" ]'
tracker
# The record as triage.sh writes it: unknowns left to the person, the calls it took in decided.
rec TK-1 A "\"decided\":[{\"question\":\"which retry backoff?\",\"options\":[\"fixed\",\"exponential\"],\"chose\":\"exponential\",\"category\":\"engineering\"},{\"question\":\"name the flag?\",\"options\":[\"on\",\"enabled\"],\"chose\":\"enabled\",\"category\":\"wording\"}]"
out=$(admit TK-1 --by ben); rc=$?
check "DS-394 AC2: a ticket whose only unknowns are calls with a recommendation is admitted, saying so" '[ $rc -eq 0 ] && [ "$(qget tickets.TK-1.state)" = triaged ] && grep -q "^admitted TK-1 by ben into batch b1 (lane A, size S), took 2 call(s) on triage.s recommendation (logged)$" <<< "$out"'
check "DS-394 AC2: each call is logged as a decision" '[ "$(logged TK-1)" = "[[\"which retry backoff?\",\"exponential\",\"engineering\",\"triage\"],[\"name the flag?\",\"enabled\",\"wording\",\"triage\"]]" ]'
rec TK-2 A "\"unknowns\":[$(call 'what does the pro tier cost?' money '10 GBP' '20 GBP' '"10 GBP"'),$(call 'which retry backoff?' engineering fixed exponential '"exponential"')]"
rec TK-3 A "\"unknowns\":[$(call 'keep the old export?' scope keep drop null)]"
out=$(admit TK-2 TK-3); rc=$?
check "DS-394 AC3: an unknown on a reserved topic refuses the ticket with that question, as today" '[ $rc -eq 11 ] && grep -q "^not admitted TK-2: open question(s): what does the pro tier cost?$" <<< "$out" && [ "$(qget tickets.TK-2)" = undefined ]'
check "DS-394 AC3: so does a call with no recommendation, and a refused ticket logs nothing" 'grep -q "^not admitted TK-3: open question(s): keep the old export?$" <<< "$out" && [ "$(logged TK-2)" = "[]" ] && [ "$(logged TK-3)" = "[]" ]'
rec VO-1 A '"verify_only":true,"already_met":["AC1: src/a.js:12 retries","AC2: src/b.js:4 logs"]'
out=$(admit VO-1 --by ben); rc=$?
check "DS-394 AC4: a ticket whose every criterion is already met is admitted as verify-only" '[ $rc -eq 0 ] && [ "$(qget tickets.VO-1.state)" = triaged ] && grep -q "^admitted VO-1 by ben into batch b1 (lane A, size S, verify-only)$" <<< "$out"'

# ---- DS-506: a bounded triage pool, each ticket admitted as soon as it can be ---------------------
# most: the most triages in flight at once, from $T/triage.events. started <KEY>: how many tickets the
# queue held as admitted when that ticket's triage started.
most(){ local n=0 m=0 ev; while read -r ev _; do if [ "$ev" = start ]; then n=$((n + 1)); [ $n -gt $m ] && m=$n; else n=$((n - 1)); fi; done < "$T/triage.events"; echo $m; }
started(){ grep "^start $1 " "$T/triage.events" | tail -1 | cut -d' ' -f3; }
pool(){ TRIAGE_K="$1" tracker; running_batch; rm -f "$T/triage.events" "$T/triage.calls"; ungate; }
# PL-1 to PL-3 each end only once all three have started.
P10=(PL-1 PL-2 PL-3 PL-4 PL-5 PL-6 PL-7 PL-8 PL-9 PL-10)
for k in "${P10[@]}"; do rec "$k" A; done
pool 3; for k in PL-1 PL-2 PL-3; do for s in PL-1 PL-2 PL-3; do gate "$k" triage.events "^start $s "; done; done
out=$(DESK_MEM_AVAIL_GB=64 admit "${P10[@]}" --by ben); rc=$?
check "DS-506 AC1: with Triage concurrency 3, three triages run at once and never more" '[ $rc -eq 0 ] && [ "$(most)" = 3 ] && [ "$(count "$T/triage.calls")" = 10 ]'
check "DS-506 AC1: the first ticket is admitted before the last triage starts" '[ "$(started PL-10)" -ge 1 ] && [ "$(qget tickets.PL-10.state)" = triaged ] && [ "$(grep -c "^admitted PL-" <<< "$out")" = 10 ]'
# AC2: SB is blocked by SA, whose triage is the slowest: it ends once SB's has, and SC is admitted.
rec SA A; rec SB A '"blockers":[{"key":"SA","category":"new"}]'; rec SC A
pool 3; gate SA admit.out '^triage: done SB '; gate SA admit.out '^admitted SC '
out=$(DESK_MEM_AVAIL_GB=64 admit SB SC SA --by ben); rc=$?
check "DS-506 AC2: a blocker whose triage is the slowest is admitted before what it blocks, held behind it in the batch" \
  '[ $rc -eq 0 ] && [ "$(grep "^admitted S" <<< "$out" | cut -d" " -f2 | tr "\n" " ")" = "SC SA SB " ] && [ "$(qget tickets.SB.held_by)" = SA ] && [ "$(qget tickets.SB.held_outside)" = undefined ]'
# AC3: one triage fails among three.
rec FA A; rec FB A; rec FC A; touch "$T/recs/FB.fails"
pool 3; out=$(DESK_MEM_AVAIL_GB=64 admit FA FB FC --by ben); rc=$?
check "DS-506 AC3: a failed triage refuses that ticket with its reason and admits every other" \
  '[ $rc -eq 11 ] && grep -qx "not admitted FB: triage failed: triage: claude exited 1: fix it and run /desk-admit FB again" <<< "$out" && [ "$(qget tickets.FA.state)" = triaged ] && [ "$(qget tickets.FC.state)" = triaged ] && [ "$(qget tickets.FB)" = undefined ]'
# AC4: LA stops at the usage limit while LB is still in flight, ending once LA's limit is said; LC to LE never start.
for k in LA LB LC LD LE; do rec "$k" A; done; cp "$T/recs/U-1.limit" "$T/recs/LA.limit"
pool 2; gate LB admit.out '^not admitted LA'; out=$(DESK_MEM_AVAIL_GB=64 admit LA LB LC LD LE --by ben); rc=$?
check "DS-506 AC4: after a usage limit no triage starts, and the one in flight finishes and is admitted" \
  '[ $rc -eq 11 ] && [ "$(sort "$T/triage.calls" | tr "\n" " ")" = "LA LB " ] && [ "$(qget tickets.LB.state)" = triaged ]'
check "DS-506 AC4: the tickets not triaged are named with the reset time and the command to run again" \
  'grep -qx "not triaged (usage limit, resets 2027-01-15 08:00 UTC): LC LD LE: run /desk-admit LC LD LE again once the limit lifts" <<< "$out" && grep -q "^not admitted LA: triage stopped at the weekly usage limit" <<< "$out"'
# AC5: killed once KA is admitted, while KB's triage runs: it runs until the test releases it.
rec KA A; rec KB A
pool 1; gate KB release '^KB$'; (cd "$T/repo" && exec node "$T/bin/intake.mjs" admit KA KB --by ben >/dev/null 2>&1) & pid=$!
i=0; while ! grep -q "^start KB " "$T/triage.events" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
# KB's triage outlives the kill; let it end before a later test's events are read.
release KB; i=0; while ! grep -q "^end KB" "$T/triage.events" && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done; ungate; : > "$T/triage.calls"
out=$(admit KA KB --by ben); rc=$?
check "DS-506 AC5: run again after a kill, an admitted ticket is already in the batch and only the rest are triaged" \
  '[ $rc -eq 0 ] && grep -qx "KA is already in batch b1 (triaged)" <<< "$out" && [ "$(tr "\n" " " < "$T/triage.calls")" = "KB " ] && [ "$(qget tickets.KB.state)" = triaged ]'
# AC6: at 1, one at a time, in the order given. outcomes: the run's lines less its progress.
outcomes(){ grep -Ev '^(triage|waiting|summary): ' <<< "$out"; }
rec OA A '"blockers":[{"key":"OC","category":"new"}]'; rec OB A; rec OC A
pool ''; out=$(admit OA OB OC --by ben); rc=$?
check "DS-506 AC6: at Triage concurrency 1, triages run one at a time in the order given" '[ "$(most)" = 1 ] && [ "$(tr "\n" " " < "$T/triage.calls")" = "OA OB OC " ]'
check "DS-506 AC6: and what it admits, in what order, is as before" '[ $rc -eq 0 ] && [ "$(outcomes)" = "$(printf "admitted OB by ben into batch b1 (lane A, size S)\nadmitted OC by ben into batch b1 (lane A, size S)\nadmitted OA by ben into batch b1 (lane A, size S), held behind OC\nthe supervisor'\''s next tick picks them up")" ]'
rec OD A; rec OE A; touch "$T/recs/OE.fails"
pool ''; out=$(admit OD OE R --by ben); rc=$?
check "DS-507 AC2: every line comes as it happens, what needs no triage first" \
  '[ $rc -eq 11 ] && [ "$(outcomes)" = "$(printf "R is already in batch b1 (running)\nadmitted OD by ben into batch b1 (lane A, size S)\nnot admitted OE: triage failed: triage: claude exited 1: fix it and run /desk-admit OE again\nthe supervisor'\''s next tick picks it up")" ]'
check "DS-507 AC2: a triage that left no record says so" 'grep -Eq "^triage: done OE no record \([0-9]+s\)$" <<< "$out"'
# A blocker Jira links, and one more ticket after it. One at a time keeps today's order; more than one
# triages the blocker first, to free what it blocks sooner.
rec JX-1 A '"blockers":[{"key":"JX-2","category":"new"}]'; rec JX-2 A; rec JX-3 A
printf '{"key":"JX-1","fields":{"status":{"name":"To Do","statusCategory":{"key":"new"}},"issuelinks":[{"type":{"inward":"is blocked by"},"inwardIssue":{"key":"JX-2","fields":{"status":{"statusCategory":{"key":"new"}}}}}]}}\n' > "$T/get/JX-1.json"
pool ''; out=$(admit JX-1 JX-2 JX-3 --by ben)
check "DS-506 AC6: at Triage concurrency 1, a blocker Jira links is triaged in the order given" '[ "$(tr "\n" " " < "$T/triage.calls")" = "JX-1 JX-2 JX-3 " ] && [ "$(qget tickets.JX-1.held_by)" = JX-2 ]'
check "DS-506 AC6: and a ticket behind another is placed after the free ones, as today" '[ "$(grep "^admitted" <<< "$out" | cut -d" " -f2 | tr "\n" " ")" = "JX-2 JX-3 JX-1 " ]'
rec QA A '"blockers":[{"key":"QB","category":"new"}]'; rec QB A; rec QC A; touch "$T/recs/QB.fails"
pool ''; out=$(admit QA QC QB --by ben)
check "DS-506 AC6: a free ticket keeps its turn behind one whose blocker is then refused, as today" '[ "$(grep "^admitted" <<< "$out" | cut -d" " -f2 | tr "\n" " ")" = "QA QC " ]'
rec RP A; rec RX A '"blockers":[{"key":"RP","category":"new"}]'; rec RA A '"blockers":[{"key":"RB","category":"new"}]'; rec RC A; rec RB A
pool ''; out=$(admit RP RX RA RC RB --by ben)
check "DS-506 AC6: the tickets left to the end keep today's rounds, past what was placed early" '[ "$(grep "^admitted" <<< "$out" | cut -d" " -f2 | tr "\n" " ")" = "RP RC RB RX RA " ]'
# JX-2 and JX-3 each end only once both have started, so JX-1 starts after both.
pool 2; gate JX-2 triage.events '^start JX-3 '; gate JX-3 triage.events '^start JX-2 '
out=$(DESK_MEM_AVAIL_GB=64 admit JX-1 JX-3 JX-2 --by ben)
check "DS-506: with more than one at once, a blocker Jira links is triaged before what it blocks" '[ "$(tail -1 "$T/triage.calls")" = JX-1 ] && [ "$(qget tickets.JX-1.held_by)" = JX-2 ]'
# AC7: a subtask the epic lists has no epic on its record, and is named before it: nothing is placed
# until the epic has started. SP-3 is named between them, and SP-4 is blocked by a child the call leaves out.
epicget(){ printf '{"key":"%s","fields":{"issuetype":{"name":"Epic","hierarchyLevel":1},"status":{"name":"To Do","statusCategory":{"key":"new"}}}}\n' "$1" > "$T/get/$1.json"; }
rec SP-1 A '"type":"Epic","branch":"feat/SP-1-subtask"'; epicget SP-1; rec SP-2 A; rec SP-3 A; rec SP-5 A; rec SP-4 A '"blockers":[{"key":"SP-5","category":"new"}]'
printf 'SP-2\nSP-5\n' > "$T/children/SP-1"
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: the AC1 spec\", \"owners\": {\"AC1\": \"SP-2\"}}"}
EOF
pool ''; out=$(admit SP-2 SP-3 SP-4 SP-1 --by ben); rc=$?
check "DS-506 AC7: an epic named last still starts, with the subtask it lists in its feature batch and not the standing one" \
  'grep -q "^started feature batch SP-1 on feat/SP-1-subtask" <<< "$out" && [ "$(eget SP-1 tickets.SP-2.admitted_by)" = ben ] && [ "$(qget tickets.SP-2)" = undefined ]'
check "DS-506 AC6: a ticket between them is placed once the epic has started, as today" '[ "$(started SP-1)" = 0 ] && [ "$(qget tickets.SP-3.state)" = triaged ]'
check "DS-506 AC7: a ticket blocked by a child the call leaves out joins the feature batch it routes to" \
  '[ "$(qget tickets.SP-4)" = undefined ] && [ "$(eget SP-1 tickets.SP-4.admitted_by)" = ben ] && grep -q "^admitted SP-4 by ben into feature batch SP-1 " <<< "$out"'
check "DS-507 AC2: its triage again in that batch is said too" 'grep -qx "triage: started SP-4 in batch SP-1" <<< "$out" && [ "$(grep -c "^triage: done SP-4 lane A" <<< "$out")" = 2 ]'
# AC8: the spawn gate holding brings the pool down to one. Each start line says how many triages the
# pool is running at that moment, so one at a time is read there, however quickly each triage ends.
for k in MA MB MC; do rec "$k" A; done
pool 3; out=$(DESK_MEM_AVAIL_GB=2 admit MA MB MC --by ben); rc=$?
check "DS-506 AC8: while the memory spawn gate holds, triages run one at a time, saying why" \
  '[ $rc -eq 0 ] && [ "$(most)" = 1 ] && [ "$(grep -c "^triage: started M[ABC] (1/3 running)$" <<< "$out")" = 3 ] && grep -qx "triaging one at a time: available memory 2.0G is under the 8G spawn gate" <<< "$out"'

# ---- an admit says each thing as it happens, and triages one at a time by default --------------------
# SL-2's triage is the slowest, SL-3 is blocked by it, and SL-4 is refused: everything but SL-2 and what
# waits for it is read while the run is still going, and SL-2's triage ends only once the test has
# read it. Times are blanked: they depend on the machine.
rec SL-1 A; rec SL-2 A; rec SL-3 A '"blockers":[{"key":"SL-2","category":"new"}]'; rec SL-4 C
pool 2; gate SL-2 release '^SL-2$'; : > "$T/admit.out"
(cd "$T/repo" && DESK_MEM_AVAIL_GB=64 exec node "$T/bin/intake.mjs" admit SL-1 SL-2 SL-3 SL-4 --by ben > "$T/admit.out" 2>&1) & pid=$!
i=0; while ! grep -q "^not admitted SL-4" "$T/admit.out" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
kill -0 "$pid" 2>/dev/null; running=$?
sofar=$(sed -E 's/\([0-9]+s\)$/(t)/' "$T/admit.out")
release SL-2; wait "$pid"; rc=$?
out=$(sed -E 's/\([0-9]+s\)$/(t)/' "$T/admit.out")
check "DS-507 AC2: each line is printed in order while the run is still going" '[ "$running" -eq 0 ] && [ "$sofar" = "$(printf "%s\n" "triage: started SL-1 (1/4 running)" "triage: started SL-2 (2/4 running)" "triage: done SL-1 lane A (t)" "admitted SL-1 by ben into batch b1 (lane A, size S)" "triage: started SL-3 (2/4 running)" "triage: done SL-3 lane A (t)" "waiting: SL-3 for blocker SL-2" "triage: started SL-4 (2/4 running)" "triage: done SL-4 lane C (t)" "not admitted SL-4: lane C: needs a plan")" ]'
check "DS-507 AC2: the rest follows when the blocker ends, a final summary last, and nothing is printed twice" '[ $rc -eq 11 ] && [ "$out" = "$(printf "%s\n" "$sofar" "triage: done SL-2 lane A (t)" "admitted SL-2 by ben into batch b1 (lane A, size S)" "admitted SL-3 by ben into batch b1 (lane A, size S), held behind SL-2" "the supervisor'\''s next tick picks them up" "summary: 3 of 4 admitted, 1 not admitted (t)")" ]'
# An epic's children are triaged in its feature batch, and each says so while the epic is still starting.
# SC-3's triage in the feature batch ends only once the test has read what was said so far.
rec SC-1 A '"type":"Epic","branch":"feat/SC-1-lines"'; epicget SC-1; rec SC-2 A; rec SC-3 A
printf 'SC-2\nSC-3\n' > "$T/children/SC-1"
pool 1; gate SC-3@SC-1 release '^SC-3$'; : > "$T/admit.out"
(cd "$T/repo" && exec node "$T/bin/intake.mjs" admit SC-1 --by ben > "$T/admit.out" 2>&1) & pid=$!
i=0; while ! grep -q "^triage: started SC-3" "$T/admit.out" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
kill -0 "$pid" 2>/dev/null; running=$?
sofar=$(sed -E 's/\([0-9]+s\)$/(t)/' "$T/admit.out")
release SC-3; wait "$pid"; rc=$?
out=$(sed -E 's/\([0-9]+s\)$/(t)/' "$T/admit.out")
check "DS-507 AC2: an epic's start and each child's triage are printed while the epic is still starting" '[ "$running" -eq 0 ] && [ "$sofar" = "$(printf "%s\n" "triage: started SC-1 (1/1 running)" "triage: done SC-1 lane A (t)" "started feature batch SC-1 on feat/SC-1-lines, beside the standing batch" "triage: started SC-2 in batch SC-1" "triage: done SC-2 lane A (t)" "triage: started SC-3 in batch SC-1")" ]'
check "DS-507 AC2: the child's end follows, and no epic line is printed twice" '[ $rc -eq 0 ] && grep -q "^triage: done SC-3 lane A (t)$" <<< "$out" && [ "$(grep -c "^started feature batch SC-1" <<< "$out")" = 1 ] && [ "$(grep -c "held behind it, and its plan waits" <<< "$out")" = 1 ]'
rec SF-1 A '"type":"Epic","branch":"feat/SF-1-lines"'; epicget SF-1; rec SF-2 A; touch "$T/recs/SF-2.fails"; printf 'SF-2\n' > "$T/children/SF-1"
out=$(admit SF-1 --by ben); rc=$?
check "DS-507 AC2: a child's triage that left no record says so before the epic is refused" '[ $rc -eq 11 ] && grep -Eq "^triage: done SF-2 no record \([0-9]+s\)$" <<< "$out" && grep -q "^not admitted SF-1: an epic, and its feature batch was not started: child SF-2 could not be triaged" <<< "$out"'
# A child's failed triage is run once more; a second failure names its class, and the discard keeps the
# records already written, so admitting the epic again triages only the child that has none.
rec SR-1 A '"type":"Epic","branch":"feat/SR-1-retry"'; epicget SR-1; rec SR-2 A; rec SR-3 A; touch "$T/recs/SR-3.failonce"; printf 'SR-2\nSR-3\n' > "$T/children/SR-1"
rm -f "$T/triage.calls"; out=$(admit SR-1 --by ben); rc=$?
check "DS-814 AC1: a child whose triage fails once is tried once more, and the batch starts" '[ $rc -eq 0 ] && [ "$(tr "\n" " " < "$T/triage.calls")" = "SR-1 SR-2 SR-3 SR-3 " ] && grep -qx "triage: SR-3 failed (unknown), so it is tried once more in 0s" <<< "$out" && [ "$(eget SR-1 tickets.SR-3.held_by)" = SR-1 ]'
check "DS-814 AC1: the retry waits 60 seconds unless overridden" '[ "$(env -u DESK_TRIAGE_RETRY_MS node --input-type=module -e "import { TRIAGE_RETRY_MS } from \"$B/epic-plan.mjs\"; console.log(TRIAGE_RETRY_MS)")" = 60000 ]'
rec SA-1 A '"type":"Epic","branch":"feat/SA-1-auth"'; epicget SA-1; rec SA-2 A; rec SA-3 A; touch "$T/recs/SA-3.authfails"; printf 'SA-2\nSA-3\n' > "$T/children/SA-1"
rm -f "$T/triage.calls"; out=$(admit SA-1 --by ben); rc=$?
check "DS-814 AC2: a child whose triage fails twice stops the epic, naming the child and its error class" '[ $rc -eq 11 ] && [ ! -e "$EB/SA-1" ] && [ "$(tr "\n" " " < "$T/triage.calls")" = "SA-1 SA-2 SA-3 SA-3 " ] && grep -qx "not admitted SA-1: an epic, and its feature batch was not started: child SA-3 could not be triaged, twice (auth: FAIL: SA-3 produced no triage record: HTTP 401. That is the login, not the session limit); batch SA-1 discarded" <<< "$out"'
kept(){ node -e 'const k=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(Object.keys(k).map((c)=>`${c}@${k[c].base}`).join(" "))' "$ES/$1/triage/kept.json"; }
check "DS-814 AC3: the discard keeps the triage records, listing only the child triaged in full" '[ "$(ls "$ES/SA-1")" = triage ] && [ -f "$ES/SA-1/triage/SA-2.json" ] && [ "$(kept SA-1)" = "SA-2@feat/SA-1-auth" ]'
rm -f "$T/recs/SA-3.authfails" "$T/triage.calls"; out=$(admit SA-1 --by ben); rc=$?
check "DS-814 AC3: admitted again, only the child with no triage record is triaged" '[ $rc -eq 0 ] && [ "$(tr "\n" " " < "$T/triage.calls")" = "SA-1 SA-3 " ] && grep -qx "triage: kept SA-2.s record from an earlier start of batch SA-1" <<< "$out" && [ "$(eget SA-1 tickets.SA-2.held_by)" = SA-1 ]'
# A record triage refused is left on disk, as triage.sh leaves it, and is never reused: only a child
# listed in kept.json is, and only while its listing is recent.
rec SL-1 A '"type":"Epic","branch":"feat/SL-1-lint"'; epicget SL-1; rec SL-2 A; rec SL-3 A; touch "$T/recs/SL-3.badrec"; printf 'SL-2\nSL-3\n' > "$T/children/SL-1"
rm -f "$T/triage.calls"; out=$(admit SL-1 --by ben); rc=$?
check "DS-814 AC2: a child whose record is refused twice is named with the lint class" '[ $rc -eq 11 ] && grep -q "child SL-3 could not be triaged, twice (lint: FAIL: SL-3 triage record is malformed)" <<< "$out" && [ -f "$ES/SL-1/triage/SL-3.json" ] && [ "$(kept SL-1)" = "SL-2@feat/SL-1-lint" ]'
node -e 'const f=process.argv[1], k=JSON.parse(require("fs").readFileSync(f,"utf8")); k["SL-2"].at=new Date(Date.now()-7*3600e3).toISOString(); require("fs").writeFileSync(f, JSON.stringify(k))' "$ES/SL-1/triage/kept.json"
rm -f "$T/recs/SL-3.badrec" "$T/triage.calls"; out=$(admit SL-1 --by ben); rc=$?
check "DS-814 AC3: a record refused, or listed longer ago than six hours, is triaged again" '[ $rc -eq 0 ] && [ "$(tr "\n" " " < "$T/triage.calls")" = "SL-1 SL-2 SL-3 " ] && ! grep -q "^triage: kept" <<< "$out"'
# A slot holding only kept records is cleared by a discard, which refuses a slot with nothing in it.
rec SK-1 A '"type":"Epic","branch":"feat/SK-1-left"'; epicget SK-1; rec SK-2 A; touch "$T/recs/SK-2.authfails"; printf 'SK-2\n' > "$T/children/SK-1"
out=$(admit SK-1 --by ben); mkdir -p "$ES/SK-1/triage"
out=$(cd "$T/repo" && node "$T/bin/batch.mjs" discard SK-1 2>&1); rc=$?
check "DS-814 AC3: a discard removes a slot that holds only kept triage records" '[ $rc -eq 0 ] && [ ! -e "$ES/SK-1" ] && grep -q "had only the triage records an earlier start kept" <<< "$out"'
out=$(cd "$T/repo" && node "$T/bin/batch.mjs" discard SK-1 2>&1); rc=$?
check "DS-814 AC3: and refuses once nothing is left" '[ $rc -eq 11 ] && grep -q "no batch SK-1 in this repo: nothing removed" <<< "$out"'
rm -f "$T/recs/SK-2.authfails"
classes=$(node --input-type=module -e "import { triageErrorClass as c } from '$B/epic-plan.mjs'; console.log([c({ status: null, signal: 'SIGTERM', stderr: '' }), c({ status: 1, stderr: 'FAIL: X produced no triage record: claude timed out after 600s (log: /x.log)' }), c({ status: 1, stderr: 'FAIL: X triage record is malformed: bad lane. Triage it again.' }), c({ status: 1, stderr: 'FAIL: X not triaged: no subscription here, and triage never runs on another login' }), c({ status: 1, stderr: 'triage: claude exited 1' })].join(' '))")
check "DS-814 AC2: a failed triage's class is read from how it ended and its last stderr line" '[ "$classes" = "timeout timeout lint auth unknown" ]'
# Those triages leave the rest free to say they finished: SG-2 ends during SG-3's triage as SG-1's child,
# and SJ-2 during SJ-1's triage again in the feature batch it joins.
after(){ sed -n "/^triage: done $1 /,\$p" <<< "$out" | grep -q "^triage: done $2 "; }
# Each gate holds the one triage until the other's start, and that one until the first's end is said.
rec SG-1 A '"type":"Epic","branch":"feat/SG-1-lines"'; epicget SG-1; rec SG-2 A; rec SG-3 A
printf 'SG-3\n' > "$T/children/SG-1"
pool 2; gate SG-2 triage.events '^start SG-3 '; gate SG-3@SG-1 admit.out '^triage: done SG-2 '
out=$(DESK_MEM_AVAIL_GB=64 admit SG-1 SG-2 --by ben); rc=$?
check "DS-507 AC2: a ticket's triage that ends while an epic's child is in triage says so at once" '[ $rc -eq 0 ] && after SG-2 SG-3'
rec SD-1 A '"type":"Epic","branch":"feat/SD-1-lines"'; epicget SD-1; rec SD-2 A; rec SD-3 A
printf 'SD-3\n' > "$T/children/SD-1"
ungate; gate SD-2 claude.calls 'feature plan for epic SD-1'; gate claude admit.out '^triage: done SD-2 '
out=$(DESK_MEM_AVAIL_GB=64 admit SD-1 SD-2 --by ben); rc=$?; ungate
check "DS-507 AC2: a ticket's triage that ends while an epic's plan is drafted says so at once" '[ $rc -eq 0 ] && sed -n "/^triage: done SD-2 /,\$p" <<< "$out" | grep -q "^drafted SD-1"'
rec SJ-1 A '"epic":{"key":"SC-1","summary":"a feature"}'; rec SJ-2 A
gate SJ-2 admit.out '^triage: started SJ-1 in batch SC-1$'; gate SJ-1@SC-1 admit.out '^triage: done SJ-2 '
out=$(DESK_MEM_AVAIL_GB=64 admit SJ-1 SJ-2 --by ben); rc=$?; ungate
check "DS-507 AC2: a ticket's triage that ends while another joins a batch says so at once" \
  '[ $rc -eq 0 ] && grep -qx "triage: started SJ-1 in batch SC-1" <<< "$out" && [ "$(sed -n "/^triage: done SJ-2 /,\$p" <<< "$out" | grep -c "^triage: done SJ-1 ")" = 1 ] && grep -q "^admitted SJ-2 " <<< "$out"'
rec JS-1 A; pool 1; out=$(admit JS-1 --by ben --json)
check "DS-507 AC2: --json stays one object, holding the same lines" '[ "$(wc -l <<< "$out" | tr -d " ")" = 1 ] && [ "$(node -e "console.log(JSON.parse(process.argv[1]).lines.at(-1).replace(/ \(\d+s\)$/, \"\"))" "$out")" = "summary: 1 of 1 admitted" ]'
for k in DA DB DC DD; do rec "$k" A; done
pool TODO; out=$(DESK_MEM_AVAIL_GB=64 admit DA DB DC DD --by ben); rc=$?
check "DS-507 AC3: with Triage concurrency left TODO, one triage runs at a time" '[ $rc -eq 0 ] && [ "$(most)" = 1 ] && [ "$(grep -c "^triage: started D[ABCD] (1/4 running)$" <<< "$out")" = 4 ]'
check "DS-507 AC3: the template recommends 1" 'grep -q "^| Triage concurrency | \`1\` |" "$S/../desk-config.md"'
check "DS-507 AC1: the desk-admit skill starts more than 3 tickets in the background and waits for the notification" \
  'grep -q "^\*\*With more than 3 tickets, start the call in the background\*\* (\`run_in_background\`" "$SK" && grep -q "and wait for its notification" "$SK"'

# ---- push: a producer's ticket, admitted now (intake.mjs push) -----------------------------------
# DESK_SUPERVISOR_MJS is a fake that logs each tick push starts, except where a case runs the real tick:
# the copy in $T/bin, whose pass is the fake one (run-by.mjs is a link, so its default is the repo's own).
# DESK_PLATFORM names no supervisor backend, so push starts the tick itself rather than through launchd.
keyrow(){ printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Ticket key pattern | `[A-Z]+-[0-9]+` |\n' >> "$T/cfg/repos/acme__widgets/config.md"; }
printf "import { appendFileSync } from 'node:fs';\nappendFileSync('%s/wake.calls', 'tick\\\\n');\n" "$T" > "$T/fakes/supervisor.mjs"
push(){ (cd "$T/repo" && DESK_PLATFORM=none DESK_SUPERVISOR_MJS="${WAKE-$T/fakes/supervisor.mjs}" node "$T/bin/intake.mjs" push "$@" 2>&1); }
config yes; keyrow; running_batch; ungate
rec PU-1 A
out=$(WAKE="$T/bin/supervisor.mjs" push PU-1); rc=$?
check "push AC1: a clean lane A ticket is admitted into the batch, and the output names it" '[ $rc -eq 0 ] && [ "$(qget tickets.PU-1.state)" = triaged ] && grep -q "^intake: admitted PU-1 by push into batch b1 (lane A, size S)$" <<< "$out"'
check "push AC1: the register records it as admitted by push" '[ "$(jget "$T/state/intake.json" tickets.PU-1.outcome)" = admitted ] && [ "$(jget "$T/state/intake.json" tickets.PU-1.by)" = push ]'
for _ in $(seq 1 120); do grep -A1 "intake: admitted PU-1 by push" "$T/state/supervisor.log" 2>/dev/null | grep -q "^no change this pass$" && break; sleep 0.5; done
for _ in $(seq 1 40); do [ -e "$T/state/supervisor.lock" ] || break; sleep 0.25; done
check "push AC2: a supervisor tick starts at once, and its pass report lists the ticket" 'grep -q "started a supervisor tick now" <<< "$out" && grep -A1 "intake: admitted PU-1 by push into batch b1" "$T/state/supervisor.log" | grep -q "^no change this pass$" && [ ! -e "$T/state/intake.pushed" ]'
n=$(count "$T/triage.calls")
# PB-1, not PL-1: DS-506's case above admitted PL-1, so the register already holds it.
rec PC-1 C; rec PB-1 A '"lint":[{"severity":"blocking","rule":"ac","message":"no acceptance criteria"}]'; rec PQ-1 A '"unknowns":["which plan tier?"]'; rec PX-1 A '"size":"XL"'
for k in PC-1 PB-1 PQ-1 PX-1; do out=$(push "$k"); eval "rc_${k//-/_}=$?"; eval "out_${k//-/_}=\$out"; done
check "push AC3: a lane C ticket is not admitted, is handed to the digest as intake hands it, and push exits 11 with the reason" \
  '[ "$rc_PC_1" -eq 11 ] && [ "$(qget tickets.PC-1)" = undefined ] && [ "$(handed PC-1)" = "handed: lane C: needs a plan" ] && grep -q "handed PC-1 to the digest: lane C: needs a plan" <<< "$out_PC_1"'
check "push AC3: so are a blocking lint finding, open questions and size XL" \
  '[ "$rc_PB_1$rc_PQ_1$rc_PX_1" = 111111 ] && [ "$(handed PB-1)" = "handed: lint (blocking): no acceptance criteria" ] && [ "$(handed PQ-1)" = "handed: open question(s): which plan tier?" ] && [ "$(handed PX-1)" = "handed: size XL: it needs splitting before a worker takes it" ]'
check "push AC3: no tick is started for a ticket not admitted" '[ "$(count "$T/wake.calls")" = 0 ]'
n=$(count "$T/triage.calls")
out=$(push PU-1); rc=$?
check "push AC4: a ticket already in the queue changes nothing, says so, and exits 0" '[ $rc -eq 0 ] && grep -q "^intake: PU-1 is already in batch b1 (triaged): nothing changed$" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ]'
out=$(push PC-1); rc=$?
check "push AC4: a ticket already in the register changes nothing, says so, and exits 0" '[ $rc -eq 0 ] && grep -q "^intake: PC-1 is already in the intake register (handed: lane C: needs a plan): nothing changed$" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ]'
printf '{"version":1,"batch":"b0","supervised":false,"concurrency":2,"tickets":{"R":{"key":"R","state":"running"}}}\n' > "$DESK_QUEUE"
rec PU-6 A; out=$(push PU-6); rc=$?
check "push AC6: a batch not handed over admits nothing, and push exits 11 naming why, as intake reports it" '[ $rc -eq 11 ] && grep -q "^intake: admits nothing while batch b0 is not handed over" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ]'
printf '{"version":1,"batch":"b0","supervised":true,"base":"feat/x","concurrency":2,"tickets":{"R":{"key":"R","state":"running"}}}\n' > "$DESK_QUEUE"
out=$(push PU-6); rc=$?
check "push AC6: so does a batch on a base" '[ $rc -eq 11 ] && grep -q "^intake: admits nothing while batch b0 runs on base feat/x" <<< "$out" && [ "$(qget tickets.PU-6)" = undefined ]'
rm -f "$DESK_QUEUE"
rec PU-5 A; out=$(push PU-5); rc=$?
# The tick push starts is a detached process: its line in wake.calls may land after push returns.
for _ in $(seq 1 80); do [ "$(count "$T/wake.calls")" = 1 ] && break; sleep 0.25; done
check "push AC5: with no live batch, a standing batch is started for it as intake starts one" \
  '[ $rc -eq 0 ] && [[ "$(qget batch)" == standing-* ]] && [ "$(qget supervised)" = true ] && [ "$(qget tickets.PU-5.state)" = triaged ] && grep -q "^intake: started standing batch standing-.*, handed to the supervisor$" <<< "$out" && [ "$(count "$T/wake.calls")" = 1 ]'
running_batch
for perm in ask no; do
  config "$perm"; keyrow; rec PU-7 A; out=$(push PU-7); rc=$?
  check "push AC7: with autopilot-workers $perm, nothing is admitted and push names the row" '[ $rc -eq 11 ] && grep -q "needs config §3 autopilot-workers to be \"yes\" (it is \"$perm\")" <<< "$out" && [ "$(qget tickets.PU-7)" = undefined ]'
done
config yes; keyrow
j=$(count "$T/jira.calls"); n=$(count "$T/triage.calls")
out=$(push pu-8); rc=$?
check "push AC8: a key not matching the ticket key pattern is refused before any Jira call" '[ $rc -eq 11 ] && grep -q "does not match §4 Ticket key pattern" <<< "$out" && [ "$(count "$T/jira.calls")" = "$j" ] && [ "$(count "$T/triage.calls")" = "$n" ]'
# A push while standing intake triages the same ticket waits for intake's lock, then finds it admitted.
rec PU-9 A; search PU-9; gate PU-9 release '^PU-9$'
intake > "$T/intake9.out" & ipid=$!
for _ in $(seq 1 120); do grep -q "^start PU-9 " "$T/triage.events" 2>/dev/null && break; sleep 0.25; done
(DESK_PUSH_WAIT_MS=60000 push PU-9 > "$T/push9.out"; echo $? > "$T/push9.rc") & ppid=$!
for _ in $(seq 1 120); do grep -q "^intake: PU-9 waits for another intake to end" "$T/push9.out" 2>/dev/null && break; sleep 0.25; done
release PU-9; wait "$ipid" "$ppid"; ungate; out=$(cat "$T/push9.out")
check "push AC9: a push and an intake reaching one ticket triage and admit it once" \
  'grep -q "^intake: PU-9 waits for another intake to end (pid [0-9]*)$" <<< "$out" && [ "$(grep -cx PU-9 "$T/triage.calls")" = 1 ] && [ "$(qget tickets.PU-9.admitted_by)" = intake ] && [ "$(cat "$T/push9.rc")" = 0 ] && grep -q "^intake: PU-9 is already in batch b1 (triaged): nothing changed$" <<< "$out"'
SUP="$S/../skills/desk-autopilot/references/supervisor.md"
check "push AC10: the autopilot skill names push as the contract: the command, its exits and what a producer does first" \
  'grep -q "^#### Raising a ticket from an event: push$" "$SUP" && grep -q "intake.mjs push <KEY>" "$SUP" && grep -q "^| 10 | " "$SUP" && grep -q "^| 11 | " "$SUP" && grep -q "lint-clean" "$SUP" && grep -q "Raising a ticket from an event: push" "$S/../skills/desk-autopilot/SKILL.md"'

out=$(cat "$T/gate.timeouts" 2>/dev/null)
check "no triage gate timed out: each case ran in the order its gates set" '[ -z "$out" ]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
