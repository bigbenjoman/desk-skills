#!/usr/bin/env bash
# suite: blast radius (plan-batch merges relocate, schema, shared, then surface work)
# layer: L2
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
# Every check above the merge-order section reads the start holds, as a batch did before that row.
cp "$T/config.md" "$T/config-default.md"
printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Overlap holds | x | `start` |\n' >> "$T/config.md"
export DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json"
cd "$T/repo" || exit 1

# rec <KEY> <change_kind, or - for none> <file>[,<file>...] [blockers json, default []] [size, default S] [blocker_needs json]
rec(){ local kind="" files needs=""; [ "$2" = - ] || kind="\"change_kind\": \"$2\", \"change_kind_reason\": \"why $1\", "
  files=$(printf '%s' "$3" | tr ',' '\n' | jq -R . | jq -sc .)
  [ -z "${6:-}" ] || needs=", \"blocker_needs\": $6"
  printf '{"ticket": "%s", "type": "Task", "lane": "A", "size": "%s", "summary": "s", "branch": "feat/%s", %s"files_in_scope": %s, "unknowns": [], "blockers": %s%s}\n' \
    "$1" "${5:-S}" "$1" "$kind" "$files" "${4:-[]}" "$needs" > "$T/state/triage/$1.json"; }
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
check "with nothing gated and one planned file each, the queue keeps the order named" '[ "$(seeded)" = "KAN-1 KAN-2 KAN-3 KAN-4" ]'
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

# ---- a collision chain holds each ticket behind every earlier one it shares a file with -----------
# The one just before it is not enough: dropping or freeing that one by hand would let it start early.
rec KAN-61 shared src/k; rec KAN-62 shared src/k; rec KAN-63 shared src/k
plan KAN-61 KAN-62 KAN-63
check "DS-793 AC2: the third of three tickets sharing a file is held behind both before it, in the queue and in --deps" \
  '[ "$(qg KAN-61 .held_by)" = null ] && [ "$(qg KAN-62 .held_by)" = KAN-61 ] && [ "$(qg KAN-63 .held_by)" = "KAN-61|KAN-62" ] && printf "%s\n" "$out" | grep -qx -- "--deps \"KAN-62:KAN-61 KAN-63:KAN-61,KAN-62\""'
# Named out of merge order (XS, then S, then M merge), the last pair is already ordered through the
# middle ticket, and is held directly all the same. No L: an L ticket is size-parked before chaining.
rec KAN-71 shared src/z '[]' S; rec KAN-72 shared src/z '[]' M; rec KAN-73 shared src/z '[]' XS
plan KAN-71 KAN-72 KAN-73
check "DS-793 AC2: a ticket named out of merge order is held behind every ticket it shares a file with that merges before it" \
  '[ "$(qg KAN-73 .held_by)" = null ] && [ "$(qg KAN-71 .held_by)" = KAN-73 ] && [ "$(qg KAN-72 .held_by)" = "KAN-71|KAN-73" ]'

# ---- AC5: Jira Blocks links win, and the plan names the contradiction -----------------------------
rec KAN-31 relocate src/m "$(nb KAN-32)"; rec KAN-32 surface src/m; rec KAN-33 schema src/n "$(nb KAN-34)"; rec KAN-34 surface src/o
plan KAN-31 KAN-32 KAN-33 KAN-34
check "AC5: the link wins: the relocation waits on the surface ticket it is blocked by" \
  '[ "$(qg KAN-31 .held_by)" = KAN-32 ] && [ "$(qg KAN-32 .held_by)" = null ] && [ "$(qg KAN-33 .held_by)" = KAN-34 ] && [ "$(merge_order)" = "KAN-32 KAN-31 KAN-34 KAN-33" ]'
check "AC5: the plan names each contradiction, sharing files or not" \
  'printf "%s\n" "$out" | grep -q "^CONTRADICTIONS — 2" && printf "%s\n" "$out" | grep -q "^  KAN-31 (relocate) merges after KAN-32 (surface): KAN-31 is blocked by KAN-32 through a Jira link, and the link wins" && printf "%s\n" "$out" | grep -q "^  KAN-33 (schema) merges after KAN-34 (surface)"'
