#!/usr/bin/env bash
# suite: merge driver: red checks, reruns and waivers (offline, fake gh)
# The real merge-driver.sh and gate.mjs, one loop at a time, set up by merge_driver_setup.sh: §4 Known
# flaky checks waived, a signed-out gh, why a red PR is not merged, §4 State checks never rerun, an
# approval check rerun once for an approval its run never saw, and a preview check's rerun waiting on
# its Vercel team's preview-build lease.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

# ---- DS-141: the written waiver for §4 Known flaky checks -----------------------------------------
q init merge-flaky
# A config that reruns, files tickets in Jira, and names `e2e` (and the required `test`) as flaky.
sed -e 's/| `ci-rerun` | Rerun CI | `yes` | `no` |/| `ci-rerun` | Rerun CI | `yes` | `yes` |/' -e 's/| Tracker | `none` |/| Tracker | `jira` |/' "$T/config.md" \
  | awk '{ print } /^\| `pr-ready`/ { print "| `jira-create` | File tickets | `yes` | `yes` |" }' > "$T/config-flaky.md"
cp "$T/config-flaky.md" "$T/config-bad.md"
echo '| Known flaky checks | `e2e: e2e/** playwright.config.ts` `test: src/**` `smoke: smoke/**` |' >> "$T/config-flaky.md"
echo '| Known flaky checks | `e2e: e2e/**` `lint` |' >> "$T/config-bad.md"
cat > "$T/stub/desk-jira" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$T/jira.log"; cp "\$4" "$T/jira-body.md"; echo "created DS-999  https://example.atlassian.net/browse/DS-999"
EOF
chmod +x "$T/stub/desk-jira"
SHA11=a111111111111111111111111111111111111111; SHA12=a222222222222222222222222222222222222222
SHA13=a333333333333333333333333333333333333333; SHA14=a444444444444444444444444444444444444444
SHA15=a555555555555555555555555555555555555555; SHA16=a666666666666666666666666666666666666666
SHA17=a777777777777777777777777777777777777777
cat > "$T/prs.json" <<EOF
{
  "111": { "head": "fix/T-11", "base": "main", "sha": "$SHA11", "state": "open", "draft": false, "files": ["src/x.ts"],
           "checks": [["test", "SUCCESS", 9001], ["e2e", "FAILURE", 9111]] },
  "112": { "head": "fix/T-12", "base": "main", "sha": "$SHA12", "state": "open", "draft": false, "files": ["src/y.ts", "e2e/login.spec.ts"],
           "checks": [["test", "SUCCESS", 9002], ["e2e", "FAILURE", 9112]] },
  "113": { "head": "fix/T-13", "base": "main", "sha": "$SHA13", "state": "open", "draft": false, "files": ["docs/readme.md"],
           "checks": [["test", "FAILURE", 9113], ["e2e", "SUCCESS", 9003]] },
  "114": { "head": "fix/T-14", "base": "main", "sha": "$SHA14", "state": "open", "draft": false, "files": ["src/z.ts"],
           "checks": [["test", "SUCCESS", 9004], ["lint", "FAILURE", 9114]] },
  "115": { "head": "fix/T-15", "base": "main", "sha": "$SHA15", "state": "open", "draft": false, "files": ["src/w.ts"],
           "checks": [["test", "SUCCESS", 9005], ["e2e", "FAILURE", 9115]] },
  "116": { "head": "fix/T-16", "base": "main", "sha": "$SHA16", "state": "open", "draft": false, "files": ["src/v.ts"],
           "checks": [["test", "SUCCESS", 9006], ["e2e", "FAILURE", 9116]] },
  "117": { "head": "fix/T-17", "base": "main", "sha": "$SHA17", "state": "open", "draft": false, "files": ["src/u.ts"],
           "checks": [["test", "SUCCESS", 9007], ["smoke", "FAILURE", 9117], ["e2e", "FAILURE", 9116]] }
}
EOF
for k in T-11 T-12 T-13 T-14 T-15 T-16 T-17; do q add "$k" Task A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
mkdir -p "$SD"
# The driver's two reruns already spent and accepted at these heads (12 minutes apart for real).
for f in reruns reruns-ok; do
  printf 'e2e\ne2e\n' > "$SD/$f-111-$SHA11"; printf 'e2e\ne2e\n' > "$SD/$f-112-$SHA12"
  printf 'test\ntest\n' > "$SD/$f-113-$SHA13"; printf 'lint\nlint\n' > "$SD/$f-114-$SHA14"
  printf 'e2e\n' > "$SD/$f-115-$SHA15"
