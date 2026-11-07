#!/usr/bin/env bash
# suite: wrappers lever (desk-env lines, the worker hints hook)
# covers: desk/bin/desk-lines.mjs hooks/desk-worker-hints.py desk/bin/worker-settings.mjs desk/bin/spawn-worker.sh
# With config §3b Phase 0 levers naming `wrappers`: `desk-env lines <file> A,B` prints what
# `sed -n A,Bp <file>` prints (AC1) and refuses what a worker's reading tools are refused (AC2);
# hooks/desk-worker-hints.py refuses a command the allow-list refuses anyway naming what to run
# instead, and is silent on anything that would run (AC3); with the lever off, `desk-env lines`
# refuses naming the lever and a worker's settings are exactly as before (AC4). Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"; : > "$GIT_CONFIG_GLOBAL"
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_DEFAULT_BRANCH DESK_SKILLS_DIR \
  DESK_AUTOPILOT_WORKER DESK_WORKER_SETTINGS DESK_CONFIG_ROOT
# The lock directory is one a worker may read (/tmp by default), so it is kept apart from $T here.
export DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_STATE="$T/state" DESK_QUEUE="$T/queue.json" DESK_LOCK_DIR="$T/locks"
mkdir -p "$T/state" "$T/locks"
PASS=0; FAIL=0; out=""; rc=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

