#!/usr/bin/env bash
# suite: context handoff hook (threshold, Stop block, clear/compact resume)
# layer: L2
# The context handoff hook (hooks/desk-handoff.py), fed hook inputs and fixture transcripts in a
# throwaway repo: one injection past the §2 threshold and none under it, the main chain only, the
# window (200k, [1m], a chosen model's [1m], past 200k, DESK_CONTEXT_WINDOW), the separate 1M-window row (unset, the 200k row's), a
# single Stop block, the .handoffs/ exclude, /desk-update's one-time offer-1m of a 20% 1M row
# and the -n name, and the SessionStart injection for clear and compact (fresh, unconsumed only),
# two sessions in one repo: a reserved name each, and each resuming its own handoff; and the
# session's /rename name, recorded in the handoff and given back as a /rename line after /clear; and
# worker mode (DS-1037): a mid-stage handoff at the handoff-threshold lever's value or the §2 rows.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"
: > "$GIT_CONFIG_GLOBAL"
mkdir -p "$T/desk"; ln -s "$SRC/desk/bin" "$T/desk/bin"
export DESK_HOME="$T/desk" DESK_CONFIG="$T/config.md" DESK_MACHINE="$T/machine.md"
unset DESK_REPO_DIR DESK_CONTEXT_WINDOW ANTHROPIC_MODEL DESK_REPO_OVERRIDE CLAUDE_CODE_DISABLE_1M_CONTEXT CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
HOOK="$SRC/hooks/desk-handoff.py"
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

R="$T/repo"; git init -q -b main "$R"; git -C "$R" remote add origin https://github.com/acme/demo.git
R="$(cd "$R" && pwd -P)"  # the hook prints the resolved path (/private/var on macOS)
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
# hook <event> <session> <transcript> [extra json fields]; each session is its own Claude process,
# unless PID names the one it shares (a /clear keeps the process and mints a new session id)
hook(){ out=$(printf '{"hook_event_name":"%s","session_id":"%s","transcript_path":"%s","cwd":"%s"%s}' \
  "$1" "$2" "$3" "$R/sub" "${4:-}" | DESK_HANDOFF_PID="${PID:-$2}" python3 "$HOOK" 2>&1); rc=$?; }
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
check "#811: it says to record each action left for the person with needs-you.mjs ask" '[[ "$c" == *"needs-you.mjs ask <SLUG from desk-env where>"* ]]'
check "#835: it asks for /clear, then /desk-resume, which carries on from the next step" '[[ "$c" == *"type /clear, then /desk-resume"* ]]'
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
config '`45`' '`20`'
transcript "$T/190k.jsonl" 190000
hook SessionStart s40 "$T/190k.jsonl" ',"source":"startup","model":"claude-opus-5-5[1m]"'
hook PostToolUse s40 "$T/190k.jsonl"
check "DS-199 AC3: a 1M row at 20, 190k of 1M: nothing"   '[ -z "$out" ]'
transcript "$T/210k.jsonl" 210000
hook PostToolUse s40 "$T/210k.jsonl"
check "DS-199 AC3: past 200k of 1M fires at 20"           '[[ "$(ctx)" == *"context is at 21% of a 1,000,000-token window (threshold 20%)"* ]]'

# ---- SessionStart's model id has no [1m]; the user's chosen model says it ----
config '`45`' '`10`'
mkdir -p "$HOME/.claude"; printf '{"model":"opus[1m]"}\n' > "$HOME/.claude/settings.json"
hook SessionStart s50 "$T/high.jsonl" ',"source":"startup","model":"claude-opus-4-6"'
hook PostToolUse s50 "$T/high.jsonl"
check "DS-270 AC1: settings opus[1m], id claude-opus-4-6: 1M" '[[ "$(ctx)" == *"context is at 10% of a 1,000,000-token window (threshold 10%)"* ]]'
hook SessionStart s51 "$T/high.jsonl" ',"source":"startup","model":"claude-sonnet-4-6"'
hook PostToolUse s51 "$T/high.jsonl"
check "DS-270: settings opus[1m], a sonnet session: 200k"  '[[ "$(ctx)" == *"context is at 50% of a 200,000-token window (threshold 45%)"* ]]'
out=$(printf '{"hook_event_name":"PostToolUse","session_id":"s52","transcript_path":"%s","cwd":"%s"}' "$T/low.jsonl" "$R" | DESK_CONTEXT_WINDOW=100000 python3 "$HOOK")
check "DS-270 AC3: DESK_CONTEXT_WINDOW wins over settings" '[[ "$(ctx)" == *"context is at 50% of a 100,000-token window (threshold 45%)"* ]]'
printf '{"model":"opus"}\n' > "$HOME/.claude/settings.json"
hook SessionStart s53 "$T/high.jsonl" ',"source":"startup","model":"claude-opus-4-6"'
hook PostToolUse s53 "$T/high.jsonl"
check "DS-270 AC2: no [1m] anywhere: 200k"                 '[[ "$(ctx)" == *"context is at 50% of a 200,000-token window (threshold 45%)"* ]]'
hook SessionStart s54 "$T/high.jsonl" ',"source":"startup","model":"claude-opus-4-6"'
out=$(printf '{"hook_event_name":"PostToolUse","session_id":"s54","transcript_path":"%s","cwd":"%s"}' "$T/high.jsonl" "$R/sub" | ANTHROPIC_MODEL='claude-opus-5-5[1m]' python3 "$HOOK")
check "DS-270 AC1: ANTHROPIC_MODEL [1m] wins over settings" '[[ "$(ctx)" == *"of a 1,000,000-token window (threshold 10%)"* ]]'
rm -f "$HOME/.claude/settings.json"
config '`45`'

