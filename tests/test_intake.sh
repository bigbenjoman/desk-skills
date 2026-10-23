#!/usr/bin/env bash
# suite: intake (standing intake admits a query's tickets into the running batch)
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
  AUTOPILOT_DRY_RUN AUTOPILOT_BASE_PUSH_APPROVED AUTOPILOT_USER_APPROVED DESK_DIGEST_DIR
export DESK_CONFIG_ROOT="$T/cfg" DESK_REPO_OVERRIDE=acme/widgets DESK_HOME="$T/desk" \
  DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" DESK_SKILLS_DIR="$T/no-skills"
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

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Intake query | \`none\` | ${2-\`project = ACME AND labels = autopilot\`} |
EOF
}
config yes

# intake.mjs and the supervisor copied beside fakes, so each runs the fake triage.sh, pass and driver.
cp "$B/intake.mjs" "$B/supervisor.mjs" "$T/bin/"
for f in desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs decider.mjs handoff.mjs briefing.mjs queue.mjs desk-q-eta.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
# The search: whatever $T/search.json holds, or a failure while $T/search.fails exists.
cat > "$T/fakes/desk-jira" <<EOF
#!/bin/sh
echo "\$*" >> "$T/jira.calls"
[ -f "$T/search.fails" ] && { echo "desk-jira: HTTP 503 from Jira" >&2; exit 1; }
cat "$T/search.json"
EOF
# Triage: copies the set record for the ticket, or fails while $T/recs/<KEY>.fails exists.
cat > "$T/bin/triage.sh" <<EOF
#!/bin/sh
echo "\$1" >> "$T/triage.calls"
[ -f "$T/recs/\$1.fails" ] && { echo "triage: claude exited 1" >&2; exit 1; }
cp "$T/recs/\$1.json" "$T/state/triage/\$1.json"
EOF
cat > "$T/bin/pass.mjs" <<EOF
import { appendFileSync } from 'node:fs';
appendFileSync('$T/pass.calls', 'pass\\n');
console.log(JSON.stringify({ status: 'nothing_yet', code: 10, message: 'no change this pass', waiting: [], parked: [], notify: false, push: [] }));
process.exitCode = 10;
EOF
echo "console.log(JSON.stringify({ status: 'not_due', push: null }));" > "$T/bin/digest.mjs"
echo "console.log(JSON.stringify({ hold: false, lines: [] }));" > "$T/bin/maintenance.mjs"
printf '#!/bin/sh\necho "$@" >> "%s/driver.calls"\n' "$T" > "$T/bin/merge-driver.sh"
printf '#!/bin/sh\necho OPEN\n' > "$T/fakes/gh"
printf '#!/bin/sh\nexit 1\n' > "$T/fakes/launchctl"
printf '#!/bin/sh\nexit 0\n' > "$T/fakes/osascript"
chmod +x "$T/fakes/"* "$T/bin/triage.sh" "$T/bin/merge-driver.sh"
export PATH="$T/fakes:$PATH"

intake(){ (cd "$T/repo" && node "$T/bin/intake.mjs" run --force "$@" 2>&1); }
tick(){ (cd "$T/repo" && node "$T/bin/supervisor.mjs" tick --foreground 2>&1); }
search(){ printf '{"issues":[%s]}\n' "$(printf '{"key":"%s"},' "$@" | sed 's/,$//')" > "$T/search.json"; }
# rec <KEY> <lane> [extra json fields]
rec(){ printf '{"ticket":"%s","type":"Story","lane":"%s","lane_reason":"needs a plan","files_in_scope":["src/%s.js"],"unknowns":[],"size":"S","blockers":[],"lint":[]%s}\n' "$1" "$2" "$1" "${3:+,$3}" > "$T/recs/$1.json"; }
count(){ if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
qget(){ node -e 'const q=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],q); console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$DESK_QUEUE" "$1"; }
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
search $(i=0; while [ $i -lt 100 ]; do echo A-1; i=$((i + 1)); done); out=$(intake)
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
check "AC3: so does lane D" '[ "$(qget tickets.D-1)" = undefined ] && [ "$(handed D-1)" = "handed: lane D: needs a plan" ]'
check "AC4: a blocking lint finding is not admitted, and goes to the digest with the finding" '[ "$(qget tickets.L-1)" = undefined ] && [ "$(handed L-1)" = "handed: lint (blocking): no acceptance criteria" ]'
check "the report names each ticket handed on" 'grep -q "intake: handed C-1 to the digest: lane C: needs a plan" <<< "$out"'
search Q-1 X-1; out=$(intake)
check "AC5: open triage questions are not admitted, and go to the digest" '[ "$(qget tickets.Q-1)" = undefined ] && [ "$(handed Q-1)" = "handed: open question(s): which plan tier?" ]'
check "AC6: size XL is not admitted, and the digest item says it needs splitting" '[ "$(qget tickets.X-1)" = undefined ] && [ "$(handed X-1)" = "handed: size XL: it needs splitting before a worker takes it" ]'
n=$(count "$T/triage.calls")
echo '{"issues":[{"key":"E-1","fields":{"issuetype":{"name":"Epic","hierarchyLevel":1}}}]}' > "$T/search.json"; out=$(intake)
check "an epic is handed on untriaged: it keeps its feature-batch approvals" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$(qget tickets.E-1)" = undefined ] && [ "$(handed E-1)" = "handed: an epic: run it as a feature batch in a session" ]'
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
rec B-5 A '"blockers":[{"key":"OUT-9","category":"new"},{"key":"DONE-1","category":"done"}]'
search B-5; out=$(intake)
check "a blocker outside the batch that is not done goes to the digest" '[ "$(qget tickets.B-5)" = undefined ] && [ "$(handed B-5)" = "handed: blocked by OUT-9, which is not done and not in the batch: add it to the batch, or settle the link" ]'

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
i=0; while ! grep -q -- "--tickets A-9 --log" "$T/driver.calls" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
check "AC2: the merge driver picks it up" 'grep -q -- "--tickets A-9 --log" "$T/driver.calls"'
# A finished batch is not live either: the next ticket starts a new one.
printf '{"version":1,"batch":"old","supervised":true,"tickets":{"Z":{"key":"Z","state":"failed"}}}\n' > "$DESK_QUEUE"
rec A-8 A; search A-8; out=$(intake)
check "AC2: a finished batch gets a new standing batch" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget tickets.A-8.state)" = triaged ] && [ "$(qget tickets.Z)" = undefined ]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
