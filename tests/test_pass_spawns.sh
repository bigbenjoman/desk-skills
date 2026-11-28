#!/usr/bin/env bash
# suite: pass: spawns (memory, branches, other batches, cloud workers, busy worktrees, recoveries, links, collisions, screenshot uploads)
# layer: L3
# budget: 205 DS-943 (136 whole pass.mjs runs, each about 1.3 CPU s with its queue.mjs children; 155-169 s on CI at 124 runs)
# pass.mjs deciding what starts: the memory ladder, a branch with a placeholder left in, --batch,
# cloud workers, a state=running write the queue refuses, a kept worktree in use, routine recoveries,
# read-only repo clones, issue links, post-merge steps, fix tries on a moved head, and per-file
# collision budgets and conflicts; and a draft's screenshots: capture tries and uploads. Runs the real
# pass.mjs, queue.mjs, harvest.mjs, batch-state.mjs, briefing.mjs, ticket-facts.mjs and answer.mjs with
# stub claude, gh, desk-jira, upload-images, setup-worktree and spawn-worker (tests/pass_setup.sh).
# Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
# shellcheck source=pass_setup.sh
. "$(dirname "$0")/pass_setup.sh"
pick_up

# ---- DS-271: no CI runner shares the memory ladder
# A waiting marker an older desk left behind holds nothing, and the pass writes none of its own.
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue-mt.json" DESK_AUTOPILOT_STATE="$T/state-mt"
mkdir -p "$T/state-mt/logs"; MT="$DESK_HOME/memory-turns"; mkdir -p "$MT"
q init mt; q set-batch concurrency=2
q add M-1; q set M-1 state=running branch=fix/M-1 session_id=live-1
q add M-2; q set M-2 state=triaged
printf '{"side":"ci","since":%s,"at":%s,"why":"12.0G available","pid":%s}\n' "$(( ($(date +%s) - 300) * 1000 ))" "$(( ($(date +%s) - 60) * 1000 ))" "$$" > "$MT/ci.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-271 AC3 an old CI waiting marker holds nothing: the worker spawns" '[ "$(field M-2 state)" = "\"running\"" ] && ! echo "$out" | grep -q "CI is waiting"'
check "DS-271 AC3 the memory line has no runner segment" 'echo "$out" | grep -qE "memory: vmmem=[0-9.]+G avail=[0-9.]+G$"'
q add M-3; q set M-3 state=triaged; q set-batch concurrency=3
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-271 AC3 held for memory, the pass writes no waiting marker" '[ "$(field M-3 state)" = "\"triaged\"" ] && [ "$(ls "$MT")" = ci.json ]'

# ---- DS-346: a queued branch with a convention placeholder left in, and no worktree yet, is
# rebuilt from the key and the triage summary before the worktree is set up. A kept worktree's is not.
export DESK_QUEUE="$T/queue-br.json" DESK_AUTOPILOT_STATE="$T/state-br"
mkdir -p "$T/state-br/logs" "$T/state-br/triage" "$T/wt/B-2"
q init br; q set-batch concurrency=3
q add B-1; q set B-1 state=triaged 'branch=fix/B-1-<slug>'
printf '{"ticket":"B-1","summary":"Triage keeps the <slug> placeholder in"}' > "$T/state-br/triage/B-1.json"
q add B-2; q set B-2 state=triaged 'branch=fix/B-2-<slug>'
q add B-3; q set B-3 state=triaged branch=fix/B-3-already-fine
out=$(node "$B/pass.mjs" 2>&1)
check "DS-346 AC3 the placeholder branch is rebuilt from key and summary, and the worker spawns on it" \
  '[ "$(field B-1 branch)" = "\"fix/B-1-triage-keeps-the-slug-placeholder-in\"" ] && [ "$(field B-1 state)" = "\"running\"" ] && echo "$out" | grep -qF "branch fix/B-1-<slug> was unusable"'
check "DS-346 AC3 a ticket whose worktree is kept keeps its branch" '[ "$(field B-2 branch)" = "\"fix/B-2-<slug>\"" ]'
check "DS-346 AC3 a usable branch is left as it is" '[ "$(field B-3 branch)" = "\"fix/B-3-already-fine\"" ]'
# The convention's other placeholder, <kebab-slug>, is rebuilt the same way, keeping its prefix.
export DESK_QUEUE="$T/queue-kb.json" DESK_AUTOPILOT_STATE="$T/state-kb"
mkdir -p "$T/state-kb/logs" "$T/state-kb/triage"
q init kb; q set-batch concurrency=3
q add B-4; q set B-4 state=triaged 'branch=feat/B-4-<kebab-slug>'
printf '{"ticket":"B-4","summary":"Branch keeps the <kebab-slug> placeholder"}' > "$T/state-kb/triage/B-4.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-177 AC1 a <kebab-slug> branch is rebuilt from the title, keeping its prefix, with no < or >" \
  '[ "$(field B-4 branch)" = "\"feat/B-4-branch-keeps-the-kebab-slug-placeholder\"" ] && [ "$(field B-4 state)" = "\"running\"" ] && echo "$out" | grep -qF "branch feat/B-4-<kebab-slug> was unusable"'

# ---- #1361: a ticket that renders, with an app to run and §4 Test sign-in unset, is asked for the row
# at spawn, not after its PR opens; with the row set it spawns.
export DESK_QUEUE="$T/queue-sg.json" DESK_AUTOPILOT_STATE="$T/state-sg" DESK_CONFIG="$T/config-sg.md"
cp "$T/config.md" "$DESK_CONFIG"; mkdir -p "$T/state-sg/logs" "$T/state-sg/triage"
printf '\n## 4. Checks\n| Field | Value |\n|---|---|\n| Dev server | `npm run dev` |\n' >> "$DESK_CONFIG"
q init sg; q set-batch concurrency=3
q add SG-1; q set SG-1 state=triaged branch=feat/SG-1 lane=A
printf '{"ticket":"SG-1","summary":"A new page","renders":true}' > "$T/state-sg/triage/SG-1.json"
q add SG-2; q set SG-2 state=triaged branch=fix/SG-2
printf '{"ticket":"SG-2","summary":"A query fix","renders":false}' > "$T/state-sg/triage/SG-2.json"
out=$(node "$B/pass.mjs" 2>&1)
check "#1361 a ticket that renders is parked at spawn on the unset Test sign-in row, with no worker" \
  '[ "$(field SG-1 state)" = "\"parked\"" ] && [ "$(field SG-1 session_id)" = null ] && jq -r ".tickets[\"SG-1\"].park.question" "$DESK_QUEUE" | grep -q "^NEEDS ROW — SG-1 renders, .* §4 Test sign-in is unset, so no worker was spawned" && [ "$(jq -r ".tickets[\"SG-1\"].park.kind" "$DESK_QUEUE")" = question ]'
check "#1361 one that renders nothing spawns" '[ "$(field SG-2 state)" = "\"running\"" ]'
printf '| Test sign-in | `dev-user@example.test` |\n' >> "$DESK_CONFIG"
q requeue SG-1 >/dev/null 2>&1
out=$(node "$B/pass.mjs" 2>&1)
check "#1361 with the row set, it spawns" '[ "$(field SG-1 state)" = "\"running\"" ]'
# #1363: with a user the repo's seed files create, desk sets the row itself, logs it, and the ticket spawns.
cp "$T/config.md" "$DESK_CONFIG"; printf '\n## 4. Checks\n| Field | Value |\n|---|---|\n| Dev server | `npm run dev` |\n' >> "$DESK_CONFIG"
mkdir -p "$T/repo/prisma"; printf "await db.user.create({ data: { email: 'maya.dev@acme.test' } });\n" > "$T/repo/prisma/seed.ts"
q add SG-3; q set SG-3 state=triaged branch=feat/SG-3 lane=A
printf '{"ticket":"SG-3","summary":"Another page","renders":true}' > "$T/state-sg/triage/SG-3.json"
out=$(node "$B/pass.mjs" 2>&1)
rm -rf "$T/repo/prisma"
check "#1363 a seeded user is taken for Test sign-in at spawn: the row is written noted as desk's, and the ticket spawns" \
  '[ "$(field SG-3 state)" = "\"running\"" ] && grep -qF "| Test sign-in | \`maya.dev@acme.test\` (set by desk: a development user prisma/seed.ts creates;" "$DESK_CONFIG" && echo "$out" | grep -qF "SG-3: desk set config §4 \"Test sign-in\" = maya.dev@acme.test"'
check "#1363 and it is a taken decision for the check-in digest" 'jq -e "select(.chose == \"maya.dev@acme.test\" and .ticket == \"config\")" "$T/state-sg/decisions.jsonl" >/dev/null'
# A decision log that cannot be written is said, not claimed to be in the digest.
cp "$T/config.md" "$DESK_CONFIG"; printf '\n## 4. Checks\n| Field | Value |\n|---|---|\n| Dev server | `npm run dev` |\n' >> "$DESK_CONFIG"
mkdir -p "$T/repo/prisma"; printf "await db.user.create({ data: { email: 'omar.dev@acme.test' } });\n" > "$T/repo/prisma/seed.ts"
chmod a-w "$T/state-sg/decisions.jsonl"
for k in SG-1 SG-2 SG-3; do q set "$k" state=done; done; q add SG-4; q set SG-4 state=triaged branch=feat/SG-4 lane=A
printf '{"ticket":"SG-4","summary":"A third page","renders":true}' > "$T/state-sg/triage/SG-4.json"
out=$(node "$B/pass.mjs" 2>&1)
rm -rf "$T/repo/prisma"; chmod u+w "$T/state-sg/decisions.jsonl"
check "#1363 with the decision log unwritable, the line says the digest does not list it, and the ticket still spawns" \
  '[ "$(field SG-4 state)" = "\"running\"" ] && echo "$out" | grep -q "SG-4: desk set config §4 \"Test sign-in\" = omar.dev@acme.test .*the decision log could not be written (.*), so the check-in digest does not list it" && ! echo "$out" | grep -q "SG-4: .*; in the check-in digest$"'
export DESK_CONFIG="$T/config.md"

# ---- pass.mjs --batch X-1, with no queue or state exported, works X-1's queue, and the
# worktree setup and the worker it starts resolve X-1's queue and state too.
unset DESK_QUEUE DESK_AUTOPILOT_STATE DESK_BATCH
export DESK_REPO_OVERRIDE=acme/widgets
X1Q="$DESK_HOME/repos/acme__widgets/batches/X-1/queue.json"; X1S="$HOME/.desk-autopilot/acme__widgets/batches/X-1"
STQ="$DESK_HOME/repos/acme__widgets/queue.json"
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
node "$B/desk-env.mjs" paths | grep -E '^DESK_(QUEUE|STATE)=' > "$T/x1-setup"
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] steps=config:1,checkout:2,install:41"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else node "$B/desk-env.mjs" paths | grep -E '^DESK_(QUEUE|STATE)=' > "$T/x1-spawn"; echo "[spawn] ticket=\$1"; fi
EOF
q --batch X-1 init x1; q --batch X-1 add X-9; q --batch X-1 set X-9 state=triaged
# X-11's worktree is left from a setup that did not finish: setup-worktree.sh completes it, install included.
mkdir -p "$T/wt/X-11"; : > "$T/wt/X-11/.desk-setup-incomplete"; q --batch X-1 add X-11; q --batch X-1 set X-11 state=triaged
out=$(node "$B/pass.mjs" --batch X-1 2>&1)
x1field(){ DESK_QUEUE="$X1Q" field "$@"; }
want="DESK_STATE='$X1S'
DESK_QUEUE='$X1Q'"
check "DS-303 AC3 pass.mjs --batch X-1 spawns X-1's ticket" '[ "$(x1field X-9 state)" = "\"running\"" ] && [ ! -f "$STQ" ]'
check "DS-303 AC3 the worktree setup it starts acts on X-1" '[ "$(cat "$T/x1-setup" 2>/dev/null)" = "$want" ]'
check "DS-303 AC3 the worker it starts acts on X-1" '[ "$(cat "$T/x1-spawn" 2>/dev/null)" = "$want" ]'
check "DS-303 AC3 the pass keeps its own state in X-1's folder" '[ -d "$X1S/logs" ]'
check "DS-698 AC1 the pass's metrics line carries each setup step's duration for the ticket it spawned" \
  'tail -n 1 "$X1S/passes.jsonl" | jq -e ".setup | map(select(.key == \"X-9\")) == [{\"key\":\"X-9\",\"kept\":false,\"steps\":{\"config\":1,\"checkout\":2,\"install\":41}}]" >/dev/null'
check "DS-698 a worktree resumed from an unfinished setup is timed as a new one, not a kept one" \
  'tail -n 1 "$X1S/passes.jsonl" | jq -e ".setup | map(select(.key == \"X-11\")) | .[0].kept == false" >/dev/null'
# X-11 was only here to be timed: its running worker would hold one of the repo's worker slots from every test below.
q --batch X-1 set X-11 state=done session_id=null

# ---- DS-124: cloud workers
# A ticket plan-batch placed in the cloud starts as one `claude --cloud` session, run through script
# since the pass has no terminal, is done once GitHub shows its PR, and parks when the start fails.
# The stub claude answers --cloud with the recorded output (tests/fixtures/cloud/).
export DESK_QUEUE="$T/queue-cl.json" DESK_AUTOPILOT_STATE="$T/state-cl"
mkdir -p "$T/state-cl/logs" "$T/state-cl/tickets"
cat > "$T/stub/claude" <<EOF
#!/bin/sh
[ "\$1" = auth ] && { printf '{"loggedIn":true,"email":"%s@example.com"}\n' "\$(basename "\${CLAUDE_CONFIG_DIR:-default}")"; exit 0; }
if [ "\$1" = --cloud ]; then
  printf '%s' "\$2" > "$T/cloud-prompt"
  printf '%s|%s\n' "\$3" "\$4" > "$T/cloud-name"
  printf '%s' "\${CLAUDE_CONFIG_DIR-unset}" > "$T/cloud-login"
  [ -e "$T/cloud-fail" ] && { cat "$S/fixtures/cloud/print-refused.txt" >&2; exit 1; }
  # This test script holds the queue lock from the session's start, so the pass's writes after it are refused.
  if [ -e "$T/lock-after-cloud" ]; then mkdir "\$DESK_QUEUE.lock"; echo $$ > "\$DESK_QUEUE.lock/pid"; fi
  cat "$S/fixtures/cloud/created.txt"; exit 0
fi
# A follow-up to a session: recorded, and answered as the CLI queues one.
if [ "\$1" = -p ] && [ "\$3" = --cloud ]; then
  printf '%s|%s|%s\n' "\$4" "\$5" "\$6" >> "$T/cloud-sent"
  printf '%s\n' "\$2" >> "$T/cloud-sent-msg"
  printf '%s' "\${CLAUDE_CONFIG_DIR-unset}" > "$T/cloud-send-login"
  [ -e "$T/cloud-send-fail" ] && { cat "$S/fixtures/cloud/stream-json-refused.txt" >&2; exit 1; }
  cat "$S/fixtures/cloud/send-json.json"; exit 0
fi
echo '[{"sessionId": "live-1"}]'
EOF
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
[ "\$1 \$2" = "pr list" ] && [ -e "$T/cloud-prs.json" ] && cat "$T/cloud-prs.json"
[ "\$1" = api ] && [ -e "$T/cloud-push" ] && case "\$2" in */branches/*) cat "$T/cloud-push" ;; esac
# A cloud PR's commits, body and comments: none of them, unless a test writes its own.
case "\$*" in "pr view "*body,commits,comments*) if [ -e "$T/cloud-view.json" ]; then cat "$T/cloud-view.json"; else echo '{"body":"","commits":[],"comments":[]}'; fi ;; esac
# issue-1552: the PR a fix try was sent for, read for its state and head.
case "\$*" in "pr view "*"--json number,state,headRefOid"*) [ -e "$T/cloud-fixpr.json" ] && cat "$T/cloud-fixpr.json" ;; esac
# Its head read just before a fix try goes out to a cloud session: "x", unless a test writes its own.
case "\$*" in "pr view "*"--json headRefOid") if [ -e "$T/cloud-head.json" ]; then cat "$T/cloud-head.json"; else echo '{"headRefOid":"x"}'; fi ;; esac
# Its body and comments read again just before they are edited: as first read, unless a test changes them.
case "\$*" in "pr view "*"--json body,comments") if [ -e "$T/cloud-live.json" ]; then cat "$T/cloud-live.json"; elif [ -e "$T/cloud-view.json" ]; then cat "$T/cloud-view.json"; fi ;; esac
exit 0
EOF
chmod +x "$T/stub/claude" "$T/stub/gh"
cloud_ticket(){ q add "$1"; q set "$1" state=triaged lane=A "branch=feat/$1" location=cloud
  printf '# %s\n\nSource: the user, in this conversation\n\nMake the widget save. AC1: it saves.\n' "$1" > "$T/state-cl/tickets/$1.md"; }
q init cl; q set-batch concurrency=2
# issue-1642: a login that has not trusted the checkout parks before any start, naming the folder-trust
# dialog and the command to answer it from the checkout; once trusted, the start goes ahead.
CL_MAIN=$(node --input-type=module -e "import { repoRoot } from '$B/desk-env.mjs'; console.log(repoRoot())")
printf '{"projects":{"/elsewhere":{"hasTrustDialogAccepted":true}}}' > "$HOME/.claude.json"
cloud_ticket CW-0
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1642 AC2 an untrusted checkout parks before the start, naming the trust dialog and the checkout" '[ "$(field CW-0 state)" = "\"parked\"" ] && [ ! -e "$T/cloud-prompt" ] && field CW-0 park.question | grep -F "would wait on the folder-trust dialog" | grep -F "from the checkout: cd $CL_MAIN && claude, then choose" | grep -qF "Yes, I trust this folder"'
check "issue-1642 AC2 the check writes nothing to the login .claude.json" '[ "$(cat "$HOME/.claude.json")" = "{\"projects\":{\"/elsewhere\":{\"hasTrustDialogAccepted\":true}}}" ]'
q set CW-0 state=done
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ projects: { [process.argv[2]]: { hasTrustDialogAccepted: true } } }))' "$HOME/.claude.json" "$CL_MAIN"
cloud_ticket CW-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC2 a cloud ticket starts as a cloud session, recorded running" '[ "$(field CW-1 state)" = "\"running\"" ] && [ "$(field CW-1 cloud.session)" = "\"session_01Vy49H7Z4T3CSgAhSxsuhqj\"" ]'
check "the cloud session is named <repo>-ticket-<KEY>, and the name is kept with it" '[ "$(cat "$T/cloud-name")" = "--name|widgets-ticket-CW-1" ] && [ "$(field CW-1 cloud.name)" = "\"widgets-ticket-CW-1\"" ]'
check "DS-124 AC2 its prompt carries the ticket's text and its branch" 'grep -q "AC1: it saves" "$T/cloud-prompt" && grep -q "feat/CW-1" "$T/cloud-prompt"'
check "DS-124 AC2 no worktree or local worker is made for it" '[ ! -e "$T/wt/CW-1" ] && [ "$(field CW-1 session_id)" = null ] && echo "$out" | grep -q "CW-1 in a cloud session on login [a-z]*: https://claude.ai/code/"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC2 with no PR yet it stays running, and the pass says so" '[ "$(field CW-1 state)" = "\"running\"" ] && echo "$out" | grep -q "CW-1: cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj.from=cli&m=0, no PR yet"'
# issue-1553 AC2: a session with no PR and no push past its start plus its ETA (its saved first
# estimate's 3h span) plus half that is reported possibly stuck, with its session URL; a push inside the margin keeps it quiet.
cl_was=$(field CW-1 cloud)
q set CW-1 "cloud=$(node -e 'const c = JSON.parse(process.argv[1]); c.started = new Date(Date.now() - 6 * 3600e3).toISOString(); console.log(JSON.stringify(c))' "$cl_was")"
node -e 'const h = 3600e3, n = Date.now(), i = (t) => new Date(t).toISOString(); console.log(JSON.stringify({ key: "CW-1", at: i(n - 6 * h), starts: i(n - 6 * h), ships: i(n - 3 * h), could_run_to: i(n - 2 * h), model: 2 }))' > "$T/state-cl/eta.jsonl"
out=$(node "$B/pass.mjs" 2>&1)
# issue-1553 comment 1: an errored session looks as quiet as a stuck one, so it is sent one retry follow-up before it is flagged.
check "issue-1553 a quiet or errored session past its ETA is sent one retry follow-up, not flagged yet" 'echo "$out" | grep -F "CW-1: cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj" | grep -qF "sent it one retry follow-up, in case it stopped on an error" && ! echo "$out" | grep -q "CW-1: .*possibly stuck" && [ "$(cat "$T/cloud-sent")" = "session_01Vy49H7Z4T3CSgAhSxsuhqj|--output-format|json" ] && [ "$(field CW-1 cloud.retried_at)" != null ]'
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1553 within the margin of its retry it is sent no second one, nor flagged" '[ "$(wc -l < "$T/cloud-sent")" -eq 1 ] && ! echo "$out" | grep -q "CW-1: .*possibly stuck"'
q set CW-1 "cloud=$(node -e 'const c = JSON.parse(process.argv[1]); c.retried_at = new Date(Date.now() - 2 * 3600e3).toISOString(); console.log(JSON.stringify(c))' "$(field CW-1 cloud)")"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1553 AC2 no push past its ETA plus margin, nor since its retry: reported possibly stuck, with its session URL" 'echo "$out" | grep -F "CW-1: cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj" | grep -F "possibly stuck (quiet, or stopped on an error)" | grep -F "nothing pushed to feat/CW-1, past its ETA of " | grep -F " from its start (its saved estimate) plus " | grep -qF "nothing since the one retry follow-up sent at " && [ "$(wc -l < "$T/cloud-sent")" -eq 1 ] && [ "$(field CW-1 state)" = "\"running\"" ]'
check "issue-1553 the stuck line says to stop it before the requeue" 'echo "$out" | grep "CW-1: .*possibly stuck" | grep -qF "queue.mjs stop CW-1 (records the session abandoned), then queue.mjs requeue CW-1"'
node -e 'console.log(new Date(Date.now() - 30 * 60e3).toISOString())' > "$T/cloud-push"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1553 AC2 a push to its branch inside the margin keeps it from possibly stuck" '! echo "$out" | grep -q "CW-1: .*possibly stuck" && echo "$out" | grep -q "CW-1: cloud session .*, no PR yet"'
rm -f "$T/cloud-push"; : > "$T/cloud-send-fail"; q set CW-1 "cloud=$(node -e 'const c = JSON.parse(process.argv[1]); delete c.retried_at; console.log(JSON.stringify(c))' "$(field CW-1 cloud)")"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1553 a retry follow-up that cannot be sent flags it at once, with why" 'echo "$out" | grep "CW-1: .*possibly stuck" | grep -qF "its retry follow-up could not be sent (Error: --cloud <session_id> does not support" && [ "$(field CW-1 cloud.retried_at)" = null ]'
rm -f "$T/cloud-send-fail" "$T/cloud-sent" "$T/state-cl/eta.jsonl"; q set CW-1 "cloud=$cl_was"
# The session opens its PR 40 minutes after it started, on a branch of its own.
node -e 'const s = Date.parse(JSON.parse(process.argv[1])); console.log(JSON.stringify([{ number: 31, title: "feat(w): CW-1 save", url: "u", headRefName: "claude/cw-1-abc", createdAt: new Date(s + 2400e3).toISOString() }]))' "$(field CW-1 cloud.started)" > "$T/cloud-prs.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC2 its PR is its result, on the PR's own branch" '[ "$(field CW-1 state)" = "\"done\"" ] && [ "$(field CW-1 result.pr)" = 31 ] && [ "$(field CW-1 branch)" = "\"claude/cw-1-abc\"" ]'
check "DS-124 AC2 the pass gives its session URL and its wall time to the PR" 'echo "$out" | grep -q "CW-1: review read from the PR: .*; PR #31 from cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj.from=cli&m=0 in 40m 00s"'
check "its tracker steps are the pass's to make, and with no tracker there are none" 'echo "$out" | grep -F "CW-1: review read from the PR: " | grep -qF "; PR #31 from cloud session" &&echo "$out" | grep -qF "its tracker steps are made by the pass" && [ "$(field CW-1 tracker_steps)" = "\"none\"" ]'
all_done; out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC2 issue-1553 AC1 the batch report shows its cost as cost unknown (cloud), never \$0" 'echo "$out" | grep -E "^  CW-1 " | grep -qF "cost unknown (cloud)" && ! echo "$out" | grep -E "^  CW-1 " | grep -q "\$0\.00" && echo "$out" | grep -q "cloud session: https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj"'
cloud_ticket CW-2; : > "$T/cloud-fail"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-124 AC4 a cloud worker that fails to start parks with the error" '[ "$(field CW-2 state)" = "\"parked\"" ] && field CW-2 park.question | grep -q "cloud worker did not start — Error: --cloud cannot be combined with --print."'
check "DS-124 AC4 and is not run locally" '[ ! -e "$T/wt/CW-2" ] && ! echo "$out" | grep -q "CW-2 port="'
check "DS-752 a cloud start that fails keeps no start time for a session that never began" '[ "$(field CW-2 cloud)" = null ]'
# issue-1552: requeued for a fix try on the PR its session opened. The try is sent to that session as a
# follow-up, and the ticket runs in the cloud until the PR's head moves past the one the try was made for.
rm -f "$T/cloud-fail" "$T/cloud-prompt" "$T/cloud-sent" "$T/cloud-sent-msg" "$T/cloud-fixpr.json"; cloud_ticket CW-3
# Its head is "x", the head pass_setup.sh's stub gives a fix try's last read before it starts.
cw3_fix='fix={"try":1,"of":2,"pr":40,"kind":"checks","what":"red: Lint","head":"x","checks":[{"name":"Lint","runId":"7"}]}'
cw3_cloud='cloud={"session":"session_01Vy49H7Z4T3CSgAhSxsuhqj","url":"https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj","pr_at":"2026-11-20T10:00:00Z"}'
q set CW-3 result.pr=40 "$cw3_fix" "$cw3_cloud"
# Its head unreadable: nothing is sent, since a push is told from it, and the ticket stays queued.
echo '{}' > "$T/cloud-head.json"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1552 AC3 with the PR's head unreadable the try is not sent, and the ticket stays queued" '[ ! -e "$T/cloud-sent" ] && [ "$(field CW-3 state)" = "\"triaged\"" ] && [ "$(field CW-3 cloud.fix)" = null ] && echo "$out" | grep -qF "CW-3: its fix try 1 of 2 was not sent to cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj, since PR #40'"'"'s head could not be read (no head in its reply)"'
# A push lands after the try's last read and before the send: the send is told from the head read just
# before it, "y", so that push is not taken for the session's.
echo '{"headRefOid":"y"}' > "$T/cloud-head.json"
out=$(node "$B/pass.mjs" 2>&1)
rm -f "$T/cloud-head.json"
check "issue-1552 AC1 a cloud ticket back for a fix try on its PR has the try sent to its session" '[ "$(cut -d"|" -f1 "$T/cloud-sent")" = "session_01Vy49H7Z4T3CSgAhSxsuhqj" ] && grep -qF "desk has a fix try for PR #40" "$T/cloud-sent-msg" && grep -qF "Lint" "$T/cloud-sent-msg"'
check "issue-1552 AC1 the send is recorded: running at stage cloud, the try out to the session at the head read as it was sent, not the drafted one" '[ "$(field CW-3 state)" = "\"running\"" ] && [ "$(field CW-3 stage)" = "\"cloud\"" ] && [ "$(field CW-3 cloud.fix.try)" = 1 ] && [ "$(field CW-3 cloud.fix.head)" = "\"y\"" ] && echo "$out" | grep -qF "CW-3: fix try 1 of 2 on PR #40 sent to its cloud session"'
check "issue-1552 AC1 no local worker and no new cloud session start for it" '[ ! -e "$T/cloud-prompt" ] && [ ! -e "$T/wt/CW-3" ] && ! echo "$out" | grep -q "CW-3 port="'
echo '{"number":40,"state":"OPEN","headRefOid":"y","headRefName":"feat/CW-3","title":"feat: CW-3","url":"u","createdAt":"2026-11-20T10:00:00Z"}' > "$T/cloud-fixpr.json"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1552 AC3 with the head unmoved the next pass waits on the session" '[ "$(field CW-3 state)" = "\"running\"" ] && echo "$out" | grep -qF "CW-3: its fix try 1 of 2 is out to cloud session" && echo "$out" | grep -qF "no push to PR #40 yet" && [ "$(wc -l < "$T/cloud-sent")" -eq 1 ]'
echo '{"number":40,"state":"OPEN","headRefOid":"bbbb2222","headRefName":"feat/CW-3","title":"feat: CW-3","url":"u","createdAt":"2026-11-20T10:00:00Z"}' > "$T/cloud-fixpr.json"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1552 AC3 once its push lands the pass reads the new head and the ticket is done on its PR again" '[ "$(field CW-3 state)" = "\"done\"" ] && [ "$(field CW-3 result.pr)" = 40 ] && field CW-3 result.summary | grep -qF "pushed its fix try 1 of 2" && [ "$(field CW-3 cloud.fix)" = null ] && [ "$(field CW-3 cloud.pr_at)" = "\"2026-11-20T10:00:00Z\"" ]'
check "issue-1552 AC4 the try is the one it was, of the same count" '[ "$(field CW-3 fix.try)" = 1 ] && [ "$(field CW-3 fix.of)" = 2 ]'
# A send that fails: the session is recorded abandoned and the ticket stays queued, and the next pass
# starts the try in a new cloud session on the PR's branch.
rm -f "$T/cloud-sent" "$T/cloud-sent-msg" "$T/cloud-fixpr.json"; : > "$T/cloud-send-fail"
q set CW-3 state=triaged stage=null result.pr=40 "$cw3_fix" "$cw3_cloud"
# The archive list cannot be read as the send fails, so the session is not put on it yet.
echo 'not json' > "$T/state-cl/cloud-archived.json"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1552 AC2 a send that fails records the session abandoned and keeps the ticket queued" '[ "$(field CW-3 state)" = "\"triaged\"" ] && [ "$(field CW-3 cloud.abandoned_at)" != null ] && [ "$(field CW-3 cloud.fix)" = null ] && field CW-3 cloud.send_error | grep -q "does not support" && echo "$out" | grep -qF "CW-3: its fix try 1 of 2 on PR #40 could not be sent to its cloud session"'
check "issue-1552 comment AC an archive list that cannot be read is named, not taken for the session being on it" 'echo "$out" | grep -F "CW-3: its fix try 1 of 2 on PR #40 could not be sent" | grep -qF "could not be put on needs-you'"'"'s archive list"'
rm -f "$T/cloud-send-fail" "$T/cloud-sent" "$T/state-cl/cloud-archived.json"
# Comment AC: the old session may still push, so the new one waits, taking no slot, for it to be archived;
# the wait puts the session on needs-you's archive list, which the failed hand-over left it off.
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1552 comment AC a new session for the try waits until the abandoned one is archived" '[ "$(field CW-3 state)" = "\"triaged\"" ] && [ ! -e "$T/cloud-prompt" ] && echo "$out" | grep -F "CW-3: its fix try on PR #40 writes to the PR" | grep -qF "cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj may still push to: its cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj is recorded abandoned, and needs-you asks you to archive it. It starts once that session is archived"'
check "issue-1552 comment AC the waiting pass puts the abandoned session on needs-you's archive list once it can" 'jq -e ".pending | map(.session) == [\"session_01Vy49H7Z4T3CSgAhSxsuhqj\"]" "$T/state-cl/cloud-archived.json" >/dev/null'
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1552 comment AC a later waiting pass lists it once, not again" 'jq -e ".pending | length == 1" "$T/state-cl/cloud-archived.json" >/dev/null && [ "$(field CW-3 state)" = "\"triaged\"" ]'
echo '{"sessions":["session_01Vy49H7Z4T3CSgAhSxsuhqj"]}' > "$T/state-cl/cloud-archived.json"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1552 AC2 once archived, the next pass starts the try in a new cloud session on the PR's branch" '[ "$(field CW-3 state)" = "\"running\"" ] && grep -qF "Work a fix try on PR #40 of ticket CW-3" "$T/cloud-prompt" && grep -qF "feat/CW-3" "$T/cloud-prompt" && [ "$(field CW-3 cloud.fix.pr)" = 40 ] && [ "$(field CW-3 cloud.pr_at)" = "\"2026-11-20T10:00:00Z\"" ] && [ "$(field CW-3 cloud.abandoned_at)" = null ] && [ ! -e "$T/cloud-sent" ]'
q set CW-3 state=done; rm -f "$T/cloud-prompt"
# DS-450: a ticket placed in the cloud before the effort lever went on. Nothing gives a cloud session
# an effort, so it parks rather than run at the session default, and a malformed row names its value.
# Placed before pins too, so the pass reads the row for it.
effort_cfg(){ { cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `effort` |\n| Worker effort | `none` | `%s` |\n' "$1"; } > "$T/config-ef.md"; }
effort_cfg 0=low; cloud_ticket CW-4; q set CW-4 levers=null
out=$(DESK_CONFIG="$T/config-ef.md" node "$B/pass.mjs" 2>&1)
check "DS-450 AC1 with the effort lever on, a cloud ticket parks and says why" '[ "$(field CW-4 state)" = "\"parked\"" ] && field CW-4 park.question | grep -q "the effort lever is on, and a cloud session cannot be given an effort"'
check "DS-450 AC1 and no session starts for it, here or in the cloud" '[ ! -e "$T/cloud-prompt" ] && [ ! -e "$T/wt/CW-4" ] && ! echo "$out" | grep -q "CW-4 port="'
effort_cfg 0=turbo; cloud_ticket CW-5; q set CW-5 levers=null
out=$(DESK_CONFIG="$T/config-ef.md" node "$B/pass.mjs" 2>&1)
check "DS-450 AC4 a malformed Worker effort row refuses a cloud start, naming the value" '[ "$(field CW-5 state)" = "\"parked\"" ] && field CW-5 park.question | grep -q "unknown effort .turbo." && [ ! -e "$T/cloud-prompt" ]'
# issue-1552 AC2 and its comment: with the effort lever on, no cloud session can take a fix try, so a
# local worker does, and the ticket's session is recorded abandoned first, and archived by the person
# before the local worker starts, so the two never both push.
effort_cfg 0=low; rm -f "$T/cloud-sent" "$T/cloud-prompt" "$T/state-cl/cloud-archived.json"
q set CW-3 state=triaged stage=null levers=null result.pr=40 "$cw3_fix" "$cw3_cloud"
out=$(DESK_CONFIG="$T/config-ef.md" node "$B/pass.mjs" 2>&1)
check "issue-1552 comment AC with the effort lever on, its live session is recorded abandoned and the local try waits for it to be archived" '[ "$(field CW-3 state)" = "\"triaged\"" ] && [ "$(field CW-3 cloud.abandoned_at)" != null ] && [ ! -e "$T/wt/CW-3" ] && echo "$out" | grep -F "CW-3: its fix try on PR #40 writes to the PR" | grep -qF "cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj may still push to: its cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj is recorded abandoned, and needs-you asks you to archive it"'
check "issue-1552 comment AC and it is on needs-you's archive list" 'jq -e ".pending | map(.session) | index(\"session_01Vy49H7Z4T3CSgAhSxsuhqj\") != null" "$T/state-cl/cloud-archived.json" >/dev/null'
echo '{"sessions":["session_01Vy49H7Z4T3CSgAhSxsuhqj"]}' > "$T/state-cl/cloud-archived.json"
out=$(DESK_CONFIG="$T/config-ef.md" node "$B/pass.mjs" 2>&1)
check "issue-1552 AC2 once archived, with the effort lever on a fix try on a cloud PR runs as a local worker" '[ "$(field CW-3 state)" = "\"running\"" ] && echo "$out" | grep -q "CW-3 port=.*(fix try 1 of 2 on PR #40)" && [ ! -e "$T/cloud-sent" ] && [ ! -e "$T/cloud-prompt" ]'
q set CW-3 state=done
# issue-1569: where §5 forbids AI attribution, the session is told so, and its PR is read for it before
# the ticket is done: found, the pass removes it where config §3 lets it, and otherwise parks naming it
# and the row, on the PR's branch.
{ cat "$T/config.md"; printf '\n## 5. Conventions\n| Field | Value |\n|---|---|\n| AI attribution | `forbidden` |\n\n## 1. Identity\n| Field | Value |\n|---|---|\n| GitHub handle | `me` |\n'; } > "$T/config-ai.md"
cloud_ticket CW-6
out=$(DESK_CONFIG="$T/config-ai.md" node "$B/pass.mjs" 2>&1)
check "issue-1569 AC1 with attribution forbidden, the cloud prompt rules it out" '[ "$(field CW-6 state)" = "\"running\"" ] && grep -q "No AI attribution anywhere" "$T/cloud-prompt" && grep -q "Co-Authored-By" "$T/cloud-prompt"'
check "issue-1569 AC5 with no §1 Git author, the prompt names the repo's git user.name and user.email" 'grep -qF "Author every commit as \`t <t@example.com>\`" "$T/cloud-prompt" && grep -qF "git config user.email \"t@example.com\"" "$T/cloud-prompt"'
node -e 'const s = Date.parse(JSON.parse(process.argv[1])); console.log(JSON.stringify([{ number: 61, title: "feat(w): CW-6 save", url: "u", headRefName: "claude/cw-6-abc", createdAt: new Date(s + 600e3).toISOString() }]))' "$(field CW-6 cloud.started)" > "$T/cloud-prs.json"
echo 'not json' > "$T/cloud-view.json"
out=$(DESK_CONFIG="$T/config-ai.md" node "$B/pass.mjs" 2>&1)
check "issue-1569 AC2 a PR whose commits cannot be read leaves the ticket running, said quietly" '[ "$(field CW-6 state)" = "\"running\"" ] && echo "$out" | grep -q "CW-6: cloud session .* opened PR #61, whose commits, body and comments could not be read"'
: > "$T/gh-calls"
printf '%s\n' '{"author":{"login":"me"},"body":"Done.\n\n🤖 Generated with [Claude Code](https://claude.ai/code)","commits":[{"oid":"abcdef1234","messageHeadline":"feat: CW-6 save","messageBody":"Co-Authored-By: Claude <noreply@anthropic.com>","authors":[{"name":"t","email":"t@example.com"}]}],"comments":[]}' > "$T/cloud-view.json"
out=$(DESK_CONFIG="$T/config-ai.md" node "$B/pass.mjs" 2>&1)
check "issue-1569 AC2 a cloud PR carrying attribution the pass may not remove parks the ticket, naming what was found" '[ "$(field CW-6 state)" = "\"parked\"" ] && field CW-6 park.question | grep -q "cloud PR #61 breaks this repo.s commit and PR rules" && field CW-6 park.question | grep -q "Co-Authored-By trailer naming Claude or Anthropic in commit abcdef1" && field CW-6 park.question | grep -q "Generated with Claude Code.* footer in the PR body" && ! field CW-6 park.question | grep -q "authored as"'
check "issue-1569 AC2 and naming each config §3 row that keeps the pass from removing it" 'field CW-6 park.question | jq -r . | grep -q "The pass may not remove it: config §3 git-force-with-lease is \"[a-z]*\" and pr-edit is \"[a-z]*\"" && ! grep -qE "pr edit 61 |-X DELETE |-f body=" "$T/gh-calls"'
check "issue-1569 AC2 it is not recorded done, and a requeue works its PR's branch locally" '[ "$(field CW-6 result)" = null ] && [ "$(field CW-6 branch)" = "\"claude/cw-6-abc\"" ] && [ "$(field CW-6 cloud.pr_at)" != null ]'
# With git-force-with-lease and pr-edit granted, the pass removes it itself: a real branch on a bare
# origin, two commits authored as Claude with its trailers, and a body and two comments carrying it.
node -e 'const fs = require("fs"); const [i, o] = process.argv.slice(1); fs.writeFileSync(o, fs.readFileSync(i, "utf8").replace(/^(\| `pr-images` .*)$/m, "$1\n| `git-force-with-lease` | Force-push with a lease | `ask` | `yes` |\n| `pr-edit` | Edit PRs | `ask` | `yes` |"))' "$T/config-ai.md" "$T/config-ai-ok.md"
git init -q --bare "$T/origin.git"; git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin main
git clone -q -b main "$T/origin.git" "$T/cw8"; git -C "$T/cw8" checkout -q -b claude/cw-8-abc
echo one > "$T/cw8/one.txt"; git -C "$T/cw8" add one.txt
GIT_AUTHOR_NAME=Claude GIT_AUTHOR_EMAIL=noreply@anthropic.com git -C "$T/cw8" commit -q -m 'feat: CW-8 one' -m 'Why it is.' -m 'Co-Authored-By: Claude <noreply@anthropic.com>'
echo two > "$T/cw8/two.txt"; git -C "$T/cw8" add two.txt
GIT_AUTHOR_NAME=Claude GIT_AUTHOR_EMAIL=noreply@anthropic.com git -C "$T/cw8" commit -q -m 'feat: CW-8 two' -m 'Claude-Session: https://claude.ai/code/session_01X'
git -C "$T/cw8" push -q origin claude/cw-8-abc; CW8_OLD=$(git -C "$T/cw8" rev-parse HEAD); CW8_TREE=$(git -C "$T/cw8" rev-parse 'HEAD^{tree}')
rm -f "$T/cloud-prompt"; cloud_ticket CW-8
out=$(DESK_CONFIG="$T/config-ai-ok.md" node "$B/pass.mjs" 2>&1)
node -e 'const s = Date.parse(JSON.parse(process.argv[1])); console.log(JSON.stringify([{ number: 63, title: "feat(w): CW-8 save", url: "u", headRefName: "claude/cw-8-abc", createdAt: new Date(s + 600e3).toISOString() }]))' "$(field CW-8 cloud.started)" > "$T/cloud-prs.json"
printf '%s\n' '{"baseRefName":"main","headRefName":"claude/cw-8-abc","author":{"login":"me"},"body":"Done.\n\n🤖 Generated with [Claude Code](https://claude.ai/code)","commits":[{"oid":"aaaaaaa111","messageHeadline":"feat: CW-8 one","messageBody":"Why it is.\n\nCo-Authored-By: Claude <noreply@anthropic.com>","authors":[{"name":"Claude","email":"noreply@anthropic.com"}]}],"comments":[{"url":"https://github.com/acme/widgets/pull/63#issuecomment-77","body":"Fixed it.\n\nGenerated with Claude Code","author":{"login":"t"}},{"url":"https://github.com/acme/widgets/pull/63#issuecomment-78","body":"https://claude.ai/code/session_01X","author":{"login":"t"}}]}' > "$T/cloud-view.json"
# By the time the body is edited, CI has added a section to it, which the edit keeps.
jq -c '.body = "Done.\n\nPreview: https://preview.example/63\n\n🤖 Generated with [Claude Code](https://claude.ai/code)"' "$T/cloud-view.json" > "$T/cloud-live.json"
: > "$T/gh-calls"
out=$(DESK_CONFIG="$T/config-ai-ok.md" node "$B/pass.mjs" 2>&1)
rm -f "$T/cloud-live.json"
CW8_NEW=$(git -C "$T/origin.git" rev-parse claude/cw-8-abc)
check "issue-1569 AC2 the pass rewrites the cloud commits on origin, with the same tree, and does not park" '[ "$(field CW-8 state)" = "\"running\"" ] && [ "$CW8_NEW" != "$CW8_OLD" ] && [ "$(git -C "$T/origin.git" rev-parse "claude/cw-8-abc^{tree}")" = "$CW8_TREE" ] && [ "$(git -C "$T/origin.git" rev-parse "claude/cw-8-abc~2")" = "$(git -C "$T/origin.git" rev-parse main)" ]'
check "issue-1569 AC2 each rewritten commit is the repo identity's, its trailers gone and the rest kept" '[ "$(git -C "$T/origin.git" log --format="%an <%ae>|%cn <%ce>" main..claude/cw-8-abc | grep -cvx "t <t@example.com>|t <t@example.com>")" = 0 ] && ! git -C "$T/origin.git" log --format=%B main..claude/cw-8-abc | grep -qiE "co-authored-by|claude-session" && git -C "$T/origin.git" log --format=%B main..claude/cw-8-abc | grep -qx "Why it is."'
check "issue-1569 AC2 it strips the footer from the PR body as it reads after the push, keeping what CI added since" 'grep -qx "pr view 63 --repo acme/widgets --json body,comments" "$T/gh-calls" && grep -qF "pr edit 63 --repo acme/widgets --body-file " "$T/gh-calls" && [ "$(cat "$T/state-cl/cloud/CW-8-pr-63-body.md")" = "$(printf "Done.\n\nPreview: https://preview.example/63")" ]'
check "issue-1569 AC2 it edits a comment down to what is left, and deletes one that was nothing but attribution" 'grep -qx "api -X PATCH repos/acme/widgets/issues/comments/77 -f body=Fixed it." "$T/gh-calls" && grep -qx "api -X DELETE repos/acme/widgets/issues/comments/78" "$T/gh-calls"'
check "issue-1569 AC2 it says what it did, records the one scrub, and leaves no fetch refs behind" 'echo "$out" | grep -q "CW-8: cloud PR #63 broke this repo.s commit and PR rules .*: the pass rewrote its 2 commit(s) as t <t@example.com> with the same tree" && [ "$(field CW-8 cloud.scrubbed)" = 1 ] && [ "$(field CW-8 cloud.pr_at)" = null ] && [ -z "$(git -C "$T/repo" for-each-ref refs/desk/cloud)" ]'
check "issue-1610 AC2 the pass records the head its rewrite produced and the rules it enforced, for recovery to keep" '[ "$(field CW-8 pass_rewrite.sha)" = "\"$CW8_NEW\"" ] && [ "$(field CW-8 pass_rewrite.branch)" = "\"claude/cw-8-abc\"" ] && [ "$(field CW-8 pass_rewrite.author.email)" = "\"t@example.com\"" ] && [ "$(field CW-8 pass_rewrite.strip)" = true ] && [ "$(field CW-8 pass_rewrite.base)" = "\"main\"" ]'
printf '%s\n' '{"baseRefName":"main","headRefName":"claude/cw-8-abc","body":"Done.","commits":[{"oid":"bbbbbbb222","messageHeadline":"feat: CW-8 one","messageBody":"Why it is.","authors":[{"name":"t","email":"t@example.com"}]}],"comments":[]}' > "$T/cloud-view.json"
out=$(DESK_CONFIG="$T/config-ai-ok.md" node "$B/pass.mjs" 2>&1)
check "issue-1569 AC2 once the PR reads clean, the next pass records the ticket done" '[ "$(field CW-8 state)" = "\"done\"" ] && [ "$(field CW-8 result.pr)" = 63 ]'
# A PR that still carries it after the pass removed it once parks, never scrubbed again.
cloud_ticket CW-9
out=$(DESK_CONFIG="$T/config-ai-ok.md" node "$B/pass.mjs" 2>&1)
q set CW-9 "cloud=$(field CW-9 cloud | jq -c '.scrubbed = 1')"
node -e 'const s = Date.parse(JSON.parse(process.argv[1])); console.log(JSON.stringify([{ number: 64, title: "feat(w): CW-9 save", url: "u", headRefName: "claude/cw-9-abc", createdAt: new Date(s + 600e3).toISOString() }]))' "$(field CW-9 cloud.started)" > "$T/cloud-prs.json"
printf '%s\n' '{"body":"Done.\n\n🤖 Generated with [Claude Code](https://claude.ai/code)","commits":[],"comments":[]}' > "$T/cloud-view.json"
: > "$T/gh-calls"
out=$(DESK_CONFIG="$T/config-ai-ok.md" node "$B/pass.mjs" 2>&1)
check "issue-1569 AC2 a PR that still carries it after one scrub parks, and is not edited again" '[ "$(field CW-9 state)" = "\"parked\"" ] && field CW-9 park.question | grep -q "It still does after the pass removed what it found once" && ! grep -q "pr edit" "$T/gh-calls"'
# A cloud session pushes its screenshots to desk-shots/<branch> on origin. Once its PR
# is found, the pass copies the screenshots at that ref's root into images/<KEY>/ for the undraft upload,
# and deletes the ref on origin only where config §3 branch-delete is yes.
node -e 'const fs = require("fs"); const [i, o] = process.argv.slice(1); fs.writeFileSync(o, fs.readFileSync(i, "utf8").replace(/^(\| `pr-images` .*)$/m, "$1\n| `branch-delete` | Delete branches | `ask` | `yes` |"))' "$T/config.md" "$T/config-bd.md"
shots_ticket(){ # <key> <pr number> <config>
  rm -f "$T/cloud-prompt" "$T/cloud-view.json"; cloud_ticket "$1"
  DESK_CONFIG="$3" node "$B/pass.mjs" > /dev/null 2>&1
  q set "$1" "cloud=$(field "$1" cloud | jq -c --arg r "desk-shots/feat/$1" '.shots = $r')"
  git clone -q "$T/origin.git" "$T/sh-$1"; git -C "$T/sh-$1" checkout -q --orphan "desk-shots/feat/$1"; git -C "$T/sh-$1" rm -rqf --ignore-unmatch .
  printf png > "$T/sh-$1/after-save.png"; echo notes > "$T/sh-$1/notes.txt"; git -C "$T/sh-$1" add after-save.png notes.txt
  git -C "$T/sh-$1" commit -q -m shots; git -C "$T/sh-$1" push -q origin "desk-shots/feat/$1"
  node -e 'const [k, n, st] = process.argv.slice(1); console.log(JSON.stringify([{ number: +n, title: `feat(w): ${k} save`, url: "u", headRefName: `feat/${k}`, createdAt: new Date(Date.parse(JSON.parse(st)) + 600e3).toISOString() }]))' "$1" "$2" "$(field "$1" cloud.started)" > "$T/cloud-prs.json"
  out=$(DESK_CONFIG="$3" node "$B/pass.mjs" 2>&1); }
shots_ticket CW-20 66 "$T/config.md"
check "issue-1550 AC4 a cloud PR's screenshots on its side ref are copied into its screenshot directory, and nothing else" '[ "$(field CW-20 state)" = "\"done\"" ] && [ "$(cat "$T/state-cl/images/CW-20/after-save.png")" = png ] && [ ! -e "$T/state-cl/images/CW-20/notes.txt" ] && echo "$out" | grep -qF "CW-20: 1 screenshot(s) from desk-shots/feat/CW-20 copied into $T/state-cl/images/CW-20, for the undraft step to upload into PR #66"'
check "issue-1550 with branch-delete not yes, the side ref is left on origin and said, and no fetched ref is kept" 'git -C "$T/origin.git" rev-parse -q --verify refs/heads/desk-shots/feat/CW-20 > /dev/null && echo "$out" | grep -qF "desk-shots/feat/CW-20 on origin is left, since config §3 branch-delete is \"no\"" && [ -z "$(git -C "$T/repo" for-each-ref refs/desk-shots)" ]'
check "issue-1550 AC4 with pr-images yes, nothing is asked: the undraft step uploads them" '[ "$(field CW-20 images_reported)" != true ] && ! echo "$out" | grep -qF "CW-20: screenshots for PR #66 are in"'
node -e 'const fs = require("fs"); const [i, o] = process.argv.slice(1); fs.writeFileSync(o, fs.readFileSync(i, "utf8").replace(/^\| `pr-images` .*$/m, "| `pr-images` | Upload PR screenshots | `ask` | `ask` |"))' "$T/config.md" "$T/config-pi.md"
shots_ticket CW-22 90 "$T/config-pi.md"
check "issue-1550 AC4 with pr-images not yes, the upload is asked as a local worker's, and the undraft step holds on it" '[ "$(field CW-22 state)" = "\"done\"" ] && [ "$(field CW-22 images_reported)" = true ] && echo "$out" | grep -qF "CW-22: screenshots for PR #90 are in $T/state-cl/images/CW-22 — config §3 pr-images is \"ask\". Ask, then: DESK_UPLOAD_APPROVED=1 node "'
shots_ticket CW-21 67 "$T/config-bd.md"
check "issue-1550 with branch-delete yes, the side ref is deleted on origin once copied" '[ "$(field CW-21 state)" = "\"done\"" ] && [ -e "$T/state-cl/images/CW-21/after-save.png" ] && ! git -C "$T/origin.git" rev-parse -q --verify refs/heads/desk-shots/feat/CW-21 > /dev/null && ! echo "$out" | grep -q "desk-shots/feat/CW-21 on origin is left"'
# A PR found only by the key in its title, off the session's branch and opened by someone else, may be a
# teammate's: it parks, and nothing of it is rewritten or edited.
cloud_ticket CW-10
out=$(DESK_CONFIG="$T/config-ai-ok.md" node "$B/pass.mjs" 2>&1)
node -e 'const s = Date.parse(JSON.parse(process.argv[1])); console.log(JSON.stringify([{ number: 65, title: "feat(w): CW-10 save", url: "u", headRefName: "pat/cw-10", createdAt: new Date(s + 600e3).toISOString() }]))' "$(field CW-10 cloud.started)" > "$T/cloud-prs.json"
printf '%s\n' '{"baseRefName":"main","headRefName":"pat/cw-10","author":{"login":"pat"},"body":"Done.\n\n🤖 Generated with [Claude Code](https://claude.ai/code)","commits":[{"oid":"ccccccc333","messageHeadline":"feat: CW-10","messageBody":"","authors":[{"name":"Pat","email":"pat@example.com"}]}],"comments":[]}' > "$T/cloud-view.json"
: > "$T/gh-calls"
out=$(DESK_CONFIG="$T/config-ai-ok.md" node "$B/pass.mjs" 2>&1)
check "issue-1569 a title-matched PR on another branch, opened by someone else, parks and is neither rewritten nor edited" '[ "$(field CW-10 state)" = "\"parked\"" ] && field CW-10 park.question | grep -q "The pass will not rewrite or edit it: it is on pat/cw-10, not feat/CW-10, and was opened by pat, not me" && ! grep -qE "pr edit 65 |-X DELETE |-f body=" "$T/gh-calls"'
check "issue-1569 and the ticket keeps its own branch, so a requeue never works the other PR's" '[ "$(field CW-10 branch)" = "\"feat/CW-10\"" ] && field CW-10 park.question | grep -q "a requeue of CW-10 works feat/CW-10 locally"'
# The same where config §3 would not let the pass remove it anyway: whose PR it is is read first.
cloud_ticket CW-11
out=$(DESK_CONFIG="$T/config-ai.md" node "$B/pass.mjs" 2>&1)
node -e 'const s = Date.parse(JSON.parse(process.argv[1])); console.log(JSON.stringify([{ number: 66, title: "feat(w): CW-11 save", url: "u", headRefName: "pat/cw-11", createdAt: new Date(s + 600e3).toISOString() }]))' "$(field CW-11 cloud.started)" > "$T/cloud-prs.json"
printf '%s\n' '{"baseRefName":"main","headRefName":"pat/cw-11","author":{"login":"pat"},"body":"Done.\n\n🤖 Generated with [Claude Code](https://claude.ai/code)","commits":[],"comments":[]}' > "$T/cloud-view.json"
out=$(DESK_CONFIG="$T/config-ai.md" node "$B/pass.mjs" 2>&1)
check "issue-1569 a teammate's PR keeps the ticket on its own branch where config §3 grants neither row too" '[ "$(field CW-11 state)" = "\"parked\"" ] && [ "$(field CW-11 branch)" = "\"feat/CW-11\"" ] && field CW-11 park.question | grep -q "The pass will not rewrite or edit it: it is on pat/cw-11" && ! field CW-11 park.question | grep -q "may not remove it"'
git -C "$T/repo" remote remove origin; rm -rf "$T/cw8" "$T/origin.git"
# AC5: whatever §5 says, a commit authored as anyone but the repo's author parks the ticket, naming it.
rm -f "$T/cloud-prompt"; cloud_ticket CW-7
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1569 AC5 with attribution allowed, the prompt still names the author, and no attribution rule" 'grep -qF "Author every commit as \`t <t@example.com>\`" "$T/cloud-prompt" && ! grep -q "No AI attribution" "$T/cloud-prompt"'
node -e 'const s = Date.parse(JSON.parse(process.argv[1])); console.log(JSON.stringify([{ number: 62, title: "feat(w): CW-7 save", url: "u", headRefName: "claude/cw-7-abc", createdAt: new Date(s + 600e3).toISOString() }]))' "$(field CW-7 cloud.started)" > "$T/cloud-prs.json"
printf '%s\n' '{"body":"Done.","commits":[{"oid":"1234567abc","messageHeadline":"feat: CW-7 save","messageBody":"","authors":[{"name":"claude[bot]","email":"bot@users.noreply.github.com"}]}],"comments":[]}' > "$T/cloud-view.json"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1569 AC5 a cloud PR with a commit by another author parks the ticket, naming the commit and its author" '[ "$(field CW-7 state)" = "\"parked\"" ] && [ "$(field CW-7 result)" = null ] && field CW-7 park.question | grep -qF "commit 1234567 authored as claude[bot] <bot@users.noreply.github.com>, not t <t@example.com>"'
rm -f "$T/cloud-view.json" "$T/cloud-prs.json"
# #1581: the repo's subscription is login b, not the pass's own ~/.claude: the cloud session starts on b,
# as a local worker would, and the spawn line and the ticket's cloud record name it.
mkdir -p "$HOME/.claude-logins/b"; cp "$HOME/.claude.json" "$HOME/.claude-logins/b/.claude.json"
printf '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `default` | `~/.claude` | `unused` |\n| `claude` | `b` | `~/.claude-logins/b` | `default` |\n' > "$T/subs-cl.md"
cloud_ticket CW-12; rm -f "$T/cloud-login"
out=$(env -u CLAUDE_CONFIG_DIR DESK_SUBSCRIPTIONS="$T/subs-cl.md" node "$B/pass.mjs" 2>&1)
check "#1581 AC1 AC4 a cloud ticket starts under the repo's subscription's folder, not the pass's login" '[ "$(cat "$T/cloud-login" 2>/dev/null)" = "$HOME/.claude-logins/b" ] && [ "$(field CW-12 state)" = "\"running\"" ]'
check "#1581 AC2 the spawn line names the account, and the ticket keeps it for desk-q" 'echo "$out" | grep -qF "CW-12 in a cloud session on b@example.com (login b): https://claude.ai/code/" && [ "$(field CW-12 cloud.login.email)" = "\"b@example.com\"" ]'
# issue-1553: its retry follow-up goes from the login the session started on, which owns it.
q set CW-12 "cloud=$(node -e 'const c = JSON.parse(process.argv[1]); c.started = new Date(Date.now() - 6 * 3600e3).toISOString(); console.log(JSON.stringify(c))' "$(field CW-12 cloud)")"
node -e 'const h = 3600e3, n = Date.now(), i = (t) => new Date(t).toISOString(); console.log(JSON.stringify({ key: "CW-12", at: i(n - 6 * h), starts: i(n - 6 * h), ships: i(n - 3 * h), could_run_to: i(n - 2 * h), model: 2 }))' > "$T/state-cl/eta.jsonl"
rm -f "$T/cloud-sent" "$T/cloud-send-login"
out=$(env -u CLAUDE_CONFIG_DIR DESK_SUBSCRIPTIONS="$T/subs-cl.md" node "$B/pass.mjs" 2>&1)
check "issue-1553 a cloud session's retry follow-up is sent on the login it started on" '[ "$(field CW-12 cloud.retried_at)" != null ] && [ "$(cat "$T/cloud-send-login" 2>/dev/null)" = "$HOME/.claude-logins/b" ]'
rm -f "$T/cloud-sent" "$T/cloud-send-login" "$T/state-cl/eta.jsonl"
q set CW-12 state=done; rm -rf "$HOME/.claude-logins/b"
# #1564: a cloud session takes none of the batch's local slots, only one of §3b "Cloud sessions at once".
# The whole pass, so its loop goes on past a local ticket with no slot to the cloud one behind it.
export DESK_QUEUE="$T/queue-cs.json"
rm -f "$T/cloud-prompt" "$T/cloud-prs.json"
q init cs; q set-batch concurrency=1
q add LS-1; q set LS-1 state=running branch=fix/LS-1 session_id=live-1
q add LS-2; q set LS-2 state=triaged branch=fix/LS-2
cloud_ticket CS-1
out=$(node "$B/pass.mjs" 2>&1)
check "#1564 AC5 with the local slots full, a ready cloud ticket still starts in a cloud session" '[ "$(field CS-1 state)" = "\"running\"" ] && [ "$(field CS-1 cloud.session)" = "\"session_01Vy49H7Z4T3CSgAhSxsuhqj\"" ]'
check "#1564 AC1 and the local ticket ahead of it still waits for the one local slot" '[ "$(field LS-2 state)" = "\"triaged\"" ] && [ ! -e "$T/wt/LS-2" ]'
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Cloud sessions at once | `4` | `1` |\n'; } > "$T/config-cs.md"
cloud_ticket CS-2; rm -f "$T/cloud-prompt"
out=$(DESK_CONFIG="$T/config-cs.md" node "$B/pass.mjs" 2>&1)
check "#1564 AC5 at the cloud limit a ready cloud ticket does not start, and the pass names the limit" \
  '[ "$(field CS-2 state)" = "\"triaged\"" ] && [ ! -e "$T/cloud-prompt" ] && echo "$out" | grep -qF "CS-2: waits for a cloud session (1 of 1 running"'
# A sibling batch whose queue does not read may be running cloud sessions the count cannot see.
cp "$X1Q" "$T/x1q.bak"; echo 'not json' > "$X1Q"
out=$(node "$B/pass.mjs" 2>&1)
cp "$T/x1q.bak" "$X1Q"
check "#1564 AC2 a sibling batch whose queue does not read holds cloud starts under the limit, and the pass says why" \
  '[ "$(field CS-2 state)" = "\"triaged\"" ] && [ ! -e "$T/cloud-prompt" ] && echo "$out" | grep -qF "cloud sessions: none starts this pass, a sibling batch" && echo "$out" | grep -qF "queue does not read ("'
# issue-1587 AC2: with the cloud full (CS-1 at the limit of 1) and a local slot free, the cloud-able CS-2
# is counted in the local demand, so the slot shows free under a sibling batch's shared cap too: the
# pass records local_free_at, and the next pass starts CS-2 on that slot.
q set LS-2 state=done; q set-batch concurrency=2 local_free_at=null
out=$(DESK_CONFIG="$T/config-cs.md" node "$B/pass.mjs" 2>&1)
check "issue-1587 AC2 a local slot the cloud-able ticket could take stays free a pass, with a sibling batch: local_free_at is recorded" \
  '[ "$(field CS-2 state)" = "\"triaged\"" ] && [ "$(bfield local_free_at)" != null ]'
out=$(DESK_CONFIG="$T/config-cs.md" node "$B/pass.mjs" 2>&1)
check "issue-1587 AC2 and the next pass starts it on that local slot" \
  '[ "$(field CS-2 state)" = "\"running\"" ] && [ "$(field CS-2 start_place.where)" = "\"local\"" ] && [ ! -e "$T/cloud-prompt" ]'
q set CS-1 state=done; q set LS-1 state=done session_id=null; q set LS-2 state=done; q set CS-2 state=done
# issue-1689 AC1: with a cloud session free, a cloud-able ticket pinned to this computer still starts
# here, and the pin stays.
cloud_ticket CS-3; q set CS-3 cloud_ok=true location=local; rm -f "$T/cloud-prompt"
out=$(DESK_CONFIG="$T/config-cs.md" node "$B/pass.mjs" 2>&1)
check "issue-1689 AC1 a pin to local overrides runs: cloud: it starts on this computer, and stays pinned" \
  '[ "$(field CS-3 state)" = "\"running\"" ] && [ "$(field CS-3 start_place.where)" = "\"local\"" ] && [ "$(field CS-3 location)" = "\"local\"" ] && [ ! -e "$T/cloud-prompt" ]'
q set CS-3 state=done
# issue-1570: a cloud PR its session marked unfinished keeps the ticket running on its session. Once CI
# on its head finishes the session is sent the results; after 2 follow-ups with no push it parks.
cl_view(){ node -e 'const [title, body, status, conclusion] = process.argv.slice(1); console.log(JSON.stringify({ title, body, headRefOid: "aaaaaaa111", comments: [],
  commits: [{ oid: "aaaaaaa111", committedDate: new Date(Date.now() - 600e3).toISOString(), messageHeadline: "feat: save", messageBody: "", authors: [{ name: "t", email: "t@example.com" }] }],
  statusCheckRollup: [{ __typename: "CheckRun", name: "Lint", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", name: "Tests", status, conclusion: conclusion || null }] }))' "$@" > "$T/cloud-view.json"; }
cl_pr(){ node -e 'const [k, n, title] = process.argv.slice(1); const s = Date.parse(process.argv[4]); console.log(JSON.stringify([{ number: +n, title, url: "u", headRefName: `claude/${k.toLowerCase()}-abc`, createdAt: new Date(s + 600e3).toISOString() }]))' "$1" "$2" "$3" "$(field "$1" cloud.started | tr -d '"')" > "$T/cloud-prs.json"; }
cl_quiet(){ q set "$1" "cloud=$(field "$1" cloud | jq -c '.unfinished.sent_at = (now - 7200 | todate)')"; }
cloud_ticket CW-13
out=$(node "$B/pass.mjs" 2>&1)
cl_pr CW-13 67 "WIP: feat(w): CW-13 save"
cl_view "WIP: feat(w): CW-13 save" "Placeholder selectors.\n\n## What is left\n- the real selectors" IN_PROGRESS
rm -f "$T/cloud-sent" "$T/cloud-sent-msg"
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1570 AC1 AC4 a cloud PR marked unfinished is not recorded done: running at stage cloud, waiting on its session" '[ "$(field CW-13 state)" = "\"running\"" ] && [ "$(field CW-13 stage)" = "\"cloud\"" ] && [ "$(field CW-13 result)" = null ] && [ "$(field CW-13 cloud.pr_at)" = null ] && [ "$(field CW-13 cloud.unfinished.pr)" = 67 ] && echo "$out" | grep -qF "CW-13: cloud PR #67 unfinished (WIP), waiting on its session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj"'
check "issue-1570 AC2 while CI runs on its head the session is sent nothing" '[ ! -e "$T/cloud-sent" ]'
cl_view "WIP: feat(w): CW-13 save" "Placeholder selectors." COMPLETED FAILURE
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1570 AC2 AC4 once CI on its head finishes, the session is sent a follow-up with the check results" '[ "$(cat "$T/cloud-sent" 2>/dev/null)" = "session_01Vy49H7Z4T3CSgAhSxsuhqj|--output-format|json" ] && grep -qF "CI on aaaaaaa has finished: Tests failure; 1 of 2 passed." "$T/cloud-sent-msg" && [ "$(field CW-13 cloud.unfinished.sent)" = 1 ] && echo "$out" | grep -qF "sent follow-up 1 of 2 with the check results" && [ "$(field CW-13 state)" = "\"running\"" ]'
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1570 AC2 the next pass, within the wait, sends no second follow-up" '[ "$(wc -l < "$T/cloud-sent")" -eq 1 ]'
cl_quiet CW-13; out=$(node "$B/pass.mjs" 2>&1)
check "issue-1570 AC2 an hour on with no push, it is sent a second" '[ "$(wc -l < "$T/cloud-sent")" -eq 2 ] && [ "$(field CW-13 cloud.unfinished.sent)" = 2 ]'
cl_quiet CW-13; rm -f "$T/cloud-prompt"; out=$(node "$B/pass.mjs" 2>&1)
# issue-1689 AC3: after its follow-ups run out it is moved to this computer, pinned local, rather than
# parked or started in another cloud session, and a local worker goes on from the PR's branch.
check "issue-1689 AC3 after 2 idle follow-ups it is moved local, pinned, on the PR's branch, naming the session" '[ "$(field CW-13 state)" != "\"parked\"" ] && [ "$(field CW-13 location)" = "\"local\"" ] && [ "$(field CW-13 park)" = null ] && echo "$out" | grep -qF "cloud session https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj" && echo "$out" | grep -qF "left PR #67 unfinished (WIP)" && echo "$out" | grep -qF "after 2 follow-ups, so it was moved to this computer: pinned local" && [ "$(field CW-13 branch)" = "\"claude/cw-13-abc\"" ] && [ "$(field CW-13 cloud.unfinished)" = null ] && [ "$(field CW-13 cloud.pr_at)" != null ] && [ "$(wc -l < "$T/cloud-sent")" -eq 2 ] && [ "$(field CW-13 start_place.where)" = "\"local\"" ] && [ ! -e "$T/cloud-prompt" ]'
rm -f "$T/cloud-prompt"; out=$(node "$B/pass.mjs" 2>&1)
check "issue-1689 AC3 no pass starts another cloud session for it: a local worker runs it, still pinned" '[ ! -e "$T/cloud-prompt" ] && [ "$(field CW-13 location)" = "\"local\"" ] && [ "$(field CW-13 start_place.where)" = "\"local\"" ]'
q set CW-13 state=done
# Once its session finishes the PR (WIP and what is left taken out), the ticket is recorded done.
cloud_ticket CW-14
out=$(node "$B/pass.mjs" 2>&1)
cl_pr CW-14 68 "feat(w): CW-14 save"
cl_view "feat(w): CW-14 save" "I could not finish the a11y run." IN_PROGRESS
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1570 AC1 the prompt's step 5 wording keeps it running too" '[ "$(field CW-14 state)" = "\"running\"" ] && echo "$out" | grep -qF "CW-14: cloud PR #68 unfinished (could not finish)"'
cl_view "feat(w): CW-14 save" "Saves the widget.\n\n### Testing\nbash tests/run.sh" COMPLETED SUCCESS
out=$(node "$B/pass.mjs" 2>&1)
check "issue-1570 AC4 once the PR reads finished it is recorded done, its unfinished record dropped" '[ "$(field CW-14 state)" = "\"done\"" ] && [ "$(field CW-14 result.pr)" = 68 ] && [ "$(field CW-14 cloud.unfinished)" = null ] && [ "$(field CW-14 cloud.pr_at)" != null ]'
rm -f "$T/cloud-sent" "$T/cloud-sent-msg" "$T/cloud-view.json" "$T/cloud-prs.json"

# ---- A spawn whose state=running write the queue refuses starts nothing, and the next pass starts it.
# queue.mjs refuses `set <KEY> state=running` while $T/refuse-running-<KEY> exists, as a queue locked
# past its wait does; every other write goes through. Each path runs alone: refused, then writable.
export DESK_QUEUE="$T/queue-rr.json" DESK_AUTOPILOT_STATE="$T/state-rr"; mkdir -p "$T/state-rr/logs" "$T/state-rr/tickets" "$T/state-rr/handoffs"
rm "$T/desk/bin/queue.mjs"
cat > "$T/desk/bin/queue.mjs" <<EOF
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2);
if (a[0] === 'set' && a.includes('state=running') && existsSync('$T/refuse-running-' + a[1])) { console.error('queue.json is locked by pid 1, past its 200ms wait'); process.exit(1); }
process.exit(spawnSync(process.execPath, ['$B/queue.mjs', ...a], { stdio: 'inherit' }).status ?? 1);
EOF
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1 resume=\${AUTOPILOT_RESUME:+yes} stage=\${AUTOPILOT_START_STAGE:-}" >> "$T/rr-spawns"; echo "[spawn] ticket=\$1"
[ -n "\${AUTOPILOT_TASK:-}" ] && echo "\$1" >> "$T/rr-tasks"; exit 0
EOF
: > "$T/rr-spawns"; : > "$T/rr-tasks"; rm -f "$T/cloud-prompt" "$T/cloud-fail"
spawns_of(){ grep -c "^$1 " "$T/rr-spawns"; }
refused_pass(){ touch "$T/refuse-running-$1"; out=$(node "$B/pass.mjs" 2>&1); rm -f "$T/refuse-running-$1"; }
q init rr
q add RR-1; q set RR-1 state=triaged lane=A branch=fix/RR-1
refused_pass RR-1
check "DS-752 AC1 a refused state=running write starts no worker, and the failed line names the ticket and says so" \
  '[ "$(spawns_of RR-1)" = 0 ] && [ "$(field RR-1 state)" = "\"triaged\"" ] && [ "$(field RR-1 session_id)" = null ] && [ "$(field RR-1 spawn_failed)" = null ] && echo "$out" | grep -q "RR-1: queue write refused, not recorded, so no worker was started — set state=running" && ! echo "$out" | grep -q "spawned: RR-1"'
check "issue-1587 a local start refused after its worktree is set up records no place at start, so a cloud-able ticket stays cloud-able" '[ "$(field RR-1 start_place)" = null ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-752 AC2 with the queue writable again, the next pass starts exactly one worker" '[ "$(spawns_of RR-1)" = 1 ] && [ "$(field RR-1 state)" = "\"running\"" ]'
check "issue-1587 and once its worker runs, its place at start is recorded" '[ "$(field RR-1 start_place.where)" = "\"local\"" ]'
check "DS-752 AC6 a recorded write spawns, and the report reads as before" 'echo "$out" | grep -q "spawned: RR-1 port=[0-9]* db=none" && ! echo "$out" | grep -q "queue write refused"'
q set RR-1 state=done session_id=null
git -C "$T/repo" worktree add -q -b fix/RR-2 "$T/wt/RR-2"
q add RR-2; q set RR-2 state=triaged lane=A branch=fix/RR-2 "worktree=$T/wt/RR-2" session_id=sess-rr2 resume=pending resume_why=x
refused_pass RR-2
check "DS-752 AC3 a killed worker whose state=running write is refused is not resumed, and still waits to resume" \
  '[ "$(spawns_of RR-2)" = 0 ] && [ "$(field RR-2 state)" = "\"triaged\"" ] && [ "$(field RR-2 resume)" = "\"pending\"" ] && [ "$(field RR-2 resumes)" = null ] && echo "$out" | grep -q "RR-2: queue write refused, not recorded, so no worker was resumed"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-752 AC3 the next pass resumes it once" 'grep -qx "RR-2 resume=yes stage=" "$T/rr-spawns" && [ "$(spawns_of RR-2)" = 1 ] && [ "$(field RR-2 state)" = "\"running\"" ]'
q set RR-2 state=done session_id=null
git -C "$T/repo" worktree add -q -b fix/RR-3 "$T/wt/RR-3"
q add RR-3; q set RR-3 state=triaged lane=A branch=fix/RR-3 "worktree=$T/wt/RR-3" handoff=pending handoff_stage=4b; hfile RR-3 4b "typecheck: pass"
refused_pass RR-3
check "DS-752 AC4 a handoff whose state=running write is refused starts no session, and the handoff is still pending" \
  '[ "$(spawns_of RR-3)" = 0 ] && [ "$(field RR-3 state)" = "\"triaged\"" ] && [ "$(field RR-3 handoff)" = "\"pending\"" ] && [ "$(field RR-3 spawn_failed)" = null ] && echo "$out" | grep -q "RR-3: queue write refused, not recorded, so no Stage 4b session was started"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-752 AC4 the next pass starts its Stage 4b session once" 'grep -qx "RR-3 resume= stage=4b" "$T/rr-spawns" && [ "$(spawns_of RR-3)" = 1 ] && [ "$(field RR-3 state)" = "\"running\"" ]'
q set RR-3 state=done session_id=null
q add RR-4; q set RR-4 state=triaged lane=A branch=feat/RR-4 location=cloud
printf '# RR-4\n\nSource: the user, in this conversation\n\nMake the widget save. AC1: it saves.\n' > "$T/state-rr/tickets/RR-4.md"
refused_pass RR-4
check "DS-752 AC5 a cloud ticket whose state=running write is refused starts no cloud session" \
  '[ ! -e "$T/cloud-prompt" ] && [ "$(field RR-4 state)" = "\"triaged\"" ] && [ "$(field RR-4 cloud)" = null ] && echo "$out" | grep -q "RR-4: queue write refused, not recorded, so no cloud session was started"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-752 AC6 with the write recorded, the cloud session starts and is recorded running" \
  '[ -e "$T/cloud-prompt" ] && [ "$(field RR-4 state)" = "\"running\"" ] && [ "$(field RR-4 stage)" = "\"cloud\"" ] && [ "$(field RR-4 cloud.session)" = "\"session_01Vy49H7Z4T3CSgAhSxsuhqj\"" ] && echo "$out" | grep -q "RR-4 in a cloud session on login [a-z]*: https://claude.ai/code/"'
q set RR-4 state=done
# The running write is recorded but the session's, after it started, is refused: the ticket keeps the
# time it started, so later passes still watch for its PR rather than skip a running ticket with no log.
q add RR-6; q set RR-6 state=triaged lane=A branch=feat/RR-6 location=cloud
printf '# RR-6\n\nSource: the user, in this conversation\n\nMake the widget save. AC1: it saves.\n' > "$T/state-rr/tickets/RR-6.md"
touch "$T/lock-after-cloud"; out=$(DESK_QUEUE_LOCK_WAIT_MS=200 node "$B/pass.mjs" 2>&1); rm -f "$T/lock-after-cloud"; rm -rf "$DESK_QUEUE.lock"
check "DS-752 a cloud session whose details are refused after it started stays running with its start time" \
  '[ "$(field RR-6 state)" = "\"running\"" ] && [ "$(field RR-6 cloud.started)" != null ] && [ "$(field RR-6 cloud.session)" = null ] && echo "$out" | grep -q "RR-6: queue write refused, not recorded — set cloud="'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-752 and the next pass watches it for its PR, saying its URL was not recorded" \
  '[ "$(field RR-6 state)" = "\"running\"" ] && echo "$out" | grep -qF "RR-6: cloud session (its session URL was not recorded), no PR yet"'
q set RR-6 state=done
# A round ruled out of resuming by a resume file on another branch keeps that file while its spawn is
# refused, so the next pass still starts it at Stage 0 rather than resuming the round.
git -C "$T/repo" worktree add -q -b fix/RR-5 "$T/wt/RR-5"
q add RR-5; q set RR-5 state=triaged lane=A branch=fix/RR-5 "worktree=$T/wt/RR-5" 'last_round={"stage":"4/9","question":"which border?"}'
mkdir -p "$T/state-rr/resume"; printf '{"ticket":"RR-5","branch":"fix/RR-5-old"}' > "$T/state-rr/resume/RR-5.json"
refused_pass RR-5
check "DS-752 a refused spawn keeps the resume file that rules out resuming the round" \
  '[ "$(spawns_of RR-5)" = 0 ] && [ -f "$T/state-rr/resume/RR-5.json" ] && [ ! -e "$T/state-rr/resume/RR-5.json.old" ] && [ "$(field RR-5 last_round.stage)" = "\"4/9\"" ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-752 and the next pass starts it at Stage 0, moving the file aside then" \
  'grep -qx "RR-5 resume= stage=" "$T/rr-spawns" && [ "$(spawns_of RR-5)" = 1 ] && [ -f "$T/state-rr/resume/RR-5.json.old" ]'
q set RR-5 state=done session_id=null

# ---- DS-662: a deep test lock queue holds new workers and resumes into Stage 4 ------------------------
# The ps stub prints $T/ps.out: two wrappers wait on the test lock with no profile (1 slot x 2), one
# from another repo; a third holds it. Every other suite runs its passes with the gate off (run.sh).
q set-batch concurrency=9
cat > "$T/ps.out" <<'EOF'
 9101     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh
 9102  9101 bash tests/run.sh
 9201     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh tsc --cwd . -- pnpm typecheck
 9301     1 bash /other/repo/desk/bin/with-lock.sh test -- pnpm test
EOF
mkdir -p "$T/locks-lq/desk-test.lock.d"; echo "9101 9102" > "$T/locks-lq/desk-test.lock.d/pid"
printf ' 9101  10:05\n 9102  10:04\n 9201  00:30\n 9301  00:20\n' > "$T/ps-ages.out"
# The holder and the tsc waiter work in this repo's main checkout, the other waiter in another repo's.
printf 'p9101\ncbash\nfcwd\nn%s/repo\np9201\ncbash\nfcwd\nn%s/repo\np9301\ncbash\nfcwd\nn/other/repo\n' "$T" "$T" > "$T/lsof.out"
lq_pass(){ out=$(AUTOPILOT_LOCK_QUEUE=on DESK_LOCK_DIR="$T/locks-lq" node "$B/pass.mjs" 2>&1); }
for k in LQ-2 LQ-3 LQ-4 LQ-5; do git -C "$T/repo" worktree add -q -b "fix/$k" "$T/wt/$k"; done
q add LQ-1; q set LQ-1 state=triaged lane=A branch=fix/LQ-1
q add LQ-2; q set LQ-2 state=triaged lane=A branch=fix/LQ-2 "worktree=$T/wt/LQ-2" session_id=sess-lq2 stage=4/9 resume=pending resume_why=x
q add LQ-3; q set LQ-3 state=triaged lane=A branch=fix/LQ-3 "worktree=$T/wt/LQ-3" handoff=pending handoff_stage=4b; hfile LQ-3 4b "typecheck: pass"
lq_pass
check "DS-662 AC1 with the queue at slots x factor, a ticket ready to start gets no worker, and the report names the depth" \
  '[ "$(spawns_of LQ-1)" = 0 ] && [ "$(field LQ-1 state)" = "\"triaged\"" ] && echo "$out" | grep -qF "test lock queue: 2 run(s) waiting on its 1 slot(s), at or over the hold at 1 x 2 = 2; runs by repo: widgets 2, other 1; this repo'"'"'s share ceil(2 / 2) = 1, 2 its own; held by $T/repo: /bin/bash /home/u/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.…, held 0m: holding new workers and resumes into Stage 4 (" && echo "$out" | grep -q "Stage 4 (.*LQ-1"'
check "DS-662 AC1 the pass record names the lock queue as what held its spawns" 'node -e "const p = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).pass; process.exit(/^test lock queue: 2 run.*\(LQ-2, LQ-3, LQ-1\)/.test(p?.held ?? \"\") ? 0 : 1)" "$DESK_QUEUE"'
check "DS-662 AC2 a killed worker last at Stage 4 and a handoff to 4b are held, still queued, and named" \
  '[ "$(spawns_of LQ-2)" = 0 ] && [ "$(field LQ-2 resume)" = "\"pending\"" ] && [ "$(spawns_of LQ-3)" = 0 ] && [ "$(field LQ-3 handoff)" = "\"pending\"" ] && echo "$out" | grep -q "holding new workers and resumes into Stage 4 (LQ-2, LQ-3, LQ-1)"'
q add LQ-4; q set LQ-4 state=triaged lane=A branch=fix/LQ-4 "worktree=$T/wt/LQ-4" session_id=sess-lq4 stage=3/9 resume=pending resume_why=x
q add LQ-5; q set LQ-5 state=triaged lane=A branch=fix/LQ-5 "worktree=$T/wt/LQ-5" handoff=pending handoff_stage=7; hfile LQ-5 7 "typecheck: pass"
lq_pass
check "DS-662 AC4 a resume at Stage 3 and a handoff to Stage 7 start as today, while the held ones stay held" \
  'grep -qx "LQ-4 resume=yes stage=" "$T/rr-spawns" && [ "$(field LQ-4 state)" = "\"running\"" ] && grep -qx "LQ-5 resume= stage=7" "$T/rr-spawns" && [ "$(field LQ-5 state)" = "\"running\"" ] && [ "$(spawns_of LQ-2)" = 0 ] && [ "$(spawns_of LQ-3)" = 0 ]'
q set LQ-4 state=done session_id=null; q set LQ-5 state=done session_id=null
git -C "$T/repo" worktree add -q -b fix/LQ-7 "$T/wt/LQ-7"
q add LQ-7; q set LQ-7 state=triaged lane=A branch=fix/LQ-7 "worktree=$T/wt/LQ-7" 'last_round={"stage":"7/9","question":"which title?"}'
lq_pass
check "DS-662 AC4 a requeue resuming its last round at Stage 7 starts as today, while the held ones stay held" \
  'grep -qx "LQ-7 resume= stage=7" "$T/rr-spawns" && [ "$(field LQ-7 state)" = "\"running\"" ] && [ "$(spawns_of LQ-2)" = 0 ] && [ "$(spawns_of LQ-3)" = 0 ] && ! echo "$out" | grep -q "Stage 4 (.*LQ-7"'
q set LQ-7 state=done session_id=null
# A fix try whose last worker parked at Stage 7 starts again on its fix task, which runs suites, so the
# deep queue holds it as it would a start at Stage 0.
git -C "$T/repo" worktree add -q -b fix/LQ-8 "$T/wt/LQ-8"
q add LQ-8; q set LQ-8 state=triaged lane=A branch=fix/LQ-8 "worktree=$T/wt/LQ-8" 'last_round={"stage":"7/9","question":"which?"}' 'fix={"kind":"review","try":1,"of":2,"pr":8,"head":"x","what":"review not clean"}'
lq_pass
check "a fix try last parked at Stage 7 is held by the deep queue, as its task runs suites" '[ "$(spawns_of LQ-8)" = 0 ] && echo "$out" | grep -q "Stage 4 (.*LQ-8"'
q set LQ-8 state=done session_id=null
# One waiter drains: below the hold at 2 with 1 waiting, each pass starts at most 2 - 1 = 1 of the held
# suite-bound two (the listing stays as it is, so each pass has the same room). The fresh LQ-1 takes no
# room (#1544): its first suite is a stage away, so it starts on the first pass beside one of them.
printf ' 9101     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh\n 9102  9101 bash tests/run.sh\n 9201     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh tsc --cwd . -- pnpm typecheck\n' > "$T/ps.out"
# Each one started is marked done before the next pass, so the repo's worker cap never holds the others.
lq_started(){ echo $(( $(spawns_of LQ-1) + $(spawns_of LQ-2) + $(spawns_of LQ-3) )); }
lq_retire(){ for k in LQ-1 LQ-2 LQ-3; do [ "$(field "$k" state)" = '"running"' ] && q set "$k" state=done session_id=null; done; :; }
lq_pass
check "DoD5 below the hold, a pass starts at most the hold less those waiting: one of the suite-bound two, the other held past a room of 1" \
  '[ $(( $(spawns_of LQ-2) + $(spawns_of LQ-3) )) = 1 ] && echo "$out" | grep -qF "under the hold at 1 x 2 = 2" && echo "$out" | grep -qF "past the 1 this pass had room for"'
check "#1544 AC1 below the hold, the fresh Stage 0 start takes no lock-queue room and starts on the first pass" \
  '[ "$(spawns_of LQ-1)" = 1 ] && ! echo "$out" | grep -q "Stage 4 (.*LQ-1"'
lq_retire; lq_pass
check "DoD5 the next pass starts one more" '[ "$(lq_started)" = 3 ]'
lq_retire; lq_pass
check "DS-662 AC3 below the hold, the held resume, handoff and new ticket all start in time, and then nothing names the lock queue" \
  'grep -qx "LQ-2 resume=yes stage=" "$T/rr-spawns" && grep -qx "LQ-3 resume= stage=4b" "$T/rr-spawns" && [ "$(spawns_of LQ-1)" = 1 ] && ! echo "$out" | grep -q "test lock queue"'
lq_retire
# A fix try whose last worker reached Stage 3 and parked starts again on its fix task, at its try's stage,
# never as a desk-ticket round resumed from Stage 3.
git -C "$T/repo" worktree add -q -b fix/LQ-9 "$T/wt/LQ-9"
q add LQ-9; q set LQ-9 state=triaged lane=A branch=fix/LQ-9 "worktree=$T/wt/LQ-9" 'last_round={"stage":"3/9","question":"which?"}' 'fix={"kind":"review","try":1,"of":2,"pr":9,"head":"x","what":"review not clean"}'
lq_pass
check "an unfinished fix try is spawned on its fix task, not resumed from its last round's stage" \
  'grep -qx "LQ-9 resume= stage=" "$T/rr-spawns" && grep -qx LQ-9 "$T/rr-tasks" && [ "$(field LQ-9 stage)" = "\"3/9\"" ]'
q set LQ-9 state=done session_id=null
q add LQ-6; q set LQ-6 state=triaged lane=A branch=fix/LQ-6
touch "$T/ps.fail"; lq_pass; rm -f "$T/ps.fail"
check "DS-662 AC5 with ps unreadable, a ticket starts as today and the pass says the lock queue was not read" \
  '[ "$(spawns_of LQ-6)" = 1 ] && echo "$out" | grep -q "test lock queue: not read (ps could not be read), so workers start as they would without it"'
q set LQ-6 state=done session_id=null
# A deep queue shared by three repos: another configured repo (api) holds the lock and has 3 waiters,
# 3 more wait outside any configured repo, and this repo has none. A hold at 1 x 6 = 6 gives each of the
# three a share of ceil(6 / 3) = 2, so of three ready tickets here exactly two start.
mkdir -p "$T/cfg-lq/repos/acme__api"
printf '## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | `/other/api` |\n' > "$T/cfg-lq/repos/acme__api/config.md"
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `test-lock-queue-factor` | `6` | test |\n' > "$T/machine-lq.md"
{ echo ' 9101     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh'
  echo ' 9102  9101 bash tests/run.sh'
  for p in 9201 9202 9203 9301 9302 9303; do echo " $p     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh tsc --cwd . -- pnpm typecheck"; done; } > "$T/ps.out"
{ printf 'p9101\ncbash\nfcwd\nn/other/api-worktrees/K-1\n'
  for p in 9201 9202 9203; do printf 'p%s\ncbash\nfcwd\nn/other/api\n' "$p"; done
  for p in 9301 9302 9303; do printf 'p%s\ncbash\nfcwd\nn/elsewhere\n' "$p"; done; } > "$T/lsof.out"
# A worker cap of 8 leaves the lock gate as the only limit.
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `8 / 8` |\n'; } > "$T/config-lq.md"
# The three are handoffs to 4b, whose next step is a suite; two fresh Stage 0 starts beside them take no
# lock-queue room (#1544), so both start whatever the share.
for k in LQ-10 LQ-11 LQ-12; do git -C "$T/repo" worktree add -q -b "fix/$k" "$T/wt/$k"; q add "$k"; q set "$k" state=triaged lane=A "branch=fix/$k" "worktree=$T/wt/$k" handoff=pending handoff_stage=4b; hfile "$k" 4b "typecheck: pass"; done
for k in LQ-16 LQ-17; do q add "$k"; q set "$k" state=triaged lane=A "branch=fix/$k"; done
out=$(AUTOPILOT_LOCK_QUEUE=on DESK_LOCK_DIR="$T/locks-lq" DESK_CONFIG="$T/config-lq.md" DESK_CONFIG_ROOT="$T/cfg-lq" DESK_MACHINE="$T/machine-lq.md" node "$B/pass.mjs" 2>&1)
check "DoD1 with the queue deep and three repos on it, this repo with no run starts its share of 2 of 3 ready tickets" \
  '[ $(( $(spawns_of LQ-10) + $(spawns_of LQ-11) + $(spawns_of LQ-12) )) = 2 ]'
check "DoD4 the held note names the runs of each active repo, and this repo share, and the third ticket" \
  'echo "$out" | grep -q "Stage 4 (LQ-1[012]), past the 2" && echo "$out" | grep -qF "6 run(s) waiting on its 1 slot(s), at or over the hold at 1 x 6 = 6; runs by repo: api 4, other 3; this repo'"'"'s share ceil(6 / 3) = 2, 0 its own" && echo "$out" | grep -qF "past the 2 this pass had room for"'
check "#1544 AC2 with this repo waiting on no lock and free slots, every fresh start begins and only the suite-bound handoff past the room is held" \
  '[ "$(spawns_of LQ-16)" = 1 ] && [ "$(spawns_of LQ-17)" = 1 ] && ! echo "$out" | grep -q "Stage 4 (.*LQ-1[67]"'
for k in LQ-10 LQ-11 LQ-12 LQ-16 LQ-17; do q set "$k" state=done session_id=null; done
# Two configured repos of one name under different owners are two repos, each named owner/name as
# desk-q names them: the three runs in /elsewhere are now beta/api's, not merged into acme's api.
mkdir -p "$T/cfg-lq/repos/beta__api"
printf '## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | `/elsewhere` |\n' > "$T/cfg-lq/repos/beta__api/config.md"
for k in LQ-13 LQ-14 LQ-15; do git -C "$T/repo" worktree add -q -b "fix/$k" "$T/wt/$k"; q add "$k"; q set "$k" state=triaged lane=A "branch=fix/$k" "worktree=$T/wt/$k" handoff=pending handoff_stage=4b; hfile "$k" 4b "typecheck: pass"; done
out=$(AUTOPILOT_LOCK_QUEUE=on DESK_LOCK_DIR="$T/locks-lq" DESK_CONFIG="$T/config-lq.md" DESK_CONFIG_ROOT="$T/cfg-lq" DESK_MACHINE="$T/machine-lq.md" node "$B/pass.mjs" 2>&1)
check "DS-958 two repos named api under different owners keep separate counts, named owner/name" \
  'echo "$out" | grep -qF "runs by repo: acme/api 4, beta/api 3; this repo'"'"'s share ceil(6 / 3) = 2, 0 its own" && [ $(( $(spawns_of LQ-13) + $(spawns_of LQ-14) + $(spawns_of LQ-15) )) = 2 ]'
for k in LQ-13 LQ-14 LQ-15; do q set "$k" state=done session_id=null; done
# A light repo whose light queue is deep (one run holds its 1 slot, two wait) and whose test
# lock is idle starts a new ticket, which begins at triage, and holds a resume into Stage 4.
{ echo ' 9101     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh light --cwd . -- bash tests/run.sh'
  echo ' 9102  9101 bash tests/run.sh'
  for p in 9201 9202; do echo " $p     1 /bin/bash /home/u/.claude/desk/bin/with-lock.sh light --cwd . -- bash tests/run.sh"; done; } > "$T/ps.out"
printf ' 9101  10:05\n 9102  10:04\n 9201  00:30\n 9202  00:20\n' > "$T/ps-ages.out"
printf 'p9101\ncbash\nfcwd\nn%s/repo\np9201\ncbash\nfcwd\nn%s/repo\np9202\ncbash\nfcwd\nn%s/repo\n' "$T" "$T" "$T" > "$T/lsof.out"
mkdir -p "$T/locks-ll/desk-light.lock.d"; echo "9101 9102" > "$T/locks-ll/desk-light.lock.d/pid"
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `8 / 8` |\n| Light lock slots | `2` | `1` |\n'
  printf '\n## 4. Checks\n| Field | Value |\n|---|---|\n| Suite weight | `light` |\n'; } > "$T/config-ll.md"
git -C "$T/repo" worktree add -q -b fix/LL-2 "$T/wt/LL-2"
q add LL-1; q set LL-1 state=triaged lane=A branch=fix/LL-1
q add LL-2; q set LL-2 state=triaged lane=A branch=fix/LL-2 "worktree=$T/wt/LL-2" session_id=sess-ll2 stage=4/9 resume=pending resume_why=x
out=$(AUTOPILOT_LOCK_QUEUE=on DESK_LOCK_DIR="$T/locks-ll" DESK_CONFIG="$T/config-ll.md" DESK_MACHINE="$T/no-machine.md" node "$B/pass.mjs" 2>&1)
check "#1458 AC2 with only the light queue full, a new ticket starts and a resume into Stage 4 is held, naming the light lock queue" \
  '[ "$(spawns_of LL-1)" = 1 ] && [ "$(spawns_of LL-2)" = 0 ] && [ "$(field LL-2 resume)" = "\"pending\"" ] && echo "$out" | grep -qF "light lock queue: 2 run(s) waiting on its 1 slot(s), at or over the hold at 1 x 2 = 2" && echo "$out" | grep -q "Stage 4 (LL-2)"'
for k in LL-1 LL-2; do q set "$k" state=done session_id=null; done
# issue-1587: while the person uses this computer (processes not desk's over the machine profile's
# baseline by its threshold), the local cap is person-use-floor; the cap comes back once their use has
# stayed under it for person-use-calm-min. A desk worker's own tree never counts.
pu_prev=$DESK_QUEUE; export DESK_QUEUE="$T/queue-pu.json"
q init pu; q set-batch concurrency=3
for k in PU-1 PU-2 PU-3; do q add "$k"; q set "$k" state=triaged lane=A "branch=fix/$k"; done
# pu_machine <calm-min> [<person-use row value>, default on; - for no row]
pu_machine(){
  local mode=${2:-on} row=''
  [ "$mode" = - ] || row="| \`person-use\` | \`$mode\` | test |\n"
  printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n%b| `person-baseline-gb` | `1` | test |\n| `person-use-gb` | `2` | test |\n| `person-baseline-cpu` | `1` | test |\n| `person-use-cpu` | `8` | test |\n| `person-use-floor` | `2` | test |\n| `person-use-calm-min` | `%s` | test |\n' "$row" "$1" > "$T/machine-pu.md"
}
pu_machine 10
printf '  100     1 4194304 10.0 /Applications/IDE.app/ide\n  200     1 8388608 90.0 bash -c x desk-worker claude -p go\n' > "$T/ps-pu.out"
pu_pass(){ out=$(AUTOPILOT_PERSON_USE=on AUTOPILOT_PERSON_USE_PS="$T/ps-pu.out" DESK_MACHINE="$T/machine-pu.md" node "$B/pass.mjs" 2>&1); }
pu_pass
# The floor counts every batch's local workers: batch X-1 has one running, so a floor of 2 leaves one.
check "issue-1587 AC3 with the person using the computer, one local worker starts of three ready: the floor of 2, less the sibling batch's running one" \
  '[ $(( $(spawns_of PU-1) + $(spawns_of PU-2) + $(spawns_of PU-3) )) = 1 ]'
check "issue-1587 AC3 AC4 the pass says the mode and why (the IDE counts, the desk worker does not), and records it for desk-q" \
  'echo "$out" | grep -qF "you'"'"'re using this computer: local cap 2, cloud first — other processes hold 4 GB, 3 over the 1 GB baseline" && [ "$(bfield person_use.on)" = true ]'
check "issue-1587 AC4 the started ticket records its place at start, and why" \
  '[ "$(jq -r "[.tickets[] | select(.start_place.where == \"local\") | .start_place.why] | join(\",\")" "$DESK_QUEUE")" = "it must run on this computer" ]'
printf '  100     1 102400 1.0 /Applications/IDE.app/ide\n' > "$T/ps-pu.out"
pu_pass
check "issue-1587 AC3 back under the threshold, the mode stays on until it has stayed under for person-use-calm-min" \
  '[ "$(bfield person_use.on)" = true ] && [ "$(bfield person_use.calm_since)" != null ] && [ $(( $(spawns_of PU-1) + $(spawns_of PU-2) + $(spawns_of PU-3) )) = 1 ]'
pu_machine 0; pu_pass
check "issue-1587 AC3 once it has, the mode switches off and the pass says the local cap is back" \
  '[ "$(bfield person_use.on)" = false ] && echo "$out" | grep -qF "person in use: off, under the threshold for 0 min; the local cap is back"'
for k in PU-1 PU-2 PU-3; do q set "$k" state=done session_id=null; done
# The mode is opt-in per machine. With no person-use row, or `off`, the pass reads nothing,
# keeps no person_use record (clearing one an earlier pass left) and says nothing of it.
printf '  100     1 4194304 10.0 /Applications/IDE.app/ide\n' > "$T/ps-pu.out"
pu_off(){ # pu_off <row value, or - for none> <ticket prefix>
  pu_machine 10 "$1"
  for k in "$2-1" "$2-2" "$2-3"; do q add "$k"; q set "$k" state=triaged lane=A "branch=fix/$k"; done
  q set-batch 'person_use={"on":true,"since":"2026-11-28T00:00:00.000Z","calm_since":null,"gb":4,"cpu":0.1,"floor":2}'
  pu_pass
}
pu_off - PN
check "DS-1058 AC1 with no person-use row and the IDE over the threshold, the local cap is not lowered: more than the floor's one start" \
  '[ $(( $(spawns_of PN-1) + $(spawns_of PN-2) + $(spawns_of PN-3) )) -gt 1 ]'
check "DS-1058 AC1 AC2 and the pass says nothing of it and clears the record desk-q reads" \
  '! echo "$out" | grep -qiE "using this computer|person in use" && [ "$(bfield person_use)" = null ]'
for k in PN-1 PN-2 PN-3; do q set "$k" state=done session_id=null; done
pu_off off PF
check "DS-1058 AC4 with person-use=off, the mode is off and nothing about it is shown" \
  '[ $(( $(spawns_of PF-1) + $(spawns_of PF-2) + $(spawns_of PF-3) )) -gt 1 ] && ! echo "$out" | grep -qiE "using this computer|person in use" && [ "$(bfield person_use)" = null ]'
for k in PF-1 PF-2 PF-3; do q set "$k" state=done session_id=null; done
export DESK_QUEUE="$pu_prev"
rm -f "$T/ps.out" "$T/lsof.out"
rm "$T/desk/bin/queue.mjs"; ln -s "$B/queue.mjs" "$T/desk/bin/queue.mjs"

# ---- DS-757: a pass records its queue changes in one write, one version higher; a spawn's running
# write is in the file before its worker starts. The stub spawn-worker.sh notes what the queue says then.
export DESK_QUEUE="$T/queue-vw.json" DESK_AUTOPILOT_STATE="$T/state-vw"; mkdir -p "$T/state-vw/logs"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1 \$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]].state)' "\$DESK_QUEUE" "\$1")" >> "$T/vw-spawns"; echo "[spawn] ticket=\$1"
EOF
: > "$T/vw-spawns"
q init vw
for k in VW-1 VW-2; do q add "$k"; q set "$k" state=running lane=A "branch=fix/$k" session_id=live-1 stage=1/9; done
say "AUTOPILOT_STAGE: 2/9 understand" > "$T/state-vw/logs/VW-1.log"; say "AUTOPILOT_STAGE: 3/9 implement" > "$T/state-vw/logs/VW-2.log"
v=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$DESK_QUEUE")
out=$(node "$B/pass.mjs" 2>&1)
check "DS-757 AC1 a pass that changes several tickets records them in one write, one version higher" \
  '[ "$(field VW-1 stage)" = "\"2/9\"" ] && [ "$(field VW-2 stage)" = "\"3/9\"" ] && [ "$(bfield version)" = "$((v + 1))" ] && [ "$(bfield pass.at)" != null ]'
q set VW-1 state=done session_id=null; q set VW-2 state=done session_id=null
q add VW-3; q set VW-3 state=triaged lane=A branch=fix/VW-3
out=$(node "$B/pass.mjs" 2>&1)
check "DS-757 AC4 a spawn's running write is in the queue file before its worker starts" 'grep -qx "VW-3 running" "$T/vw-spawns" && echo "$out" | grep -q "spawned: VW-3"'

# ---- A pass holds a ticket whose kept worktree is in use, and spawns it once that clears.
# W-1's worktree is another process's working directory. W-2 and W-3 are fix tries: W-2's worktree
# has an uncommitted change, W-3's branch a commit origin does not have. W-4 is a fix try with only an
# untracked file, which setup-worktree.sh can leave itself: it spawns.
export DESK_QUEUE="$T/queue-wb.json" DESK_AUTOPILOT_STATE="$T/state-wb"; mkdir -p "$T/state-wb/logs" "$T/wt/W-1/src"; : > "$T/wb-spawns"
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1" >> "$T/wb-spawns"; echo "[spawn] ticket=\$1"
EOF
git init -q --bare "$T/wb-origin.git"
for k in 2 3 4; do
  git clone -q "$T/wb-origin.git" "$T/wt/W-$k" 2>/dev/null; git -C "$T/wt/W-$k" checkout -q -b "fix/W-$k"
  echo a > "$T/wt/W-$k/a.txt"; git -C "$T/wt/W-$k" add a.txt; git -C "$T/wt/W-$k" commit -q -m a; git -C "$T/wt/W-$k" push -q origin "fix/W-$k" 2>/dev/null
done
echo b >> "$T/wt/W-2/a.txt"; git -C "$T/wt/W-3" commit -q --allow-empty -m "not pushed"; : > "$T/wt/W-4/settings.local.json.desk-disabled"
printf 'p4242\ncclaude\nfcwd\nn%s/wt/W-1/src\n' "$T" > "$T/lsof.out"
q init wb; q set-batch concurrency=4
q add W-1; q set W-1 state=triaged lane=A branch=fix/W-1
for k in 2 3 4; do q add "W-$k"; q set "W-$k" state=triaged lane=A "branch=fix/W-$k" 'fix={"try":1,"of":2,"pr":5'"$k"',"kind":"review","what":"a P1 review finding"}'; done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-348 AC1 a worktree another process works in is held, naming the pid" \
  '[ "$(field W-1 state)" = "\"triaged\"" ] && ! grep -qx W-1 "$T/wb-spawns" && echo "$out" | grep -qF "W-1: WORKTREE IN USE — its worktree $T/wt/W-1 is the working directory of pid 4242 (claude), which the pass did not start"'
check "DS-348 AC2 a fix try whose worktree has an uncommitted change is held, saying so" \
  '[ "$(field W-2 state)" = "\"triaged\"" ] && ! grep -qx W-2 "$T/wb-spawns" && echo "$out" | grep -qF "W-2: WORKTREE IN USE — its worktree $T/wt/W-2 has uncommitted changes (a.txt)"'
check "DS-348 AC2 a fix try whose branch is ahead of origin is held, saying so" \
  '[ "$(field W-3 state)" = "\"triaged\"" ] && ! grep -qx W-3 "$T/wb-spawns" && echo "$out" | grep -qF "W-3: WORKTREE IN USE — its branch fix/W-3 is 1 commit(s) ahead of origin/fix/W-3, not pushed"'
check "DS-348 an untracked file alone does not hold a fix try" '[ "$(field W-4 state)" = "\"running\"" ] && grep -qx W-4 "$T/wb-spawns"'
check "a held worktree is kept on its ticket, with why, so desk-q and needs-you show it as needing you" \
  'field W-2 worktree_busy.why | grep -qF "its worktree $T/wt/W-2 has uncommitted changes (a.txt)" && field W-1 worktree_busy.why | grep -qF "pid 4242" && field W-3 worktree_busy.why | grep -qF "its branch fix/W-3 is 1 commit(s) ahead of origin/fix/W-3, not pushed" && [ "$(field W-4 worktree_busy)" = null ]'
# desk-q's own rule, read from a script file: desk-q.mjs takes an -e script's arguments for its own.
cat > "$T/shown.mjs" <<'EOF'
const { shownState } = await import(process.argv[2]);
const { readFileSync } = await import('node:fs');
const q = JSON.parse(readFileSync(process.argv[3], 'utf8'));
console.log(shownState(q, q.tickets[process.argv[4]]));
EOF
shown(){ node "$T/shown.mjs" "$B/desk-q.mjs" "$DESK_QUEUE" "$1"; }
check "desk-q groups it as needing you, not ready" '[ "$(shown W-2)" = needs ] && [ "$(shown W-3)" = needs ]'
: > "$T/lsof.out"; git -C "$T/wt/W-2" checkout -q -- a.txt; git -C "$T/wt/W-3" push -q origin fix/W-3 2>/dev/null
# The repo's shared cap leaves this batch one slot a pass here: each spawned worker is finished before the next.
held=""; left=""; stale=""
for k in 1 2 3; do
  for w in W-1 W-2 W-3 W-4; do [ "$(field "$w" state)" = "\"running\"" ] && q set "$w" state=done session_id=null; done
  out=$(node "$B/pass.mjs" 2>&1); echo "$out" | grep -q "WORKTREE IN USE" && held=yes
  # The first pass spawns one of them: the record is dropped from the others, still triaged, because
  # their worktrees are clean now, and they read as ready again.
  if [ "$k" = 1 ]; then
    stale=""
    for w in W-1 W-2 W-3; do
      [ "$(field "$w" state)" = "\"triaged\"" ] || continue
      [ "$(field "$w" worktree_busy)" = null ] && [ "$(shown "$w")" = ready ] || stale="$stale $w"
      left=yes
    done
  fi
done
check "a pass drops the record from a ticket still triaged once its worktree is clean, and it reads as ready" '[ -n "${left:-}" ] && [ -z "$stale" ]'
check "DS-348 AC3 once each cause clears, the next pass spawns the worker" \
  '[ "$(grep -cxE "W-[123]" "$T/wb-spawns")" = 3 ] && [ -z "$held" ]'
check "and the record is dropped from each ticket once its worktree is clean" \
  '[ "$(field W-1 worktree_busy)$(field W-2 worktree_busy)$(field W-3 worktree_busy)" = nullnullnull ]'

# W-5 is a fix try on its open PR whose worker was killed mid-edit, leaving an uncommitted change: its
# own session is resumed, not held. W-6 is a fix try requeued for a fresh worker, with an uncommitted change no worker
# of its own is resuming: still held.
for w in W-1 W-2 W-3 W-4; do q set "$w" state=done; done
: > "$T/wb-spawns"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1 \$3 resume=\${AUTOPILOT_RESUME:+yes}" >> "$T/wb-spawns"; echo "[spawn] ticket=\$1"
EOF
for k in 5 6; do
  git clone -q "$T/wb-origin.git" "$T/wt/W-$k" 2>/dev/null; git -C "$T/wt/W-$k" checkout -q -b "fix/W-$k"
  echo a > "$T/wt/W-$k/a.txt"; git -C "$T/wt/W-$k" add a.txt; git -C "$T/wt/W-$k" commit -q -m a; git -C "$T/wt/W-$k" push -q origin "fix/W-$k" 2>/dev/null
  echo b >> "$T/wt/W-$k/a.txt"; q add "W-$k"
done
q set W-5 state=running lane=A branch=fix/W-5 "worktree=$T/wt/W-5" session_id=sess-w5 port=47760 stage=4/9 'fix={"try":1,"of":2,"pr":55,"kind":"review","what":"a P1 review finding"}'
say "AUTOPILOT_STAGE: 4/9 verify" > "$T/state-wb/logs/W-5.log"; touch -t 202601010000 "$T/state-wb/logs/W-5.log"
q set W-6 state=triaged lane=A branch=fix/W-6 'fix={"try":1,"of":2,"pr":56,"kind":"review","what":"a P1 review finding"}'
printf '#!/bin/sh\ncase "$*" in *"--head fix/W-5"*) echo 55 ;; esac\n' > "$T/stub/gh"
out=$(node "$B/pass.mjs" 2>&1)
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
check "DS-388 AC3 a fix try whose own worker was killed with its worktree dirty is not held, and that session resumes" \
  'grep -qx "W-5 sess-w5 resume=yes" "$T/wb-spawns" && [ "$(field W-5 state)" = "\"running\"" ] && [ "$(field W-5 worktree_busy)" = null ] && ! echo "$out" | grep -q "W-5: WORKTREE IN USE" && echo "$out" | grep -q "W-5 resumed after it was killed" && ! echo "$out" | grep -q "W-5: PR #55"'
check "DS-388 AC4 a fix try whose worktree holds changes no worker of its own is resuming is still held" \
  '[ "$(field W-6 state)" = "\"triaged\"" ] && ! grep -q "^W-6 " "$T/wb-spawns" && echo "$out" | grep -qF "W-6: WORKTREE IN USE — its worktree $T/wt/W-6 has uncommitted changes (a.txt)" && [ "$(field W-6 resume)" = null ]'
# DS-551 AC3: a fix try stopped for a planned reboot with a verified commit not pushed resumes its own
# session after the restart, never held as WORKTREE IN USE.
q set W-5 state=done; q set W-6 state=done
git clone -q "$T/wb-origin.git" "$T/wt/W-8" 2>/dev/null; git -C "$T/wt/W-8" checkout -q -b fix/W-8
echo a > "$T/wt/W-8/a.txt"; git -C "$T/wt/W-8" add a.txt; git -C "$T/wt/W-8" commit -q -m a; git -C "$T/wt/W-8" push -q origin fix/W-8 2>/dev/null
git -C "$T/wt/W-8" commit -q --allow-empty -m "verified, not pushed"; q add W-8
q set W-8 state=running lane=A branch=fix/W-8 "worktree=$T/wt/W-8" session_id=sess-w8 port=47761 stage=7/9 'fix={"try":1,"of":2,"pr":58,"kind":"review","what":"a P1 review finding"}'
{ say "AUTOPILOT_STAGE: 7/9 pr" "AUTOPILOT_REBOOT: voicepa-83 asked at 07:31Z"; result_event; } > "$T/state-wb/logs/W-8.log"
out=$(DESK_BOOT_TIME=$(( $(date +%s) + 60 )) node "$B/pass.mjs" 2>&1)
check "DS-551 AC3 a reboot stop with unpushed commits resumes its own session, not held as worktree in use" \
  'grep -qx "W-8 sess-w8 resume=yes" "$T/wb-spawns" && ! echo "$out" | grep -q "W-8: WORKTREE IN USE" && [ "$(field W-8 worktree_busy)" = null ] && [ "$(field W-8 park)" = null ]'
q set W-8 state=done

# W-7 parked with a commit origin lacks, on a branch origin has never seen; the note goes once it is pushed.
git clone -q "$T/wb-origin.git" "$T/wt/W-7" 2>/dev/null; git -C "$T/wt/W-7" checkout -q -b fix/W-7
git -C "$T/wt/W-7" commit -q --allow-empty -m "not pushed"
q add W-7; q set W-7 lane=A branch=fix/W-7 "worktree=$T/wt/W-7"; q park W-7 "git push was refused: remote rejected"
node "$B/pass.mjs" >/dev/null 2>&1
check "DS-497 a pass keeps what a parked ticket's worktree holds that origin does not on its park" \
  '[ "$(field W-7 park.unpushed)" = "\"its worktree $T/wt/W-7 has 1 commit(s) not on origin\"" ]'
git -C "$T/wt/W-7" push -q origin fix/W-7 2>/dev/null
node "$B/pass.mjs" >/dev/null 2>&1
check "DS-497 and drops it once they are pushed" '[ "$(field W-7 park.unpushed)" = null ] && [ "$(field W-7 state)" = "\"parked\"" ]'

# Commits up to the head the ticket's own last worker left are pushed by the fix try's pass,
# not held. W-9's worker parks with a commit it did not push, and the pass records that head.
wb_clone(){ git clone -q "$T/wb-origin.git" "$T/wt/$1" 2>/dev/null; git -C "$T/wt/$1" checkout -q -b "fix/$1"
  echo a > "$T/wt/$1/a.txt"; git -C "$T/wt/$1" add a.txt; git -C "$T/wt/$1" commit -q -m a; git -C "$T/wt/$1" push -q origin "fix/$1" 2>/dev/null; }
wb_fix(){ q set "$1" state=triaged park=null lane=A "branch=fix/$1" 'fix={"try":1,"of":2,"pr":6'"${1#W-}"',"kind":"review","what":"a P1 review finding"}'; }
wb_clone W-9; git -C "$T/wt/W-9" commit -q --allow-empty -m "merge of main, not pushed"; W9_HEAD=$(git -C "$T/wt/W-9" rev-parse HEAD)
q add W-9; q set W-9 state=running lane=A branch=fix/W-9 "worktree=$T/wt/W-9" session_id=sess-w9 port=47762 stage=7/9
{ say "AUTOPILOT_STAGE: 7/9 pr" "AUTOPILOT_PARK: which colour should the widget be?"; result_event; } > "$T/state-wb/logs/W-9.log"
node "$B/pass.mjs" >/dev/null 2>&1
check "DS-606 a pass that finds a worker exited records the head its worktree was left at" \
  '[ "$(field W-9 state)" = "\"parked\"" ] && [ "$(field W-9 worker_head.sha)" = "\"$W9_HEAD\"" ]'
# W-11 is ahead with a head no worker of its own left; W-12's push is refused by origin; W-13 has an
# uncommitted change on its last worker's head. W-10's origin ref is stale, its head already pushed.
for k in 11 12 13 14 15 16 17 18 19 20; do wb_clone "W-$k"; q add "W-$k"; done
q set W-11 "worker_head={\"sha\":\"$(git -C "$T/wt/W-11" rev-parse HEAD)\"}"; git -C "$T/wt/W-11" commit -q --allow-empty -m "by hand"
git -C "$T/wt/W-12" commit -q --allow-empty -m "worker's"; q set W-12 "worker_head={\"sha\":\"$(git -C "$T/wt/W-12" rev-parse HEAD)\"}"
q set W-13 "worker_head={\"sha\":\"$(git -C "$T/wt/W-13" rev-parse HEAD)\"}"; echo b >> "$T/wt/W-13/a.txt"
wb_clone W-10; git -C "$T/wt/W-10" commit -q --allow-empty -m b; git -C "$T/wt/W-10" push -q origin fix/W-10 2>/dev/null
git -C "$T/wt/W-10" update-ref refs/remotes/origin/fix/W-10 HEAD~1; q add W-10
# W-14's and W-15's last worker rebased its branch: origin has c, the head has its own d before it. W-14's
# head holds c again by its patch; W-15's dropped it. W-16's holds c, but origin also merged a side branch
# (m) after it, a merge git cherry never lists.
for k in 14 15 16; do
  echo c > "$T/wt/W-$k/c.txt"; git -C "$T/wt/W-$k" add c.txt; git -C "$T/wt/W-$k" commit -q -m c
  base=$(git -C "$T/wt/W-$k" rev-parse HEAD); C=$base
  if [ "$k" = 16 ]; then
    git -C "$T/wt/W-$k" checkout -q -b side HEAD~1; echo m > "$T/wt/W-$k/m.txt"; git -C "$T/wt/W-$k" add m.txt; git -C "$T/wt/W-$k" commit -q -m m
    git -C "$T/wt/W-$k" checkout -q "fix/W-$k"; git -C "$T/wt/W-$k" merge -q --no-ff --no-edit side; git -C "$T/wt/W-$k" branch -q -D side
  fi
  git -C "$T/wt/W-$k" push -q origin "fix/W-$k" 2>/dev/null
  git -C "$T/wt/W-$k" reset -q --hard "$base~1"
  echo d > "$T/wt/W-$k/d.txt"; git -C "$T/wt/W-$k" add d.txt; git -C "$T/wt/W-$k" commit -q -m d
  [ "$k" != 15 ] && git -C "$T/wt/W-$k" cherry-pick "$C" >/dev/null
  q set "W-$k" "worker_head={\"sha\":\"$(git -C "$T/wt/W-$k" rev-parse HEAD)\"}"
done
# W-17's worker folded its fix into origin's c with an amend, so c's patch changed; W-18's re-made c by
# hand after a reset, with its fix in another file, so the head still holds c's change. W-19's rebased c,
# then reset away from it and committed e: c is in neither its head nor its tree. W-20's c was amended on
# origin by someone else, author, date and subject kept, after the worker pushed it.
for k in 17 18 19 20; do
  echo c > "$T/wt/W-$k/c.txt"; git -C "$T/wt/W-$k" add c.txt; git -C "$T/wt/W-$k" commit -q -m c
  git -C "$T/wt/W-$k" push -q origin "fix/W-$k" 2>/dev/null
done
echo fix >> "$T/wt/W-17/c.txt"; git -C "$T/wt/W-17" commit -q -a --amend --no-edit
git -C "$T/wt/W-18" reset -q --hard HEAD~1; echo c > "$T/wt/W-18/c.txt"; echo fix > "$T/wt/W-18/e.txt"
git -C "$T/wt/W-18" add c.txt e.txt; git -C "$T/wt/W-18" commit -q -m "c, with its fix"
git -C "$T/wt/W-19" commit -q --amend --no-edit --date=now; git -C "$T/wt/W-19" reset -q --hard HEAD~1
echo e > "$T/wt/W-19/e.txt"; git -C "$T/wt/W-19" add e.txt; git -C "$T/wt/W-19" commit -q -m e
W19_ORIGIN=$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-19)
git clone -q -b fix/W-20 "$T/wb-origin.git" "$T/other-W-20"; echo humanfix >> "$T/other-W-20/c.txt"
git -C "$T/other-W-20" commit -q -a --amend --no-edit; git -C "$T/other-W-20" push -q -f origin fix/W-20 2>/dev/null
echo w > "$T/wt/W-20/w.txt"; git -C "$T/wt/W-20" add w.txt; git -C "$T/wt/W-20" commit -q -m w
W20_ORIGIN=$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-20)
for k in 17 18 19 20; do q set "W-$k" "worker_head={\"sha\":\"$(git -C "$T/wt/W-$k" rev-parse HEAD)\"}"; done
W17_HEAD=$(git -C "$T/wt/W-17" rev-parse HEAD); W18_HEAD=$(git -C "$T/wt/W-18" rev-parse HEAD)
W14_HEAD=$(git -C "$T/wt/W-14" rev-parse HEAD); W15_ORIGIN=$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-15)
W16_ORIGIN=$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-16)
for k in 11 12 13 14 15 16 17 18 19 20 9; do wb_fix "W-$k"; done
printf '#!/bin/sh\nwhile read o n r; do [ "$r" = refs/heads/fix/W-12 ] && { echo "W-12 is protected" >&2; exit 1; }; done; exit 0\n' > "$T/wb-origin.git/hooks/pre-receive"
chmod +x "$T/wb-origin.git/hooks/pre-receive"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-606 with config §3 git-push not yes, its last worker's commits are held, naming the row" \
  '[ "$(field W-9 state)" = "\"triaged\"" ] && ! grep -q "^W-9 " "$T/wb-spawns" && echo "$out" | grep -qF "W-9: WORKTREE IN USE — its branch fix/W-9 is 1 commit(s) ahead of origin/fix/W-9, not pushed: they are its last worker'"'"'s, but config §3 git-push is"'
check "uncommitted changes on its last worker's head are its interrupted worker's: its fix try spawns over them, naming them" \
  '[ "$(field W-13 state)" = "\"running\"" ] && grep -q "^W-13 " "$T/wb-spawns" && [ "$(field W-13 fix.left_dirty)" = "[\"a.txt\"]" ] && ! echo "$out" | grep -q "W-13: WORKTREE IN USE"'
q set W-13 state=done
node -e 'const f = process.argv[1], fs = require("fs"); fs.writeFileSync(process.argv[2], fs.readFileSync(f, "utf8").replace(/^(\| `autopilot-workers` .*\n)/m, "$1| `git-push` | Push | `yes` | `yes` |\n"))' "$T/config.md" "$T/config-gp.md"
out=$(DESK_CONFIG="$T/config-gp.md" node "$B/pass.mjs" 2>&1)
check "DS-606 AC1 a fix try ahead of origin at its last worker's head is pushed, and its worker spawns" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-9)" = "$W9_HEAD" ] && grep -q "^W-9 " "$T/wb-spawns" && [ "$(field W-9 state)" = "\"running\"" ] && [ "$(field W-9 worktree_busy)" = null ] && ! echo "$out" | grep -q "W-9: WORKTREE IN USE"'
check "DS-606 AC3 a fix try ahead with a head no worker of its own left is held, as before" \
  '[ "$(field W-11 state)" = "\"triaged\"" ] && ! grep -q "^W-11 " "$T/wb-spawns" && echo "$out" | grep -qF "W-11: WORKTREE IN USE — its branch fix/W-11 is 1 commit(s) ahead of origin/fix/W-11, not pushed, so no worker was spawned. The next pass looks again"'
check "DS-606 AC4 a refused push of its last worker's head holds it, quoting the push's error" \
  '[ "$(field W-12 state)" = "\"triaged\"" ] && ! grep -q "^W-12 " "$T/wb-spawns" && field W-12 worktree_busy.why | grep -qF "its branch fix/W-12 is 1 commit(s) ahead of origin/fix/W-12, not pushed: they are its last worker'"'"'s, and the pass'"'"'s git push origin fix/W-12 was refused (" && field W-12 worktree_busy.why | grep -qF "W-12 is protected"'
check "a branch its last worker rebased is pushed with a lease on origin's tip when origin's commits are in it by their patch" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-14)" = "$W14_HEAD" ] && grep -q "^W-14 " "$T/wb-spawns" && echo "$out" | grep -qF "W-14: pushed fix/W-14 to ${W14_HEAD:0:9}, the head its last worker rebased it to, with --force-with-lease=fix/W-14:"'
q set W-14 state=done; out=$(DESK_CONFIG="$T/config-gp.md" node "$B/pass.mjs" 2>&1)
check "one that dropped a commit origin has is not overwritten: held, naming the exact lease push" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-15)" = "$W15_ORIGIN" ] && ! grep -q "^W-15 " "$T/wb-spawns" && field W-15 worktree_busy.why | grep -qF "but origin/fix/W-15 has 1 commit(s) the head does not hold by their patch, so the pass does not overwrite them. Check them, then push with git push --force-with-lease=fix/W-15:$W15_ORIGIN origin fix/W-15"'
check "nor one whose origin holds a merge git cherry cannot compare: held, naming it" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-16)" = "$W16_ORIGIN" ] && ! grep -q "^W-16 " "$T/wb-spawns" && field W-16 worktree_busy.why | grep -qF "but origin/fix/W-16 has 1 merge commit(s) the head does not hold, whose resolutions git cherry cannot compare, so the pass does not overwrite them"'
check "a branch whose worker amended its fix into origin's commit is lease-pushed: the commit keeps its author, date and subject" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-17)" = "$W17_HEAD" ] && echo "$out" | grep -qF "W-17: pushed fix/W-17 to ${W17_HEAD:0:9}" && echo "$out" | grep -qF "each is rewritten in it: a commit there keeps its author, author date and subject"'
q set W-17 state=done; out=$(DESK_CONFIG="$T/config-gp.md" node "$B/pass.mjs" 2>&1)
check "and one whose head holds origin's change by its tree, after a reset, is lease-pushed" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-18)" = "$W18_HEAD" ] && echo "$out" | grep -qF "W-18: pushed fix/W-18 to ${W18_HEAD:0:9}" && echo "$out" | grep -qF "the head holds their change"'
q set W-18 state=done; out=$(DESK_CONFIG="$T/config-gp.md" node "$B/pass.mjs" 2>&1)
check "one rewritten, then reset away from origin's commit, is not overwritten: held" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-19)" = "$W19_ORIGIN" ] && field W-19 worktree_busy.why | grep -qF "but origin/fix/W-19 has 1 commit(s) the head does not hold by their patch"'
check "nor one whose commit someone amended on origin, author, date and subject kept: held" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-20)" = "$W20_ORIGIN" ] && field W-20 worktree_busy.why | grep -qF "but origin/fix/W-20 has 1 commit(s) the head does not hold by their patch"'
# W-21's last worker left a commit unpushed while another push's preview build holds §4 Vercel's
# preview-build slot: the pass leaves its push for a later pass, then pushes once the slot is free.
wb_clone W-21; q add W-21; git -C "$T/wt/W-21" commit -q --allow-empty -m "worker's"
q set W-21 "worker_head={\"sha\":\"$(git -C "$T/wt/W-21" rev-parse HEAD)\"}"; wb_fix W-21; W21_HEAD=$(git -C "$T/wt/W-21" rev-parse HEAD)
sed 's/^| Ticket key pattern | `T-\[0-9\]+` |$/&\n| Vercel | `acme` `web: prj_1` |/' "$T/config-gp.md" > "$T/config-gpv.md"
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `preview-build=on` | test |\n' > "$T/machine-pv.md"
pv(){ DESK_CONFIG="$T/config-gpv.md" DESK_MACHINE="$T/machine-pv.md" DESK_LEASE_DIR="$T/leases-pv" "$@"; }
pv node "$B/desk-env.mjs" lease acquire preview-build acme --ttl 600 --no-owner --label "another PR's push" >/dev/null
out=$(pv node "$B/pass.mjs" 2>&1)
check "a push the preview-build slot is taken for waits for a later pass, naming it" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-21)" != "$W21_HEAD" ] && ! grep -q "^W-21 " "$T/wb-spawns" && field W-21 worktree_busy.why | grep -qF "the pass'"'"'s push of them waits on the preview build for acme: the preview-build slot for acme is held by another PR'"'"'s push"'
rm -rf "$T/leases-pv"; out=$(pv node "$B/pass.mjs" 2>&1)
check "once the slot is free the pass pushes, keeping the slot for that push's build under its PR's or branch's label" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-21)" = "$W21_HEAD" ] && grep -q "^W-21 " "$T/wb-spawns" && jq -e "(.leases[0].label | test(\"(@fix/W-21|#[0-9]+)\$\")) and .leases[0].ttl == 1200" "$T/leases-pv/leases.json" >/dev/null'
q set W-21 state=done
# issue-1610: each last worker left c, with a trailer, pushed; c was then rewritten on origin with its
# message and author only (same tree). W-22's worker did nothing more. W-23's and W-24's branches were
# cleaned by the pass's own attribution rewrite, which recorded the rules it enforced; their next worker
# started from that clean head and rebased it under a commit d of its own (trees differ): W-23's d
# carries a trailer, W-24's does not. Real lost work, trees differing, is still lease-pushed (W-14 above).
for k in 22 23 24; do
  wb_clone "W-$k"; q add "W-$k"
  echo c > "$T/wt/W-$k/c.txt"; git -C "$T/wt/W-$k" add c.txt; git -C "$T/wt/W-$k" commit -q -m c -m 'Co-Authored-By: Claude <noreply@anthropic.com>'
  git -C "$T/wt/W-$k" push -q origin "fix/W-$k" 2>/dev/null
  git clone -q -b "fix/W-$k" "$T/wb-origin.git" "$T/other-W-$k"
  GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com git -C "$T/other-W-$k" commit -q --amend --reset-author -m c
  git -C "$T/other-W-$k" push -q -f origin "fix/W-$k" 2>/dev/null
done
# W-24's base, base-W-24, then gained m, someone else's commit with a trailer, and its worker rebased onto it.
git -C "$T/wt/W-24" fetch -q origin fix/W-24; git -C "$T/wt/W-24" reset -q --hard FETCH_HEAD~1
echo m > "$T/wt/W-24/m.txt"; git -C "$T/wt/W-24" add m.txt
GIT_AUTHOR_NAME=o GIT_AUTHOR_EMAIL=o@example.com git -C "$T/wt/W-24" commit -q -m m -m 'Co-Authored-By: Claude <noreply@anthropic.com>'
git -C "$T/wt/W-24" push -q origin HEAD:refs/heads/base-W-24 2>/dev/null
for k in 23 24; do
  git -C "$T/wt/W-$k" fetch -q origin "fix/W-$k"; [ "$k" = 23 ] && git -C "$T/wt/W-$k" reset -q --hard FETCH_HEAD~1
  echo d > "$T/wt/W-$k/d.txt"; git -C "$T/wt/W-$k" add d.txt
  trailer=(); [ "$k" = 23 ] && trailer=(-m 'Co-Authored-By: Claude <noreply@anthropic.com>')
  GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com git -C "$T/wt/W-$k" commit -q -m d ${trailer[@]+"${trailer[@]}"}
  GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com git -C "$T/wt/W-$k" cherry-pick FETCH_HEAD >/dev/null
  q set "W-$k" "pass_rewrite={\"sha\":\"$(git --git-dir="$T/wb-origin.git" rev-parse "refs/heads/fix/W-$k")\",\"branch\":\"fix/W-$k\",\"base\":\"base-W-$k\",\"author\":{\"name\":\"t\",\"email\":\"t@example.com\"},\"strip\":true}"
done
W22_HEAD=$(git -C "$T/wt/W-22" rev-parse HEAD); W22_ORIGIN=$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-22)
W23_ORIGIN=$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-23); W24_HEAD=$(git -C "$T/wt/W-24" rev-parse HEAD)
for k in 22 23 24; do q set "W-$k" "worker_head={\"sha\":\"$(git -C "$T/wt/W-$k" rev-parse HEAD)\"}"; wb_fix "W-$k"; done
out=$(DESK_CONFIG="$T/config-gp.md" node "$B/pass.mjs" 2>&1)
check "issue-1610 AC1 an origin head with the worker's tree is adopted as the ticket's head, not pushed over, and said" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-22)" = "$W22_ORIGIN" ] && [ "$(git -C "$T/wt/W-22" rev-parse HEAD)" = "$W22_ORIGIN" ] && [ "$(field W-22 worker_head.sha)" = "\"$W22_ORIGIN\"" ] && grep -q "^W-22 " "$T/wb-spawns" && echo "$out" | grep -qF "W-22: adopted origin'"'"'s fix/W-22 at ${W22_ORIGIN:0:9} as its head, not pushing ${W22_HEAD:0:9}"'
check "issue-1610 AC2 a push that would put back what the pass's own attribution rewrite removed is never made: held, naming it" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-23)" = "$W23_ORIGIN" ] && ! grep -q "^W-23 " "$T/wb-spawns" && field W-23 worktree_busy.why | grep -qF "a push would put back what the pass'"'"'s own attribution rewrite of fix/W-23 removed (a Co-Authored-By trailer naming Claude or Anthropic in commit"'
check "issue-1610 AC2 a worker's rebase of the pass's rewritten commits that keeps to its rules is still lease-pushed, whoever wrote its moved base" \
  '[ "$(git --git-dir="$T/wb-origin.git" rev-parse refs/heads/fix/W-24)" = "$W24_HEAD" ] && grep -q "^W-24 " "$T/wb-spawns" && echo "$out" | grep -qF "W-24: pushed fix/W-24 to ${W24_HEAD:0:9}, the head its last worker rebased it to"'
q set W-22 state=done; q set W-23 state=done; q set W-24 state=done
q set W-9 state=done; wb_fix W-10
out=$(DESK_CONFIG="$T/config-gp.md" node "$B/pass.mjs" 2>&1)
check "DS-606 AC2 a stale origin ref is fetched first, so a head already on origin is not held" \
  'grep -q "^W-10 " "$T/wb-spawns" && [ "$(field W-10 worktree_busy)" = null ] && ! echo "$out" | grep -q "W-10: WORKTREE IN USE"'
for k in 10 11 12 13 14 15 16 17 18 19 20; do q set "W-$k" state=done; done; rm -f "$T/wb-origin.git/hooks/pre-receive"

# ---- DS-397: routine recoveries the pass settles by script, with no decider and no person -----------
# D-1's branch adds nothing to main, where merged PR #88 names it. P-2 parked on a refused push with its
# PR body in its log. R-1 parked on a scope call it recommends an option for; R-2's recommendation is a
# money call, never taken.
export DESK_QUEUE="$T/queue-rc.json" DESK_AUTOPILOT_STATE="$T/state-rc"; mkdir -p "$T/state-rc/logs"
# Into the §3 table: later sections appended tables of their own after it.
node -e 'const f = process.argv[1], fs = require("fs"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^(\| `autopilot-workers` .*\n)/m, "$1| `git-push` | Push | `yes` | `yes` |\n| `pr-open` | Open a PR | `yes` | `yes` |\n"))' "$T/config.md"
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/rc-gh.log"
case "\$*" in
  *"--state merged --search D-1 in:title"*) echo '[{"number":8,"title":"fix(x): D-10 other","headRefName":"fix/D-10"},{"number":88,"title":"fix(x): D-1 add x","headRefName":"fix/D-1-again"}]' ;;
  *"--state merged --search D-2 in:title"*) echo '[{"number":89,"title":"fix(x): D-2 add x","headRefName":"fix/D-2-again"}]' ;;
  *"--state merged --search"*) echo '[]' ;;
  "pr create"*) echo "https://github.com/acme/widgets/pull/91" ;;
esac
exit 0
EOF
chmod +x "$T/stub/gh"
git init -q --bare -b main "$T/rc-origin.git"
git -C "$T/repo" remote add origin "$T/rc-origin.git"; git -C "$T/repo" push -q origin main:main 2>/dev/null
git -C "$T/repo" worktree add -q -b fix/D-1 "$T/wt/D-1" main
echo x > "$T/wt/D-1/x.txt"; git -C "$T/wt/D-1" add x.txt; git -C "$T/wt/D-1" commit -q -m "fix(x): D-1 add x"
# D-2's local branch adds nothing either, but its copy on origin carries a commit the local one lacks.
git -C "$T/repo" worktree add -q -b fix/D-2 "$T/wt/D-2" main
echo x > "$T/wt/D-2/x.txt"; git -C "$T/wt/D-2" add x.txt; git -C "$T/wt/D-2" commit -q -m "fix(x): D-2 add x"
echo y > "$T/wt/D-2/y.txt"; git -C "$T/wt/D-2" add y.txt; git -C "$T/wt/D-2" commit -q -m "fix(y): D-2 add y"
git -C "$T/wt/D-2" push -q origin fix/D-2 2>/dev/null; D2_REMOTE=$(git -C "$T/wt/D-2" rev-parse HEAD)
git -C "$T/wt/D-2" reset -q --hard HEAD~1; git -C "$T/repo" update-ref -d refs/remotes/origin/fix/D-2
git -C "$T/repo" worktree add -q -b fix/P-2 "$T/wt/P-2" main
echo p > "$T/wt/P-2/p.txt"; git -C "$T/wt/P-2" add p.txt; git -C "$T/wt/P-2" commit -q -m "fix(p): P-2 make p"
# P-3's push is refused as a server error while $T/rc-503 is there.
git -C "$T/repo" worktree add -q -b fix/P-3 "$T/wt/P-3" main
echo q > "$T/wt/P-3/q.txt"; git -C "$T/wt/P-3" add q.txt; git -C "$T/wt/P-3" commit -q -m "fix(q): P-3 make q"
cat > "$T/rc-origin.git/hooks/pre-receive" <<EOF
#!/bin/sh
while read -r _ _ ref; do [ "\$ref" = refs/heads/fix/P-3 ] && [ -f "$T/rc-503" ] && { echo "Internal Server Error" >&2; exit 1; }; done
exit 0
EOF
chmod +x "$T/rc-origin.git/hooks/pre-receive"; touch "$T/rc-503"
git clone -q -b main "$T/rc-origin.git" "$T/rc-other" 2>/dev/null
echo x > "$T/rc-other/x.txt"; git -C "$T/rc-other" add x.txt; git -C "$T/rc-other" commit -q -m "fix(x): D-1 add x, again"; git -C "$T/rc-other" push -q origin HEAD:main 2>/dev/null
q init rc; q set-batch concurrency=4
q add D-1; q set D-1 lane=A branch=fix/D-1 "worktree=$T/wt/D-1"; q park D-1 "D-1: which of the two x files should win?"
q add D-2; q set D-2 lane=A branch=fix/D-2 "worktree=$T/wt/D-2"; q park D-2 "D-2: which of the two x files should win?"
PQ='git push origin fix/P-2 was refused: push it and open the draft (gh pr create --repo acme/widgets --draft --base main --head fix/P-2 --title "fix(p): P-2 make p" --body-file pr-body.md), then post the review and the Jira comment'
q add P-2; q set P-2 lane=A branch=fix/P-2 "worktree=$T/wt/P-2"; q park P-2 "$PQ"
say "AUTOPILOT_PR_BODY_BEGIN:" "## Summary" "Makes p." "AUTOPILOT_PR_BODY_END:" "AUTOPILOT_PARK: $PQ" > "$T/state-rc/logs/P-2.log"
q add P-3; q set P-3 lane=A branch=fix/P-3 "worktree=$T/wt/P-3"; q park P-3 "${PQ//P-2/P-3}"
say "AUTOPILOT_PR_BODY_BEGIN:" "## Summary" "Makes q." "AUTOPILOT_PR_BODY_END:" "AUTOPILOT_PARK: ${PQ//P-2/P-3}" > "$T/state-rc/logs/P-3.log"
# DS-948: P-8's body asks for an issue to be closed later with a closing keyword before it.
mkdir -p "$T/wt-p8"; q add P-8; q set P-8 lane=A branch=fix/P-8 "worktree=$T/wt-p8"; q park P-8 "${PQ//P-2/P-8}"
say "AUTOPILOT_PR_BODY_BEGIN:" "## Summary" "Makes r." "- [ ] Close #1090 after a week of clean main runs." "AUTOPILOT_PR_BODY_END:" "AUTOPILOT_PARK: ${PQ//P-2/P-8}" > "$T/state-rc/logs/P-8.log"
RQ='R-1: widen this PR to cover the CSV export too (recommended), or split the export into a follow-up?'
q add R-1; q set R-1 state=running lane=A branch=fix/R-1 session_id=gone
say "AUTOPILOT_PARK: $RQ" 'AUTOPILOT_PARK_RECOMMENDS: {"options": ["widen this PR", "split it into a follow-up"], "chose": "widen this PR", "category": "scope"}' > "$T/state-rc/logs/R-1.log"
q add R-2; q set R-2 state=running lane=A branch=fix/R-2 session_id=gone
say "AUTOPILOT_PARK: R-2: buy the paid plan (recommended), or stay on free?" 'AUTOPILOT_PARK_RECOMMENDS: {"options": ["buy the paid plan", "stay on free"], "chose": "buy the paid plan", "category": "money"}' > "$T/state-rc/logs/R-2.log"
# DS-912: this pass runs with §4 Vercel set and the preview-build kind on, so each push it makes takes a unit.
node -e 'const [f, g] = process.argv.slice(1), fs = require("fs"); fs.writeFileSync(g, fs.readFileSync(f, "utf8").replace(/^(\| Ticket key pattern .*\n)/m, "$1| Vercel | `acme` |\n"))' "$T/config.md" "$T/config-pv.md"
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `preview-build=on` | test |\n| `preview-build-slots` | `3` | test |\n' > "$T/machine-pv.md"
rm -rf "$T/leases-pv"
out=$(DESK_CONFIG="$T/config-pv.md" DESK_MACHINE="$T/machine-pv.md" DESK_LEASE_DIR="$T/leases-pv" node "$B/pass.mjs" 2>&1)
check "DS-912 a draft the pass opens takes a unit before its push, the unit takes the PR's number once it is open, and P-3's failed push gives its unit back" \
  '[ "$(DESK_LEASE_DIR="$T/leases-pv" node "$B/leases.mjs" list --json 2>/dev/null | jq -r .label | sort | paste -sd, -)" = "acme/widgets#91" ] && grep -q "\"event\":\"release\".*acme/widgets@fix/P-3" "$T/leases-pv/"*.jsonl'
check "DS-397 AC6 a branch adding nothing beyond a merged PR for its key is recorded done on that PR" \
  '[ "$(field D-1 state)" = "\"done\"" ] && [ "$(field D-1 result.pr)" = 88 ] && [ "$(field D-1 park)" = null ] && echo "$out" | grep -qF "D-1: its branch fix/D-1 adds nothing to main, and merged PR #88 (fix(x): D-1 add x) names it: recorded done on that PR, worktree and branch dropped"'
check "DS-397 AC6 its worktree and branch are dropped" '[ ! -e "$T/wt/D-1" ] && ! git -C "$T/repo" rev-parse --verify -q refs/heads/fix/D-1 >/dev/null'
check "DS-397 AC6 a branch whose copy on origin adds a commit is kept, local and remote" \
  '[ "$(field D-2 state)" = "\"parked\"" ] && [ -e "$T/wt/D-2" ] && git -C "$T/repo" rev-parse --verify -q refs/heads/fix/D-2 >/dev/null && [ "$(git -C "$T/rc-origin.git" rev-parse refs/heads/fix/D-2)" = "$D2_REMOTE" ]'
check "DS-397 AC5 a refused push with its PR body in the log is pushed" '[ "$(git -C "$T/rc-origin.git" rev-parse refs/heads/fix/P-2)" = "$(git -C "$T/wt/P-2" rev-parse HEAD)" ]'
check "DS-397 AC5 and its draft opened from that body, with the title its worker gave" \
  'grep -qE "^pr create --repo acme/widgets --draft --base main --head fix/P-2 --title fix\(p\): P-2 make p --body-file .*/state-rc/pr-bodies/P-2.md$" "$T/rc-gh.log" && [ "$(cat "$T/state-rc/pr-bodies/P-2.md")" = "$(printf "## Summary\nMakes p.")" ]'
check "DS-397 AC5 the ticket is recorded done on the draft, naming what its park left" \
  '[ "$(field P-2 state)" = "\"done\"" ] && [ "$(field P-2 result.pr)" = 91 ] && [ "$(field P-2 draft_pr)" = 91 ] && echo "$out" | grep -F "P-2: review read from the PR: " | grep -qF "; PR #91 pushed and opened as a draft by the pass from its worker'"'"'s PR body; what else its park named is not done: git push origin fix/P-2 was refused"'
check "DS-948 AC1 a body with a closing keyword mid-line is not pushed or opened, and the park says which line" \
  '[ "$(field P-8 state)" = "\"parked\"" ] && ! grep -q "fix/P-8" "$T/rc-gh.log" && echo "$out" | grep -qF "P-8: parked on a refused push or draft PR with its PR body in the log, but its PR body has a closing keyword outside a line of its own, which GitHub would act on at merge (line 3: Close #1090): left parked"'
check "DS-397 AC3 a take call with a recommended option is answered with it and requeued" \
  '[ "$(field R-1 state)" != "\"parked\"" ] && [ "$(field R-1 prev_park.question)" = "\"$RQ\"" ] && [ "$(field R-1 auto_answered.chose)" = "\"widen this PR\"" ] && grep -q "^widen this PR. This was the option the last worker recommended" "$T/state-rc/briefings/R-1.md" && echo "$out" | grep -qF "R-1: took the recommended option on its scope call (\"widen this PR\"), answered it and requeued; logged as a decision"'
check "DS-397 AC3 and the decision is logged as taken by the pass" 'jq -e "select(.ticket == \"R-1\" and .chose == \"widen this PR\" and .category == \"scope\" and .source == \"pass\")" "$T/state-rc/decisions.jsonl" >/dev/null'
check "DS-397 AC3 a recommendation in an ask category is never taken" \
  '[ "$(field R-2 state)" = "\"parked\"" ] && [ "$(field R-2 park.recommends)" = null ] && ! grep -q "buy the paid plan" "$T/state-rc/briefings/R-2.md" 2>/dev/null && echo "$out" | grep -qF "R-2: unreadable park recommendation (money is an ask category: ask, never take it)"'
first=$out; out=$(node "$B/pass.mjs" 2>&1)
check "DS-397 a second pass opens no second draft and takes nothing again" '[ "$(grep -c "^pr create" "$T/rc-gh.log")" = 1 ] && [ "$(grep -c "\"R-1\"" "$T/state-rc/decisions.jsonl")" = 1 ] && [ "$(field R-2 state)" = "\"parked\"" ]'
check "DS-496 AC2 a 5xx on the pass's own push records the push as what clears the park, with no recovery" \
  '[ "$(field P-3 state)" = "\"parked\"" ] && [ "$(field P-3 park.recovery)" = null ] && [ "$(field P-3 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"fix/P-3\"}" ] && echo "$first" | grep -qF "P-3: parked on a refused push or draft PR with its PR body in the log, but GitHub still answers 5xx: left parked, and each pass tries the push until it can requeue it" && echo "$out" | grep -qF "P-3: waiting on \"git push origin fix/P-3 succeeds\" (GitHub still answers 5xx): left parked"'
rm "$T/rc-503"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-496 AC2 and the next pass pushes it and requeues it for the steps its park named" '[ "$(git -C "$T/rc-origin.git" rev-parse refs/heads/fix/P-3)" = "$(git -C "$T/wt/P-3" rev-parse HEAD)" ] && [ "$(field P-3 state)" != "\"parked\"" ] && [ "$(field P-3 state)" != "\"done\"" ] && echo "$out" | grep -qF "P-3: \"git push origin fix/P-3 succeeds\" holds: requeued"'
# #1532 AC4: the live red spell's repair, its worker failed with the fix committed and not pushed while main
# is still red, has its branch pushed and its draft opened by the pass (pushRepairFix), not asked about.
RK="base-red-main-20261126175511"; MS=$(git -C "$T/repo" rev-parse main)
git -C "$T/repo" worktree add -q -b "fix/$RK" "$T/wt/$RK" main
echo g > "$T/wt/$RK/guard.txt"; git -C "$T/wt/$RK" add guard.txt; git -C "$T/wt/$RK" commit -q -m "fix(guards): $RK add the missing guard"
printf '{"branch":"main","sha":"%s","checks":[{"name":"tests","sha":"%s","url":null}],"merges":[],"repair_key":"%s","since":"2026-11-26T17:55:11Z","at":"%s"}\n' "$MS" "$MS" "$RK" "$(node -e 'console.log(new Date().toISOString())')" > "$T/state-rc/base-red.json"
q add "$RK"; q set "$RK" state=failed lane=A "branch=fix/$RK" "worktree=$T/wt/$RK"
: > "$T/rc-gh.log"; out=$(node "$B/pass.mjs" 2>&1)
check "#1532 AC4 a red spell's repair left with an unpushed fix is pushed and opened as its draft, titled by its commit" \
  '[ "$(git -C "$T/rc-origin.git" rev-parse "refs/heads/fix/$RK")" = "$(git -C "$T/wt/$RK" rev-parse HEAD)" ] && grep -qE "^pr create --repo acme/widgets --draft --base main --head fix/$RK --title fix\(guards\): $RK add the missing guard --body-file .*/state-rc/pr-bodies/$RK.md$" "$T/rc-gh.log" && grep -qF "Repairs the red main: \"tests\" failed on its latest run there." "$T/state-rc/pr-bodies/$RK.md"'
check "#1532 AC4 and it is recorded done on that draft, and the pass says so" \
  '[ "$(field "$RK" state)" = "\"done\"" ] && [ "$(field "$RK" result.pr)" = 91 ] && [ "$(field "$RK" draft_pr)" = 91 ] && echo "$out" | grep -qF "$RK: its worker left an unpushed fix while main is still red: pushed fix/$RK and opened draft PR #91"'
rm -f "$T/state-rc/base-red.json"

# ---- DS-431: the clones behind §4 Worker read-only repos ------------------------------------------
# acme/web's default branch is not main, and this repo's origin says where its neighbours are. Each
# worker started is a line in $T/spawns.
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1 \${AUTOPILOT_TASK:-}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF
mkdir -p "$T/remotes/acme"; git init -q --bare -b trunk "$T/remotes/acme/web.git"
git clone -q "$T/remotes/acme/web.git" "$T/web-src" 2>/dev/null
git -C "$T/web-src" checkout -q -b trunk
echo one > "$T/web-src/f.txt"; git -C "$T/web-src" add f.txt; git -C "$T/web-src" commit -q -m one; git -C "$T/web-src" push -q origin trunk 2>/dev/null
git -C "$T/repo" remote set-url origin "file://$T/remotes/acme/widgets.git"
REF="$HOME/.desk-autopilot/acme__widgets/ref"
listed(){ { cat "$T/config.md"; printf '\n## 4. Tracker, tools and team\n| Field | Value |\n|---|---|\n| Worker read-only repos | %s |\n' "$1"; } > "$T/config-rr.md"; }
ready(){ q add "$1"; q set "$1" state=triaged lane=A "branch=fix/$1"; }
finish(){ q set "$1" state=done session_id=null; }
export DESK_CONFIG="$T/config-rr.md" DESK_QUEUE="$T/queue-rr.json" DESK_AUTOPILOT_STATE="$T/state-rr"
q init rr; q set-batch concurrency=5
: > "$T/spawns"

listed '`acme/web`'; mkdir -p "$REF/acme__old"; ready R-1; out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 AC1 a listed repo is cloned at its default branch's head before the worker spawns" \
  '[ "$(field R-1 state)" = "\"running\"" ] && [ "$(cat "$REF/acme__web/f.txt")" = one ] && [ "$(git -C "$REF/acme__web" rev-parse HEAD)" = "$(git -C "$T/web-src" rev-parse HEAD)" ]'
check "DS-431 a clone has no remote, so a worker that cds in has nowhere to push" '[ -z "$(git -C "$REF/acme__web" remote)" ] && ! git -C "$REF/acme__web" push origin HEAD 2>/dev/null'
check "DS-431 AC3 a clone no longer listed is deleted, and nothing unlisted is made" '[ "$(ls "$REF")" = acme__web ]'
finish R-1

echo two > "$T/web-src/f.txt"; git -C "$T/web-src" commit -q -am two; git -C "$T/web-src" push -q origin trunk 2>/dev/null
echo junk > "$REF/acme__web/stray.txt"
ready R-2; out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 AC1 the next spawn moves the clone to the new head, and drops anything else in it" \
  '[ "$(field R-2 state)" = "\"running\"" ] && [ "$(cat "$REF/acme__web/f.txt")" = two ] && [ "$(git -C "$REF/acme__web" rev-parse HEAD)" = "$(git -C "$T/web-src" rev-parse HEAD)" ] && [ ! -e "$REF/acme__web/stray.txt" ]'
finish R-2

rm "$REF/acme__web/.git/HEAD"; ready R-3; out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 a clone killed part way is made again" '[ "$(field R-3 state)" = "\"running\"" ] && [ "$(cat "$REF/acme__web/f.txt")" = two ]'
finish R-3

mv "$T/remotes/acme/web.git" "$T/remotes/acme/gone.git"
mkdir -p "$T/state-rr/tickets"; echo text > "$T/state-rr/tickets/c-ticket.md"
q add c-ticket; q set c-ticket state=triaged lane=A branch=fix/c-ticket location=cloud
out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 a cloud ticket does not wait on a refresh" '! echo "$out" | grep -q "c-ticket: read-only repo" && ! field c-ticket park.question | grep -q "read-only repo"'
q drop c-ticket
ready R-4; ready R-5; q set R-5 handoff=pending handoff_stage=4b worktree="$T/wt/R-5"; : > "$T/spawns"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 AC5 a repo that cannot be refreshed parks the ticket, naming the repo and the failure" \
  '[ "$(field R-4 state)" = "\"parked\"" ] && field R-4 park.question | grep -q "read-only repo could not be refreshed.*acme/web: fatal: " && echo "$out" | grep -q "R-4: read-only repo could not be refreshed"'
check "DS-431 AC5 no worker is spawned to read the stale copy, whichever way it would have started" \
  '[ ! -s "$T/spawns" ] && [ "$(field R-5 state)" = "\"parked\"" ] && field R-5 park.question | grep -q "read-only repo could not be refreshed" && [ "$(field R-5 handoff)" = null ] && [ "$(field R-5 handoff_stage)" = "\"4b\"" ]'
q drop R-4; q drop R-5
q set-batch concurrency=1; ready R-8; ready R-9; ready R-10; q set R-8 resume=pending resume_why=x
out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 a killed worker waits with its session kept, and parks take the slots a worker would have" \
  '[ ! -s "$T/spawns" ] && [ "$(field R-8 state)" = "\"triaged\"" ] && [ "$(field R-8 resume)" = "\"pending\"" ] && echo "$out" | grep -q "R-8: read-only repo could not be refreshed.*session is kept" && [ "$(field R-9 state)" = "\"parked\"" ] && [ "$(field R-10 state)" = "\"triaged\"" ]'
q drop R-8; q drop R-9; q drop R-10; q set-batch concurrency=5
mv "$T/remotes/acme/gone.git" "$T/remotes/acme/web.git"

# Every fetch hangs. It writes its arguments, and when it ends, how many whole seconds it ran before
# the pass stopped it, or "answered" if the pass waited the hang out.
mkdir -p "$T/hung-git"; cat > "$T/hung-git/git" <<EOF
#!/bin/sh
case "\$*" in *fetch*)
  s=\$(date +%s); trap 'echo "stopped after \$(( \$(date +%s) - s ))s" >> "$T/hung-ends"; kill \$! 2>/dev/null; exit 143' TERM
  echo "\$*" >> "$T/hung-fetches"
  sleep 30 </dev/null >/dev/null 2>&1 & wait \$!
  echo answered >> "$T/hung-ends"; exit 0;;
esac
exec "$(command -v git)" "\$@"
EOF
chmod +x "$T/hung-git/git"
ready R-11; : > "$T/hung-fetches"; : > "$T/hung-ends"; out=$(PATH="$T/hung-git:$PATH" DESK_READ_REPO_REFRESH_MS=1000 node "$B/pass.mjs" 2>&1)
check "DS-431 a hung remote parks within the refresh's own limit" '[ "$(field R-11 state)" = "\"parked\"" ] && field R-11 park.question | grep -q "acme/web: the refresh ran past its 1 seconds"'
check "DS-779 a hung remote holds the pass for the refresh limit, not for as long as git hangs" \
  '[ -s "$T/hung-ends" ] && [ "$(wc -l < "$T/hung-ends")" = "$(wc -l < "$T/hung-fetches")" ] && ! grep -qv "^stopped after [0-3]s$" "$T/hung-ends"'
check "DS-779 once one remote call runs out, the pass tries no more: the refresh's fetch and one of its own" '[ "$(wc -l < "$T/hung-fetches")" -le 2 ]'
q drop R-11

listed '`none`'; [ -d "$REF/acme__web" ] && had_clone=1; out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 AC3 the row set back to none deletes the clone on a pass with nothing to spawn" '[ "$had_clone" = 1 ] && [ -z "$(ls "$REF")" ]'

listed '`not a repo`'; ready R-6; out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 an item that is not owner/name parks rather than dropping out" '[ "$(field R-6 state)" = "\"parked\"" ] && field R-6 park.question | grep -q "not a repo: it is not owner/name"'
q drop R-6

listed '`none`'; ready R-7; out=$(node "$B/pass.mjs" 2>&1)
check "DS-431 AC4 at none a spawn makes no clone" '[ "$(field R-7 state)" = "\"running\"" ] && [ -z "$(ls "$REF")" ]'

url(){ node --input-type=module -e "import { cloneUrl } from '$B/read-repos.mjs'; console.log(cloneUrl(process.argv[1], 'acme/web'))" "$1"; }
check "DS-431 a clone is addressed by this repo's own transport and host" \
  '[ "$(url git@github.com:me/own.git)" = git@github.com:acme/web.git ] && [ "$(url https://github.com/me/own)" = https://github.com/acme/web ] && [ "$(url ssh://git@ghe.example/me/own.git)" = ssh://git@ghe.example/acme/web.git ] && [ "$(url "")" = https://github.com/acme/web.git ]'

# A migrate that failed in setup reaches the worker's briefing, and one that did not says nothing.
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
echo "[setup-worktree] database=widgets_x_70"
EOF
q --batch X-3 init x3; q --batch X-3 add X-70; q --batch X-3 set X-70 state=triaged
out=$(node "$B/pass.mjs" --batch X-3 2>&1)
X70B=$(find "$T" -path '*briefings/X-70.md' | head -n 1)
check "a clean setup's briefing says nothing about the database" '[ -n "$X70B" ] && ! grep -q "Your database did not migrate" "$X70B"'
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
echo "[setup-worktree] database=widgets_x_8"; echo "[setup-worktree] migrate=failed"
EOF
q --batch X-2 init x2; q --batch X-2 add X-8; q --batch X-2 set X-8 state=triaged
out=$(node "$B/pass.mjs" --batch X-2 2>&1)
X8B=$(find "$T" -path '*briefings/X-8.md' | head -n 1)
check "a failed migrate is in the worker's briefing, naming the database and the log" \
  '[ -n "$X8B" ] && grep -q "Setup could not apply migrations to widgets_x_8" "$X8B" && grep -q ".desk-migrate.log" "$X8B"'

# ---- issue links a worker asks for: AUTOPILOT_LINK, made by the pass under §3 jira-edit
# The fake desk-jira logs each call and links anything but L-404, which does not exist. Its get --json
# reads an issue's links from jira-links-<KEY>.json, none when there is no such file.
cat > "$T/stub/desk-jira" <<EOF
#!/bin/sh
echo "\$*" >> "$T/jira-calls"
case "\$1" in
  link) [ "\$4" = L-404 ] && { echo "desk-jira: Issue Does Not Exist (404)" >&2; exit 1; }; echo "linked: \$2 relates to \$4 (read back)" ;;
  get) printf '{"key":"%s","fields":{"issuelinks":' "\$2"; if [ -f "$T/jira-links-\$2.json" ]; then cat "$T/jira-links-\$2.json"; else printf '[]'; fi; echo '}}' ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$T/stub/desk-jira"
for v in y:yes a:ask; do sed -e "s#^\(| \`pr-images\` .*\)\$#\1\\
| \`jira-edit\` | Edit tickets | \`yes\` | \`${v#*:}\` |#" "$T/config.md" > "$T/config-l${v%%:*}.md"
  printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `L-[0-9]+` |\n' >> "$T/config-l${v%%:*}.md"; done
lrun(){ local k=$1; shift; q add "$k"; q set "$k" state=running "branch=fix/$k" "session_id=gone-$k"; say "$@" > "$T/state-l/logs/$k.log"; }
export DESK_CONFIG="$T/config-ly.md" DESK_QUEUE="$T/queue-l.json" DESK_AUTOPILOT_STATE="$T/state-l"
mkdir -p "$T/state-l/logs"; q init l
lrun L-1 "AUTOPILOT_LINK: L-1 relates-to L-2" "AUTOPILOT_DONE: pr=41 jira=In Review"
lrun L-3 "AUTOPILOT_LINK: L-3 relates-to OT-9" "AUTOPILOT_DONE: pr=43 jira=In Review"
lrun L-4 "AUTOPILOT_LINK: L-4 relates-to L-404" "AUTOPILOT_DONE: pr=44 jira=In Review"
lrun L-5 "AUTOPILOT_LINK: L-5 blocked-by L-2" "AUTOPILOT_DONE: pr=45 jira=In Review"
lrun L-6 "AUTOPILOT_LINK: L-6 relates-to L-2" "AUTOPILOT_PARK: Which empty state copy?"
lrun L-10 "AUTOPILOT_LINK: L-10 relates-to" "AUTOPILOT_DONE: pr=50 jira=In Review"
: > "$T/jira-calls"; out=$(node "$B/pass.mjs" 2>&1)
# A finished ticket with a link not made parks naming why and the command, on its PR, and clears back
# to done once each link is read on Jira.
kept(){ [ "$(field "$1" state)" = '"parked"' ] && field "$1" park.question | grep -qF "Issue links not made: $2" && [ "$(field "$1" park.clears_when.kind)" = '"links-made"' ] && [ "$(field "$1" follow_on)" = null ]; }
check "DS-557 AC1 with §3 jira-edit yes, the pass makes the link, read back, and the ticket is done, not parked" \
  'grep -qx "link L-1 relates-to L-2" "$T/jira-calls" && [ "$(field L-1 state)" = "\"done\"" ] && [ "$(field L-1 park)" = null ] && [ "$(field L-1 follow_on)" = null ] && echo "$out" | grep -qF "L-1 link: linked: L-1 relates to L-2 (read back)"'
check "DS-557 AC1 a worker that parks has its link made too, and its question is its own" \
  'grep -qx "link L-6 relates-to L-2" "$T/jira-calls" && [ "$(field L-6 state)" = "\"parked\"" ] && [ "$(field L-6 park.question)" = "\"Which empty state copy?\"" ] && [ "$(field L-6 follow_on)" = null ]'
check "DS-557 AC3 a link to another project is not made: the ticket parks on its PR with why and the command" \
  '! grep -q "^link L-3" "$T/jira-calls" && kept L-3 "OT-9 is not in L-3'"'"'s project L, so the pass does not link it: desk-jira link L-3 relates-to OT-9" && [ "$(field L-3 result.pr)" = 43 ] && [ "$(field L-3 park.clears_when.pr)" = 43 ] && echo "$out" | grep -qF "L-3: Issue links not made: OT-9" && echo "$out" | grep -qF "records L-3 done again on PR #43 once it reads them on Jira" && ! echo "$out" | grep -qF "its worker said: pr=43 jira=In Review"'
check "DS-557 AC3 a link to a ticket that does not exist keeps desk-jira's reason" \
  'kept L-4 "desk-jira refused it (desk-jira: Issue Does Not Exist (404)): desk-jira link L-4 relates-to L-404"'
check "DS-557 a Blocks link is never made by the pass, and is kept for the person" \
  '! grep -q "^link L-5" "$T/jira-calls" && kept L-5 "a Blocks link changes the order tickets spawn in, so it is yours to make: desk-jira link L-5 blocked-by L-2"'
check "DS-557 AC3 a request that does not read parks with the reason, waiting for an answer" \
  '[ "$(field L-10 state)" = "\"parked\"" ] && field L-10 park.question | grep -qF "Issue links not made: the request does not read" && [ "$(field L-10 park.clears_when.kind)" = "\"none\"" ]'
export DESK_CONFIG="$T/config-la.md"
lrun L-7 "AUTOPILOT_LINK: L-7 relates-to L-2" "AUTOPILOT_DONE: pr=47 jira=In Review"
lrun L-8 "AUTOPILOT_LINK: L-8 relates-to L-2" "AUTOPILOT_PARK: Which empty state copy?"
# A later round's DONE with follow-ons of its own keeps the link step an earlier round left.
lrun L-9 "AUTOPILOT_DONE: pr=49 jira=In Review follow_on=[{\"step\":\"post the note\",\"row\":\"jira-comment\"}]"
q set L-9 'follow_on=[{"step":"Issue link not made: earlier","row":"jira-edit"}]'
: > "$T/jira-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-557 AC2 with §3 jira-edit ask, nothing is linked and the ticket parks with the exact command" \
  '! grep -q "^link" "$T/jira-calls" && kept L-7 "config §3 jira-edit is \\\"ask\\\", so the pass did not make it: desk-jira link L-7 relates-to L-2" && [ "$(field L-7 result.pr)" = 47 ]'
# The person runs the command: the next pass reads the link on Jira and L-7 is done again on its PR.
echo '[{"type":{"name":"Relates","inward":"relates to","outward":"relates to"},"outwardIssue":{"key":"L-2"}}]' > "$T/jira-links-L-7.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-557 AC2 once the person has made the link, the parked ticket goes back to done on its PR" \
  '[ "$(field L-7 state)" = "\"done\"" ] && [ "$(field L-7 park)" = null ] && [ "$(field L-7 result.pr)" = 47 ] && echo "$out" | grep -F "L-7: review read from the PR: " | grep -qF "; issue links L-7 relates-to L-2 made, each read on Jira: recorded done again on PR #47" && [ "$(field L-3 state)" = "\"parked\"" ]'
check "DS-557 AC2 a worker's own park carries the command in its question, and keeps it past the park" \
  '[ "$(field L-8 state)" = "\"parked\"" ] && field L-8 park.question | grep -qF "Which empty state copy?. Issue links not made: config §3 jira-edit is \\\"ask\\\", so the pass did not make it: desk-jira link L-8 relates-to L-2" && field L-8 follow_on | grep -qF "Issue link not made: config §3 jira-edit is \\\"ask\\\", so the pass did not make it: desk-jira link L-8 relates-to L-2"'
# linkThere on five links, in order. A function, as bash brace-expands the object literals in a check's eval.
there(){ node --input-type=module -e "import { linkThere } from '$B/link-requests.mjs'; const dup = { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }; const rel = { name: 'Relates', inward: 'relates to', outward: 'relates to' }; const l = (type) => ({ key: 'L-1', type, other: 'L-2' }); console.log([linkThere([{ type: dup, inwardIssue: { key: 'L-2' } }], l('duplicates')), linkThere([{ type: dup, outwardIssue: { key: 'L-2' } }], l('duplicates')), linkThere([{ type: dup, inwardIssue: { key: 'L-2' } }], l('is-duplicated-by')), linkThere([{ type: rel, inwardIssue: { key: 'L-2' } }], l('relates-to')), linkThere([{ type: rel, outwardIssue: { key: 'L-3' } }], l('relates-to'))].join());"; }
check "DS-557 a links-made park reads direction as desk-jira link does: duplicates is not met by is duplicated by" '[ "$(there)" = "false,true,true,true,false" ]'
check "DS-557 a later round's follow-ons keep the link step an earlier round left" \
  '[ "$(field L-9 follow_on)" = "[{\"step\":\"Issue link not made: earlier\",\"row\":\"jira-edit\"},{\"step\":\"post the note\",\"row\":\"jira-comment\"}]" ]'

# DS-689 AC6: a §4 Append-only paths row that is not a list of path globs is named in the pass report;
# a row of globs is not.
export DESK_QUEUE="$T/queue-ao.json" DESK_AUTOPILOT_STATE="$T/state-ao"; mkdir -p "$T/state-ao/logs"
q init ao
{ cat "$T/config.md"; printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Append-only paths | messages and the locales |\n'; } > "$T/config-ao-bad.md"
{ cat "$T/config.md"; printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Append-only paths | `messages/*.json` |\n'; } > "$T/config-ao.md"
out=$(DESK_CONFIG="$T/config-ao-bad.md" node "$B/pass.mjs" 2>&1)
check "DS-689 AC6 a malformed Append-only paths row is named in the pass report, read as none" \
  'echo "$out" | grep -qF "collisions: config §4 \"Append-only paths\" is not a list of path globs (messages and the locales) — read as none"'
out=$(DESK_CONFIG="$T/config-ao.md" node "$B/pass.mjs" 2>&1)
check "DS-689 AC6 a row of globs is not named" '! echo "$out" | grep -qF "Append-only paths"'

# DS-759: base drift names the tickets still being worked whose worktree is behind main, not done ones.
export DESK_QUEUE="$T/queue-bd.json" DESK_AUTOPILOT_STATE="$T/state-bd"; mkdir -p "$T/state-bd/logs"
q init bd
for k in D-1 D-2; do git -C "$T/repo" worktree add -q -b "fix/$k" "$T/wt/$k" refs/remotes/origin/main; done
git -C "$T/repo" update-ref refs/remotes/origin/main "$(git -C "$T/repo" commit-tree -p refs/remotes/origin/main -m ahead 'refs/remotes/origin/main^{tree}')"
q add D-1; q set D-1 state=done lane=A branch=fix/D-1 "worktree=$T/wt/D-1" result.pr=901
q add D-2; q set D-2 state=running lane=A branch=fix/D-2 "worktree=$T/wt/D-2" session_id=live-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-759 AC8 a running ticket whose worktree is behind main is listed as base drift" 'echo "$out" | grep "^base drift: " | grep -qE "D-2 is [1-9][0-9]* behind main"'
check "DS-759 AC7 a done ticket whose worktree is behind main is not" '! echo "$out" | grep "^base drift: " | grep -qF "D-1"'

# DS-570 AC2: once a PR merges, each criterion its last desk-review (by the §1 handle) left for after the
# merge is a follow-on step on the ticket, which needs-you lists; the steps it had are kept, a review by
# anyone else adds none, and a PR whose review left none gains none.
export DESK_QUEUE="$T/queue-pm.json" DESK_AUTOPILOT_STATE="$T/state-pm" DESK_CONFIG="$T/config-pm.md"; mkdir -p "$T/state-pm/logs"
{ cat "$T/config.md"; printf '\n## 1. Identity\n| Field | Value |\n|---|---|\n| GitHub handle | `ben` |\n'; } > "$T/config-pm.md"
node --input-type=module -e "
import { writeFileSync } from 'node:fs';
import { render, postMergeSection } from '$B/../../skills/desk-review/bin/verdict.mjs';
const sha = 'a'.repeat(40), seats = [{ role: 'correctness', vendor: 'claude', status: 'ran' }];
const results = (o) => ({ sha, round: 1, gaps: 0, skipped_files: 0, seats, findings: [], ...o });
const later = results({ post_merge: [{ gap: 'AC7', needs: 'production', step: 'fill in the switch date at the production relay run' }, { gap: 'AC8', needs: 'staging', step: 'place a test call on staging' }] });
const body = (r) => [render(r), '', postMergeSection(r)].join('\n');
const other = results({ post_merge: [{ gap: 'AC9', needs: 'device', step: 'someone else says so' }] });
const pr = (n, reviews) => JSON.stringify({ state: 'MERGED', url: 'https://github.com/acme/widgets/pull/' + n, mergedAt: '2026-11-10T09:00:00Z', headRefOid: sha, mergeCommit: { oid: 'b'.repeat(40) }, statusCheckRollup: [], reviews });
writeFileSync('$T/pm-702.json', pr(702, [{ author: { login: 'ben' }, state: 'COMMENTED', body: body(results({ gaps: 2 })) }, { author: { login: 'ben' }, state: 'COMMENTED', body: body(later) }, { author: { login: 'mallory' }, state: 'COMMENTED', body: body(other) }]));
writeFileSync('$T/pm-703.json', pr(703, [{ author: { login: 'ben' }, state: 'COMMENTED', body: body(results({})) }]));
writeFileSync('$T/pm-704.json', pr(704, [{ author: { login: 'mallory' }, state: 'COMMENTED', body: body(other) }]));
// DS-787: a review whose post-merge criteria word the worker's two follow steps differently.
const reworded =results({ post_merge: [{ gap: 'AC5', needs: 'production', step: 'manual production run: open Osteopaths in the production portal' }, { gap: 'AC6', needs: 'staging', step: 'staging variable removed: AUTOMATED_TESTS_ENABLED gone from the staging portal Vercel project' }] });
writeFileSync('$T/pm-711.json', pr(711, [{ author: { login: 'ben' }, state: 'COMMENTED', body: body(reworded) }]));
writeFileSync('$T/pm-712.json', pr(712, [{ author: { login: 'ben' }, state: 'COMMENTED', body: body(reworded) }]));
writeFileSync('$T/pm-713.json', pr(713, [{ author: { login: 'ben' }, state: 'COMMENTED', body: body(reworded) }]));
writeFileSync('$T/pm-714.json', pr(714, [{ author: { login: 'ben' }, state: 'COMMENTED', body: body(reworded) }]));
"
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr view 702 "*) cat "$T/pm-702.json" ;;
  "pr view 703 "*) cat "$T/pm-703.json" ;;
  "pr view 704 "*) cat "$T/pm-704.json" ;;
  "pr view 711 "*) cat "$T/pm-711.json" ;;
  "pr view 712 "*) cat "$T/pm-712.json" ;;
  "pr view 713 "*) cat "$T/pm-713.json" ;;
  "pr view 714 "*) cat "$T/pm-714.json" ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/stub/gh"
q init pm
q add PM-1; q set PM-1 state=done result.pr=702
q add PM-2; q set PM-2 state=done result.pr=703
q add PM-3; q set PM-3 state=done result.pr=704
q add PM-10; q set PM-10 state=done result.pr=711 \
  'follow_on=[{"step":"after the promotion, open Osteopaths in the production portal","row":null},{"step":"after the promotion, delete AUTOMATED_TESTS_ENABLED from the staging portal Vercel project","row":null}]'
q add PM-11; q set PM-11 state=done result.pr=712 'follow_on=[{"step":"Issue link not made: PM-11 blocks PM-12","row":"jira-edit"}]'
q add PM-13; q set PM-13 state=done result.pr=713 post_merge_read=709 \
  'follow_on=[{"step":"Check after the merge: AC2 (needs device): play the clip on a phone","row":null}]'
# DS-788: an earlier PR's unrun criteria worded as the new PR's: the same words under another gate are another step.
q add PM-14; q set PM-14 state=done result.pr=714 post_merge_read=710 \
  'follow_on=[{"step":"manual production run: open Osteopaths in the production portal","row":null,"from":"review","after":"main"},{"step":"staging variable removed: AUTOMATED_TESTS_ENABLED gone from the staging portal Vercel project","row":null,"from":"review","after":"main"}]'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
pending(){ node --input-type=module -e "import { readFileSync } from 'node:fs'; import { followOnPending } from '$B/harvest.mjs'; console.log(followOnPending(JSON.parse(readFileSync('$DESK_QUEUE', 'utf8')).tickets['$1']))"; }
check "DS-570 AC2 DS-785 AC2 DS-787 AC2 a merged PR whose worker declared no follow step lists its post-merge criteria, naming no §3 row, gated on production or main as each needs" \
  '[ "$(field PM-1 follow_on | jq -c "[.[] | [.step, .row]]")" = "[[\"fill in the switch date at the production relay run\",null],[\"place a test call on staging\",null]]" ] && [ "$(field PM-1 follow_on | jq -c "[.[] | .after]")" = "[\"production\",\"main\"]" ] && echo "$out" | grep -qF "merge recorded: PM-1 (PR #702): 2 criteria its review left for after the merge, now follow-on steps"'
check "DS-788 AC5 a post-merge criterion is stored as its step alone, with no review prefix, marked as the review's" \
  '! field PM-1 follow_on | grep -qE "Check after the merge|Verification:|\(needs " && [ "$(field PM-1 follow_on | jq -c "[.[] | .from]")" = "[\"review\",\"review\"]" ]'
check "DS-787 AC1 a merged PR whose worker declared follow steps keeps only those, adding none of its review's post-merge criteria" \
  '[ "$(field PM-10 follow_on | jq -c "[.[].step]")" = "[\"after the promotion, open Osteopaths in the production portal\",\"after the promotion, delete AUTOMATED_TESTS_ENABLED from the staging portal Vercel project\"]" ] && [ "$(field PM-10 post_merge_read)" = 711 ] && ! echo "$out" | grep -qF "merge recorded: PM-10 (PR #711): 2 criteria"'
check "DS-787 AC3 a ticket whose only follow steps are link steps gains the post-merge criteria after them" \
  '[ "$(field PM-11 follow_on | jq -c "[.[].step]")" = "[\"Issue link not made: PM-11 blocks PM-12\",\"manual production run: open Osteopaths in the production portal\",\"staging variable removed: AUTOMATED_TESTS_ENABLED gone from the staging portal Vercel project\"]" ]'
check "DS-787 a requeued ticket whose only kept steps are an earlier PR's unrun criteria gains the new PR's criteria after them" \
  '[ "$(field PM-13 follow_on | jq -c "[.[].step]")" = "[\"Check after the merge: AC2 (needs device): play the clip on a phone\",\"manual production run: open Osteopaths in the production portal\",\"staging variable removed: AUTOMATED_TESTS_ENABLED gone from the staging portal Vercel project\"]" ] && [ "$(field PM-13 post_merge_read)" = 713 ]'
check "DS-788 a kept criterion worded as a new one is that one only under the same gate: a production criterion is added beside a main one worded the same" \
  '[ "$(field PM-14 follow_on | jq -c "[.[] | .after]")" = "[\"main\",\"main\",\"production\"]" ] && [ "$(field PM-14 follow_on | jq -r ".[2].step")" = "manual production run: open Osteopaths in the production portal" ]'
check "DS-570 AC2 so needs-you lists them as the ticket's follow item" '[ "$(pending PM-1)" = true ]'
check "DS-785 the pass keeps the merged PR's merge commit, which needs-you judges a gated step by" \
  '[ "$(field PM-1 pr_status.merge_commit)" = "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"" ]'
check "DS-570 a review that left none, or one by anyone but the §1 handle, adds no follow-on step" \
  '[ "$(field PM-2 merged_at)" != null ] && [ "$(field PM-2 follow_on)" = null ] && [ "$(field PM-3 follow_on)" = null ] && [ "$(pending PM-3)" = false ]'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
# The one call a settled pass still makes is DS-836's list of the handle's open PRs (ticketless PRs): it
# reads no merged PR again.
# A merged PR's stage read (merge-stages.mjs) is the next of the backlog each pass, never one read before.
check "DS-570 the next pass reads no PR again and adds no step twice" '! grep -v "^pr list .* --author ben " "$T/gh-calls" | grep -v "mergedAt timelineItems" | grep -q . &&[ "$(field PM-1 follow_on.length)" = 2 ] && [ "$(field PM-10 follow_on.length)" = 2 ] && [ "$(field PM-11 follow_on.length)" = 3 ] && [ "$(field PM-13 follow_on.length)" = 3 ] && [ "$(field PM-14 follow_on.length)" = 3 ]'
# A merge recorded before the pass read it still gains its steps: the merge driver's (merged_at set, its
# kept status still open), and needs-you's done or a hand-shipped ticket's (the kept status set merged,
# carrying the criteria an earlier read of the open PR kept).
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('$T/pm-705.json', readFileSync('$T/pm-702.json', 'utf8').replaceAll('/pull/702', '/pull/705'));
writeFileSync('$T/pm-710.json', JSON.stringify({ ...JSON.parse(readFileSync('$T/pm-702.json', 'utf8')), reviews: [], url: 'https://github.com/acme/widgets/pull/710' }));
const open = JSON.parse(readFileSync('$T/pm-702.json', 'utf8'));
writeFileSync('$T/pm-709.json', JSON.stringify({ ...open, state: 'OPEN', mergedAt: '0001-01-01T00:00:00Z', url: open.url.replace('/pull/702', '/pull/709') }));
"
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr view 705 "*) cat "$T/pm-705.json" ;;
  "pr view 709 "*) cat "$T/pm-709.json" ;;
  "pr view 710 "*) cat "$T/pm-710.json" ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
kept='[{"step":"Check after the merge: AC7 (needs production): fill in the switch date","row":null}]'
q add PM-4; q set PM-4 state=done result.pr=705 merged_at=2026-11-10T09:00:00Z 'pr_status={"pr":705,"state":"OPEN","checks":[]}'
q add PM-5; q set PM-5 state=done result.pr=706 "pr_status={\"pr\":706,\"state\":\"MERGED\",\"merged_at\":\"2026-11-10T09:00:00Z\",\"checks\":[],\"post_merge\":$kept}"
q add PM-6; q set PM-6 state=done result.pr=707 merged_at=2026-11-10T09:00:00Z "pr_status={\"pr\":707,\"state\":\"MERGED\",\"merged_at\":\"2026-11-10T09:00:00Z\",\"checks\":[],\"post_merge\":$kept}"
q add PM-7; q set PM-7 state=done result.pr=708 merged_at=2026-11-01T09:00:00Z follow_on_done=2026-11-02T09:00:00Z \
  'follow_on=[{"step":"run the backfill","row":"jira-comment"}]' \
  "pr_status={\"pr\":708,\"state\":\"MERGED\",\"merged_at\":\"2026-11-10T09:00:00Z\",\"checks\":[],\"post_merge\":$kept}"
q add PM-8; q set PM-8 state=done result.pr=709
# A merge needs-you's done recorded carries no merge commit: a step gated on production has its PR read
# again for one, and a step with no gate does not (PM-6 above).
q add PM-9; q set PM-9 state=done result.pr=710 merged_at=2026-11-10T09:00:00Z 'pr_status={"pr":710,"state":"MERGED","merged_at":"2026-11-10T09:00:00Z","checks":[]}' \
  'follow_on=[{"step":"open the portal","row":null,"after":"production"}]'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-785 a merge recorded with no merge commit, owing a gated follow step, has its PR read again for the commit" \
  'grep -qE "pr view 710 " "$T/gh-calls" && [ "$(field PM-9 pr_status.merge_commit)" = "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"" ] && [ "$(field PM-9 follow_on.length)" = 1 ]'
check "DS-570 an open PR's kept status carries its post-merge criteria, and they are no follow-on step before the merge" \
  '[ "$(field PM-8 pr_status.post_merge.length)" = 2 ] && [ "$(field PM-8 follow_on)" = null ]'
check "DS-570 AC2 a requeued ticket whose earlier follow-on item was run lists its new PR's post-merge steps alone" \
  '[ "$(field PM-7 follow_on | jq -c "[.[].step]")" = "[\"fill in the switch date\"]" ] && [ "$(field PM-7 follow_on_done)" = null ] && [ "$(pending PM-7)" = true ]'
check "DS-570 AC2 a PR the merge driver merged and recorded first still gains its post-merge steps" \
  '[ "$(field PM-4 follow_on.length)" = 2 ] && [ "$(field PM-4 merged_at)" = "\"2026-11-10T09:00:00Z\"" ] && [ "$(pending PM-4)" = true ]'
check "DS-570 AC2 a merge needs-you or a hand-ship recorded gains the steps its kept status names, reading no PR" \
  '[ "$(field PM-5 follow_on | jq -c "[.[].step]")" = "[\"fill in the switch date\"]" ] && [ "$(field PM-5 merged_at)" != null ] && [ "$(field PM-6 follow_on.length)" = 1 ] && ! grep -qE "pr view 70[67] " "$T/gh-calls"'
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-570 and once they are follow-on steps, no pass reads those PRs or adds them again" \
  '! grep -qE "pr view (70[4-8]|710) " "$T/gh-calls" && [ "$(field PM-4 follow_on.length)" = 2 ] && [ "$(field PM-5 follow_on.length)" = 1 ] && [ "$(field PM-6 follow_on.length)" = 1 ] && [ "$(field PM-7 follow_on.length)" = 1 ]'
# DS-796: one PR recorded on two tickets, by the pass's shippedElsewhere on PM-15 (queued first) and by
# the merge driver's shipped_pr on PM-16. Both get its status from one read, so neither owes it for good.
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('$T/pm-715.json', readFileSync('$T/pm-702.json', 'utf8').replaceAll('/pull/702', '/pull/715'));
writeFileSync('$T/pm-716.json', readFileSync('$T/pm-702.json', 'utf8').replaceAll('/pull/702', '/pull/716'));
"
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr view 715 "*) cat "$T/pm-715.json" ;;
  "pr view 716 "*) cat "$T/pm-716.json" ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
q add PM-15; q set PM-15 state=done result.pr=715
q add PM-16; q set PM-16 state=done result.pr=715 shipped_pr=715 merged_at=2026-11-10T09:00:00Z
# PR 716's criteria were already taken by PM-19 (its follow item since run): PM-18, recorded on it later
# with a lower key, takes none.
q add PM-18; q set PM-18 state=done result.pr=716 shipped_pr=716 merged_at=2026-11-10T09:00:00Z
q add PM-19; q set PM-19 state=done result.pr=716 merged_at=2026-11-10T09:00:00Z post_merge_read=716
unmade(){ node --input-type=module -e "import { readFileSync } from 'node:fs'; import { postMergeUnmade } from '$B/harvest.mjs'; console.log(postMergeUnmade(JSON.parse(readFileSync('$DESK_QUEUE', 'utf8')).tickets['$1']))"; }
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-796 a PR recorded on two tickets is read once, and each keeps its status, so the merge driver's owes its review no longer" \
  '[ "$(grep -c "pr view 715 " "$T/gh-calls")" = 1 ] && [ "$(field PM-15 pr_status.pr)" = 715 ] && [ "$(field PM-16 pr_status.pr)" = 715 ] && [ "$(field PM-16 post_merge_read)" = 715 ] && [ "$(unmade PM-16)" = false ] && [ "$(unmade PM-15)" = false ]'
check "DS-796 and its review's post-merge criteria go to one of the two tickets, so the person is not asked for each twice" \
  '[ "$(field PM-15 follow_on.length)" = 2 ] && [ "$(field PM-16 follow_on)" = null ] && [ "$(field PM-16 post_merge_by)" = "\"PM-15\"" ] && [ "$(field PM-15 post_merge_by)" = null ]'
check "DS-796 a ticket recorded on a PR whose criteria another ticket already took takes none, whatever its key" \
  '[ "$(field PM-18 follow_on)" = null ] && [ "$(field PM-18 post_merge_read)" = 716 ] && [ "$(field PM-18 post_merge_by)" = "\"PM-19\"" ] && [ "$(unmade PM-18)" = false ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-796 nor on a later pass" '[ "$(field PM-15 follow_on.length)" = 2 ] && [ "$(field PM-16 follow_on)" = null ]'
# PR 717 is also recorded on PM-20, archived and never given its criteria (a requeued ticket re-shipped
# on it): an archived ticket is never written, so the live PM-21 takes them, whatever the keys.
# PR 718's lower key PM-22 keeps a merged status naming no criteria (needs-you's done), so the pass skips
# it, and PM-23, which reads the PR, writes PM-22's share before stamping itself.
# PR 719's lower key PM-24 was recorded done on another repo's PR #719 (needs-you's elsewhereDone), and
# PR 720's lower key PM-26 is archived on it and readmitted, queued: neither takes the criteria.
node --input-type=module -e "
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
for (const n of [717, 718, 719, 720, 721]) writeFileSync('$T/pm-' + n + '.json', readFileSync('$T/pm-702.json', 'utf8').replaceAll('/pull/702', '/pull/' + n));
// PR 722 as GitHub names it after the repo was renamed: the remote still says acme/widgets.
writeFileSync('$T/pm-722.json', readFileSync('$T/pm-702.json', 'utf8').replaceAll('acme/widgets/pull/702', 'acme/renamed/pull/722'));
const f = '${DESK_QUEUE%.json}.archive.json';
const a = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { tickets: {} };
const gone = (key, pr) => ({ key, type: 'Task', lane: 'A', state: 'done', park: null, result: { pr }, merged_at: '2026-11-10T09:00:00Z',
  pr_status: { pr, state: 'MERGED', merged_at: '2026-11-10T09:00:00Z', checks: [] }, archived_at: '2026-11-10T10:00:00Z' });
a.tickets['PM-20'] = gone('PM-20', 717);
a.tickets['PM-26'] = gone('PM-26', 720);
writeFileSync(f, JSON.stringify(a));
"
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr view 717 "*) cat "$T/pm-717.json" ;;
  "pr view 718 "*) cat "$T/pm-718.json" ;;
  "pr view 719 "*) cat "$T/pm-719.json" ;;
  "pr view 720 "*) cat "$T/pm-720.json" ;;
  "pr view 721 "*) cat "$T/pm-721.json" ;;
  "pr view 722 "*) cat "$T/pm-722.json" ;;
  "pr list "*) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
# PR 721's PM-29, reached first, keeps criteria from before the last review; its owner PM-28 has no status.
q add PM-29; q set PM-29 state=done result.pr=721 merged_at=2026-11-10T09:00:00Z \
  'pr_status={"pr":721,"state":"MERGED","merged_at":"2026-11-10T09:00:00Z","url":"https://github.com/acme/widgets/pull/721","checks":[],"post_merge":[{"step":"a criterion the last review dropped"}]}'
q add PM-28; q set PM-28 state=done result.pr=721 merged_at=2026-11-10T09:00:00Z
q add PM-30; q set PM-30 state=done result.pr=722
q add PM-21; q set PM-21 state=done result.pr=717 merged_at=2026-11-10T09:00:00Z
q add PM-22; q set PM-22 state=done result.pr=718 merged_at=2026-11-10T09:00:00Z 'pr_status={"pr":718,"state":"MERGED","merged_at":"2026-11-10T09:00:00Z","merge_commit":"c","checks":[]}'
q add PM-23; q set PM-23 state=done result.pr=718 shipped_pr=718 merged_at=2026-11-10T09:00:00Z
q add PM-24; q set PM-24 state=done result.pr=719 merged_at=2026-11-10T09:00:00Z 'pr_status={"pr":719,"state":"MERGED","merged_at":"2026-11-10T09:00:00Z","url":"https://github.com/acme/elsewhere/pull/719"}'
q add PM-25; q set PM-25 state=done result.pr=719 merged_at=2026-11-10T09:00:00Z
q add PM-26; q set PM-26 state=queued result.pr=720
q add PM-27; q set PM-27 state=done result.pr=720 merged_at=2026-11-10T09:00:00Z
out=$(node "$B/pass.mjs" 2>&1)
check "DS-796 an archived ticket on the PR that never took its criteria is not their owner: the live ticket takes them" \
  '[ "$(field PM-21 follow_on.length)" = 2 ] && [ "$(field PM-21 post_merge_by)" = null ] && [ "$(field PM-21 post_merge_read)" = 717 ] && [ "$(field PM-20 follow_on)" = null ]'
check "DS-796 a ticket done on a PR of the same number in another repo is not their owner either: the ticket on this repo takes them" \
  '[ "$(field PM-25 follow_on.length)" = 2 ] && [ "$(field PM-25 post_merge_by)" = null ] && [ "$(field PM-24 follow_on)" = null ] && [ "$(field PM-24 post_merge_read)" = null ]'
check "DS-796 a shared PR gives its owner the criteria of a read this pass, not those another ticket kept from before the last review" \
  '[ "$(field PM-28 follow_on | jq -c "[.[].step]")" = "[\"fill in the switch date at the production relay run\",\"place a test call on staging\"]" ] && [ "$(field PM-29 post_merge_by)" = "\"PM-28\"" ] && [ "$(field PM-29 follow_on)" = null ] && [ "$(grep -c "pr view 721 " "$T/gh-calls")" = 1 ]'
check "DS-796 a PR GitHub names under the renamed repo still gives its ticket the criteria" \
  '[ "$(field PM-30 follow_on.length)" = 2 ] && [ "$(field PM-30 post_merge_read)" = 722 ]'
check "DS-796 nor is a readmitted ticket, by its archived entry: the done ticket takes them and the queued one is left alone" \
  '[ "$(field PM-27 follow_on.length)" = 2 ] && [ "$(field PM-27 post_merge_by)" = null ] && [ "$(field PM-26 follow_on)" = null ] && [ "$(field PM-26 post_merge_read)" = null ] && [ "$(field PM-26 state)" = "\"queued\"" ]'
check "DS-796 an owner the pass does not read for itself is given its criteria by the ticket that reads the PR, before that one names it" \
  '[ "$(field PM-22 follow_on.length)" = 2 ] && [ "$(field PM-22 post_merge_read)" = 718 ] && [ "$(field PM-23 follow_on)" = null ] && [ "$(field PM-23 post_merge_by)" = "\"PM-22\"" ] && [ "$(grep -c "merge recorded: PM-22 (PR #718): 2 criteria" <<<"$out")" = 1 ]'

# Pass metrics: MX-2 collides with the running MX-1 on src/a.ts, and MX-3 is eligible while the memory
# gate holds every spawn.
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `5 / 8` |\n| Per-file collision budget | x | `1` |\n'; } > "$T/config-mx.md"
export DESK_CONFIG="$T/config-mx.md" DESK_QUEUE="$T/queue-mx.json" DESK_AUTOPILOT_STATE="$T/state-mx"; mkdir -p "$T/state-mx/logs" "$T/state-mx/triage"
printf '{"files_in_scope":["src/a.ts","src/b.ts"]}\n' > "$T/state-mx/triage/MX-1.json"
printf '{"files_in_scope":["src/a.ts"]}\n' > "$T/state-mx/triage/MX-2.json"
printf '{"files_in_scope":["src/c.ts"]}\n' > "$T/state-mx/triage/MX-3.json"
q init mx; q set-batch concurrency=5 concurrency_by=user pass.collision_streak=9 pass.collision_warned=false
q add MX-1; q set MX-1 state=running branch=fix/MX-1 session_id=live-1
q add MX-2; q set MX-2 state=triaged branch=fix/MX-2 collides_with=MX-1
q add MX-3; q set MX-3 state=triaged branch=fix/MX-3
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
ml=$(tail -n 1 "$T/state-mx/passes.jsonl" 2>/dev/null)
check "DS-758 AC1 a pass appends one metrics line with its time, repo, batch, counts, spawns, duration and queue-write failures" \
  '[ "$(wc -l < "$T/state-mx/passes.jsonl")" -eq 1 ] && echo "$ml" | jq -e ".at and (.repo | type == \"string\") and has(\"batch\") and .running == 1 and .eligible == 1 and .spawned == 0 and (.duration_ms | type == \"number\") and .queue_write_failures == 0 and (.held | keys) == [\"collision\",\"lock\",\"memory\",\"usage\"]" >/dev/null'
check "DS-758 AC2 a ticket held for memory counts under memory, not collision" \
  'echo "$ml" | jq -e ".held.memory == 1 and .held.collision == 1" >/dev/null'
check "DS-758 the line names the held ticket, the running one holding it and the file" \
  'echo "$ml" | jq -e ".collisions == [{\"key\":\"MX-2\",\"with\":[\"MX-1\"],\"files\":[\"src/a.ts\"],\"holds\":[{\"file\":\"src/a.ts\",\"k\":1,\"with\":[\"MX-1\"]}]}]" >/dev/null'
check "the pass opens a stuck interval for each ticket a hold kept waiting, with its cause, from the pass's time" \
  '[ "$(jq -sc "map(select(.end == null) | [.key, .cause, .start == .recorded]) | sort" "$T/state-mx/stuck-intervals.jsonl")" = "[[\"MX-2\",\"collision\",true],[\"MX-3\",\"memory: low available\",true]]" ]'
check "DS-758 AC4 after nine such passes, this 10th one (1 of 5 running) carries the warning, stamped when written" \
  'echo "$ml" | jq -e ".concurrency == 5 and (.warning | test(\"^10 passes in a row .*MX-2 \\\\(behind MX-1 on src/a.ts\\\\)\")) and .warned_at >= .at" >/dev/null && echo "$out" | grep -q "^collision warning (sent to the check-in digest): 10 passes"'
check "DS-758 the queue's pass record carries the streak and the warning on to the next pass" \
  '[ "$(jq -c "[.pass.collision_streak, .pass.collision_warned]" "$DESK_QUEUE")" = "[10,true]" ]'
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-758 AC1 the next pass appends a second line" '[ "$(wc -l < "$T/state-mx/passes.jsonl")" -eq 2 ]'
check "DS-758 AC5 the 11th pass in a row gives no second warning" \
  '! tail -n 1 "$T/state-mx/passes.jsonl" | jq -e "has(\"warning\")" >/dev/null && [ "$(jq -c "[.pass.collision_streak, .pass.collision_warned]" "$DESK_QUEUE")" = "[11,true]" ]'
q set-batch concurrency=4 concurrency_by=user
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1)
check "DS-758 AC6 a pass where it clears (1 of 4 running is 25%) resets the streak and the warning" \
  '[ "$(jq -c "[.pass.collision_streak, .pass.collision_warned]" "$DESK_QUEUE")" = "[0,false]" ]'
rm -f "$T/state-mx/passes.jsonl"; mkdir -p "$T/state-mx/passes.jsonl"
out=$(AUTOPILOT_MIN_AVAIL_GB=100000 node "$B/pass.mjs" 2>&1); code=$?
check "DS-758 AC3 a metrics file that cannot be written: the pass completes and its report says so" \
  'echo "$out" | grep -q "metrics: this pass.s metrics line was not written to $T/state-mx/passes.jsonl" && echo "$out" | grep -q "^memory: vmmem=" && [ "$code" -ne 1 ] && [ "$(jq -r .pass.at "$DESK_QUEUE")" != null ]'

# ---- a cloud ticket's tracker steps: made by the pass, since the session has no tracker access ------
# The fake desk-jira logs each call: C-1 and C-2 are In Progress with a transition to In Review, C-3 is
# already In Review. C-2's config does not grant jira-transition.
cat > "$T/stub/desk-jira" <<EOF
#!/bin/sh
echo "\$*" >> "$T/cj-calls"
case "\$1" in
  comments) [ -f "$T/cj-said-\$2" ] && cat "$T/cj-said-\$2"; exit 0 ;;
  comment) echo "\$3" > "$T/cj-said-\$2" ;;
  get) [ "\$2" = C-3 ] && s="In Review" || s="In Progress"; printf '{"key":"%s","fields":{"status":{"name":"%s"}}}\n' "\$2" "\$s" ;;
  transitions) printf '21\tStart review\t-> In Review\n31\tClose\t-> Done\n' ;;
  transition) echo "\$2 -> In Review" ;;
esac
EOF
chmod +x "$T/stub/desk-jira"
for v in y:yes a:ask; do sed -e "s#^\(| \`pr-images\` .*\)\$#\1\\
| \`jira-comment\` | Comment | \`yes\` | \`yes\` |\\
| \`jira-transition\` | Move | \`yes\` | \`${v#*:}\` |#" "$T/config.md" > "$T/config-cj${v%%:*}.md"
  printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `C-[0-9]+` |\n| Review state | `In Review` |\n| Done state | `Done` |\n' >> "$T/config-cj${v%%:*}.md"; done
export DESK_QUEUE="$T/queue-cj.json" DESK_AUTOPILOT_STATE="$T/state-cj"; mkdir -p "$T/state-cj/logs"; q init cj
for k in C-1 C-3; do q add "$k"; q set "$k" state=done location=cloud "result.pr=5${k#C-}" tracker_steps=due; done
out=$(DESK_CONFIG="$T/config-cjy.md" node "$B/pass.mjs" 2>&1)
check "a cloud ticket's PR-link comment and its move to §4 Review state are made by the pass" \
  'grep -qx "comment C-1 PR #51, opened by a cloud session: https://github.com/acme/widgets/pull/51 (C-1/desk-autopilot cloud PR)" "$T/cj-calls" && grep -qx "transition C-1 21" "$T/cj-calls" && echo "$out" | grep -qF "C-1 cloud PR #51 → tracker: commented the link to PR #51, and moved it from In Progress to In Review" && [ "$(field C-1 tracker_steps)" != "\"due\"" ]'
check "one already in §4 Review state is commented on, never moved" '! grep -q "^transition C-3" "$T/cj-calls" && grep -q "^comment C-3 " "$T/cj-calls"'
: > "$T/cj-calls"; q set C-1 tracker_steps=due; out=$(DESK_CONFIG="$T/config-cjy.md" node "$B/pass.mjs" 2>&1)
check "a comment already on the ticket is not posted again" '! grep -q "^comment C-1" "$T/cj-calls"'
q add C-2; q set C-2 state=done location=cloud result.pr=52 tracker_steps=due
out=$(DESK_CONFIG="$T/config-cja.md" node "$B/pass.mjs" 2>&1)
check "a step whose §3 row is not yes is the person's, with its command" \
  '! grep -q "^transition C-2" "$T/cj-calls" && echo "$out" | grep -qF "C-2: cloud PR #52'"'"'s tracker step is yours: config §3 jira-transition is \"ask\": move it to In Review with desk-jira transition C-2"'

# ---- DS-573: a parked ticket whose own PR merged before its Jira tail was done goes back to a worker
# for its after-merge steps only. PR 701, 703 and 704 merged, 702 is open; MT-3 is done in Jira. GitHub's
# list of merged PRs holds 701 and 704 from the tickets' own branches, which the spawn's shipped-elsewhere
# check must not read as shipped.
export DESK_QUEUE="$T/queue-mt.json" DESK_AUTOPILOT_STATE="$T/state-mt"; mkdir -p "$T/state-mt/logs"
{ cat "$T/config.md"; printf '\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `MT-[0-9]+` |\n'; } > "$T/config-mt.md"
cat > "$T/stub/gh" <<'EOF'
#!/bin/sh
case "$*" in
  "pr view 701 "*|"pr view 703 "*|"pr view 704 "*|"pr view 705 "*) echo '{"state":"MERGED","isDraft":false,"mergedAt":"2026-11-12T09:01:00Z"}' ;;
  "pr view 702 "*) echo '{"state":"OPEN","isDraft":true,"mergedAt":null}' ;;
  *"--state merged --search MT-1 in:title"*) echo '[{"number":701,"title":"fix(x): MT-1 add x","headRefName":"fix/MT-1"}]' ;;
  *"--state merged --search MT-5 in:title"*) echo '[{"number":705,"title":"fix(x): MT-5 add x","headRefName":"fix/MT-5"}]' ;;
  "pr list --repo "*" --state merged --search "*) echo '[{"number":701,"headRefName":"fix/MT-1","mergedAt":"2099-01-01T09:01:00Z"},{"number":704,"headRefName":"fix/MT-4","mergedAt":"2099-01-01T09:01:00Z"}]' ;;
  "pr list"*) echo '[]' ;;
esac
exit 0
EOF
cat > "$T/stub/desk-jira" <<'EOF'
#!/bin/sh
[ "$1" = get ] || exit 0
[ "$2" = MT-5 ] && { echo "desk-jira: 503 from Jira" >&2; exit 1; }
c=indeterminate; [ "$2" = MT-3 ] && c=done
printf '{"key":"%s","fields":{"status":{"statusCategory":{"key":"%s"}}}}\n' "$2" "$c"
EOF
chmod +x "$T/stub/gh" "$T/stub/desk-jira"
export DESK_CONFIG="$T/config-mt.md"
q init mt; q set-batch concurrency=4
MQ="MT-1: PR #701's unit tests are red: which fixture should win?"
q add MT-1; q set MT-1 lane=A branch=fix/MT-1 draft_pr=701 handoff_stage=7; q park MT-1 "$MQ"
q add MT-2; q set MT-2 lane=A branch=fix/MT-2 draft_pr=702; q park MT-2 "MT-2: which fixture should win?"
q add MT-3; q set MT-3 lane=A draft_pr=703; q park MT-3 "MT-3: which fixture should win?"
q add MT-4; q set MT-4 state=parked lane=A branch=fix/MT-4 draft_pr=704 'park={"question":"MT-4: waiting on PR #704 to merge","clears_when":{"kind":"pr-merged","pr":704}}'
# MT-5's branch adds nothing to main (origin's main already holds x.txt) and merged PR #705 names it,
# but its Jira read fails: it is left parked, never dropped as a duplicate with its tail unread. Origin
# goes back to DS-397's, whose main holds x.txt, so dropDuplicate would drop it were it reached.
git -C "$T/repo" remote set-url origin "$T/rc-origin.git"
git -C "$T/repo" worktree add -q -b fix/MT-5 "$T/wt/MT-5" main
echo x > "$T/wt/MT-5/x.txt"; git -C "$T/wt/MT-5" add x.txt; git -C "$T/wt/MT-5" commit -q -m "fix(x): MT-5 add x"
q add MT-5; q set MT-5 lane=A branch=fix/MT-5 "worktree=$T/wt/MT-5" draft_pr=705; q park MT-5 "MT-5: which fixture should win?"
out=$(node "$B/pass.mjs" 2>&1)
MTB="$T/state-mt/briefings/MT-1.md"
check "DS-573 AC1 a parked ticket whose PR merged, not done in Jira, is requeued and spawned, with no question left" \
  '[ "$(field MT-1 state)" = "\"running\"" ] && [ "$(field MT-1 park)" = null ] && [ "$(field MT-1 merged_tail)" = 701 ] && [ "$(field MT-1 prev_park.question)" = "\"$MQ\"" ] && echo "$out" | grep -qF "MT-1: its PR #701 merged while it was parked, and it is not done in Jira: requeued for its after-merge steps only, with no push"'
check "DS-573 AC1 its briefing names the merge" \
  'grep -qF "## Your PR has merged: run only the steps after the merge" "$MTB" && grep -qF "A pass found PR #701 merged at 2026-11-12 09:01 UTC, and MT-1 is not done in Jira yet." "$MTB" && grep -qF "The last round parked on: $MQ" "$MTB"'
check "DS-573 AC2 its briefing says to run only the after-merge steps and not to push, starting from Stage 0, not its handoff" \
  'grep -qF "this round does not push, rebase, merge any branch, open or edit a PR, or change code" "$MTB" && grep -qF "Run only the steps left after a merge: desk-ticket Stage 8" "$MTB" && grep -qF "AUTOPILOT_DONE: pr=701" "$MTB" && ! grep -qF "## What cleared your last park" "$MTB" && [ "$(field MT-1 handoff_stage)" = null ]'
check "DS-573 AC3 a parked ticket whose PR is still open is left as it was" \
  '[ "$(field MT-2 state)" = "\"parked\"" ] && [ "$(field MT-2 park.question)" = "\"MT-2: which fixture should win?\"" ] && [ "$(field MT-2 merged_tail)" = null ] && ! echo "$out" | grep -q "MT-2: its PR"'
check "DS-573 a ticket already done in Jira is not requeued for a tail" \
  '[ "$(field MT-3 state)" = "\"parked\"" ] && [ "$(field MT-3 merged_tail)" = null ]'
check "DS-573 AC1 a park whose recorded condition holds, its PR merged and not done in Jira, is requeued for its tail, not recorded done" \
  '[ "$(field MT-4 state)" = "\"running\"" ] && [ "$(field MT-4 merged_tail)" = 704 ] && grep -qF "A pass found PR #704 merged at 2026-11-12 09:01 UTC" "$T/state-mt/briefings/MT-4.md" && echo "$out" | grep -qF "MT-4: its PR #704 merged while it was parked"'
check "DS-573 a merged PR whose Jira read fails is left parked, its branch and worktree kept, not recorded done as a duplicate" \
  '[ "$(field MT-5 state)" = "\"parked\"" ] && [ "$(field MT-5 park.question)" = "\"MT-5: which fixture should win?\"" ] && [ "$(field MT-5 merged_tail)" = null ] && [ -e "$T/wt/MT-5" ] && git -C "$T/repo" rev-parse --verify -q refs/heads/fix/MT-5 >/dev/null && echo "$out" | grep -qF "MT-5: whether its PR #705 merged, or its ticket is done, could not be read" && ! echo "$out" | grep -qF "MT-5: its branch fix/MT-5 adds nothing"'
# The tail worker parks in its turn: that park is the person's, never requeued again on the same PR.
# Its branch adds nothing to main once squash-merged, and merged PR #701 names it: still never dropped.
git -C "$T/repo" worktree add -q -B fix/MT-1 "$T/wt/MT-1-tail" main
echo x > "$T/wt/MT-1-tail/x.txt"; git -C "$T/wt/MT-1-tail" add x.txt; git -C "$T/wt/MT-1-tail" commit -q -m "fix(x): MT-1 add x"
q set MT-1 "worktree=$T/wt/MT-1-tail"
q park MT-1 "MT-1: jira-close-own-merged is ask: may I move it to Done?"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-573 a park of the tail worker's own stays parked for the person, its branch kept, not recorded done as a duplicate" \
  '[ "$(field MT-1 state)" = "\"parked\"" ] && [ "$(field MT-1 park.question)" = "\"MT-1: jira-close-own-merged is ask: may I move it to Done?\"" ] && [ -e "$T/wt/MT-1-tail" ] && git -C "$T/repo" rev-parse --verify -q refs/heads/fix/MT-1 >/dev/null && ! echo "$out" | grep -qF "MT-1: its PR #701 merged" && ! echo "$out" | grep -qF "MT-1: its branch fix/MT-1 adds nothing"'

# A fix try queued against its PR is spawned only once the PR is read again and is still open at the
# try's head. FT-1's PR merged since, FT-2's was closed, FT-3's head moved, FT-4's is as it was, and
# FT-5's cannot be read.
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue-ft.json" DESK_AUTOPILOT_STATE="$T/state-ft"; mkdir -p "$T/state-ft/logs"; : > "$T/ft-spawns"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1" >> "$T/ft-spawns"; echo "[spawn] ticket=\$1"
EOF
cat > "$T/stub/gh" <<'EOF'
#!/bin/sh
case "$*" in
  "pr view 901 "*|"pr view 911 "*) echo '{"state":"MERGED","mergedAt":"2026-11-12T15:38:26Z","headRefOid":"h1","statusCheckRollup":[]}' ;;
  "pr view 902 "*) echo '{"state":"CLOSED","mergedAt":null,"headRefOid":"h1","statusCheckRollup":[]}' ;;
  "pr view 903 "*) echo '{"state":"OPEN","mergedAt":null,"headRefOid":"h2","statusCheckRollup":[]}' ;;
  "pr view 904 "*) echo '{"state":"OPEN","mergedAt":null,"headRefOid":"h1","statusCheckRollup":[]}' ;;
  "pr view 905 "*) echo 'HTTP 502: Bad Gateway' >&2; exit 1 ;;
  "pr view 906 "*|"pr view 907 "*|"pr view 909 "*) echo '{"state":"OPEN","mergedAt":null,"headRefOid":"h2","statusCheckRollup":[]}' ;;
  "pr view 908 "*) echo '{"state":"CLOSED","mergedAt":null,"headRefOid":"h2","statusCheckRollup":[]}' ;;
  "pr list "*) echo '[]' ;;
esac
exit 0
EOF
q init ft; q set-batch concurrency=5
for k in 1 2 3 4 5; do
  q add "FT-$k"; q set "FT-$k" state=triaged lane=A "branch=fix/FT-$k" "result.pr=90$k" \
    'fix={"try":2,"of":2,"pr":90'"$k"',"head":"h1","kind":"checks","what":"red: Lint","checks":[{"name":"Lint","url":null}],"at":"2026-11-12T15:28:05Z"}' \
    'fix_tries=[{"try":1,"head":"h0","kind":"checks","what":"red: Lint","at":"2026-11-12T12:00:00Z"},{"try":2,"head":"h1","kind":"checks","what":"red: Lint","at":"2026-11-12T15:28:05Z"}]'
done
# FT-6's feedback try and FT-7's instruction from the person both meet a moved head; FT-8 is a killed
# worker's session waiting to resume, whose PR was closed since.
q add FT-6; q set FT-6 state=triaged lane=A branch=fix/FT-6 result.pr=906 \
  'fix={"try":1,"of":2,"pr":906,"head":"h1","kind":"feedback","what":"review feedback: 1 unresolved thread","threads":[{"id":"PRRT_1","text":"a thread"}],"at":"2026-11-12T15:28:05Z"}' \
  'fix_tries=[{"try":1,"head":"h1","kind":"feedback","what":"review feedback: 1 unresolved thread","at":"2026-11-12T15:28:05Z"}]'
q add FT-7; q set FT-7 state=triaged lane=A branch=fix/FT-7 result.pr=907 \
  'fix={"try":1,"of":1,"pr":907,"head":"h1","kind":"instruction","ready":true,"what":"your instruction","answer":"rename the flag"}'
# Its spawn cleared result, so FT-8 has no result.pr of its own.
q add FT-8; q set FT-8 state=triaged lane=A branch=fix/FT-8 resume=pending \
  'fix={"try":1,"of":2,"pr":908,"head":"h1","kind":"checks","what":"red: Lint","at":"2026-11-12T15:28:05Z"}' \
  'fix_tries=[{"try":1,"head":"h1","kind":"checks","what":"red: Lint","at":"2026-11-12T15:28:05Z"}]'
out=$(node "$B/pass.mjs" 2>&1)
check "#1396 a fix try whose PR merged since records the merge naming that PR" '[ "$(field FT-1 merge.pr)" = 901 ]'
check "DS-605 AC1 a fix try whose PR merged since spawns no worker, is finished, and the ticket is recorded merged" \
  '! grep -qx FT-1 "$T/ft-spawns" && [ "$(field FT-1 state)" = "\"done\"" ] && [ "$(field FT-1 fix.finished)" != null ] && [ "$(field FT-1 merged_at)" = "\"2026-11-12T15:38:26.000Z\"" ] && echo "$out" | grep -qF "FT-1: its fix try 2 of 2 on PR #901 was not spawned, PR #901 merged at 2026-11-12T15:38:26Z: the try is finished and the ticket done on its PR again, recorded merged"'
check "DS-605 AC2 a fix try whose PR was closed unmerged spawns no worker and is finished" \
  '! grep -qx FT-2 "$T/ft-spawns" && [ "$(field FT-2 state)" = "\"done\"" ] && [ "$(field FT-2 fix.finished)" != null ] && [ "$(field FT-2 fix.ended)" = "\"PR #902 was closed unmerged\"" ] && [ "$(field FT-2 merged_at)" = null ]'
check "DS-605 AC3 a fix try whose PR head moved past the try's spawns no worker and is finished with head moved" \
  '! grep -qx FT-3 "$T/ft-spawns" && [ "$(field FT-3 state)" = "\"done\"" ] && [ "$(field FT-3 fix.finished)" != null ] && field FT-3 fix.ended | grep -q "^\"head moved: PR #903 is at h2, past h1"'
check "DS-605 a try that ended with no worker is taken out of fix_tries, so it spends none of the PR's tries" \
  '[ "$(field FT-3 fix_tries | jq -c "[.[].try]")" = "[1]" ] && [ "$(field FT-4 fix_tries | jq -c "[.[].try]")" = "[1,2]" ]'
check "DS-605 AC4 a fix try whose PR is open at the try's head spawns, as before" \
  'grep -qx FT-4 "$T/ft-spawns" && [ "$(field FT-4 state)" = "\"running\"" ] && [ "$(field FT-4 fix.finished)" = null ]'
check "DS-605 AC5 a fix try whose PR cannot be read is not spawned this pass, and the report says why" \
  '! grep -qx FT-5 "$T/ft-spawns" && [ "$(field FT-5 state)" = "\"triaged\"" ] && [ "$(field FT-5 fix.finished)" = null ] && echo "$out" | grep -qF "FT-5: its fix try 2 of 2 on PR #905 was not spawned: the PR could not be read"'
check "DS-605 a try ended before any worker ran it is marked so, and its threads are not replied on or resolved as worked" \
  '! grep -qx FT-6 "$T/ft-spawns" && [ "$(field FT-6 fix.no_worker)" = true ] && [ "$(field FT-3 fix.no_worker)" = true ] && [ "$(field FT-6 fix.resolved)" = null ] && ! echo "$out" | grep -q "FT-6.*resolved"'
check "DS-605 the person's instruction is not ended by a moved head: its worker carries it out at the new head" \
  'grep -qx FT-7 "$T/ft-spawns" && [ "$(field FT-7 fix.finished)" = null ]'
check "DS-605 a session waiting to resume on a PR closed since is not resumed, and keeps its try as made" \
  '! grep -qx FT-8 "$T/ft-spawns" && [ "$(field FT-8 state)" = "\"done\"" ] && [ "$(field FT-8 resume)" = null ] && [ "$(field FT-8 fix.no_worker)" = null ] && [ "$(field FT-8 fix_tries | jq length)" = 1 ] && [ "$(field FT-8 result.pr)" = 908 ] && echo "$out" | grep -qF "FT-8: its fix try 1 of 2 on PR #908 was not resumed, PR #908 was closed unmerged"'
# FT-9's migration renames try holds the merge as an instruction does; a pass of its own, so it has a slot.
export DESK_QUEUE="$T/queue-ft9.json" DESK_AUTOPILOT_STATE="$T/state-ft9"; mkdir -p "$T/state-ft9/logs"
q init ft9; q set-batch concurrency=1
q add FT-9; q set FT-9 state=triaged lane=A branch=fix/FT-9 result.pr=909 \
  'fix={"try":1,"of":2,"extra":true,"pr":909,"head":"h1","kind":"renames","base":"main","renames":[{"from":"a","to":"b","old":"001_a","new":"002_a","files":["src/a.test.ts"]}],"what":"its files name a migration main renamed"}'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-605 a migration renames try, which holds the merge, is not ended by a moved head either" \
  'grep -qx FT-9 "$T/ft-spawns" && [ "$(field FT-9 fix.finished)" = null ]'
# FT-11's PR merged since too, and the merge driver already recorded who merged it; a pass of its own.
export DESK_QUEUE="$T/queue-ft11.json" DESK_AUTOPILOT_STATE="$T/state-ft11"; mkdir -p "$T/state-ft11/logs"
q init ft11; q set-batch concurrency=1
q add FT-11; q set FT-11 state=triaged lane=A branch=fix/FT-11 result.pr=911 \
  'merge={"by":"merge driver","pr":911,"head_sha":"0123456789abcdef0123456789abcdef01234567","base":"main","at":"2026-11-12T15:38:26.000Z"}' \
  'fix={"try":1,"of":2,"pr":911,"head":"h1","kind":"checks","what":"red: Lint","at":"2026-11-12T15:28:05Z"}' \
  'fix_tries=[{"try":1,"head":"h1","kind":"checks","what":"red: Lint","at":"2026-11-12T15:28:05Z"}]'
out=$(node "$B/pass.mjs" 2>&1)
check "#1396 a fix try ending on a merge already recorded with its PR and merger keeps that record" \
  '! grep -qx FT-11 "$T/ft-spawns" && [ "$(field FT-11 fix.finished)" != null ] && [ "$(field FT-11 merge.by)" = "\"merge driver\"" ] && [ "$(field FT-11 merge.pr)" = 911 ] && [ "$(field FT-11 merge.base)" = "\"main\"" ]'
# FT-10's fix try worker parked, and its PR #901 merged since: tailAfterMerge sent it back for
# its after-merge steps (merged_tail, cleared.tail). That tail spawns; its merged PR does not end it.
export DESK_QUEUE="$T/queue-ft10.json" DESK_AUTOPILOT_STATE="$T/state-ft10"; mkdir -p "$T/state-ft10/logs"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1 task=\${AUTOPILOT_TASK:-}" >> "$T/ft-spawns"; echo "[spawn] ticket=\$1"
EOF
q init ft10; q set-batch concurrency=1
q add FT-10; q set FT-10 state=triaged lane=A branch=fix/FT-10 result.pr=901 merged_tail=901 \
  'cleared={"what":"PR #901 merged at 2026-11-12 15:38 UTC, and FT-10 is not done in Jira yet","tail":{"pr":901,"merged_at":"2026-11-12T15:38:26Z"}}' \
  'fix={"try":1,"of":2,"pr":901,"head":"h1","kind":"checks","what":"red: Lint","at":"2026-11-12T15:28:05Z"}' \
  'fix_tries=[{"try":1,"head":"h1","kind":"checks","what":"red: Lint","at":"2026-11-12T15:28:05Z"}]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-605 a ticket sent back for its after-merge steps spawns for them: its merged PR does not end it, and its fix try is finished, kept as made" \
  'grep -qx "FT-10 task=" "$T/ft-spawns" && [ "$(field FT-10 state)" = "\"running\"" ] && [ "$(field FT-10 fix.finished)" != null ] && [ "$(field FT-10 fix.no_worker)" = null ] && [ "$(field FT-10 fix_tries | jq length)" = 1 ] && grep -qF "## Your PR has merged: run only the steps after the merge" "$T/state-ft10/briefings/FT-10.md" && ! grep -qF "## Fix try" "$T/state-ft10/briefings/FT-10.md" && ! echo "$out" | grep -qF "FT-10: its fix try"'
# FT-11 and FT-12's fix try workers started (fix.started), parked, and were requeued once answered:
# FT-11's worker pushed its PR #903 to h2 itself, and FT-12's PR #902 was closed since.
export DESK_QUEUE="$T/queue-ft11.json" DESK_AUTOPILOT_STATE="$T/state-ft11"; mkdir -p "$T/state-ft11/logs"
q init ft11; q set-batch concurrency=2
for k in 11 12; do
  pr=903; [ "$k" = 12 ] && pr=902
  q add "FT-$k"; q set "FT-$k" state=triaged lane=A "branch=fix/FT-$k" \
    'fix={"try":1,"of":2,"pr":'"$pr"',"head":"h1","kind":"checks","what":"red: Lint","checks":[{"name":"Lint","url":null}],"at":"2026-11-12T15:28:05Z","started":"2026-11-12T15:30:00Z"}' \
    'fix_tries=[{"try":1,"head":"h1","kind":"checks","what":"red: Lint","at":"2026-11-12T15:28:05Z"}]'
done
out=$(node "$B/pass.mjs" 2>&1)
check "DS-605 a started try requeued after its park is not ended by a head its own worker moved: it spawns again" \
  'grep -q "^FT-11 task=" "$T/ft-spawns" && [ "$(field FT-11 state)" = "\"running\"" ] && [ "$(field FT-11 fix.finished)" = null ] && [ "$(field FT-11 fix.no_worker)" = null ]'
check "DS-605 a started try whose PR was closed since ends, kept as a try made, not marked no_worker" \
  '! grep -q "^FT-12 " "$T/ft-spawns" && [ "$(field FT-12 state)" = "\"done\"" ] && [ "$(field FT-12 fix.no_worker)" = null ] && [ "$(field FT-12 fix_tries | jq length)" = 1 ] && echo "$out" | grep -qF "FT-12: its fix try 1 of 2 on PR #902 was not spawned again, PR #902 was closed unmerged"'
check "DS-605 the spawn that starts a fix try marks it started" \
  '[ "$(DESK_QUEUE="$T/queue-ft.json" field FT-4 fix.started)" != null ] && [ "$(DESK_QUEUE="$T/queue-ft.json" field FT-1 fix.started)" = null ]'
# FT-13's spawn is refused by spawn-worker.sh: no worker ran, so its try is not marked started.
export DESK_QUEUE="$T/queue-ft13.json" DESK_AUTOPILOT_STATE="$T/state-ft13"; mkdir -p "$T/state-ft13/logs"
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "[spawn-worker] refused: a stage file is missing"; exit 1
EOF
q init ft13; q set-batch concurrency=1
q add FT-13; q set FT-13 state=triaged lane=A branch=fix/FT-13 result.pr=904 \
  'fix={"try":1,"of":2,"pr":904,"head":"h1","kind":"checks","what":"red: Lint","checks":[{"name":"Lint","url":null}],"at":"2026-11-12T15:28:05Z"}'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-605 a fix try whose spawn was refused is not marked started, so it is still a try no worker ran" \
  '[ "$(field FT-13 state)" = "\"failed\"" ] && [ "$(field FT-13 spawn_failed)" = true ] && [ "$(field FT-13 fix.started)" = null ]'

# ---- DS-755: tickets naming one file start up to its per-file budget. On main, src/big.ts and
# src/hot.ts are 1,200 lines and src/edge.ts 1,000. Each case is a queue of its own, cap 8.
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; exit 0; fi
echo "\$1" >> "$T/fb-spawns"; echo "[spawn] ticket=\$1"
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}, {\"sessionId\": \"live-2\"}, {\"sessionId\": \"live-3\"}]'" > "$T/stub/claude"
git -C "$T/repo" checkout -q main
mkdir -p "$T/repo/src"; seq 1 1200 > "$T/repo/src/big.ts"; seq 1 1000 > "$T/repo/src/edge.ts"; seq 1 1200 > "$T/repo/src/hot.ts"
git -C "$T/repo" add src; git -C "$T/repo" commit -q -m "budget fixtures"
fbconf(){ { cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `8 / 8` |\n'; case "$1" in '') ;; *'`'*) printf '| Per-file collision budget | x | %s |\n' "$1" ;; *) printf '| Per-file collision budget | x | `%s` |\n' "$1" ;; esac; } > "$T/config-fb.md"; }
# fbq <name> <row>: a fresh queue under that row; fbt <KEY> <state> <files...>: a ticket and its triage record.
fbq(){ fbconf "$2"; export DESK_CONFIG="$T/config-fb.md" DESK_QUEUE="$T/queue-$1.json" DESK_AUTOPILOT_STATE="$T/state-$1"; mkdir -p "$T/state-$1/logs" "$T/state-$1/triage"; : > "$T/fb-spawns"; q init "$1"; q set-batch concurrency=8 concurrency_by=user; }
fbt(){ k=$1 st=$2; shift 2; jq -nc '{files_in_scope: $ARGS.positional}' --args "$@" > "$DESK_AUTOPILOT_STATE/triage/$k.json"; q add "$k"; q set "$k" "state=$st" "branch=fix/$k"; }
spawned(){ grep -qx "$1" "$T/fb-spawns"; }

fbq fba ''
# FB-1 to FB-4 name one file each, so the pass's re-sort (equal gates, then fewer files) keeps
# them in queue order and the budget, not the sort, decides which start.
fbt FB-1 triaged src/big.ts; fbt FB-2 triaged src/big.ts; fbt FB-3 triaged src/big.ts
fbt FB-4 triaged src/big.ts; fbt FB-5 triaged src/edge.ts; fbt FB-6 triaged src/edge.ts; fbt FB-9 triaged src/edge.ts
fbt FB-7 triaged src/new.ts src/big.ts; fbt FB-8 triaged src/solo.ts; q set FB-8 collides_with=FB-1
out=$(node "$B/pass.mjs" 2>&1)
check "DS-755 AC1 with no budget row, three ready tickets naming a file over 1,000 lines on the base all start" \
  'spawned FB-1 && spawned FB-2 && spawned FB-3'
check "DS-755 AC2 a fourth naming it does not start, and the report names the file and the three running" \
  '! spawned FB-4 && [ "$(field FB-4 state)" = "\"triaged\"" ] && echo "$out" | grep "^held back by a collision:" | grep -qF "FB-4 (src/big.ts has 3 running of its 3: FB-1, FB-2, FB-3)"'
check "DS-755 AC3 AC9 DS-1032 AC3 of three naming a 1,000-line file, the first two in queue order start and the third waits" \
  'spawned FB-5 && spawned FB-6 && ! spawned FB-9 && echo "$out" | grep -qF "FB-9 (src/edge.ts has 2 running of its 2: FB-5, FB-6)"'
check "DS-755 AC5 a ticket naming two files, one at its budget, does not start" '! spawned FB-7 && [ "$(field FB-7 state)" = "\"triaged\"" ]'
check "DS-755 AC7 an admission-time collides_with naming a running ticket that shares no file in the triage records holds nothing" 'spawned FB-8'
check "DS-755 the metrics line names each held ticket's files at their budget and the running tickets filling them" \
  'tail -n 1 "$T/state-fba/passes.jsonl" | jq -e ".held.collision == 3 and (.collisions | map(select(.key == \"FB-7\")) == [{\"key\":\"FB-7\",\"with\":[\"FB-1\",\"FB-2\",\"FB-3\"],\"files\":[\"src/big.ts\"],\"holds\":[{\"file\":\"src/big.ts\",\"k\":3,\"with\":[\"FB-1\",\"FB-2\",\"FB-3\"]}]}])" >/dev/null'

fbq fbb ''
fbt FB-11 running src/big.ts; fbt FB-12 running src/big.ts; fbt FB-13 running src/big.ts
q set FB-11 session_id=live-1; q set FB-12 session_id=live-2; q set FB-13 session_id=live-3
fbt FB-14 triaged src/big.ts
fbt FB-15 "done" src/edge.ts; fbt FB-16 triaged src/edge.ts; q set FB-16 collides_with=FB-15
out=$(node "$B/pass.mjs" 2>&1)
check "DS-755 AC2 with three already running that name the file, a fourth does not start, and the report names them" \
  '! spawned FB-14 && echo "$out" | grep -qF "FB-14 (src/big.ts has 3 running of its 3: FB-11, FB-12, FB-13)"'
check "DS-755 AC3 AC7 once the first has stopped running, the other starts: a done ticket its collides_with names holds nothing" 'spawned FB-16'

# A test file takes no place, under a row of 1 too; a shared non-test file still holds.
fbq fbt '1'
fbt FB-61 triaged tests/test_prompts.py src/c.test.ts; fbt FB-62 triaged tests/test_prompts.py src/c.test.ts; fbt FB-63 triaged tests/test_prompts.py src/c.test.ts
fbt FB-64 triaged tests/test_prompts.py src/solo.ts; fbt FB-65 triaged tests/test_prompts.py src/solo.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-1032 AC2 a test file takes no place: three ready tickets whose only shared files are test files all start" \
  'spawned FB-61 && spawned FB-62 && spawned FB-63 && ! echo "$out" | grep "^held back by a collision:" | grep -qE "FB-6[123] \("'
check "DS-1032 AC2 negative control: tickets also sharing a non-test file are held on that file alone" \
  'spawned FB-64 && ! spawned FB-65 && echo "$out" | grep "^held back by a collision:" | grep -qF "FB-65 (src/solo.ts has 1 running of its 1: FB-64)"'

fbq fbc '3 over 1000 lines, else 1; serial: src/hot.ts, docs/*.md'
fbt FB-21 triaged src/hot.ts; fbt FB-22 triaged src/hot.ts; fbt FB-23 triaged src/big.ts; fbt FB-24 triaged src/big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-755 AC4 of two ready tickets naming a file on the serial list, only one starts, whatever its length" \
  'spawned FB-21 && ! spawned FB-22 && spawned FB-23 && spawned FB-24'

fbq fbd '1'
fbt FB-31 triaged src/big.ts; fbt FB-32 triaged src/big.ts src/a.ts; fbt FB-33 triaged src/edge.ts; fbt FB-34 triaged src/edge.ts; fbt FB-35 triaged src/solo.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-755 AC6 a row of 1 starts and holds exactly the tickets one at a time does" \
  'spawned FB-31 && ! spawned FB-32 && spawned FB-33 && ! spawned FB-34 && spawned FB-35 && echo "$out" | grep -qF "held back by a collision: FB-32 (src/big.ts has 1 running of its 1: FB-31), FB-34 (src/edge.ts has 1 running of its 1: FB-33)"'

fbq fbe 'three, mostly'
fbt FB-41 triaged src/big.ts; fbt FB-42 triaged src/big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-755 AC10 a row the pass cannot read is 1 for every file, and the report says so" \
  'spawned FB-41 && ! spawned FB-42 && echo "$out" | grep -qF "collisions: config §3b \"Per-file collision budget\" reads \"three, mostly\"" && echo "$out" | grep -qF "read as 1 for every file"'
# A review try changes no file: running, it fills no place of a file; ready, it waits on none.
fbq fbf '1'
fbt FB-51 running src/big.ts; q set FB-51 session_id=live-51 'fix={"kind":"rereview","try":1,"of":2,"pr":51,"head":"aaa","what":"review its head","at":"T0","started":"T0"}'
fbt FB-52 triaged src/big.ts
fbt FB-53 running src/edge.ts; q set FB-53 session_id=live-53
fbt FB-54 triaged src/edge.ts; q set FB-54 'fix={"kind":"rereview","try":1,"of":2,"pr":54,"head":"bbb","what":"review its head","at":"T0"}' result.pr=54
out=$(node "$B/pass.mjs" 2>&1)
check "#1001 a running review try fills no place: a ticket naming the same file starts" 'spawned FB-52'
check "#1001 a ready review try is not held back behind a worker editing its files" '! echo "$out" | grep "^held back by a collision:" | grep -qF "FB-54"'
check "#1001 negative control: a ticket naming a file a running worker edits is still held" 'q set FB-52 state=triaged >/dev/null; fbt FB-55 triaged src/edge.ts; out=$(node "$B/pass.mjs" 2>&1); echo "$out" | grep "^held back by a collision:" | grep -qF "FB-55 (src/edge.ts has 1 running of its 1: FB-53)"'
# fbrow <row>: what desk-env reads the row as, "<big> <small> <serial globs joined by +> <bad>".
fbrow(){ node --input-type=module -e "import { fileBudget } from '$B/desk-env.mjs'; const b = fileBudget(process.argv[1]); console.log(b.big, b.small, b.serial.join('+'), b.bad != null)" "$1"; }
check "DS-755 AC10 a serial list with an empty or spaced entry does not read either, so it is 1 for every file" \
  '[ "$(fbrow "3 over 1000 lines, else 1; serial: ,")" = "1 1  true" ] && [ "$(fbrow "3 over 1000 lines, else 1; serial: a b")" = "1 1  true" ] && [ "$(fbrow "3 over 1000 lines, else 1; serial:")" = "1 1  true" ]'
check "DS-755 a serial list of globs and serial: none both read" \
  '[ "$(fbrow "3 over 1000 lines, else 1; serial: desk/bin/desk-env.mjs, docs/*.md")" = "3 1 desk/bin/desk-env.mjs+docs/*.md false" ] && [ "$(fbrow "3 over 1000 lines, else 1; serial: none")" = "3 1  false" ]'

# The budget in one span and the serial path in a second: read whole, it does not read, so the
# serial list is never dropped in silence.
fbq fbf '`3 over 1000 lines, else 1`; serial: `src/hot.ts`'
fbt FB-51 triaged src/big.ts; fbt FB-52 triaged src/big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-755 AC10 a row split over two code spans is 1 for every file, and the report says so" \
  'spawned FB-51 && ! spawned FB-52 && echo "$out" | grep -qF "collisions: config §3b \"Per-file collision budget\" holds more than one code span" && echo "$out" | grep -qF "read as 1 for every file"'

# ---- The tickets running in this repo's other batches fill places in the per-file budget too.
# Batch XB-1 of this repo (acme__widgets) and the standing batch of acme__third each run a ticket.
XBQ="$DESK_HOME/repos/acme__widgets/batches/XB-1"; XBS="$HOME/.desk-autopilot/acme__widgets/batches/XB-1"
X3Q="$DESK_HOME/repos/acme__third"; X3S="$HOME/.desk-autopilot/acme__third"
mkdir -p "$XBQ" "$XBS/triage" "$X3Q" "$X3S/triage"
# xb <state> [fix]: XB-1's queue, its one ticket XO-1 in that state (a review try with `fix`); XO-1's
# triage record names src/big.ts.
xb(){
  local fix=''
  if [ -n "${2:-}" ]; then fix=',"fix":{"kind":"rereview","try":1,"of":2,"pr":9,"head":"aaa","what":"review its head","at":"T0","started":"T0"}'; fi
  printf '{"tickets":{"XO-1":{"key":"XO-1","state":"%s"%s}}}\n' "$1" "$fix" > "$XBQ/queue.json"
}
printf '{"files_in_scope":["src/big.ts"]}\n' > "$XBS/triage/XO-1.json"
fbq xba '1'; xb running
fbt XA-1 triaged src/big.ts; fbt XA-2 triaged src/solo.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-664 AC1 a ticket naming a file at its budget once another batch's running ticket counts does not start, naming the batch, ticket and file" \
  '! spawned XA-1 && spawned XA-2 && [ "$(field XA-1 state)" = "\"triaged\"" ] && echo "$out" | grep "^held back by a collision:" | grep -qF "XA-1 (src/big.ts has 1 running of its 1: XO-1 in batch XB-1)"'
check "DS-664 the metrics line names the other batch's ticket among those filling the file" \
  'tail -n 1 "$T/state-xba/passes.jsonl" | jq -e "(.collisions | map(select(.key == \"XA-1\")) == [{\"key\":\"XA-1\",\"with\":[\"XO-1\"],\"files\":[\"src/big.ts\"],\"holds\":[{\"file\":\"src/big.ts\",\"k\":1,\"with\":[\"XO-1 in batch XB-1\"]}]}])" >/dev/null'
xb 'done'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-664 AC2 once the other batch's ticket stops running, the held ticket starts" 'spawned XA-1'
xb running fix; fbq xbr '1'; fbt XR-1 triaged src/big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "#1001 DS-664 a review try running in another batch fills no place either" 'spawned XR-1'
rm -f "$XBQ/queue.json"
printf '{"tickets":{"XT-1":{"key":"XT-1","state":"running"}}}\n' > "$X3Q/queue.json"
printf '{"files_in_scope":["src/big.ts"]}\n' > "$X3S/triage/XT-1.json"
# A decoy where this repo's standing batch keeps its records, so counting the other repo's ticket holds.
XWS="$HOME/.desk-autopilot/acme__widgets/triage"; mkdir -p "$XWS"
printf '{"files_in_scope":["src/big.ts"]}\n' > "$XWS/XT-1.json"
fbq xbc '1'; fbt XC-1 triaged src/big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-664 AC3 a file shared only with a ticket running in another repo's batch holds nothing" 'spawned XC-1 && ! echo "$out" | grep "^held back by a collision:" | grep -qF "XT-1"'
rm -f "$XWS/XT-1.json"
printf '{"tickets": not json\n' > "$XBQ/queue.json"
fbq xbd '1'; fbt XD-1 triaged src/big.ts
out=$(node "$B/pass.mjs" 2>&1)
# AC4 as the person reworded it on PR #725: "Given another batch's queue that cannot be read, when
# the pass runs, then the per-file budget does not hold the ticket, and the report says that batch
# was not checked." DS-308's repo worker cap still counts an unreadable queue at the cap (borrow.mjs,
# unchanged), so nothing starts this pass on that account.
check "DS-664 AC4 another batch's queue that does not read holds no ticket on the per-file budget, and the report says that batch was not checked" \
  '! echo "$out" | grep "^held back by a collision:" | grep -qF "XD-1" && echo "$out" | grep -qF "collisions: $XBQ/queue.json is not valid JSON (" && echo "$out" | grep -qF "that batch'"'"'s running tickets were not counted toward the per-file budget" && echo "$out" | grep -qF "batch XB-1 unreadable ("'
xb running
fbq xbe ''; fbt XE-1 triaged src/big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-664 AC5 a file shared with another batch's running ticket, with room counting both batches, starts" 'spawned XE-1'
# XO-1 starts running in XB-1 while this pass waits for the borrow lock, which a live process holds:
# the pass counts it from the queues read under the lock, so XF-1 does not start beside it.
xb triaged; fbq xbf '1'; fbt XF-1 triaged src/big.ts
mkdir -p "$T/xlocks/desk-borrow.lock.d"; sleep 30 & holder=$!
echo "$holder" > "$T/xlocks/desk-borrow.lock.d/pid"
DESK_LOCK_DIR="$T/xlocks" node "$B/pass.mjs" > "$T/xbf.out" 2>&1 & passpid=$!
sleep 3; xb running; kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null; wait "$passpid"
out=$(cat "$T/xbf.out")
check "DS-664 a ticket another batch starts while the pass waits for the borrow lock holds the file" \
  '! spawned XF-1 && echo "$out" | grep "^held back by a collision:" | grep -qF "XF-1 (src/big.ts has 1 running of its 1: XO-1 in batch XB-1)"'
rm -rf "${XBQ:?}" "${XBS:?}" "${X3Q:?}" "${X3S:?}"

# ---- DS-575: admitted tickets naming one file start in queue order within its budget, and none is asked
# about. RK-182, RK-147 and RK-181 all name desk/bin/desk-q.mjs (budget 1), queued in that order, not
# key order; collides_with is each one's two others, both ways as admission records it. RK-90 and RK-91
# share no file with anything.
fbq rk '1'
fbt RK-182 triaged desk/bin/desk-q.mjs; fbt RK-147 triaged desk/bin/desk-q.mjs; fbt RK-181 triaged desk/bin/desk-q.mjs src/a.ts
q set RK-182 'collides_with=RK-147|RK-181'; q set RK-147 'collides_with=RK-182|RK-181'; q set RK-181 'collides_with=RK-182|RK-147'
fbt RK-90 triaged src/solo.ts; fbt RK-91 triaged src/other.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-575 AC1 of three naming one file with a budget of 1, only the first in queue order starts and the others wait, held by it" \
  'spawned RK-182 && ! spawned RK-147 && ! spawned RK-181 && [ "$(field RK-147 state)" = "\"triaged\"" ] && [ "$(field RK-181 state)" = "\"triaged\"" ] && echo "$out" | grep "^held back by a collision:" | grep -qF "RK-147 (desk/bin/desk-q.mjs has 1 running of its 1: RK-182), RK-181 (desk/bin/desk-q.mjs has 1 running of its 1: RK-182)"'
check "DS-575 AC2 two tickets with no file in common both start in the same pass" 'spawned RK-90 && spawned RK-91'
check "DS-575 AC3 overlapping tickets wait with no question: none parked, none with an open question, no order asked" \
  '[ "$(jq -c "[.tickets | to_entries[] | select(.key | startswith(\"RK-\")) | .value | select(.state == \"parked\" or (.open_questions // 0) > 0 or .held_by != null)] | length" "$DESK_QUEUE")" = 0 ] && ! echo "$out" | grep -qF "which comes first" && [ -z "$(ls "$DESK_AUTOPILOT_STATE/parks" 2>/dev/null)" ]'
q set RK-182 state=done; : > "$T/fb-spawns"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-575 AC1 AC3 once the running one stops, the next in queue order starts and the last still waits" \
  'spawned RK-147 && ! spawned RK-181 && echo "$out" | grep "^held back by a collision:" | grep -qF "RK-181 (desk/bin/desk-q.mjs has 1 running of its 1: RK-147)"'
q set RK-147 state=done; : > "$T/fb-spawns"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-575 AC1 the last starts once the second stops" 'spawned RK-181'

# ---- #1515: a ticket handed off between sessions keeps its files' places against new tickets, and
# a handoff a running ticket's files hold back is said as that collision, not a deadline stall.
# hot <KEY> <files...>: a ticket handed off to Stage 4b, with its worktree, branch and briefing.
hot(){ k=$1; shift; fbt "$k" triaged "$@"; git -C "$T/repo" worktree add -q -b "fix/$k" "$T/wt/$k"; q set "$k" lane=A "worktree=$T/wt/$k" handoff=pending handoff_stage=4b; hfile "$k" 4b "typecheck: pass"; }
fbq hoa '1'; mkdir -p "$DESK_AUTOPILOT_STATE/handoffs"; q set-batch concurrency=1
fbt HO-0 running src/solo.ts; q set HO-0 session_id=live-1
hot HO-1 src/big.ts; fbt HO-2 triaged src/big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "#1515 AC1 AC2 a new ticket naming a file a handed-off ticket names does not start, and the report names the handoff holding it" \
  '! spawned HO-2 && [ "$(field HO-2 state)" = "\"triaged\"" ] && echo "$out" | grep "^held back by a collision:" | grep -qF "HO-2 (src/big.ts has 1 running or handed off of its 1: HO-1 (handed off))"'
check "#1515 the metrics line names the handoff among those filling the file" \
  'tail -n 1 "$T/state-hoa/passes.jsonl" | jq -e "(.collisions | map(select(.key == \"HO-2\")) == [{\"key\":\"HO-2\",\"with\":[\"HO-1\"],\"files\":[\"src/big.ts\"],\"holds\":[{\"file\":\"src/big.ts\",\"k\":1,\"with\":[\"HO-1\"]}]}])" >/dev/null'
q set HO-0 state=done; : > "$T/fb-spawns"
out=$(node "$B/pass.mjs" 2>&1)
check "#1515 AC3 when the slot frees, the handed-off ticket takes it and the new ticket naming its file still waits" \
  'spawned HO-1 && ! spawned HO-2 && [ "$(field HO-1 state)" = "\"running\"" ] && echo "$out" | grep "^held back by a collision:" | grep -qF "HO-2 (src/big.ts has 1 running of its 1: HO-1)"'

fbq hob '1'; mkdir -p "$DESK_AUTOPILOT_STATE/handoffs"
fbt HO-5 running src/edge.ts; q set HO-5 session_id=live-2
hot HO-6 src/edge.ts
q set HO-6 'waits={"handoff":{"since":"2026-01-01T00:00:00.000Z","deadline":"2026-01-01T00:15:00.000Z","escalate_to":"requeue","stage":"4b"}}'
hot HO-7 src/hot.ts; hot HO-8 src/hot.ts
out=$(node "$B/pass.mjs" 2>&1)
check "#1515 AC4 a handoff a running ticket's files hold back past its deadline is said as held by that collision, not as a deadline stall" \
  '! spawned HO-6 && echo "$out" | grep -qF "HO-6: held by collision on src/edge.ts with HO-5 — its Stage 4b session starts once that ticket stops running" && ! echo "$out" | grep -qF "HO-6: HANDOFF NOT STARTED"'
check "#1515 AC4 its handoff wait records the collision and no deadline, for desk-q to read" \
  '[ "$(field HO-6 waits.handoff | jq -c "[.collision, .deadline, .escalated]")" = "[[{\"file\":\"src/edge.ts\",\"with\":[\"HO-5\"]}],null,null]" ]'
check "#1515 two handoffs naming one file do not hold each other: the first in queue order starts and the other waits behind it" \
  'spawned HO-7 && ! spawned HO-8 && echo "$out" | grep -qF "HO-8: held by collision on src/hot.ts with HO-7"'

# ---- #1667: a ticket a person placed at the front (--front, or a move) above a pending handoff takes a
# serial file they both need ahead of it; the handoff waits with its briefing kept. Unplaced, a ticket
# moved to the front by the pass (a released chain head) does not beat the handoff.
fbq hof '3 over 1000 lines, else 1; serial: src/hot.ts'; mkdir -p "$DESK_AUTOPILOT_STATE/handoffs"
hot HO-11 src/hot.ts; fbt HO-12 triaged src/hot.ts; q front HO-12 --placed >/dev/null
out=$(node "$B/pass.mjs" 2>&1)
check "#1667 AC1 a front ticket above a handoff resume takes the serial file: it starts and the handoff waits, still pending" \
  'spawned HO-12 && ! spawned HO-11 && [ "$(field HO-11 state)" = "\"triaged\"" ] && [ "$(field HO-11 handoff)" = "\"pending\"" ] && [ "$(field HO-11 handoff_stage)" = "\"4b\"" ]'
check "#1667 AC1 the handed-off ticket keeps its briefing" '[ -s "$DESK_AUTOPILOT_STATE/handoffs/HO-11.json" ]'
check "#1667 AC3 the pass says which ticket won the file and why" \
  'echo "$out" | grep -qF "src/hot.ts: HO-12 goes first for it, ahead of HO-11'"'"'s handoff to Stage 4b: placed at the front of the spawn order (--front, or a person'"'"'s move) above it, so HO-11 waits for the file with its handoff briefing kept, and its handoff deadline keeps running until that ticket starts"'
q set HO-12 state=done; : > "$T/fb-spawns"
out=$(node "$B/pass.mjs" 2>&1)
check "#1667 AC1 once the front ticket stops running, the handoff starts from its briefing" 'spawned HO-11'

fbq hog '3 over 1000 lines, else 1; serial: src/hot.ts'; mkdir -p "$DESK_AUTOPILOT_STATE/handoffs"
hot HO-13 src/hot.ts; fbt HO-14 triaged src/hot.ts; q front HO-14 >/dev/null
out=$(node "$B/pass.mjs" 2>&1)
check "#1667 AC2 AC4 an unplaced ticket ahead of a handoff resume does not beat it: the handoff takes the serial file" \
  'spawned HO-13 && ! spawned HO-14 && ! echo "$out" | grep -qF "takes it ahead of" && echo "$out" | grep "^held back by a collision:" | grep -qF "HO-14 (src/hot.ts has 1 running of its 1: HO-13)"'

fbq hoh '3 over 1000 lines, else 1; serial: src/hot.ts'; mkdir -p "$DESK_AUTOPILOT_STATE/handoffs"
hot HO-16 src/hot.ts; fbt HO-15 triaged src/hot.ts; q move HO-15 last >/dev/null
out=$(node "$B/pass.mjs" 2>&1)
check "#1667 AC1 a placed ticket below the handoff does not beat it" 'spawned HO-16 && ! spawned HO-15'

# A placed ticket above the handoff that cannot start (its worker already printed AUTOPILOT_DONE, so
# eligibility drops it) holds nothing: the handoff starts.
fbq hoi '3 over 1000 lines, else 1; serial: src/hot.ts'; mkdir -p "$DESK_AUTOPILOT_STATE/handoffs"
hot HO-17 src/hot.ts; fbt HO-18 triaged src/hot.ts; q front HO-18 --placed >/dev/null
say "AUTOPILOT_DONE: pr=18 jira=none" > "$DESK_AUTOPILOT_STATE/logs/HO-18.log"
out=$(node "$B/pass.mjs" 2>&1)
check "#1667 a front ticket that has already finished does not hold the handoff: it starts, and no line says the finished one goes first" \
  'spawned HO-17 && ! spawned HO-18 && ! echo "$out" | grep -qF "HO-18 goes first"'

# A front ticket the spawn loop skips (its worktree is another process's working directory) fills no
# place: the handoff waits behind it, but as no collision hold, so its deadline keeps running.
fbq hoj '3 over 1000 lines, else 1; serial: src/hot.ts'; mkdir -p "$DESK_AUTOPILOT_STATE/handoffs"
hot HO-19 src/hot.ts; fbt HO-20 triaged src/hot.ts; q front HO-20 --placed >/dev/null
mkdir -p "$T/wt/HO-20"; printf 'p4243\ncclaude\nfcwd\nn%s/wt/HO-20\n' "$T" > "$T/lsof.out"
out=$(node "$B/pass.mjs" 2>&1)
: > "$T/lsof.out"
check "#1667 a front ticket that does not start holds the handoff with no collision hold: its handoff wait keeps a deadline" \
  '! spawned HO-20 && ! spawned HO-19 && echo "$out" | grep -qF "HO-20: WORKTREE IN USE" && [ "$(field HO-19 waits.handoff | jq -c "[.collision, (.deadline != null)]")" = "[null,true]" ] && ! echo "$out" | grep -qF "HO-19: held by collision"'

# #1624 with #1667: a front ticket goes first for a serial file ahead of a handoff, and a higher-priority
# ticket on that file waits behind the handoff. The higher one does not hold the front ticket by
# priority, or the three hold each other for good: the front ticket starts.
fbq hok '3 over 1000 lines, else 1; serial: src/hot.ts'; mkdir -p "$DESK_AUTOPILOT_STATE/handoffs"
printf '\n## 4. Ranking\n| Field | Value |\n|---|---|\n| Priority | `P1` `P2` |\n' >> "$T/config-fb.md"
hot HO-21 src/hot.ts; fbt HO-22 triaged src/hot.ts; fbt HO-23 triaged src/hot.ts; q front HO-22 --placed >/dev/null
for p in HO-22:P2 HO-23:P1; do f="$DESK_AUTOPILOT_STATE/triage/${p%%:*}.json"; jq -c --arg v "${p#*:}" '.priority = $v' "$f" > "$f.new" && mv "$f.new" "$f"; done
out=$(node "$B/pass.mjs" 2>&1)
check "#1624 a lower-priority front ticket ahead of a handoff starts, though a higher one waits behind that handoff on its file" \
  'spawned HO-22 && ! spawned HO-21 && ! spawned HO-23 && ! echo "$out" | grep -qF "HO-22: waits for HO-23"'

# ---- DS-756: each merge-time conflict is recorded per file in the repo's conflicts.jsonl, and a file
# with 3 in 7 days runs one place fewer. $T/cf is a real clone: fix/CF-1 and main both change b.txt and
# the first line of big.ts (1,200 lines, so 3 places unlowered). The fake gh answers PRs from $T/fx.
git init -q --bare -b main "$T/cf-origin.git"
git init -q -b main "$T/cf"; git -C "$T/cf" remote add origin "$T/cf-origin.git"
seq 1 1200 > "$T/cf/big.ts"; echo base > "$T/cf/b.txt"; echo base > "$T/cf/c.txt"
git -C "$T/cf" add -A; git -C "$T/cf" commit -q -m init
git -C "$T/cf" checkout -q -b fix/CF-1; { echo pr; seq 2 1200; } > "$T/cf/big.ts"; echo pr > "$T/cf/b.txt"; echo pr > "$T/cf/c.txt"
git -C "$T/cf" commit -q -am pr; CFH=$(git -C "$T/cf" rev-parse HEAD)
git -C "$T/cf" checkout -q main; { echo main; seq 2 1200; } > "$T/cf/big.ts"; echo main > "$T/cf/b.txt"
git -C "$T/cf" commit -q -am main; git -C "$T/cf" push -q origin main fix/CF-1
cat > "$T/stub/gh" <<EOF
#!$NODE
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'view') { try { process.stdout.write(fs.readFileSync('$T/fx/' + a[2] + '.json', 'utf8')); } catch { process.exit(1); } }
else if (a[0] === 'pr' && a[1] === 'list') console.log('[]');
else process.exit(1);
EOF
chmod +x "$T/stub/gh"
config_f
{ sed "s#$T/repo#$T/cf#" "$T/config-f.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `8 / 8` |\n'; } > "$T/config-cf.md"
# cfq <name>: a fresh queue and state on the clone. iso <days ago>: that time. cfrec <days ago> <head>: a recorded conflict on big.ts.
cfq(){ export DESK_CONFIG="$T/config-cf.md" DESK_QUEUE="$T/queue-$1.json" DESK_AUTOPILOT_STATE="$T/state-$1"; mkdir -p "$T/state-$1/logs" "$T/state-$1/triage"; : > "$T/fb-spawns"; q init "$1"; q set-batch concurrency=8 concurrency_by=user; }
iso(){ node -e 'console.log(new Date(Date.now() - Number(process.argv[1]) * 864e5).toISOString())' "$1"; }
cfrec(){ printf '{"file":"big.ts","ticket":"CF-9","pr":909,"head":"%s","at":"%s"}\n' "$2" "$(iso "$1")" >> "$DESK_AUTOPILOT_STATE/conflicts.jsonl"; }
cfn(){ jq -c "$1" "$T/state-cfa/conflicts.jsonl" 2>/dev/null; }

cfq cfa
q add CF-1; q set CF-1 state=done lane=A branch=fix/CF-1 result.pr=901; fx 901 "$CFH" CONFLICTING tests:SUCCESS
out=$(node "$B/pass.mjs" 2>&1)
check "DS-756 AC1 a ready PR in conflict with its base records one entry per conflicting file, naming the file, ticket, PR and time" \
  '[ "$(jq -sc "map(.file) | sort" "$T/state-cfa/conflicts.jsonl")" = "[\"b.txt\",\"big.ts\"]" ] && [ "$(jq -sc "map([.ticket, .pr, .head]) | unique" "$T/state-cfa/conflicts.jsonl")" = "[[\"CF-1\",901,\"$CFH\"]]" ] && [ "$(cfn ".at" | grep -cE "^\"20[0-9]{2}-[0-9]{2}-[0-9]{2}T")" = 2 ]'
check "DS-756 AC1 the conflict still goes to its fix try with the same files" \
  '[ "$(field CF-1 fix.kind)" = "\"conflict\"" ] && [ "$(field CF-1 fix.files | jq -c "sort")" = "[\"b.txt\",\"big.ts\"]" ]'
q set CF-1 state=done fix=null fix_tries=null
node "$B/pass.mjs" >/dev/null 2>&1
check "DS-756 AC1 the same conflict at the same head, met on a later pass, is not recorded again" '[ "$(grep -c . "$T/state-cfa/conflicts.jsonl")" = 2 ]'

cfq cfb
cfrec 3 h1; cfrec 2 h2; cfrec 1 h3
fbt CF-11 triaged big.ts; fbt CF-12 triaged big.ts; fbt CF-13 triaged big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-756 AC2 a file with 3 conflicts in the last 7 days runs one place fewer than configured" \
  'spawned CF-11 && spawned CF-12 && ! spawned CF-13 && echo "$out" | grep -qF "CF-13 (big.ts has 2 running of its 2: CF-11, CF-12)"'
check "DS-756 AC2 the report names the file and its conflict count" \
  'echo "$out" | grep -qF "collisions: big.ts runs 2 of its configured 3, after 3 merge-time conflict(s) in the last 7 days"'

cfq cfc
cfrec 10 h1; cfrec 9 h2; cfrec 8 h3
fbt CF-21 triaged big.ts; fbt CF-22 triaged big.ts; fbt CF-23 triaged big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-756 AC3 lowered, then 7 days with no conflict: back up by one to its configured k" \
  'spawned CF-21 && spawned CF-22 && spawned CF-23 && ! echo "$out" | grep -qF "collisions: big.ts runs"'

cfq cfd
cfrec 3 h1; cfrec 2 h2; cfrec 1 h3; echo 'not json' >> "$DESK_AUTOPILOT_STATE/conflicts.jsonl"
fbt CF-31 triaged big.ts; fbt CF-32 triaged big.ts; fbt CF-33 triaged big.ts
out=$(node "$B/pass.mjs" 2>&1)
check "DS-756 AC5 a record the pass cannot read leaves every file at its configured k, and the report says so" \
  'spawned CF-31 && spawned CF-32 && spawned CF-33 && echo "$out" | grep -qF "collisions: the conflict record was not read ($T/state-cfd/conflicts.jsonl line 4 is not a conflict entry), so every file runs at its configured budget"'

# ---- Screenshots on drafts under review: capture tries and uploads. PRs are fr_gh's, each made by frx
# (tests/pass_setup.sh). Each worker started is a line in $T/spawns.
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1 \${AUTOPILOT_TASK:-}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF
printf '#!/bin/sh\necho %s\n' "'[{\"sessionId\": \"live-1\"}]'" > "$T/stub/claude"
fr_gh; config_r

# ---- DS-379: a clean, green draft whose body has `_drag <file>_` cells with no screenshot file goes to a
# capture worker, once; still missing after it, the person gets the screens and why. dragbody <n> <body>.
dragbody(){ node -e 'const fs = require("fs"); const [f, b] = process.argv.slice(1); const j = JSON.parse(fs.readFileSync(f, "utf8")); j.body = b; fs.writeFileSync(f, JSON.stringify(j));' "$T/fr/$1.json" "$2"; }
node -e 'const fs = require("fs"); const [a, b] = process.argv.slice(1); const row = "| `pr-ready` | Undraft PRs | `yes` | `yes` |";
  fs.writeFileSync(b, fs.readFileSync(a, "utf8").replace(row, `${row}\n| \`pr-images\` | Upload PR screenshots | \`yes\` | \`yes\` |`));' "$T/config-r.md" "$T/config-s.md"
export DESK_CONFIG="$T/config-s.md" DESK_QUEUE="$T/queue-s.json" DESK_AUTOPILOT_STATE="$T/state-s"
mkdir -p "$T/state-s/logs" "$T/state-s/images/S-3"; : > "$T/state-s/images/S-3/s-3-after.png"
q init s; q set-batch concurrency=5
for k in 1 2 3; do q add "S-$k"; q set "S-$k" state=done lane=A "branch=fix/S-$k" "result.pr=76$k" images_uploaded=none; frx "76$k" "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody "76$k" "Before | After
_drag s-$k-before.png_ | _drag s-$k-after.png_"; done
q set S-2 'fix_tries=[{"try":1,"head":"'"$H1"'","kind":"capture","what":"take 2 screenshot(s) never taken"}]' \
  'fix={"try":1,"of":1,"pr":762,"head":"'"$H1"'","kind":"capture","what":"take 2","files":["s-2-before.png","s-2-after.png"],"finished":"x"}' \
  'result.summary=pr=762 jira=Done said=s-2-before.png: the page needs a signed-in admin; s-2-after.png: same'
# S-3: its worker took both, but config §3 pr-images was not yes when it finished, so they wait for the person.
: > "$T/state-s/images/S-3/s-3-before.png"; q set S-3 images_uploaded=null images_reported=true
: > "$T/spawns"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-379 AC1 cells with no screenshot file send the draft to a capture worker, naming the files" \
  '[ "$(field S-1 state)" = "\"triaged\"" ] && [ "$(field S-1 fix | jq -c "[.kind, .pr, .files]")" = "[\"capture\",761,[\"s-1-before.png\",\"s-1-after.png\"]]" ] && echo "$out" | grep -qF "capture try: S-1 requeued for PR #761 — take 2 screenshot(s) never taken: s-1-before.png, s-1-after.png"'
check "DS-379 AC1 and nothing is put to the person, and it is not undrafted" \
  '! echo "$out" | grep -q "S-1: DRAFT" && [ "$(field S-1 stuck)" = null ] && ! grep -q "^pr ready 761" "$T/gh-calls"'
check "DS-379 AC1 the capture try is not one of the fix tries" '[ "$(field S-1 fix_tries | jq -c "[.[].kind]")" = "[\"capture\"]" ]'
check "DS-379 AC3 still missing after the capture try, it is the person's, naming each screen and why" \
  '[ "$(field S-2 state)" = "\"done\"" ] && [ "$(field S-2 stuck.why | jq -r .)" = "2 screenshot(s) still not taken after a capture try: s-2-before.png, s-2-after.png; the capture try said: s-2-before.png: the page needs a signed-in admin; s-2-after.png: same" ] && echo "$out" | grep -qF "S-2: STUCK — PR #762: 2 screenshot(s) still not taken"'
check "DS-379 AC4 screenshots taken but not approved for upload wait for the person, as before" \
  '[ "$(field S-3 state)" = "\"done\"" ] && [ "$(field S-3 fix)" = null ] && echo "$out" | grep -qF "S-3: DRAFT — PR #763 stays draft: 2 screenshot cell(s) left: s-3-before.png, s-3-after.png, whose files are saved, but config §3 pr-images leaves their upload to you"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-379 AC1 the capture worker's task is to take them and print AUTOPILOT_IMAGES" \
  'grep -q "^S-1 .*Your task is the capture try on PR #761.*print AUTOPILOT_IMAGES" "$T/spawns" && grep -q "^- s-1-after.png$" "$T/state-s/briefings/S-1.md"'
# Its worker took both: the next pass uploads them into the body (the stub swaps the cells) and undrafts it.
mkdir -p "$T/state-s/images/S-1"; : > "$T/state-s/images/S-1/s-1-before.png"; : > "$T/state-s/images/S-1/s-1-after.png"
said1='[all taken] each at 1440 px wide, signed in as the seeded admin with the demo workspace selected, the onboarding banner dismissed and the side panel open, so the before and after frames line up row for row in the body'
say "AUTOPILOT_IMAGES: $T/state-s/images/S-1/" "AUTOPILOT_DONE: pr=761 jira=Done said=$said1" > "$T/state-s/logs/S-1.log"
q set S-1 state=running session_id=gone; dragbody 761 "Before | After
<img alt=\"s-1-before\" src=\"https://github.com/user-attachments/assets/1\"> | <img alt=\"s-1-after\" src=\"https://github.com/user-attachments/assets/2\">"
: > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-379 AC2 what the capture worker took is uploaded into the PR's body, and it leaves draft" \
  'grep -qx "761 $T/state-s/images/S-1/" "$T/uploads" && [ "$(field S-1 images_uploaded)" = true ] && grep -q "^pr ready 761" "$T/gh-calls"'
check "DS-379 AC3 what a capture worker said is kept whole, past the summary's 200 characters, even opening with a bracket" \
  '[ "$(field S-1 state)" = "\"done\"" ] && [ "$(field S-1 result.done.said | jq -r .)" = "$said1" ] &&[ "$(field S-1 result.summary | jq -r . | wc -c | tr -d " ")" -le 201 ]'

# ---- DS-492: an upload that leaves cells goes to whatever fills them, with nothing put to the person,
# and a body with no cell left leaves draft however the upload ended.
: > "$T/spawns"
mixed='Before | After
<img alt="s-4-before" src="https://github.com/user-attachments/assets/4"> | _drag s-4-after.png_

```evidence
s-4-after.png | after | /x | 1280
```'
printf '| Evidence workflow | `pr-evidence.yml` |\n' >> "$T/config-s.md"
q add S-4; q set S-4 state=running session_id=gone lane=A branch=fix/S-4 result.pr=764; frx 764 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 764 "$mixed"
mkdir -p "$T/state-s/images/S-4"; : > "$T/state-s/images/S-4/s-4-before.png"
say "AUTOPILOT_IMAGES: $T/state-s/images/S-4/" "AUTOPILOT_DONE: pr=764 jira=Done" > "$T/state-s/logs/S-4.log"
printf '%s\n' '[upload] done: 1 image(s) in the body, 1 placeholder(s) left' > "$T/upload-left"
: > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-492 AC1 what is on disk is uploaded and what the workflow takes is started, in one pass" \
  'grep -qx "764 $T/state-s/images/S-4/" "$T/uploads" && [ "$(field S-4 images_uploaded)" = "\"partial\"" ] && grep -q "^workflow run pr-evidence.yml --repo acme/widgets --ref main -f pr=764$" "$T/gh-calls"'
check "DS-492 AC1 and nothing is put to the person while it runs" \
  '[ "$(field S-4 undraft.call)" = "\"evidence\"" ] && ! echo "$out" | grep -q "S-4: DRAFT" && ! echo "$out" | grep -q "S-4: image upload" && ! grep -q "^pr ready 764" "$T/gh-calls"'
check "DS-492 AC1 the upload is reported as advanced, naming the cells left for the undraft step" \
  'echo "$out" | grep -qF "S-4 images → #764, 1 cell(s) left for the undraft step"'
rm -f "$T/upload-left"
dragbody 764 "Before | After
<img alt=\"s-4-before\" src=\"https://github.com/user-attachments/assets/4\"> | <img alt=\"s-4-after\" src=\"https://github.com/user-attachments/assets/5\">"
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-492 AC2 every cell filled, the next pass takes it out of draft though the upload was partial" \
  '[ "$(field S-4 images_uploaded)" = "\"partial\"" ] && grep -q "^pr ready 764" "$T/gh-calls"'
# S-5: an upload that matched no cell at all is partial, and never a person's: its cell goes to the undraft step.
q add S-5; q set S-5 state=running session_id=gone lane=A branch=fix/S-5 result.pr=765; frx 765 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 765 "_drag s-5.png_"
mkdir -p "$T/state-s/images/S-5"; : > "$T/state-s/images/S-5/other.png"
say "AUTOPILOT_IMAGES: $T/state-s/images/S-5/" "AUTOPILOT_DONE: pr=765 jira=Done" > "$T/state-s/logs/S-5.log"
printf '%s\n' '[upload] uploaded, but found no _drag placeholders matching the files' > "$T/upload-left"
out=$(node "$B/pass.mjs" 2>&1); rm -f "$T/upload-left"
check "DS-492 an upload that matched no cell is partial, never re-uploaded, and not put to the person" \
  '[ "$(field S-5 images_uploaded)" = "\"partial\"" ] && echo "$out" | grep -q "S-5: image upload to PR #765 placed no image: none of its files matches a cell in the body — .*nothing is re-uploaded, and any cell left goes to the undraft step$" && ! echo "$out" | grep -q "INCOMPLETE"'
# S-9: every before/after pair is byte for byte the same, so the body has no table: nothing to upload,
# images_uploaded=none, and nothing for the person.
q add S-9; q set S-9 state=running session_id=gone lane=A branch=fix/S-9 result.pr=769; frx 769 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 769 "No visual change: every before/after pair is identical."
mkdir -p "$T/state-s/images/S-9"; for v in desktop mobile; do printf 'same-%s' "$v" > "$T/state-s/images/S-9/before-$v.png"; printf 'same-%s' "$v" > "$T/state-s/images/S-9/after-$v.png"; done
say "AUTOPILOT_IMAGES: $T/state-s/images/S-9/" "AUTOPILOT_DONE: pr=769 jira=Done" > "$T/state-s/logs/S-9.log"
ups=$(grep -c . "$T/uploads" 2>/dev/null || echo 0)
out=$(node "$B/pass.mjs" 2>&1)
check "identical before/after pairs record images_uploaded=none, with no upload and nothing for the person" \
  '[ "$(field S-9 images_uploaded)" = "\"none\"" ] && [ "$(grep -c . "$T/uploads" 2>/dev/null || echo 0)" = "$ups" ] && ! echo "$out" | grep -q "S-9.*INCOMPLETE\|S-9: image upload"'
# S-6: an evidence workflow that cannot start asks for it to be run, never for an upload.
q add S-6; q set S-6 state=done lane=A branch=fix/S-6 result.pr=766 images_uploaded=none; frx 766 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 766 "$mixed"
: > "$T/wf-refuse-766"; out=$(node "$B/pass.mjs" 2>&1); rm -f "$T/wf-refuse-766"
check "DS-492 an evidence workflow that could not start asks for its run, not an upload" \
  'echo "$out" | grep -qF "S-6: DRAFT — PR #766 stays draft: its evidence workflow \`pr-evidence.yml\` could not start: HTTP 502: Bad Gateway. Run \`gh workflow run pr-evidence.yml -f pr=766\`" && ! echo "$out" | grep "S-6: DRAFT" | grep -q upload'
# S-7: the person's done recorded no cell left (undraft `filled`, its capture stuck cleared): the next
# pass undrafts it. S-8, the same but put back to draft by a person, stays held.
for k in 7 8; do q add "S-$k"; q set "S-$k" state=done lane=A "branch=fix/S-$k" "result.pr=76$k" images_uploaded=none stuck=null \
  'fix_tries=[{"try":1,"head":"'"$H1"'","kind":"capture","what":"take 1"}]' 'undraft={"call":"filled","why":"no screenshot cell is left in its body","action":null,"pr":76'"$k"'}'
  frx "76$k" "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody "76$k" 'Before | After
<img alt="a" src="https://github.com/user-attachments/assets/7"> | <img alt="b" src="https://github.com/user-attachments/assets/8">'; done
printf '2026-11-06T10:00:00Z\tben\n' > "$T/fr/768.events"
: > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-492 AC4 a draft the person's done recorded as filled is taken out of draft by the next pass" \
  'grep -q "^pr ready 767" "$T/gh-calls" && [ "$(field S-7 undraft.call)" = "\"ready\"" ]'
check "DS-492 AC4 negative control: put back to draft by a person, it stays held" \
  '! grep -q "^pr ready 768" "$T/gh-calls" && [ "$(field S-8 undraft.call)" = "\"held\"" ]'

# ---- DS-429: an upload that crashes keeps its whole output and is tried once more by a later pass,
# from the directory it was given, before its cells go to the person naming the saved log.
# P-1: a finished worker whose upload crashes; its fix round's log names no screenshots.
q add P-1; q set P-1 state=running session_id=gone lane=A branch=fix/P-1 result.pr=771; frx 771 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 771 '_drag p-1.png_'
mkdir -p "$T/state-s/images/P-1"; : > "$T/state-s/images/P-1/p-1.png"
say "AUTOPILOT_IMAGES: $T/state-s/images/P-1/" "AUTOPILOT_DONE: pr=771 jira=Done" > "$T/state-s/logs/P-1.log"
# P-2: its upload already crashed once, on its own PR: the retry crashes too, and that is the last try.
q add P-2; q set P-2 state=done lane=A branch=fix/P-2 result.pr=772 'upload_crash={"pr":772,"dir":"'"$T/state-s/images/P-2/"'","tries":1,"log":"x"}'
frx 772 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 772 '_drag p-2.png_'; mkdir -p "$T/state-s/images/P-2"; : > "$T/state-s/images/P-2/p-2.png"
# P-3: its upload crashed once, but its body has no cell left (the crash came after the uploader's edit).
q add P-3; q set P-3 state=done lane=A branch=fix/P-3 result.pr=773 'upload_crash={"pr":773,"dir":"'"$T/state-s/images/P-3/"'","tries":1,"log":"x"}'
frx 773 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 773 '<img alt="p-3" src="https://github.com/user-attachments/assets/3">'; mkdir -p "$T/state-s/images/P-3"; : > "$T/state-s/images/P-3/p-3.png"
# P-5: its upload crashed once, and its retry finds the shared browser profile in use.
q add P-5; q set P-5 state=done lane=A branch=fix/P-5 result.pr=775 'upload_crash={"pr":775,"dir":"'"$T/state-s/images/P-5/"'","tries":1,"log":"x"}'
frx 775 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 775 '_drag p-5.png_'; mkdir -p "$T/state-s/images/P-5"; : > "$T/state-s/images/P-5/p-5.png"; : > "$T/upload-busy-775"
: > "$T/upload-crash"; : > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-429 a crashed upload whose body has no cell left is not uploaded again, and its record is cleared" \
  '! grep -q "^773 " "$T/uploads" && [ "$(field P-3 upload_crash)" = null ] && [ "$(field P-3 images_uploaded)" = true ]'
check "DS-429 the shared profile in use spends no try, and its cells wait for the next pass" \
  'grep -q "^775 " "$T/uploads" && [ "$(field P-5 upload_crash.tries)" = 1 ] && [ "$(field P-5 upload_crash.busy)" = true ] && [ "$(field P-5 undraft.call)" = "\"wait\"" ]'
check "DS-429 AC1 a crashed upload's whole output is saved, not just its last two lines" \
  'grep -q "^Error: profile locked$" "$T/state-s/images/P-1.upload.log" && grep -q "^Node.js v22.23.1$" "$T/state-s/images/P-1.upload.log"'
check "DS-429 AC1 and the failure line names that file" \
  'echo "$out" | grep -qF "P-1: image upload to PR #771 crashed (try 1 of 2), and the next pass tries it again; its whole output is saved in $T/state-s/images/P-1.upload.log"'
check "DS-429 a crash with a retry to come is not put to the person" \
  '[ "$(field P-1 undraft.call)" = "\"wait\"" ] && ! echo "$out" | grep -q "P-1: DRAFT" && ! grep -q "^pr ready 771" "$T/gh-calls"'
check "DS-429 a pass tries an upload once: the retry step does not run it again" '[ "$(grep -c "^771 " "$T/uploads")" = 1 ]'
check "DS-429 AC3 a retry that crashes too spends the tries, naming the saved log" \
  'grep -qx "772 $T/state-s/images/P-2/" "$T/uploads" && [ "$(field P-2 upload_crash.tries)" = 2 ] && echo "$out" | grep -qF "P-2: image upload to PR #772 crashed (try 2 of 2), and its cells go to the undraft step"'
check "DS-429 AC3 once spent, the person's item says the upload crashed and where its output is" \
  '[ "$(field P-2 undraft.call)" = "\"person\"" ] && echo "$out" | grep -qF "P-2: DRAFT — PR #772 stays draft: 1 screenshot cell(s) left: p-2.png, and desk'"'"'s upload of them crashed on 2 tries; its output is saved in $T/state-s/images/P-2.upload.log"'
# P-1 goes back to a fix worker, whose round's log has no AUTOPILOT_IMAGES line (the spawn clears images_dir).
rm -f "$T/upload-crash"; : > "$T/upload-fills"
q set P-1 state=running session_id=gone images_dir=null images_uploaded=null; say "AUTOPILOT_DONE: pr=771 jira=Done" > "$T/state-s/logs/P-1.log"
# P-4: its upload crashed on every try, and a later round (a capture worker's) names its screenshots again.
q add P-4; q set P-4 state=running session_id=gone lane=A branch=fix/P-4 result.pr=774 'upload_crash={"pr":774,"dir":"'"$T/state-s/images/P-4/"'","tries":2,"log":"x"}'
frx 774 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 774 '_drag p-4.png_'; mkdir -p "$T/state-s/images/P-4"; : > "$T/state-s/images/P-4/p-4.png"
say "AUTOPILOT_IMAGES: $T/state-s/images/P-4/" "AUTOPILOT_DONE: pr=774 jira=Done" > "$T/state-s/logs/P-4.log"
: > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-429 AC2 a later pass tries the crashed upload again from the ticket's images folder" \
  'grep -qx "771 $T/state-s/images/P-1/" "$T/uploads" && [ "$(field P-1 images_uploaded)" = true ] && [ "$(field P-1 upload_crash)" = null ]'
check "DS-429 AC4 every cell filled by the retry, it is not put to the person and leaves draft" \
  '! echo "$out" | grep -q "P-1: DRAFT" && grep -q "^pr ready 771" "$T/gh-calls"'
check "DS-429 AC3 a spent upload is not tried again" '! grep -q "^772 " "$T/uploads" && [ "$(field P-2 undraft.call)" = "\"person\"" ]'
check "DS-429 a round that names its screenshots is uploaded though earlier tries were spent" \
  'grep -qx "774 $T/state-s/images/P-4/" "$T/uploads" && [ "$(field P-4 upload_crash)" = null ] && grep -q "^pr ready 774" "$T/gh-calls"'
rm -f "$T/upload-fills" "$T/upload-busy-775"

# ---- DS-675: the saved GitHub login expired: no upload is attempted and none goes to the person PR by
# PR; once it is signed in, the next pass uploads what waited.
signed="$(cat "$T/profile.github-session.json")"
printf '{"user":"t","cookies":[{"name":"user_session","domain":"github.com","expires":1}],"origins":[]}\n' > "$T/profile.github-session.json"
q add P-6; q set P-6 state=running session_id=gone lane=A branch=fix/P-6 result.pr=776; frx 776 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 776 '_drag p-6.png_'
mkdir -p "$T/state-s/images/P-6"; : > "$T/state-s/images/P-6/p-6.png"
say "AUTOPILOT_IMAGES: $T/state-s/images/P-6/" "AUTOPILOT_DONE: pr=776 jira=Done" > "$T/state-s/logs/P-6.log"
: > "$T/uploads"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-675 AC1 an expired login: the pass attempts no upload and spends no try" '! grep -q "^776 " "$T/uploads" && [ "$(field P-6 upload_crash)" = null ]'
check "DS-675 AC1 it waits in the queue naming the sign-in, and is not put to the person" \
  'echo "$out" | grep -qF "P-6 images → #776 wait in the machine'"'"'s upload queue: the GitHub login in $T/profile.github-session.json expired" && echo "$out" | grep -qF "until it is signed in: node ~/.claude/desk/bin/github-signin.mjs" && ! echo "$out" | grep -q "P-6: DRAFT"'
printf '%s\n' "$signed" > "$T/profile.github-session.json"
: > "$T/uploads"; : > "$T/upload-fills"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-675 AC2 signed in again, the next pass uploads what waited" 'grep -qx "776 $T/state-s/images/P-6/" "$T/uploads" && [ "$(field P-6 images_uploaded)" = true ]'
rm -f "$T/upload-fills"

# ---- DS-790: GitHub's PR page changed (exit 7 naming it): the upload spends no try, the PR stays in
# draft and is not put to the person, and no later upload runs till desk is installed again.
q add P-7; q set P-7 state=running session_id=gone lane=A branch=fix/P-7 result.pr=777; frx 777 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 777 '_drag p-7.png_'
mkdir -p "$T/state-s/images/P-7"; : > "$T/state-s/images/P-7/p-7.png"; : > "$T/upload-page-777"
say "AUTOPILOT_IMAGES: $T/state-s/images/P-7/" "AUTOPILOT_DONE: pr=777 jira=Done" > "$T/state-s/logs/P-7.log"
: > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-790 AC1 a page change spends no try and leaves the job in the queue" 'grep -q "^777 " "$T/uploads" && [ "$(field P-7 upload_crash)" = null ] && grep -qE "\"key\": ?\"P-7\"" "$T/desk/upload-queue.json"'
check "DS-790 AC3 the PR stays in draft, waiting on the uploader, and is not put to the person" \
  '! grep -q "^pr ready 777" "$T/gh-calls" && echo "$out" | grep -qF "P-7 images → #777 wait in the machine'"'"'s upload queue: desk'"'"'s screenshot uploader is broken: GitHub'"'"'s PR page changed" && ! echo "$out" | grep -q "P-7: DRAFT"'
: > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-790 AC3 the next pass under the same install tries no upload and still leaves it in draft" '! grep -q "^777 " "$T/uploads" && ! grep -q "^pr ready 777" "$T/gh-calls" && [ "$(field P-7 upload_crash)" = null ]'
# desk installed again with the fix: the install the pause recorded is no longer the one installed.
rm -f "$T/upload-page-777"; : > "$T/upload-fills"
node -e 'const f = process.argv[1]; const q = JSON.parse(require("fs").readFileSync(f, "utf8")); q.page.install = "/an/earlier/release/bin"; require("fs").writeFileSync(f, JSON.stringify(q))' "$T/desk/upload-queue.json"
: > "$T/uploads"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-790 AC4 installed again and the composer found: what waited is uploaded" 'grep -qE "^777 $T/state-s/images/P-7/?$" "$T/uploads" && [ "$(field P-7 images_uploaded)" = true ]'
check "DS-790 AC4 and the pause clears" 'grep -qE "\"page\": ?null" "$T/desk/upload-queue.json"'
rm -f "$T/upload-fills"

# ---- DS-674: a crash that filled cells spends no try, and a throttled stop spends none and waits for
# its retry_after. UC-1: one filled crash already recorded, three cells left, and each retry fills one
# then crashes. UC-2: one try spent, and its retry is throttled.
q add UC-1; q set UC-1 state=done lane=A branch=fix/UC-1 result.pr=791 'upload_crash={"pr":791,"dir":"'"$T/state-s/images/UC-1/"'","tries":1,"log":"x","filled":1}'
frx 791 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 791 '_drag uc-1a.png_ _drag uc-1b.png_ _drag uc-1c.png_'; mkdir -p "$T/state-s/images/UC-1"; for f in a b c; do : > "$T/state-s/images/UC-1/uc-1$f.png"; done
q add UC-2; q set UC-2 state=done lane=A branch=fix/UC-2 result.pr=792 'upload_crash={"pr":792,"dir":"'"$T/state-s/images/UC-2/"'","tries":1,"log":"x"}'
frx 792 "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody 792 '_drag uc-2.png_'; mkdir -p "$T/state-s/images/UC-2"; : > "$T/state-s/images/UC-2/uc-2.png"
: > "$T/upload-fillcrash-791"; echo 2099-01-01T00:00:00.000Z > "$T/upload-throttle-792"
: > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-674 AC1 a crash that filled a cell spends no try, and its cells wait rather than go to the person" \
  'grep -qx "791 $T/state-s/images/UC-1/" "$T/uploads" && [ "$(field UC-1 upload_crash.tries)" = 1 ] && [ "$(field UC-1 upload_crash.filled)" = 1 ] && [ "$(field UC-1 undraft.call)" = "\"wait\"" ] && echo "$out" | grep -qF "UC-1: image upload to PR #791 crashed after filling 1 cell(s), so it spends no try (1 of 2 spent), and the next pass tries it again"'
check "DS-674 AC3 a throttled upload spends no try and its cells wait for the back-off" \
  'grep -qx "792 $T/state-s/images/UC-2/" "$T/uploads" && [ "$(field UC-2 upload_crash.tries)" = 1 ] && [ "$(field UC-2 upload_crash.throttled)" = "\"2099-01-01T00:00:00.000Z\"" ] && [ "$(field UC-2 undraft.call)" = "\"wait\"" ] && echo "$out" | grep -qF "UC-2 images → #792 wait: GitHub'"'"'s rate limit throttled the upload, so it is tried again after 2099-01-01T00:00:00.000Z without counting a try"'
# UC-2's throttle set the machine's upload back-off (DS-673), so inside it no upload is tried, UC-1's included.
: > "$T/uploads"; out=$(node "$B/pass.mjs" 2>&1)
check "DS-674 AC3 a throttled upload is not tried again before its retry_after, nor is any other inside the back-off" \
  '! grep -q "^792 " "$T/uploads" && ! grep -q "^791 " "$T/uploads" && [ "$(field UC-2 undraft.call)" = "\"wait\"" ] && [ "$(field UC-1 undraft.call)" = "\"wait\"" ] && ! echo "$out" | grep -q "UC-[12]: DRAFT"'
# The back-off ends: the queue's and UC-2's retry_after both lie in the past.
rm -f "$T/upload-throttle-792"; : > "$T/upload-fills"
node -e 'const f = process.argv[1]; const q = JSON.parse(require("fs").readFileSync(f, "utf8")); q.backoff.until = "2020-01-01T00:00:00.000Z"; require("fs").writeFileSync(f, JSON.stringify(q))' "$T/desk/upload-queue.json"
q set UC-2 'upload_crash={"pr":792,"dir":"'"$T/state-s/images/UC-2/"'","tries":1,"log":"x","throttled":"2020-01-01T00:00:00.000Z"}'
: > "$T/uploads"; out=$(node "$B/pass.mjs" 2>&1); rm -f "$T/upload-fills" "$T/upload-fillcrash-791"
check "DS-674 AC1 after a second crash that filled a cell, the next pass tries the upload again" \
  'grep -qx "791 $T/state-s/images/UC-1/" "$T/uploads" && [ "$(field UC-1 upload_crash.tries)" = 1 ] && [ "$(field UC-1 undraft.call)" = "\"wait\"" ] && ! echo "$out" | grep -q "UC-1: DRAFT"'
check "DS-674 AC3 once its retry_after has passed, the throttled upload is tried again" \
  'grep -qx "792 $T/state-s/images/UC-2/" "$T/uploads" && [ "$(field UC-2 upload_crash)" = null ] && [ "$(field UC-2 images_uploaded)" = true ]'

# ---- KAN-629: screenshots saved in the ticket's briefed directory by a worker that never printed
# AUTOPILOT_IMAGES are uploaded from that directory, not left to the person as files desk holds.
# K-1: a finished round with no marker; its body has the cell. K-2: the same, but its cells were filled
# by an earlier round's upload. K-3: a running worker with no marker yet. K-4: done before this fix, its
# draft's cells still left. K-5: done, its earlier upload partial (assets already on GitHub).
for k in 1 2 3 4 5; do mkdir -p "$T/state-s/images/K-$k"; : > "$T/state-s/images/K-$k/k-$k.png"; frx "78$k" "$H1" "$H1" 'p0=0 p1=0 p2=0'; dragbody "78$k" "_drag k-$k.png_"; done
dragbody 782 '<img alt="k-2" src="https://github.com/user-attachments/assets/2">'
for k in 1 2; do q add "K-$k"; q set "K-$k" state=running session_id=gone lane=A "branch=fix/K-$k"; say "AUTOPILOT_DONE: pr=78$k jira=Done" > "$T/state-s/logs/K-$k.log"; done
q add K-3; q set K-3 state=running session_id=live-1 lane=A branch=fix/K-3 result.pr=783 log_bytes=0; say "working" > "$T/state-s/logs/K-3.log"
q add K-4; q set K-4 state=done lane=A branch=fix/K-4 result.pr=784
q add K-5; q set K-5 state=done lane=A branch=fix/K-5 result.pr=785 images_uploaded=partial
: > "$T/upload-fills"; : > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "KAN-629 a finished round with no AUTOPILOT_IMAGES uploads the briefed screenshot directory" \
  'grep -qx "781 $T/state-s/images/K-1" "$T/uploads" && [ "$(field K-1 images_uploaded)" = true ] && ! echo "$out" | grep -q "K-1: DRAFT"'
check "KAN-629 negative control: a body with no cell left is not uploaded again from that directory" \
  '! grep -q "^782 " "$T/uploads" && [ "$(field K-2 images_uploaded)" = null ]'
check "KAN-629 negative control: a running worker with no marker may still be capturing, so nothing is uploaded" \
  '! grep -q "^783 " "$T/uploads" && [ "$(field K-3 images_uploaded)" = null ]'
check "KAN-629 a done draft whose cells desk holds the files for goes to the pass's upload, not the person" \
  'grep -qx "784 $T/state-s/images/K-4" "$T/uploads" && [ "$(field K-4 undraft.call)" = "\"upload\"" ] && [ "$(field K-4 images_uploaded)" = true ] && ! echo "$out" | grep -q "K-4: DRAFT"'
check "KAN-629 a partial upload is never sent again, and its cells stay with the person as before" \
  '! grep -q "^785 " "$T/uploads" && [ "$(field K-5 undraft.call)" = "\"person\"" ] && echo "$out" | grep -qF "K-5: DRAFT — PR #785 stays draft: 1 screenshot cell(s) left: k-5.png, whose files desk holds but could not put in the body"'
check "KAN-629 one upload a pass: the undraft step does not send K-1 again" '[ "$(grep -c "^781 " "$T/uploads")" = 1 ]'
: > "$T/uploads"; : > "$T/gh-calls"; out=$(node "$B/pass.mjs" 2>&1)
check "KAN-629 its cells filled, the next pass takes it out of draft with no second upload" \
  'grep -q "^pr ready 784" "$T/gh-calls" && ! grep -q "^784 " "$T/uploads"'
rm -f "$T/upload-fills"
for k in 1 2 3 4 5; do q set "K-$k" state=done session_id=null; dragbody "78$k" "no cell"; done

# DS-798: a merged ticket's follow step that only reads CI goes to a follow-step checker the pass starts,
# and the next pass records what it found, settles a step it passed and says so on the PR. The checker is
# the claude stub answering a prompt that opens as a follow-step checker's: FS-2's step fails, any other passes.
node -e 'const fs = require("fs"); const [src, dst] = process.argv.slice(1); fs.writeFileSync(dst, fs.readFileSync(src, "utf8").replace(/^(\| `pr-images` .*)$/m, "$1\n| `pr-self-review-comment` | Post the review | `yes` | `yes` |"))' "$T/config.md" "$T/config-fs.md"
cp "$T/stub/claude" "$T/claude-before-fs"
cat > "$T/stub/claude" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "-p You are the autopilot follow-step checker for "*)
    echo started >> "$T/follow-prompts"
    case "\$2" in *"FS-2's PR"*) r=fail ;; *"FS-4's PR"*) r=broken; [ -e "$T/fs4-pending" ] && r=pending ;; *) r=pass ;; esac
    $NODE -e 'const r = process.argv[1]; console.log(JSON.stringify({ type: "result", total_cost_usd: 0.03, result: "FOLLOW_RESULT: " + JSON.stringify({ steps: [{ n: 0, result: r, found: r === "pass" ? "run 9 is green" : r === "broken" ? "the a11y scan crashed loading, 0 pages scanned" : "run 9 failed lint", evidence: "https://github.com/acme/widgets/actions/runs/9", ...(r === "broken" ? { source: "E2E (advisory) › a11y scan", issue: 812 } : {}) }] }) }))' "\$r"
    exit 0 ;;
esac
exec "$T/claude-before-fs" "\$@"
EOF
chmod +x "$T/stub/claude"
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh-calls"
case "\$*" in
  "pr list "*) echo '[]' ;;
  "pr comment "*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/stub/gh"
CI_STEP='{"step":"the CI run on main for the merge commit is green","row":null}'
PAGE_STEP='{"step":"check the page loads","row":null}'
fs_merged(){ q add "$1"; q set "$1" state=done result.pr="$2" merged_at=2026-11-20T09:00:00Z "pr_status={\"pr\":$2,\"state\":\"MERGED\",\"merged_at\":\"2026-11-20T09:00:00Z\",\"checks\":[]}" "$3"; }
q init fs
fs_merged FS-1 801 "follow_on=[$CI_STEP,$PAGE_STEP]"
fs_merged FS-2 802 "follow_on=[$CI_STEP]"
fs_merged FS-3 803 "follow_on=[$PAGE_STEP]"
fs_merged FS-4 804 "follow_on=[$CI_STEP]"
: > "$T/gh-calls"; out=$(DESK_CONFIG="$T/config-fs.md" node "$B/pass.mjs" 2>&1)
check "DS-798 AC1 once the merge is recorded, the pass starts a follow-step checker on each ticket's step that only reads CI" \
  'echo "$out" | grep -qF "FS-1 follow steps: a follow-step checker started" && [ "$(field FS-1 follow_run.steps | jq -c "[.[].step]")" = "[\"the CI run on main for the merge commit is green\"]" ] && [ "$(field FS-2 follow_run.steps | jq length)" = 1 ]'
check "DS-798 AC4 a ticket with no step a checker can run gets none" '[ "$(field FS-3 follow_run)" = null ] && ! echo "$out" | grep -qF "FS-3 follow steps"'
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ "$(grep -l FOLLOW_RESULT "$DESK_AUTOPILOT_STATE"/follow/FS-*.json 2>/dev/null | grep -vc settings)" -ge 3 ] && break; sleep 0.2; done
: > "$T/gh-calls"; out=$(DESK_CONFIG="$T/config-fs.md" node "$B/pass.mjs" 2>&1)
check "DS-798 AC1 the next pass records the step it passed and settles it, leaving the person's step" \
  '[ "$(field FS-1 follow_run)" = null ] && [ "$(field FS-1 follow_checks | jq -c "[.[] | [.result, .evidence, .pr]]")" = "[[\"pass\",\"https://github.com/acme/widgets/actions/runs/9\",801]]" ] && [ "$(field FS-1 follow_on)" = "[$PAGE_STEP]" ]'
check "DS-798 AC1 and says what it found on the ticket's PR" \
  'grep -q "^pr comment 801 --repo acme/widgets --body A desk follow-step checker ran the step FS-1 left" "$T/gh-calls" && echo "$out" | grep -qF "FS-1 follow steps: its follow-step checker passed 1 and failed 0; said on PR #801"'
check "#1318 a comment whose ticket keeps a step open (FS-1's page check) does not say nothing is left" \
  'grep -qF "Its other follow steps are still open: needs-you lists each one a person has to take." "$T/gh-calls" && ! grep -qF "Nothing is left for a person." "$T/gh-calls"'
check "DS-798 AC2 a step it failed is recorded with what it found and the run URL, and stays a follow step" \
  '[ "$(field FS-2 follow_checks | jq -c "[.[] | [.result, .found]]")" = "[[\"fail\",\"run 9 failed lint\"]]" ] && [ "$(field FS-2 follow_on | jq length)" = 1 ] && [ "$(field FS-2 follow_on_done)" = null ] && echo "$out" | grep -qF "FS-2 follow steps: its follow-step checker passed 0 and failed 1, each listed in needs-you"'
check "#1318 a step whose evidence source ran and produced nothing is recorded broken, with the step that broke and its issue, and stays a follow step" \
  '[ "$(field FS-4 follow_checks | jq -c "[.[] | [.result, .source, .issue]]")" = "[[\"broken\",\"E2E (advisory) › a11y scan\",812]]" ] && [ "$(field FS-4 follow_on | jq length)" = 1 ] && echo "$out" | grep -qF "FS-4 follow steps: its follow-step checker passed 0 and failed 0, and found the evidence source of 1 broken, ran but produced nothing to judge: E2E (advisory) › a11y scan (#812); listed in needs-you and checked again later"'
check "DS-798 a step a checker ran is not run again" \
  ': > "$T/follow-prompts"; DESK_CONFIG="$T/config-fs.md" node "$B/pass.mjs" >/dev/null 2>&1; [ ! -s "$T/follow-prompts" ] && [ "$(field FS-2 follow_run)" = null ]'
# #1318: six hours on, the broken step is checked again. Still broken as it was, it is not said on the
# PR again; a re-check that finds the run still going keeps it broken, on the same cadence.
fs4_recheck(){
  q set FS-4 "follow_checks=$(field FS-4 follow_checks | jq -c '.[0].at = "2026-11-20T00:00:00.000Z"')"
  n=0; for f in "$DESK_AUTOPILOT_STATE"/follow/FS-4-*.json; do case "$f" in *settings*|*'*'*) ;; *) n=$((n+1)) ;; esac; done
  DESK_CONFIG="$T/config-fs.md" node "$B/pass.mjs" >/dev/null 2>&1
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ "$(grep -l FOLLOW_RESULT "$DESK_AUTOPILOT_STATE"/follow/FS-4-*.json 2>/dev/null | grep -vc settings)" -gt "$n" ] && break; sleep 0.2; done
  : > "$T/gh-calls"; out=$(DESK_CONFIG="$T/config-fs.md" node "$B/pass.mjs" 2>&1)
}
fs4_recheck
check "#1318 a step still broken as it was is checked again and not said on the PR again" \
  '[ "$(field FS-4 follow_checks | jq -c "[.[] | .result]")" = "[\"broken\"]" ] && [ "$(field FS-4 follow_checks | jq -r ".[0].at")" != 2026-11-20T00:00:00.000Z ] && ! grep -q "^pr comment 804" "$T/gh-calls" && echo "$out" | grep -qF "FS-4 follow steps: its follow-step checker passed 0 and failed 0, and found the evidence source of 1 broken"'
: > "$T/fs4-pending"; fs4_recheck; rm -f "$T/fs4-pending"
check "#1318 a re-check that finds the run still going keeps the step broken, with its source and issue" \
  '[ "$(field FS-4 follow_checks | jq -c "[.[] | [.result, .source, .issue]]")" = "[[\"broken\",\"E2E (advisory) › a11y scan\",812]]" ] && [ "$(field FS-4 follow_checks | jq -r ".[0].at")" != 2026-11-20T00:00:00.000Z ]'
cp "$T/claude-before-fs" "$T/stub/claude"

# ---- DS-843 AC4: a config row the pass cannot read stops it before it starts any worker.
# A §4 Evidence workflow row naming `none` beside a workflow is a config error, and the pass uses the
# row only after its spawns.
export DESK_QUEUE="$T/queue-771.json" DESK_AUTOPILOT_STATE="$T/state-771"; mkdir -p "$T/state-771/logs"
{ cat "$T/config.md"; printf '\n## 4. Tracker, tools and team\n\n| Field | Value |\n|---|---|\n| Evidence workflow | `none` `x.yml` |\n'; } > "$T/config-771.md"
q init c771; q set-batch concurrency=1
q add C-1; q set C-1 state=triaged branch=fix/C-1
out=$(DESK_CONFIG="$T/config-771.md" node "$B/pass.mjs" 2>&1); rc=$?
check "DS-843 AC4 an unreadable Evidence workflow row stops the pass with its error before any spawn" \
  '[ $rc -eq 11 ] && echo "$out" | grep -q "pass.mjs crashed: .*Evidence workflow" && ! echo "$out" | grep -q "spawned" && [ "$(field C-1 state)" = "\"triaged\"" ] && [ "$(field C-1 session_id)" = null ]'
jout=$(DESK_CONFIG="$T/config-771.md" node "$B/pass.mjs" --json 2>/dev/null)
check "DS-843 AC4 and its JSON error names no spawned ticket" \
  'echo "$jout" | jq -e ".status == \"error\" and (has(\"spawned\") | not)" >/dev/null'

# ---- DS-893: with the ledger lever on, a pass's spawn (its state=running write, made as queue.mjs)
# appends a spawned event naming the pass; with the ledger's lock held past its wait, the queue is still
# written and the pass's report names the missed append. The queue sits in a folder of its own, so the
# log beside it is this case's alone.
export DESK_QUEUE="$T/lg/queue.json" DESK_AUTOPILOT_STATE="$T/state-lg"; mkdir -p "$T/lg" "$T/state-lg/logs"
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `ledger` |\n'; } > "$T/config-lg.md"
q init lg; q set-batch concurrency=2
q add LG-1; q set LG-1 state=triaged lane=A branch=fix/LG-1
out=$(DESK_CONFIG="$T/config-lg.md" node "$B/pass.mjs" 2>&1)
check "DS-893 AC2 with the ledger lever on, a pass's spawn is a spawned event naming the pass" \
  '[ "$(field LG-1 state)" = "\"running\"" ] && [ "$(jq -sc "[.[] | select(.key == \"LG-1\" and .type == \"spawned\") | .by.proc]" "$T/lg/ledger/events.jsonl")" = "[\"pass\"]" ]'
# DS-894: the pass then compares queue.json with the queue rebuilt from the log, and its metrics line
# records the counts. lgm is the last pass's [differences, missed appends].
lgm(){ tail -1 "$T/state-lg/passes.jsonl" | jq -c "[.ledger_diffs, .ledger_missed]"; }
check "DS-894 AC1/AC4 a batch with no log, seeded by the pass's writes, matches it: no difference line, and the metrics record zero" \
  '! echo "$out" | grep -q "differ between queue.json" && [ "$(lgm)" = "[0,0]" ]'
jq '.tickets["LG-1"].lane = "Z"' "$T/lg/queue.json" > "$T/lg/q.tmp" && mv "$T/lg/q.tmp" "$T/lg/queue.json"
out=$(DESK_CONFIG="$T/config-lg.md" node "$B/pass.mjs" 2>&1)
check "DS-894 AC2 a field written past the queue store: the report names the ticket and field, and the metrics count it" \
  'echo "$out" | grep -q "ledger: 1 field(s) differ between queue.json and the queue rebuilt from the log, 0 missed append(s) this pass: LG-1 lane" && [ "$(lgm)" = "[1,0]" ]'
DESK_CONFIG="$T/config-lg.md" q add LG-2; DESK_CONFIG="$T/config-lg.md" q set LG-2 state=triaged lane=A branch=fix/LG-2
mkdir "$T/lg/ledger/.lock"; echo $$ > "$T/lg/ledger/.lock/pid"
out=$(DESK_CONFIG="$T/config-lg.md" node "$B/pass.mjs" 2>&1); rm -rf "$T/lg/ledger/.lock"
check "DS-893 AC10 the ledger locked past its wait: the spawn is still recorded, and the report names the missed append" \
  '[ "$(field LG-2 state)" = "\"running\"" ] && echo "$out" | grep -q "ledger: 1 missed append" && ! jq -e "select(.key == \"LG-2\" and .type == \"spawned\")" "$T/lg/ledger/events.jsonl" >/dev/null'
check "DS-894 AC5 the pass whose spawn missed its append counts it, and names the field it left unrecorded" \
  'echo "$out" | grep -qE "ledger: [1-9][0-9]* field\(s\) differ between queue.json and the queue rebuilt from the log, [1-9][0-9]* missed append\(s\) this pass: LG-1 lane, LG-2 " && [ "$(lgm | jq ".[0] > 1 and .[1] > 0")" = true ] && DESK_CONFIG="$T/config-lg.md" node "$B/queue.mjs" rebuild | grep -q "^LG-2 state: queue.json \"running\", rebuilt \"triaged\""'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-894 AC7 with the lever off, no difference line and no difference count" \
  '! echo "$out" | grep -q "differ between queue.json" && [ "$(tail -1 "$T/state-lg/passes.jsonl" | jq "has(\"ledger_diffs\") or has(\"ledger_missed\")")" = false ]'

# ---- DS-905: with the ledger and ledger-record levers on, a pass's writes go to the log first and
# queue.json records the log's position; a queue.json deleted is rebuilt from the log by the next pass,
# which says so. The record lever alone is ignored, and the pass says it needs the ledger lever.
export DESK_QUEUE="$T/rec/queue.json" DESK_AUTOPILOT_STATE="$T/state-rec"; mkdir -p "$T/rec" "$T/state-rec/logs"
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `ledger ledger-record` |\n'; } > "$T/config-rec.md"
{ cat "$T/config.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `ledger-record` |\n'; } > "$T/config-reconly.md"
q init rec; q set-batch concurrency=2
q add RC-1; q set RC-1 state=triaged lane=A branch=fix/RC-1
out=$(DESK_CONFIG="$T/config-rec.md" node "$B/pass.mjs" 2>&1)
check "DS-905 AC1 in record mode a pass's spawn is a spawned event, and queue.json records the log position it holds" \
  '[ "$(field RC-1 state)" = "\"running\"" ] && jq -e "select(.key == \"RC-1\" and .type == \"spawned\")" "$T/rec/ledger/events.jsonl" >/dev/null && [ "$(jq .ledger_seq "$T/rec/queue.json")" = "$(tail -1 "$T/rec/ledger/events.jsonl" | jq .seq)" ] && ! echo "$out" | grep -q "differ between queue.json"'
rm "$T/rec/queue.json"
out=$(DESK_CONFIG="$T/config-rec.md" node "$B/pass.mjs" 2>&1)
check "DS-905 AC2 a deleted queue.json is rebuilt from the log by the next pass, which says so and stops for the batch fields" \
  '[ "$(field RC-1 state)" = "\"running\"" ] && [ "$(field RC-1 branch)" = "\"fix/RC-1\"" ] && echo "$out" | grep -q "ledger: queue.json was missing, so it was rebuilt from the log at .* (1 ticket(s)).*the pass stops until they are set again"'
out=$(DESK_CONFIG="$T/config-rec.md" node "$B/pass.mjs" 2>&1)
check "DS-905 every pass after the rebuild stops too, until the batch fields are set again" \
  'echo "$out" | grep -q "the pass stops until they are set again"'
q set-batch concurrency=2 rebuilt_from_log=null
out=$(DESK_CONFIG="$T/config-rec.md" node "$B/pass.mjs" 2>&1)
check "DS-905 and once they are, the pass runs" \
  '! echo "$out" | grep -q "the pass stops until" && [ "$(jq .rebuilt_from_log "$T/rec/queue.json")" = "null" ]'
out=$(DESK_CONFIG="$T/config-reconly.md" node "$B/pass.mjs" 2>&1)
check "DS-905 AC6 the record lever without the ledger lever is ignored, and the pass says it needs the ledger lever" \
  'echo "$out" | grep -q "ledger: the ledger-record lever is ignored: it needs the ledger lever on as well"'

# ---- the ask ledger: with the ledger lever on, the first worker after a park's requeue acts on its
# answer, on a plain spawn and a handoff's alike; a production-broken park pushed now is an ask presented
# by push; the pass's own take of a recommended option answers its ask by default. A pass again writes
# nothing twice, and with the lever off nothing is written. The batch is made with the lever on, so its
# ledger names it from the start, as a batch run with the lever on has.
AK_CONFIG="$DESK_CONFIG"; export DESK_CONFIG="$T/config-lg.md"
export DESK_QUEUE="$T/ak/queue.json" DESK_AUTOPILOT_STATE="$T/state-ak"; mkdir -p "$T/ak" "$T/state-ak/logs" "$T/state-ak/handoffs"
q init ak; q set-batch concurrency=4
q add AK-1; q set AK-1 state=triaged lane=A branch=fix/AK-1 'prev_park={"question":"which copy?","since":"2026-11-20T10:00:00Z","requeued_at":"2026-11-20T11:00:00Z","round":2}'
q add AK-2; q set AK-2 state=parked lane=A branch=fix/AK-2 'park={"kind":"question","question":"PRODUCTION BROKEN: checkout returns 500","since":"2026-11-20T09:00:00Z"}'
git -C "$T/repo" worktree add -q -b fix/AK-6 "$T/wt/AK-6"
q add AK-6; q set AK-6 state=triaged lane=A branch=fix/AK-6 "worktree=$T/wt/AK-6" handoff=pending handoff_stage=4b 'prev_park={"question":"which width?","since":"2026-11-20T08:00:00Z","round":1}'; hfile AK-6 4b "typecheck: pass"
AKQ='AK-5: widen this PR to cover the CSV export too (recommended), or split the export into a follow-up?'
q add AK-5; q set AK-5 state=parked lane=A "park={\"kind\":\"question\",\"question\":\"$AKQ\",\"since\":\"2026-11-20T07:00:00Z\",\"recommends\":{\"question\":\"Widen this PR, or split?\",\"options\":[\"widen this PR\",\"split it into a follow-up\"],\"chose\":\"widen this PR\",\"category\":\"scope\"}}"
out=$(CLAUDE_CODE_SESSION_ID=sess-pass node "$B/pass.mjs" 2>&1)
akev(){ jq -sc "[.[] | select(.type | startswith(\"ask_\")) | [.type, .key, .data.ask, (.data.round // .data.via // .data.by // .data.kind)]]" "$T/ak/ledger/events.jsonl"; }
has(){ akev | jq -e "any(. == $1)" >/dev/null; }
# AK-1 and AK-5 (requeued by the take) both wait on a plain spawn; the repo's shared cap may leave room
# for one, so each that started is checked, and one must have.
plain(){ local n=0
  if [ "$(field AK-1 state)" = "\"running\"" ]; then has "[\"ask_acted\",\"AK-1\",\"AK-1:2026-11-20T10:00:00Z\",2]" || return 1; n=1; fi
  if [ "$(field AK-5 state)" = "\"running\"" ]; then has "[\"ask_acted\",\"AK-5\",\"AK-5:2026-11-20T07:00:00Z\",1]" || return 1; n=1; fi
  [ "$n" = 1 ]; }
check "ask ledger: a plain spawn after a park's requeue acts on its ask, with the park's round" 'plain'
check "ask ledger: so does a requeued ticket's handoff spawn" \
  'echo "$out" | grep -q "AK-6 fresh session from Stage 4b (handed off)" && has "[\"ask_acted\",\"AK-6\",\"AK-6:2026-11-20T08:00:00Z\",1]"'
check "ask ledger: a production-broken park pushed now is raised and presented by push" \
  'echo "$out" | grep -q "PUSH: AK-2: PRODUCTION BROKEN" && has "[\"ask_raised\",\"AK-2\",\"AK-2:2026-11-20T09:00:00Z\",\"question\"]" && has "[\"ask_presented\",\"AK-2\",\"AK-2:2026-11-20T09:00:00Z\",\"push\"]"'
check "ask ledger: the pass's take of a recommended option raises its ask and answers it by default, with no session" \
  'echo "$out" | grep -qF "AK-5: took the recommended option" && has "[\"ask_raised\",\"AK-5\",\"AK-5:2026-11-20T07:00:00Z\",\"question\"]" && has "[\"ask_answered\",\"AK-5\",\"AK-5:2026-11-20T07:00:00Z\",\"default\"]" && [ "$(jq -sc "[.[] | select(.type == \"ask_answered\") | .data.session]" "$T/ak/ledger/events.jsonl")" = "[null]" ]'
check "ask ledger: the pass measures each ask's tokens: a raise no worker log wrote is complete false, with no figures" \
  '[ "$(jq -sc "[.[] | select(.type == \"ask_tokens\" and .key == \"AK-2\") | [.data.step, .data.source, .data.input, .data.complete]]" "$T/ak/ledger/events.jsonl")" = "[[\"raise\",\"log\",null,false]]" ]'
n=$(akev | jq length)
out=$(node "$B/pass.mjs" 2>&1)
check "ask ledger: the next pass, pushing it again, writes nothing twice" '[ "$n" -ge 6 ] && [ "$(akev | jq length)" = "$n" ]'
export DESK_CONFIG="$AK_CONFIG"
export DESK_QUEUE="$T/ak-off/queue.json" DESK_AUTOPILOT_STATE="$T/state-ak-off"; mkdir -p "$T/ak-off" "$T/state-ak-off/logs"
q init akoff; q set-batch concurrency=2
q add AK-3; q set AK-3 state=triaged lane=A branch=fix/AK-3 'prev_park={"question":"which copy?","since":"2026-11-20T10:00:00Z","round":1}'
q add AK-4; q set AK-4 state=parked lane=A branch=fix/AK-4 'park={"kind":"question","question":"PRODUCTION BROKEN: login fails","since":"2026-11-20T09:00:00Z"}'
out=$(node "$B/pass.mjs" 2>&1)
check "ask ledger: with the lever off, the same spawn and push as with it on write no ledger and the pass reports nothing of it" \
  '[ "$n" -ge 6 ] && [ "$(field AK-3 state)" = "\"running\"" ] && echo "$out" | grep -q "PUSH: AK-4: PRODUCTION BROKEN" && [ ! -e "$T/ak-off/ledger" ] && ! echo "$out" | grep -q "ask ledger"'

# ---- question handling: on the batched arm, a park's recommended call desk may not take for the worker
# applies by default at the first check-in after a digest listed it; never before a digest has, nor with
# the lever off, nor for a product call. QH-1 to QH-3 were listed at 09:00Z five days ago, so a check-in
# has passed since; QH-5 was listed just now. Whichever path raises an ask first, it carries the arm.
export DESK_CONFIG="$T/config-lg.md" DESK_QUEUE="$T/qh/queue.json" DESK_AUTOPILOT_STATE="$T/state-qh"; mkdir -p "$T/qh" "$T/state-qh/logs"
q init qh; q set-batch concurrency=1
qh_pin(){ printf 'levers={"set":[],"values":{"question-handling":"%s"},"at":"2026-11-20T00:00:00Z"}' "$1"; }
qh_park(){ q add "$1"; q set "$1" state=parked lane=A "park={\"kind\":\"question\",\"question\":\"$1: two columns or one?\",\"since\":\"2026-11-20T07:00:00Z\",\"recommends\":{\"question\":\"Two columns or one?\",\"options\":[\"two columns\",\"one column\"],\"chose\":\"two columns\",\"category\":\"$2\"}}" "${@:3}"; }
qh_park QH-1 design "$(qh_pin batched)"; qh_park QH-2 design; qh_park QH-3 product "$(qh_pin batched)"; qh_park QH-4 design "$(qh_pin batched)"; qh_park QH-5 design "$(qh_pin batched)"
q add QH-6; q set QH-6 state=parked lane=A 'park={"kind":"question","question":"PRODUCTION BROKEN: search returns 500","since":"2026-11-20T08:00:00Z"}' "$(qh_pin one-at-a-time)"
node --input-type=module -e "
import { queueDifference } from '$B/queue-ledger.mjs';
import { recordAsks } from '$B/ask-ledger.mjs';
queueDifference('$DESK_QUEUE', { seed: true });
const listed = (key, at) => recordAsks('$DESK_QUEUE', [{ step: 'presented', key, since: '2026-11-20T07:00:00Z', via: 'digest', ref: 'page.md' }], { on: true, now: new Date(at) });
for (const k of ['QH-1', 'QH-2', 'QH-3']) listed(k, '2026-11-20T09:00:00Z');
listed('QH-5', new Date().toISOString());"
out=$(node "$B/pass.mjs" 2>&1)
qh_raised(){ jq -sc "[.[] | select(.type == \"ask_raised\" and .key == \"$1\") | [.data.arm, .data.blocking]]" "$T/qh/ledger/events.jsonl"; }
check "question handling: a batched-arm design call a digest listed applies its recommendation by default at the next check-in, and is requeued" \
  '[ "$(field QH-1 state)" != "\"parked\"" ] && [ "$(field QH-1 auto_answered.chose)" = "\"two columns\"" ] && grep -q "^two columns. This was the option the last worker recommended .* listed it and nobody answered it by the next check-in, so desk applied it by default" "$T/state-qh/briefings/QH-1.md" && echo "$out" | grep -qF "QH-1: nobody answered its design call by the check-in after the digest listed it, so its recommended option (\"two columns\") applied by default"'
check "question handling: it is logged as a decision taken by default, saying how to reverse it" \
  'jq -e "select(.ticket == \"QH-1\" and .source == \"default\" and .chose == \"two columns\" and (.question | test(\"To reverse it, override it here with one column\")))" "$T/state-qh/decisions.jsonl" >/dev/null'
check "question handling: and its ask is answered by default in the ticket ledger, raised by the take with its arm" \
  '[ "$(jq -sc "[.[] | select(.type == \"ask_answered\" and .key == \"QH-1\") | .data.by]" "$T/qh/ledger/events.jsonl")" = "[\"default\"]" ] && [ "$(qh_raised QH-1)" = "[[\"batched\",true]]" ]'
check "question handling: never before a digest has listed it, nor before the check-in after the digest that did" \
  '[ "$(field QH-4 state)" = "\"parked\"" ] && [ "$(field QH-5 state)" = "\"parked\"" ] && ! grep -q "QH-[45]" "$T/state-qh/decisions.jsonl"'
check "question handling: with the lever off, and for a product call, nothing applies by default" \
  '[ "$(field QH-2 state)" = "\"parked\"" ] && [ "$(field QH-3 state)" = "\"parked\"" ] && [ "$(field QH-2 auto_answered)" = null ] && ! grep -q "QH-[23]" "$T/state-qh/decisions.jsonl"'
check "question handling: a production-broken park raised by the pass's own push carries its arm" \
  'echo "$out" | grep -q "PUSH: QH-6: PRODUCTION BROKEN" && [ "$(qh_raised QH-6 | jq -c "map(.[0])")" = "[\"one-at-a-time\"]" ]'
export DESK_CONFIG="$AK_CONFIG"

echo "pass: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
