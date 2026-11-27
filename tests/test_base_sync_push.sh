#!/usr/bin/env bash
# suite: base sync: logins, the push row, pre-push hooks, worktrees and baselines
# layer: L3
# The base sync, set up by base_sync_setup.sh: a base worker held on its login's limit, the §3
# batch-base-push row, a refused or raced push, the repo's pre-push hook and env files, a base held in
# another checkout, and the baseline checks taken at the synced base.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=base_sync_setup.sh
. "$S/base_sync_setup.sh"

# DS-620: a base worker try (an epic PR review) whose session exited at its login's limit waits for
# that limit, with another login with room, and then resumes its own session there as the same try: it
# never starts on another login. A conflict fix try no longer does (DS-1057): it ends instead. logins <names>: the subscriptions file lists each (`default` is ~/.claude, `b` is
# ~/.claude-logins/b), the first the default and the rest unused. A folder listed in $LIM, as `<folder> <reset>`, is at its
# limit: its preflight and its probe are refused. The spawn line records the login it was given.
LB="$HOME/.claude-logins/b"; LD="$HOME/.claude"; LIM="$T/limited"
mkdir -p "$LD" "$T/usage"
export DESK_USAGE_DIR="$T/usage"
# Only the listed logins' folders exist: a folder under ~/.claude-logins is a login whether listed or not.
logins(){
  rm -rf "$HOME/.claude-logins"
  printf '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n' > "$T/subs.md"
  use=default
  # The table holds a literal ~ as a user's does, for the reader to expand.
  # shellcheck disable=SC2088
  for n in "$@"; do [ "$n" = default ] || mkdir -p "$HOME/.claude-logins/$n"; printf '| `claude` | `%s` | `%s` | `%s` |\n' "$n" "$([ "$n" = default ] && echo '~/.claude' || echo "~/.claude-logins/$n")" "$use" >> "$T/subs.md"; use=unused; done
  export DESK_SUBSCRIPTIONS="$T/subs.md"
}
cat > "$T/stub/claude" <<EOF
#!/bin/sh
d="\${CLAUDE_CONFIG_DIR:-$LD}"
case "\$1" in
  auth) printf '{"loggedIn":true,"email":"%s@example.com"}\n' "\$(basename "\$d")" ;;
  -p) r=\$(grep -F "\$d " "$LIM" 2>/dev/null | head -n 1 | cut -d' ' -f2)
    if [ -n "\$r" ]; then printf '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":%s}}\n' "\$r"; echo '{"type":"result","is_error":true}'; exit 1; fi
    echo '{"type":"result","is_error":false}' ;;
  *) cat "$T/agents.json" 2>/dev/null || echo "[]" ;;
esac
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
ld="\${AUTOPILOT_LOGIN_DIR:-$LD}"
if [ "\$3" = preflight ]; then if grep -qF "\$ld " "$LIM" 2>/dev/null; then echo "[preflight] usage-limit: the account is at its usage limit"; else echo "[preflight] pass"; fi
else echo "\$1 \$2 login=\${AUTOPILOT_LOGIN_DIR-unset} \${AUTOPILOT_TASK:-}\${AUTOPILOT_RESUME:+RESUME session=\$3}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF
# A try of each kind, as base_fix records it, running as session sid-old.
TRY_conflict='{"try":1,"head":"abc","source":"def","files":["a.txt"],"at":"2026-11-09T00:00:00Z","session":"sid-old"}'
TRY_review='{"kind":"review","try":1,"head":"abc","pr":300,"at":"2026-11-09T00:00:00Z","session":"sid-old"}'
# stopped <case> <kind> [login folder]: the try's session, on login b unless given, exited at that
# login's 5-hour limit, an hour off, in the base worktree on feat/x.
stopped(){
  : > "$T/spawns"; rm -f "$T/agents.json"; fresh "$1"; feature; fixrow yes
  git -C "$C/repo" fetch -q origin; git -C "$C/repo" worktree add -q --track -b feat/x "$C/wt/base-feat-x" origin/feat/x
  local try="TRY_$2"
  node "$B/queue.mjs" set-batch "base_fix={\"tries\":[${!try}],\"running\":\"sid-old\",\"port\":3510}" >/dev/null
  mkdir -p "$C/state/logs" "$C/state/workers"
  local on=${3:-$LB}
  [ "$on" = "$LD" ] || printf '{"login":"b","config_dir":"%s"}\n' "$on" > "$C/state/workers/base-feat-x.login.json"
  limit_event "$(( $(date +%s) + 3600 ))"; age_log
  echo "$on $(( $(date +%s) + 3600 ))" > "$LIM"
}
# DS-1057: a conflict fix try no longer waits on its own login while new work starts on another: its
# try ends, spending none, and the base syncs (or a new try starts) on the login new work starts on.
logins default b; stopped m1conflict conflict; pass
check "DS-1057 a conflict try gone at b's limit, the default with room, ends rather than waiting on b" \
  '[ "$(jq -r .base_fix.running "$DESK_QUEUE")" = null ] && [[ "$out" == *"try 1 of 2 on feat/x exited at the 5-hour usage limit until "*" on login b, which new work has moved off, so it ends and a new try starts on login default; it spends no try"* ]] && [[ "$out" == *"base sync: merged 2 commit(s) from main into feat/x and pushed"* ]] && [[ "$out" != *"base-feat-x on the 5-hour usage limit until "* ]] && ! grep -q "RESUME session=sid-old" "$T/spawns"'
