#!/usr/bin/env bash
# suite: base sync: CI reopens, the epic PR, the merged-tree check and promotion
# The base sync, set up by base_sync_setup.sh: a PR whose CI runs only once the base has main's
# trigger, the epic PR and its review try, §4 Merged-tree check, parks waiting on the base containing
# main, and the promotion PR's check try.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=base_sync_setup.sh
. "$S/base_sync_setup.sh"
# The lock and usage directories these passes ran with when they shared one suite with the push cases.
mkdir -p "$T/lock" "$T/usage" "$HOME/.claude"; export DESK_LOCK_DIR="$T/lock" DESK_USAGE_DIR="$T/usage"
ln -sf "$B/with-lock.sh" "$T/desk/bin/with-lock.sh"

# DS-416: a base cut before main added feat/** to the CI trigger. gh serves PR #801 into feat/x with
# its required check "tests" unreported, and ci.yml at three refs: the PR's head as written below,
# the base from $T/basewf and main from $T/mainwf. The base head is $T/bhead. Every gh call is logged to $T/ghlog.
cat > "$T/stub/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/ghlog"
case "\$1 \$2" in
  "pr view") printf '{"state":"%s","url":null,"isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","headRefOid":"h1","headRefName":"feat/T-1","baseRefName":"feat/x","baseRefOid":"%s","statusCheckRollup":[{"name":"Vercel","status":"COMPLETED","conclusion":"SUCCESS"}]}\n' "\$(cat "$T/prstate" 2>/dev/null || echo OPEN)" "\$(cat "$T/bhead")"; exit 0 ;;
  "pr close") echo CLOSED > "$T/prstate"; exit 0 ;;
  "pr reopen") [ -e "$T/reopenfail" ] && { echo "HTTP 502" >&2; exit 1; }; echo OPEN > "$T/prstate"; exit 0 ;;
esac
case "\$*" in
  *"workflows?ref="*--jq*) echo .github/workflows/ci.yml ;;
  *"ci.yml?ref=h1"*) printf 'on:\n  pull_request:\n    branches: [main]\njobs:\n  tests:\n    runs-on: x\n' ;;
  *"ci.yml?ref=feat%2Fx"*) printf 'on:\n  pull_request:\n    branches: %s\njobs:\n  tests:\n    runs-on: x\n' "\$(cat "$T/basewf")" ;;
  *"ci.yml?ref=main"*) printf 'on:\n  pull_request:\n    branches: %s\njobs:\n  tests:\n    runs-on: x\n' "\$(cat "$T/mainwf")" ;;
esac
exit 0
EOF
chmod +x "$T/stub/gh"
reopens(){ grep -c "^pr reopen 801" "$T/ghlog" 2>/dev/null || true; }
# A base behind main syncs on any pass (DS-542), so these bases start current with main, and main moves
# on only after the pass that reads the PR.
current(){ git -C "$C/repo" push -q origin main:feat/x; }
mainmoves(){ git -C "$C/repo" commit -q --allow-empty -m three; git -C "$C/repo" commit -q --allow-empty -m four; git -C "$C/repo" push -q origin main; }
fresh stale416; current; echo "[main, 'feat/**']" > "$T/mainwf"
printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Required checks | `tests` |\n' >> "$C/config.md"
node "$B/queue.mjs" set T-1 state=done result.pr=801 >/dev/null
echo '[main]' > "$T/basewf"; echo b1 > "$T/bhead"; : > "$T/ghlog"; pass
check "DS-416 the PR's check only main's workflow runs on the base is recorded as behind" \
  '[ "$(jq -r ".tickets[\"T-1\"].pr_status.behind.tests" "$DESK_QUEUE")" != null ] && [ "$(jq -r ".tickets[\"T-1\"].pr_status.untriggered" "$DESK_QUEUE")" = null ] && [ "$(reopens)" = 0 ]'
# The sync brings main's trigger to the base, which gh's base copy stands in for.
echo "[main, 'feat/**']" > "$T/basewf"; mainmoves; pass
check "DS-416 AC2 with nothing to spawn, the base syncs for the PR's CI" 'origin_has_main && [[ "$out" == *"merged 2 commit(s) from main into feat/x and pushed; PR #801 is reopened so CI runs"* ]] && [[ "$out" != *"spawned:"* ]]'
check "DS-416 AC4 the PR is closed and reopened, and the base head recorded" \
  'grep -q "^pr close 801" "$T/ghlog" && [ "$(reopens)" = 1 ] && [ "$(jq -r .reopened_at "$DESK_QUEUE")" = b1 ] && [[ "$out" == *"closed and reopened PR #801 (T-1)"* ]]'