# ---- a model whose default window is 1M needs no [1m] (Claude Code's model docs: Fable, Sonnet 5+,
# Haiku 5.5+, Opus 4.7+); one that reaches 1M only through [1m] stays 200k; CLAUDE_CODE_DISABLE_1M_CONTEXT
# holds every model to 200k ----
config '`45`' '`10`'
win(){ s="w-$1${2:+-off}"; hook SessionStart "$s" "$T/high.jsonl" ",\"source\":\"startup\",\"model\":\"$1\""
  out=$(printf '{"hook_event_name":"PostToolUse","session_id":"%s","transcript_path":"%s","cwd":"%s"}' "$s" "$T/high.jsonl" "$R" | env ${2:+$2} python3 "$HOOK")
  case "$(ctx)" in *"1,000,000-token window"*) echo 1M ;; *"200,000-token window"*) echo 200k ;; *) echo none ;; esac; }
for m in claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5 claude-fable-5-2 claude-opus-4-7; do
  check "#745: $m, no [1m] anywhere, is 1M" '[ "$(win '"$m"')" = 1M ]'
done
for m in claude-opus-4-6 claude-sonnet-4-6 claude-haiku-4-5-20251001; do
  check "#745: $m, no [1m] anywhere, is 200k" '[ "$(win '"$m"')" = 200k ]'
done
check "#745: CLAUDE_CODE_DISABLE_1M_CONTEXT holds a default-1M model to 200k" '[ "$(win claude-opus-5-5 CLAUDE_CODE_DISABLE_1M_CONTEXT=1)" = 200k ]'
check "#745: CLAUDE_CODE_DISABLE_1M_CONTEXT holds a [1m] model to 200k" '[ "$(win claude-opus-4-6[1m] CLAUDE_CODE_DISABLE_1M_CONTEXT=1)" = 200k ]'
printf '{"model":"opus[1m]"}\n' > "$HOME/.claude/settings.json"
check "#745: and a chosen [1m] model too" '[ "$(win claude-opus-4-6 CLAUDE_CODE_DISABLE_1M_CONTEXT=1)" = 200k ]'
rm -f "$HOME/.claude/settings.json"
config '`45`'

