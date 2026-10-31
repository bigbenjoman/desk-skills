#!/usr/bin/env bash
# suite: worker Read hook (no re-reading a file unchanged since the last read)
# hooks/desk-worker-reread.py fed fake PreToolUse/PostToolUse Read events and a PreCompact: a repeat
# read of an unchanged file and range is refused naming the earlier read (AC1); a changed file (AC2),
# another range (AC3), a compaction (AC4), a subagent (AC5), the off switch (AC6) and a non-worker
# session (AC7) all let it through. Plus worker-settings registering the hook. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
export DESK_HOME="$T/desk"
unset DESK_AUTOPILOT_WORKER DESK_ALLOW_REREAD
HOOK="$SRC/hooks/desk-worker-reread.py"
PASS=0; FAIL=0; out=""; rc=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# ev <event> <session> <input json> [extra json fields] -> the hook event on stdin
ev(){ printf '{"hook_event_name":"%s","session_id":"%s","tool_name":"Read","tool_input":%s%s}' "$1" "$2" "$3" "${4:+,$4}"; }
# hook <env...> -- reads the event on stdin -> $out, $rc
hook(){ out=$(env "$@" python3 "$HOOK" 2>&1); rc=$?; }
W="DESK_AUTOPILOT_WORKER=1"
# read <session> <input> [extra] -> a Read as the worker makes it: PreToolUse, then PostToolUse when let through
readf(){ hook $W < <(ev PreToolUse "$1" "$2" "${3:-}"); local pre="$out" prc=$rc
  [ -z "$pre" ] && hook $W < <(ev PostToolUse "$1" "$2" "${3:-}"); out="$pre"; rc=$prc; }
denied(){ [ "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecision"])' 2>/dev/null)" = deny ]; }
reason(){ printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecisionReason"])' 2>/dev/null; }
let_through(){ [ "$rc" -eq 0 ] && [ -z "$out" ]; }

F="$T/a.md"; printf 'one\ntwo\nthree\n' > "$F"
WHOLE="{\"file_path\":\"$F\"}"
RANGE="{\"file_path\":\"$F\",\"offset\":2,\"limit\":1}"

readf s1 "$WHOLE"
check "first read goes through"                                 'let_through'
readf s1 "$WHOLE"
check "AC1: a repeat read of the unchanged file is refused"     '[ $rc -eq 0 ] && denied'
check "AC1: the reason names the earlier read and the file"     '[[ "$(reason)" == *"already read $F (the whole file) at "* ]]'

readf s1 "$RANGE"
check "AC3: a different range of the same file goes through"   'let_through'
readf s1 "$RANGE"
check "AC1: that range repeated is refused, naming the range"  'denied && [[ "$(reason)" == *"$F (lines 2-2)"* ]]'

printf 'one\ntwo\nthree\nfour\n' > "$F"
readf s1 "$WHOLE"
check "AC2: the file changed since (an edit): goes through"    'let_through'
readf s1 "$WHOLE"
check "AC2: and the new content repeated is refused"           'denied'
# A shell rewrite back to identical bytes (a rebase that changes nothing) still refuses: hash, not mtime.
touch -t 202001010000 "$F"
readf s1 "$WHOLE"
check "a touch with the content unchanged still refuses"       'denied'
printf 'rewritten by a rebase\n' > "$F"
readf s1 "$WHOLE"
check "AC2: rewritten by a shell command: goes through"        'let_through'

readf s2 "$WHOLE"
check "another session's first read goes through"             'let_through'

hook $W < <(printf '{"hook_event_name":"PreCompact","session_id":"s1","trigger":"auto"}')
check "PreCompact exits cleanly"                               'let_through'
readf s1 "$WHOLE"
check "AC4: after a compaction the read goes through"         'let_through'
readf s2 "$WHOLE"
check "AC4: another session's records survive it"             'denied'

readf s1 "$WHOLE" '"agent_id":"sub-1","agent_type":"Explore"'
check "AC5: a subagent's read of a file the worker read goes through" 'let_through'
G="$T/b.md"; printf 'b\n' > "$G"
readf s1 "{\"file_path\":\"$G\"}" '"agent_id":"sub-1","agent_type":"Explore"'
readf s1 "{\"file_path\":\"$G\"}"
check "AC5: a subagent's read is not recorded for the worker" 'let_through'

hook $W DESK_ALLOW_REREAD=1 < <(ev PreToolUse s1 "$WHOLE")
check "AC6: off switch set: the repeat read goes through"     'let_through'

hook < <(ev PostToolUse s9 "$WHOLE"); hook < <(ev PreToolUse s9 "$WHOLE")
check "AC7: not a worker: a read twice goes through"           'let_through'
check "AC7: not a worker: nothing recorded"                    '[ ! -e "$DESK_HOME/worker-reread/s9" ]'

hook $W < <(ev PreToolUse s1 "{\"file_path\":\"$T/missing.md\"}")
check "a missing file: goes through, no error"                 'let_through'
hook $W < <(printf 'not json')
check "bad input: goes through, no error"                      'let_through'

# worker-settings registers the hook on Read before and after, and on compaction, beside the others.
mkdir -p "$HOME/.claude/hooks"; : > "$HOME/.claude/hooks/desk-worker-reread.py"; : > "$HOME/.claude/hooks/deny-ai-attribution.py"
git init -q -b main "$T/repo" 2>/dev/null; git -C "$T/repo" -c user.email=t@e -c user.name=t commit -q --allow-empty -m init
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

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Unit tests | \`bash tests/run.sh\` |
EOF
out=$(cd "$T/repo" && env -u DESK_REPO_OVERRIDE -u DESK_SLUG -u DESK_REPO_DIR -u DESK_DEFAULT_BRANCH -u DESK_SKILLS_DIR \
  DESK_HOME="$SRC/desk" DESK_CONFIG="$T/config.md" DESK_AUTOPILOT_STATE="$T/state" DESK_STATE="$T/state" DESK_QUEUE="$T/queue.json" \
  node "$SRC/desk/bin/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" --branch fix/fix-thing --out "$T/ws.json" 2>&1); rc=$?
CMD="python3 \"$HOME/.claude/hooks/desk-worker-reread.py\""
q(){ jq -r "$1" "$T/ws.json"; }
check "worker-settings: PreToolUse Read runs the hook"         '[ $rc -eq 0 ] && [ "$(q ".hooks.PreToolUse[] | select(.matcher == \"Read\") | .hooks[0].command")" = "$CMD" ]'
check "worker-settings: the Bash attribution hook is kept"     '[ "$(q ".hooks.PreToolUse[] | select(.matcher == \"Bash\") | .hooks[0].command")" = "python3 \"$HOME/.claude/hooks/deny-ai-attribution.py\"" ]'
check "worker-settings: PostToolUse Read runs the hook"        '[ "$(q ".hooks.PostToolUse[] | select(.matcher == \"Read\") | .hooks[0].command")" = "$CMD" ]'
check "worker-settings: PreCompact runs the hook"              '[ "$(q ".hooks.PreCompact[0].hooks[0].command")" = "$CMD" ]'

echo "worker reread hook: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