for kind in review; do
  # AC10: login b at its limit, the default login with room. The try waits on b, then resumes there.
  logins default b; stopped "m1$kind" "$kind"; pass
  check "DS-620 AC10 $kind: it waits on its own login, with no session started on another" \
    '[ ! -s "$T/spawns" ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = sid-old ] && [ "$(jq -r ".base_fix.tries[0].outcome" "$DESK_QUEUE")" = null ] && [[ "$out" == *"base-feat-x on the 5-hour usage limit until "* ]]'
  : > "$LIM"; limit_event "$(( $(date +%s) - 60 ))"; age_log; pass
  check "DS-620 AC10 $kind: once b's limit lifts it resumes its own session there, as the same try" \
    'grep -q "^base-feat-x $C/wt/base-feat-x login=$LB .*RESUME session=sid-old" "$T/spawns" && [ "$(grep -c "^base-feat-x " "$T/spawns")" = 1 ] && [ "$(jq -r ".base_fix.tries | length" "$DESK_QUEUE")" = 1 ]'
done
for kind in conflict review; do
  # One login: it is held and resumed exactly as before.
  logins default; stopped "m5$kind" "$kind" "$LD"; pass
  check "DS-620 $kind: one login: it waits" \
    '[ ! -s "$T/spawns" ] && [ "$(jq -r .base_fix.running "$DESK_QUEUE")" = sid-old ] && [[ "$out" == *"base-feat-x on the 5-hour usage limit until "* ]]'
  : > "$LIM"; limit_event "$(( $(date +%s) - 60 ))"; age_log; pass
  check "DS-620 $kind: one login: once the limit lifts it resumes its own session" 'grep -q "^base-feat-x .* login=unset .*RESUME session=sid-old" "$T/spawns"'
done
# DS-620: outside feature mode too, a base worker paused at the repo's login's limit holds every spawn,
# with no ticket preflighted, and the hold is recorded with its reset; on another login it holds nothing.
logins default; stopped m7 conflict "$LD"; node "$B/queue.mjs" set-batch feature=false >/dev/null; rm -f "$C/state/feature.json"; pass
check "DS-620 a base worker paused on the repo's login holds the batch, with the hold recorded" \
  '[ "$(grep -c "^T-1 " "$T/spawns")" = 0 ] && [ "$(jq -r ".tickets[\"T-1\"].state" "$DESK_QUEUE")" = triaged ] && [ "$(jq -r .usage_hold.preflight "$DESK_QUEUE")" = null ] && [ "$(jq -r .usage_hold.resets_at "$DESK_QUEUE")" != null ]'
logins default b; stopped m8 conflict; node "$B/queue.mjs" set-batch feature=false >/dev/null; rm -f "$C/state/feature.json"; pass
check "DS-620 a base worker paused on a login that is not the repo's holds nothing else" \
  '[ "$(grep -c "^T-1 " "$T/spawns")" = 1 ] && [ "$(jq -r .usage_hold "$DESK_QUEUE")" = null ] && [[ "$out" == *"which new work has moved off"* ]]'
unset DESK_SUBSCRIPTIONS; rm -f "$LIM"; probe_off
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1 \$2 \${AUTOPILOT_BRANCH:-} \${AUTOPILOT_TASK:-}\${AUTOPILOT_RESUME:+RESUME session=\$3 \$AUTOPILOT_RESUME}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF

# An ordinary batch plan-batch seeded while feature.json still names the epic and a spine (here §4
# Acceptance specs is unset, so feature mode is off): a failed sync holds no spawns.
fresh planned; conflict; node "$B/queue.mjs" set-batch epic=E-1 >/dev/null; node "$B/queue.mjs" drop T-1 >/dev/null
echo '{"epic":"E-1","spine":"T-1"}' > "$C/state/feature.json"; mkdir -p "$C/state/triage"
echo '{"ticket":"T-1","type":"Task","lane":"A","branch":"feat/T-1","files_in_scope":["b.txt"],"unknowns":[],"links":"n/a"}' > "$C/state/triage/T-1.json"
printf '\n## 1. Identity\n| Field | Value |\n|---|---|\n| GitHub handle | `me` |\n| Jira display name | `Me` |\n' >> "$C/config.md"
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" T-1 2>&1)
check "plan-batch records an ordinary batch on the queue" '[ "$(jq -r .feature "$DESK_QUEUE")" = false ] && [ "$(jq -r ".tickets[\"T-1\"].state" "$DESK_QUEUE")" = triaged ]'
pass
check "feature.json naming a spine does not hold its spawns" '[[ "$out" == *"spawned: T-1"* ]] && [[ "$out" == *"spawning carries on"* ]]'