# ---- /desk-update offers to lower a 1M threshold of 45 to 20, once ----
offer(){ out=$(python3 "$HOOK" offer-1m "$@" "$R/sub" 2>&1); rc=$?; }
config '`45`'
offer
check "DS-199 AC2: unset under a 45 row is offered"       '[ $rc -eq 0 ] && [[ "$out" == "handoff at 45%"*"to 20"*"53%"* ]]'
config '`45`' '`45`'
offer
check "DS-199 AC2: a 1M row at 45 is offered"             '[ $rc -eq 0 ] && [[ "$out" == "handoff at 45%"* ]]'
config '`45`' '`20`'
offer
check "DS-199 AC2: a 1M row at 20 is not"                 '[ $rc -eq 1 ] && [ -z "$out" ]'
config '`60`'
offer
check "DS-199 AC2: unset under a 60 row is not"           '[ $rc -eq 1 ] && [ -z "$out" ]'
config '`45`'; before="$(cat "$DESK_CONFIG")"
DESK_CONFIG="$T/missing.md" offer
check "DS-199 AC2: no desk config: not offered"           '[ $rc -eq 1 ] && [ -z "$out" ]'
offer --asked
check "DS-199 AC2: --asked records it"                    '[ $rc -eq 0 ] && [ -f "$DESK_HOME/handoff/offered-1m-acme__demo.json" ]'
offer
check "DS-199 AC2: once asked, never offered again"       '[ $rc -eq 1 ] && [ -z "$out" ]'
check "DS-199 AC2: and the config is unchanged"           '[ "$(cat "$DESK_CONFIG")" = "$before" ]'

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
check "#835: the Stop block asks for /clear, then /desk-resume" '[[ "$out" == *"type /clear, then /desk-resume"* ]]'
hook Stop s1 "$T/high.jsonl" ',"stop_hook_active":false'
check "the marker stops a second block"                   '[ -z "$out" ]'
hook Stop s3 "$T/side.jsonl"
check "Stop never blocks a session that has not fired"    '[ -z "$out" ]'
mkdir -p "$R/.handoffs"; echo "# handoff" > "$R/.handoffs/$DAY.md"
hook Stop s2 "$T/high.jsonl"
check "Stop with another session's handoff written: still blocks" '[[ "$out" == *"write the handoff first"* ]]'
hook PostToolUse s13 "$T/high.jsonl"
s13_handoff=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("handoff", ""))' "$DESK_HOME/handoff/s13.json")
check "a fired session's handoff is its own placeholder"  '[ -n "$s13_handoff" ] && grep -q "placeholder.*session s13" "$s13_handoff"'
echo "# handoff" > "$s13_handoff"
hook Stop s13 "$T/high.jsonl"
check "Stop with its own handoff written: none"           '[ -z "$out" ]'
age "$s13_handoff" 90003
hook Stop s4 "$T/500k.jsonl" ',"stop_hook_active":true'
check "stop_hook_active: never blocks"                    '[ -z "$out" ]'
hook PostToolUse s11 "$T/high.jsonl"
c="$(ctx)"
check "AC3: an existing <date>.md gives a later <date>-n.md" '[[ "$c" == *"$R/.handoffs/$DAY-"* ]] && [[ "$c" != *"$R/.handoffs/$DAY.md"* ]]'

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
check "compact: its own handoff, already consumed, is not offered" '[ -z "$out" ]'
hook SessionStart s3 "$T/low.jsonl" ',"source":"compact"'
check "#865: compact with no handoff of its own injects none, not another session's newest" '[ -z "$out" ]'
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

