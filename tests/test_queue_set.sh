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
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json"
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

rm -rf "$T"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