# AC6, AC7: a push refused by branch protection rolls back, and holds spawns only in feature mode.
fresh refused; printf '#!/bin/sh\necho "error: GH006: Protected branch update failed for refs/heads/feat/x." >&2\nexit 1\n' > "$C/origin.git/hooks/pre-receive"
chmod +x "$C/origin.git/hooks/pre-receive"; tip=$(origin_tip); pass
check "a refused push leaves origin alone"           '[ "$(origin_tip)" = "$tip" ]'
check "and names the reason"                         '[[ "$out" == *"the push to feat/x was refused"* ]] && [[ "$out" == *"GH006"* ]]'
check "and rolls the merge back locally"             "[ \"\$(git -C $BWT rev-parse HEAD)\" = \"$tip\" ]"
check "not feature mode: a refused push still spawns" '[[ "$out" == *"spawned: T-1"* ]]'
node "$B/queue.mjs" set T-1 state=triaged >/dev/null; feature; pass
check "feature mode: a refused push spawns nothing"  '[[ "$out" != *"spawned:"* ]] && [[ "$out" == *"refused"* ]]'

# AC6, AC7: the permission row.
fresh denied no; feature; tip=$(origin_tip); pass
check "batch-base-push no: nothing pushed"           '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"config §3 batch-base-push is \"no\""* ]]'
check "feature mode: the row refusing spawns nothing" '[[ "$out" != *"spawned:"* ]]'
fresh askit unset; tip=$(origin_tip); pass
check "unset reads as ask, and asks for the approval" '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"is \"ask\""* ]] && [[ "$out" == *"AUTOPILOT_BASE_PUSH_APPROVED=1"* ]]'
check "not feature mode: the row refusing still spawns" '[[ "$out" == *"spawned: T-1"* ]]'
fresh approved ask; out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" 2>&1)
check "ask with the approval syncs"                  'origin_has_main && [[ "$out" == *"merged 2 commit(s)"* ]]'
fresh typo nope; tip=$(origin_tip); out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" 2>&1)
check "a value the row cannot read is no, not ask"   '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"batch-base-push is \"no\""* ]]'

# A supervised batch under ask is asked once on the queue (needs-you's base-push item), never
# listed as waiting, so no decider is handed it each pass. Its approval syncs this and every later pass.
spass(){ out=$(node "$B/pass.mjs" --json --by supervisor 2>/dev/null); }
waits_base(){ jq -e '[.waiting[] | select(test("base sync"))] | length > 0' <<<"$out" >/dev/null; }
fresh supask ask; feature; tip=$(origin_tip); spass; since=$(jq -r .base_push_ask.since "$DESK_QUEUE")
check "DS-403 AC1 a supervised pass under ask records one ask on the queue" '[ "$(origin_tip)" = "$tip" ] && [ "$(jq -r .base_push_ask.base "$DESK_QUEUE")" = feat/x ] && [ "$(jq -r .base_push_ask.source "$DESK_QUEUE")" = main ]'
check "DS-403 AC1 nothing waits on you for it, and the report says where it is asked" '! waits_base && [[ "$(jq -r .message <<<"$out")" == *"asked once for the batch in /desk-needs-you"* ]]'
check "DS-403 AC1 feature mode still spawns nothing on it"  '[[ "$(jq -r .message <<<"$out")" != *"spawned:"* ]]'
spass
check "DS-403 AC1 the next pass keeps the same ask"   '[ "$(jq -r .base_push_ask.since "$DESK_QUEUE")" = "$since" ] && ! waits_base && [ "$(origin_tip)" = "$tip" ]'
node "$B/queue.mjs" set-batch "gate={\"state\":\"failed\",\"sha\":\"$tip\",\"failures\":[\"feat/x is behind main, so it was not synced\"]}" >/dev/null
spass
check "DS-403 AC1 a failed base gate waits on the ask, not in the waiting list" \
  '[[ "$(jq -r .message <<<"$out")" == *"BASE GATE: waits on the base sync, asked once for the batch in /desk-needs-you"* ]] && [ "$(jq "[.waiting[] | select(startswith(\"BASE GATE\"))] | length" <<<"$out")" = 0 ]'
node "$B/queue.mjs" set-batch gate=null >/dev/null
node "$B/queue.mjs" set-batch approved.base_push=true >/dev/null
out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" --json --by supervisor 2>/dev/null)
check "DS-403 AC2 approved, the next pass merges main in" 'origin_has_main && [[ "$(jq -r .message <<<"$out")" == *"merged 2 commit(s)"* ]]'
check "DS-403 AC2 the approval stays on the queue and the ask is cleared" '[ "$(jq -r .approved.base_push "$DESK_QUEUE")" = true ] && [ "$(jq -r .base_push_ask "$DESK_QUEUE")" = null ]'
git -C "$C/repo" commit -q --allow-empty -m three; git -C "$C/repo" push -q origin main
node "$B/queue.mjs" set T-1 state=triaged >/dev/null
out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" --json --by supervisor 2>/dev/null)
check "DS-403 AC3 behind again, it syncs with no new ask" 'origin_has_main && [[ "$(jq -r .message <<<"$out")" == *"merged 1 commit(s)"* ]] && [ "$(jq -r .base_push_ask "$DESK_QUEUE")" = null ]'
fresh supno no; feature; tip=$(origin_tip); spass
check "DS-403 AC4 batch-base-push no: nothing synced and no ask raised" '[ "$(origin_tip)" = "$tip" ] && [ "$(jq -r .base_push_ask "$DESK_QUEUE")" = null ] && waits_base'
fresh sesask ask; tip=$(origin_tip); out=$(node "$B/pass.mjs" --json 2>/dev/null)
check "DS-403 a session's pass under ask still waits on its session, with no queue ask" '[ "$(jq -r .base_push_ask "$DESK_QUEUE")" = null ] && waits_base'