pass
check "DS-416 AC4 once per base head: the next pass at b1 does not reopen it again" '[ "$(reopens)" = 1 ]'
echo b2 > "$T/bhead"; pass
check "DS-416 AC4 a new base head reopens it once more" '[ "$(reopens)" = 2 ] && [ "$(jq -r .reopened_at "$DESK_QUEUE")" = b2 ]'
check "DS-416 a reopened PR is marked so until the next pass reads it" \
  '[ "$(jq -r ".tickets[\"T-1\"].pr_status.reopened" "$DESK_QUEUE")" = true ] && [ "$(jq -r ".tickets[\"T-1\"].reopening" "$DESK_QUEUE")" = null ]'
closes(){ grep -c "^pr close 801" "$T/ghlog" 2>/dev/null || true; }
# A reopen that fails leaves the PR closed: the ticket owes it, and the next pass reopens it.
echo b3 > "$T/bhead"; touch "$T/reopenfail"; pass
check "DS-416 a failed reopen is owed on the ticket and said, the head still recorded" \
  '[ "$(cat "$T/prstate")" = CLOSED ] && [ "$(jq -r ".tickets[\"T-1\"].reopening" "$DESK_QUEUE")" = 801 ] && [ "$(jq -r .reopened_at "$DESK_QUEUE")" = b3 ] && [[ "$out" == *"PR #801 (T-1) is closed, to start its CI, and did not reopen"* ]]'
c=$(closes); out=$(node "$B/pass.mjs" --json 2>/dev/null)
check "DS-416 a second failed reopen records the PR closed and still owed" \
  '[ "$(jq -r ".tickets[\"T-1\"].pr_status.state" "$DESK_QUEUE")" = CLOSED ] && [ "$(jq -r ".tickets[\"T-1\"].reopening" "$DESK_QUEUE")" = 801 ] && [ "$(closes)" = "$c" ]'
check "DS-416 a batch whose last PR is closed and owed its reopen is not idle" '[ "$(printf "%s" "$out" | jq -r .status)" = show_person ]'
rm -f "$T/reopenfail"; pass
check "DS-416 the next pass reads the closed PR again and reopens it without closing it again" \
  '[ "$(cat "$T/prstate")" = OPEN ] && [ "$(closes)" = "$c" ] && [ "$(jq -r ".tickets[\"T-1\"].reopening" "$DESK_QUEUE")" = null ] && [[ "$out" == *"closed and reopened PR #801 (T-1)"* ]]'
c=$(closes); r=$(reopens); pass
check "DS-416 once reopened, the same base head does not close it again" '[ "$(closes)" = "$c" ] && [ "$(reopens)" = "$r" ]'
fresh trig416 yes; current; printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Required checks | `tests` |\n' >> "$C/config.md"
node "$B/queue.mjs" set T-1 state=done result.pr=801 >/dev/null
echo '[main]' > "$T/basewf"; echo '[main]' > "$T/mainwf"; : > "$T/ghlog"; pass; mainmoves; pass
check "DS-416 AC5 a check main's workflow does not run on the base either is untriggered: the behind base syncs, no reopen" \
  '[ "$(jq -r ".tickets[\"T-1\"].pr_status.untriggered.tests" "$DESK_QUEUE")" != null ] && origin_has_main && [[ "$out" == *"base sync: merged 2 commit(s) from main into feat/x"* ]] && [[ "$out" != *"is reopened so CI runs"* ]] && [ "$(reopens)" = 0 ]'