# ---- #865: compaction mode (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE set): no /clear, one handoff kept ----
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook PostToolUse c1 "$T/high.jsonl"
c="$(ctx)"; CP="$(printf '%s' "$c" | grep -o "$R/.handoffs/[^ ]*\.md" | head -1)"
check "#865 with the override set, the threshold asks for the handoff and to keep working" '[[ "$c" == *"context is at 50%"* ]] && [[ "$c" == *"compacts on its own"* ]] && [[ "$c" == *"write the handoff at $CP"* ]] && [[ "$c" == *"carry on with the work"* ]]'
check "#865 and asks for no /clear or /desk-resume"        '[[ "$c" != *"type /clear, then"* ]] && [[ "$c" != *"/desk-resume"* ]]'
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook Stop c1 "$T/high.jsonl"
check "#865 the Stop block asks for the handoff, not /clear" '[[ "$out" == *"\"decision\": \"block\""* ]] && [[ "$out" == *"$CP"* ]] && [[ "$out" != *"/clear, then"* ]] && [[ "$out" == *"do not ask the user to /clear"* ]]'
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook PreCompact c1 "$T/high.jsonl" ',"trigger":"auto"'
check "#865 PreCompact says nothing while the handoff is unwritten" '[ $rc -eq 0 ] && [ -z "$out" ]'
echo "# compacting session" > "$CP"
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook PreCompact c1 "$T/high.jsonl" ',"trigger":"auto"'
check "#865 PreCompact names the written handoff for the summary" '[ $rc -eq 0 ] && [[ "$out" == *"$CP"* ]] && [[ "$out" == *"next step"* ]]'
hook PreCompact c1 "$T/high.jsonl" ',"trigger":"auto"'
check "#865 without the override, PreCompact says nothing" '[ -z "$out" ]'
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook SessionStart c1 "$T/low.jsonl" ',"source":"compact"'
check "#865 after the compaction, the session is told to read its handoff" '[[ "$(ctx)" == *"read .handoffs/$(basename "$CP")"* ]]'
check "#865 and the handoff is not marked consumed"        '! grep -qx "$(basename "$CP")" "$R/.handoffs/.consumed"'
age "$CP" 60
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook PostToolUse c1 "$T/compacted-high.jsonl"
c="$(ctx)"
check "#865 the next crossing refreshes the same handoff, not a new one" '[[ "$c" == *"refresh the handoff at $CP"* ]]'
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook PreCompact c1 "$T/high.jsonl" ',"trigger":"auto"'
check "#865 PreCompact says nothing while the kept handoff is not yet refreshed" '[ -z "$out" ]'
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook Stop c1 "$T/high.jsonl"
check "#865 Stop blocks until the kept handoff is refreshed" '[[ "$out" == *"write the handoff first"* ]] && [[ "$out" == *"$CP"* ]]'
echo "# compacting session, refreshed" > "$CP"
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 hook PreCompact c1 "$T/high.jsonl" ',"trigger":"auto"'
check "#865 once refreshed, PreCompact names it"           '[[ "$out" == *"$CP"* ]]'
hook SessionStart x1 "$T/low.jsonl" ',"source":"clear"'
check "#865 another session's /clear does not take the handoff a compacting session holds" '[[ "$(ctx)" != *"$(basename "$CP")"* ]] && ! grep -qx "$(basename "$CP")" "$R/.handoffs/.consumed"'
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 PID=c1 hook SessionStart c2 "$T/low.jsonl" ',"source":"clear"'
check "#865 a /clear after it still finds the handoff, and consumes it" '[[ "$(ctx)" == *"read .handoffs/$(basename "$CP")"* ]] && grep -qx "$(basename "$CP")" "$R/.handoffs/.consumed"'
# Between the handoff being written and the compaction, another session's /clear leaves it alone; a
# second compaction with no crossing since does not hand over the handoff written before the first.
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 PID=m1 hook PostToolUse m1 "$T/high.jsonl"
MP="$(ctx | grep -o "$R/.handoffs/[^ ]*\.md" | head -1)"; echo "# m1" > "$MP"
hook SessionStart m9 "$T/low.jsonl" ',"source":"clear"'
check "#865 before its compaction, another session's /clear does not take a compacting session's handoff" '[ -n "$MP" ] && [[ "$(ctx)" != *"$(basename "$MP")"* ]] && ! grep -qx "$(basename "$MP")" "$R/.handoffs/.consumed"'
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 PID=m1 hook SessionStart m1 "$T/low.jsonl" ',"source":"compact"'
check "#865 and its own compaction still reads it"         '[[ "$(ctx)" == *"read .handoffs/$(basename "$MP")"* ]]'
age "$MP" 30
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 PID=m1 hook PreCompact m1 "$T/low.jsonl" ',"trigger":"manual"'
check "#865 a second compaction with no crossing since: PreCompact names no stale handoff" '[ -z "$out" ]'
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 PID=m1 hook SessionStart m1 "$T/low.jsonl" ',"source":"compact"'
check "#865 and the compaction injects none"               '[ -z "$out" ]'

# A hold whose Claude process has exited no longer keeps the handoff from another session's /clear.
echo "# orphan" > "$R/.handoffs/orphan-865.md"
DEAD=99999999; printf 'orphan-865.md %s\n' "$DEAD" >> "$R/.handoffs/.held"
hook SessionStart o9 "$T/low.jsonl" ',"source":"clear"'
check "#865 a handoff held by a Claude process that has exited is taken by the next /clear" '[[ "$(ctx)" == *"read .handoffs/orphan-865.md"* ]]'
echo "# reused" > "$R/.handoffs/reused-865.md"
printf 'reused-865.md %s Thu1Jan00:00:001970\n' "$$" >> "$R/.handoffs/.held"
hook SessionStart o8 "$T/low.jsonl" ',"source":"clear"'
check "#865 so is one whose pid now belongs to a process that started later" '[[ "$(ctx)" == *"read .handoffs/reused-865.md"* ]]'
# fn <name> <args...>: call one of the hook's functions directly, printing its result
printf 'import importlib.util as u, sys\ns = u.spec_from_file_location("h", sys.argv[1]); m = u.module_from_spec(s); s.loader.exec_module(m)\nprint(getattr(m, sys.argv[2])(*sys.argv[3:]))\n' > "$T/fn.py"
fn(){ python3 "$T/fn.py" "$HOOK" "$@"; }
echo "# live" > "$R/.handoffs/live-865.md"
printf 'live-865.md %s %s\n' "$$" "$(fn process_start $$)" >> "$R/.handoffs/.held"
hook SessionStart o7 "$T/low.jsonl" ',"source":"clear"'
check "#865 while one held by a running process, started when it did, is skipped" '[[ "$(ctx)" != *"live-865.md"* ]]'
ST="$(TZ=Asia/Tokyo LC_ALL=C fn process_start $$)"
check "#865 a start time read under another TZ and locale still matches" '[ "$(TZ=America/New_York fn process_alive $$ "$ST")" = True ]'
check "#865 a pid held by another user's process that started at another time has lapsed" '[ "$(fn process_alive 1 t0)" = False ]'