# A production base written into the queue by hand is refused on read, before anything is pushed.
fresh prod; git -C "$C/repo" push -q origin origin/feat/x:refs/heads/production
tip=$(git -C "$C/origin.git" rev-parse production)
node -e 'const f = process.argv[1]; const q = JSON.parse(require("fs").readFileSync(f, "utf8")); q.base = "production"; require("fs").writeFileSync(f, JSON.stringify(q))' "$DESK_QUEUE"
pass
check "a production base in the queue is refused"    '[ $rc -eq 11 ] && [[ "$out" == *"is a production branch"* ]] && [ "$(git -C "$C/origin.git" rev-parse production)" = "$tip" ] && [ ! -e "$C/wt/base-production" ]'

# desk-skills#837: the repo's own pre-push hook does not run on a base sync. The base worktree has no
# installed deps, so a hook that runs the repo's checks could only fail there.
# hook <output>: the repo's pre-push hook prints <output>, notes that it ran, and refuses the push.
hook(){
  mkdir -p "$C/hooks"
  { echo '#!/bin/sh'; echo "touch '$C/hook.ran'"; echo "cat >&2 <<'OUT'"; printf '%s\n' "$1"; echo 'OUT'; echo 'exit 1'; } > "$C/hooks/pre-push"
  chmod +x "$C/hooks/pre-push"; git -C "$C/repo" config core.hooksPath "$C/hooks"
}
# own_commit: the base gets content of its own on origin, as a merged child PR gives it.
own_commit(){ git clone -q "$C/origin.git" "$C/own"; git -C "$C/own" switch -q feat/x; echo own > "$C/own/b.txt"; git -C "$C/own" add b.txt; git -C "$C/own" commit -q -m own; git -C "$C/own" push -q origin feat/x; }
NO_DEPS=$'pre-push: FAIL  pnpm format:check (1s, exit 1)\n WARN   Local package.json exists, but node_modules missing, did you mean to install?\nsh: turbo: command not found\npre-push: push stopped.'
fresh hooked; hook "$NO_DEPS"; pass
check "#837 DS-803 AC1 a base with nothing of its own is synced without running the hook, to main's content" \
  'origin_has_main && [ ! -e "$C/hook.ran" ] && git -C "$C/origin.git" diff --quiet main feat/x && [[ "$out" != *"was refused"* ]] && [[ "$out" != *"turbo"* ]]'
# With content of its own, the hook runs, and a real failing check refuses the push.
fresh hookfmt; own_commit; hook $'pre-push: ok    pnpm lint (1s)\npre-push: FAIL  pnpm format:check (1s, exit 1)\n[warn] b.txt\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.\npre-push: push stopped.'
tip=$(origin_tip); pass
check "DS-803 AC3 a base with its own content runs the hook, and a failing check refuses the sync" \
  '[ -e "$C/hook.ran" ] && [ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"the push to feat/x was refused: pre-push: FAIL  pnpm format:check"* ]] && [[ "$out" != *"environment failure"* ]]'
# pnpm warns of missing packages before every script there, so the warning beside a check that ran
# and failed is still a failing check, and still refuses the push.
fresh hookwarn; own_commit; hook $'pre-push: FAIL  pnpm format:check (1s, exit 1)\n WARN   Local package.json exists, but node_modules missing, did you mean to install?\n[warn] b.txt\n[warn] Code style issues found in the above file.\npre-push: push stopped.'
tip=$(origin_tip); pass
check "DS-803 AC3 pnpm's missing-packages warning beside a failing check still refuses the sync" \
  '[ -e "$C/hook.ran" ] && [ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"the push to feat/x was refused: pre-push: FAIL  pnpm format:check"* ]] && [[ "$out" != *"environment failure"* ]]'
# A hook that could not run its checks there is said as an environment failure, and the
# sync pushes without it.
fresh hookenv; own_commit; hook "$NO_DEPS"; pass
check "DS-803 AC2 a hook missing its tool is an environment failure naming it, and the sync still pushes" \
  '[ -e "$C/hook.ran" ] && origin_has_main && git -C "$C/origin.git" cat-file -e feat/x:b.txt && [[ "$out" == *"could not run its checks in the base worktree (\`turbo\` (command not found), an environment failure"* ]] && [[ "$out" != *"was refused"* ]]'

