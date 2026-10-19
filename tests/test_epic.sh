#!/usr/bin/env bash
# suite: epics (expansion, Jira links, held tickets)
# Epics as autopilot batches (docs/design-epic-batches.md): desk-jira children/link/parent against a
# local stub, expand-parent.mjs, ticket-facts.mjs, plan-batch.mjs dependency handling, the held-ticket
# idle rule, answer.mjs on a held ticket, and worker-settings for `link`. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state"
export HOME="$T/home" DESK_CONFIG_ROOT="$T/home/.config/desk" DESK_ENV_MJS="$B/desk-env.mjs"
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG JIRA_SITE JIRA_TOKEN JIRA_EMAIL DESK_STATE DESK_REPO_DIR DESK_DEFAULT_BRANCH
export PATH="$SRC/bin:$PATH" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" DESK_JIRA_NAME=Me
PASS=0; FAIL=0
# bash 3.2 misparses JSON written inline with \" escapes inside a check's "$(...)": build it in a
# variable first and pass "$q".
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

# ---------------------------------------------------------------------------------------------------
# Fixture: an epic with children of every kind, a bug with a QA subtask, and link targets.
cat > "$T/fixture.json" <<'EOF'
{
  "page_size": 3,
  "page_fault": {"KAN-90": "repeat", "KAN-91": "missing", "KAN-92": "endless"},
  "issues": {
    "KAN-93": {"summary": "to be filed under an epic"},
    "KAN-10": {"summary": "Epic", "issuetype": {"name": "Epic", "subtask": false, "hierarchyLevel": 1}},
    "KAN-11": {"summary": "first"},
    "KAN-12": {"summary": "finished", "status": {"name": "Done", "statusCategory": {"key": "done"}}},
    "KAN-13": {"summary": "under way", "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}}},
    "KAN-14": {"summary": "container", "issuetype": {"name": "Story", "subtask": false, "hierarchyLevel": 0},
               "issuelinks": [{"id": "1", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                               "inwardIssue": {"key": "KAN-11", "fields": {"status": {"name": "To Do", "statusCategory": {"key": "new"}}}}}]},
    "KAN-15": {"summary": "open subtask", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1}},
    "KAN-16": {"summary": "done subtask", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1},
               "status": {"name": "Done", "statusCategory": {"key": "done"}}},
    "KAN-17": {"summary": "story, subtasks all done", "issuetype": {"name": "Story", "subtask": false, "hierarchyLevel": 0}},
    "KAN-18": {"summary": "done subtask", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1},
               "status": {"name": "Done", "statusCategory": {"key": "done"}}},
    "OTH-1":  {"summary": "another project"},
    "KAN-19": {"summary": "last"},
    "KAN-60": {"summary": "epic with a bug child", "issuetype": {"name": "Epic", "subtask": false, "hierarchyLevel": 1}},
    "KAN-61": {"summary": "bug with QA", "issuetype": {"name": "Bug", "subtask": false, "hierarchyLevel": 0}},
    "KAN-62": {"summary": "QA", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1}},
    "KAN-63": {"summary": "story, subtasks under way", "issuetype": {"name": "Story", "subtask": false, "hierarchyLevel": 0}},
    "KAN-64": {"summary": "under way", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1},
               "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}}},
    "KAN-70": {"summary": "epic, in-progress stories", "issuetype": {"name": "Epic", "subtask": false, "hierarchyLevel": 1}},
    "KAN-71": {"summary": "story under way, some subtasks open", "issuetype": {"name": "Story", "subtask": false, "hierarchyLevel": 0},
               "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
               "issuelinks": [{"id": "31", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                               "inwardIssue": {"key": "KAN-11", "fields": {"status": {"name": "To Do", "statusCategory": {"key": "new"}}}}}]},
    "KAN-72": {"summary": "open subtask of an in-progress story", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1}},
    "KAN-73": {"summary": "subtask under way", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1},
               "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}}},
    "KAN-74": {"summary": "subtask done", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1},
               "status": {"name": "Done", "statusCategory": {"key": "done"}}},
    "KAN-75": {"summary": "story under way, subtasks all done", "issuetype": {"name": "Story", "subtask": false, "hierarchyLevel": 0},
               "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}}},
    "KAN-76": {"summary": "subtask done", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1},
               "status": {"name": "Done", "statusCategory": {"key": "done"}}},
    "KAN-77": {"summary": "story under way, no subtasks", "issuetype": {"name": "Story", "subtask": false, "hierarchyLevel": 0},
               "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}}},
    "KAN-78": {"summary": "task under way", "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}}},
    "KAN-79": {"summary": "done story with an open subtask", "issuetype": {"name": "Story", "subtask": false, "hierarchyLevel": 0},
               "status": {"name": "Done", "statusCategory": {"key": "done"}}},
    "KAN-80": {"summary": "open subtask of a done story", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1}},
    "KAN-20": {"summary": "empty epic", "issuetype": {"name": "Epic", "subtask": false, "hierarchyLevel": 1}},
    "KAN-30": {"summary": "a bug", "issuetype": {"name": "Bug", "subtask": false, "hierarchyLevel": 0}},
    "KAN-31": {"summary": "QA", "issuetype": {"name": "Subtask", "subtask": true, "hierarchyLevel": -1}},
    "KAN-40": {}, "KAN-41": {},
    "KAN-42": {"issuelinks": [{"id": "9", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                               "outwardIssue": {"key": "KAN-43"}}]},
    "KAN-43": {"issuelinks": [{"id": "9", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                               "inwardIssue": {"key": "KAN-42"}}]},
    "KAN-50": {"_names": {"customfield_10500": "Size"}, "customfield_10500": {"value": "L"},
               "issuelinks": [
                 {"id": "21", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                  "inwardIssue": {"key": "KAN-51", "fields": {"status": {"name": "Done", "statusCategory": {"key": "done"}}}}},
                 {"id": "22", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                  "outwardIssue": {"key": "KAN-52", "fields": {"status": {"name": "To Do", "statusCategory": {"key": "new"}}}}},
                 {"id": "23", "type": {"name": "Duplicate", "inward": "is duplicated by", "outward": "duplicates"},
                  "inwardIssue": {"key": "KAN-54"}},
                 {"id": "24", "type": {"name": "Relates", "inward": "relates to", "outward": "relates to"},
                  "outwardIssue": {"key": "KAN-55"}}]},
    "KAN-53": {"description": "Size: M\nThe rest of the body."},
    "KAN-1100": {"summary": "epic with a definition of done", "issuetype": {"name": "Epic", "subtask": false, "hierarchyLevel": 1},
                 "description": "h2. Outcome\nA feature.\n\nh2. Definition of done\n# DoD1: Given a, then b.\n# DoD2: Given c, then d.\n# DoD1: named twice\n\nh2. Acceptance criteria\n# AC1: not read while a DoD exists"},
    "KAN-1110": {"summary": "epic with acceptance criteria only", "issuetype": {"name": "Epic", "subtask": false, "hierarchyLevel": 1},
                 "description": "## Acceptance criteria\n1. AC1: first\n2. AC2: second\n\n## Out of scope\n* AC9: not a criterion"}
  },
  "children": {
    "KAN-10": ["KAN-11", "KAN-12", "KAN-13", "KAN-14", "KAN-17", "OTH-1", "KAN-19"],
    "KAN-90": ["KAN-11", "KAN-12", "KAN-13", "KAN-14", "KAN-17", "OTH-1", "KAN-19"],
    "KAN-91": ["KAN-11", "KAN-12", "KAN-13", "KAN-14", "KAN-17", "OTH-1", "KAN-19"],
    "KAN-14": ["KAN-15", "KAN-16"],
    "KAN-17": ["KAN-18"],
    "KAN-30": ["KAN-31"],
    "KAN-60": ["KAN-61", "KAN-63"],
    "KAN-61": ["KAN-62"],
    "KAN-63": ["KAN-64"],
    "KAN-70": ["KAN-71", "KAN-75", "KAN-77", "KAN-78", "KAN-79"],
    "KAN-71": ["KAN-72", "KAN-73", "KAN-74"],
    "KAN-75": ["KAN-76"],
    "KAN-79": ["KAN-80"],
    "KAN-1100": ["KAN-11"],
    "KAN-1110": ["KAN-19"]
  }
}
EOF
sed 's/"page_size": 3/"page_size": 3, "link_readback": "drop", "edit_drop": ["parent"]/' "$T/fixture.json" > "$T/fixture-drop.json"