# A /clear straight after a compaction, with no crossing since, still finds the session's own handoff
# when another session's is newer.
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 PID=k1 hook PostToolUse k1 "$T/high.jsonl"
KP="$(ctx | grep -o "$R/.handoffs/[^ ]*\.md" | head -1)"; echo "# k1" > "$KP"
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 PID=k1 hook SessionStart k1 "$T/low.jsonl" ',"source":"compact"'
age "$KP" 30; echo "# another session" > "$R/.handoffs/other-865.md"
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 PID=k1 hook SessionStart k2 "$T/low.jsonl" ',"source":"clear"'
check "#865 a /clear right after a compaction reads its own handoff, not another's newer one" '[ -n "$KP" ] && [[ "$(ctx)" == *"read .handoffs/$(basename "$KP")"* ]]'

# ---- DS-282: two sessions in one repo each keep their own handoff ----
rm -rf "$R/.handoffs"
hook PostToolUse a1 "$T/high.jsonl"
check "DS-282: session A is named <date>.md"              '[[ "$(ctx)" == *"$R/.handoffs/$DAY.md"* ]]'
hook PostToolUse b1 "$T/high.jsonl"
c="$(ctx)"
check "DS-282 AC1: B, before A writes, gets <date>-2.md"  '[[ "$c" == *"$R/.handoffs/$DAY-2.md"* ]] && [[ "$c" != *"$R/.handoffs/$DAY.md"* ]]'
check "DS-282 AC2: A's name exists at once, one line naming A" '[ "$(wc -l < "$R/.handoffs/$DAY.md")" -eq 1 ] && grep -q "placeholder.*session a1" "$R/.handoffs/$DAY.md"'
check "DS-282 AC2: and B is told to read it, then replace it" '[[ "$c" == *"placeholder"* ]] && [[ "$c" == *"read it, then replace it whole"* ]]'
hook Stop a1 "$T/high.jsonl"
check "DS-282: a placeholder does not count as written at Stop" '[[ "$out" == *"write the handoff first"* ]]'
hook SessionStart c1 "$T/low.jsonl" ',"source":"clear"'
check "DS-282 AC5: an unfilled placeholder is not offered" '[ -z "$out" ]'
PID=a1 hook SessionStart a2 "$T/low.jsonl" ',"source":"clear"'
check "DS-282 AC5: nor to the session that reserved it"   '[ -z "$out" ]'
echo "# A" > "$R/.handoffs/$DAY.md"
hook Stop b1 "$T/high.jsonl"
check "DS-282: A's written handoff does not release B's Stop" '[[ "$out" == *"write the handoff first"* ]] && [[ "$out" == *"$DAY-2.md"* ]]'
age "$R/.handoffs/$DAY.md" 60
echo "# B" > "$R/.handoffs/$DAY-2.md"
PID=a1 hook SessionStart a3 "$T/low.jsonl" ',"source":"clear"'
check "DS-282 AC3: A's next session reads A's, not B's newer one" '[[ "$(ctx)" == *"read .handoffs/$DAY.md"* ]]'
PID=b1 hook SessionStart b2 "$T/low.jsonl" ',"source":"clear"'
check "DS-282 AC3: and B's reads B's"                     '[[ "$(ctx)" == *"read .handoffs/$DAY-2.md"* ]]'
echo "# C" > "$R/.handoffs/$DAY-9.md"
hook SessionStart d1 "$T/low.jsonl" ',"source":"clear"'
check "DS-282 AC4: no handoff recorded: the newest fresh one" '[[ "$(ctx)" == *"read .handoffs/$DAY-9.md"* ]]'
age "$R/.handoffs/$DAY-9.md" 30; echo "# A again" > "$R/.handoffs/$DAY-10.md"
PID=a1 hook SessionStart a4 "$T/low.jsonl" ',"source":"clear"'
check "DS-282 AC4: A's second /clear, nothing new recorded: the newest" '[[ "$(ctx)" == *"read .handoffs/$DAY-10.md"* ]]'