# DS-808: a pre-push hook that reads a §4 Env files variable. envhook <case> [env rows]: a base with content
# of its own, .env ignored by git and present in the primary checkout, and a hook that fails as a shell's
# `set -u` does unless .env sets NEEDS_ME.
envhook(){
  fresh "$1"; own_commit
  [ -z "${2:-}" ] || printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Env files | `.env` |\n| Database URL variable | `DATABASE_URL` |\n' >> "$C/config.md"
  echo .env >> "$C/repo/.git/info/exclude"
  printf 'NEEDS_ME=yes\nDATABASE_URL=postgres://u:p@localhost:5432/dev\n' > "$C/repo/.env"
  mkdir -p "$C/hooks"
  cat > "$C/hooks/pre-push" <<EOF
#!/bin/sh
touch '$C/hook.ran'
[ -f .env ] && . ./.env
if [ -z "\${NEEDS_ME:-}" ]; then echo 'pre-push: FAIL  sh check.sh (0s, exit 1)' >&2; echo 'check.sh: line 1: NEEDS_ME: unbound variable' >&2; exit 1; fi
touch '$C/hook.passed'
EOF
  chmod +x "$C/hooks/pre-push"; git -C "$C/repo" config core.hooksPath "$C/hooks"
}
envhook envcopy rows; pass
check "DS-808 AC1 the base worktree is made holding the env files a worker's gets" \
  "[ \"\$(grep NEEDS_ME $BWT/.env)\" = NEEDS_ME=yes ] && [[ \"\$out\" == *\"§4 Env files copied in (.env)\"* ]]"
check "DS-808 AC1 with its database variable blanked, as a worker with no database of its own has it" "[ \"\$(grep DATABASE_URL $BWT/.env)\" = DATABASE_URL= ]"
check "DS-808 AC1 and the base worktree still reads as clean" "[ -z \"\$(git -C $BWT status --porcelain)\" ]"
check "DS-808 AC2 the pre-push hook passes and the merge reaches origin" \
  '[ -e "$C/hook.passed" ] && origin_has_main && git -C "$C/origin.git" cat-file -e feat/x:b.txt && [[ "$out" == *"merged 2 commit(s) from main into feat/x and pushed"* ]] && [[ "$out" != *"environment failure"* ]]'
envhook envmissing; pass
check "DS-808 AC3 without the env file, the missing variable is an environment failure naming it, and the sync still pushes" \
  '[ -e "$C/hook.ran" ] && [ ! -e "$C/hook.passed" ] && origin_has_main && [[ "$out" == *"could not run its checks in the base worktree (\`NEEDS_ME\` (environment variable not set), an environment failure"* ]]'
# A hook that needs the database variable the base worktree's copy blanks, failing in Prisma's words for it.
envhook envdb rows
cat > "$C/hooks/pre-push" <<EOF
#!/bin/sh
touch '$C/hook.ran'
[ -f .env ] && . ./.env
if [ -z "\${DATABASE_URL:-}" ]; then echo 'pre-push: FAIL  pnpm prisma validate (1s, exit 1)' >&2; echo 'Error validating datasource \`db\`: You must provide a nonempty URL. The environment variable \`DATABASE_URL\` resolved to an empty string.' >&2; exit 1; fi
touch '$C/hook.passed'
EOF
pass
check "DS-808 AC2 a hook that needs the blanked database variable is an environment failure naming it, and the merge still reaches origin" \
  '[ -e "$C/hook.ran" ] && [ ! -e "$C/hook.passed" ] && origin_has_main && git -C "$C/origin.git" cat-file -e feat/x:b.txt && [[ "$out" == *"(\`DATABASE_URL\` (environment variable not set), an environment failure"* ]]'
# DS-808 AC4: a refused push while the base lags too far to spawn is recorded for needs-you.
fresh stuck; own_commit; hook $'pre-push: FAIL  make check (1s, exit 1)\nb.txt: bad\npre-push: push stopped.'
tip=$(origin_tip); AUTOPILOT_BASE_BEHIND_MAX=0 pass
check "DS-808 AC4 a refused push past the lag freezes spawns and is recorded with its base, frozen count and command" \
  '[ "$(origin_tip)" = "$tip" ] && [[ "$out" != *"spawned: T-1"* ]] && [ "$(jq -r "[.base_sync_stuck.base, .base_sync_stuck.frozen] | join(\" \")" "$DESK_QUEUE")" = "feat/x 1" ] && [[ "$(jq -r .base_sync_stuck.cmd "$DESK_QUEUE")" == *"push origin HEAD:refs/heads/feat/x || "*" reset -q --hard origin/feat/x" ]]'
bash -c "$(jq -r .base_sync_stuck.cmd "$DESK_QUEUE")" >/dev/null 2>&1; AUTOPILOT_BASE_BEHIND_MAX=0 pass
check "DS-808 AC4 its command rolls the merge back when the push is refused again, so the next pass keeps the item" \
  '[ "$(git -C "$C/wt/base-feat-x" rev-parse HEAD)" = "$(origin_tip)" ] && [ "$(jq -r .base_sync_stuck.base "$DESK_QUEUE")" = feat/x ]'
