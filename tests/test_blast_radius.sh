#!/usr/bin/env bash
# suite: blast radius (plan-batch merges relocate, schema, shared, then surface work)
# plan-batch on fixture triage records, offline: the order it prints and why, the merge chain it
# makes between tickets that share files, and Jira Blocks links winning where they contradict the
# kinds. Scratch HOME, state and queue only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/triage"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_JIRA_NAME AUTOPILOT_WRITE_QUEUE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=${rc:-} out: ${out:-}"; fi; }
trap 'rm -rf "$T"' EXIT

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 1. Who you are
| Field | Value |
|---|---|
| GitHub handle | \`me\` |
| Jira display name | \`Me\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 4. Tracker, tools and team
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Ticket key pattern | \`KAN-[0-9]+\` |
| Local database | \`none\` |
EOF
export DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1

# rec <KEY> <change_kind, or - for none> <file>[,<file>...] [blockers json, default []] [size, default S]
rec(){ local kind="" files; [ "$2" = - ] || kind="\"change_kind\": \"$2\", \"change_kind_reason\": \"why $1\", "
  files=$(printf '%s' "$3" | tr ',' '\n' | jq -R . | jq -sc .)
  printf '{"ticket": "%s", "type": "Task", "lane": "A", "size": "%s", "summary": "s", "branch": "feat/%s", %s"files_in_scope": %s, "unknowns": [], "blockers": %s}\n' \
    "$1" "${5:-S}" "$1" "$kind" "$files" "${4:-[]}" > "$T/state/triage/$1.json"; }
nb(){ printf '[{"key": "%s", "category": "new"}]' "$1"; }
plan(){ node "$B/queue.mjs" init "t$RANDOM" >/dev/null; out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" "$@" 2>&1); rc=$?; }
qg(){ jq -r ".tickets[\"$1\"]$2" "$DESK_QUEUE"; }
seeded(){ jq -r '.tickets | keys_unsorted | join(" ")' "$DESK_QUEUE"; }
# The MERGE ORDER section's ticket keys, in order.
merge_order(){ printf '%s\n' "$out" | sed -n '/^MERGE ORDER/,/^$/p' | grep -oE '^  [0-9]+\. KAN-[0-9]+' | grep -oE 'KAN-[0-9]+' | tr '\n' ' ' | sed 's/ $//'; }

# ---- AC2: one of each kind, named smallest first, sharing no files --------------------------------
rec KAN-1 surface src/a; rec KAN-2 shared src/b; rec KAN-3 schema src/c; rec KAN-4 relocate src/d
plan KAN-1 KAN-2 KAN-3 KAN-4
check "AC2: the plan orders relocate, schema, shared, surface" '[ $rc -eq 0 ] && [ "$(merge_order)" = "KAN-4 KAN-3 KAN-2 KAN-1" ]'
check "the queue keeps the order named: spawn priority is the user's, a gate named first starts first" '[ "$(seeded)" = "KAN-1 KAN-2 KAN-3 KAN-4" ]'
check "AC2: each position says why: its kind, what that means, and triage's reason" \
  'printf "%s\n" "$out" | grep -q "^  1\. KAN-4  relocate: moves, renames or deletes files.* (why KAN-4)$" \
   && printf "%s\n" "$out" | grep -q "^  2\. KAN-3  schema: changes a schema" \
   && printf "%s\n" "$out" | grep -q "^  3\. KAN-2  shared: changes shared code" \
   && printf "%s\n" "$out" | grep -q "^  4\. KAN-1  surface: touches one surface"'

# ---- AC4: tickets that share no files are never chained, whatever their kinds ---------------------
check "AC4: no shared files, so nothing is held and there is no --deps" \
  '[ "$(jq -r "[.tickets[].state] | unique | join(\",\")" "$DESK_QUEUE")" = triaged ] && [ "$(qg KAN-1 .held_by)" = null ] && ! printf "%s" "$out" | grep -q -- "--deps"'

# ---- AC3: overlapping files chain the larger blast radius first -----------------------------------
rec KAN-11 surface src/x,src/y; rec KAN-12 relocate src/y; rec KAN-13 shared src/z
plan KAN-11 KAN-12 KAN-13
check "AC3: the relocation is first in the merge chain and the surface ticket is held behind it" \
  '[ "$(qg KAN-11 .held_by)" = KAN-12 ] && [ "$(qg KAN-11 .state)" = parked ] && [[ "$(qg KAN-11 .park.question)" == "held by orchestrator: blocked by KAN-12 (shares src/y; relocate before surface)"* ]] && [ "$(qg KAN-12 .state)" = triaged ]'
check "AC3: the chain is in the --deps it prints, and the plan says why" \
  'printf "%s\n" "$out" | grep -qx -- "--deps \"KAN-11:KAN-12\"" && printf "%s\n" "$out" | grep -q "^       after KAN-12 (shares src/y; relocate before surface)"'
check "AC4: the ticket sharing nothing runs beside them, unheld" '[ "$(qg KAN-13 .state)" = triaged ] && [ "$(qg KAN-13 .held_by)" = null ]'

# Two of a kind: the smaller first, then the order named.
rec KAN-21 shared src/s '[]' M; rec KAN-22 shared src/s '[]' XS; rec KAN-23 shared src/s '[]' XS
plan KAN-21 KAN-22 KAN-23
check "two of a kind: the smaller merges first, a tie goes to the order named" \
  '[ "$(qg KAN-22 .held_by)" = null ] && [ "$(qg KAN-23 .held_by)" = KAN-22 ] && [ "$(qg KAN-21 .held_by)" = "KAN-22|KAN-23" ] && printf "%s" "$out" | grep -q "both shared, KAN-22 is smaller" && printf "%s" "$out" | grep -q "both shared, KAN-22 named first"'

# ---- AC5: Jira Blocks links win, and the plan names the contradiction -----------------------------
rec KAN-31 relocate src/m "$(nb KAN-32)"; rec KAN-32 surface src/m; rec KAN-33 schema src/n "$(nb KAN-34)"; rec KAN-34 surface src/o
plan KAN-31 KAN-32 KAN-33 KAN-34
check "AC5: the link wins: the relocation waits on the surface ticket it is blocked by" \
  '[ "$(qg KAN-31 .held_by)" = KAN-32 ] && [ "$(qg KAN-32 .held_by)" = null ] && [ "$(qg KAN-33 .held_by)" = KAN-34 ] && [ "$(merge_order)" = "KAN-32 KAN-31 KAN-34 KAN-33" ]'
check "AC5: the plan names each contradiction, sharing files or not" \
  'printf "%s\n" "$out" | grep -q "^CONTRADICTIONS — 2" && printf "%s\n" "$out" | grep -q "^  KAN-31 (relocate) merges after KAN-32 (surface): KAN-31 is blocked by KAN-32 through a Jira link, and the link wins" && printf "%s\n" "$out" | grep -q "^  KAN-33 (schema) merges after KAN-34 (surface)"'
check "AC5: no merge-chain hold is added the other way, so there is no cycle" \
  '! printf "%s" "$out" | grep -q "dependency cycle" && [ "$(qg KAN-32 .state)" = triaged ]'

# A link that agrees with the kinds is no contradiction.
rec KAN-41 surface src/p "$(nb KAN-42)"; rec KAN-42 relocate src/p
plan KAN-41 KAN-42
check "a link that agrees with the kinds is not named a contradiction" '[ "$(qg KAN-41 .held_by)" = KAN-42 ] && ! printf "%s" "$out" | grep -q CONTRADICTIONS'

# A record from before triage asked for the kind is ordered as surface work, and the plan says so.
rec KAN-51 - src/q; rec KAN-52 shared src/r
plan KAN-51 KAN-52
check "no kind recorded: ordered as surface work, and named" \
  '[ "$(merge_order)" = "KAN-52 KAN-51" ] && printf "%s\n" "$out" | grep -q "^  2\. KAN-51  surface (no kind recorded)" && printf "%s\n" "$out" | grep -q "no change kind on 1 ticket(s): KAN-51"'

echo "blast radius: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