# ---- the session's name survives /clear ----
rm -rf "$R/.handoffs"
cp "$T/high.jsonl" "$T/named.jsonl"
printf '{"type":"custom-title","customTitle":"demo-old","sessionId":"w1"}\n{"type":"custom-title","customTitle":"demo-batch","sessionId":"w1"}\n' >> "$T/named.jsonl"
hook PostToolUse w1 "$T/named.jsonl"
c="$(ctx)"
check "a /renamed session is told to record its last name in the handoff" '[[ "$c" == *"Session name: demo-batch"* ]] && [[ "$c" != *"demo-old"* ]]'
hook PostToolUse w2 "$T/high.jsonl"
c="$(ctx)"
check "an unnamed one is given the role names for this repo" '[[ "$c" == *"no name"* ]] && [[ "$c" == *"demo-batch"* ]] && [[ "$c" == *"demo-ticket-<KEY>"* ]] && [[ "$c" == *"demo-orchestrator"* ]]'
printf '# Handoff\n\n- **Session name:** `demo-batch`\n' > "$R/.handoffs/$DAY.md"
age "$R/.handoffs/$DAY.md" 60
printf '# Handoff\n\nSession name: <repo>-ticket-<KEY>\n' > "$R/.handoffs/$DAY-2.md"
PID=w1 hook SessionStart w3 "$T/low.jsonl" ',"source":"clear"'
check "after /clear, the injection gives the /rename line from the handoff" '[[ "$(ctx)" == *"print the line \`/rename demo-batch\`"* ]]'
PID=w2 hook SessionStart w4 "$T/low.jsonl" ',"source":"clear"'
c="$(ctx)"
check "a handoff whose name is still a placeholder gives no /rename line" '[[ "$c" == *"read .handoffs/$DAY-2.md"* ]] && [[ "$c" != *"/rename"* ]]'
{ printf '{"type":"custom-title","customTitle":"Release prep","sessionId":"w5"}\n'
  python3 -c 'import sys; sys.stdout.write(("{\"type\":\"user\",\"message\":{\"content\":\"%s\"}}\n" % ("x" * 1000)) * 9000)'
  cat "$T/high.jsonl"; } > "$T/big.jsonl"
hook PostToolUse w5 "$T/big.jsonl"
check "a name set before the last 8 MB of the transcript is still found" '[[ "$(ctx)" == *"Session name: Release prep"* ]]'
printf '# Handoff\n\nSession name: `Release prep`\n' > "$R/.handoffs/$DAY-3.md"
PID=w5 hook SessionStart w6 "$T/low.jsonl" ',"source":"clear"'
check "a name with a space comes back whole as the /rename line" '[[ "$(ctx)" == *"print the line \`/rename Release prep\`"* ]]'
for form in '**Session name: widgets-batch**' 'Session name: "widgets-batch"' '- Session name: bugs < 5'; do
  rm -f "$R/.handoffs/.consumed"; printf '# Handoff\n\n%s\n' "$form" > "$R/.handoffs/$DAY-3.md"
  want="${form#*name: }"; want="${want%\*\*}"; want="${want//\"/}"
  PID=w5 hook SessionStart w7 "$T/low.jsonl" ',"source":"clear"'
  check "the /rename line from \"$form\" is /rename $want" '[[ "$(ctx)" == *"print the line \`/rename $want\`"* ]]'