done
printf 'e2e\n' > "$SD/reruns-116-$SHA16"   # one rerun tried and refused: none accepted
: > "$T/merges.log"
DESK_CONFIG="$T/config-flaky.md" loop
check "AC4: the driver starts with the flaky row read"                 '[ $rc -eq 0 ] && echo "$out" | grep -q "flaky=\[e2e,test,smoke\]"'
check "AC4: a waivable head is held a loop like a green one, not merged yet" '[ -z "$(merged)" ] && echo "$out" | grep -q "#111 green but for WAIVED \"e2e\" at a11111111 — confirming on the next loop"'
check "AC6: a diff touching the check'\''s paths is not waived, and says so" 'echo "$out" | grep -q "#112 the waiver for \"e2e\" does not apply: the diff touches e2e/login.spec.ts (e2e/\*\*, for \"e2e\")"'
check "AC7: a required check is never waived, and the PR is reported"   'echo "$out" | grep -q "#113 \"test\" is in §4 Known flaky checks but is a §4 Required check" && [ "$(qf T-13 .merge_blocked)" != null ]'
check "AC8: an unlisted red check waives nothing and reads red as today" 'echo "$out" | grep -q "#114 red at a44444444: \"lint\" failure" && ! echo "$out" | grep -q "#114.*waive"'
check "AC4: one rerun is not enough to waive"                          'echo "$out" | grep -q "#115 \"e2e\" is a known flaky check: waived only once still red after 2 accepted reruns at a55555555 (1 so far)"'
check "AC4: a refused rerun counts toward the cap but never toward the waiver" 'echo "$out" | grep -q "#116 \"e2e\" is a known flaky check: waived only once still red after 2 accepted reruns at a66666666 (0 so far)" && echo "$out" | grep -q "#116 rerun of 9116 refused" && [ "$(wc -l < "$SD/reruns-116-$SHA16" | tr -d " ")" = 2 ] && [ ! -e "$SD/reruns-ok-116-$SHA16" ]'
check "AC4: an accepted rerun counts toward the waiver"                '[ "$(wc -l < "$SD/reruns-ok-115-$SHA15" | tr -d " ")" = 2 ]'
check "AC4: an accepted run credits only its own checks, not one whose run was refused" '[ "$(cat "$SD/reruns-ok-117-$SHA17")" = smoke ] && [ "$(wc -l < "$SD/reruns-117-$SHA17" | tr -d " ")" = 2 ]'
DESK_CONFIG="$T/config-flaky.md" loop
check "AC4: the waived PR merges pinned to its head and logs WAIVED"   '[ "$(merged)" = 111 ] && grep -qx "111 main $SHA11" "$T/merges.log" && echo "$out" | grep -q "#111 WAIVED \"e2e\" at a11111111"'
check "AC5: a ticket is filed naming the check, PR, head SHA and failing run" 'grep -q "^create Bug Flaky check \"e2e\" waived to merge PR #111 " "$T/jira.log" && grep -q "\`e2e\`" "$T/jira-body.md" && grep -q "https://github.com/acme/widgets/pull/111" "$T/jira-body.md" && grep -q "$SHA11" "$T/jira-body.md" && grep -q "https://github.com/acme/widgets/actions/runs/9111" "$T/jira-body.md" && echo "$out" | grep -q "#111 WAIVED: filed DS-999"'
# A third loop reaches every other PR with #111 gone: none of them may merge.
DESK_CONFIG="$T/config-flaky.md" loop
check "AC4: two accepted reruns still wait out the last one's cooldown" 'echo "$out" | grep -q "#115 \"e2e\" is a known flaky check: waiting out the last rerun'\''s cooldown"'
check "AC6-8: nothing else merged once the others were all tried"      '[ "$(merged)" = 111 ] && echo "$out" | grep -q "#116 "'
# The same PR and head merging again (reopened) files no second ticket.
jq '."111".state = "open"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
DESK_CONFIG="$T/config-flaky.md" loop; DESK_CONFIG="$T/config-flaky.md" loop
check "AC5: the ticket is filed once per PR and head"                  '[ "$(merged)" = "111 111" ] && [ "$(wc -l < "$T/jira.log" | tr -d " ")" = 1 ]'