# DS-508: an epic batch not in feature mode lands its base through one epic PR, opened once every child
# has merged. gh serves each PR from $T/ep/<n>.json and its GraphQL review read from $T/ep/<n>.graphql;
# `pr create` opens #300 (refused while $T/ep/create.fail exists), and `pr ready` takes it out of draft.
mkdir -p "$T/ep"
cat > "$T/stub/gh" <<EOF
#!$(node -p process.execPath)
const fs = require('fs');
const a = process.argv.slice(2);
const at = (f) => a[a.indexOf(f) + 1];
fs.appendFileSync('$T/ghlog', a.join(' ') + '\n');
const file = (n, ext = 'json') => '$T/ep/' + n + '.' + ext;
if (a[0] === 'pr' && a[1] === 'view' && fs.existsSync(file(a[2]))) {
  const p = JSON.parse(fs.readFileSync(file(a[2]), 'utf8'));
  console.log(at('--jq') === '.state' ? p.state : JSON.stringify(p));
} else if (a[0] === 'pr' && a[1] === 'create') {
  if (fs.existsSync('$T/ep/create.fail')) { console.error('GraphQL: Resource not accessible by integration'); process.exit(1); }
  fs.writeFileSync(file(300), JSON.stringify({ state: 'OPEN', isDraft: a.includes('--draft'), headRefOid: 'e'.repeat(40) }));
  console.log('https://github.com/acme/widgets/pull/300');
} else if (a[0] === 'pr' && a[1] === 'ready') {
  const p = JSON.parse(fs.readFileSync(file(a[2]), 'utf8')); p.isDraft = false; fs.writeFileSync(file(a[2]), JSON.stringify(p));
} else if (a[0] === 'api' && a.includes('graphql')) {
  const n = (a.find((x) => x.startsWith('n=')) ?? '').slice(2);
  if (fs.existsSync(file(n, 'graphql'))) process.stdout.write(fs.readFileSync(file(n, 'graphql'), 'utf8'));
}
EOF
chmod +x "$T/stub/gh"
# review <counts, or - for none>: PR #300's GraphQL read, with the user's desk-review at its head.
EH=$(printf 'e%.0s' $(seq 1 40))
review(){ node -e 'const [f, sha, c] = process.argv.slice(1);
  const nodes = c === "-" ? [] : [{ id: "R1", author: { login: "tester" }, commit: { oid: sha }, body: ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${sha} ${c} vendor=codex round=1 -->`].join("\n") }];
  require("fs").writeFileSync(f, JSON.stringify({ data: { repository: { pullRequest: { headRefOid: sha, reviewDecision: null, reviews: { nodes }, reviewThreads: { nodes: [] } } } } }));' "$T/ep/300.graphql" "$EH" "$1"; }
epicrows(){ printf '| `pr-open` | Open a draft PR | `yes` | `yes` |\n| `pr-ready` | Undraft | `yes` | `yes` |\n| `pr-conflict-unreviewed` | Resolve a conflict | `yes` | `yes` |\n' >> "$C/config.md"
  printf '\n## 1. Who you are\n| Field | Value |\n|---|---|\n| GitHub handle | `tester` |\n\n## 4. Tools\n| Field | Value |\n|---|---|\n| Local review command | `/desk-review` |\n| Clean review verdict | `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0` |\n' >> "$C/config.md"; }
fresh epic508; epicrows; rm -f "$T/ep"/*; : > "$T/spawns"; : > "$T/ghlog"; rm -f "$T/agents.json"
node "$B/queue.mjs" set-batch epic=E-8 feature=false >/dev/null
node "$B/queue.mjs" set T-1 state=done result.pr=801 merged_at=2026-11-06T10:00:00Z >/dev/null
echo '{"state":"MERGED","mergedAt":"2026-11-06T10:00:00Z"}' > "$T/ep/801.json"
node "$B/queue.mjs" add T-2 >/dev/null
node "$B/queue.mjs" set T-2 state=parked 'park={"question":"held by orchestrator: behind T-1, E-8"}' 'held_by=T-1|E-8' held_outside=E-8 >/dev/null
touch "$T/ep/create.fail"; pass
check "DS-508 AC4 an epic PR that cannot be opened is put to the person with the reason, exit 11, never 10" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"epic PR: not opened — gh pr create failed: GraphQL: Resource not accessible by integration. Every child has merged into feat/x, and nothing lands on main until it is open"* ]]'
check "DS-508 AC5 a ticket held behind the epic waits on the epic PR, saying why there is none, not on a merge" \
  '[[ "$out" == *"WAITING ON EPIC PR: T-2 (E-8: no epic PR: gh pr create failed"* ]] && [[ "$out" != *"WAITING ON MERGE"* ]]'
pass
check "DS-508 AC4 it is tried again, and said again, on the next pass" '[ $rc -eq 11 ] && [ "$(grep -c "^pr create" "$T/ghlog")" = 2 ] && [[ "$out" == *"epic PR: not opened"* ]]'
rm "$T/ep/create.fail"; pass
check "DS-508 AC1 once every child has merged, the epic PR opens as a draft from the base, and is recorded" \
  'grep -q "^pr create --repo acme/widgets --draft --base main --head feat/x --title E-8: promote feat/x to main" "$T/ghlog" && [ "$(jq -r .promotion.pr "$DESK_QUEUE")" = 300 ] && [[ "$out" == *"epic PR #300 opened as a draft, feat/x → main"* ]]'
check "DS-508 AC1 and the batch is not idle" '[[ "$out" != *"IDLE"* ]]'
review -; pass
check "DS-508 AC2 a draft epic PR with no clean review gets a review try in the base worktree" \
  'grep -q "^base-feat-x $C/wt/base-feat-x feat/x .*It is epic PR #300, which merges this batch.s base feat/x into main" "$T/spawns" && [ "$(jq -r ".base_fix.tries[0].kind" "$DESK_QUEUE")" = review ] && [[ "$out" == *"epic PR review try 1 of 2 on feat/x, PR #300"* ]]'
check "DS-508 AC5 and the held ticket says it waits on the epic PR by number" '[[ "$out" == *"WAITING ON EPIC PR: T-2 (E-8: epic PR #300, in draft until a clean review stands at its head)"* ]]'
live; pass
check "DS-508 AC2 a live review try is waited on, not doubled" '[ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [[ "$out" == *"epic PR #300: review try 1 of 2 is at it"* ]]'
ended "AUTOPILOT_DONE: pr=300 jira=none"; rm -f "$T/agents.json"; pass
check "DS-508 AC2 a try that ended with no clean review at the same head goes to the person, exit 11" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"EPIC PR: #300 stays draft: no clean review at eeeeeeeeeeee after 1 review try; the last try finished: pr=300 jira=none"* ]] && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ]'
review "p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0"; pass
check "DS-508 AC2 a clean review at its head takes it out of draft" 'grep -q "^pr ready 300 --repo acme/widgets" "$T/ghlog" && [ "$(jq -r .isDraft "$T/ep/300.json")" = false ]'
pass
check "DS-508 AC3 out of draft with no merge driver granted, it is put to the person naming the rows, exit 11" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"EPIC PR: #300 is out of draft, but no merge driver merges it (config §3 autopilot-merge"* ]]'
echo '{"state":"MERGED","mergedAt":"2026-11-07T09:00:00Z"}' > "$T/ep/300.json"; pass
check "DS-508 AC6 once the epic PR merges, it is recorded and the epic is lifted from the held ticket" \
  '[ "$(jq -r .promotion.merged_at "$DESK_QUEUE")" = 2026-11-07T09:00:00Z ] && [[ "$(jq -r ".tickets[\"T-2\"].held_by // \"\"" "$DESK_QUEUE")" != *E-8* ]] && [[ "$out" == *"outside hold: T-2: E-8 landed on main through its epic PR"* ]]'
pass
check "DS-508 AC6 and with its other blocker merged, it is released" '[ "$(jq -r ".tickets[\"T-2\"].state" "$DESK_QUEUE")" != parked ]'
node "$B/queue.mjs" drop T-2 >/dev/null; pass
check "DS-508 AC6 with the epic PR merged and nothing left, the batch reads idle" '[[ "$out" == *"IDLE"* ]] && [ "$(grep -c "^pr create" "$T/ghlog")" = 3 ]'
# Held behind another epic whose batch the supervisor archived as its epic PR merged by hand, before its
# own pass could record the merge: read from GitHub in the archived copy.
SQ=$(node --input-type=module -e "const E = await import('$B/desk-env.mjs'); console.log(E.batchPaths(E.repoSlug()).queue)")
mkdir -p "$(dirname "$SQ")/batches/.done/E-9"
echo '{"epic":"E-9","base":"feat/y","feature":false,"promotion":{"pr":900},"tickets":{}}' > "$(dirname "$SQ")/batches/.done/E-9/queue.json"
echo '{"state":"MERGED","mergedAt":"2026-11-07T10:00:00Z"}' > "$T/ep/900.json"
node "$B/queue.mjs" add T-3 >/dev/null
node "$B/queue.mjs" set T-3 state=parked 'park={"question":"held by orchestrator: behind E-9"}' held_by=E-9 held_outside=E-9 >/dev/null
pass
check "DS-508 AC6 a ticket held behind an epic whose batch was archived with its epic PR merged is released" \
  '[[ "$out" == *"outside hold: T-3: E-9 landed on main through its epic PR"* ]] && [ "$(jq -r ".tickets[\"T-3\"].state" "$DESK_QUEUE")" != parked ]'
# DS-815: an archived epic batch whose epic PR closed unmerged is read from GitHub once, and kept beside
# the archive, not read again on every pass the ticket behind it stays held.
mkdir -p "$(dirname "$SQ")/batches/.done/E-10"
echo '{"epic":"E-10","base":"feat/w","feature":false,"promotion":{"pr":901},"tickets":{}}' > "$(dirname "$SQ")/batches/.done/E-10/queue.json"
echo '{"state":"CLOSED"}' > "$T/ep/901.json"
node "$B/queue.mjs" add T-5 >/dev/null
node "$B/queue.mjs" set T-5 state=parked 'park={"question":"held by orchestrator: behind E-10"}' held_by=E-10 held_outside=E-10 >/dev/null
pass; pass
check "DS-815 an archived epic PR that closed unmerged is read from GitHub once in the interval, and kept beside the archive" \
  '[ "$(grep -c "^pr view 901 " "$T/ghlog")" = 1 ] && [ "$(jq -r .state "$(dirname "$SQ")/batches/.done/E-10/promotion-read.json")" = CLOSED ] && [ "$(jq -r ".tickets[\"T-5\"].state" "$DESK_QUEUE")" = parked ]'
# Reopened and merged by the person, as the epic PR step asks of a closed one: read again once the
# interval has passed, and the ticket behind it is released.
echo '{"state":"MERGED","mergedAt":"2026-11-07T11:00:00Z"}' > "$T/ep/901.json"
echo '{"pr":901,"state":"CLOSED","at":"2026-01-01T00:00:00.000Z"}' > "$(dirname "$SQ")/batches/.done/E-10/promotion-read.json"
pass
check "DS-815 and once the interval has passed it is read again, so one reopened and merged releases the ticket behind it" \
  '[ "$(grep -c "^pr view 901 " "$T/ghlog")" = 2 ] && [[ "$out" == *"outside hold: T-5: E-10 landed on main through its epic PR"* ]] && [ "$(jq -r ".tickets[\"T-5\"].state" "$DESK_QUEUE")" != parked ]'
node "$B/queue.mjs" drop T-5 >/dev/null
# Held behind the epic of another batch, whose epic PR could not be opened: said as that, not as a merge.
mkdir -p "$(dirname "$SQ")/batches/E-7"
echo '{"epic":"E-7","base":"feat/z","feature":false,"promotion":{"pr":null,"why":"gh pr create failed: nope"},"tickets":{"T-70":{"key":"T-70","state":"done","merged_at":"2026-11-06T10:00:00Z","result":{"pr":700}}}}' > "$(dirname "$SQ")/batches/E-7/queue.json"
node "$B/queue.mjs" add T-4 >/dev/null
node "$B/queue.mjs" set T-4 state=parked 'park={"question":"held by orchestrator: behind E-7"}' held_by=E-7 held_outside=E-7 >/dev/null
pass
check "DS-508 AC5 a ticket held behind another batch's epic waits on that epic PR, saying why there is none" \
  '[[ "$out" == *"WAITING ON EPIC PR: T-4 (E-7: no epic PR: gh pr create failed: nope)"* ]] && [[ "$out" != *"WAITING ON MERGE"* ]]'

# §4 Merged-tree check: a stubbed check that fails on a repeated revision number in migrations/, and
# leaves a stray file behind as a real tool can.
ln -sf "$B/with-lock.sh" "$T/desk/bin/with-lock.sh"
cat > "$T/check.sh" <<'EOF'
d=$(ls migrations 2>/dev/null | cut -d_ -f1 | sort | uniq -d)
[ -z "$d" ] && exit 0
touch stray.tmp; echo "Revision $d is present more than once"; exit 1
EOF
treerow(){ printf '\n## 4. Tools\n| Field | Value |\n|---|---|\n| Merged-tree check | `%s` |\n' "$1" >> "$C/config.md"; }
# clash: main and feat/x each add a migration numbered 121, under different filenames.
clash(){
  git -C "$C/repo" fetch -q origin; git -C "$C/repo" switch -q -c side origin/feat/x
  mkdir -p "$C/repo/migrations"; echo a > "$C/repo/migrations/121_a.py"; git -C "$C/repo" add migrations; git -C "$C/repo" commit -q -m base-side; git -C "$C/repo" push -q origin HEAD:feat/x
  git -C "$C/repo" switch -q main; mkdir -p "$C/repo/migrations"; echo b > "$C/repo/migrations/121_b.py"; git -C "$C/repo" add migrations; git -C "$C/repo" commit -q -m main-side; git -C "$C/repo" push -q origin main
  git -C "$C/repo" branch -q -D side
}
# renumber: what the fix worker does, from a clone: merge main, move the base's own migration after it.
renumber(){
  git clone -q "$C/origin.git" "$C/fixer"; git -C "$C/fixer" switch -q feat/x
  git -C "$C/fixer" merge -q --no-edit origin/main; git -C "$C/fixer" mv migrations/121_a.py migrations/122_a.py
  git -C "$C/fixer" commit -q -m renumber; git -C "$C/fixer" push -q origin feat/x
}
rm -f "$T/agents.json"; : > "$T/spawns"

fresh tree1; feature; fixrow yes; treerow "sh $T/check.sh"; clash; tip=$(origin_tip); pass
check "DS-441 AC1 a clean merge that fails the check pushes nothing" '[ "$(origin_tip)" = "$tip" ]'
check "DS-441 AC1 a base fix worker is sent, with the check's output" \
  'grep -q "^base-feat-x .*Your task is merged-tree fix try 1 of 2 on feat/x" "$T/spawns" && grep -q "Revision 121 is present more than once" "$C/state/briefings/base-feat-x.md" && [ "$(jq -r ".base_fix.tries[0].check.output" "$DESK_QUEUE")" = "Revision 121 is present more than once" ]'
check "DS-441 AC1 the report says it is the check, and not the person's yet" '[[ "$out" == *"fails §4 Merged-tree check"* ]] && [[ "$out" == *"Merged-tree fix try 1 of 2 starts this pass"* ]] && [ $rc -ne 11 ]'
check "DS-441 AC1 the worktree is left clean at the base's head" "[ -z \"\$(git -C $BWT status --porcelain)\" ] && [ \"\$(git -C $BWT rev-parse HEAD)\" = \"\$tip\" ]"
renumber; ended "AUTOPILOT_DONE: pr=none jira=none"; pass
check "DS-441 AC2 once the worker has pushed, the next pass finds the base current and clears the tries" \
  '[[ "$out" == *"merged-tree fix: try 1 of 2 on feat/x finished"* ]] && [[ "$out" == *"feat/x is current with main again"* ]] && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ] && origin_has_main'

rm -f "$T/agents.json"; : > "$T/spawns"
fresh tree5; feature; fixrow yes; treerow "sh $T/check.sh"; clash; tip=$(origin_tip); pass
# The worker merged locally, could not make the check pass, and parked without pushing.
git -C "$C/wt/base-feat-x" merge -q --no-edit origin/main; ended "AUTOPILOT_PARK: the check still fails"; pass
check "DS-441 AC5 a fix that still fails is put to the person, quoting the check" \
  '[[ "${out#*WAITING ON YOU}" == *"nothing pushed. Its output: Revision 121 is present more than once"* ]] && [[ "${out#*WAITING ON YOU}" == *"Still failing the check after 1 fix try; the last try parked: the check still fails"* ]]'
check "DS-441 AC5 nothing was pushed and no second try starts" '[ "$(origin_tip)" = "$tip" ] && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ]'

: > "$T/spawns"
fresh tree4; treerow none; clash; pass
check "DS-441 AC4 with the row none, a clean merge pushes as before" 'origin_has_main && [[ "$out" == *"and pushed"* ]]'
fresh treeunset; clash; pass
check "DS-441 AC4 with no row at all, likewise" 'origin_has_main'
fresh treepass; treerow "sh $T/check.sh"; pass
check "DS-441 negative: a merge the check passes is pushed" 'origin_has_main && [[ "$out" == *"and pushed"* ]] && [ -z "$(git -C "$C/wt/base-feat-x" status --porcelain)" ]'

# A batch whose every child has merged, its draft epic PR's review due, beside a live sibling batch in
# the repo with one worker running and ready tickets. epicbeside <case> <concurrency row>.
SIB="$DESK_HOME/repos/acme__widgets/queue.json"
epicbeside(){
  fresh "$1"; epicrows; rm -f "$T/ep"/*; : > "$T/spawns"; rm -f "$T/agents.json"
  printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Autopilot worker concurrency | `2 / 3` | `%s` |\n' "$2" >> "$C/config.md"
  node "$B/queue.mjs" set-batch epic=E-8 feature=false 'promotion={"pr":300}' >/dev/null
  node "$B/queue.mjs" set T-1 state=done result.pr=801 merged_at=2026-11-06T10:00:00Z >/dev/null
  echo '{"state":"MERGED","mergedAt":"2026-11-06T10:00:00Z"}' > "$T/ep/801.json"
  echo "{\"state\":\"OPEN\",\"isDraft\":true,\"headRefOid\":\"$EH\"}" > "$T/ep/300.json"; review -
  mkdir -p "$(dirname "$SIB")" "$HOME/.desk-autopilot/acme__widgets/orchestrators"
  echo '{"concurrency":3,"tickets":{"S-1":{"key":"S-1","state":"running"},"S-2":{"key":"S-2","state":"triaged"},"S-3":{"key":"S-3","state":"triaged"},"S-4":{"key":"S-4","state":"triaged"}}}' > "$SIB"
  jq -n --arg q "$SIB" --arg at "$(node -p 'new Date().toISOString()')" '{queue: $q, at: $at}' > "$HOME/.desk-autopilot/acme__widgets/orchestrators/sibling.json"
  out=$(DESK_REPO_OVERRIDE=acme/widgets node "$B/pass.mjs" 2>&1); rc=$?
}
epicbeside eslot '2 / 3'
check "DS-520 AC2 with a free slot beside a sibling batch's ready work, the epic review starts" 'grep -q "^base-feat-x .*It is epic PR #300" "$T/spawns" && [ "$(jq -r ".base_fix.tries[0].kind" "$DESK_QUEUE")" = review ]'
check "DS-520 AC1 the review counts as wanting one slot, and the sibling keeps the rest" '[[ "$out" == *"repo workers: 1 of the §3b cap of 3 running"*"1 kept for the standing batch, which has 3 ready and 1 running"* ]]'
epicbeside efull '1 / 1'
check "DS-520 AC3 with the §3b cap full, the review waits" '! grep -q "^base-feat-x " "$T/spawns" && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ]'
check "DS-520 AC3 and the pass says why" '[[ "$out" == *"epic PR #300: review try 1 of 2 starts once a worker may (none may this pass: repo workers: 1 of the §3b cap of 1 running"* ]]'
rm -f "$SIB"

# DS-542: parks waiting on "base contains main", in a batch that spawns nothing (every ticket held).
# waitpark <KEY> <question>: a lane A ticket parked on the base containing main.
waitpark(){ node "$B/queue.mjs" add "$1" Story A >/dev/null; node "$B/queue.mjs" park "$1" "$2" >/dev/null; node "$B/queue.mjs" clears-when "$1" "base contains main" >/dev/null; }
Q1="requeue me once the hotfix is on main and main has been merged into feat/x"
Q2="requeue me once main is merged into feat/x, then build the image"
fresh bparks; node "$B/queue.mjs" set-batch concurrency=0 >/dev/null; node "$B/queue.mjs" set T-1 state=done >/dev/null
waitpark W-1 "$Q1"; waitpark W-2 "$Q2"; node "$B/not-now.mjs" add W-2 "$Q2" >/dev/null 2>&1
put_off(){ node "$B/not-now.mjs" check "$1" >/dev/null 2>&1; [ $? -eq 3 ]; }
check "DS-542 a put-off park starts in the not-now register" 'put_off "$Q2"'
pass
check "DS-542 AC1 with nothing to spawn, main is merged into the base and pushed" 'origin_has_main && [[ "$out" == *"base sync: merged 2 commit(s) from main into feat/x and pushed"* ]] && [[ "$out" != *"spawned:"* ]]'
check "DS-542 AC2 the park on the base containing main is requeued in the same pass, naming the condition" \
  '[ "$(jq -r ".tickets[\"W-1\"].state" "$DESK_QUEUE")" = triaged ] && [[ "$out" == *"W-1: \"the batch base contains main\" holds: requeued"* ]]'
check "DS-542 AC2 the next worker is told what cleared it" '[ "$(jq -r ".tickets[\"W-1\"].cleared.what" "$DESK_QUEUE")" = "the batch base contains main" ]'
check "DS-542 AC3 a put-off one is requeued and its not-now entry lifted" \
  '[ "$(jq -r ".tickets[\"W-2\"].state" "$DESK_QUEUE")" = triaged ] && [[ "$out" == *"W-2: \"the batch base contains main\" holds: requeued, its not-now entry lifted"* ]] && ! put_off "$Q2"'

fresh bparkconflict; conflict; node "$B/queue.mjs" set-batch concurrency=0 >/dev/null; node "$B/queue.mjs" set T-1 state=done >/dev/null
waitpark W-3 "$Q1"; tip=$(origin_tip); pass
check "DS-542 AC4 a conflicting sync leaves the park" '[ "$(jq -r ".tickets[\"W-3\"].state" "$DESK_QUEUE")" = parked ]'
check "DS-542 AC4 the merge is aborted: nothing pushed, the base worktree clean" "[ \"\$(origin_tip)\" = \"\$tip\" ] && [ -z \"\$(git -C $BWT status --porcelain)\" ]"
check "DS-542 AC4 the pass says why the base did not sync, on the base and on the park" \
  '[[ "$out" == *"base sync: merging main into feat/x conflicts, nothing pushed. Conflicting files: a.txt"* ]] && [[ "$out" == *"W-3: waiting on \"the batch base contains main\" (feat/x is 3 commit(s) behind main, and the base did not sync this pass: merging main into feat/x conflicts"*"): left parked"* ]]'

# DS-594 AC2: an epic batch whose base another worktree holds still opens its epic PR once every child
# has merged (the DS-508 gh stub above serves it).
fresh epic594; epicrows; rm -f "$T/ep"/*; : > "$T/ghlog"
git -C "$C/repo" fetch -q origin; git -C "$C/repo" worktree add -q --track -b feat/x "$C/wt/T-9" origin/feat/x
node "$B/queue.mjs" set-batch epic=E-8 feature=false >/dev/null
node "$B/queue.mjs" set T-1 state=done result.pr=801 merged_at=2026-11-06T10:00:00Z >/dev/null
echo '{"state":"MERGED","mergedAt":"2026-11-06T10:00:00Z"}' > "$T/ep/801.json"; pass
check "DS-594 AC2 with the base held in another worktree, the PR from the base to main is opened" \
  'grep -q "^pr create --repo acme/widgets --draft --base main --head feat/x --title E-8: promote feat/x to main" "$T/ghlog" && [ "$(jq -r .promotion.pr "$DESK_QUEUE")" = 300 ] && [[ "$out" != *"is checked out in"* ]]'

# A gate passed at the base's head covers T-1, so no gate starts. promo <isDraft> <tests' conclusion>.
promo(){ echo "{\"state\":\"OPEN\",\"isDraft\":$1,\"headRefOid\":\"$EH\",\"statusCheckRollup\":[{\"name\":\"tests\",\"status\":\"COMPLETED\",\"conclusion\":\"$2\"},{\"name\":\"lint\",\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\"}]}" > "$T/ep/300.json"; }
promobatch(){
  fresh "$1"; epicrows; current; feature; rm -f "$T/ep"/*; : > "$T/spawns"; rm -f "$T/agents.json"
  node "$B/queue.mjs" set T-1 state=done result.pr=801 merged_at=2026-11-06T10:00:00Z >/dev/null
  echo '{"state":"MERGED","mergedAt":"2026-11-06T10:00:00Z"}' > "$T/ep/801.json"
  node "$B/queue.mjs" set-batch 'promotion={"pr":300}' "gate={\"state\":\"passed\",\"sha\":\"$(origin_tip)\",\"pr\":300,\"ready\":true,\"slice\":{\"n\":1,\"keys\":[\"T-1\"],\"of\":${2:-1},\"last\":true}}" >/dev/null
}
promobatch promo786; promo false FAILURE; pass
check "DS-786 AC1 a promotion PR out of draft with a failing check gets check try 1 in the base worktree, naming the check" \
  'grep -q "^base-feat-x $C/wt/base-feat-x feat/x .*It is promotion PR #300, which merges this batch.s base feat/x into main" "$T/spawns" && [ "$(jq -r ".base_fix.tries[0].kind" "$DESK_QUEUE")" = checks ] && [ "$(jq -r ".base_fix.tries[0].failing | join(\",\")" "$DESK_QUEUE")" = tests ] && [[ "$out" == *"promotion PR check try 1 of 2 on feat/x, PR #300"* ]]'
check "DS-786 AC1 and nothing is recorded for the person yet" '[ "$(jq -r .promotion.red "$DESK_QUEUE")" = null ] && [[ "$out" != *"PROMOTION PR:"* ]]'
live; pass
check "DS-786 AC1 a live check try is waited on, not doubled" '[ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [[ "$out" == *"promotion PR #300: tests fails; check try 1 of 2 is at it"* ]]'
# The try committed on the base and parked without pushing.
git -C "$C/wt/base-feat-x" -c user.name=t -c user.email=t@t commit -q --allow-empty -m wip
ended "AUTOPILOT_PARK: the Flows image is missing, which only a person can build"; rm -f "$T/agents.json"; pass
check "DS-786 a parked check try's unpushed commit is kept on a ref and the base worktree is put back at origin's base" \
  '[ "$(git -C "$C/wt/base-feat-x" rev-list --count origin/feat/x..HEAD)" = 0 ] && [ -z "$(git -C "$C/wt/base-feat-x" status --porcelain)" ] && [ "$(jq -r ".base_fix.tries[0].kept.ref" "$DESK_QUEUE")" = refs/desk/base-fix/base-feat-x/checks-300-1 ]'
check "DS-786 AC2 a try that left the head red goes to the person, recorded for needs-you, exit 11" \
  '[ $rc -eq 11 ] && [[ "${out#*WAITING ON YOU}" == *"PROMOTION PR: #300 is red: still failing tests at eeeeeeeeeeee after 1 check try; the last try parked: the Flows image is missing"* ]] && [ "$(jq -r ".promotion.red.checks | join(\",\")" "$DESK_QUEUE")" = tests ] && [ "$(jq -r .promotion.red.tried "$DESK_QUEUE")" = 1 ] && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ]'
check "DS-786 AC2 and the batch is not idle while it is red" '[[ "$out" != *"IDLE"* ]]'
promo false SUCCESS; pass
check "DS-786 AC5 once its checks pass, the record is cleared and no try is sent" '[ "$(jq -r .promotion.red "$DESK_QUEUE")" = null ] && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [[ "$out" != *"PROMOTION PR"* ]]'
# AC4: a draft promotion PR with a child still to merge into the base is red only for that.
promobatch promo786d 2; node "$B/queue.mjs" add T-2 >/dev/null
node "$B/queue.mjs" set T-2 state=parked 'park={"question":"Which endpoint?"}' >/dev/null
promo true FAILURE; pass
check "DS-786 AC4 a draft promotion PR waiting on a child gets no check try and no record" \
  '! grep -q "^base-feat-x " "$T/spawns" && [ "$(jq -r .base_fix "$DESK_QUEUE")" = null ] && [ "$(jq -r .promotion.red "$DESK_QUEUE")" = null ] && [[ "$out" != *"PROMOTION PR"* ]] && [[ "$out" != *"promotion PR #300: tests"* ]]'
echo stray > "$C/wt/base-feat-x/stray.txt"; promo false FAILURE; pass
check "DS-786 a base worktree holding work of its own gets no check try, and the person is told why" \
  '! grep -q "^base-feat-x " "$T/spawns" && [[ "$out" == *"PROMOTION PR: #300 is red (tests), and its check try 1 of 2 cannot start, since the base worktree $C/wt/base-feat-x has uncommitted changes"* ]] && [ -f "$C/wt/base-feat-x/stray.txt" ]'
rm -f "$C/wt/base-feat-x/stray.txt"; pass
check "DS-786 AC4 negative: out of draft, the same red gets its check try" 'grep -q "^base-feat-x .*It is promotion PR #300" "$T/spawns"'

finish epic
