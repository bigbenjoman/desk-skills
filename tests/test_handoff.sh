#!/usr/bin/env bash
# suite: context handoff hook (threshold, Stop block, clear/compact resume)
# The context handoff hook (hooks/desk-handoff.py), fed hook inputs and fixture transcripts in a
# throwaway repo: one injection past the §2 threshold and none under it, the main chain only, the
# window (200k, [1m], past 200k, DESK_CONTEXT_WINDOW), the separate 1M-window row (unset, the 200k row's), a
# single Stop block, the .handoffs/ exclude
# and the -n name, and the SessionStart injection for clear and compact (fresh, unconsumed only).
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"
: > "$GIT_CONFIG_GLOBAL"
mkdir -p "$T/desk"; ln -s "$SRC/desk/bin" "$T/desk/bin"
export DESK_HOME="$T/desk" DESK_CONFIG="$T/config.md" DESK_MACHINE="$T/machine.md"
unset DESK_REPO_DIR DESK_CONTEXT_WINDOW ANTHROPIC_MODEL DESK_REPO_OVERRIDE
HOOK="$SRC/hooks/desk-handoff.py"
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

R="$T/repo"; git init -q -b main "$R"; git -C "$R" remote add origin https://github.com/acme/demo.git
mkdir -p "$R/sub"
DAY="$(date +%Y-%m-%d)"
# config <Handoff at context %> [<Handoff at context % on a 1M window>]
config(){ { printf '## 2. Paths\n| Field | Value | Notes |\n|---|---|---|\n| Handoff at context %% | %s | |\n' "$1"
  if [ -n "${2:-}" ]; then printf '| Handoff at context %% on a 1M window | %s | |\n' "$2"; fi; } > "$DESK_CONFIG"; }

# transcript <file> <main-chain tokens> [<later sidechain tokens>]
transcript(){
  { printf '{"type":"user","isSidechain":false,"message":{"role":"user","content":"hi"}}\n'
    printf '{"type":"assistant","isSidechain":false,"message":{"model":"claude-opus-5-5","usage":{"input_tokens":%s,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}\n' 0
    printf '{"type":"assistant","isSidechain":false,"message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":%s,"cache_read_input_tokens":%s,"output_tokens":9}}}\n' 0 "$(( $2 - 10 ))"
    [ -n "${3:-}" ] && printf '{"type":"assistant","isSidechain":true,"message":{"usage":{"input_tokens":%s,"output_tokens":1}}}\n' "$3"
    printf '{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result"}]}}\n'; } > "$1"
}
# hook <event> <session> <transcript> [extra json fields]
hook(){ out=$(printf '{"hook_event_name":"%s","session_id":"%s","transcript_path":"%s","cwd":"%s"%s}' \
  "$1" "$2" "$3" "$R/sub" "${4:-}" | python3 "$HOOK" 2>&1); rc=$?; }
