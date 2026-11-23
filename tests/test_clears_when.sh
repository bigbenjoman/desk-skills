#!/usr/bin/env bash
# suite: clears-when (a park says what clears it, and a pass settles it without a model)
# layer: L3
# A worker's AUTOPILOT_PARK_CLEARS_WHEN is stored on its park, and queue.mjs clears-when sets one. Each
# pass checks every recorded condition: a lane C or D park stays for a person, one whose own PR merged
# is recorded done, any other is requeued, and a check that cannot run leaves the park as it is. The
# decider may record one, and gets an answer to a park it was never handed. Runs the real pass.mjs
# with stub claude, gh and desk-jira. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt" "$T/gh" "$T/jira"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_START_STAGE DESK_GITHUB_HANDLE
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
| \`git-push\` | Push the ticket's branch | \`yes\` | \`yes\` |
| \`git-force-with-lease\` | Force-push with a lease | \`ask\` | \`ask\` |
EOF

# shellcheck source=link_bin.sh
. "$S/link_bin.sh"; link_bin "$B" "$T/desk/bin"
printf 'echo "[spawn] ticket=$1"\n' > "$T/desk/bin/spawn-worker.sh"
printf '#!/bin/sh\necho "[]"\n' > "$T/stub/claude"
# gh: a PR is $T/gh/pr-<n>.json (none is a failed read), a branch's merged PR $T/gh/merged-<branch with
# / as _>, the repo's variables $T/gh/vars.json ($T/gh/vars.fail fails the read), an Actions run
# $T/gh/run-<id>.json (none is a failed read). Anything else answers nothing.
cat > "$T/stub/gh" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "pr view") if [ "\$7" = headRefOid,statusCheckRollup ]; then [ -f "$T/gh/checks-\$3.json" ] && { cat "$T/gh/checks-\$3.json"; exit 0; }; echo "gh: HTTP 502 reading checks of PR \$3" >&2; exit 1; fi
    if [ "\$7" = headRefOid,reviews ]; then [ -f "$T/gh/reviews-\$3.json" ] && { cat "$T/gh/reviews-\$3.json"; exit 0; }; echo "gh: HTTP 502 reading reviews of PR \$3" >&2; exit 1; fi
    [ -f "$T/gh/pr-\$3.json" ] && { cat "$T/gh/pr-\$3.json"; exit 0; }; echo "gh: HTTP 502 for PR \$3" >&2; exit 1 ;;
  "pr list") h=""; jq=""; while [ \$# -gt 0 ]; do [ "\$1" = --head ] && h="\$2"; [ "\$1" = -q ] && jq="\$2"; shift; done
    [ -n "\$h" ] || { echo "[]"; exit 0; }
    # A file holding a PR as JSON is the list's one entry, read through the caller's -q as gh would.
    f="$T/gh/merged-\$(echo "\$h" | tr / _)"; [ -f "\$f" ] || exit 0
    case "\$(head -c1 "\$f")" in "{") jq -c "[.] | \$jq" "\$f" ;; *) cat "\$f" ;; esac; exit 0 ;;
  "variable list") [ -f "$T/gh/vars.fail" ] && { echo "gh: HTTP 401: Bad credentials" >&2; exit 1; }
    cat "$T/gh/vars.json" 2>/dev/null || echo "[]"; exit 0 ;;
  "run view") [ -f "$T/gh/run-\$3.json" ] && { cat "$T/gh/run-\$3.json"; exit 0; }; echo "gh: HTTP 404: run \$3 not found" >&2; exit 1 ;;
esac
exit 0
EOF
# desk-jira get <KEY> --json: $T/jira/<KEY>.json, or unreachable.
cat > "$T/stub/desk-jira" <<EOF
#!/bin/sh
[ -f "$T/jira/\$2.json" ] && { cat "$T/jira/\$2.json"; exit 0; }; echo "desk-jira: unreachable" >&2; exit 1
EOF
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/desk-jira"
pr(){ printf '{"state":"%s","isDraft":%s,"statusCheckRollup":[]}\n' "$2" "$3" > "$T/gh/pr-$1.json"; }
run(){ printf '{"status":"%s","conclusion":"%s"}\n' "$2" "$3" > "$T/gh/run-$1.json"; }
jira(){ printf '{"key":"%s","fields":{"status":{"name":"%s","statusCategory":{"key":"%s"}}}}\n' "$1" "$2" "$3" > "$T/jira/$1.json"; }

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
# A ticket the pass moved to the archive beside the queue (queue-store.mjs) is found as a queue read finds it.
field(){ node -e 'const fs = require("fs"); const [, f, key] = process.argv; const live = JSON.parse(fs.readFileSync(f, "utf8")).tickets;
  let a = {}; try { a = JSON.parse(fs.readFileSync(f.replace(/\.json$/, "") + ".archive.json", "utf8")).tickets; } catch {}
  const t = Object.hasOwn(live, key) ? live[key] : a[key]; console.log(JSON.stringify(process.argv[3].split(".").reduce((o, k) => o?.[k], t) ?? null))' "$DESK_QUEUE" "$1" "$2"; }
say(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv.slice(1).join("\n") }] } }))' "$@"; }
# parked <KEY> <lane> <question> [<clears-when>]
parked(){ q add "$1" Story "$2"; q park "$1" "$3"; q set "$1" "branch=feat/$1"; [ $# -lt 4 ] || q clears-when "$1" "$4"; }

# Nothing spawns, so a requeued ticket stays where the pass put it.
q init cw; q set-batch concurrency=0

# ---- AC2: a worker's park records what clears it --------------------------------------------------
q add C-1 Story A; q set C-1 state=running branch=feat/C-1 session_id=gone
say "AUTOPILOT_PARK: waiting on PR #41, the shared helper" "AUTOPILOT_PARK_CLEARS_WHEN: pr 41 merged" > "$T/state/logs/C-1.log"
q add C-2 Story A; q set C-2 state=running branch=feat/C-2 session_id=gone
say "AUTOPILOT_PARK: waiting on the weather" "AUTOPILOT_PARK_CLEARS_WHEN: when it rains" > "$T/state/logs/C-2.log"
q add C-3 Story A; q set C-3 state=running branch=feat/C-3 session_id=gone
say "AUTOPILOT_PARK_CLEARS_WHEN: pr 3 merged" "AUTOPILOT_PARK: which copy?" > "$T/state/logs/C-3.log"
pr 41 OPEN true
# DS-563: KAN-976's command, a check on a PR's head, and prose no form reads.
q add C-6 Story A; q set C-6 state=running branch=feat/C-6 session_id=gone
say "AUTOPILOT_PARK: waiting on PR 991" "AUTOPILOT_PARK_CLEARS_WHEN: gh pr view 991 --repo acme/widgets --json state reports MERGED" > "$T/state/logs/C-6.log"
q add C-7 Story A; q set C-7 state=running branch=feat/C-7 session_id=gone
say "AUTOPILOT_PARK: waiting on the Flows image build" 'AUTOPILOT_PARK_CLEARS_WHEN: check "Flows image" on pr 874 passes' > "$T/state/logs/C-7.log"
printf '{"headRefOid":"%s","statusCheckRollup":[{"name":"Flows image","status":"IN_PROGRESS","conclusion":""}]}\n' "$(printf d%.0s {1..40})" > "$T/gh/checks-874.json"
q add C-8 Story A; q set C-8 state=running branch=feat/C-8 session_id=gone
say "AUTOPILOT_PARK: waiting on KAN-1086" "AUTOPILOT_PARK_CLEARS_WHEN: KAN-1086's fix PR is merged to main" > "$T/state/logs/C-8.log"

out=$(node "$B/queue.mjs" clears-when C-1 "pr 41 merged" 2>&1); rc=$?
check "queue.mjs clears-when refuses a ticket that is not parked" '[ $rc -ne 0 ] && grep -q "is not parked" <<< "$out"'

# ---- AC4: lane C or D stays; AC6: a failed check or none leaves the park; AC7: VPL-555's case -------
parked D-1 C "which of two layouts?" "ticket ABC-9 done"; jira ABC-9 Done "done"
parked E-1 A "waiting on PR 77" "pr 77 merged"
parked E-2 A "a product call" "none"
parked E-3 A "waiting on ABC-404" "ticket ABC-404 done"
parked E-4 A "waiting on ABC-10" "ticket ABC-10 done"; jira ABC-10 "In Progress" indeterminate
parked V-1 A "set DESK_DEPLOY_ON=local" "variable DESK_DEPLOY_ON set"; q set V-1 draft_pr=699
pr 699 MERGED false; echo '[{"name":"DESK_DEPLOY_ON"}]' > "$T/gh/vars.json"
# DS-349: a park that waits on an Actions run
parked R-1 A "waiting on e2e run 41048026730" "run 41048026730 completed"; run 41048026730 completed failure
parked R-2 A "waiting on e2e run 41048026731" "run 41048026731 completed"; run 41048026731 in_progress ""
parked R-3 A "waiting on e2e run 41048026732" "run 41048026732 completed"
parked W-1 B "waiting on review of #706" "pr 706 ready"; pr 706 OPEN false; echo '{"number":707,"author":{"login":"me"}}' > "$T/gh/merged-feat_W-1"; pr 707 MERGED false
# DS-496: a park on a refused push. A real origin, whose pre-receive hook prints $T/gh/refuse-<branch
# with / as _> and refuses, so git reports it as a worker's push would see it.
git init -q --bare "$T/origin.git"; git -C "$T/repo" remote add origin "$T/origin.git"
cat > "$T/origin.git/hooks/pre-receive" <<EOF
#!/bin/sh
while read -r _ _ ref; do
  f="$T/gh/refuse-\$(echo "\${ref#refs/heads/}" | tr / _)"
  [ -f "\$f" ] && { cat "\$f" >&2; exit 1; }
done
exit 0
EOF
chmod +x "$T/origin.git/hooks/pre-receive"
on_origin(){ git -C "$T/origin.git" rev-parse --verify -q "refs/heads/feat/$1" >/dev/null; }
# pushpark <KEY> <lane> [<clears-when>]
pushpark(){ parked "$1" "$2" "GitHub refused the push of feat/$1 with a 5xx" "${3:-git push origin feat/$1 succeeds}"; git -C "$T/repo" branch "feat/$1"; q set "$1" "worktree=$T/repo"; }
pushpark P-1 A
pushpark P-2 A; echo "Internal Server Error" > "$T/gh/refuse-feat_P-2"
pushpark P-3 A; echo "branch is protected" > "$T/gh/refuse-feat_P-3"
PIN=$(printf a%.0s {1..40})
pushpark P-4 A "git push --force-with-lease=feat/P-4:$PIN origin feat/P-4 succeeds"
pushpark P-5 C
pushpark P-6 A "git push origin feat/other succeeds"
# P-8: a ticket's one-off grant for this branch and SHA, with §3's lease row at ask.
HELD=$(git -C "$T/repo" rev-parse HEAD); REWRITTEN=$(git -C "$T/repo" commit-tree "$HELD^{tree}" -m rewritten)
git -C "$T/repo" push -q origin "$HELD:refs/heads/feat/P-8"
pushpark P-8 A "git push --force-with-lease=feat/P-8:$HELD origin feat/P-8 succeeds"; git -C "$T/repo" branch -f feat/P-8 "$REWRITTEN"
q set P-8 "grant={\"step\":\"force-push\",\"branch\":\"feat/P-8\",\"lease\":\"$HELD\",\"at\":\"2026-11-01T00:00:00Z\"}"
# P-9: the same, with a pinned grant (the approved park named the SHA), and P-10 pinned to another SHA.
git -C "$T/repo" push -q origin "$HELD:refs/heads/feat/P-9"
pushpark P-9 A "git push --force-with-lease=feat/P-9:$HELD origin feat/P-9 succeeds"; git -C "$T/repo" branch -f feat/P-9 "$REWRITTEN"
q set P-9 "grant={\"step\":\"force-push\",\"branch\":\"feat/P-9\",\"lease\":\"$HELD\",\"pinned\":true,\"at\":\"2026-11-01T00:00:00Z\"}"
git -C "$T/repo" push -q origin "$HELD:refs/heads/feat/P-10"
pushpark P-10 A "git push --force-with-lease=feat/P-10:$HELD origin feat/P-10 succeeds"; git -C "$T/repo" branch -f feat/P-10 "$REWRITTEN"
q set P-10 "grant={\"step\":\"force-push\",\"branch\":\"feat/P-10\",\"lease\":\"$PIN\",\"pinned\":true,\"at\":\"2026-11-01T00:00:00Z\"}"
q add C-4 Story A; q set C-4 state=running branch=feat/C-4 session_id=gone
say "AUTOPILOT_PARK: GitHub refused the push of feat/C-4 with a 5xx" "AUTOPILOT_PARK_CLEARS_WHEN: git push -u origin feat/C-4 succeeds" > "$T/state/logs/C-4.log"
# C-5: a force-push park whose question names no SHA, only its clears-when does.
q add C-5 Story A; q set C-5 state=running branch=feat/C-5 session_id=gone
say "AUTOPILOT_PARK: GitHub refused the force-push of feat/C-5 with a 5xx" 'AUTOPILOT_PARK_INPUTS: {"step": "push"}' \
  "AUTOPILOT_PARK_CLEARS_WHEN: git push --force-with-lease=feat/C-5:$PIN origin feat/C-5 succeeds" > "$T/state/logs/C-5.log"
# F-1 asks for a force-push naming no SHA; F-2 has already been refused once; F-3 names the SHA;
# F-4 only mentions one; F-5 is lane C.
for k in F-1 F-2 F-3 F-4 F-5; do l=A; [ "$k" = F-5 ] && l=C; q add "$k" Story "$l"; q set "$k" state=running "branch=feat/$k" session_id=gone; done
q set F-2 'lease_refused={"question":"an earlier park"}'
say "AUTOPILOT_PARK: needs a force-push of feat/F-1, which my settings deny. Approve?" > "$T/state/logs/F-1.log"
say "AUTOPILOT_PARK: needs a force-push of feat/F-2, which my settings deny. Approve?" > "$T/state/logs/F-2.log"
say "AUTOPILOT_PARK: needs a force-push of feat/F-3. Approve?" "AUTOPILOT_PARK_INPUTS: {\"lease\": \"$PIN\"}" > "$T/state/logs/F-3.log"
say "AUTOPILOT_PARK: should I merge rather than force-push?" > "$T/state/logs/F-4.log"
say "AUTOPILOT_PARK: needs a force-push of feat/F-5, which my settings deny. Approve?" > "$T/state/logs/F-5.log"
out=$(node "$B/queue.mjs" clears-when E-2 "when it rains" 2>&1); rc=$?
check "queue.mjs clears-when refuses a condition it cannot read, naming the forms" '[ $rc -ne 0 ] && grep -q "pr <n> merged, pr <n> ready, ticket <KEY> done, variable <NAME> set, run <id> completed, git push origin <branch> succeeds, base contains <branch>, pr <n> reviewed by <login> at head, file <path> exists, ticket <KEY> in <repo> batch, check \"<name>\" on pr <n> passes, commit <sha> on <branch>, gh pr view <n> \[--repo <owner/name>\] reports MERGED, or none" <<< "$out"'
# DS-563 AC4: a worker checks its line before it ends, through queue.mjs or the clears-when.mjs its settings allow.
out=$(node "$B/queue.mjs" clears-when --check "when the fix PR is merged to main" 2>&1); rc=$?
check "DS-563 AC4 queue.mjs clears-when --check on an unreadable line exits non-zero and prints the forms, one a line" \
  '[ $rc -ne 0 ] && grep -q "\"when the fix PR is merged to main\" is not a form a pass reads. The forms:" <<< "$out" && grep -qx "  pr <n> merged" <<< "$out" && grep -qx "  check \"<name>\" on pr <n> passes" <<< "$out" && grep -qx "  none" <<< "$out"'
out=$(node "$B/clears-when.mjs" --check "when the fix PR is merged to main" 2>&1); rc=$?
check "DS-563 AC4 and so does clears-when.mjs --check, which a worker may run" '[ $rc -eq 1 ] && grep -qx "  commit <sha> on <branch>" <<< "$out"'
out=$(node "$B/queue.mjs" clears-when --check "gh pr view 991 --repo acme/widgets --json state reports MERGED" 2>&1); rc=$?
check "DS-563 AC4 a line that reads exits 0, naming what it reads as" '[ $rc -eq 0 ] && [ "$out" = "reads as: PR #991 merged" ]'
out=$(node "$B/clears-when.mjs" --check 'check "Flows image" on pr 874 passes' 2>&1); rc=$?
check "DS-563 AC4 clears-when.mjs --check reads the check form" '[ $rc -eq 0 ] && [ "$out" = "reads as: \"Flows image\" passing on PR #874'"'"'s head" ]'
r=$(node --input-type=module -e "
import { parseClearsWhen, checkCond } from '$B/clears-when.mjs';
import { normaliseRollup, latestPerCheck } from '$B/gate.mjs';
const p = (s, here) => JSON.stringify(parseClearsWhen(s, { here }).cond ?? null);
// As pass.mjs reads them: the latest run of each check on the head.
const roll = (rows) => ({ checks: () => ({ headRefOid: 'abcdef1234567', checks: latestPerCheck(normaliseRollup(rows)) }) });
const run = (id, at, conclusion) => ({ name: 'Flows image', workflowName: 'images', status: 'COMPLETED', conclusion, startedAt: at, detailsUrl: 'https://github.com/o/r/actions/runs/' + id + '/job/1' });
const ok = { __typename: 'CheckRun', name: 'Flows image', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'images' };
const c = { kind: 'checks-pass', pr: 874, checks: ['Flows image', 'Grader image'] };
console.log([
  p('gh pr view 991 --repo o/r --json state reports MERGED'), p('gh pr view 991 --repo o/r --json state reports MERGED', 'O/R'),
  p('gh pr view 991 … reports MERGED'), p('gh pr view 991 --json state -q .state returns \"MERGED\"'),
  p('check \"Flows image\" on pr 874 passes'), p('checks \"Flows image\" and \"Grader image\" on PR #909 pass at its head'),
  p('commit 68d6155aa is an ancestor of origin/feat/bug-1253-press-kit-key-messages'), p('commit 68D6155AA on main'),
  p('KAN-1086s fix PR is merged to main'), p('gh pr view 991 reports OPEN'), p('check Flows image on pr 874 passes'),
  JSON.stringify(checkCond(c, roll([ok, { name: 'Grader image', status: 'COMPLETED', conclusion: 'SUCCESS' }]))),
  JSON.stringify(checkCond(c, roll([ok, { name: 'Grader image', status: 'IN_PROGRESS', conclusion: '' }]))),
  JSON.stringify(checkCond(c, roll([ok]))),
  JSON.stringify(checkCond({ ...c, checks: ['images / Flows image', 'ci/legacy'] }, roll([ok, { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE' }]))),
  JSON.stringify(checkCond(c, { checks: () => { throw new Error('gh pr view 874: HTTP 502'); } })),
  JSON.stringify(checkCond({ kind: 'pr-merged', pr: 991, repo: 'o/r' }, { pr: (n, repo) => ({ state: repo === 'o/r' ? 'MERGED' : 'OPEN' }) })),
  JSON.stringify(checkCond({ ...c, checks: ['Flows image'] }, roll([run(1, '2026-11-01T10:00:00Z', 'FAILURE'), run(2, '2026-11-01T11:00:00Z', 'SUCCESS')]))),
  JSON.stringify(checkCond({ ...c, checks: ['Flows image'] }, roll([run(2, '2026-11-01T11:00:00Z', 'SUCCESS'), run(3, '2026-11-01T12:00:00Z', 'FAILURE')]))),
  p('gh pr view 991 --repo github.com/o/r --json state reports MERGED'), p('gh pr view 991 -R github.com/O/R reports MERGED', 'o/r'),
].join('|'));
")
check "DS-563 AC1 a gh pr view command reporting MERGED reads as that PR merged, in the repo it names" \
  '[ "$(cut -d"|" -f1,2 <<< "$r")" = "{\"kind\":\"pr-merged\",\"pr\":991,\"repo\":\"o/r\"}|{\"kind\":\"pr-merged\",\"pr\":991}" ]'
check "DS-563 AC1 with no --repo, or other flags, it is this repo's PR" \
  '[ "$(cut -d"|" -f3,4 <<< "$r")" = "{\"kind\":\"pr-merged\",\"pr\":991}|{\"kind\":\"pr-merged\",\"pr\":991}" ]'
check "DS-563 AC2 the check form reads one quoted name, or several joined by and" \
  '[ "$(cut -d"|" -f5,6 <<< "$r")" = "{\"kind\":\"checks-pass\",\"pr\":874,\"checks\":[\"Flows image\"]}|{\"kind\":\"checks-pass\",\"pr\":909,\"checks\":[\"Flows image\",\"Grader image\"]}" ]'
check "DS-563 a commit on a branch reads, origin/ dropped and the SHA lower-cased" \
  '[ "$(cut -d"|" -f7,8 <<< "$r")" = "{\"kind\":\"commit-on\",\"sha\":\"68d6155aa\",\"branch\":\"feat/bug-1253-press-kit-key-messages\"}|{\"kind\":\"commit-on\",\"sha\":\"68d6155aa\",\"branch\":\"main\"}" ]'
check "DS-563 prose, a state other than MERGED and an unquoted check name read as no form" '[ "$(cut -d"|" -f9,10,11 <<< "$r")" = "null|null|null" ]'
check "DS-563 AC2 every named check green at the head holds" '[ "$(cut -d"|" -f12 <<< "$r")" = "{\"holds\":true,\"note\":\"at abcdef123\"}" ]'
check "DS-563 AC2 one still running, or not run, does not, saying which" \
  '[ "$(cut -d"|" -f13,14 <<< "$r")" = "{\"holds\":false,\"note\":\"\\\"Grader image\\\" is in_progress at abcdef123\"}|{\"holds\":false,\"note\":\"\\\"Grader image\\\" has not run at abcdef123\"}" ]'
check "DS-563 a check named as workflow / job matches, and a failed commit status does not hold" \
  '[ "$(cut -d"|" -f15 <<< "$r")" = "{\"holds\":false,\"note\":\"\\\"ci/legacy\\\" is failure at abcdef123\"}" ]'
check "DS-563 a failed checks read is an error, not holding" '[ "$(cut -d"|" -f16 <<< "$r")" = "{\"error\":\"gh pr view 874: HTTP 502\"}" ]'
check "DS-563 another repo's PR is read in that repo" '[ "$(cut -d"|" -f17 <<< "$r")" = "{\"holds\":true}" ]'
check "DS-563 AC2 only a check's latest run counts: a failure a later run passed holds, a pass a later run failed does not" \
  '[ "$(cut -d"|" -f18,19 <<< "$r")" = "{\"holds\":true,\"note\":\"at abcdef123\"}|{\"holds\":false,\"note\":\"\\\"Flows image\\\" is failure at abcdef123\"}" ]'
check "DS-563 AC1 a --repo with its host is the last two parts, and this repo's stores none" \
  '[ "$(cut -d"|" -f20,21 <<< "$r")" = "{\"kind\":\"pr-merged\",\"pr\":991,\"repo\":\"o/r\"}|{\"kind\":\"pr-merged\",\"pr\":991}" ]'
# DS-542 AC5: a park waiting on main being merged into the batch base.
parked B-1 A "requeue me once main has been merged into the base"
out=$(node "$B/queue.mjs" clears-when B-1 "base contains main" 2>&1); rc=$?
check "DS-542 AC5 queue.mjs clears-when records base contains main on the park" \
  '[ $rc -eq 0 ] && [ "$(field B-1 park.clears_when)" = "{\"kind\":\"base-contains\",\"branch\":\"main\"}" ] && grep -q "B-1: its park clears when the batch base contains main" <<< "$out"'
out=$(node "$B/queue.mjs" clears-when B-1 "base contains main and the hotfix" 2>&1); rc=$?
check "DS-542 AC5 an unknown form is still refused, listing the forms" '[ $rc -ne 0 ] && grep -q "is not one of: .*base contains <branch>, .*or none" <<< "$out"'
q drop B-1
check "DS-496 queue.mjs clears-when stores a push" '[ "$(field P-1 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-1\"}" ]'
check "DS-496 and a lease push, with the SHA it may overwrite" '[ "$(field P-4 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-4\",\"lease\":\"$PIN\"}" ]'
out=$(node "$B/queue.mjs" clears-when E-2 "git push --force-with-lease origin feat/P-4 succeeds" 2>&1); rc=$?
check "DS-496 a lease naming no SHA is refused: a pass would overwrite whatever the tracking ref says" '[ $rc -ne 0 ]'
out=$(node "$B/queue.mjs" clears-when E-2 "git push --force-with-lease=feat/other:$PIN origin feat/P-4 succeeds" 2>&1); rc=$?
check "DS-496 and one whose lease names another branch" '[ $rc -ne 0 ]'
out=$(node "$B/queue.mjs" clears-when E-2 "run abc completed" 2>&1); rc=$?
check "DS-349 AC10 a run id that is not a number is refused, naming the forms" '[ $rc -ne 0 ] && grep -q "\"run abc completed\" is not one of: .*run <id> completed, .*or none" <<< "$out"'
# DS-581: a review by a named account at the PR's head, a file appearing, a ticket queued in another repo's batch.
HEAD_SHA=$(printf b%.0s {1..40}); OLD_SHA=$(printf c%.0s {1..40})
reviews(){ printf '{"headRefOid":"%s","reviews":[{"author":{"login":"%s"},"state":"COMMENTED","commit":{"oid":"%s"}}]}\n' "$HEAD_SHA" "$2" "$3" > "$T/gh/reviews-$1.json"; }
parked RV-1 A "waiting on pullbot's verdict on #3063" "pr 3063 reviewed by agent-pullbot at head"; reviews 3063 agent-pullbot "$HEAD_SHA"
parked RV-2 A "waiting on pullbot's verdict on #3064" "pr 3064 reviewed by agent-pullbot at head"; reviews 3064 agent-pullbot "$OLD_SHA"
parked RV-3 A "waiting on pullbot's verdict on #3065" "pr 3065 reviewed by agent-pullbot at head"
mkdir -p "$T/files/AA-48-recall-capture"; : > "$T/files/AA-48-recall-capture/meet.json"
parked FE-1 A "waiting on the recall capture" "file $T/files/AA-48-recall-capture/meet.json exists"
parked FE-2 A "waiting on the second capture" "file $T/files/AA-48-recall-capture/later.json exists"
mkdir -p "$T/desk/repos/acme__studia-web"; echo '{"tickets":{"SV-3994":{"key":"SV-3994","state":"triaged"}}}' > "$T/desk/repos/acme__studia-web/queue.json"
node --input-type=module -e "import { writeBeat } from '$B/borrow.mjs'; writeBeat('$T/home/.desk-autopilot/acme__studia-web', '$T/desk/repos/acme__studia-web/queue.json');"
parked TQ-1 A "SV-3994 belongs in a studia-web batch" "ticket SV-3994 in studia-web batch"
parked TQ-2 A "SV-3995 belongs in a studia-zendesk batch" "ticket SV-3995 in studia-zendesk batch"
out=$(node "$B/queue.mjs" clears-when E-2 "file ../elsewhere/meet.json exists" 2>&1); rc=$?
check "DS-581 AC5 a relative file path outside the worktree and \$DESK_STATE is refused, naming the paths allowed" \
  '[ $rc -ne 0 ] && grep -q "is outside the ticket.s worktree and \$DESK_STATE: name an absolute path, a path relative to the ticket.s worktree, or \$DESK_STATE/<path>" <<< "$out"'
check "DS-581 AC1 queue.mjs clears-when records a review at the head" '[ "$(field RV-1 park.clears_when)" = "{\"kind\":\"pr-reviewed\",\"pr\":3063,\"login\":\"agent-pullbot\"}" ]'
r=$(node --input-type=module -e "
import { parseClearsWhen, checkCond, condPath, queuedIn } from '$B/clears-when.mjs';
const p = (s) => JSON.stringify(parseClearsWhen(s).cond ?? parseClearsWhen(s).why);
const rv = { reviews: () => ({ headRefOid: 'h1', reviews: [{ author: { login: 'agent-pullbot[bot]' }, commit: { oid: 'h1' } }] }) };
const web = (batch, tickets) => ({ slug: 'acme__studia-web', batch, path: '/q/' + batch, q: { tickets } });
const qi = (queues, live = () => true) => JSON.stringify(checkCond({ kind: 'ticket-queued', ticket: 'SV-1', repo: 'studia-web' }, { queued: (k, r) => queuedIn(k, r, queues, live) }));
console.log([
  p('pr #3063 reviewed by agent-pullbot at head'),
  p('file \$DESK_STATE/fixtures/AA-48/meet.json exists'), p('file out/meet.json exists'), p('file ~/meet.json exists'), p('file \$DESK_STATE/../x exists'),
  p('SV-3994 is queued in a studia-web batch'), p('ticket SV-3994 in acme/studia-web batch'),
  JSON.stringify(checkCond({ kind: 'pr-reviewed', pr: 1, login: 'agent-pullbot' }, rv)),
  JSON.stringify(checkCond({ kind: 'pr-reviewed', pr: 1, login: 'agent-pullbot' }, { reviews: () => { throw new Error('gh pr view 1: HTTP 502'); } })),
  condPath({ kind: 'file-exists', path: 'a/b', root: 'state' }, { worktree: '/w', state: '/s' }), condPath({ kind: 'file-exists', path: 'a/b', root: 'worktree' }, { worktree: '/w', state: '/s' }),
  qi([web('a', {}), web('b', { 'SV-1': {} })]), qi([web('b', { 'SV-1': {} })], () => false), qi([{ slug: 'acme__studia-zendesk', q: { tickets: { 'SV-1': {} } } }]),
  qi([web('a', {}), { slug: 'acme__studia-web', batch: 'c', error: 'torn' }]), qi([web('b', { 'SV-1': {} }), { slug: 'acme__studia-web', batch: 'c', error: 'torn' }]),
  qi([{ slug: 'acme__x__studia-web', q: { tickets: { 'SV-1': {} } } }]),
  JSON.stringify(queuedIn('SV-1', 'acme/studia-web', [{ slug: 'other__acme__studia-web', q: { tickets: { 'SV-1': {} } } }], () => true)),
  JSON.stringify(queuedIn('SV-1', 'ACME/Studia-Web', [web('b', { 'SV-1': {} })], () => true)),
  JSON.stringify(queuedIn('SV-1', 'foo__web', [{ slug: 'acme__foo__web', q: { tickets: { 'SV-1': {} } } }], () => true)),
  JSON.stringify(queuedIn('SV-1', 'acme__studia-web', [web('b', { 'SV-1': {} })], () => true)),
].join('|'));
")
check "DS-581 a bare name that holds __ is still the whole name, and the owner__name slug matches itself" \
  '[[ "$(cut -d"|" -f20 <<< "$r")" == "{\"holds\":true"* ]] && [[ "$(cut -d"|" -f21 <<< "$r")" == "{\"holds\":true"* ]]'
check "DS-581 a repo named by its name is not another whose name only ends the same, nor owner/name one under another owner" \
  '[ "$(cut -d"|" -f17,18 <<< "$r")" = "{\"holds\":false,\"note\":\"no studia-web queue was found on this computer\"}|{\"holds\":false,\"note\":\"no acme/studia-web queue was found on this computer\"}" ]'
check "DS-581 owner/name matches its slug, case aside" '[[ "$(cut -d"|" -f19 <<< "$r")" == "{\"holds\":true"* ]]'
check "DS-581 AC6 a ticket in a running batch of the repo holds" '[ "$(cut -d"|" -f12 <<< "$r")" = "{\"holds\":true,\"note\":\"in acme__studia-web batch b\"}" ]'
check "DS-581 in a batch whose orchestrator is not running, it does not" '[ "$(cut -d"|" -f13 <<< "$r")" = "{\"holds\":false,\"note\":\"in acme__studia-web batch b, whose orchestrator is not running\"}" ]'
check "DS-581 AC7 with no queue of the repo, it does not hold, saying so" '[ "$(cut -d"|" -f14 <<< "$r")" = "{\"holds\":false,\"note\":\"no studia-web queue was found on this computer\"}" ]'
check "DS-581 an unreadable queue of the repo is an error, unless another running batch holds it" \
  '[ "$(cut -d"|" -f15 <<< "$r")" = "{\"error\":\"acme__studia-web batch c'"'"'s queue cannot be read (torn)\"}" ] && [[ "$(cut -d"|" -f16 <<< "$r")" == "{\"holds\":true"* ]]'
check "DS-581 AC1 the review form reads, # optional" '[ "$(cut -d"|" -f1 <<< "$r")" = "{\"kind\":\"pr-reviewed\",\"pr\":3063,\"login\":\"agent-pullbot\"}" ]'
check "DS-581 file paths under \$DESK_STATE and the worktree read, and ~ or a climb out of \$DESK_STATE is refused" \
  '[ "$(cut -d"|" -f2,3 <<< "$r")" = "{\"kind\":\"file-exists\",\"path\":\"fixtures/AA-48/meet.json\",\"root\":\"state\"}|{\"kind\":\"file-exists\",\"path\":\"out/meet.json\",\"root\":\"worktree\"}" ] && [[ "$(cut -d"|" -f4,5 <<< "$r")" == *"is outside the ticket"*"is outside the ticket"* ]]'
check "DS-581 the queued form reads as SV-3994 wrote it, and as owner/name" \
  '[ "$(cut -d"|" -f6,7 <<< "$r")" = "{\"kind\":\"ticket-queued\",\"ticket\":\"SV-3994\",\"repo\":\"studia-web\"}|{\"kind\":\"ticket-queued\",\"ticket\":\"SV-3994\",\"repo\":\"acme/studia-web\"}" ]'
check "DS-581 an app's review, written with its [bot] suffix, counts at the head" '[ "$(cut -d"|" -f8 <<< "$r")" = "{\"holds\":true}" ]'
check "DS-581 AC8 a failed reviews read is an error, not holding" '[ "$(cut -d"|" -f9 <<< "$r")" = "{\"error\":\"gh pr view 1: HTTP 502\"}" ]'
check "DS-581 a file path is read under \$DESK_STATE or the worktree" '[ "$(cut -d"|" -f10,11 <<< "$r")" = "/s/a/b|/w/a/b" ]'
# A file condition read against its park's question.
r=$(node --input-type=module -e "
import { withQuestion } from '$B/clears-when.mjs';
const w = (cond, q) => JSON.stringify(withQuestion(cond, q, { state: '/h/.desk-autopilot/acme__w', home: '/h' }));
const rel = { kind: 'file-exists', path: 'fixtures/DS-776/compare-pass.txt', root: 'worktree' };
console.log([
  w(rel, 'Please run compare_pass.sh on the host and save its output to ~/.desk-autopilot/acme__w/fixtures/DS-776/compare-pass.txt.'),
  w(rel, 'Waiting on the evidence run, which writes /elsewhere/DS-776/compare-pass.txt'),
  w(rel, 'Waiting on the evidence run to write fixtures/DS-776/compare-pass.txt'),
  w(rel, 'Which copy should the heading use?'),
  w({ kind: 'pr-merged', pr: 5 }, 'Please save it to out/x.txt'),
  w({ kind: 'file-exists', path: '/h/.desk-autopilot/acme__w/fixtures/a.json', root: 'abs' }, 'Could you save it as \`\$DESK_STATE/fixtures/a.json\`?'),
  w({ kind: 'file-exists', path: 'fixtures/meet.json', root: 'worktree' }, 'Please save the capture to out/meet.json'),
].join('|'));
")
check "DS-807 AC4 a relative clears-when looks where the question's ~/ path under the state directory says, and is the person's where it asks them" \
  '[ "$(cut -d"|" -f1 <<< "$r")" = "{\"ok\":true,\"cond\":{\"kind\":\"file-exists\",\"path\":\"fixtures/DS-776/compare-pass.txt\",\"root\":\"state\",\"person\":true}}" ]'
check "DS-807 AC4 AC3 an absolute path a script writes is looked at there, and is not the person's" \
  '[ "$(cut -d"|" -f2 <<< "$r")" = "{\"ok\":true,\"cond\":{\"kind\":\"file-exists\",\"path\":\"/elsewhere/DS-776/compare-pass.txt\",\"root\":\"abs\"}}" ]'
check "DS-807 AC3 the same path a script writes, a question naming no file, and any other condition are kept as given" \
  '[ "$(cut -d"|" -f3,4,5 <<< "$r")" = "{\"ok\":true,\"cond\":{\"kind\":\"file-exists\",\"path\":\"fixtures/DS-776/compare-pass.txt\",\"root\":\"worktree\"}}|{\"ok\":true,\"cond\":{\"kind\":\"file-exists\",\"path\":\"fixtures/DS-776/compare-pass.txt\",\"root\":\"worktree\"}}|{\"ok\":true,\"cond\":{\"kind\":\"pr-merged\",\"pr\":5}}" ]'
check "DS-807 an absolute path under the state directory is the question's \$DESK_STATE one" \
  '[ "$(cut -d"|" -f6 <<< "$r")" = "{\"ok\":true,\"cond\":{\"kind\":\"file-exists\",\"path\":\"/h/.desk-autopilot/acme__w/fixtures/a.json\",\"root\":\"abs\",\"person\":true}}" ]'
check "DS-807 AC4 a relative path the question contradicts with another relative one is refused, saying the two paths differ" \
  '[[ "$(cut -d"|" -f7 <<< "$r")" == "{\"ok\":false,\"why\":\"the question names \\\"out/meet.json\\\" and the clears-when \\\"fixtures/meet.json\\\": the two paths differ"* ]]'
r=$(node --input-type=module -e "
import { withQuestion } from '$B/clears-when.mjs';
const w = (cond, q) => { const r = withQuestion(cond, q, { state: '/h/.desk-autopilot/acme__w', home: '/h' }); return r.ok ? [r.cond.root, r.cond.path, !!r.cond.person].join(' ') : r.why; };
const rel = { kind: 'file-exists', path: 'fixtures/DS-776/compare-pass.txt', root: 'worktree' };
const mov = { kind: 'file-exists', path: 'fixtures/Screen Recording.mov', root: 'worktree' };
console.log([
  w(rel, 'Please copy /tmp/DS-776/compare-pass.txt to \$DESK_STATE/fixtures/DS-776/compare-pass.txt'),
  w({ kind: 'file-exists', path: 'fixtures/X/out.txt', root: 'state' }, 'Please save it to ~/.desk-autopilot/<slug>/fixtures/X/out.txt'),
  w(mov, 'Please save the recording to \"\$DESK_STATE/fixtures/Screen Recording.mov\".'),
  w(mov, 'Please save it to ~/.desk-autopilot/acme__w/fixtures/Screen\\\\ Recording.mov'),
  w(rel, 'The nightly job needs it to write \$DESK_STATE/fixtures/DS-776/compare-pass.txt'),
  w(rel, 'Waiting on CI: run 991 writes \$DESK_STATE/fixtures/DS-776/compare-pass.txt'),
  w(rel, 'Please run the check once the worker saves \$DESK_STATE/fixtures/DS-776/compare-pass.txt'),
  w(rel, 'Waiting on runs that write /a/compare-pass.txt and /b/compare-pass.txt'),
  w(rel, 'This needs Ben to save its output to \$DESK_STATE/fixtures/DS-776/compare-pass.txt. Then the check reruns.'),
  w(rel, 'Please run the export and, after it finishes, save the output to \$DESK_STATE/fixtures/DS-776/compare-pass.txt'),
  w(rel, 'Please copy the export to /tmp/delivery/compare-pass.txt from \$DESK_STATE/staging/compare-pass.txt'),
  w(rel, 'Please save the export to \\\${DESK_STATE}/fixtures/DS-776/compare-pass.txt'),
].join('|'));
")
check "DS-807 AC1 a further step of the same request after a timing clause is still the person's" '[ "$(cut -d"|" -f10 <<< "$r")" = "state fixtures/DS-776/compare-pass.txt true" ]'
check "DS-807 AC4 a copy's destination is looked at, never the path it copies from" '[ "$(cut -d"|" -f11 <<< "$r")" = "abs /tmp/delivery/compare-pass.txt true" ]'
check "DS-807 AC4 a \${DESK_STATE} path is a place, not a placeholder" '[ "$(cut -d"|" -f12 <<< "$r")" = "state fixtures/DS-776/compare-pass.txt true" ]'
check "DS-807 AC4 a copy request looks at the \$DESK_STATE copy, not its source" '[ "$(cut -d"|" -f1 <<< "$r")" = "state fixtures/DS-776/compare-pass.txt true" ]'
check "DS-807 AC4 an absolute or \$DESK_STATE clears-when is kept when the question's path is a placeholder, and is still the person's" \
  '[ "$(cut -d"|" -f2 <<< "$r")" = "state fixtures/X/out.txt true" ]'
check "DS-807 AC1 a quoted or escaped path with a space is the question's file" \
  '[ "$(cut -d"|" -f3,4 <<< "$r")" = "state fixtures/Screen Recording.mov true|state fixtures/Screen Recording.mov true" ]'
check "DS-807 AC3 a file a job, a run or the worker makes is not the person's" \
  '[ "$(cut -d"|" -f5,6,7 <<< "$r")" = "state fixtures/DS-776/compare-pass.txt false|state fixtures/DS-776/compare-pass.txt false|state fixtures/DS-776/compare-pass.txt false" ]'
check "DS-807 AC4 a question naming two places for the file is refused, naming both" \
  '[[ "$(cut -d"|" -f8 <<< "$r")" == "the question names \"/a/compare-pass.txt\", \"/b/compare-pass.txt\" and the clears-when \"fixtures/DS-776/compare-pass.txt\": it names more than one place"* ]]'
check "DS-807 AC1 a question asking the person by name is theirs" '[ "$(cut -d"|" -f9 <<< "$r")" = "state fixtures/DS-776/compare-pass.txt true" ]'
check "DS-349 queue.mjs clears-when stores a run" '[ "$(field R-1 park.clears_when)" = "{\"kind\":\"run-completed\",\"run\":41048026730}" ]'
check "queue.mjs clears-when stores the condition on the park" '[ "$(field D-1 park.clears_when)" = "{\"kind\":\"ticket-done\",\"ticket\":\"ABC-9\"}" ]'
# A condition only the parked ticket's own draft leaving draft or merging makes hold is refused.
draft(){ q set "$1" "pr_status={\"pr\":$2,\"state\":\"OPEN\",\"isDraft\":$3}"; }
parked DR-1 A "the Review gate is red on #3085"; draft DR-1 3085 true
out=$(node "$B/queue.mjs" clears-when DR-1 "pr 3085 ready" 2>&1); rc=$?
check "DS-582 AC1 its own draft PR leaving draft is refused, saying the park keeps it in draft, and nothing is recorded" \
  '[ $rc -ne 0 ] && grep -q "PR #3085 is DR-1.s own draft, and the park itself keeps it in draft" <<< "$out" && grep -q "Nothing was recorded" <<< "$out" && [ "$(field DR-1 park.clears_when)" = null ]'
out=$(node "$B/queue.mjs" clears-when DR-1 "pr 3085 merged" 2>&1); rc=$?
check "DS-582 AC2 and so is it merging" '[ $rc -ne 0 ] && grep -q "PR #3085 is DR-1.s own draft, and the park itself keeps it in draft" <<< "$out" && [ "$(field DR-1 park.clears_when)" = null ]'
out=$(node "$B/queue.mjs" clears-when DR-1 "pr 3090 ready" 2>&1); rc=$?
check "DS-582 AC4 another ticket's draft PR is accepted" '[ $rc -eq 0 ] && [ "$(field DR-1 park.clears_when)" = "{\"kind\":\"pr-ready\",\"pr\":3090}" ]'
parked DR-2 A "waiting on a merge of #3086"; draft DR-2 3086 false
out=$(node "$B/queue.mjs" clears-when DR-2 "pr 3086 merged" 2>&1); rc=$?
check "DS-582 AC5 its own PR out of draft merging is accepted" '[ $rc -eq 0 ] && [ "$(field DR-2 park.clears_when)" = "{\"kind\":\"pr-merged\",\"pr\":3086}" ]'
parked DR-3 A "waiting on #3087"
out=$(node "$B/queue.mjs" clears-when DR-3 "pr 3087 ready" 2>&1); rc=$?
check "DS-582 AC6 with no recorded PR it is accepted" '[ $rc -eq 0 ] && [ "$(field DR-3 park.clears_when)" = "{\"kind\":\"pr-ready\",\"pr\":3087}" ]'
q drop DR-1; q drop DR-2; q drop DR-3
q add C-10 Story A; q set C-10 state=running branch=feat/C-10 session_id=gone; draft C-10 3085 true
say "AUTOPILOT_PARK: the Review gate is red on #3085" "AUTOPILOT_PARK_CLEARS_WHEN: PR #3085 out of draft" > "$T/state/logs/C-10.log"
# A park asking the person to save a file, recorded by queue.mjs and by a worker's lines.
parked FP-1 A "Please run compare_pass.sh on the host and save its output to \$DESK_STATE/fixtures/FP-1/compare-pass.txt" "file fixtures/FP-1/compare-pass.txt exists"
parked FP-2 A "Please save the capture to out/meet.json"
out=$(node "$B/queue.mjs" clears-when FP-2 "file fixtures/meet.json exists" 2>&1); rc=$?
check "DS-807 AC4 queue.mjs clears-when refuses a path the question contradicts, saying the two paths differ, and records nothing" \
  '[ $rc -ne 0 ] && grep -q "the two paths differ" <<< "$out" && grep -q "Nothing was recorded" <<< "$out" && [ "$(field FP-2 park.clears_when)" = null ]'
check "DS-807 AC4 queue.mjs clears-when looks where the question's \$DESK_STATE path says, marked the person's" \
  '[ "$(field FP-1 park.clears_when)" = "{\"kind\":\"file-exists\",\"path\":\"fixtures/FP-1/compare-pass.txt\",\"root\":\"state\",\"person\":true}" ]'
parked FP-3 A "Please save the export to \$DESK_STATE/fixtures/FP-3/export.csv"
out=$(node "$B/queue.mjs" clears-when FP-3 "file fixtures/FP-3/export.csv exists" 2>&1)
check "DS-807 AC4 queue.mjs clears-when says the path it recorded, and that the person makes it" \
  'grep -qF "FP-3: its park clears when file \$DESK_STATE/fixtures/FP-3/export.csv exists, which the person makes" <<< "$out"'
q drop FP-3
q add C-11 Story A; q set C-11 state=running branch=feat/C-11 session_id=gone
say "AUTOPILOT_PARK: Please save the export to $T/state/fixtures/C-11/export.csv" "AUTOPILOT_PARK_CLEARS_WHEN: file fixtures/C-11/export.csv exists" > "$T/state/logs/C-11.log"
q add C-12 Story A; q set C-12 state=running branch=feat/C-12 session_id=gone
say "AUTOPILOT_PARK: Please save the export to out/export.csv" "AUTOPILOT_PARK_CLEARS_WHEN: file fixtures/export.csv exists" > "$T/state/logs/C-12.log"

# #1290: a park on another author's PR on another branch merging, with no work of its own, is done by it;
# one on its own branch's PR is requeued as before.
parked O-1 A "PR #880 fixes the same thing" "pr 880 merged"
printf '{"state":"MERGED","isDraft":false,"mergedAt":"2026-11-23T10:00:00Z","headRefName":"fix/other-880","author":{"login":"someone-else"}}\n' > "$T/gh/pr-880.json"
# #1294: H-1 held behind O-1 is released once O-1 is done by #880; O-4, parked as not its own before
# such a park was settled, is done by its PR once that merged.
q add H-1 Story A; q set H-1 state=triaged; q hold H-1 O-1
# H-2 is held behind R-9, requeued after an earlier round merged (its merged_at kept) and done again on a
# PR still open: that earlier merge does not release H-2.
q add R-9 Story A; q set R-9 state=done result.pr=884 merged_at=2026-01-01T00:00:00Z; pr 884 OPEN false
q add H-2 Story A; q set H-2 state=triaged; q hold H-2 R-9
# H-3 is held behind R-8, once done by #880 and then done again on its own PR #885, still open: its old
# done_by does not release H-3.
q add R-8 Story A; q set R-8 state=done result.pr=885 merged_at=2026-01-01T00:00:00Z 'done_by={"pr":880,"why":"x"}'; pr 885 OPEN false
q add H-3 Story A; q set H-3 state=triaged; q hold H-3 R-8
parked O-4 A "its PR #883 is not its own: PR #883 is on branch fix/other-883, not O-4's branch feat/O-4. desk takes as a ticket's result only a PR on the branch its worker made"; q set O-4 result.pr=883
printf '{"state":"MERGED","isDraft":false,"mergedAt":"2026-11-23T11:00:00Z","headRefName":"fix/other-883","author":{"login":"someone-else"}}\n' > "$T/gh/pr-883.json"
parked O-2 A "waiting on my PR #881" "pr 881 merged"
printf '{"state":"MERGED","isDraft":false,"headRefName":"feat/O-2","author":{"login":"someone-else"}}\n' > "$T/gh/pr-881.json"
out=$(node "$B/pass.mjs" 2>&1)
check "#1290 a park on another branch's PR merging is done by it, with no requeue and no result PR" \
  '[ "$(field O-1 state)" = "\"done\"" ] && [ "$(field O-1 done_by.pr)" = 880 ] && [ "$(field O-1 result.pr)" = null ] && [ "$(field O-1 park)" = null ] && grep -qF "O-1: \"PR #880 merged\" holds, and #880 is not its own (PR #880 is on branch fix/other-880, not O-1'"'"'s branch feat/O-1) with no work of its own beside it: recorded done by #880, no worker spawned" <<< "$out" && ! grep -q "\[spawn\] ticket=O-1" <<< "$out"'
check "#1294 a ticket held behind one done by another's PR is released" \
  '[ "$(field O-1 merged_at)" = "\"2026-11-23T10:00:00Z\"" ] && [ "$(field H-1 state)" = "\"triaged\"" ] && [ "$(field H-1 held_by)" = null ] && grep -q "released: H-1, every blocker merged (O-1)" <<< "$out"'
check "#1294 an earlier round's merged_at does not release what is held behind a ticket whose PR is still open" '[ "$(field H-2 state)" = "\"parked\"" ] && [ "$(field H-2 held_by)" = "\"R-9\"" ] && ! grep -q "released: H-2" <<< "$out"'
check "#1294 an old done_by does not release what is held behind a ticket done again on its own PR, still open" '[ "$(field H-3 state)" = "\"parked\"" ] && ! grep -q "released: H-3" <<< "$out"'
check "#1294 a not-its-own park whose PR merged is done by it, its foreign result PR cleared" \
  '[ "$(field O-4 state)" = "\"done\"" ] && [ "$(field O-4 done_by.pr)" = 883 ] && [ "$(field O-4 result.pr)" = null ] && [ "$(field O-4 merged_at)" = "\"2026-11-23T11:00:00Z\"" ] && grep -qF "O-4: \"PR #883 merged\" holds, and #883 is not its own" <<< "$out"'
check "#1290 a park on its own branch's PR merging is requeued as before" '[ "$(field O-2 state)" = "\"triaged\"" ] && grep -qF "O-2: \"PR #881 merged\" holds: requeued" <<< "$out"'
check "DS-269 AC2 a worker's park records its condition" '[ "$(field C-1 state)" = "\"parked\"" ] && [ "$(field C-1 park.clears_when)" = "{\"kind\":\"pr-merged\",\"pr\":41}" ]'
check "DS-563 AC3 an unreadable condition is kept for the decider to restate, and reported" \
  '[ "$(field C-2 park.clears_when.kind)" = "\"unreadable\"" ] && [ "$(field C-2 park.clears_when.text)" = "\"when it rains\"" ] && grep -q "C-2: unreadable clears-when (\"when it rains\" is not one of.*), kept for the decider to restate" <<< "$out"'
check "DS-563 AC1 KAN-976's gh pr view command is recorded as PR 991 merged" '[ "$(field C-6 park.clears_when)" = "{\"kind\":\"pr-merged\",\"pr\":991}" ]'
check "DS-563 AC2 a check line is recorded as that check passing, and waits while it runs" \
  '[ "$(field C-7 park.clears_when)" = "{\"kind\":\"checks-pass\",\"pr\":874,\"checks\":[\"Flows image\"]}" ] && [ "$(field C-7 state)" = "\"parked\"" ] && grep -q "C-7: waiting on ..Flows image. passing on PR #874.s head. (.Flows image. is in_progress at ddddddddd): left parked" <<< "$out"'
check "DS-563 AC3 prose is kept for the decider, not checked and not none" '[ "$(field C-8 park.clears_when.kind)" = "\"unreadable\"" ] && [ "$(field C-8 state)" = "\"parked\"" ]'
check "DS-582 AC3 a worker's line on its own draft leaving draft is recorded none, and the report names why" \
  '[ "$(field C-10 state)" = "\"parked\"" ] && [ "$(field C-10 park.clears_when)" = "{\"kind\":\"none\"}" ] && grep -q "C-10: clears-when \"PR #3085 out of draft\" recorded as none, for the person: PR #3085 is C-10.s own draft, and the park itself keeps it in draft" <<< "$out"'
r=$(node --input-type=module -e "
import { settlesByScript } from '$B/batch-state.mjs';
const q = JSON.parse((await import('node:fs')).readFileSync('$DESK_QUEUE', 'utf8'));
console.log([settlesByScript(q.tickets['C-8']), settlesByScript(q.tickets['E-2'])].join('|'));
")
check "DS-563 AC3 a park waiting on its restate is not yet the person's (digest and needs-you leave it out), and one recorded none is" '[ "$r" = "true|false" ]'
check "DS-807 AC4 a worker's relative clears-when is recorded where its question's path says, marked the person's" \
  '[ "$(field C-11 park.clears_when)" = "{\"kind\":\"file-exists\",\"path\":\"fixtures/C-11/export.csv\",\"root\":\"state\",\"person\":true}" ] && grep -qF "C-11: clears-when \"file fixtures/C-11/export.csv exists\" recorded as file \$DESK_STATE/fixtures/C-11/export.csv exists, where its question says" <<< "$out"'
check "DS-807 AC4 one its question contradicts is kept for the decider to restate, naming why" \
  '[ "$(field C-12 park.clears_when.kind)" = "\"unreadable\"" ] && grep -q "C-12: unreadable clears-when (the question names \"out/export.csv\" and the clears-when \"fixtures/export.csv\": the two paths differ" <<< "$out"'
r=$(node --input-type=module -e "
import { settlesByScript } from '$B/batch-state.mjs';
import { personClears } from '$B/clears-when.mjs';
const q = JSON.parse((await import('node:fs')).readFileSync('$DESK_QUEUE', 'utf8'));
console.log([settlesByScript(q.tickets['FP-1']), personClears(q.tickets['FP-1'].park.clears_when), settlesByScript(q.tickets['FE-2']), personClears(q.tickets['FE-2'].park.clears_when)].join('|'));
")
check "DS-807 AC1 AC2 a park on a file the person is asked to make is theirs, so the digest and needs-you list it" '[ "$(cut -d"|" -f1,2 <<< "$r")" = "false|true" ]'
check "DS-807 AC3 a park on a file a script makes still settles by script" '[ "$(cut -d"|" -f3,4 <<< "$r")" = "true|false" ]'
check "DS-807 the pass still checks the person's file, and leaves the park while it is not there" '[ "$(field FP-1 state)" = "\"parked\"" ]'
check "DS-269 AC2 a condition printed before the last park is not that park's" '[ "$(field C-3 park.clears_when)" = "{\"kind\":\"none\"}" ]'
check "DS-269 a condition that does not hold yet says nothing and leaves the park" '! grep -q "C-1: \"" <<< "$out" && ! grep -q "E-4: \"\|E-4: could not" <<< "$out" && [ "$(field E-4 state)" = "\"parked\"" ]'
check "DS-269 AC4 a lane C park whose condition holds stays, and the report says so" '[ "$(field D-1 state)" = "\"parked\"" ] && grep -q "D-1: \"ABC-9 done\" holds, but it is lane C: left parked for a person" <<< "$out"'
check "DS-269 AC6 a failed gh check leaves the park and is named" '[ "$(field E-1 state)" = "\"parked\"" ] && grep -q "E-1: could not check \"PR #77 merged\" (gh pr view 77: gh: HTTP 502 for PR 77): left parked" <<< "$out"'
check "DS-269 AC6 a failed Jira check leaves the park and is named" '[ "$(field E-3 state)" = "\"parked\"" ] && grep -q "E-3: could not check \"ABC-404 done\" (desk-jira get ABC-404: desk-jira: unreachable): left parked" <<< "$out"'
check "DS-269 AC6 a park with none is left alone and not reported" '[ "$(field E-2 state)" = "\"parked\"" ] && ! grep -q "E-2: \"\|E-2: could not" <<< "$out"'
check "DS-269 AC7 a variable set and its own PR merged: recorded done, no person" '[ "$(field V-1 state)" = "\"done\"" ] && [ "$(field V-1 result.pr)" = 699 ] && [ "$(field V-1 park)" = null ] && grep -q "V-1: \"repo variable DESK_DEPLOY_ON set\" holds and its PR #699 merged: recorded done" <<< "$out"'
check "DS-269 AC3 an own PR found merged from the branch closes it out" '[ "$(field W-1 state)" = "\"done\"" ] && [ "$(field W-1 result.pr)" = 707 ] && grep -q "W-1: \"PR #706 out of draft\" holds and its PR #707 merged: recorded done" <<< "$out"'
check "DS-349 AC8 a finished run: requeued with no person, and the report names its conclusion" \
  '[ "$(field R-1 state)" = "\"triaged\"" ] && grep -q "R-1: \"Actions run 41048026730 completed, conclusion failure\" holds: requeued" <<< "$out"'
check "DS-349 AC8 the next worker is told the run's conclusion" \
  '[ "$(field R-1 cleared.what)" = "\"Actions run 41048026730 completed, conclusion failure\"" ] && [ "$(field R-1 prev_park.question)" = "\"waiting on e2e run 41048026730\"" ]'
check "DS-349 AC9 a run in progress: the park stays, and the report shows it waiting" \
  '[ "$(field R-2 state)" = "\"parked\"" ] && grep -q "R-2: waiting on \"Actions run 41048026731 completed\" (still in_progress): left parked" <<< "$out"'
check "DS-349 a run that cannot be read leaves the park and is named" \
  '[ "$(field R-3 state)" = "\"parked\"" ] && grep -q "R-3: could not check \"Actions run 41048026732 completed\" (gh run view 41048026732: gh: HTTP 404: run 41048026732 not found): left parked" <<< "$out"'
check "DS-269 the report groups them under clears-when" 'grep -q "^clears-when:$" <<< "$out"'
check "DS-496 AC2 the pass makes the push, requeues, and tells the next worker" \
  'on_origin P-1 && [ "$(field P-1 state)" = "\"triaged\"" ] && [ "$(field P-1 branch)" = "\"feat/P-1\"" ] && [ "$(field P-1 cleared.what)" = "\"git push origin feat/P-1 succeeds\"" ] && grep -q "P-1: \"git push origin feat/P-1 succeeds\" holds: requeued" <<< "$out"'
check "DS-496 AC2 another 5xx: the park stays, its condition kept for the next pass" \
  '! on_origin P-2 && [ "$(field P-2 state)" = "\"parked\"" ] && [ "$(field P-2 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-2\"}" ] && grep -q "P-2: waiting on \"git push origin feat/P-2 succeeds\" (GitHub still answers 5xx): left parked" <<< "$out"'
check "DS-496 AC3 any other refusal ends the tries and goes to a person" \
  '! on_origin P-3 && [ "$(field P-3 state)" = "\"parked\"" ] && [ "$(field P-3 park.clears_when)" = "{\"kind\":\"none\"}" ] && [[ "$(field P-3 park.recovery)" == *"git refused it"* ]] && grep -q "P-3: could not check \"git push origin feat/P-3 succeeds\"" <<< "$out"'
check "DS-496 a lease push §3 does not grant is not made, and says so" \
  '! on_origin P-4 && [ "$(field P-4 park.clears_when)" = "{\"kind\":\"none\"}" ] && grep -q "P-4: could not check \"git push --force-with-lease=feat/P-4:$PIN origin feat/P-4 succeeds\" (config §3 git-force-with-lease is \"ask\"): left parked" <<< "$out"'
check "DS-496 AC2 a pinned one-off grant for that branch and SHA: the pass makes the lease push and requeues" \
  '[ "$(git -C "$T/origin.git" rev-parse refs/heads/feat/P-9)" = "$REWRITTEN" ] && [ "$(field P-9 state)" = "\"triaged\"" ] && grep -q "P-9: \"git push --force-with-lease=feat/P-9:$HELD origin feat/P-9 succeeds\" holds: requeued" <<< "$out"'
check "DS-496 a pinned grant for another SHA does not: it goes to a person" \
  '[ "$(git -C "$T/origin.git" rev-parse refs/heads/feat/P-10)" = "$HELD" ] && [ "$(field P-10 state)" = "\"parked\"" ] && grep -q "P-10: could not check .*(config §3 git-force-with-lease is \"ask\"): left parked" <<< "$out"'
check "DS-496 an unpinned one-off grant does not let a pass make the lease push: it goes to a person" \
  '[ "$(git -C "$T/origin.git" rev-parse refs/heads/feat/P-8)" = "$HELD" ] && [ "$(field P-8 state)" = "\"parked\"" ] && [ "$(field P-8 park.clears_when)" = "{\"kind\":\"none\"}" ] && grep -q "P-8: could not check .*(config §3 git-force-with-lease is \"ask\"): left parked" <<< "$out"'
check "DS-496 a lane C park is not pushed for" \
  '! on_origin P-5 && [ "$(field P-5 state)" = "\"parked\"" ] && grep -q "P-5: \"git push origin feat/P-5 succeeds\" not tried, since it is lane C: left parked for a person" <<< "$out"'
check "DS-496 a condition naming another branch is not pushed" \
  '[ "$(field P-6 state)" = "\"parked\"" ] && ! git -C "$T/origin.git" rev-parse --verify -q refs/heads/feat/other >/dev/null && grep -q "P-6: could not check .*it names feat/other, and the ticket.s branch is feat/P-6" <<< "$out"'
check "DS-496 a worker's park line records a push, -u dropped, and with no worktree it goes to a person" \
  '[ "$(field C-4 state)" = "\"parked\"" ] && [ "$(field C-4 park.clears_when)" = "{\"kind\":\"none\"}" ] && grep -q "C-4: could not check \"git push origin feat/C-4 succeeds\" (it has no worktree to push from): left parked" <<< "$out"'
check "DS-496 AC2 a lease park's clears-when SHA goes on its inputs, so a yes to it is a pinned grant after the condition is cleared" \
  '[ "$(field C-5 park.clears_when)" = "{\"kind\":\"none\"}" ] && [ "$(field C-5 park.inputs)" = "{\"step\":\"push\",\"lease\":\"$PIN\"}" ]'
check "DS-514 AC1 a force-push park naming no SHA is refused back to a worker, with the reason on the ticket" \
  '[ "$(field F-1 state)" = "\"triaged\"" ] && [ "$(field F-1 park)" = null ] && [ "$(field F-1 lease_refused.question)" = "$(field F-1 prev_park.question)" ] && [[ "$(field F-1 lease_refused.question)" == *"force-push of feat/F-1"* ]] && [ "$(field F-1 grant)" = null ] && grep -q "F-1: its park asked for a force-push naming no lease SHA: refused back" <<< "$out"'
check "DS-514 AC1 a second one stays parked, saying no answer can grant it" \
  '[ "$(field F-2 state)" = "\"parked\"" ] && [[ "$(field F-2 park.recovery)" == *"no answer can grant it"* ]]'
check "DS-514 AC1 and it becomes the refused park, so a requeue tells the next worker why" \
  '[ "$(field F-2 lease_refused.question)" = "$(field F-2 park.question)" ] && [[ "$(field F-2 lease_refused.question)" == *"force-push of feat/F-2"* ]]'
check "DS-514 AC2 a force-push park naming the SHA is recorded, with its lease" \
  '[ "$(field F-3 state)" = "\"parked\"" ] && [ "$(field F-3 park.inputs)" = "{\"lease\":\"$PIN\"}" ] && [ "$(field F-3 park.recovery)" = null ]'
check "DS-514 AC3 a park that only mentions a force-push is recorded and not refused" \
  '[ "$(field F-4 state)" = "\"parked\"" ] && [ "$(field F-4 lease_refused)" = null ]'
check "DS-514 a lane C park is left for a person, not sent to a worker" \
  '[ "$(field F-5 state)" = "\"parked\"" ] && [ "$(field F-5 lease_refused)" = null ]'
check "DS-581 AC2 a review by that account on the head settles the park" \
  '[ "$(field RV-1 state)" = "\"triaged\"" ] && grep -q "RV-1: \"PR #3063 reviewed by agent-pullbot at its head\" holds: requeued" <<< "$out"'
check "DS-581 AC3 a review only on an older commit does not hold" \
  '[ "$(field RV-2 state)" = "\"parked\"" ] && grep -q "RV-2: waiting on \"PR #3064 reviewed by agent-pullbot at its head\" (agent-pullbot.s review is on an older commit than the head bbbbbbbbb): left parked" <<< "$out"'
check "DS-581 AC8 a failed reviews read leaves the park and is named" \
  '[ "$(field RV-3 state)" = "\"parked\"" ] && grep -q "RV-3: could not check \"PR #3065 reviewed by agent-pullbot at its head\" (gh pr view 3065: gh: HTTP 502 reading reviews of PR 3065): left parked" <<< "$out"'
check "DS-581 AC4 a file that is there settles the park, one not there yet leaves it" \
  '[ "$(field FE-1 state)" = "\"triaged\"" ] && grep -q "FE-1: \"file $T/files/AA-48-recall-capture/meet.json exists\" holds: requeued" <<< "$out" && [ "$(field FE-2 state)" = "\"parked\"" ]'
check "DS-581 AC6 a ticket in a running studia-web batch settles the park" \
  '[ "$(field TQ-1 state)" = "\"triaged\"" ] && grep -q "TQ-1: \"SV-3994 in a running studia-web batch, in acme__studia-web\" holds: requeued" <<< "$out"'
check "DS-581 AC7 with no studia-zendesk queue it does not hold, and the report says the queue was not found" \
  '[ "$(field TQ-2 state)" = "\"parked\"" ] && grep -q "TQ-2: waiting on \"SV-3995 in a running studia-zendesk batch\" (no studia-zendesk queue was found on this computer): left parked" <<< "$out"'

# ---- AC3: a lane A ticket waiting on something else is requeued ------------------------------------
pr 41 MERGED false
# Its first run failed and a later one passed: only the latest run counts.
fl='{"name":"Flows image","workflowName":"images","status":"COMPLETED","conclusion":"%s","startedAt":"%s","detailsUrl":"https://github.com/acme/widgets/actions/runs/%s/job/1"}'
printf "{\"headRefOid\":\"%s\",\"statusCheckRollup\":[$fl,$fl]}\n" "$(printf d%.0s {1..40})" FAILURE 2026-11-01T10:00:00Z 1 SUCCESS 2026-11-01T11:00:00Z 2 > "$T/gh/checks-874.json"
q add V-2 Story A; q park V-2 "set FOO"; q clears-when V-2 "variable FOO set"; touch "$T/gh/vars.fail"
rm "$T/gh/refuse-feat_P-2" "$T/gh/refuse-feat_P-3"
mkdir -p "$T/state/fixtures/FP-1"; : > "$T/state/fixtures/FP-1/compare-pass.txt"
# C-8 waited past the restate window with no restate (no decider came, or a session left it); C-2 has
# just parked.
q set C-8 'park.clears_when={"kind":"unreadable","text":"KAN-1086s fix PR is merged to main","why":"x","at":"2026-01-01T00:00:00Z"}'
out=$(node "$B/pass.mjs" 2>&1)
check "#1290 the next pass leaves it done: no re-park" '[ "$(field O-1 state)" = "\"done\"" ] && [ "$(field O-1 park)" = null ]'
check "#1294 the next pass leaves O-4 done: no re-park as not its own" '[ "$(field O-4 state)" = "\"done\"" ] && [ "$(field O-4 park)" = null ]'
node "$B/queue.mjs" requeue O-4 >/dev/null 2>&1
check "#1294 a requeue sends it back for work of its own: no longer done by its PR, nor merged by it" '[ "$(field O-4 done_by)" = null ] && [ "$(field O-4 merged_at)" = null ] && [ "$(field O-4 state)" = "\"triaged\"" ]'
# #1290: with the §1 handle set, a merged PR a collaborator opened from the ticket's own branch is not its
# own: done by it, not recorded as its result (which the PR status step would park as not its own).
cp "$T/config.md" "$T/config-h.md"; printf '\n## 1. Who you are\n| Field | Value |\n|---|---|\n| GitHub handle | `me` |\n' >> "$T/config-h.md"
parked O-3 A "a collaborator is finishing this on my branch" "pr 882 merged"
printf '{"state":"MERGED","isDraft":false,"headRefName":"feat/O-3","author":{"login":"someone-else"}}\n' > "$T/gh/pr-882.json"
echo '{"number":882,"author":{"login":"someone-else"}}' > "$T/gh/merged-feat_O-3"
out3=$(DESK_CONFIG="$T/config-h.md" node "$B/pass.mjs" 2>&1)
check "#1290 a collaborator's merged PR on its own branch is done by it, with no result PR" \
  '[ "$(field O-3 state)" = "\"done\"" ] && [ "$(field O-3 done_by.pr)" = 882 ] && [ "$(field O-3 result.pr)" = null ] && grep -qF "O-3: \"PR #882 merged\" holds, and #882 is not its own (PR #882 was opened by someone-else, not by me)" <<< "$out3"'
check "DS-563 a park no restate reached within the window is recorded none, so the digest lists it" \
  '[ "$(field C-8 park.clears_when)" = "{\"kind\":\"none\"}" ] && [ "$(field C-8 state)" = "\"parked\"" ] && grep -q "C-8: unreadable clears-when \"KAN-1086s fix PR is merged to main\" not restated within 60 minutes: recorded as none, for the person" <<< "$out"'
check "DS-807 AC5 the file saved where the question says: the next pass clears the park and requeues it" \
  '[ "$(field FP-1 state)" = "\"triaged\"" ] && grep -q "FP-1: \"file \$DESK_STATE/fixtures/FP-1/compare-pass.txt exists\" holds: requeued" <<< "$out"'
check "DS-563 one still inside the window keeps waiting on its restate" '[ "$(field C-2 park.clears_when.kind)" = "\"unreadable\"" ] && ! grep -q "C-2: unreadable" <<< "$out"'
check "DS-496 AC2 the 5xx over: the next pass pushes and requeues" 'on_origin P-2 && [ "$(field P-2 state)" = "\"triaged\"" ]'
check "DS-496 AC3 a refusal is not tried again" '! on_origin P-3 && [ "$(field P-3 state)" = "\"parked\"" ]'
check "DS-269 AC3 C-1's PR merged: requeued, with one line naming the condition" '[ "$(field C-1 state)" = "\"triaged\"" ] && [ "$(grep -c "C-1: \"PR #41 merged\" holds: requeued" <<< "$out")" = 1 ]'
check "DS-563 AC2 the check green at the PR's head: the pass settles the park" \
  '[ "$(field C-7 state)" = "\"triaged\"" ] && grep -q "C-7: ..Flows image. passing on PR #874.s head, at ddddddddd. holds: requeued" <<< "$out"'
check "DS-269 AC6 a failed variable read leaves the park and is named" '[ "$(field V-2 state)" = "\"parked\"" ] && grep -q "V-2: could not check \"repo variable FOO set\" (gh variable list: gh: HTTP 401: Bad credentials): left parked" <<< "$out"'
check "DS-269 AC4 still lane C: never requeued" '[ "$(field D-1 state)" = "\"parked\"" ]'
pushpark P-7 A; out=$(AUTOPILOT_DRY_RUN=1 node "$B/pass.mjs" 2>&1)
check "DS-496 a dry run pushes nothing" '! on_origin P-7 && [ "$(field P-7 state)" = "\"parked\"" ]'
git -C "$T/repo" remote set-url origin https://127.0.0.1:1/nothing.git; out=$(node "$B/pass.mjs" 2>&1); git -C "$T/repo" remote set-url origin "$T/origin.git"
check "DS-496 a push that reached nothing keeps the park and its condition" \
  '[ "$(field P-7 state)" = "\"parked\"" ] && [ "$(field P-7 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-7\"}" ] && [ "$(field P-7 park.recovery)" = null ] && grep -q "P-7: could not check \"git push origin feat/P-7 succeeds\"" <<< "$out"'
mkdir -p "$T/hung-push"; printf '#!/bin/sh\ncase " $* " in *" push "*) exec sleep 30;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "$T/hung-push/git"; chmod +x "$T/hung-push/git"
out=$(PATH="$T/hung-push:$PATH" DESK_READ_REPO_REFRESH_MS=1000 node "$B/pass.mjs" 2>&1)
check "DS-779 a push that hangs past its limit keeps the park and its condition" \
  '! on_origin P-7 && [ "$(field P-7 state)" = "\"parked\"" ] && [ "$(field P-7 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-7\"}" ] && [ "$(field P-7 park.recovery)" = null ] && grep -q "P-7: could not check \"git push origin feat/P-7 succeeds\" (git push ran past its 1 seconds)" <<< "$out"'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-496 and the next pass that reaches origin pushes it" 'on_origin P-7 && [ "$(field P-7 state)" = "\"triaged\"" ]'
# DS-912: the pass's push starts a preview build, so with §4 Vercel set it takes the team's
# preview-build unit first, and leaves the push for a later pass while every unit is held.
cp "$T/config.md" "$T/config-vercel.md"; printf '\n## 4. Tracker, tools and team\n| Field | Value |\n|---|---|\n| Vercel | `acme` |\n' >> "$T/config-vercel.md"
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `preview-build=on` | test |\n' > "$T/machine-pv.md"
LD="$T/leases"; pvl(){ DESK_LEASE_DIR="$LD" node "$B/leases.mjs" list --json 2>/dev/null | jq -r .label | paste -sd',' -; }
DESK_LEASE_DIR="$LD" DESK_MACHINE="$T/machine-pv.md" node "$B/leases.mjs" acquire preview-build acme --ttl 1200 --no-owner --label acme/site#7 >/dev/null 2>&1
pushpark P-11 A; q set P-11 result.pr=1911; pr 1911 OPEN true
out=$(DESK_CONFIG="$T/config-vercel.md" DESK_MACHINE="$T/machine-pv.md" DESK_LEASE_DIR="$LD" node "$B/pass.mjs" 2>&1)
check "DS-912 with the team's one unit held, the pass does not push, keeps the park, and says it waits on the preview build" \
  '! on_origin P-11 && [ "$(field P-11 state)" = "\"parked\"" ] && [ "$(field P-11 park.clears_when)" = "{\"kind\":\"push-ok\",\"branch\":\"feat/P-11\"}" ] && grep -q "P-11: waiting on \"git push origin feat/P-11 succeeds\" (it waits on the preview build for acme: the preview-build slot for acme is held by acme/site#7" <<< "$out"'
rm -rf "$LD"
# The label is the branch's open PR as GitHub lists it (the stub answers `pr list --head` from this file).
echo 1911 > "$T/gh/merged-feat_P-11"
out=$(DESK_CONFIG="$T/config-vercel.md" DESK_MACHINE="$T/machine-pv.md" DESK_LEASE_DIR="$LD" node "$B/pass.mjs" 2>&1)
rm -f "$T/gh/merged-feat_P-11"
check "DS-912 once a unit is free the pass takes it, labelled with the PR, pushes and requeues" 'on_origin P-11 && [ "$(field P-11 state)" = "\"triaged\"" ] && [ "$(pvl)" = "acme/widgets#1911" ]'
# While the batch is on a usage hold no decider starts, so a line past the window is not lapsed to none.
q add C-9 Story A; q park C-9 "waiting on KAN-1087"
q set C-9 'park.clears_when={"kind":"unreadable","text":"KAN-1087s fix PR is merged to main","why":"x","at":"2026-01-01T00:00:00Z"}'
q set-batch 'usage_hold={"since":"2026-01-01T00:00:00Z","type":"seven_day","paused":[]}'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-563 AC3 on a usage hold, a line past the window keeps waiting for a decider" \
  '[ "$(field C-9 park.clears_when.kind)" = "\"unreadable\"" ] && ! grep -q "C-9: unreadable" <<< "$out"'
node -e 'const f = process.argv[1]; const fs = require("fs"); const q = JSON.parse(fs.readFileSync(f, "utf8")); delete q.usage_hold; fs.writeFileSync(f, JSON.stringify(q, null, 2))' "$DESK_QUEUE"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-563 AC3 once the hold lifts it lapses as before" '[ "$(field C-9 park.clears_when)" = "{\"kind\":\"none\"}" ]'

# ---- the decider records a condition, and gets an answer to a park it was never handed --------------
node "$B/answer.mjs" E-2 "go with the second option" >/dev/null 2>&1
since=$(field E-2 park.since | tr -d '"')
r=$(node --input-type=module -e "
import { deciderSettings, deciderPrompt, freshItems, deciderItems } from '$B/decider.mjs';
const allow = deciderSettings({ bin: '/b', state: '/s' }).permissions.allow;
const prompt = deciderPrompt({ slug: 's', report: '', items: [], rules: '', bin: '/b' });
const items = deciderItems({ parked: [{ key: 'E-2', question: 'a product call' }] }, { tickets: { 'E-2': { lane: 'A', park: { since: '$since' } } } });
const later = deciderItems({ parked: [{ key: 'E-2', question: 'a product call' }] }, { tickets: { 'E-2': { lane: 'A', park: { since: '2999-01-01T00:00:00Z' } } } });
console.log([allow.includes('Bash(node /b/queue.mjs clears-when:*)'), prompt.includes('/b/queue.mjs clears-when <TICKET>'),
  freshItems('$T/state', items, {})[0].answers?.[0]?.text, freshItems('$T/state', later, {})[0].answers === undefined].join('|'));
")
check "DS-269 AC2 the decider may record a condition, and its prompt says how" '[ "$(cut -d"|" -f1,2 <<< "$r")" = "true|true" ]'
check "DS-269 AC5 an answer since a park never handed on goes to the decider with it" '[ "$(cut -d"|" -f3 <<< "$r")" = "go with the second option" ]'
check "DS-269 AC5 an answer from before the park does not" '[ "$(cut -d"|" -f4 <<< "$r")" = true ]'

# ---- DS-563 AC3: an unreadable clears-when goes to the decider to restate, and to the person only as none ----
r=$(node --input-type=module -e "
import { deciderItems, presort, deciderPrompt, outcome, restateKeys } from '$B/decider.mjs';
const un = { kind: 'unreadable', text: 'KAN-1086s fix PR is merged to main', why: 'x' };
const tickets = { 'U-1': { lane: 'A', state: 'parked', park: { question: 'waiting on KAN-1086', clears_when: un } },
  'U-2': { lane: 'C', state: 'parked', park: { question: 'which layout?', clears_when: un } } };
const items = deciderItems({ parked: [{ key: 'U-1', question: 'waiting on KAN-1086' }, { key: 'U-2', question: 'which layout?' }] }, { tickets });
const s = presort(items);
const prompt = deciderPrompt({ slug: 's', report: '', items: s.ask, rules: '', bin: '/b' });
const plain = deciderPrompt({ slug: 's', report: '', items: [], rules: '', bin: '/b' });
const rec = { items: s.ask };
const restated = { tickets: { 'U-1': { ...tickets['U-1'], park: { ...tickets['U-1'].park, clears_when: { kind: 'pr-merged', pr: 5 } } } } };
const none = { tickets: { 'U-1': { ...tickets['U-1'], park: { ...tickets['U-1'].park, clears_when: { kind: 'none' } } } } };
console.log([
  items[0].restate, items[0].clears, s.ask.map((i) => i.ticket).join(','), s.hand.map((h) => h.item.ticket).join(','), s.waits.length,
  prompt.includes('  - clears-when to restate: KAN-1086s fix PR is merged to main'), prompt.includes('/b/queue.mjs clears-when <TICKET> none'), plain.includes('to restate'),
  outcome(rec, { settled: {}, handed: {} }, restated).settled[0]?.did, outcome(rec, { settled: {}, handed: { [s.ask[0].id]: 'only a person' } }, none).handed[0]?.why,
  restateKeys(items).join(','), restateKeys(items, { tickets: { ...tickets, 'U-2': none.tickets['U-1'] } }).join(','),
].join('|'));
")
check "DS-563 AC3 the decider's item carries the line to restate, and no recorded condition" '[ "$(cut -d"|" -f1,2 <<< "$r")" = "KAN-1086s fix PR is merged to main|" ]'
check "DS-563 AC3 it goes to the decider session, not the digest or the waits; a lane C one is still handed on" '[ "$(cut -d"|" -f3,4,5 <<< "$r")" = "U-1|U-2|0" ]'
check "DS-563 AC3 the prompt asks it restated as a form, or recorded none; a prompt without one is unchanged" '[ "$(cut -d"|" -f6,7,8 <<< "$r")" = "true|true|false" ]'
check "DS-563 AC3 restated as a form: settled, waiting on it" '[ "$(cut -d"|" -f9 <<< "$r")" = "recorded clears-when \"PR #5 merged\", which a later pass checks" ]'
check "DS-563 AC3 recorded none: handed to the person" '[ "$(cut -d"|" -f10 <<< "$r")" = "only a person" ]'
check "DS-563 AC3 restateKeys names the tickets whose line is still to restate, against the queue as it stands" '[ "$(cut -d"|" -f11,12 <<< "$r")" = "U-1,U-2|U-1" ]'

# A park written `<path> exists`, with no `file`: read as the file where the path can only be one, and
# refused otherwise, saying to write `file <path> exists`, with the forms.
parked X-1 A "waiting on the export"
out=$(node "$B/queue.mjs" clears-when X-1 "docs/out.json exists" 2>&1); rc=$?
check "a park clearing on '<path> exists' is stored as that file existing" '[ $rc -eq 0 ] && [ "$(field X-1 park.clears_when)" = "{\"kind\":\"file-exists\",\"path\":\"docs/out.json\",\"root\":\"worktree\"}" ]'
out=$(node "$B/clears-when.mjs" --check '$DESK_STATE/approvals/X-2.json exists' 2>&1); rc=$?
check "so is a \$DESK_STATE path" '[ $rc -eq 0 ] && [ "$out" = "reads as: file \$DESK_STATE/approvals/X-2.json exists" ]'
out=$(node "$B/clears-when.mjs" --check 'fix/X-3 exists' 2>&1); rc=$?
check "a path that could be a branch is refused, saying to write the file form, and listing the forms" \
  '[ $rc -eq 1 ] && grep -q "\"fix/X-3 exists\" is not a form a pass reads (for a file, write \"file fix/X-3 exists\"). The forms:" <<< "$out" && grep -qx "  file <path> exists" <<< "$out"'
# DS-864: commit <sha> on <branch>, read in a fixture clone of a fixture origin, as pass.mjs reads it.
F="$T/ds864"; mkdir -p "$F"; git init -q --bare -b main "$F/origin.git"; git clone -q "$F/origin.git" "$F/c" 2>/dev/null
g(){ git -C "$F/c" "$@"; }
g commit -q --allow-empty -m init; g push -q origin main
g checkout -q -b fix/Y; g commit -q --allow-empty -m y1; g push -q origin fix/Y
landed=$(g rev-parse HEAD)
g commit -q --allow-empty -m fix; ahead=$(g rev-parse HEAD)   # the fix, one past origin/fix/Y
g checkout -q main; g commit -q --allow-empty -m main2; g push -q origin main
g checkout -q -b moved "$landed"; g merge -q --no-edit main; g push -q origin moved:fix/Y   # fix/Y moved by a merge that leaves the fix out
moved=$(g rev-parse --short=9 HEAD); g fetch -q origin
# cob <js expression>: prints it, with `git` (the fixture clone), `at(sha, branch)` (checkCond's answer) and
# commitOnBranch in scope.
cob(){ node --input-type=module -e "
import { execFileSync } from 'node:child_process';
import { checkCond, commitOnBranch } from '$B/clears-when.mjs';
const git = (args) => { try { return { ok: true, out: execFileSync('git', ['-C', '$F/c', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; } catch (e) { return { ok: false, code: e.status, out: String(e.stderr) }; } };
const read = { commitOn: (sha, branch) => commitOnBranch(git, sha, branch) };
const at = (sha, branch) => JSON.stringify(checkCond({ kind: 'commit-on', sha, branch }, read));
console.log($1);
"; }
r=$(cob "[at('${ahead:0:9}', 'fix/Y'), at('${landed:0:9}', 'fix/Y'), at('0123456789', 'fix/Y'),
  JSON.stringify(commitOnBranch(git, '${ahead:0:9}', 'main', { merges: true }))].join('|')")
check "DS-864 AC1 a commit its branch has moved past, by a merge that leaves it out, can never hold, naming the branch's new head" \
  '[ "$(cut -d"|" -f1 <<< "$r")" = "{\"holds\":false,\"never\":\"the branch origin/fix/Y has moved to $moved, which ${ahead:0:9} does not build on, so ${ahead:0:9} can no longer land there: the push it waits on is stale\"}" ]'
g push -q origin "$ahead:refs/heads/fix/Y" --force; g fetch -q origin
r2=$(cob "JSON.stringify(commitOnBranch(git, '${ahead:0:9}', 'fix/Y'))")
g push -q origin "$landed:refs/heads/fix/Y" --force; g fetch -q origin
r3=$(cob "JSON.stringify(commitOnBranch(git, '${ahead:0:9}', 'fix/Y'))")
r4=$(cob "at('${ahead:0:9}', 'gone/Z')")
check "DS-864 AC2 a commit its branch head is still an ancestor of waits as before" \
  '[ "$r3" = "{\"holds\":false,\"note\":\"${ahead:0:9} is not on origin/fix/Y yet\"}" ]'
check "DS-864 AC3 a commit on its branch holds as before" '[ "$r2" = "{\"holds\":true}" ] && [ "$(cut -d"|" -f2 <<< "$r")" = "{\"holds\":true}" ]'
check "DS-864 a branch origin does not have could not be checked, so the park is left as it is" '[[ "$r4" == "{\"error\":\"git rev-parse origin/gone/Z: "* ]]'
check "DS-864 a commit this clone lacks waits as before" '[ "$(cut -d"|" -f3 <<< "$r")" = "{\"holds\":false,\"note\":\"0123456789 is not on origin/fix/Y yet\"}" ]'
check "DS-864 the default branch or a batch base moving on is how a PR's commit arrives, so it waits as before" \
  '[ "$(cut -d"|" -f4 <<< "$r")" = "{\"holds\":false,\"note\":\"${ahead:0:9} is not on origin/main yet\"}" ]'

# Ask or take, where the worker contract sends a parking worker, gives every form with a line written in it, and each reads as its form.
contract="$S/../skills/desk-autopilot/references/ask-or-take.md"
rows=$(CW="$B/clears-when.mjs" node -e '
  import(process.env.CW).then(({ CLEARS_WHEN_EXAMPLES: ex, parseClearsWhen }) => {
    const bad = ex.filter(([, e]) => !parseClearsWhen(e).ok).map(([, e]) => e);
    console.log(JSON.stringify({ bad }));
    for (const [f, e] of ex) console.log("| `" + f + "` | `" + e + "` |");
  });')
check "each form's example reads" '[ "$(head -1 <<< "$rows")" = "{\"bad\":[]}" ]'
check "Ask or take carries each form beside its example" 'while IFS= read -r row; do grep -qxF "  $row" "$contract" || exit 1; done < <(tail -n +2 <<< "$rows")'
check "and the worker contract's core sends the worker to that table, and to --check" 'grep -qF "table of forms" "$S/../skills/desk-autopilot/references/autopilot-worker-contract.md" && grep -qF "shows, and run \`clears-when.mjs --check\` on it first." "$S/../skills/desk-autopilot/references/autopilot-worker-contract.md"'

echo "clears-when: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