out=$(DESK_CONFIG="$T/config-bad.md" MERGE_DRIVER_ONE_LOOP=1 bash "$B/merge-driver.sh" --tickets "T-11" 2>&1); rc=$?
check "AC9: a row that does not parse stops the driver, naming the row" '[ $rc -eq 1 ] && echo "$out" | grep -q "FAIL: config §4 Known flaky checks does not parse: \`lint\`" && ! echo "$out" | grep -q "merge driver up"'

# ---- DS-225 AC2: gh signed out stops the driver, saying so -------------------------------------
: > "$FAKE_SLEEPS"; touch "$T/gh.signedout"
loop; rm -f "$T/gh.signedout"
check "DS-225 AC2: a signed-out gh is logged as signed out and the driver exits non-zero" '[ $rc -eq 1 ] && echo "$out" | grep -q "FAIL: gh is signed out (To get started with GitHub CLI, please run:  gh auth login)" && echo "$out" | tail -1 | grep -q "merge driver exited 1$"'
check "DS-225 AC2: the refused list is not read as empty, and the driver does not wait to retry" '! echo "$out" | grep -q "no ready batch PRs" && [ ! -s "$FAKE_SLEEPS" ]'
touch "$T/gh.broken"; loop; rm -f "$T/gh.broken"
check "DS-225 AC2: any other gh failure is retried as before" '! echo "$out" | grep -q "signed out" && echo "$out" | grep -q "could not list PRs" && [ $rc -eq 1 ]'

# The sections below run with Jira's tracker in the config: the fake desk-jira moves tickets.
stub_jira_close

# ---- DS-420: why the driver is not merging a red PR is recorded too: its review threads, or an approval --
SHA81=b811111111111111111111111111111111111111; SHA82=b822222222222222222222222222222222222222
SHA83=b833333333333333333333333333333333333333; SHA84=b844444444444444444444444444444444444444
cat > "$T/prs.json" <<EOF
{ "181": { "head": "fix/T-81", "base": "main", "sha": "$SHA81", "state": "open", "draft": false, "feedback": "NONE 1", "checks": [["test", "SUCCESS", 9081], ["build", "FAILURE", 9181]] },
  "182": { "head": "fix/T-82", "base": "main", "sha": "$SHA82", "state": "open", "draft": false, "feedback": "REVIEW_REQUIRED 0", "checks": [["test", "SUCCESS", 9082], ["build", "FAILURE", 9182]] },
  "183": { "head": "fix/T-83", "base": "main", "sha": "$SHA83", "state": "open", "draft": false, "feedback": "REVIEW_REQUIRED 0", "checks": [["test", "SUCCESS", 9083]] },
  "184": { "head": "fix/T-84", "base": "main", "sha": "$SHA84", "state": "open", "draft": false, "feedback": "REVIEW_REQUIRED 0", "checks": [["test", "FAILURE", 9084]] } }
EOF
q init merge-declines
for k in T-81 T-82 T-83 T-84; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; : > "$T/gh.log"
dloop(){ out=$(DESK_CONFIG="$T/config-flaky.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-81 T-82 T-83 T-84" 2>&1); rc=$?; }
dloop
check "DS-420 AC1: one refusal of a red PR for its thread is not yet recorded" '[ "$(qf T-81 .merge_blocked)" = null ] && echo "$out" | grep -q "#181 has outstanding review feedback (NONE, 1 unresolved)"'
dloop
check "DS-420 AC1: held a second loop, a red PR's thread is recorded as why, and it is not rerun" 'qf T-81 .merge_blocked | grep -q "^review feedback: 1 unresolved thread on a red PR, first " && ! grep -q "run rerun 9181" "$T/gh.log"'
check "DS-420 AC2: a red PR that needs an approving review is recorded for the person, and still rerun so its fix tries come" '[ "$(qf T-82 .merge_blocked)" = "approval: an approving review is required at b82222222: a person approves it before desk merges it" ] && grep -q "run rerun 9182" "$T/gh.log" && echo "$out" | grep -q "#182 at b82222222 needs an approving review (review decision REVIEW_REQUIRED) — not merging"'
check "DS-420 AC2: a red required check listed as flaky does not replace the approval request" '[ "$(qf T-84 .merge_blocked)" = "approval: an approving review is required at b84444444: a person approves it before desk merges it" ] && ! echo "$out" | grep -q "#184 \"test\" is in §4 Known flaky checks"'
check "DS-420 AC2: so is a green one, and it is not merged" '[ "$(qf T-83 .merge_blocked)" = "approval: an approving review is required at b83333333: a person approves it before desk merges it" ] && [ -z "$(merged)" ]'
jq '."182".feedback = "APPROVED 0" | ."183".feedback = "APPROVED 0"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
dloop
check "DS-420 AC2: once approved, the request is cleared: the red one reads red, the green one is confirmed" '[ "$(qf T-82 .merge_blocked)" = null ] && [ "$(qf T-83 .merge_blocked)" = null ] && echo "$out" | grep -q "#182 red at b82222222" && echo "$out" | grep -q "#183 green at b83333333 — confirming"'