done

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
EVENTS="$(sed -n 's/^HANDOFF_EVENTS="\(.*\)"$/\1/p' "$SRC/install.sh")"
check "HANDOFF_EVENTS is read from install.sh, PreCompact among them" '[[ " $EVENTS " == *" PreCompact "* ]]'
printf '{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"mine.sh"}]}]}}\n' > "$SETTINGS"
reg(){ rc=0; register_hook "$@" || rc=$?; out=$(cat "$SETTINGS" 2>/dev/null); }
# shellcheck disable=SC2086
reg check desk-handoff.py 'python3 "/h/desk-handoff.py"' 15 "" $EVENTS
check "check: not registered is exit 1"                   '[ $rc -eq 1 ]'
# shellcheck disable=SC2086
reg apply desk-handoff.py 'python3 "/h/desk-handoff.py"' 15 "" $EVENTS
q(){ python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$SETTINGS" "$1"; }
check "apply: each of the five events runs the hook"      '[ "$(q "sum(1 for ev in \"$EVENTS\".split() for e in d[\"hooks\"][ev] for h in e[\"hooks\"] if h[\"command\"]==\"python3 \\\"/h/desk-handoff.py\\\"\" and h[\"timeout\"]==15)")" = 5 ]'
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
check "one event missing: only it is added back"          '[ $rc -eq 0 ] && [ "$(q "[len(d[\"hooks\"][ev]) for ev in \"$EVENTS\".split()]")" = "[1, 1, 2, 1, 1]" ]'
reg apply deny-ai-attribution.py 'python3 "/h/deny.py"' 10 Bash PreToolUse
check "a matcher is written when given"                   '[ "$(q "d[\"hooks\"][\"PreToolUse\"][0][\"matcher\"]")" = Bash ] && [ "$(q "\"matcher\" in d[\"hooks\"][\"SessionStart\"][0]")" = False ]'
: > "$SETTINGS"
reg apply desk-update-check.sh 'bash "/h/u.sh"' 15 "" SessionStart
check "an empty settings.json is treated as {}"           '[ $rc -eq 0 ] && [ "$(q "d[\"hooks\"][\"SessionStart\"][0][\"hooks\"][0][\"command\"]")" = "bash \"/h/u.sh\"" ]'
printf '{not json' > "$SETTINGS"
reg check desk-update-check.sh 'bash "/h/u.sh"' 15 "" SessionStart
check "unreadable settings.json: exit 2, untouched"       '[ $rc -eq 2 ] && [ "$out" = "{not json" ]'

# ---- install.sh's settings_env, which offers compaction mode, on a throwaway settings.json ----
eval "$(sed -n '/^settings_env() {$/,/^}$/p' "$SRC/install.sh")"
check "settings_env is found in install.sh"               'declare -F settings_env >/dev/null'
printf '{"model":"opus","env":{"FOO":"1"}}\n' > "$SETTINGS"
rc=0; settings_env check CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 55 || rc=$?
check "settings_env check: unset is exit 1"               '[ $rc -eq 1 ]'
rc=0; settings_env apply CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 55 || rc=$?
check "settings_env apply: sets it and keeps the rest"    '[ $rc -eq 0 ] && [ "$(q "d[\"env\"][\"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE\"]")" = 55 ] && [ "$(q "d[\"env\"][\"FOO\"]+d[\"model\"]")" = 1opus ]'
printf '{"env":{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"30"}}\n' > "$SETTINGS"
rc=0; settings_env apply CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 55 || rc=$?
check "settings_env: a value already set is kept"         '[ $rc -eq 0 ] && [ "$(q "d[\"env\"][\"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE\"]")" = 30 ]'
printf '{not json' > "$SETTINGS"
rc=0; settings_env apply CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 55 || rc=$?
check "settings_env: unreadable settings.json is exit 2, untouched" '[ $rc -eq 2 ] && [ "$(cat "$SETTINGS")" = "{not json" ]'

# ---- DS-1037: worker mode, a mid-stage handoff at the lever's value or the §2 rows ----
# wtranscript <file> <main-chain tokens> <the worker's last stage line>
wtranscript(){ transcript "$1" "$2"
  printf '{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"Verified.\\nAUTOPILOT_STAGE: %s\\n"}]}}\n' "$3" >> "$1"; }
WFILE="$T/state/handoffs/W-1.json"; mkdir -p "$T/state/handoffs"
whook(){ DESK_AUTOPILOT_WORKER=1 DESK_HANDOFF_FILE="$WFILE" DESK_LEVER_VALUES="${LV:-}" hook "$@"; }
config '`45`' '`20`'
before="$(ls "$R/.handoffs" 2>/dev/null | wc -l | tr -d ' ')"
LV='question-handling=batched handoff-threshold=30'
wtranscript "$T/w25.jsonl" 50000 "5/9 evidence"
whook PostToolUse wk1 "$T/w25.jsonl"
check "DS-1037 AC2 drawn 30: 25% of 200k mid-stage injects nothing"       '[ $rc -eq 0 ] && [ -z "$out" ]'
wtranscript "$T/w32.jsonl" 64000 "5/9 evidence"
whook PostToolUse wk1 "$T/w32.jsonl"
c="$(ctx)"
check "DS-1037 AC2 drawn 30: at 32% it hands off partway through Stage 5"  '[[ "$c" == *"context is at 32% of a 200,000-token window"* ]] && [[ "$c" == *"threshold of 30% (handoff-threshold 30), partway through Stage 5"* ]]'
check "DS-1037 AC2 it says to commit, write the briefing for Stage 5 and print the marker" '[[ "$c" == *"commit what you have"* ]] && [[ "$c" == *"handoff.mjs write W-1 --stage 5 --context 32 --left"* ]] && [[ "$c" == *"AUTOPILOT_HANDOFF: 5"* ]] && [[ "$c" == *"Print no AUTOPILOT_DONE"* ]]'
check "DS-1037 a worker is named no .handoffs/ file"                        '[ "$(ls "$R/.handoffs" 2>/dev/null | wc -l | tr -d " ")" = "$before" ] && [[ "$c" != *".handoffs/"* ]]'
whook PostToolUse wk1 "$T/w32.jsonl"
check "DS-1037 it fires once"                                              '[ -z "$out" ]'
whook Stop wk1 "$T/w32.jsonl"
check "DS-1037 Stop blocks once while the briefing is unwritten"           '[[ "$out" == *"\"decision\": \"block\""* ]] && [[ "$out" == *"write the handoff briefing first"* ]] && [[ "$out" == *"AUTOPILOT_HANDOFF: 5"* ]]'
whook Stop wk1 "$T/w32.jsonl"
check "DS-1037 and only once"                                              '[ -z "$out" ]'
wtranscript "$T/w40s2.jsonl" 80000 "2/9 understand"
whook PostToolUse wk2 "$T/w40s2.jsonl"
check "DS-1037 before Stage 3 no fresh session can start there: nothing"   '[ -z "$out" ]'
wtranscript "$T/w40s3.jsonl" 80000 "3/9 implement"
whook PostToolUse wk2 "$T/w40s3.jsonl"
check "DS-1037 once it reaches Stage 3 it hands off there"                 '[[ "$(ctx)" == *"partway through Stage 3"* ]]'
echo '{"ticket":"W-1"}' > "$WFILE"
whook Stop wk2 "$T/w40s3.jsonl"
check "DS-1037 with the briefing written, Stop does not block"             '[ -z "$out" ]'
whook SessionStart wk3 "$T/w32.jsonl" ',"source":"startup","model":"claude-opus-5-5"'
wtranscript "$T/w31m.jsonl" 310000 "4b/9 self-review"
whook PostToolUse wk3 "$T/w31m.jsonl"
check "DS-1037 the drawn value holds on a 1M window too"                   '[[ "$(ctx)" == *"31% of a 1,000,000-token window, past this worker'"'"'s threshold of 30% (handoff-threshold 30), partway through Stage 4b"* ]]'
LV=''
wtranscript "$T/w40.jsonl" 80000 "5/9 evidence"
whook PostToolUse wk4 "$T/w40.jsonl"
check "DS-1037 AC4 lever off: 40% of 200k is under the 45% row"             '[ -z "$out" ]'
wtranscript "$T/w46.jsonl" 92000 "5/9 evidence"
whook PostToolUse wk4 "$T/w46.jsonl"
check "DS-1037 AC4 lever off: at 46% it hands off at the 200k row"          '[[ "$(ctx)" == *"threshold of 45% (config §2 Handoff at context %), partway through Stage 5"* ]]'
LV='handoff-threshold=config'
whook SessionStart wk5 "$T/w46.jsonl" ',"source":"startup","model":"claude-opus-5-5"'
wtranscript "$T/w19m.jsonl" 190000 "5/9 evidence"
whook PostToolUse wk5 "$T/w19m.jsonl"
check "DS-1037 AC4 drawn config: 19% of a 1M window is under the 20% 1M row" '[ -z "$out" ]'
wtranscript "$T/w21m.jsonl" 210000 "5/9 evidence"
whook PostToolUse wk5 "$T/w21m.jsonl"
check "DS-1037 AC4 drawn config: at 21% it hands off at the 1M row"         '[[ "$(ctx)" == *"threshold of 20% (config §2 Handoff at context % on a 1M window)"* ]]'
whook SessionStart wk5 "$T/w21m.jsonl" ',"source":"compact"'
whook PostToolUse wk5 "$T/w21m.jsonl"
check "DS-1037 a compaction makes the next crossing a new one"             '[[ "$(ctx)" == *"partway through Stage 5"* ]]'
config '`0`'
wtranscript "$T/w90.jsonl" 180000 "5/9 evidence"
whook PostToolUse wk6 "$T/w90.jsonl"
check "DS-1037 AC4 rows at 0 and no lever value: a worker never hands off" '[ -z "$out" ]'
config '`45`'
DESK_HANDOFF_FILE="" hook PostToolUse wk7 "$T/w90.jsonl"
check "DS-1037 outside a worker, worker mode stays off"                    '[[ "$(ctx)" == *".handoffs/"* ]]'

echo "$PASS checks passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