PORT=$((20000 + RANDOM % 20000)); LOG="$T/requests.log"; : > "$LOG"
python3 "$S/stub_jira.py" "$PORT" "$LOG" "" "$T/fixture.json" & STUB=$!
DPORT=$((PORT + 1)); python3 "$S/stub_jira.py" "$DPORT" "$T/drop.log" "" "$T/fixture-drop.json" & DROP=$!
trap 'kill $STUB $DROP 2>/dev/null; rm -rf "$T"' EXIT
sleep 0.6

# A repo whose desk config points at the stub.
git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
git -C "$T/repo" remote add origin "git@github.com:acme/epic.git"
SLUG=$(cd "$T/repo" && node "$DESK_ENV_MJS" where | sed -n "s/^SLUG='\(.*\)'$/\1/p")
CD="$DESK_CONFIG_ROOT/repos/$SLUG"; mkdir -p "$CD"
mkcfg(){  # site edit-perm [acceptance-specs value]
  cat > "$CD/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/epic\` |
| Default branch | \`main\` |

## 1. Identity
| Field | Value |
|---|---|
| GitHub handle | \`me\` |
| Jira display name | \`Me\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`jira-edit\` | edit | \`yes\` | \`$2\` |
| \`jira-create\` | create | \`yes\` | \`yes\` |
| \`autopilot-merge\` | merge | \`no\` | \`yes\` |
| \`pr-merge-green\` | merge | \`no\` | \`yes\` |

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Jira site | \`$1\` |
| Jira project | \`KAN\` "x" |
| Ticket key pattern | \`KAN-[0-9]+\` |
| Other work id patterns | \`P[0-9]+-[0-9]+\` |
| Local database | \`none\` |
| Package manager | \`pnpm\` |
| Merge method | \`squash\` |
| Required checks | \`none\` |
| Merge holds | \`none\` |
| Unit tests | \`pnpm test\` |
| Acceptance specs | ${3:-\`none\`} |
EOF
}
mkcfg "http://127.0.0.1:$PORT" yes
printf 'me@example.com' > "$CD/jira-email"; printf good-token > "$CD/atlassian-token"; chmod 600 "$CD/atlassian-token"
cd "$T/repo" || exit 1
J(){ out=$(desk-jira "$@" 2>&1); rc=$?; }

# ---------------------------------------------------------------------------------------------------
# A1 children
J children KAN-10
check "children lists every child, across pages, in rank order" \
  '[ $rc -eq 0 ] && [ "$(printf "%s\n" "$out" | cut -f1 | tr "\n" " ")" = "KAN-11 KAN-12 KAN-13 KAN-14 KAN-17 OTH-1 KAN-19 " ]'
check "children paged (more than one search call)" '[ "$(grep -c search/jql "$LOG")" -ge 3 ]'
check "children prints the status category" 'printf "%s\n" "$out" | grep -q "^KAN-12	.*	done	"'
J children KAN-10 --json
check "children --json is one merged array" '[ $rc -eq 0 ] && [ "$(printf "%s" "$out" | jq length)" = 7 ]'
J children KAN-40
check "no children says so, exit 0" '[ $rc -eq 0 ] && [ "$out" = "no children" ]'
printf bad-token > "$T/bad"
out=$(JIRA_TOKEN_FILE="$T/bad" desk-jira children KAN-10 2>&1); rc=$?
check "children with a bad token fails, never 'no children'" '[ $rc -ne 0 ] && ! printf "%s" "$out" | grep -q "no children"'
J children KAN-90
check "children stops on a repeated page token, naming it and the page" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -q "page 2 repeats page token .3."'
J children KAN-91
check "children fails on a missing token before the last page" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -q "page 1 is not the last but has no nextPageToken" && ! printf "%s" "$out" | grep -q "^KAN-11"'
: > "$LOG"; J children KAN-92
check "children gives up after 200 pages, with the count" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -q "no last page after 200 pages" && [ "$(grep -c search/jql "$LOG")" -eq 200 ]'

# A page far bigger than one argv string may hold (Linux caps one argument at 128 KB).
python3 - "$T/fixture.json" <<'PY'
import json, sys
p = sys.argv[1]; f = json.load(open(p))
pad = "x" * 12000
f["issues"]["KAN-500"] = {"summary": "big epic", "issuetype": {"name": "Epic", "subtask": False, "hierarchyLevel": 1}}
kids = []
for n in range(501, 621):
    k = f"KAN-{n}"; kids.append(k)
    f["issues"][k] = {"summary": pad}
f["children"]["KAN-500"] = kids
json.dump(f, open(p, "w"))
PY
kill $STUB 2>/dev/null; sleep 0.2; python3 "$S/stub_jira.py" "$PORT" "$LOG" "" "$T/fixture.json" & STUB=$!; sleep 0.5
J children KAN-500 --json
check "children survives pages bigger than an argv string (120 x 12 KB, over 1 MB)" '[ $rc -eq 0 ] && [ "$(printf "%s" "$out" | jq length)" = 120 ]'

# A2 link
: > "$LOG"; J link KAN-40 blocked-by KAN-41
body=$(grep issueLink "$LOG" | grep POST | jq -r .body)
check "link blocked-by sends inward=OTHER outward=KEY" \
  '[ $rc -eq 0 ] && [ "$(printf "%s" "$body" | jq -r ".inwardIssue.key+\" \"+.outwardIssue.key+\" \"+.type.name")" = "KAN-41 KAN-40 Blocks" ]'
check "link reads back and says so" 'printf "%s" "$out" | grep -q "KAN-40 is blocked by KAN-41"'
: > "$LOG"; J link KAN-40 blocked-by KAN-41
check "an identical link is skipped" '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "already linked" && ! grep -q "\"POST\".*issueLink\|issueLink.*\"POST\"" "$LOG"'
J link KAN-41 blocked-by KAN-40
check "the reverse of an existing link is refused" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -qi "reverse"'
: > "$LOG"; J link KAN-11 blocks KAN-19
body=$(grep issueLink "$LOG" | grep POST | jq -r .body)
check "link blocks sends inward=KEY outward=OTHER" '[ $rc -eq 0 ] && [ "$(printf "%s" "$body" | jq -r ".inwardIssue.key+\" \"+.outwardIssue.key")" = "KAN-11 KAN-19" ]'
J link KAN-40 blocked-by KAN-40
check "a self link is refused" '[ $rc -ne 0 ]'
J link KAN-40 frobs KAN-41
check "a link type the site does not have is refused" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -q "no link type"'
out=$(JIRA_SITE="http://127.0.0.1:$DPORT" desk-jira link KAN-40 blocked-by KAN-41 2>&1); rc=$?
check "a read-back that does not show the link fails" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -qi "read.back"'

# A3 parent=
: > "$LOG"; printf 'body' > "$T/repo/b.md"; J create Story "s" b.md parent=KAN-10 --no-lint
check "create parent=KEY sends {key}" '[ $rc -eq 0 ] && [ "$(grep "\"/rest/api/2/issue\"" "$LOG" | jq -r .body | jq -c .fields.parent)" = "{\"key\":\"KAN-10\"}" ]'
J create Story "s" b.md parent=not-a-key
check "parent= that is not a key is refused" '[ $rc -ne 0 ]'
printf 'KAN-10' > "$T/repo/p.txt"; J create Story "s" b.md parent=@p.txt
check "parent=@file is refused too (a key only)" '[ $rc -ne 0 ]'
J edit KAN-93 parent=KAN-10
check "edit parent=KEY that reads back exits 0" '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "^updated KAN-93"'
out=$(JIRA_SITE="http://127.0.0.1:$DPORT" desk-jira edit KAN-93 parent=KAN-10 2>&1); rc=$?
check "edit exits 1 when the parent does not stick" '[ $rc -eq 1 ] && printf "%s" "$out" | grep -q "reads back as -, not KAN-10"'

# ---------------------------------------------------------------------------------------------------
# B expand-parent
E(){ out=$(node "$B/expand-parent.mjs" "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); }
E KAN-10
check "epic expands to open, in-repo children, containers replaced by open subtasks, rank kept" \
  '[ $rc -eq 0 ] && [ "$(printf "%s\n" "$out" | paste -sd " " -)" = "KAN-11 KAN-15 KAN-17 KAN-19" ]'
check "the report names each drop and why" 'printf "%s" "$err" | grep -q "KAN-12.*done" && printf "%s" "$err" | grep -q "KAN-13.*in progress" && printf "%s" "$err" | grep -q "OTH-1.*not this repo" && printf "%s" "$err" | grep -q "KAN-14.*KAN-15"'
check "expansion.json records the container, its subtasks and its blockers" \
  '[ "$(jq -c ".containers[\"KAN-14\"]" "$T/state/expansion.json")" = "{\"subtasks\":[\"KAN-15\"],\"blocked_by\":[{\"key\":\"KAN-11\",\"category\":\"new\"}]}" ] && [ "$(jq -r .parent "$T/state/expansion.json")" = KAN-10 ]'
check "an epic with no numbered criteria records none, and says so" \
  '[ "$(jq -c .criteria "$T/state/expansion.json")" = "[]" ] && printf "%s" "$err" | grep -q "KAN-10: no numbered criteria"'
E KAN-1100
check "an epic's DoD ids are its criteria, an id named twice kept once, its AC ids not read" \
  '[ $rc -eq 0 ] && [ "$(jq -c "[.criteria[].id]" "$T/state/expansion.json")" = "[\"DoD1\",\"DoD2\"]" ] && [ "$(jq -r ".criteria[0].text" "$T/state/expansion.json")" = "Given a, then b." ]'
E KAN-1110
check "with no DoD, the AC ids are the criteria (markdown numbering), other sections not read" \
  '[ $rc -eq 0 ] && [ "$(jq -c "[.criteria[].id]" "$T/state/expansion.json")" = "[\"AC1\",\"AC2\"]" ] && printf "%s" "$err" | grep -q "criteria AC1 AC2"'
E KAN-30
check "a bug with subtasks is not expanded (exit 4)" '[ $rc -eq 4 ] && [ -z "$out" ]'
check "a run that expands nothing leaves no expansion.json behind" '[ ! -e "$T/state/expansion.json" ]'
E KAN-60
check "an epic's Bug child with a QA subtask runs as itself, not as the subtask" '[ $rc -eq 0 ] && [ "$out" = KAN-61 ]'
check "a story whose subtasks are all under way is dropped, with the reason" 'printf "%s" "$err" | grep -q "KAN-63.*under way\|KAN-63.*in progress"'
E KAN-70
check "an In Progress story is replaced by its open subtasks, not dropped whole" '[ $rc -eq 0 ] && [ "$out" = KAN-72 ]'
check "the report marks the in-progress story and names its replacement" 'printf "%s" "$err" | grep -q "KAN-71 (in progress) → KAN-72"'
check "its in-progress and done subtasks are still dropped, with reasons" 'printf "%s" "$err" | grep -q "KAN-73 (subtask of KAN-71): in progress" && printf "%s" "$err" | grep -q "KAN-74 (subtask of KAN-71): done"'
check "an In Progress story with no open subtask is dropped as in progress" 'printf "%s" "$err" | grep -q "drop KAN-75: in progress" && printf "%s" "$err" | grep -q "drop KAN-77: in progress"'
check "an In Progress non-story child is still dropped as in progress" 'printf "%s" "$err" | grep -q "drop KAN-78: in progress"'
check "a Done story is dropped, its open subtask not pulled in" 'printf "%s" "$err" | grep -q "drop KAN-79: done" && ! printf "%s\n" "$out" | grep -qx KAN-80'
check "expansion.json carries the in-progress story's subtasks and blockers" \
  '[ "$(jq -c ".containers[\"KAN-71\"]" "$T/state/expansion.json")" = "{\"subtasks\":[\"KAN-72\"],\"blocked_by\":[{\"key\":\"KAN-11\",\"category\":\"new\"}]}" ]'
E KAN-30 --subtasks
check "--subtasks refuses a bug (stories only)" '[ $rc -eq 4 ] && [ -z "$out" ]'
E KAN-14 --subtasks
check "a story expands with --subtasks" '[ $rc -eq 0 ] && [ "$out" = KAN-15 ]'
E KAN-20
check "an epic with nothing open exits 3" '[ $rc -eq 3 ] && [ -z "$out" ]'
E KAN-999
check "an unreadable parent fails, never an empty batch" '[ $rc -ne 0 ] && [ $rc -ne 3 ] && [ -z "$out" ]'
E "bad key"
check "a non-key argument is refused" '[ $rc -ne 0 ] && [ -z "$out" ]'

# ---------------------------------------------------------------------------------------------------
# C ticket-facts
mkdir -p "$T/state/triage"
rec(){ printf '%s' "$2" > "$T/state/triage/$1.json"; }
rec KAN-50 '{"ticket":"KAN-50","lane":"A","branch":"b"}'
out=$(node "$B/ticket-facts.mjs" KAN-50 2>&1); rc=$?
check "facts: Blocks blockers from the inward side only, with category" \
  '[ $rc -eq 0 ] && [ "$(jq -c .blockers "$T/state/triage/KAN-50.json")" = "[{\"key\":\"KAN-51\",\"category\":\"done\"}]" ]'
check "facts: other link types counted, Relates not" '[ "$(jq .other_links "$T/state/triage/KAN-50.json")" = 1 ]'
check "facts: size from the field named Size" '[ "$(jq -r .size "$T/state/triage/KAN-50.json")" = L ]'
check "facts: the model-written fields survive" '[ "$(jq -r .lane "$T/state/triage/KAN-50.json")" = A ]'
check "facts: desk-jira lint's findings are recorded, blocking ones included" \
  '[ "$(jq -r "[.lint[] | select(.severity == \"blocking\") | .rule] | index(\"criteria\") != null" "$T/state/triage/KAN-50.json")" = true ] && printf "%s" "$out" | grep -q "lint [1-9][0-9]* blocking"'
rec KAN-53 '{"ticket":"KAN-53","lane":"A","branch":"b"}'
node "$B/ticket-facts.mjs" KAN-53 >/dev/null 2>&1
check "facts: size from the body's first line" '[ "$(jq -r .size "$T/state/triage/KAN-53.json")" = M ] && [ "$(jq -c .blockers "$T/state/triage/KAN-53.json")" = "[]" ]'
rec KAN-404 '{"ticket":"KAN-404","lane":"A","branch":"b"}'
out=$(node "$B/ticket-facts.mjs" KAN-404 2>&1); rc=$?
check "facts: a failed read is recorded, not empty blockers" '[ "$(jq -r ".facts_error|type" "$T/state/triage/KAN-404.json")" = string ] && [ "$(jq -r ".blockers|type" "$T/state/triage/KAN-404.json")" = null ]'
rec P1-1 '{"ticket":"P1-1","lane":"A","branch":"b"}'
node "$B/ticket-facts.mjs" P1-1 >/dev/null 2>&1
check "facts: a non-tracker key records links n/a" '[ "$(jq -r .links "$T/state/triage/P1-1.json")" = n/a ]'
check "facts: a non-tracker key with no ticket file records why it was not linted" '[ "$(jq -r ".lint_error" "$T/state/triage/P1-1.json")" != null ]'
mkdir -p "$T/state/tickets"
printf '# P1-2\n\n## Acceptance criteria\n1. AC1: Given x, when y, then z.\n\n## Verification\n* Unit: none.\n\n## Design\nNo UI.\n\n## Out of scope\n* None.\n' > "$T/state/tickets/P1-2.md"
rec P1-2 '{"ticket":"P1-2","lane":"A","branch":"b"}'
node "$B/ticket-facts.mjs" P1-2 >/dev/null 2>&1
check "facts: a ticket file is linted, with no size asked of it" '[ "$(jq -c .lint "$T/state/triage/P1-2.json")" = "[]" ]'

# ---------------------------------------------------------------------------------------------------
# D plan-batch (offline: triage records and expansion.json only)
export DESK_CONFIG="$CD/config.md"
rm -f "$T/state/triage/"*.json "$T/state/expansion.json" "$DESK_QUEUE"
r(){ # key lane blockers-json [extra-json]
  printf '{"ticket":"%s","type":"Task","lane":"%s","lane_reason":"r","summary":"s","branch":"feat/%s","files_in_scope":["f/%s"],"unknowns":[],"blockers":%s%s}' \
    "$1" "$2" "$1" "$1" "$3" "${4:+,$4}" > "$T/state/triage/$1.json"; }
nb(){ printf '{"key":"%s","category":"%s"}' "$1" "${2:-new}"; }
r KAN-101 A '[]'
r KAN-102 A "[$(nb KAN-101)]"
r KAN-103 A "[$(nb KAN-101),$(nb KAN-102)]"
r KAN-104 C "[$(nb KAN-101)]"
r KAN-105 A "[$(nb KAN-101)]" '"size":"L"'
r KAN-106 A "[$(nb KAN-900)]"
r KAN-107 A "[$(nb KAN-901 'done')]"
printf '{"ticket":"KAN-108","type":"Task","lane":"A","summary":"s","branch":"feat/KAN-108","files_in_scope":[],"unknowns":[],"facts_error":"HTTP 500"}' > "$T/state/triage/KAN-108.json"
r KAN-109 A "[$(nb KAN-104)]"
r KAN-110 A "[$(nb KAN-111)]"
r KAN-111 A "[$(nb KAN-110)]"
r KAN-131 A "[$(nb KAN-132)]"
r KAN-132 A "[$(nb KAN-133),$(nb KAN-134)]"
r KAN-133 A "[$(nb KAN-131)]"
r KAN-134 A "[$(nb KAN-133)]"
r KAN-121 A '[]'
r KAN-122 A '[]'
r KAN-123 A "[$(nb KAN-120)]"
printf '{"ticket":"KAN-124","type":"Task","lane":"A","summary":"s","branch":"feat/KAN-124","files_in_scope":[],"unknowns":[]}' > "$T/state/triage/KAN-124.json"
printf '{"parent":"KAN-100","containers":{"KAN-120":{"subtasks":["KAN-121","KAN-122"],"blocked_by":[{"key":"KAN-101","category":"new"}]}}}' > "$T/state/expansion.json"
node "$B/queue.mjs" init t >/dev/null; node "$B/queue.mjs" set-batch epic=KAN-100 >/dev/null
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-103 KAN-102 KAN-101 KAN-104 KAN-105 KAN-106 KAN-107 KAN-108 KAN-109 KAN-110 KAN-111 KAN-131 KAN-132 KAN-133 KAN-134 KAN-121 KAN-122 KAN-123 KAN-124 2>&1); rc=$?
qg(){ jq -r ".tickets[\"$1\"]$2" "$DESK_QUEUE"; }
check "plan-batch ran, and exits 11: parks and questions need the person" '[ $rc -eq 11 ] && printf "%s" "$out" | grep -q "^NEEDS YOU BEFORE STAGE 3"'
check "in-batch blocker: successor held with release_chain's prefix" \
  '[ "$(qg KAN-102 .state)" = parked ] && [[ "$(qg KAN-102 .park.question)" == "held by orchestrator"* ]] && [ "$(qg KAN-102 .held_by)" = KAN-101 ]'
check "held_by unions every in-batch blocker" '[ "$(qg KAN-103 .held_by)" = "KAN-101|KAN-102" ]'
check "--deps printed, one entry per successor, predecessors unioned" \
  'printf "%s" "$out" | grep -q -- "--deps \".*KAN-103:KAN-101,KAN-102.*\"" && printf "%s" "$out" | grep -q -- "KAN-102:KAN-101"'
check "a lane C successor is parked by its lane, never held, no --deps entry" \
  '[[ "$(qg KAN-104 .park.question)" == "lane C"* ]] && [ "$(qg KAN-104 .held_by)" = null ] && ! printf "%s" "$out" | grep -- "^--deps" | grep -q "KAN-104:"'
check "size L is parked, never held" '[[ "$(qg KAN-105 .park.question)" == "size L"* ]] && [ "$(qg KAN-105 .held_by)" = null ]'
check "an open blocker outside the batch is a question" \
  '[ "$(qg KAN-106 .state)" = triaged ] && [ "$(qg KAN-106 .open_questions)" = 1 ] && printf "%s" "$out" | grep -q "\[KAN-106\].*KAN-900"'
check "a done blocker outside the batch is ignored" '[ "$(qg KAN-107 .state)" = triaged ] && [ "$(qg KAN-107 .open_questions)" = 0 ]'
check "unreadable links are a question (fail closed)" '[ "$(qg KAN-108 .open_questions)" = 1 ] && printf "%s" "$out" | grep -q "\[KAN-108\].*could not be read"'
check "a missing facts record is a question too" '[ "$(qg KAN-124 .open_questions)" = 1 ]'
check "a blocker parked by its lane makes the successor a question, not held" \
  '[ "$(qg KAN-109 .state)" = triaged ] && [ "$(qg KAN-109 .open_questions)" = 1 ] && [ "$(qg KAN-109 .held_by)" = null ]'
check "a cycle parks both, no --deps" \
  '[[ "$(qg KAN-110 .park.question)" == "dependency cycle"* ]] && [[ "$(qg KAN-111 .park.question)" == "dependency cycle"* ]] && ! printf "%s" "$out" | grep -- "^--deps" | grep -q "KAN-110:\|KAN-111:"'
check "every ticket on a longer cycle is parked (strongly connected)" \
  '[[ "$(qg KAN-131 .park.question)" == "dependency cycle"* ]] && [[ "$(qg KAN-132 .park.question)" == "dependency cycle"* ]] && [[ "$(qg KAN-133 .park.question)" == "dependency cycle"* ]] && [[ "$(qg KAN-134 .park.question)" == "dependency cycle"* ]]'
check "a subtask inherits its container's blocker" '[ "$(qg KAN-121 .held_by)" = KAN-101 ] && [ "$(qg KAN-122 .held_by)" = KAN-101 ]'
check "blocked by a container means blocked by its subtasks in the batch" '[ "$(qg KAN-123 .held_by)" = "KAN-121|KAN-122" ]'
order=$(jq -r '.tickets | keys_unsorted | join(" ")' "$DESK_QUEUE")
check "queue seeded in topological order (blockers before successors)" \
  '[[ "$order" == *KAN-101*KAN-102*KAN-103* ]] && [[ "$order" == *KAN-101*KAN-121*KAN-123* ]]'

# Regression: records with no links at all seed exactly as before.
rm -f "$T/state/triage/"*.json
r KAN-201 A '[]'; r KAN-202 B '[]'
# a leftover expansion from another epic must not touch this batch
printf '{"parent":"KAN-100","containers":{"KAN-120":{"subtasks":["KAN-201"],"blocked_by":[{"key":"KAN-202","category":"new"}]}}}' > "$T/state/expansion.json"
printf '{"ticket":"P1-5","type":"Bug","lane":"A","summary":"s","branch":"fix/P1-5","files_in_scope":["x"],"unknowns":[],"links":"n/a"}' > "$T/state/triage/P1-5.json"
node "$B/queue.mjs" init t2 >/dev/null
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-202 KAN-201 P1-5 2>&1); rc=$?
check "regression: no links -> all triaged, argument order kept, no deps" \
  '[ $rc -eq 0 ] && [ "$(jq -r ".tickets|keys_unsorted|join(\" \")" "$DESK_QUEUE")" = "KAN-202 KAN-201 P1-5" ] && [ "$(jq -r "[.tickets[].state]|unique|join(\",\")" "$DESK_QUEUE")" = triaged ] && ! printf "%s" "$out" | grep -q -- "--deps"'

# An INCONCLUSIVE lane challenge (its code reads failed) shows the lane as unchecked and asks the user.
rm -f "$T/state/triage/"*.json "$T/state/expansion.json"
r KAN-301 C '[]' '"lane_challenge":{"verdict":"INCONCLUSIVE","reason":"x","failed_reads":["git show main:src/a.ts: denied"]}'
r KAN-302 C '[]' '"lane_challenge":{"verdict":"CONFIRM","reason":"y"}'
r KAN-303 A '[]' '"lint":[{"severity":"blocking","rule":"criteria","message":"no acceptance criteria: x"},{"severity":"advisory","rule":"section","message":"no Verification y"}]'
node "$B/queue.mjs" init t3 >/dev/null
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-301 KAN-302 KAN-303 2>&1); rc=$?
check "inconclusive challenge: plan marks the lane UNCHECKED" \
  '[ $rc -eq 11 ] && printf "%s" "$out" | grep -q "^KAN-301  lane C .*UNCHECKED" && printf "%s" "$out" | grep -q "challenge INCONCLUSIVE.*git show main:src/a.ts: denied"'
check "inconclusive challenge: listed as a question to confirm or re-lane, with the failed reads" \
  'printf "%s" "$out" | grep -q "\[KAN-301\] lane C is unchecked.*git show main:src/a.ts: denied.*re-lane"'
check "a confirmed challenge is not asked again" \
  'printf "%s" "$out" | grep -q "challenge CONFIRMED: y" && ! printf "%s" "$out" | grep -q "\[KAN-302\]" && ! printf "%s" "$out" | grep -q "^KAN-302 .*UNCHECKED"'
check "plan: a blocking lint finding is shown under its ticket, an advisory one is not" \
  'printf "%s\n" "$out" | grep -qxF "  ! lint (blocking): no acceptance criteria: x" && ! printf "%s" "$out" | grep -q "no Verification y"'
check "plan: the LINT section lists the ticket before spawning" 'printf "%s\n" "$out" | grep -A1 "^LINT — 1 ticket" | grep -qxF "  KAN-303: 1 blocking finding(s)"'
check "inconclusive challenge: parked, park question says unchecked, no open answers to block a re-lane" \
  '[ "$(qg KAN-301 .state)" = parked ] && [[ "$(qg KAN-301 .park.question)" == "lane C UNCHECKED"* ]] && [ "$(qg KAN-301 .open_questions)" = 0 ] && [[ "$(qg KAN-302 .park.question)" == "lane C —"* ]] && [ "$(qg KAN-303 .state)" = triaged ]'

# ---------------------------------------------------------------------------------------------------
# F feature mode: an epic on a batch base, with criteria and an acceptance-spec command
mkcfg "http://127.0.0.1:$PORT" yes '`tests/acceptance/` `pnpm vitest run tests/acceptance -t "{ids}"`'
rm -f "$T/state/triage/"*.json "$T/state/feature.json"
crit='[{"id":"DoD1","text":"one"},{"id":"DoD2","text":"two"},{"id":"DoD3","text":"all children Done"}]'
printf '{"parent":"KAN-1000","containers":{},"criteria":%s}' "$crit" > "$T/state/expansion.json"
r KAN-1001 A '[]'; r KAN-1002 A '[]'; r KAN-1003 A '[]'; r KAN-1050 A '[]'
fbatch(){ # [base]
  node "$B/queue.mjs" init "f$RANDOM" >/dev/null; node "$B/queue.mjs" set-batch epic=KAN-1000 >/dev/null
  if [ -n "${1:-}" ]; then jq --arg b "$1" '.base = $b' "$DESK_QUEUE" > "$T/q.tmp" && mv "$T/q.tmp" "$DESK_QUEUE"; fi; }
P(){ out=$(node "$B/plan-batch.mjs" "$@" 2>&1); rc=$?; }
PJ(){ out=$(node "$B/plan-batch.mjs" --json "$@" 2>/dev/null); rc=$?; }
fplan(){ printf '%s' "$1" > "$T/state/feature.json"; }

fbatch feat/epic
PJ KAN-1001 KAN-1002 KAN-1003
check "feature mode on with no plan yet: it says so and the person is needed (feature_plan)" \
  '[ $rc -eq 11 ] && printf "%s" "$out" | jq -r .message | grep -q "^FEATURE MODE — on: KAN-1000 on base feat/epic, 3 criteria" && [ "$(printf "%s" "$out" | jq -r "[.needs_person[] | select(.why == \"feature_plan\") | .ticket] | join(\",\")")" = KAN-1000 ]'
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-1001 KAN-1002 KAN-1003 2>&1); rc=$?
check "feature mode refuses to seed the queue before the spine is filed" \
  '[ $rc -eq 11 ] && printf "%s" "$out" | grep -q "queue is not seeded" && [ "$(jq ".tickets | length" "$DESK_QUEUE")" = 0 ]'

fplan '{"epic":"KAN-1000","spine":null,"draft":"Spine: shared contracts and one spec per criterion","owners":{"DoD1":"KAN-1001","DoD2":"KAN-1003"},"contributors":{"DoD2":["KAN-1002","KAN-1003"]},"untestable":{"DoD3":{"why":"it is about Jira state"}}}'
P KAN-1001 KAN-1002 KAN-1003
check "AC1: the plan prints the drafted spine and each criterion's owner" \
  'printf "%s\n" "$out" | grep -q "Drafted:" && printf "%s\n" "$out" | grep -qF "    | Spine: shared contracts and one spec per criterion" && printf "%s\n" "$out" | grep -q "^  DoD1 .*KAN-1001" && printf "%s\n" "$out" | grep -q "^  DoD2 .*KAN-1003 .*KAN-1002"'
check "AC3: an untestable criterion is named and asked about the close-out check" \
  'printf "%s\n" "$out" | grep -q "\[KAN-1000\] DoD3 cannot be written as a test (it is about Jira state): leave it to the epic close-out check?"'
check "AC6: a criterion's owner is held behind every other contributor" \
  'printf "%s\n" "$out" | grep -q "^KAN-1003 .*HELD (blocked by KAN-1002" && ! printf "%s\n" "$out" | grep -q "^KAN-1002 .*HELD"'

fplan '{"epic":"KAN-1000","spine":"KAN-1050","owners":{"DoD1":"KAN-1001","DoD2":"KAN-1003"},"contributors":{"DoD2":["KAN-1002"]},"untestable":{"DoD3":{"why":"Jira state","close_out":true}}}'
fbatch feat/epic
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-1001 KAN-1002 KAN-1003 KAN-1050 2>&1); rc=$?
check "AC2: once approved and filed, the spine is seeded first and runnable" \
  '[ $rc -eq 0 ] && [ "$(jq -r ".tickets | keys_unsorted | .[0]" "$DESK_QUEUE")" = KAN-1050 ] && [ "$(qg KAN-1050 .state)" = triaged ] && [ "$(qg KAN-1050 .held_by)" = null ]'
check "AC2: every other child is held behind the spine" \
  '[ "$(qg KAN-1001 .held_by)" = KAN-1050 ] && [ "$(qg KAN-1002 .held_by)" = KAN-1050 ] && [ "$(qg KAN-1003 .held_by)" = "KAN-1002|KAN-1050" ] && [[ "$(qg KAN-1001 .park.question)" == "held by orchestrator: blocked by KAN-1050 (feature spine)"* ]]'
check "a criterion agreed for the close-out is not asked again" '! printf "%s" "$out" | grep -q "close-out check?" && printf "%s\n" "$out" | grep -q "^  DoD3 .*close-out "'

fplan '{"epic":"KAN-1000","spine":"KAN-1050","owners":{"DoD1":"KAN-1001","DoD9":"KAN-1002"},"untestable":{"DoD3":{"why":"x","close_out":true}}}'
P KAN-1001 KAN-1002 KAN-1003 KAN-1050
check "a criterion with no owner, and an id the epic does not have, are questions" \
  '[ $rc -eq 11 ] && printf "%s" "$out" | grep -q "\[KAN-1000\] DoD2 has no owner" && printf "%s" "$out" | grep -q "\[KAN-1000\] DoD9 in feature.json is not one of KAN-1000"'
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-1001 KAN-1002 KAN-1003 KAN-1050 2>&1); rc=$?
check "an owner table with questions is not seeded" '[ $rc -eq 11 ] && printf "%s" "$out" | grep -q "question(s) on the owner table"'

fplan '{"epic":"KAN-1000","spine":"KAN-1050","owners":{"DoD1":"KAN-1001","DoD2":"KAN-1003"},"untestable":{"DoD3":{"why":"x","close_out":true}}}'
for v in 'C|' 'A|"size":"L"'; do
  r KAN-1050 "${v%%|*}" '[]' "${v#*|}"
  fbatch feat/epic
  out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-1001 KAN-1002 KAN-1003 KAN-1050 2>&1); rc=$?
  check "AC7: a spine parked at triage ($v) stops feature mode, and the plan says why" \
    'printf "%s" "$out" | grep -q "FEATURE MODE — off: the spine KAN-1050 is parked at triage" && [ "$(qg KAN-1001 .held_by)" = null ] && [ "$(qg KAN-1001 .state)" = triaged ]'
done
r KAN-1050 A '[]'

fbatch feat/epic
printf '{"parent":"KAN-1000","containers":{},"criteria":[]}' > "$T/state/expansion.json"
P KAN-1001
check "AC4: an epic with no numbered criteria keeps feature mode off, saying why" 'printf "%s" "$out" | grep -q "FEATURE MODE — off: KAN-1000 has no numbered criteria"'
printf '{"parent":"KAN-1000","containers":{},"criteria":%s}' "$crit" > "$T/state/expansion.json"
mkcfg "http://127.0.0.1:$PORT" yes
P KAN-1001
check "AC4: a repo with Acceptance specs none keeps feature mode off, saying why" 'printf "%s" "$out" | grep -q "FEATURE MODE — off: config §4 Acceptance specs is none"'
mkcfg "http://127.0.0.1:$PORT" yes '`tests/acceptance/`'
P KAN-1001
check "AC4: an Acceptance specs row with no {ids} command keeps it off" 'printf "%s" "$out" | grep -q "FEATURE MODE — off: .*no command taking {ids}"'
mkcfg "http://127.0.0.1:$PORT" yes '`tests/acceptance/` `pnpm vitest run -t "{ids}"`'
fbatch
P KAN-1001
check "AC5: an epic with no batch base keeps feature mode off, saying why" 'printf "%s" "$out" | grep -q "FEATURE MODE — off: the batch has no base branch"'
node "$B/queue.mjs" init "f$RANDOM" >/dev/null; jq '.base = "feat/epic"' "$DESK_QUEUE" > "$T/q.tmp" && mv "$T/q.tmp" "$DESK_QUEUE"
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" KAN-1001 KAN-1002 2>&1); rc=$?
check "AC5: a batch of ordinary tickets says nothing of feature mode and seeds as before" \
  '[ $rc -eq 0 ] && ! printf "%s" "$out" | grep -q "FEATURE MODE" && [ "$(qg KAN-1001 .state)" = triaged ] && [ "$(qg KAN-1002 .held_by)" = null ]'
mkcfg "http://127.0.0.1:$PORT" yes
rm -f "$T/state/feature.json" "$T/state/expansion.json"

# ---------------------------------------------------------------------------------------------------
# E idle rule and answer.mjs on a held ticket
idle(){ node --input-type=module -e "import {batchIdle} from '$B/batch-state.mjs'; console.log(batchIdle(JSON.parse(process.argv[1])) ? 'idle' : 'busy')" "$1"; }
H='{"state":"parked","park":{"question":"held by orchestrator: blocked by A"},"held_by":"A"}'
q='{"tickets":{"A":{"state":"running"},"S":'"$H"'}}'
check "held behind a running predecessor: not idle" '[ "$(idle "$q")" = busy ]'
q='{"tickets":{"A":{"state":"done","result":{"pr":7}},"S":'"$H"'}}'
check "held behind a done predecessor with a PR: not idle" '[ "$(idle "$q")" = busy ]'
q='{"tickets":{"A":{"state":"done"},"S":'"$H"'}}'
check "held behind a done predecessor with NO PR: idle (it will never merge)" '[ "$(idle "$q")" = idle ]'
H2='{"state":"parked","park":{"question":"held by orchestrator: blocked by S"},"held_by":"S"}'
q='{"tickets":{"A":{"state":"running"},"S":'"$H"',"T":'"$H2"'}}'
check "held behind a held ticket that is waiting: not idle (transitive)" '[ "$(idle "$q")" = busy ]'
HAX='{"state":"parked","park":{"question":"held by orchestrator: blocked by A, X"},"held_by":"A|X"}'
idlep(){ node --input-type=module -e "import {batchIdle} from '$B/batch-state.mjs'; const st=JSON.parse(process.argv[2]); console.log(batchIdle(JSON.parse(process.argv[1]), (n)=>st[n]??null) ? 'idle' : 'busy')" "$1" "$2"; }
merged='{"7":"MERGED"}'; closed='{"7":"CLOSED"}'
q='{"tickets":{"A":{"state":"done","result":{"pr":7}},"X":{"state":"failed"},"S":'"$HAX"'}}'
check "held behind one merged and one failed blocker: idle (it can never release)" '[ "$(idlep "$q" "$merged")" = idle ]'
q='{"tickets":{"A":{"state":"done","result":{"pr":7}},"S":'"$H"'}}'
check "held behind a blocker whose PR was closed unmerged: idle" '[ "$(idlep "$q" "$closed")" = idle ]'
check "held behind a merged blocker (release due): not idle" '[ "$(idlep "$q" "$merged")" = busy ]'
wom(){ node --input-type=module -e "import {waitingOnMerge} from '$B/batch-state.mjs'; const q=JSON.parse(process.argv[1]); console.log(waitingOnMerge(q, q.tickets.S) ? 'waiting' : 'stuck')" "$1"; }
HZ='{"state":"parked","park":{"question":"held by orchestrator: z"},"held_by":"Z"}'
HA='{"state":"parked","park":{"question":"held by orchestrator: a"},"held_by":"A"}'
HD='{"state":"parked","park":{"question":"held by orchestrator: b c"},"held_by":"B|C"}'
womk(){ node --input-type=module -e "import {waitingOnMerge} from '$B/batch-state.mjs'; const q=JSON.parse(process.argv[1]); console.log(waitingOnMerge(q, q.tickets[process.argv[2]]) ? 'waiting' : 'stuck')" "$1" "$2"; }
q='{"tickets":{"Z":{"state":"running"},"A":'"$HZ"',"B":'"$HA"',"C":'"$HA"',"D":'"$HD"'}}'
check "a diamond of holds (Z <- A <- B,C <- D) is waiting, not stuck" '[ "$(womk "$q" D)" = waiting ]'
q='{"tickets":{"A":{"state":"queued"},"S":'"$H"'}}'
check "held behind a queued blocker (never spawns by itself): stuck, not waiting" '[ "$(wom "$q")" = stuck ]'
q='{"tickets":{"S":{"state":"parked","park":{"question":"held by orchestrator: starts once A merges"}}}}'
check "a hold with no recorded blocker: idle, never silently waiting" '[ "$(idle "$q")" = idle ]'
q='{"tickets":{"A":{"state":"failed"},"S":'"$H"'}}'
check "held behind a failed predecessor: idle" '[ "$(idle "$q")" = idle ]'
q='{"tickets":{"A":{"state":"parked","park":{"question":"lane C"}},"S":'"$H"'}}'
check "held behind a predecessor parked for another reason: idle" '[ "$(idle "$q")" = idle ]'
node "$B/queue.mjs" init t4 >/dev/null; node "$B/queue.mjs" add KAN-401 Task A >/dev/null; node "$B/queue.mjs" add KAN-402 Task A >/dev/null
node "$B/queue.mjs" set KAN-401 state=failed >/dev/null; node "$B/queue.mjs" set KAN-402 held_by=KAN-401 >/dev/null
node "$B/queue.mjs" park KAN-402 "held by orchestrator: blocked by KAN-401 (Jira link) — starts once their PRs merge" >/dev/null
out=$(node "$B/queue.mjs" render 2>&1)
check "held behind a failed blocker is surfaced as stuck and waiting on you" 'printf "%s" "$out" | grep -q "STUCK" && printf "%s" "$out" | grep -q "waiting on you"'
q='{"tickets":{"A":{"state":"done"},"B":{"state":"parked","park":{"question":"x"}}}}'
check "everything done or parked: idle (unchanged)" '[ "$(idle "$q")" = idle ]'
q='{"tickets":{"A":{"state":"triaged"}}}'
check "a triaged ticket: not idle (unchanged)" '[ "$(idle "$q")" = busy ]'

node "$B/queue.mjs" init t3 >/dev/null; node "$B/queue.mjs" add KAN-301 Task A >/dev/null; node "$B/queue.mjs" add KAN-302 Task A >/dev/null
node "$B/queue.mjs" set KAN-301 state=triaged >/dev/null
node "$B/queue.mjs" set KAN-302 open_questions=1 held_by=KAN-301 >/dev/null
node "$B/queue.mjs" park KAN-302 "held by orchestrator: blocked by KAN-301 (Jira link) — starts once their PRs merge" >/dev/null
out=$(node "$B/answer.mjs" KAN-302 "start it anyway" 2>&1)
check "answer on a held ticket keeps the hold and clears the count" \
  '[ "$(qg KAN-302 .state)" = parked ] && [ "$(qg KAN-302 .open_questions)" = 0 ] && printf "%s" "$out" | grep -q "held"'
out=$(node "$B/queue.mjs" render 2>&1)
check "render shows a held ticket as HELD, not waiting on you" 'printf "%s" "$out" | grep -q "HELD" && ! printf "%s" "$out" | grep -q "waiting on you"'
node "$B/queue.mjs" set-batch epic=KAN-300 >/dev/null; out=$(node "$B/queue.mjs" render 2>&1)
check "render shows the epic" 'printf "%s" "$out" | grep -q "epic KAN-300"'

# queue.mjs hold / admit: the mid-batch procedures as single commands
node "$B/queue.mjs" init t6 >/dev/null
for k in KAN-801 KAN-802 KAN-803; do node "$B/queue.mjs" add $k Task A >/dev/null; node "$B/queue.mjs" set $k state=triaged >/dev/null; done
node "$B/queue.mjs" hold KAN-803 KAN-801 >/dev/null; node "$B/queue.mjs" hold KAN-803 KAN-802 >/dev/null
check "hold records every blocker (unioned) with the release prefix" \
  '[ "$(qg KAN-803 .held_by)" = "KAN-801|KAN-802" ] && [[ "$(qg KAN-803 .park.question)" == "held by orchestrator"* ]]'
node "$B/queue.mjs" park KAN-802 "lane C — needs a plan" >/dev/null
out=$(node "$B/queue.mjs" hold KAN-802 KAN-801 2>&1); rc=$?
check "hold refuses a ticket parked for its own reason" '[ $rc -ne 0 ] && [[ "$(qg KAN-802 .park.question)" == "lane C"* ]]'
out=$(node "$B/queue.mjs" hold KAN-801 KAN-801 2>&1); rc=$?
check "hold refuses a self hold" '[ $rc -ne 0 ]'
node "$B/queue.mjs" add KAN-804 Task A >/dev/null
out=$(node "$B/queue.mjs" hold KAN-804 KAN-801 2>&1); rc=$?
check "hold refuses a ticket never triaged (a release would send it to a worker untriaged)" '[ $rc -ne 0 ] && [ "$(qg KAN-804 .state)" = queued ]'
mkdir -p "$T/state/triage"
printf '{"ticket":"KAN-801","type":"Task","lane":"A","branch":"feat/KAN-801","files_in_scope":["src/a.ts","src/b.ts"],"unknowns":[]}' > "$T/state/triage/KAN-801.json"
printf '{"ticket":"KAN-810","type":"Task","lane":"A","branch":"feat/KAN-810","files_in_scope":["src/b.ts"],"unknowns":[],"blockers":[]}' > "$T/state/triage/KAN-810.json"
printf '{"ticket":"KAN-811","type":"Task","lane":"C","lane_reason":"big","branch":"feat/KAN-811","unknowns":[]}' > "$T/state/triage/KAN-811.json"
printf '{"ticket":"KAN-812","type":"Task","lane":"A","branch":"feat/KAN-812","unknowns":[],"size":"XL"}' > "$T/state/triage/KAN-812.json"
node "$B/queue.mjs" admit KAN-810 >/dev/null; node "$B/queue.mjs" admit KAN-811 >/dev/null; node "$B/queue.mjs" admit KAN-812 >/dev/null
check "admit: a lane A ticket is triaged with its branch" '[ "$(qg KAN-810 .state)" = triaged ] && [ "$(qg KAN-810 .branch)" = feat/KAN-810 ]'
check "admit records collisions both ways from files in scope" '[ "$(qg KAN-810 .collides_with)" = KAN-801 ] && [[ "$(qg KAN-801 .collides_with)" == *KAN-810* ]]'
check "admit: lane C and size XL are parked for their own reason" '[[ "$(qg KAN-811 .park.question)" == "lane C"* ]] && [[ "$(qg KAN-812 .park.question)" == "size XL"* ]]'
printf '{"ticket":"KAN-814","type":"Task","lane":"D","lane_reason":"design","branch":"feat/KAN-814","unknowns":[],"lane_challenge":{"verdict":"INCONCLUSIVE","reason":"x","failed_reads":["r"]}}' > "$T/state/triage/KAN-814.json"
node "$B/queue.mjs" admit KAN-814 >/dev/null
check "admit: an INCONCLUSIVE challenge parks the lane as unchecked, as plan-batch does" '[ "$(qg KAN-814 .state)" = parked ] && [[ "$(qg KAN-814 .park.question)" == "lane D UNCHECKED"* ]]'
out=$(node "$B/queue.mjs" admit KAN-813 2>&1); rc=$?
check "admit refuses a ticket with no triage record" '[ $rc -ne 0 ]'

# ---------------------------------------------------------------------------------------------------
# worker-settings: link is never a worker's or triage's; children is a read
ws(){ node "$B/worker-settings.mjs" "$@" >/dev/null 2>&1; }
ws triage --ticket KAN-1 --out "$T/tri.json"
check "triage: link denied" 'jq -r ".permissions.deny[]" "$T/tri.json" | grep -q "^Bash(desk-jira link"'
check "triage: children allowed" 'jq -r ".permissions.allow[]" "$T/tri.json" | grep -q "^Bash(desk-jira children"'
ws worker --ticket KAN-1 --wt "$T/repo" --out "$T/wk.json"
check "worker with jira-edit yes: link still denied, edit granted" \
  'jq -r ".permissions.deny[]" "$T/wk.json" | grep -q "^Bash(desk-jira link" && ! jq -r ".permissions.allow[]" "$T/wk.json" | grep -q "desk-jira link" && jq -r ".permissions.allow[]" "$T/wk.json" | grep -q "^Bash(desk-jira edit"'
check "worker: children allowed" 'jq -r ".permissions.allow[]" "$T/wk.json" | grep -q "^Bash(desk-jira children"'

ws worker --ticket KAN-1 --wt "$T/repo" --out "$T/dry.json" --dry
check "dry run: link denied" 'jq -r ".permissions.deny[]" "$T/dry.json" | grep -q "^Bash(desk-jira link"'

# merge-driver release_chain: every predecessor, from --deps (a successor named twice) and held_by.
mkdir -p "$T/fakebin"; printf '%s\n' feat/KAN-701 > "$T/merged"
cat > "$T/fakebin/gh" <<'GH'
#!/usr/bin/env bash
if [ "$1 $2" = "pr list" ]; then
  st=""; prev=""; for a in "$@"; do [ "$prev" = --state ] && st="$a"; prev="$a"; done
  if [ "$st" = merged ]; then n=100; sep=""; printf '['
    for b in $(cat "$FAKE_MERGED"); do n=$((n+1)); printf '%s{"number":%d,"title":"t","headRefName":"%s","baseRefName":"main","isDraft":false}' "$sep" "$n" "$b"; sep=,; done
    printf ']\n'; else echo '[]'; fi
  exit 0
fi
echo '{}'
GH
chmod +x "$T/fakebin/gh"
node "$B/queue.mjs" init t5 >/dev/null
for k in KAN-701 KAN-702 KAN-703 KAN-704; do node "$B/queue.mjs" add $k Task A >/dev/null; node "$B/queue.mjs" set $k branch=feat/$k >/dev/null; done
node "$B/queue.mjs" set KAN-701 state=done >/dev/null; node "$B/queue.mjs" set KAN-702 state=done >/dev/null
node "$B/queue.mjs" set KAN-703 held_by=KAN-701 >/dev/null; node "$B/queue.mjs" park KAN-703 "held by orchestrator: blocked by KAN-701 (Jira link)" >/dev/null
node "$B/queue.mjs" set KAN-704 held_by=KAN-702 >/dev/null; node "$B/queue.mjs" park KAN-704 "held by orchestrator: blocked by KAN-702 (Jira link)" >/dev/null
md(){ out=$(PATH="$T/fakebin:$PATH" FAKE_MERGED="$T/merged" MERGE_DRIVER_RELEASE_ONLY=1 bash "$B/merge-driver.sh" --tickets "KAN-701 KAN-703" --deps "KAN-703:KAN-701 KAN-703:KAN-702" 2>&1); rc=$?; }
md
check "driver: a successor named twice in --deps waits for both predecessors" '[ $rc -eq 0 ] && [ "$(qg KAN-703 .state)" = parked ]'
check "driver: a queue-held ticket outside --deps/--tickets waits for its held_by" '[ "$(qg KAN-704 .state)" = parked ]'
printf '%s\n' feat/KAN-701 feat/KAN-702 > "$T/merged"; md
check "driver: released once every predecessor merged; held_by cleared; moved to front" \
  '[ "$(qg KAN-703 .state)" = triaged ] && [ "$(qg KAN-703 .held_by)" = null ] && [ "$(qg KAN-703 .park)" = null ] && [ "$(jq -r ".tickets|keys_unsorted|.[0]" "$DESK_QUEUE")" != KAN-701 ]'
check "driver: a queue-held ticket is released from held_by alone" '[ "$(qg KAN-704 .state)" = triaged ]'

# merge-driver main loop: a ticket admitted to the queue after the driver started joins its PR set.
# The fake gh admits KAN-802 on its first open-PR listing; the fake sleep stops the driver after two loops.
mkdir -p "$T/loopbin"
cat > "$T/loopbin/gh" <<'GH'
#!/usr/bin/env bash
if [ "$1 $2" = "pr list" ]; then
  if [ ! -f "$FAKE_DIR/admitted" ]; then
    : > "$FAKE_DIR/admitted"
    node "$FAKE_Q" add KAN-802 Task A >/dev/null; node "$FAKE_Q" set KAN-802 branch=feat/KAN-802 >/dev/null
  fi
  echo '[{"number":201,"title":"t","headRefName":"feat/KAN-801","baseRefName":"main","isDraft":true},{"number":202,"title":"t","headRefName":"feat/KAN-802","baseRefName":"main","isDraft":true}]'
  exit 0
fi
echo '{}'
GH
cat > "$T/loopbin/sleep" <<'SLEEP'
#!/usr/bin/env bash
echo x >> "$FAKE_DIR/sleeps"
[ "$(wc -l < "$FAKE_DIR/sleeps")" -ge 2 ] && kill -TERM "$PPID"
exit 0
SLEEP
chmod +x "$T/loopbin/gh" "$T/loopbin/sleep"
node "$B/queue.mjs" init t6 >/dev/null
node "$B/queue.mjs" add KAN-801 Task A >/dev/null; node "$B/queue.mjs" set KAN-801 branch=feat/KAN-801 >/dev/null
out=$(PATH="$T/loopbin:$PATH" FAKE_DIR="$T" FAKE_Q="$B/queue.mjs" bash "$B/merge-driver.sh" --tickets "KAN-801" 2>&1)
first=$(printf '%s\n' "$out" | grep 'draft (still reviewing)' | head -1)
last=$(printf '%s\n' "$out" | grep 'draft (still reviewing)' | tail -1)
check "driver loop: a ticket not yet in the queue is not the batch's" '[ -n "$first" ] && ! printf "%s" "$first" | grep -q "#202"'
check "driver loop: a ticket admitted mid-run joins on the next loop, no restart" \
  'printf "%s" "$out" | grep -q "KAN-802 joined the batch" && printf "%s" "$last" | grep -q "#201 #202"'

check "pass.mjs still reports base drift (regression guard)" 'grep -q "out.push(\`base drift:" "$B/pass.mjs"'

echo "epic: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