check "AC5: no merge-chain hold is added the other way, so there is no cycle" \
  '! printf "%s" "$out" | grep -q "dependency cycle" && [ "$(qg KAN-32 .state)" = triaged ]'

# ---- the questions plan-batch adds are seeded on the ticket, where the decider reads them ---------
rec KAN-41 surface src/q "$(nb KAN-99)"; rec KAN-42 surface src/r
plan KAN-41 KAN-42
check "a question plan-batch adds is on its ticket's queue entry word for word; a ticket with none has none" \
  '[ "$(qg KAN-41 ".plan_questions | join(\"|\")")" = "KAN-41 is blocked by KAN-99 (not started), which is not in this batch: add KAN-99 to the batch, or confirm KAN-41 can start without it" ] && [ "$(qg KAN-41 .open_questions)" = 1 ] && [ "$(qg KAN-42 .plan_questions)" = null ]'

# A link that agrees with the kinds is no contradiction.
rec KAN-41 surface src/p "$(nb KAN-42)"; rec KAN-42 relocate src/p
plan KAN-41 KAN-42
check "a link that agrees with the kinds is not named a contradiction" '[ "$(qg KAN-41 .held_by)" = KAN-42 ] && ! printf "%s" "$out" | grep -q CONTRADICTIONS'

# A record from before triage asked for the kind is ordered as surface work, and the plan says so.
rec KAN-51 - src/q; rec KAN-52 shared src/r
plan KAN-51 KAN-52
check "no kind recorded: ordered as surface work, and named" \
  '[ "$(merge_order)" = "KAN-52 KAN-51" ] && printf "%s\n" "$out" | grep -q "^  2\. KAN-51  surface (no kind recorded)" && printf "%s\n" "$out" | grep -q "no change kind on 1 ticket(s): KAN-51"'

# ---- spawn order: the ticket that gates the most starts first, then the fewest planned files -------------
# KAN-63 gates KAN-62 and KAN-64 but is named last; KAN-65 plans three files, KAN-66 one.
rec KAN-62 surface src/s62 "$(nb KAN-63)"; rec KAN-64 surface src/s64 "$(nb KAN-63)"; rec KAN-63 surface src/s63
rec KAN-65 surface src/s65a,src/s65b,src/s65c; rec KAN-66 surface src/s66
plan KAN-65 KAN-66 KAN-62 KAN-64 KAN-63
check "a ticket that gates others is spawned first, however late it is named; then the fewest planned files" '[ "$(seeded)" = "KAN-63 KAN-66 KAN-62 KAN-64 KAN-65" ]'
check "the plan shows the spawn order with what each gates" \
  'printf "%s\n" "$out" | grep -q "^SPAWN ORDER — Blockers start first, then the tickets that gate the most others" && printf "%s\n" "$out" | grep -q "^  1\. KAN-63  gates 2, 1 planned file(s)$" && printf "%s\n" "$out" | grep -q "^  5\. KAN-65  gates 0, 3 planned file(s)$"'
plan --keep-order KAN-65 KAN-66 KAN-62 KAN-64 KAN-63
check "--keep-order keeps the order named, blockers still first" '[ "$(seeded)" = "KAN-65 KAN-66 KAN-63 KAN-62 KAN-64" ] && printf "%s\n" "$out" | grep -q "^SPAWN ORDER — With --keep-order, tickets start in the order named"'

# ---- §3b "Overlap holds" merge: a shared file orders the merges, not the starts --------------------
# The start-hold fixture above: three tickets sharing src/k, each held from starting under `start`.
rec KAN-61 shared src/k; rec KAN-62 shared src/k; rec KAN-63 shared src/k
for row in default merge; do
  if [ "$row" = default ]; then export DESK_CONFIG="$T/config-default.md"; else
    { cat "$T/config-default.md"; printf '\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Overlap holds | x | `merge` |\n'; } > "$T/config-merge.md"
    export DESK_CONFIG="$T/config-merge.md"; fi
  plan KAN-61 KAN-62 KAN-63
  check "DS-1031 AC1 ($row): tickets sharing only files all start, with no held_by and no --deps" \
    '[ "$(jq -r "[.tickets[].state] | unique | join(\",\")" "$DESK_QUEUE")" = triaged ] && [ "$(jq -r "[.tickets[].held_by] | unique | join(\",\")" "$DESK_QUEUE")" = "" ] && ! printf "%s" "$out" | grep -q -- "--deps"'
  check "DS-1031 AC1 ($row): the later ones carry a merge-order hold naming each earlier one" \
    '[ "$(qg KAN-61 .merge_order)" = null ] && [ "$(qg KAN-62 .merge_order)" = KAN-61 ] && [ "$(qg KAN-63 .merge_order)" = "KAN-61|KAN-62" ] && printf "%s\n" "$out" | grep -q "^  KAN-63 merges after KAN-61 (shares src/k; both shared, KAN-61 named first), KAN-62"'