rm -f "$C/hooks/pre-push"; pass
check "DS-808 AC4 the next pass that pushes clears it" 'origin_has_main && [ "$(jq -r .base_sync_stuck "$DESK_QUEUE")" = null ]'

# AC5: a push refused as non-fast-forward is fetched, merged again and retried once.
fresh race; git clone -q "$C/origin.git" "$C/other"; git -C "$C/other" switch -q feat/x; echo "$C/other" > "$T/race.arm"; pass
check "a non-fast-forward push is retried and lands" 'origin_has_main && git -C "$C/origin.git" log --format=%s feat/x | grep -qx "merged by the driver"'
check "the report says it retried"                   '[[ "$out" == *"fetched, merged again, retried once"* ]] && [[ "$out" == *"spawned: T-1"* ]]'

# DS-594 AC3: a primary checkout on the base gets a detached base worktree and a sync, and is left as it was.
fresh primary; git -C "$C/repo" switch -q feat/x; echo mine > "$C/repo/local.txt"; head=$(git -C "$C/repo" rev-parse HEAD); pass
check "DS-594 AC3 primary on the base: a detached base worktree is made" "[ -d $BWT ] && ! git -C $BWT symbolic-ref -q HEAD"
check "DS-594 AC3 and the base is synced"             'origin_has_main && [[ "$out" == *"base sync: merged 2 commit(s) from main into feat/x and pushed"* ]] && [[ "$out" != *"switch the primary checkout off"* ]]'
check "DS-594 AC3 the primary checkout's branch and files are unchanged" \
  '[ "$(git -C "$C/repo" symbolic-ref --short HEAD)" = feat/x ] && [ "$(git -C "$C/repo" rev-parse HEAD)" = "$head" ] && [ "$(cat "$C/repo/local.txt")" = mine ] && [ "$(git -C "$C/repo" status --porcelain)" = "?? local.txt" ]'

# DS-594 AC1: another worktree holding the base leaves it as it is, and a detached base worktree syncs.
fresh holder; git -C "$C/repo" fetch -q origin; git -C "$C/repo" worktree add -q --track -b feat/x "$C/wt/T-9" origin/feat/x
head=$(git -C "$C/wt/T-9" rev-parse HEAD); pass
check "DS-594 AC1 another worktree on the base: a detached base worktree is made at origin's base" \
  "[ -d $BWT ] && ! git -C $BWT symbolic-ref -q HEAD && [[ \"\$out\" == *\"base worktree for feat/x made at \$C/wt/base-feat-x\"* ]]"
check "DS-594 AC1 and the pass reports the base synced" 'origin_has_main && [[ "$out" == *"base sync: merged 2 commit(s) from main into feat/x and pushed"* ]] && [[ "$out" != *"is checked out in"* ]]'
check "DS-594 AC1 the other worktree is left on the base, where it was" '[ "$(git -C "$C/wt/T-9" symbolic-ref --short HEAD)" = feat/x ] && [ "$(git -C "$C/wt/T-9" rev-parse HEAD)" = "$head" ]'

# DS-594 AC5: a detached base worktree with uncommitted changes pushes nothing and says so.
fresh dirty; node "$B/queue.mjs" set T-1 state=done >/dev/null; pass; tip=$(origin_tip)
git -C "$C/repo" commit -q --allow-empty -m three; git -C "$C/repo" push -q origin main; echo stray > "$C/wt/base-feat-x/stray.txt"; pass
check "DS-594 AC5 uncommitted changes in a detached base worktree: nothing is pushed" '[ "$(origin_tip)" = "$tip" ]'
check "DS-594 AC5 and the report names them" '[[ "$out" == *"the base worktree $C/wt/base-feat-x has uncommitted changes"* ]]'

# A base worktree an earlier pass made on the branch itself is still reused.
fresh legacy; git -C "$C/repo" fetch -q origin; git -C "$C/repo" worktree add -q --track -b feat/x "$C/wt/base-feat-x" origin/feat/x; pass
check "DS-594 a base worktree on the branch from an earlier pass is reused and synced" \
  '[[ "$out" != *"base worktree for feat/x made"* ]] && [ "$(git -C "$C/wt/base-feat-x" symbolic-ref --short HEAD)" = feat/x ] && origin_has_main'

# Baseline checks: tc.sh stands in for §4 Typecheck, printing errors.txt as tsc would and failing when it
# holds any error. baseline <case> [on|off] [base]: fresh, with that row and the toolchain rows set.
baseline(){
  fresh "$1" yes "${3:-feat/x}"
  printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Install | `none` |\n| Typecheck | `sh tc.sh` |\n| Lint | `none` |\n| Baseline checks | `%s` |\n' "${2:-on}" >> "$C/config.md"
  git clone -q "$C/origin.git" "$C/seed"; git -C "$C/seed" switch -q feat/x
  printf 'cat errors.txt\n! grep -q error errors.txt\n' > "$C/seed/tc.sh"
  printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n" > "$C/seed/errors.txt"
  git -C "$C/seed" add tc.sh errors.txt; git -C "$C/seed" commit -q -m "a base with an error"; git -C "$C/seed" push -q origin feat/x
}
mkdir -p "$T/lock"; export DESK_LOCK_DIR="$T/lock"; ln -s "$B/with-lock.sh" "$T/desk/bin/with-lock.sh"
DESK_ENV="node $B/desk-env.mjs"