# ---- DS-422: a red §4 State check reads the PR's state, so it is never rerun ------------------------
cp "$T/config-flaky.md" "$T/config-state.md"
echo '| State checks | `🌿 Local Adversarial Code Review: verdict` `🔐 Review gate: approval` `🏁 CI gate` |' >> "$T/config-state.md"
cp "$T/config-flaky.md" "$T/config-state-bad.md"
echo '| State checks | `🔐 Review gate: approve` |' >> "$T/config-state-bad.md"
SHA91=c911111111111111111111111111111111111111; SHA92=c922222222222222222222222222222222222222; SHA93=c933333333333333333333333333333333333333; SHA94=c944444444444444444444444444444444444444
cat > "$T/prs.json" <<EOF
{ "191": { "head": "fix/T-91", "base": "main", "sha": "$SHA91", "state": "open", "draft": false,
           "checks": [["test", "SUCCESS", 9090], ["🌿 Local Adversarial Code Review", "FAILURE", 9191], ["🔐 Review gate", "FAILURE", 9192], ["🏁 CI gate", "FAILURE", 9195]] },
  "192": { "head": "fix/T-92", "base": "main", "sha": "$SHA92", "state": "open", "draft": false,
           "checks": [["test", "SUCCESS", 9090], ["build", "FAILURE", 9193], ["🏁 CI gate", "FAILURE", 9194]] },
  "193": { "head": "fix/T-93", "base": "main", "sha": "$SHA93", "state": "open", "draft": false,
           "checks": [["test", "SUCCESS", 9090], ["build", "FAILURE", 9196, 96001], ["🌿 Local Adversarial Code Review", "FAILURE", 9196, 96002]] },
  "194": { "head": "fix/T-94", "base": "main", "sha": "$SHA94", "state": "open", "draft": false,
           "checks": [["test", "SUCCESS", 9090], ["build", "FAILURE", 9197, 97001], ["lint", "FAILURE", 9197, 97002], ["🌿 Local Adversarial Code Review", "FAILURE", 9197, 97003]] } }
EOF
cat > "$T/annotations.json" <<'EOF'
{ "9191": "The review at 135ce1536 is not in the current form: it claims cross-provider but its providers line does not say codex read the diff.",
  "9192": "Approval required — a feat(portal): title, and only fix, docs, chore merge without an approval." }