R="$T/repo"; git init -q -b main "$R"; git -C "$R" -c user.email=t@e -c user.name=t commit -q --allow-empty -m init
git -C "$R" remote add origin https://github.com/acme/widgets.git
CREDS="$HOME/.config/desk/repos/acme__widgets"; mkdir -p "$CREDS"
# config <levers row> -> the repo's config, in its credentials directory as desk-setup writes it
config(){ cat > "$CREDS/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$R\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Phase 0 levers | \`none\` | \`$1\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Unit tests | \`bash tests/run.sh\` |
EOF
}
# lines <args...> -> $out (stdout), $err, $rc, run in the repo as a worker runs it
lines(){ out=$(cd "$R" && node "$B/desk-env.mjs" lines "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); }
F="$R/notes.txt"; printf 'one\ntwo\nthree\nfour\nfive\n' > "$F"
printf 'a\nb' > "$R/nonl.txt"
printf 'token=secret\n' > "$CREDS/jira-token"

# ---- AC4: the lever off --------------------------------------------------------------------------
config none
lines notes.txt 2,3
check "AC4 lever off: desk-env lines refuses, naming the lever, and prints nothing" \
  '[ $rc -eq 3 ] && [ -z "$out" ] && [[ "$err" == *"wrappers lever is off"* ]] && [[ "$err" == *"Phase 0 levers"* ]]'

# ---- AC1: the same lines as sed -n ---------------------------------------------------------------
config wrappers
for spec in 2,3 1,5 4,9 5 3,'$' 6,8 4,2; do
  lines notes.txt "$spec"; want=$(cd "$R" && sed -n "${spec}p" notes.txt)
  check "AC1 desk-env lines notes.txt $spec prints what sed -n ${spec}p does" '[ $rc -eq 0 ] && [ "$out" = "$want" ]'
done
lines notes.txt 2,3
check "AC1 line endings are kept"                     '[ "$(cd "$R" && node "$B/desk-env.mjs" lines notes.txt 2,3 | od -c)" = "$(cd "$R" && sed -n 2,3p notes.txt | od -c)" ]'
lines nonl.txt 2
check "AC1 a last line with no newline prints as it is" '[ $rc -eq 0 ] && [ "$out" = b ]'
lines "$F" 1,1
check "AC1 an absolute path in the worktree reads"    '[ $rc -eq 0 ] && [ "$out" = one ]'
for bad in '' 0,2 a,b 2- '1,2p' '1;2'; do
  lines notes.txt "$bad"
  check "a range that is no sed line range is a usage error: '$bad'" '[ $rc -eq 2 ] && [ -z "$out" ] && [[ "$err" == usage:* ]]'
done
lines missing.txt 1,2
check "a missing file says so, as sed does"           '[ $rc -eq 1 ] && [[ "$err" == *"missing.txt: No such file or directory"* ]]'

# ---- AC2: what a worker's reading tools are refused, desk-env lines refuses ----------------------
lines "$CREDS/jira-token" 1
check "AC2 the credentials directory is refused, outside a worker too" \
  '[ $rc -eq 1 ] && [ -z "$out" ] && [[ "$err" == *"refused: "*"credentials directory"* ]]'
lines "$CREDS/config.md" 1,3
check "AC2 the config beside the credentials is refused, as cat of it is" '[ $rc -eq 1 ] && [ -z "$out" ]'
ln -s "$CREDS/jira-token" "$R/link"
lines link 1
check "AC2 a symlink into the credentials directory is refused" '[ $rc -eq 1 ] && [ -z "$out" ] && [[ "$err" == *"credentials directory"* ]]'
rm "$R/link"

# A worker: what it may read comes from the sidecar worker-settings writes beside its settings.
mkdir -p "$HOME/.claude/hooks" "$T/skills" "$T/outside"; cp "$SRC/hooks/desk-worker-hints.py" "$HOME/.claude/hooks/"
: > "$HOME/.claude/hooks/deny-ai-attribution.py"
printf 'x\n' > "$T/outside/f.txt"; printf 's1\ns2\n' > "$T/state/skill.md"
ws(){ out=$(cd "$R" && node "$B/worker-settings.mjs" worker --ticket fix-thing --wt "$R" --branch fix/fix-thing --out "$T/ws.json" 2>&1); rc=$?; }
ws
check "worker settings written with the lever on, sidecar beside them" '[ $rc -eq 0 ] && [ -f "$T/ws.wrappers.json" ]'
W=(DESK_AUTOPILOT_WORKER=1 "DESK_WORKER_SETTINGS=$T/ws.json")
wlines(){ out=$(cd "$R" && env "${W[@]}" node "$B/desk-env.mjs" lines "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); }
wlines notes.txt 2,3
check "AC1 in a worker, its worktree reads"           '[ $rc -eq 0 ] && [ "$out" = "$(printf "two\nthree")" ]'
wlines "$T/state/skill.md" 2
check "AC1 in a worker, a granted directory reads"    '[ $rc -eq 0 ] && [ "$out" = s2 ]'
wlines "$T/outside/f.txt" 1
check "AC2 in a worker, a file outside its directories is refused" \
  '[ $rc -eq 1 ] && [ -z "$out" ] && [[ "$err" == *"outside your worktree and the directories your settings let you read"* ]]'
wlines "../outside/f.txt" 1
check "AC2 in a worker, a .. path out of the worktree is refused" '[ $rc -eq 1 ] && [ -z "$out" ]'
ln -s "$T/outside/f.txt" "$R/out-link"
wlines out-link 1
check "AC2 in a worker, a symlink out of its directories is refused" '[ $rc -eq 1 ] && [ -z "$out" ]'
rm "$R/out-link"
wlines "$CREDS/jira-token" 1
check "AC2 in a worker, the credentials directory is refused" '[ $rc -eq 1 ] && [[ "$err" == *"credentials directory"* ]]'
out=$(cd "$R" && env DESK_AUTOPILOT_WORKER=1 node "$B/desk-env.mjs" lines notes.txt 1 2>&1); rc=$?
check "AC2 a worker with no settings named reads nothing"  '[ $rc -eq 1 ] && [[ "$out" == *"refused: DESK_WORKER_SETTINGS is not set"* ]]'
out=$(cd "$R" && env DESK_AUTOPILOT_WORKER=1 DESK_WORKER_SETTINGS="$T/none.json" node "$B/desk-env.mjs" lines notes.txt 1 2>&1); rc=$?
check "AC2 a worker whose sidecar is missing reads nothing" '[ $rc -eq 1 ] && [[ "$out" == *"refused: cannot read"* ]]'

# ---- AC4 and the settings diff: the lever adds the hook and no allow or deny rule ----------------
cp "$T/ws.json" "$T/ws-on.json"
config none; rm -f "$T/ws.wrappers.json"; ws; cp "$T/ws.json" "$T/ws-off.json"
check "AC4 lever off: no sidecar is written"           '[ $rc -eq 0 ] && [ ! -e "$T/ws.wrappers.json" ]'
check "AC4 lever off: the hints hook is not registered" '! grep -q desk-worker-hints "$T/ws-off.json"'
check "the lever adds no allow rule, no deny rule and no directory" \
  '[ "$(jq -S .permissions "$T/ws-on.json")" = "$(jq -S .permissions "$T/ws-off.json")" ]'
check "the lever adds exactly one hook: the hints hook on Bash, given the settings file" \
  '[ "$(jq -c "[.hooks.PreToolUse[] | select(.matcher == \"Bash\")] | length" "$T/ws-on.json")" = 2 ] \
   && [ "$(jq -r ".hooks.PreToolUse[-1].hooks[0].command" "$T/ws-on.json")" = "python3 \"$HOME/.claude/hooks/desk-worker-hints.py\" '"'"'$T/ws.json'"'"'" ] \
   && [ "$(jq -S "del(.hooks.PreToolUse[-1])" "$T/ws-on.json")" = "$(jq -S . "$T/ws-off.json")" ]'
check "desk-env lines is already allowed by name and module, so no rule is needed for it" \
  'jq -e ".permissions.allow | index(\"Bash(desk-env:*)\") and index(\"Bash(node $B/desk-env.mjs:*)\")" "$T/ws-on.json" >/dev/null'
check "spawn-worker names the settings file for desk-env lines" 'grep -q "^export DESK_WORKER_SETTINGS=\"\$SETTINGS\"" "$B/spawn-worker.sh"'

# ---- AC3: the hook ---------------------------------------------------------------------------------
config wrappers; ws
HOOK="$HOME/.claude/hooks/desk-worker-hints.py"
# hook <command> [cwd] -> $out, $rc
hook(){ out=$(jq -nc --arg c "$1" --arg d "${2:-$R}" '{hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$c},cwd:$d}' | python3 "$HOOK" "$T/ws.json" 2>&1); rc=$?; }
reason(){ printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason' 2>/dev/null; }
denied(){ [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision' 2>/dev/null)" = deny ]; }
silent(){ [ "$rc" -eq 0 ] && [ -z "$out" ]; }
LOCK="$(jq -r .lock "$T/ws.wrappers.json")"

hook "cd $R && node tests/test_x.mjs 2>&1 | tail -5"
check "AC3 cd into its own worktree before a refused step: refused" '[ $rc -eq 0 ] && denied'
check "AC3 the refusal names the command without the cd" '[[ "$(reason)" == *"the \`cd $R\` does nothing"*"Run the rest without it: \`node tests/test_x.mjs 2>&1 | tail -5\`"* ]]'
check "AC3 and names the one test file through §4 Unit tests" '[[ "$(reason)" == *"\`$LOCK test -- bash tests/run.sh tests/test_x.mjs\`"* ]]'
check "AC3 and names the step that was refused"         '[[ "$(reason)" == *"\`node tests/test_x.mjs 2>&1\` is not allowed on its own"* ]]'
hook "bash tests/test_worker_settings.sh | tail -3"
check "AC3 one .sh test file run directly: refused naming bash tests/run.sh with it" \
  'denied && [[ "$(reason)" == *"-- bash tests/run.sh tests/test_worker_settings.sh\`"* ]]'
hook "node tests/test_desk_env.mjs"
check "AC3 one test file run directly, unchained: refused with the hint" 'denied && [[ "$(reason)" == *"bash tests/run.sh tests/test_desk_env.mjs"* ]]'
hook "sed -n 10,20p desk/bin/pass.mjs; perl -ne print x"
check "AC3 a sed line range beside a refused step: refused naming desk-env lines" \
  'denied && [[ "$(reason)" == *"\`desk-env lines desk/bin/pass.mjs 10,20\` prints what \`sed -n 10,20p desk/bin/pass.mjs\` does"* ]] && [[ "$(reason)" == *"\`perl -ne print x\` is not allowed"* ]]'

# Silent wherever the command could run, or no hint fits: the harness decides as it does today.
for c in "cd $R && git status" "sed -n 1,5p notes.txt" "sed -n 1,5p notes.txt | head -2" "git log --oneline -3 && git status" \
  "bash tests/run.sh tests/test_x.mjs" "$LOCK test -- bash tests/run.sh test_x.mjs" "desk-env lines notes.txt 1,2" \
  "perl -ne print x" "cd /tmp && perl -ne print x" "awk '{print}' x" "git stash list" "for f in a b; do node tests/test_\$f.mjs; done" \
  "node tests/test_\$(echo x).mjs" "node tests/x.mjs" "cat <<EOF > a\nx\nEOF" "echo 'unbalanced"; do
  hook "$c"
  check "AC3 no opinion: $c" 'silent'
done
hook "cd $R/tests && node test_x.mjs"
check "AC3 cd into a directory inside the worktree is not called a no-op" 'denied && [[ "$(reason)" != *"does nothing"* ]]'
out=$(printf 'not json' | python3 "$HOOK" "$T/ws.json" 2>&1); rc=$?
check "bad input: no opinion, no error"                 'silent'
out=$(jq -nc '{tool_input:{command:"node tests/test_x.mjs"},cwd:"/"}' | python3 "$HOOK" "$T/missing.json" 2>&1); rc=$?
check "settings it cannot read: no opinion, no error"   'silent'

echo "wrappers lever: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