# AC1: the first pass that spawns records the base's errors, gives the count, and briefs the worker.
baseline record; pass
check "AC1 the base's errors are recorded"            '[ "$(jq -r ".checks.typecheck[0].count" "$C/state/baseline.json")" = 1 ] && [ "$(jq -r .base "$C/state/baseline.json")" = feat/x ]'
check "AC1 at the synced base's head"                 "[ \"\$(jq -r .sha \"\$C/state/baseline.json\")\" = \"\$(git -C $BWT rev-parse HEAD)\" ]"
check "AC1 the report gives the counts"               '[[ "$out" == *"baseline: recorded feat/x at "*": typecheck 1 error(s)"* ]]'
check "the worker is told to check against it"        'grep -q "## Baseline checks" "$C/state/briefings/T-1.md" && grep -q "desk-env baseline typecheck" "$C/state/briefings/T-1.md"'
check "the base worktree is left clean"               "[ -z \"\$(git -C $BWT status --porcelain)\" ]"
node "$B/queue.mjs" add T-2 >/dev/null; node "$B/queue.mjs" set T-2 state=triaged >/dev/null; pass
check "a base that has not moved is not recorded again" '[[ "$out" == *"spawned: T-2"* ]] && [[ "$out" != *"baseline: recorded"* ]]'