EOF
q init merge-state
for k in T-91 T-92 T-93 T-94; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; : > "$T/gh.log"
stloop(){ out=$(DESK_CONFIG="$T/config-state.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-91 T-92 T-93 T-94" 2>&1); rc=$?; }
stloop
check "DS-422: the driver starts with the state row read" '[ $rc -eq 0 ] && echo "$out" | grep -q "state=\[🌿 Local Adversarial Code Review,🔐 Review gate,🏁 CI gate\]"'
check "DS-422 AC1: red only on state checks, none is rerun" '! grep -q "run rerun 919[125]" "$T/gh.log" && [ ! -e "$SD/reruns-191-$SHA91" ]'
check "DS-422 AC1: each is logged with the gate and why" 'echo "$out" | grep -qF "#191 \"🌿 Local Adversarial Code Review\" failed (verdict state): The review at 135ce1536 is not in the current form" && echo "$out" | grep -qF "#191 \"🔐 Review gate\" failed (approval state): Approval required — a feat(portal): title" && echo "$out" | grep -qF "#191 \"🏁 CI gate\" failed (state) — a state check: a rerun reads the same PR state, so it is not rerun"'
check "DS-422 AC4: a red approval check puts the PR to the person, with no rerun and no cooldown" '[ "$(qf T-91 .merge_blocked)" = "approval: \"🔐 Review gate\" needs approval from a human reviewer at c91111111: a person approves it before desk merges it" ] && [ ! -e "$SD/cooldown-191" ] && ! echo "$out" | grep -q "#191 red, cooling down"'
check "DS-422 AC2: a red build beside a state check is rerun as today, and only it is counted" 'grep -q "run rerun 9193 --repo acme/widgets --failed" "$T/gh.log" && ! grep -q "run rerun 9194" "$T/gh.log" && [ "$(cat "$SD/reruns-192-$SHA92")" = build ] && [ -e "$SD/cooldown-192" ]'
check "DS-422 AC1: a red build sharing a run with a red state check is rerun by its job, not the run, so the state check is not" 'grep -q "run rerun --job 96001 --repo acme/widgets" "$T/gh.log" && ! grep -q "run rerun 9196" "$T/gh.log" && ! grep -q "96002 --repo" "$T/gh.log" && [ "$(cat "$SD/reruns-193-$SHA93")" = build ] && [ "$(cat "$SD/reruns-ok-193-$SHA93")" = build ]'
check "DS-422 AC2: two red checks sharing a run with a state check rerun the run, and the log says the state check goes with it" 'grep -q "run rerun 9197 --repo acme/widgets --failed" "$T/gh.log" && ! grep -q "run rerun --job 9700" "$T/gh.log" && echo "$out" | grep -qF "#194 \"🌿 Local Adversarial Code Review\" failed (verdict state) — a state check: a rerun reads the same PR state, so it is not rerun for itself, though rerunning run 9197 for the check beside it reruns it too"'
stloop
check "DS-422 AC1: a later loop reruns no state check either" '! grep -q "run rerun 919[12]" "$T/gh.log" && ! echo "$out" | grep -q "#191 red, cooling down"'
out=$(DESK_CONFIG="$T/config-state-bad.md" MERGE_DRIVER_ONE_LOOP=1 bash "$B/merge-driver.sh" --tickets "T-91" 2>&1); rc=$?
check "DS-422: a state row that does not parse stops the driver, naming the row" '[ $rc -eq 1 ] && echo "$out" | grep -qF "FAIL: config §4 State checks does not parse: \`🔐 Review gate: approve\`" && ! echo "$out" | grep -q "merge driver up"'