done
check "DS-1031 AC1: the merge order still puts the earlier ticket first" '[ "$(merge_order)" = "KAN-61 KAN-62 KAN-63" ]'

# AC3: an in-batch blocker triage judged needs only to merge is a merge-order hold.
rec KAN-81 surface src/a81 "$(nb KAN-82)" S '{"KAN-82": {"needs": "merge", "why": "both add a line to one list"}}'; rec KAN-82 surface src/a82
plan KAN-81 KAN-82
check "DS-1031 AC3: a Jira blocker in the batch that triage judged needs: merge holds the merge, not the start" \
  '[ "$(qg KAN-81 .held_by)" = null ] && [ "$(qg KAN-81 .state)" = triaged ] && [ "$(qg KAN-81 .merge_order)" = KAN-82 ] && printf "%s\n" "$out" | grep -q "^  KAN-81 merges after KAN-82 (Jira link; triage: both add a line to one list)"'

# AC4: needs: build, or no verdict at all, holds the start as before.
rec KAN-81 surface src/a81 "$(nb KAN-82)" S '{"KAN-82": {"needs": "build", "why": "it reads the new table"}}'
plan KAN-81 KAN-82
check "DS-1031 AC4: a blocker triage judged needs: build holds the start" \
  '[ "$(qg KAN-81 .held_by)" = KAN-82 ] && [ "$(qg KAN-81 .state)" = parked ] && [ "$(qg KAN-81 .merge_order)" = null ]'
rec KAN-81 surface src/a81 "$(nb KAN-82)"
plan KAN-81 KAN-82
check "DS-1031 AC4: a Jira link with no triage verdict holds the start" \
  '[ "$(qg KAN-81 .held_by)" = KAN-82 ] && [ "$(qg KAN-81 .state)" = parked ] && [ "$(qg KAN-81 .merge_order)" = null ]'

# A merge-order hold one way and a start hold the other can never release, so it is a cycle.
rec KAN-91 surface src/a91 "$(nb KAN-92)" S '{"KAN-92": {"needs": "merge", "why": "x"}}'
rec KAN-92 surface src/a92 "$(nb KAN-91)" S '{"KAN-91": {"needs": "build", "why": "y"}}'
plan KAN-91 KAN-92
check "DS-1031 a merge-order hold against a start hold is a dependency cycle" \
  'printf "%s" "$out" | grep -q "dependency cycle" && [ "$(qg KAN-91 .merge_order)" = null ] && [ "$(qg KAN-92 .held_by)" = null ]'

# A file shared with a ticket held behind the other already: the merge order follows that hold.
rec KAN-95 surface src/s95 "$(nb KAN-96)"; rec KAN-96 relocate src/s95
plan KAN-95 KAN-96
check "DS-1031 a start hold already ordering a pair that shares a file adds no merge-order hold" \
  '[ "$(qg KAN-95 .held_by)" = KAN-96 ] && [ "$(qg KAN-95 .merge_order)" = null ] && [ "$(qg KAN-96 .merge_order)" = null ]'

# AC5: at start, the same three tickets are held from starting as before, and nothing is merge-ordered.
export DESK_CONFIG="$T/config.md"
plan KAN-61 KAN-62 KAN-63
check "DS-1031 AC5: Overlap holds start holds the starts as before, with no merge-order hold" \
  '[ "$(qg KAN-63 .held_by)" = "KAN-61|KAN-62" ] && [ "$(jq -r "[.tickets[].merge_order] | unique | join(\",\")" "$DESK_QUEUE")" = "" ] && ! printf "%s" "$out" | grep -q "MERGE-ORDER" && printf "%s\n" "$out" | grep -q "must run sequentially"'

echo "blast radius: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
