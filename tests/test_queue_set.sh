#!/usr/bin/env bash
# queue.mjs set must store a value opening with { or [ as JSON, refuse an invalid one, and keep an
# object's other keys when one nested key is set.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home"; mkdir -p "$HOME"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
cat > "$T/config.md" <<'EOF'
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | `acme/widgets` |
| Default branch | `main` |
EOF
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo"
git init -q "$T/repo"; mkdir -p "$T/repo/.claude"
R="$(cd "$T/repo" && pwd -P)"   # git reports the resolved root (/private/var on macOS)
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
# r <path>: the JSON of T-1's field at that dotted path.
r(){ out=$(node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets["T-1"]; for (const p of process.argv[2].split(".")) v = v?.[p]; console.log(JSON.stringify(v));' "$DESK_QUEUE" "$1"); }

q init t; q add T-1

q set T-1 'result={"pr":12,"summary":"done"}'
r result.pr;                check "object is stored as JSON"              '[ $rc -eq 0 ] && [ "$out" = 12 ]'
q set T-1 result.pr=13
r result;                   check "nested set keeps the other keys"       '[ "$out" = "{\"pr\":13,\"summary\":\"done\"}" ]'

q set T-1 'deps=["T-2","T-3"]'
r deps;                     check "array is stored as JSON"               '[ $rc -eq 0 ] && [ "$out" = "[\"T-2\",\"T-3\"]" ]'

q set T-1 state=done 'result={"pr":'
check "invalid JSON is an error"                                          '[ $rc -ne 0 ] && [[ "$out" == *"not valid JSON"* ]]'
r result.pr;                check "invalid JSON writes nothing"           '[ "$out" = 13 ]'
r state;                    check "nor the other pairs"                   '[ "$out" != "\"done\"" ]'

q set T-1 lane=A open_questions=0 park=null
r lane;                     check "plain string unchanged"                '[ "$out" = "\"A\"" ]'
r open_questions;           check "integer unchanged"                     '[ "$out" = 0 ]'
r park;                     check "null unchanged"                        '[ "$out" = null ]'

q set-batch 'meta={"a":1}'
out=$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).meta))' "$DESK_QUEUE")
check "set-batch takes JSON too"                                          '[ "$out" = "{\"a\":1}" ]'

# init refuses, before touching the queue, when the repo's settings start sessions in dontAsk
printf '{"permissions":{"defaultMode":"dontAsk"}}\n' > "$T/repo/.claude/settings.json"
q init t2
check "init refuses under dontAsk"                                        '[ $rc -ne 0 ] && [[ "$out" == *"defaultMode is dontAsk: the orchestrator cannot ask questions or run monitors"* ]] && [[ "$out" == *"$R/.claude/settings.json"* ]]'
out=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).batch)' "$DESK_QUEUE")
check "a refused init leaves the queue alone"                             '[ "$out" = t ]'
out=$(node "$B/desk-env.mjs" default-mode 2>&1); rc=$?
check "desk-env default-mode exits 1 and names the file"                  '[ $rc -eq 1 ] && [[ "$out" == *"DEFAULT_MODE=dontAsk"* ]] && [[ "$out" == *"SOURCE=$R/.claude/settings.json"* ]]'
out=$(AUTOPILOT_ALLOW_DONTASK=1 node "$B/queue.mjs" init t3 2>&1); rc=$?
check "AUTOPILOT_ALLOW_DONTASK=1 overrides"                               '[ $rc -eq 0 ]'
printf '{"permissions":{"defaultMode":"default"}}\n' > "$T/repo/.claude/settings.local.json"
q init t4
check "settings.local.json outranks settings.json"                        '[ $rc -eq 0 ]'
rm -f "$T/repo/.claude/settings.local.json" "$T/repo/.claude/settings.json"
mkdir -p "$HOME/.claude"; printf '{"permissions":{"defaultMode":"dontAsk"}}\n' > "$HOME/.claude/settings.json"
q init t5
check "user-level dontAsk is caught too"                                  '[ $rc -ne 0 ] && [[ "$out" == *"$HOME/.claude/settings.json"* ]]'
rm -f "$HOME/.claude/settings.json"
out=$(node "$B/desk-env.mjs" default-mode 2>&1); rc=$?
check "no defaultMode anywhere: unset, exit 0"                            '[ $rc -eq 0 ] && [[ "$out" == *"DEFAULT_MODE=unset"* ]]'

rm -rf "$T"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