# ---- DS-561: a red approval check whose run started before the head's approval is rerun once -----
# Each red "🔐 Review gate" run started at RAN; an approval or clean verdict newer than RAN is one it never saw.
CLEAN_561='p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'
cp "$T/config-state.md" "$T/config-stale.md"; echo "| Clean review verdict | \`$CLEAN_561\` |" >> "$T/config-stale.md"
cp "$T/config-state.md" "$T/config-stale-plain.md"; echo '| Clean review verdict | `no findings` |' >> "$T/config-stale-plain.md"
SHA94=c944444444444444444444444444444444444444; SHA95=c955555555555555555555555555555555555555; SHA96=c966666666666666666666666666666666666666; SHA97=c977777777777777777777777777777777777777
SHA98=c988888888888888888888888888888888888888; SHA99=c999999999999999999999999999999999999999
RAN='2026-11-10T22:02:10Z'
# ap <n> <sha> <review>...: PR #n's GraphQL read, each review `<login>|<state>|<submittedAt>|<commit>[|verdict|plain]`.
ap(){
  node -e 'const [f, clean, ...rows] = process.argv.slice(1);
    const reviews = rows.map((x, i) => { const [login, state, at, oid, v] = x.split("|");
      return { id: "PRR_" + i, author: { login }, state, submittedAt: at, commit: { oid },
        body: v === "plain" ? "No findings. Nothing deferred or carried."
          : v ? ["<!-- desk-review:local -->", `<!-- desk-review:verdict v=1 sha=${oid} ${clean} vendor=codex round=1 -->`].join("\n") : "LGTM" }; });
    require("fs").writeFileSync(f, JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: null, reviews: { nodes: reviews }, reviewThreads: { nodes: [] } } } } }));' "$T/ap-$1.json" "$CLEAN_561" "${@:2}"
}
ap 195 "ben|APPROVED|2026-11-10T22:02:50Z|$SHA95"
ap 196 "ben|APPROVED|2026-11-10T22:01:30Z|$SHA96"
ap 197 "ben|COMMENTED|2026-11-10T22:02:50Z|$SHA97" "ben|APPROVED|2026-11-10T22:02:50Z|c900000000000000000000000000000000000000"
ap 198 "ben|APPROVED|2026-11-10T22:02:50Z|$SHA98"
ap 199 "tester|COMMENTED|2026-11-10T22:02:33Z|$SHA99|verdict"
ap 194 "tester|COMMENTED|2026-11-10T22:01:00Z|c900000000000000000000000000000000000000|verdict" "tester|COMMENTED|2026-11-10T22:02:33Z|$SHA94|plain"
gate_pr(){ printf '"%s": { "head": "fix/T-%s", "base": "main", "sha": "%s", "state": "open", "draft": false, "payload": "%s", "checks": [["test", "SUCCESS", 9090], ["%s", "FAILURE", %s, %s, "%s"]] }' "$1" "${1#1}" "$2" "$T/ap-$1.json" "$3" "$4" "$5" "$RAN"; }
printf '{ %s, %s, %s, %s, %s, %s }\n' "$(gate_pr 194 "$SHA94" '🔐 Review gate' 9241 94101)" "$(gate_pr 195 "$SHA95" '🔐 Review gate' 9251 95001)" "$(gate_pr 196 "$SHA96" '🔐 Review gate' 9261 96101)" \
  "$(gate_pr 197 "$SHA97" '🔐 Review gate' 9271 97101)" "$(gate_pr 198 "$SHA98" '🌿 Local Adversarial Code Review' 9281 98101)" \
  "$(gate_pr 199 "$SHA99" '🔐 Review gate' 9291 99101)" > "$T/prs.json"
echo '{ "95001": "No PullBot review at c95555555 yet" }' > "$T/annotations.json"
q init merge-stale
for k in T-94 T-95 T-96 T-97 T-98 T-99; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; : > "$T/gh.log"
saloop(){ out=$(DESK_CONFIG="$T/config-stale.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-95 T-96 T-97 T-98 T-99" 2>&1); rc=$?; }
saloop
check "DS-561 AC1: an APPROVED review of the head newer than the red approval check's run reruns that check's job once, and says why" 'grep -q "run rerun --job 95001 --repo acme/widgets" "$T/gh.log" && echo "$out" | grep -qF "#195 \"🔐 Review gate\" failed in a run started $RAN, before an APPROVED review by ben at c95555555 (2026-11-10T22:02:50Z): rerunning it once at this head" && [ "$(cat "$SD/approval-rerun-195-$SHA95")" = "🔐 Review gate" ]'
check "DS-561 AC1: it is not put to the person while that rerun runs" '[ "$(qf T-95 .merge_blocked)" = null ] && ! echo "$out" | grep -q "#195 at c95555555 waits on an approval"'
check "DS-561: a clean verdict at the head newer than the run reruns it too" 'grep -q "run rerun --job 99101 --repo acme/widgets" "$T/gh.log" && echo "$out" | grep -qF "#199 \"🔐 Review gate\" failed in a run started $RAN, before a clean review verdict at c99999999"'
check "DS-561 AC3: an approval older than the run reruns nothing, and waits on a person as today" '! grep -q "run rerun.*\(9261\|96101\)" "$T/gh.log" &&[ "$(qf T-96 .merge_blocked)" = "approval: \"🔐 Review gate\" needs approval from a human reviewer at c96666666: a person approves it before desk merges it" ]'
check "DS-561 AC3: no approval at the head (only a comment, and one approving another commit) reruns nothing" '! grep -q "run rerun.*\(9271\|97101\)" "$T/gh.log" &&[ "$(qf T-97 .merge_blocked)" = "approval: \"🔐 Review gate\" needs approval from a human reviewer at c97777777: a person approves it before desk merges it" ]'
check "DS-561 AC4: a red verdict check is not rerun for an approval, as DS-422 has it" '! grep -q "run rerun.*\(9281\|98101\)" "$T/gh.log" &&echo "$out" | grep -qF "#198 \"🌿 Local Adversarial Code Review\" failed (verdict state)" && [ ! -e "$SD/approval-rerun-198-$SHA98" ]'
: > "$T/gh.log"
saloop
check "DS-561 AC2: still red at that head after its rerun, it is not rerun again" '! grep -q "run rerun" "$T/gh.log" && echo "$out" | grep -qF "#195 \"🔐 Review gate\" was rerun once at c95555555 for the review its run started before, and is red again — not rerunning it a second time"'
check "DS-583 AC1: its line says no PullBot review is at the head, so it takes the verdict route, not a person's approval" '[ "$(qf T-95 .merge_blocked)" = null ] && ! echo "$out" | grep -q "#195 at c95555555 waits on an approval" && echo "$out" | grep -qF "#195 \"🔐 Review gate\" failed (verdict state): No PullBot review at c95555555 yet"'
check "DS-561 AC2: a check with no such line, red again after its rerun, waits on a person as today" '[ "$(qf T-99 .merge_blocked)" = "approval: \"🔐 Review gate\" needs approval from a human reviewer at c99999999: a person approves it before desk merges it" ]'
: > "$T/gh.log"
out=$(DESK_CONFIG="$T/config-stale-plain.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-94" 2>&1)
check "DS-561: under a plain-text clean row, a clean plain review at the head newer than the run reruns it, not an older marker review" 'grep -q "run rerun --job 94101 --repo acme/widgets" "$T/gh.log" && echo "$out" | grep -qF "#194 \"🔐 Review gate\" failed in a run started $RAN, before a clean review verdict at c94444444 (2026-11-10T22:02:33Z)"'