# AC2, AC3, AC4: a worker's check, in its own clone of the base.
git clone -q "$C/origin.git" "$C/w1"; git -C "$C/w1" switch -q feat/x; cd "$C/w1" || exit 1
wcheck(){ out=$(DESK_DEFAULT_BRANCH=feat/x $DESK_ENV baseline typecheck 2>&1); rc=$?; }
printf "src/a.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n" > errors.txt; wcheck
check "AC2 only the recorded error, moved: the check passes" '[ $rc -eq 0 ] && [[ "$out" == *"PASS sh tc.sh: only the 1 error(s) the base already has"* ]]'
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nlib/other.ts(1,1): error TS2304: Cannot find name 'x'.\nFound 2 errors.\n" > errors.txt; wcheck
check "AC3 a new error in another file fails and is named" '[ $rc -eq 1 ] && [[ "$out" == *"FAIL sh tc.sh: 1 new error(s)"* ]] && [[ "$out" == *"lib/other.ts:1  TS2304  Cannot find name '"'x'"'."* ]]'
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/a.ts(4,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 2 errors.\n" > errors.txt; wcheck
check "AC4 a second identical error fails on the extra one" '[ $rc -eq 1 ] && [[ "$out" == *"src/a.ts:4  TS2322"* ]] && [[ "$out" != *"src/a.ts:3"* ]]'
printf 'tsc: out of memory\n' > errors.txt; printf 'cat errors.txt\nexit 134\n' > tc.sh; wcheck
check "AC6 unreadable output runs the full check and says so" '[ $rc -eq 1 ] && [[ "$out" == *"FULL sh tc.sh: this run'"'"'s output could not be read"* ]] && [[ "$out" == *"tsc: out of memory"* ]]'
git checkout -q -- .; cd "$C/repo" || exit 1

# AC5: a sync that brings commits into the base takes the baseline again before the next spawn.
git -C "$C/repo" fetch -q origin; git -C "$C/repo" switch -q main; git -C "$C/repo" merge -q --no-edit origin/feat/x
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(1,1): error TS2304: Cannot find name 'y'.\nFound 2 errors.\n" > "$C/repo/errors.txt"
git -C "$C/repo" commit -q -am "main adds an error"; git -C "$C/repo" push -q origin main
node "$B/queue.mjs" set T-1 state=done >/dev/null; node "$B/queue.mjs" set T-2 state=done >/dev/null
node "$B/queue.mjs" add T-3 >/dev/null; node "$B/queue.mjs" set T-3 state=triaged >/dev/null; pass
check "AC5 the sync merged"                           '[[ "$out" == *"base sync: merged"* ]]'
check "AC5 and the baseline is taken again first"     '[[ "$out" == *"baseline: recorded feat/x at "*": typecheck 2 error(s)"* ]] && [ "$(jq -r ".checks.typecheck[0].count" "$C/state/baseline.json")" = 2 ]'
check "AC5 the worker is briefed on the new baseline" 'grep -q "typecheck 2 error(s)" "$C/state/briefings/T-3.md"'

# The base moved on origin (the merge driver merged a PR into it) while a stray file kept the base
# worktree from catching up: it is not recorded, and leaves no baseline to compare against.
echo stray > "$C/wt/base-feat-x/stray.txt"
git -C "$C/seed" pull -q --no-rebase origin feat/x; git -C "$C/seed" commit -q --allow-empty -m "merged by the driver"; git -C "$C/seed" push -q origin feat/x
node "$B/queue.mjs" set T-3 state=done >/dev/null
node "$B/queue.mjs" add T-4 >/dev/null; node "$B/queue.mjs" set T-4 state=triaged >/dev/null; pass
check "a base worktree behind origin drops the baseline" '[ ! -e "$C/state/baseline.json" ] && [[ "${out#*WAITING ON YOU}" == *"baseline: not recorded"*"is not at origin'"'"'s feat/x"* ]] && ! grep -q "## Baseline checks" "$C/state/briefings/T-4.md"'

# AC7: off, or no base, checks as today.
baseline off off; pass
check "AC7 off: nothing is recorded"                  '[ ! -e "$C/state/baseline.json" ] && [[ "$out" != *"baseline"* ]] && [[ "$out" == *"spawned: T-1"* ]]'
check "AC7 off: no baseline section in the briefing"  '! grep -q "## Baseline checks" "$C/state/briefings/T-1.md"'
cd "$C/seed" || exit 1; out=$(DESK_DEFAULT_BRANCH=feat/x $DESK_ENV baseline typecheck 2>&1); rc=$?; cd "$C/repo" || exit 1
check "AC7 off: the worker's check is the full check" '[ $rc -eq 1 ] && [[ "$out" == *"baseline: off (config §4 Baseline checks is \"off\", not on): the full check"* ]] && [[ "$out" == *"FAIL sh tc.sh (exit 1)"* ]]'
fresh nobase-on yes -; printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Typecheck | `sh tc.sh` |\n| Baseline checks | `on` |\n' >> "$C/config.md"; pass
check "AC7 no base: nothing is recorded"              '[ ! -e "$C/state/baseline.json" ] && [[ "$out" == *"spawned: T-1"* ]] && ! grep -q "## Baseline checks" "$C/state/briefings/T-1.md"'

# DS-964: a base deleted on origin. gone <case> [perm]: a base worktree from a first pass that synced
# main in, then main takes everything on feat/x and origin deletes it (GitHub's delete-branch-on-merge),
# and T-1 is ready again.
gone(){
  fresh "$1" "${2:-yes}"; pass
  git -C "$C/repo" fetch -q origin; git -C "$C/repo" merge -q --ff-only origin/feat/x; git -C "$C/repo" push -q origin main
  git -C "$C/origin.git" branch -q -D feat/x; node "$B/queue.mjs" set T-1 state=triaged >/dev/null
}
spawned(){ [[ "$out" == *"spawned: T-1"* ]]; }
gone gonemerged; pass
check "DS-964 AC1 a merged, deleted base is recreated on origin at main's head" '[ "$(origin_tip)" = "$(git -C "$C/origin.git" rev-parse main)" ]'
check "DS-964 AC1 the pass says it was recreated, and why" \
  '[[ "$out" == *"base sync: feat/x is missing on origin, and its last known head "*" is in main (merged, then deleted), so it was recreated at main'"'"'s head "*" and pushed"* ]]'
check "DS-964 AC1 and the ready ticket spawns" 'spawned'
# Unmerged: the base gets a commit of its own a pass fetches, then origin loses it with main never taking it.
fresh goneunmerged; pass; own_commit; pass; tip=$(origin_tip)
git -C "$C/origin.git" branch -q -D feat/x; node "$B/queue.mjs" set T-1 state=triaged >/dev/null; pass
check "DS-964 AC2 a deleted base whose last head is not in main is not recreated" '! git -C "$C/origin.git" rev-parse -q --verify refs/heads/feat/x >/dev/null'
check "DS-964 AC2 the pass names the missing branch and its unmerged head" \
  '[[ "$out" == *"feat/x is missing on origin, and its last known head ${tip:0:12} is not in main, so it was not recreated"* ]]'
check "DS-964 AC2 and spawns stay held, outside feature mode too" '! spawned'
# The push grant: without it, or on a dry run, the base is not recreated and spawns stay held.
gone gonedenied no; pass
check "DS-964 batch-base-push no: a merged, deleted base is not recreated, and says why" \
  '! git -C "$C/origin.git" rev-parse -q --verify refs/heads/feat/x >/dev/null && [[ "$out" == *"(merged, then deleted), and config §3 batch-base-push is \"no\", so it was not recreated at main'"'"'s head"* ]] && ! spawned'
gone gonedry; out=$(AUTOPILOT_DRY_RUN=1 node "$B/pass.mjs" 2>&1)
check "DS-964 a dry run says it would recreate the base, and pushes nothing" \
  '! git -C "$C/origin.git" rev-parse -q --verify refs/heads/feat/x >/dev/null && [[ "$out" == *"base sync (dry run): feat/x is missing on origin"*"would recreate it at main'"'"'s head"* ]]'

# A dry run probes and pushes nothing.
fresh dry; tip=$(origin_tip); out=$(AUTOPILOT_DRY_RUN=1 node "$B/pass.mjs" 2>&1)
check "a dry run pushes nothing and says what it would merge" '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"would merge 2 commit(s)"* ]]'

finish push
