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
for f in desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs batches.mjs decider.mjs handoff.mjs briefing.mjs queue.mjs desk-q-eta.mjs closeout.mjs installed.mjs run-by.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
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
printf "import { appendFileSync } from 'node:fs';\nappendFileSync('%s/digest.calls', 'checkin\\\\n');\nconsole.log(JSON.stringify({ status: 'not_due', push: null }));\n" "$T" > "$T/bin/digest.mjs"
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
# A finished batch is not live either: the next ticket starts a new one. A blocker in it is outside the
# new one, so a ticket it blocks is handed on rather than started.
printf '{"version":1,"batch":"old","supervised":true,"tickets":{"Z":{"key":"Z","state":"done","result":{"pr":null}}}}\n' > "$DESK_QUEUE"
rec A-7 A '"blockers":[{"key":"Z","category":"indeterminate"}]'
rec A-8 A; search A-8 A-7; out=$(intake)
check "AC2: a finished batch gets a new standing batch" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget tickets.A-8.state)" = triaged ] && [ "$(qget tickets.Z)" = undefined ]'
check "a blocker left in the finished batch hands its ticket on" '[ "$(qget tickets.A-7)" = undefined ] && grep -q "^handed: blocked by Z" <<< "$(handed A-7)"'
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

# ---- by hand: intake.mjs admit (/desk-admit) -----------------------------------------------------
admit(){ (cd "$T/repo" && node "$T/bin/intake.mjs" admit "$@" 2>&1); }
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
rec H-5 A '"blockers":[{"key":"H-4","category":"new"}]'; rec H-4 A
out=$(admit H-5 H-4 --front)
check "admit: a blocker named in the same call goes first, and the other is held behind it" '[ "$(qget tickets.H-4.state)" = triaged ] && [ "$(qget tickets.H-5.held_by)" = H-4 ]'
check "admit: --front moves each admitted ticket to the front" 'grep -q "H-4 moved to the front of the spawn order" <<< "$out" && [ "$(node -e "console.log(Object.keys(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).tickets)[0])" "$DESK_QUEUE")" = H-5 ]'
rec H-6 A '"type":"Epic"'
out=$(admit H-6); rc=$?
check "admit: an epic is refused toward a feature batch" '[ $rc -eq 11 ] && grep -q "not admitted H-6: an epic" <<< "$out"'
printf '{"version":1,"batch":"s1","supervised":false,"tickets":{"P":{"key":"P","state":"running"}}}\n' > "$DESK_QUEUE"
rec H-7 A; n=$(count "$T/triage.calls")
out=$(admit H-7); rc=$?
check "admit: a session-run batch is refused before any triage, pointing at that session" '[ $rc -eq 11 ] && [ "$(count "$T/triage.calls")" = "$n" ] && grep -q "is run by a session, not the supervisor: send these tickets to that session" <<< "$out"'
rm -f "$DESK_QUEUE"; config ask '`none`'
out=$(admit H-7); rc=$?
check "admit: with no batch and autopilot-workers not yes, it points at /desk-autopilot" '[ $rc -eq 11 ] && [ ! -f "$DESK_QUEUE" ] && grep -q "run /desk-autopilot H-7" <<< "$out"'
config yes '`none`'
out=$(admit H-7)
check "admit: with no batch and autopilot-workers yes, it starts a standing batch handed to the supervisor" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget supervised)" = true ] && [ "$(qget tickets.H-7.state)" = triaged ]'

# ---- two batches: a ticket is in one batch at most ----------------------------------------------
NB="$DESK_HOME/repos/acme__widgets/batches/X-1"; mkdir -p "$NB"
printf '{"version":1,"batch":"X-1","tickets":{"X-2":{"key":"X-2","state":"running"}}}\n' > "$NB/queue.json"
config yes; running_batch; rm -f "$T/state/intake.json"
rec X-2 A; rec X-3 A '"epic":{"key":"X-1","summary":"a feature"}'; rec X-4 A '"epic":{"key":"X-1","summary":"a feature"}'
n=$(count "$T/triage.calls")
search X-2; out=$(intake)
check "DS-307 AC2: a ticket in another batch is not triaged, admitted or handed on" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$(qget tickets.X-2)" = undefined ] && [ "$(handed X-2)" = none ]'
search X-3; out=$(intake)
check "DS-307 AC3: a new child of an epic with a live feature batch is not admitted" '[ "$(qget tickets.X-3)" = undefined ] && grep -q "^elsewhere: " <<< "$(handed X-3)"'
check "DS-307 AC3: the intake line names the feature batch" 'grep -q "intake: X-3 not admitted: X-3 is a child of epic X-1, whose feature batch X-1 is running" <<< "$out"'
n=$(count "$T/triage.calls"); out=$(intake)
check "DS-307 AC3: it is not triaged again while that batch is live" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$out" = "intake: nothing new" ]'
before=$(cat "$DESK_QUEUE")
out=$(admit X-4); rc=$?
check "DS-307 AC4: /desk-admit refuses a live epic's child, naming its feature batch" '[ $rc -eq 11 ] && grep -q "^not admitted X-4: X-4 is a child of epic X-1, whose feature batch X-1 is running" <<< "$out" && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
n=$(count "$T/triage.calls"); out=$(admit X-2); rc=$?
check "DS-307 AC4: /desk-admit refuses a ticket in another batch before any triage" '[ $rc -eq 11 ] && grep -q "^not admitted X-2: X-2 is in batch X-1" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ] && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
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

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