# ---- DS-583: a gate listed as approval that failed its verdict step takes the verdict route ---------
SHA583=d583000000000000000000000000000000000000; SHA584=d584000000000000000000000000000000000000
ap 1583 "agent-pullbot|COMMENTED|2026-11-10T22:02:40Z|$SHA583|verdict"
ap 1584 "tester|COMMENTED|2026-11-10T22:01:00Z|$SHA584"
printf '{ %s, %s }\n' "$(gate_pr 1583 "$SHA583" '🔐 Review gate' 9583 58301)" "$(gate_pr 1584 "$SHA584" '🔐 Review gate' 9584 58401)" > "$T/prs.json"
echo '{ "58301": "No PullBot review at d58300000 yet", "58401": "No PullBot review at d58400000 yet" }' > "$T/annotations.json"
q init merge-verdict-step
for k in T-583 T-584; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/gh.log"
vsloop(){ out=$(DESK_CONFIG="$T/config-stale.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-583 T-584" 2>&1); rc=$?; }
vsloop
check "DS-583 AC1: a ready PR red only on its verdict step records no approval note, and its log names the verdict step" '[ "$(qf T-584 .merge_blocked)" = null ] && ! echo "$out" | grep -q "#1584 at d58400000 waits on an approval" && echo "$out" | grep -qF "#1584 \"🔐 Review gate\" failed (verdict state): No PullBot review at d58400000 yet" && ! grep -q "run rerun.*\(9584\|58401\)" "$T/gh.log"'
check "DS-583 AC5: a clean verdict another account posted at the head after the run started reruns that check's job once" 'grep -q "run rerun --job 58301 --repo acme/widgets" "$T/gh.log" && echo "$out" | grep -qF "#1583 \"🔐 Review gate\" failed in a run started $RAN, before a clean review verdict at d58300000 (2026-11-10T22:02:40Z): rerunning it once at this head"'
: > "$T/gh.log"
vsloop
check "DS-583 AC6: red again after its one rerun at that head, it is not rerun a second time" '! grep -q "run rerun" "$T/gh.log" && echo "$out" | grep -qF "#1583 \"🔐 Review gate\" was rerun once at d58300000 for the review its run started before, and is red again — not rerunning it a second time" && [ "$(qf T-583 .merge_blocked)" = null ]'