ctx(){ printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"])' 2>/dev/null; }
age(){ python3 -c 'import os,sys,time; t=time.time()-float(sys.argv[2]); os.utime(sys.argv[1],(t,t))' "$1" "$2"; }

config '`45`'

# ---- AC1: under, then over, the threshold; once only ----
transcript "$T/low.jsonl" 50000
hook PostToolUse s1 "$T/low.jsonl"
check "25% of 200k: nothing injected"                     '[ $rc -eq 0 ] && [ -z "$out" ]'
transcript "$T/high.jsonl" 100000
hook PostToolUse s1 "$T/high.jsonl"
c="$(ctx)"
check "50% of 200k: PostToolUse injects"                  '[[ "$c" == *"context is at 50%"* ]] && [[ "$c" == *"threshold 45%"* ]]'
check "it says finish the step and start no new work"     '[[ "$c" == *"Finish the step you are on"* ]] && [[ "$c" == *"start no new work"* ]]'
check "it names .handoffs/<date>.md in the repo root"     '[[ "$c" == *"$R/.handoffs/$DAY.md"* ]]'
check "it lists the handoff sections and paste-in line"   '[[ "$c" == *"where things stand"* ]] && [[ "$c" == *"next step"* ]] && [[ "$c" == *"decisions made"* ]] && [[ "$c" == *"open questions"* ]] && [[ "$c" == *"paste-in line"* ]]'
check "AC3: .handoffs/ is in .git/info/exclude"           'grep -qx ".handoffs/" "$R/.git/info/exclude"'
hook PostToolUse s1 "$T/high.jsonl"
check "a second PostToolUse injects nothing"              '[ -z "$out" ]'
hook UserPromptSubmit s1 "$T/high.jsonl"
check "nor does UserPromptSubmit after it fired"          '[ -z "$out" ]'
hook UserPromptSubmit s2 "$T/high.jsonl"
c="$(ctx)"
check "UserPromptSubmit fires too, as its own event"      '[[ "$out" == *"\"hookEventName\": \"UserPromptSubmit\""* ]] && [[ "$c" == *"context is at 50%"* ]]'
check "exclude is written once"                           '[ "$(grep -c "^.handoffs/$" "$R/.git/info/exclude")" = 1 ]'

# ---- main chain only ----
transcript "$T/side.jsonl" 50000 190000
hook PostToolUse s3 "$T/side.jsonl"
check "a later sidechain's usage is ignored"              '[ -z "$out" ]'

# ---- the window (the 1M row pinned to 45, so only the window changes) ----
config '`45`' '`45`'
transcript "$T/300k.jsonl" 300000
hook PostToolUse s4 "$T/300k.jsonl"
check "300k is past 200k, so the window is 1M (30%)"      '[ -z "$out" ]'
transcript "$T/500k.jsonl" 500000
hook PostToolUse s4 "$T/500k.jsonl"
check "500k of 1M fires"                                  '[[ "$(ctx)" == *"context is at 50% of a 1,000,000-token window"* ]]'
hook SessionStart s5 "$T/high.jsonl" ',"source":"startup","model":"claude-opus-5-5[1m]"'
check "SessionStart startup injects nothing"              '[ -z "$out" ]'
hook PostToolUse s5 "$T/high.jsonl"
check "a [1m] model: 100k is 10%, nothing"                '[ -z "$out" ]'
out=$(printf '{"hook_event_name":"PostToolUse","session_id":"s6","transcript_path":"%s","cwd":"%s"}' "$T/low.jsonl" "$R" | DESK_CONTEXT_WINDOW=100000 python3 "$HOOK")
check "DESK_CONTEXT_WINDOW overrides the window"          '[[ "$(ctx)" == *"context is at 50% of a 100,000-token window"* ]]'

# ---- the 1M row: Handoff at context % on a 1M window ----
config '`45`' '`35`'
hook PostToolUse s20 "$T/300k.jsonl"
check "1M AC1: a 1M row at 35, 30% of 1M: nothing"        '[ -z "$out" ]'
transcript "$T/400k.jsonl" 400000
hook PostToolUse s20 "$T/400k.jsonl"
check "1M AC1: 40% of 1M passes 35 and fires"             '[[ "$(ctx)" == *"context is at 40% of a 1,000,000-token window (threshold 35%)"* ]]'
config '`45`' '`10`'
hook SessionStart s21 "$T/high.jsonl" ',"source":"startup","model":"claude-opus-5-5[1m]"'
hook PostToolUse s21 "$T/high.jsonl"
check "1M AC1: a [1m] model at 10% of 1M passes 10"       '[[ "$(ctx)" == *"(threshold 10%)"* ]]'
config '`45`'
hook PostToolUse s22 "$T/300k.jsonl"
check "no 1M row: 30% of 1M is under the 45 row, nothing" '[ -z "$out" ]'
transcript "$T/440k.jsonl" 440000
hook PostToolUse s22 "$T/440k.jsonl"
check "no 1M row: 44% of 1M, nothing"                     '[ -z "$out" ]'
hook PostToolUse s22 "$T/500k.jsonl"
check "no 1M row: 50% of 1M passes the 45 row"            '[[ "$(ctx)" == *"context is at 50% of a 1,000,000-token window (threshold 45%)"* ]]'
config '`45`' '`TODO`'
hook PostToolUse s23 "$T/500k.jsonl"
check "a TODO 1M row is the 45 row too"                   '[[ "$(ctx)" == *"(threshold 45%)"* ]]'
config '`60`'
hook PostToolUse s30 "$T/500k.jsonl"
check "no 1M row, the row above at 60: 50% of 1M, nothing" '[ -z "$out" ]'
transcript "$T/650k.jsonl" 650000
hook PostToolUse s30 "$T/650k.jsonl"
check "no 1M row, the row above at 60: 65% fires at 60"   '[[ "$(ctx)" == *"(threshold 60%)"* ]]'
config '`60`'; printf '| Handoff at context %% on a 1M window |  | |\n' >> "$DESK_CONFIG"
hook PostToolUse s32 "$T/500k.jsonl"
check "an empty 1M row, the row above at 60: 50%, nothing" '[ -z "$out" ]'
hook PostToolUse s32 "$T/650k.jsonl"
check "an empty 1M row follows the row above (60)"        '[[ "$(ctx)" == *"(threshold 60%)"* ]]'
config '`45`' '`25`'
hook PostToolUse s31 "$T/300k.jsonl"
check "a 1M row at 25 still fires at 25"                  '[[ "$(ctx)" == *"context is at 30% of a 1,000,000-token window (threshold 25%)"* ]]'
config '`45`' '`10`'
transcript "$T/80k.jsonl" 80000
hook PostToolUse s24 "$T/80k.jsonl"
check "1M AC3: 200k window, 40% with a 1M row at 10: nothing" '[ -z "$out" ]'
hook PostToolUse s24 "$T/high.jsonl"
check "1M AC3: 200k window, 50% fires at the 45 row"      '[[ "$(ctx)" == *"context is at 50% of a 200,000-token window (threshold 45%)"* ]]'
config '`45`' '`0`'
hook PostToolUse s25 "$T/500k.jsonl"
check "1M AC4: a 1M row at 0, 50% of 1M: nothing"         '[ -z "$out" ]'
hook PostToolUse s26 "$T/high.jsonl"
check "1M AC4: a 200k window still fires at 45"           '[[ "$(ctx)" == *"(threshold 45%)"* ]]'
config '`0`'
hook PostToolUse s27 "$T/500k.jsonl"
check "the 45 row at 0 and no 1M row: off on 1M as well"  '[ -z "$out" ]'
config '`0`' '`25`'
hook PostToolUse s28 "$T/300k.jsonl"
check "the 45 row at 0, a 1M row at 25: fires on 1M"      '[[ "$(ctx)" == *"(threshold 25%)"* ]]'
hook PostToolUse s29 "$T/high.jsonl"
check "and stays off on a 200k window"                    '[ -z "$out" ]'
config '`45`'

# ---- AC5: the row ----
config '`10`'
hook PostToolUse s7 "$T/low.jsonl"
check "§2 at 10 fires at 25%"                             '[[ "$(ctx)" == *"threshold 10%"* ]]'
config '`0`'
hook PostToolUse s8 "$T/high.jsonl"
check "§2 at 0 never fires"                               '[ -z "$out" ]'
config '`TODO`'
hook PostToolUse s9 "$T/high.jsonl"
check "unset row: the default 45 applies"                 '[[ "$(ctx)" == *"threshold 45%"* ]]'
DESK_CONFIG="$T/missing.md" hook PostToolUse s10 "$T/high.jsonl"
check "no desk config: silent"                            '[ -z "$out" ]'
config '`45`'

# ---- AC2: one Stop block until the handoff exists ----
hook Stop s1 "$T/high.jsonl" ',"stop_hook_active":false'
check "Stop blocks once with write the handoff first"     '[[ "$out" == *"\"decision\": \"block\""* ]] && [[ "$out" == *"write the handoff first"* ]]'
hook Stop s1 "$T/high.jsonl" ',"stop_hook_active":false'
check "the marker stops a second block"                   '[ -z "$out" ]'
hook Stop s3 "$T/side.jsonl"
check "Stop never blocks a session that has not fired"    '[ -z "$out" ]'
mkdir -p "$R/.handoffs"; echo "# handoff" > "$R/.handoffs/$DAY.md"
hook Stop s2 "$T/high.jsonl"
check "Stop with a handoff newer than the firing: none"   '[ -z "$out" ]'
hook Stop s4 "$T/500k.jsonl" ',"stop_hook_active":true'
check "stop_hook_active: never blocks"                    '[ -z "$out" ]'
hook PostToolUse s11 "$T/high.jsonl"
check "AC3: an existing <date>.md gives <date>-2.md"       '[[ "$(ctx)" == *"$R/.handoffs/$DAY-2.md"* ]]'

# ---- AC4: SessionStart on clear and compact ----
hook SessionStart n1 "$T/low.jsonl" ',"source":"clear"'
c="$(ctx)"
check "clear: injects read .handoffs/<latest>.md"         '[[ "$c" == *"read .handoffs/$DAY.md"* ]] && [[ "$c" == *"continue from its next step"* ]]'
check "and marks it consumed"                             'grep -qx "$DAY.md" "$R/.handoffs/.consumed"'
hook SessionStart n2 "$T/low.jsonl" ',"source":"clear"'
check "a consumed handoff is not injected again"          '[ -z "$out" ]'
echo "# later" > "$R/.handoffs/$DAY-2.md"
hook SessionStart n3 "$T/low.jsonl" ',"source":"resume"'
check "resume injects nothing"                            '[ -z "$out" ]'
hook SessionStart s1 "$T/low.jsonl" ',"source":"compact"'
check "compact: injects the newest handoff"               '[[ "$(ctx)" == *"read .handoffs/$DAY-2.md"* ]]'
transcript "$T/compacted.jsonl" 100000
printf '{"type":"system","subtype":"compact_boundary","isSidechain":false}\n{"type":"user","isSidechain":false,"isCompactSummary":true,"message":{"role":"user","content":"summary"}}\n' >> "$T/compacted.jsonl"
hook UserPromptSubmit s1 "$T/compacted.jsonl"
check "after compact, usage from before it is not counted" '[ -z "$out" ]'
transcript "$T/later.jsonl" 30000
{ cat "$T/compacted.jsonl"; tail -n 3 "$T/later.jsonl"; } > "$T/compacted-low.jsonl"
hook PostToolUse s1 "$T/compacted-low.jsonl"
check "nor does usage under it fire"                      '[ -z "$out" ]'
{ cat "$T/compacted.jsonl"; tail -n 3 "$T/high.jsonl"; } > "$T/compacted-high.jsonl"
hook PostToolUse s1 "$T/compacted-high.jsonl"
check "usage after compact over the threshold fires again" '[[ "$(ctx)" == *"context is at 50%"* ]]'
echo "# old" > "$R/.handoffs/old.md"; age "$R/.handoffs/old.md" 90000
age "$R/.handoffs/$DAY.md" 90001; age "$R/.handoffs/$DAY-2.md" 90002
hook SessionStart n4 "$T/low.jsonl" ',"source":"clear"'
check "a handoff over 24 hours old is not injected"       '[ -z "$out" ]'
config '`0`'; echo "# fresh" > "$R/.handoffs/fresh.md"
hook SessionStart n5 "$T/low.jsonl" ',"source":"clear"'
check "§2 at 0: no SessionStart injection"                '[ -z "$out" ]'
config '`45`'

# ---- never breaks a session ----
out=$(printf 'not json' | python3 "$HOOK" 2>&1); rc=$?
check "bad input: exit 0, silent"                         '[ $rc -eq 0 ] && [ -z "$out" ]'
out=$(printf '{"hook_event_name":"PostToolUse","session_id":"x","transcript_path":"%s","cwd":"%s"}' "$T/high.jsonl" "$T" | python3 "$HOOK" 2>&1); rc=$?
check "outside a git repo: exit 0, silent"                '[ $rc -eq 0 ] && [ -z "$out" ]'
hook PostToolUse s12 "$T/missing.jsonl"
check "a missing transcript: silent"                      '[ $rc -eq 0 ] && [ -z "$out" ]'

# ---- AC6: install.sh's register_hook, taken from install.sh, on a throwaway settings.json ----
eval "$(sed -n '/^DESK_WRITE_JSON_PY="$(cat <<.PY.$/,/^)"$/p' "$SRC/install.sh")"; export DESK_WRITE_JSON_PY
fn="$(sed -n '/^register_hook() {$/,/^}$/p' "$SRC/install.sh")"
check "register_hook is found in install.sh"              '[ -n "$fn" ] && [ -n "${DESK_WRITE_JSON_PY:-}" ]'
eval "$fn"
SETTINGS="$T/settings.json"
EVENTS="UserPromptSubmit PostToolUse Stop SessionStart"
printf '{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"mine.sh"}]}]}}\n' > "$SETTINGS"
reg(){ rc=0; register_hook "$@" || rc=$?; out=$(cat "$SETTINGS" 2>/dev/null); }
# shellcheck disable=SC2086
reg check desk-handoff.py 'python3 "/h/desk-handoff.py"' 15 "" $EVENTS
check "check: not registered is exit 1"                   '[ $rc -eq 1 ]'
# shellcheck disable=SC2086
reg apply desk-handoff.py 'python3 "/h/desk-handoff.py"' 15 "" $EVENTS
q(){ python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$SETTINGS" "$1"; }
check "apply: each of the four events runs the hook"      '[ "$(q "sum(1 for ev in \"$EVENTS\".split() for e in d[\"hooks\"][ev] for h in e[\"hooks\"] if h[\"command\"]==\"python3 \\\"/h/desk-handoff.py\\\"\" and h[\"timeout\"]==15)")" = 4 ]'
check "apply: other settings and hooks are kept"          '[ "$(q "d[\"model\"]")" = opus ] && [ "$(q "d[\"hooks\"][\"Stop\"][0][\"hooks\"][0][\"command\"]")" = mine.sh ]'
# shellcheck disable=SC2086
reg check desk-handoff.py 'python3 "/h/desk-handoff.py"' 15 "" $EVENTS
check "check after apply: exit 0"                         '[ $rc -eq 0 ]'
# shellcheck disable=SC2086
reg apply desk-handoff.py 'python3 "/h/desk-handoff.py"' 15 "" $EVENTS
check "apply again adds nothing"                          '[ "$(q "len(d[\"hooks\"][\"Stop\"])")" = 2 ]'
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["hooks"]["Stop"]=d["hooks"]["Stop"][:1]; json.dump(d,open(p,"w"))' "$SETTINGS"
# shellcheck disable=SC2086
reg apply desk-handoff.py 'python3 "/h/desk-handoff.py"' 15 "" $EVENTS
check "one event missing: only it is added back"          '[ $rc -eq 0 ] && [ "$(q "[len(d[\"hooks\"][ev]) for ev in \"$EVENTS\".split()]")" = "[1, 1, 2, 1]" ]'
reg apply deny-ai-attribution.py 'python3 "/h/deny.py"' 10 Bash PreToolUse
check "a matcher is written when given"                   '[ "$(q "d[\"hooks\"][\"PreToolUse\"][0][\"matcher\"]")" = Bash ] && [ "$(q "\"matcher\" in d[\"hooks\"][\"SessionStart\"][0]")" = False ]'
: > "$SETTINGS"
reg apply desk-update-check.sh 'bash "/h/u.sh"' 15 "" SessionStart
check "an empty settings.json is treated as {}"           '[ $rc -eq 0 ] && [ "$(q "d[\"hooks\"][\"SessionStart\"][0][\"hooks\"][0][\"command\"]")" = "bash \"/h/u.sh\"" ]'
printf '{not json' > "$SETTINGS"
reg check desk-update-check.sh 'bash "/h/u.sh"' 15 "" SessionStart
check "unreadable settings.json: exit 2, untouched"       '[ $rc -eq 2 ] && [ "$out" = "{not json" ]'

echo "$PASS checks passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