# ---- DS-912: a preview check's rerun takes a unit of its Vercel team's preview-build lease first ----
cp "$T/config-flaky.md" "$T/config-vercel.md"; echo '| Vercel | `acme` `web: prj_1` |' >> "$T/config-vercel.md"
machine(){ printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `preview-build=on` | test |\n| `preview-build-slots` | `%s` | test |\n' "$2" > "$1"; }
machine "$T/machine-one.md" 1; machine "$T/machine-two.md" 2
LD="$T/leases"
hold(){ DESK_LEASE_DIR="$LD" DESK_MACHINE="$1" node "$B/leases.mjs" acquire preview-build acme --ttl 1200 --no-owner --label "$2" >/dev/null 2>&1; }
leases(){ DESK_LEASE_DIR="$LD" node "$B/leases.mjs" list --json 2>/dev/null | jq -r '"\(.label) \(.owner)"' | paste -sd',' -; }
SHA912=e912000000000000000000000000000000000000; SHA913=e913000000000000000000000000000000000000; SHA914=e914000000000000000000000000000000000000
SHA915=e915000000000000000000000000000000000000
cat > "$T/prs.json" <<EOF
{ "1912": { "head": "fix/T-912", "base": "main", "sha": "$SHA912", "state": "open", "draft": false, "checks": [["test", "SUCCESS", 9090], ["Vercel Preview", "FAILURE", 9912]] },
  "1913": { "head": "fix/T-913", "base": "main", "sha": "$SHA913", "state": "open", "draft": false, "checks": [["test", "SUCCESS", 9090], ["build", "FAILURE", 9913]] },
  "1914": { "head": "fix/T-914", "base": "main", "sha": "$SHA914", "state": "open", "draft": false, "checks": [["test", "SUCCESS", 9090], ["deploy-preview", "FAILURE", 9914]] },
  "1915": { "head": "fix/T-915", "base": "main", "sha": "$SHA915", "state": "open", "draft": false, "checks": [["test", "SUCCESS", 9090], ["Vercel", "FAILURE"], ["build", "FAILURE", 9915]] } }
EOF
q init merge-preview
for k in T-912 T-913 T-914 T-915; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; : > "$T/gh.log"
pvloop(){ out=$(DESK_CONFIG="$T/config-vercel.md" DESK_MACHINE="$1" DESK_LEASE_DIR="$LD" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$2" 2>&1); rc=$?; }
hold "$T/machine-one.md" "acme/site#7"
pvloop "$T/machine-one.md" "T-912 T-913 T-915"
check "DS-912 AC3: with the team's one unit held, a preview check is not rerun, and the log says it waits on the preview build" '! grep -q "run rerun 9912" "$T/gh.log" && echo "$out" | grep -qF "#1912 red + completed, but waits on the preview build for acme before rerunning: the preview-build slot for acme is held by acme/site#7 (no owner" && [ ! -e "$SD/reruns-1912-$SHA912" ] && [ ! -e "$SD/cooldown-1912" ]'
check "DS-912 AC3: a red check that is no preview is rerun as before" 'grep -q "run rerun 9913 --repo acme/widgets --failed" "$T/gh.log" && [ "$(leases)" = "acme/site#7 null" ]'
check "DS-912 AC3: a red Vercel status with no run is not rerun, so the build beside it reruns without the lease" 'grep -q "run rerun 9915 --repo acme/widgets --failed" "$T/gh.log" && ! echo "$out" | grep -q "#1915 .*waits on the preview build"'
rm -rf "$LD"
pvloop "$T/machine-one.md" "T-912"
check "DS-912 AC3: once a unit is free the rerun takes it, labelled with the PR, and runs" 'grep -q "run rerun 9912 --repo acme/widgets --failed" "$T/gh.log" && [ "$(leases)" = "acme/widgets#1912 null" ]'
rm -rf "$LD"; hold "$T/machine-two.md" "acme/site#7"; hold "$T/machine-two.md" "acme/docs#8"
pvloop "$T/machine-two.md" "T-914"
check "DS-912 AC5: with preview-build-slots 2 and both held, the third build waits" '! grep -q "run rerun 9914" "$T/gh.log" && echo "$out" | grep -qF "#1914 red + completed, but waits on the preview build for acme before rerunning: all 2 preview-build slots for acme are held"'
rm -rf "$LD"; : > "$T/gh.log"
pvloop "$T/machine-two.md" "T-914"
check "DS-912 AC5: and runs once a unit is free" 'grep -q "run rerun 9914 --repo acme/widgets --failed" "$T/gh.log" && [ "$(leases)" = "acme/widgets#1914 null" ]'

finish reruns
