#!/usr/bin/env bash
# suite: desk-jira against a local stub
# Tests for bin/desk-jira against a local stub. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$S/.." && pwd)"
J="$SRC/bin/desk-jira"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/repos" "$T/state"
export HOME="$T/home" DESK_CONFIG_ROOT="$T/home/.config/desk" DESK_ENV_MJS="$SRC/desk/bin/desk-env.mjs"
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG JIRA_SITE JIRA_TOKEN JIRA_EMAIL DESK_STATE DESK_REPO_DIR DESK_AUTOPILOT_WORKER
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# KAN-5 holds every element `get` prints. The parent is shaped as Jira Cloud returns it (recorded
# from DS-30's own issue); KAN-6 has none of them; KAN-7's web links cannot be read.
DESIGN_URL="https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Desk-ticket-standard?node-id=1234-5678&t=0123456789abcdef-1&mode=design&ref=a-long-tail"
cat > "$T/fixture.json" <<EOF
{"issues": {
  "KAN-5": {"summary": "full ticket", "issuetype": {"name": "Story"},
    "parent": {"key": "KAN-2", "fields": {"summary": "the epic", "status": {"name": "To Do"}, "issuetype": {"name": "Epic"}}},
    "customfield_10100": "$DESIGN_URL",
    "_names": {"customfield_10100": "Design"},
    "issuelinks": [
      {"id": "1", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
       "inwardIssue": {"key": "KAN-3", "fields": {"summary": "first", "status": {"name": "Done"}, "issuetype": {"name": "Task"}}}},
      {"id": "2", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
       "outwardIssue": {"key": "KAN-4", "fields": {"summary": "later", "status": {"name": "To Do"}, "issuetype": {"name": "Task"}}}},
      {"id": "3", "type": {"name": "Relates", "inward": "relates to", "outward": "relates to"},
       "outwardIssue": {"key": "KAN-8", "fields": {"summary": "nearby", "status": {"name": "To Do"}, "issuetype": {"name": "Bug"}}}}],
    "subtasks": [{"key": "KAN-9", "fields": {"summary": "a piece", "status": {"name": "To Do"}, "issuetype": {"name": "Subtask"}}}],
    "attachment": [{"id": "10", "filename": "flow.png", "mimeType": "image/png", "size": 2048,
      "content": "https://example.atlassian.net/rest/api/2/attachment/content/10"}],
    "description": "Run {{desk\\\\-jira get KAN\\\\-5}} and *read\\\\_it*.\\n{code}grep -c '\\\\[x\\\\]' f{code}"},
  "KAN-6": {"summary": "bare"},
  "KAN-7": {"summary": "links down"},
  "KAN-20": {"summary": "a story", "issuetype": {"name": "Story"}, "customfield_10208": {"value": "M"}},
  "KAN-30": {}, "KAN-31": {}, "KAN-32": {}, "KAN-33": {}, "KAN-34": {}},
 "fields": [{"id": "customfield_10207", "name": "Launch Priority", "custom": true, "schema": {"type": "option"}},
            {"id": "customfield_10208", "name": "Size", "custom": true, "schema": {"type": "option"}}],
 "remotelinks": {"KAN-5": [{"id": 1, "relationship": "mentioned in",
   "object": {"url": "https://github.com/acme/alpha/pull/7", "title": "PR 7"}}]},
 "remotelink_fail": ["KAN-7"]}
EOF
PORT=$((20000 + RANDOM % 20000)); LOG="$T/requests.log"; : > "$LOG"
python3 "$S/stub_jira.py" "$PORT" "$LOG" "" "$T/fixture.json" & STUB=$!
SLOWPORT=$((PORT + 1)); python3 "$S/stub_jira.py" "$SLOWPORT" "$T/slow.log" 1.5 & SLOW=$!
# A site where a deleted link is still there on the read-back.
cat > "$T/keep.json" <<'EOF'
{"unlink_readback": "keep", "issues": {
  "KAN-30": {"issuelinks": [{"id": "77", "type": {"name": "Relates", "inward": "relates to", "outward": "relates to"},
                             "outwardIssue": {"key": "KAN-31"}}]},
  "KAN-31": {"issuelinks": [{"id": "77", "type": {"name": "Relates", "inward": "relates to", "outward": "relates to"},
                             "inwardIssue": {"key": "KAN-30"}}]}}}
EOF
KEEPPORT=$((PORT + 2)); python3 "$S/stub_jira.py" "$KEEPPORT" "$T/keep.log" "" "$T/keep.json" & KEEP=$!
trap 'kill $STUB $SLOW $KEEP 2>/dev/null' EXIT
sleep 0.5

mkrepo() {  # name remote tracker site
  local d="$T/repos/$1"; git init -q "$d"; [ -n "$2" ] && git -C "$d" remote add origin "$2"
  local slug; slug=$(cd "$d" && node "$DESK_ENV_MJS" where | sed -n "s/^SLUG='\(.*\)'$/\1/p")
  mkdir -p "$DESK_CONFIG_ROOT/repos/$slug"
  printf '## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Tracker | `%s` |\n| Jira site | `%s` |\n| Jira project | `KAN` "x" |\n' "$3" "$4" > "$DESK_CONFIG_ROOT/repos/$slug/config.md"
  printf 'me@example.com' > "$DESK_CONFIG_ROOT/repos/$slug/jira-email"
  echo "$slug"
}
SLUG_A=$(mkrepo a "git@github.com:Acme/Alpha.git/" jira "http://127.0.0.1:$PORT")
SLUG_N=$(mkrepo n "https://github.com/acme/none" none none)
A="$T/repos/a"
check "slug lower-case, trailing slash dropped" '[ "$SLUG_A" = acme__alpha ]'
printf good-token > "$DESK_CONFIG_ROOT/repos/$SLUG_A/atlassian-token"; chmod 600 "$DESK_CONFIG_ROOT/repos/$SLUG_A/atlassian-token"

# H6: where via desk-env; DESK_SLUG no longer an override
out=$(cd "$A" && DESK_SLUG=evil__repo "$J" where)
check "where uses desk-env slug, ignores DESK_SLUG" 'printf "%s" "$out" | grep -q "^repo    : acme__alpha$"'
out=$(cd "$A" && DESK_REPO_OVERRIDE=Acme/None "$J" where)
check "DESK_REPO_OVERRIDE switches repo" 'printf "%s" "$out" | grep -q "^repo    : acme__none$"'
out=$(cd "$T/repos/n" && "$J" where)
check "where: Tracker none message" 'printf "%s" "$out" | grep -q "site    : (Tracker is none for acme__none)"'
err=$(cd "$T/repos/n" && "$J" search 'project=KAN' 2>&1); rc=$?
check "search with Tracker none dies with message" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "Tracker is none for acme__none"'

# H6 fallback: desk-env missing, same slugs for a URL table
for url in "git@github.com:Acme/Widget.git" "https://github.com/acme/widget/" "https://github.com/acme/widget.git/" \
           "ssh://git@github.com:443/Acme/Widget.git" "git@github-work:acme/widget.git" \
           "https://gitlab.example.com/group/sub/Widget.git" "github.com:acme/widget" "/srv/git/widget.git" \
           "https://github.com/widget" "git@github.com:/abs/acme/widget.git" ""; do
  URLN=$((${URLN:-0} + 1)); d="$T/repos/url-$URLN"; git init -q "$d"; [ -n "$url" ] && git -C "$d" remote add origin "$url"
  want=$(cd "$d" && node "$DESK_ENV_MJS" where | sed -n "s/^SLUG='\(.*\)'$/\1/p")
  got=$(cd "$d" && DESK_ENV_MJS=/nonexistent "$J" where | sed -n 's/^repo    : //p')
  check "fallback slug agrees for '$url' ($want)" '[ "$got" = "$want" ]'
done

# H3: token never on argv, never in xtrace
trace=$(cd "$A" && bash -x "$J" whoami 2>&1)
check "whoami works through curl -K -" 'printf "%s" "$trace" | grep -q "Me <me@example.com>"'
check "bash -x trace does not contain the token" '! printf "%s" "$trace" | grep -q good-token'
check "curl is never given -u" '! printf "%s" "$trace" | grep -qE "curl .* -u "'
( cd "$A" && JIRA_SITE="http://127.0.0.1:$SLOWPORT" JIRA_TOKEN=good-token "$J" whoami >/dev/null ) & BG=$!
seen=""
for _ in $(seq 1 100); do seen="$seen$(ps -axww -o args= | grep '[c]url' || true)"; done
wait $BG
check "ps actually saw the curl call (control)" 'printf "%s" "$seen" | grep -q "127.0.0.1:$SLOWPORT"' 
printf '%s\n' "$seen" | grep good-token | sort -u | cut -c1-240 | sed 's/^/  ps: /'
check "token not visible in ps during a call" '! printf "%s" "$seen" | grep -q good-token'

# H5: bad token -> auth failure, never "no issues"
printf bad-token > "$T/bad"; 
err=$(cd "$A" && JIRA_TOKEN_FILE="$T/bad" "$J" search 'project=KAN' 2>&1); rc=$?
check "search with bad token exits non-zero" '[ $rc -ne 0 ]'
check "search with bad token says auth failed" 'printf "%s" "$err" | grep -q "authentication failed for 127.0.0.1:$PORT\|authentication failed for http://127.0.0.1:$PORT as me@example.com"'
check "search with bad token never prints no issues" '! printf "%s" "$err" | grep -q "no issues"'
err=$(cd "$A" && JIRA_TOKEN_FILE="$T/bad" "$J" get KAN-1 2>&1); rc=$?
check "get with bad token says auth failed" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "authentication failed"'

# get prints the whole ticket, each element in its own labelled section
out=$(cd "$A" && "$J" get KAN-5 2>&1); rc=$?
check "get exits 0" '[ $rc -eq 0 ]'
check "get prints the parent with its type, after type" 'printf "%s\n" "$out" | grep -A1 "^type     : Story$" | grep -qx "parent   : KAN-2 (Epic) the epic"'
check "get prints a custom field longer than 120 characters in full" '[ ${#DESIGN_URL} -gt 120 ] && printf "%s\n" "$out" | grep -qxF "Design : $DESIGN_URL"'
check "get prints Blocks and Relates links under links:" 'printf "%s\n" "$out" | grep -A3 "^links:$" | grep -qx "  is blocked by KAN-3 (Task, Done) first" &&
  printf "%s\n" "$out" | grep -A3 "^links:$" | grep -qx "  blocks KAN-4 (Task, To Do) later" &&
  printf "%s\n" "$out" | grep -A3 "^links:$" | grep -qx "  relates to KAN-8 (Bug, To Do) nearby"'
check "get prints subtasks under subtasks:" 'printf "%s\n" "$out" | grep -A1 "^subtasks:$" | grep -qx "  KAN-9 (Subtask, To Do) a piece"'
check "get prints attachments under attachments:" 'printf "%s\n" "$out" | grep -A1 "^attachments:$" | grep -qxF "  flow.png (image/png, 2048 bytes) https://example.atlassian.net/rest/api/2/attachment/content/10"'
check "get prints remote web links under web links:" 'printf "%s\n" "$out" | grep -A1 "^web links:$" | grep -qxF "  PR 7 https://github.com/acme/alpha/pull/7 (mentioned in)"'
check "get prints the description with wiki escapes removed" 'printf "%s\n" "$out" | grep -qxF "Run {{desk-jira get KAN-5}} and *read_it*."'
check "get leaves a {code} block as written" 'printf "%s\n" "$out" | grep -qxF "{code}grep -c '"'\\\\[x\\\\]'"' f{code}"'
viewed=$(cd "$A" && "$J" view KAN-5 2>&1); rc=$?
check "view prints the same as get" '[ $rc -eq 0 ] && [ "$viewed" = "$out" ]'
helped=$(cd "$A" && "$J" help 2>&1); rc=$?
check "help and --help print the usage" '[ $rc -eq 0 ] && [[ "$helped" == *"desk-jira <command>"* ]] && [ "$(cd "$A" && "$J" --help 2>&1)" = "$helped" ]'
raw=$(cd "$A" && "$J" get KAN-5 --json | jq -r .fields.description | head -n1)
check "get --json keeps the raw description" '[ "$raw" = "Run {{desk\\-jira get KAN\\-5}} and *read\\_it*." ]'
out=$(cd "$A" && "$J" get KAN-6 2>&1); rc=$?
check "get with none of them says so in each section" '[ $rc -eq 0 ] && printf "%s\n" "$out" | grep -qx "parent   : -" &&
  printf "%s\n" "$out" | grep -qx "links: none" && printf "%s\n" "$out" | grep -qx "subtasks: none" &&
  printf "%s\n" "$out" | grep -qx "attachments: none" && printf "%s\n" "$out" | grep -qx "web links: none"'
out=$(cd "$A" && "$J" get KAN-7 2>/dev/null); rc=$?
check "get with unreadable web links says so, never none" '[ $rc -eq 0 ] && printf "%s\n" "$out" | grep -qx "web links: (could not read them)"'

out=$(cd "$A" && "$J" search 'project=KAN' 2>&1); rc=$?
check "search with good token lists issues" '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "^KAN-1"'
err=$(cd "$A" && JIRA_SITE=nonexistent.invalid "$J" search x 2>&1); rc=$?
check "unreachable site fails loudly" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "could not reach"'
err=$(cd "$A" && JIRA_SITE=http://example.com "$J" search x 2>&1); rc=$?
check "plain http to a remote host refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing plain http"'
for site in "http://localhost@127.0.0.1:$PORT" "http://127.0.0.1:$PORT@127.0.0.1:$PORT" "http://127.0.0.1.example.com" \
            "http://localhostevil.com" "http://[::1].example.com" "http://127.0.0.1:x@example.com" "http://127.0.0.1:"; do
  n0=$(wc -l < "$LOG")
  err=$(cd "$A" && JIRA_SITE="$site" "$J" whoami 2>&1); rc=$?
  check "plain http to look-alike $site refused, nothing sent" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing plain http" && [ "$(wc -l < "$LOG")" -eq "$n0" ]'
done
out=$(cd "$A" && JIRA_SITE="http://localhost:$PORT/" "$J" whoami 2>&1); rc=$?
check "plain http to localhost:<port> accepted" '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "Me <me@example.com>"'
out=$(cd "$A" && http_proxy=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 all_proxy=http://127.0.0.1:9 \
  NO_PROXY='' no_proxy='' "$J" whoami 2>&1); rc=$?
check "a local http site bypasses the proxy" '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "Me <me@example.com>"'

# H4: body files
printf 'hello from the repo' > "$A/body.md"
out=$(cd "$A" && "$J" comment KAN-1 body.md 2>&1); rc=$?
check "comment with a repo file is sent" '[ $rc -eq 0 ] && tail -n1 "$LOG" | grep -q "hello from the repo"'
printf 'tmp body' > "${TMPDIR:-/tmp}/desk-jira-test-body.md"
out=$(cd "$A" && "$J" comment KAN-1 "${TMPDIR:-/tmp}/desk-jira-test-body.md" 2>&1); rc=$?
check "comment with a TMPDIR file is sent" '[ $rc -eq 0 ]'
printf 'state body' > "$T/state/b.md"
out=$(cd "$A" && DESK_STATE="$T/state" "$J" comment KAN-1 "$T/state/b.md" 2>&1); rc=$?
check "comment with a DESK_STATE file is sent" '[ $rc -eq 0 ]'
n_before=$(wc -l < "$LOG")
for f in "$DESK_CONFIG_ROOT/repos/$SLUG_N/jira-email" "@$DESK_CONFIG_ROOT/repos/$SLUG_A/atlassian-token" /etc/hosts "$A/.git/config" ; do
  err=$(cd "$A" && "$J" comment KAN-1 "$f" 2>&1); rc=$?
  check "comment refuses $f" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing to send"'
done
ln -sf "$DESK_CONFIG_ROOT/repos/$SLUG_A/atlassian-token" "${TMPDIR:-/tmp}/desk-jira-test-link"
err=$(cd "$A" && "$J" comment KAN-1 "${TMPDIR:-/tmp}/desk-jira-test-link" 2>&1); rc=$?
check "a /tmp symlink to a token is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing to send"'
err=$(cd "$A" && "$J" edit KAN-1 "description=@/etc/hosts" 2>&1); rc=$?
check "edit field=@file outside roots refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing to send"'
err=$(cd "$A" && "$J" create Task s /etc/hosts 2>&1); rc=$?
check "create desc-file outside roots refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing to send"'
err=$(cd "$A" && "$J" attach KAN-1 /etc/hosts 2>&1); rc=$?
check "attach outside roots refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing to send"'
check "nothing refused reached the stub" '[ "$(wc -l < "$LOG")" -eq "$n_before" ]'

# rest: the REST recipes' writes, with desk-jira's own credentials and the same body-file rule.
printf '{"fields":{"summary":"from rest"}}' > "$A/put.json"
out=$(cd "$A" && "$J" rest put api/3/issue/KAN-1 put.json 2>&1); rc=$?
check "rest PUT sends the body file as JSON, authenticated" '[ $rc -eq 0 ] && tail -n1 "$LOG" | jq -e ".method == \"PUT\" and .path == \"/rest/api/3/issue/KAN-1\" and .authed and (.body | fromjson | .fields.summary) == \"from rest\"" >/dev/null'
out=$(cd "$A" && "$J" rest DELETE api/2/issueLink/999 2>&1); rc=$?
check "rest DELETE with no body; a 404 is an error naming the call" '[ $rc -ne 0 ] && tail -n1 "$LOG" | jq -e ".method == \"DELETE\" and .body == \"\"" >/dev/null && printf "%s" "$out" | grep -q "HTTP 404 from DELETE api/2/issueLink/999"'
n_before=$(wc -l < "$LOG")
err=$(cd "$A" && "$J" rest PUT api/3/issue/KAN-1 /etc/hosts 2>&1); rc=$?
check "rest refuses a body file outside the roots" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing to send"'
err=$(cd "$A" && "$J" rest GET api/3/myself 2>&1); rc=$?
check "rest refuses GET and points at api" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "a read is desk-jira api"'
err=$(cd "$A" && "$J" rest PATCH api/3/issue/KAN-1 2>&1); rc=$?
check "rest refuses any other method" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "PUT, POST or DELETE"'
check "nothing rest refused reached the stub" '[ "$(wc -l < "$LOG")" -eq "$n_before" ]'
check "no request anywhere carried a token in its body" '! grep -q "good-token" "$LOG"'

# create assigns the user under §3 jira-assign-self yes, reads the assignee back, and needs
# --route for anyone else
printf '\n## 3. Permissions\n\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n| `jira-assign-self` | x | `yes` | `yes` |\n' \
  >> "$DESK_CONFIG_ROOT/repos/$SLUG_A/config.md"
SLUG_B=$(mkrepo b "https://github.com/acme/beta" jira "http://127.0.0.1:$PORT"); B="$T/repos/b"
printf good-token > "$DESK_CONFIG_ROOT/repos/$SLUG_B/atlassian-token"; chmod 600 "$DESK_CONFIG_ROOT/repos/$SLUG_B/atlassian-token"
printf 'a body' > "$B/body.md"
sent_assignee() { jq -sc '[.[] | select(.method == "POST" and .path == "/rest/api/2/issue")] | last | .body | fromjson | .fields | if has("assignee") then .assignee else "absent" end' "$LOG"; }
creates() { jq -s '[.[] | select(.method == "POST" and .path == "/rest/api/2/issue")] | length' "$LOG"; }
out=$(cd "$A" && "$J" create Task s body.md --no-lint 2>&1); rc=$?
check "create with assign-self yes sends your accountId" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "{\"accountId\":\"abc\"}" ]'
check "create reads the assignee back" 'printf "%s" "$out" | grep -q "^  assignee: Me$"'
out=$(cd "$A" && "$J" create Task s body.md assignee=me --no-lint 2>&1); rc=$?
check "create assignee=me goes through without --route" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "{\"accountId\":\"abc\"}" ]'
out=$(cd "$A" && "$J" create Task s body.md assignee=null --no-lint 2>&1); rc=$?
check "create assignee=null stays unassigned" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "null" ] && printf "%s" "$out" | grep -q "^  assignee: -$"'
n0=$(creates)
err=$(cd "$A" && "$J" create Task s body.md assignee=xyz --no-lint 2>&1); rc=$?
check "create for someone else refused without --route" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q -- "--route" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$A" && "$J" create Task s body.md 'assignee={"name":"xyz"}' --no-lint 2>&1); rc=$?
check "create with a non-accountId assignee refused without --route" '[ $rc -ne 0 ] && [ "$(creates)" -eq "$n0" ]'
out=$(cd "$A" && "$J" create Task s body.md assignee=xyz --route --no-lint 2>&1); rc=$?
check "create for someone else with --route sends them" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "{\"accountId\":\"xyz\"}" ] && printf "%s" "$out" | grep -q "^  assignee: xyz$"'
out=$(cd "$B" && "$J" create Task s body.md --no-lint 2>&1); rc=$?
check "create without assign-self sends no assignee" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "\"absent\"" ] && printf "%s" "$out" | grep -q "^  assignee: -$"'

# Field rules from config §4: required fields per type, no XL outside an Epic, and the top
# priorities only the user sets (never a headless autopilot worker), recorded on the ticket.
SLUG_C=$(mkrepo c "https://github.com/acme/gamma" jira "http://127.0.0.1:$PORT"); C="$T/repos/c"
printf '| Priority | `customfield_10207` |\n| Required fields | `Epic, Story, Task, Bug: customfield_10208, customfield_10207` |\n| Size field | `customfield_10208` |\n| Priorities only you set | `P0` `P1` |\n' \
  >> "$DESK_CONFIG_ROOT/repos/$SLUG_C/config.md"
printf good-token > "$DESK_CONFIG_ROOT/repos/$SLUG_C/atlassian-token"; chmod 600 "$DESK_CONFIG_ROOT/repos/$SLUG_C/atlassian-token"
printf 'a body' > "$C/body.md"
sent_fields() { jq -sc '[.[] | select(.method == "POST" and .path == "/rest/api/2/issue")] | last | .body | fromjson | .fields | {s: .customfield_10208, p: .customfield_10207}' "$LOG"; }
puts() { jq -s '[.[] | select(.method == "PUT")] | length' "$LOG"; }
comments_sent() { jq -s '[.[] | select(.method == "POST" and (.path | test("/comment$")))] | length' "$LOG"; }
last_comment() { jq -sr '[.[] | select(.method == "POST" and (.path | test("/comment$")))] | last | .body | fromjson | .body' "$LOG"; }

n0=$(creates)
err=$(cd "$C" && "$J" create Story s body.md customfield_10207=P2 2>&1); rc=$?
check "create without a required field is refused and names it" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "a Story needs customfield_10208 (config §4 Required fields)" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$C" && "$J" create bug s body.md 2>&1); rc=$?
check "create names every missing field, type matched in any case" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "needs customfield_10207" && printf "%s" "$err" | grep -q "needs customfield_10208" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$C" && "$J" create Task s body.md customfield_10208= customfield_10207=P2 2>&1); rc=$?
check "create with a required field empty is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "needs customfield_10208" && [ "$(creates)" -eq "$n0" ]'
out=$(cd "$C" && "$J" create Story s body.md customfield_10208=M customfield_10207=P2 --no-lint 2>&1); rc=$?
check "create with every required field goes, options wrapped by name" '[ $rc -eq 0 ] && [ "$(sent_fields)" = "{\"s\":{\"value\":\"M\"},\"p\":{\"value\":\"P2\"}}" ]'
out=$(cd "$C" && "$J" create Subtask s body.md --no-lint 2>&1); rc=$?
check "a type with no rule needs no fields" '[ $rc -eq 0 ]'

n0=$(creates)
err=$(cd "$C" && "$J" create Task s body.md customfield_10208=XL customfield_10207=P2 2>&1); rc=$?
check "create with Size XL on a Task is refused and says to split it" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "split it into tickets of L or smaller" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$C" && "$J" create Story s body.md 'customfield_10208={"value":"xl"}' customfield_10207=P2 2>&1); rc=$?
check "create with Size xl as JSON on a Story is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "split it" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$C" && "$J" create Story s body.md 'customfield_10208={"id":"10301"}' customfield_10207=P2 2>&1); rc=$?
check "create with Size as an option id is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "by its option name" && [ "$(creates)" -eq "$n0" ]'
out=$(cd "$C" && "$J" create Epic s body.md customfield_10208=XL customfield_10207=P2 --no-lint 2>&1); rc=$?
check "an Epic may be XL" '[ $rc -eq 0 ] && [ "$(sent_fields)" = "{\"s\":{\"value\":\"XL\"},\"p\":{\"value\":\"P2\"}}" ]'
n0=$(creates)
err=$(cd "$C" && "$J" create Epic s body.md issuetype=Task customfield_10208=XL customfield_10207=P2 2>&1); rc=$?
check "an issuetype field overrides the type the rules read" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "XL on a Task" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$C" && "$J" create Epic s body.md 'issuetype={"id":"10001","name":"Epic"}' customfield_10208=XL customfield_10207=P2 2>&1); rc=$?
check "create refuses an issuetype carrying an id beside its name" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "pass issuetype by its name" && [ "$(creates)" -eq "$n0" ]'

p0=$(puts)
err=$(cd "$C" && "$J" edit KAN-20 customfield_10208=null 2>&1); rc=$?
check "edit clearing a required field is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing to clear customfield_10208: a Story needs it" && [ "$(puts)" -eq "$p0" ]'
err=$(cd "$C" && "$J" edit KAN-20 customfield_10207= 2>&1); rc=$?
check "edit setting a required field empty is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing to clear customfield_10207" && [ "$(puts)" -eq "$p0" ]'
err=$(cd "$C" && "$J" edit KAN-20 customfield_10208=XL 2>&1); rc=$?
check "edit setting XL on a Story is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "XL on a Story" && [ "$(puts)" -eq "$p0" ]'
err=$(cd "$C" && "$J" edit KAN-20 'issuetype={"id":"10000","name":"Epic"}' customfield_10208=XL 2>&1); rc=$?
check "edit refuses an issuetype carrying an id beside its name" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "pass issuetype by its name" && [ "$(puts)" -eq "$p0" ]'
err=$(cd "$C" && "$J" edit 'KAN-20?x=1' customfield_10208=XL 2>&1); rc=$?
check "edit refuses a key that is not a key" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "not an issue key" && [ "$(puts)" -eq "$p0" ]'
out=$(cd "$C" && "$J" edit KAN-20 customfield_10208=L 2>&1); rc=$?
check "edit to another size goes" '[ $rc -eq 0 ] && [ "$(puts)" -eq $((p0 + 1)) ] && printf "%s" "$out" | grep -q "customfield_10208: L"'
out=$(cd "$C" && "$J" edit KAN-6 'labels=["x"]' 2>&1); rc=$?
check "edit leaving the required fields alone goes" '[ $rc -eq 0 ] && [ "$(puts)" -eq $((p0 + 2)) ]'

n0=$(creates); p0=$(puts); c0=$(comments_sent)
err=$(cd "$C" && "$J" create Story s body.md customfield_10208=M customfield_10207=P1 2>&1); rc=$?
check "create at a top priority without --approved is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q -- "--approved" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$C" && "$J" edit KAN-20 customfield_10207=p0 2>&1); rc=$?
check "edit to a top priority without --approved is refused, any case" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q -- "--approved" && [ "$(puts)" -eq "$p0" ]'
err=$(cd "$C" && DESK_AUTOPILOT_WORKER=1 "$J" create Story s body.md customfield_10208=M customfield_10207=P1 --approved "the user said so" 2>&1); rc=$?
check "a headless worker cannot create at a top priority, even with --approved" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "headless autopilot worker" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$C" && DESK_AUTOPILOT_WORKER=1 "$J" edit KAN-20 customfield_10207=P0 2>&1); rc=$?
check "a headless worker cannot edit to a top priority" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "headless autopilot worker" && [ "$(puts)" -eq "$p0" ]'
err=$(cd "$C" && DESK_AUTOPILOT_WORKER=1 "$J" edit KAN-20 'customfield_10207={"id":"10400"}' 2>&1); rc=$?
check "a priority passed as an option id is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "by its name" && [ "$(puts)" -eq "$p0" ]'
out=$(cd "$C" && DESK_AUTOPILOT_WORKER=1 "$J" edit KAN-20 customfield_10207=P2 2>&1); rc=$?
check "a headless worker may set a lower priority" '[ $rc -eq 0 ] && [ "$(puts)" -eq $((p0 + 1)) ]'
check "nothing refused posted a comment" '[ "$(comments_sent)" -eq "$c0" ]'
err=$(cd "$C" && "$J" edit KAN-20 customfield_10207=P2 --approved "not needed" 2>&1); rc=$?
check "--approved on a lower priority is refused" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q -- "--approved is only for" && [ "$(puts)" -eq $((p0 + 1)) ]'
out=$(cd "$C" && "$J" create Story s body.md customfield_10208=M customfield_10207=P1 --approved "Launch blocks on it, per the user" --no-lint 2>&1); rc=$?
check "create at a top priority with --approved goes" '[ $rc -eq 0 ] && [ "$(creates)" -eq $((n0 + 1)) ] && [ "$(sent_fields)" = "{\"s\":{\"value\":\"M\"},\"p\":{\"value\":\"P1\"}}" ]'
check "the decision is recorded on the new ticket" '[ "$(comments_sent)" -eq $((c0 + 1)) ] && last_comment | grep -qxF "customfield_10207 set to P1 by Me: Launch blocks on it, per the user" &&
  last_comment | grep -qxF "(KAN-99/desk-jira priority)" && printf "%s" "$out" | grep -q "recorded on KAN-99"'
out=$(cd "$C" && "$J" edit KAN-20 customfield_10207=P0 --approved="the user: live harm" 2>&1); rc=$?
check "edit to a top priority with --approved= goes and is recorded" '[ $rc -eq 0 ] && [ "$(puts)" -eq $((p0 + 2)) ] && [ "$(comments_sent)" -eq $((c0 + 2)) ] &&
  last_comment | grep -qxF "customfield_10207 set to P0 by Me: the user: live harm"'

# With the built-in priority, Jira reads an option's name, so a decoy value beside it must not pass.
SLUG_D=$(mkrepo d "https://github.com/acme/delta" jira "http://127.0.0.1:$PORT"); D="$T/repos/d"
printf '| Priorities only you set | `Highest` `High` |\n' >> "$DESK_CONFIG_ROOT/repos/$SLUG_D/config.md"
printf good-token > "$DESK_CONFIG_ROOT/repos/$SLUG_D/atlassian-token"; chmod 600 "$DESK_CONFIG_ROOT/repos/$SLUG_D/atlassian-token"
p0=$(puts)
for v in 'priority=Highest' 'priority={"value":"","name":"Highest"}' 'priority={"value":"Low","name":"Highest"}' 'priority={"name":"high"}'; do
  err=$(cd "$D" && DESK_AUTOPILOT_WORKER=1 "$J" edit KAN-20 "$v" 2>&1); rc=$?
  check "a headless worker cannot set the built-in priority with $v" '[ $rc -ne 0 ] && [ "$(puts)" -eq "$p0" ]'
done
out=$(cd "$D" && DESK_AUTOPILOT_WORKER=1 "$J" edit KAN-20 priority=Low 2>&1); rc=$?
check "a headless worker may set the built-in priority lower" '[ $rc -eq 0 ] && [ "$(puts)" -eq $((p0 + 1)) ]'
# DS-31: a .md body is converted from markdown to wiki markup on create, comment and edit
# description=@file.md; a body already in wiki markup, and every other body, goes unchanged.
M="$A/md"; mkdir -p "$M"
has(){ grep -qxF -- "$2" "$1"; }
conv(){ (cd "$A" && "$J" md2wiki "$M/$1.md" > "$M/$1.out" 2>"$M/$1.err"); }
same(){ cmp -s "$M/$1.md" "$M/$1.out"; }
# The shape of VPL-288 (not on this site, so rebuilt): ## headings, numbered and dash lists, bold.
cat > "$M/vpl288.md" <<'EOF'
## Summary
Calls are not forwarded to the PA while the user is on another call.

## Steps to reproduce
1. Turn on **Forward when busy** in the app
2. Ring the user from a second phone
   - while they are on a call
3. The call drops

## Expected
- The call reaches the PA
- See [the spec](https://example.com/spec_(v2)) and `forward_when_busy`
EOF
conv vpl288
out=$(cd "$T" && "$J" md2wiki "$M/vpl288.md" 2>&1); rc=$?
check "md2wiki runs outside any repo, with no Jira site or credentials" '[ $rc -eq 0 ] && printf "%s\n" "$out" | cmp -s - "$M/vpl288.out"'
check "every ## heading becomes h2., the same count" '[ "$(grep -c "^h2\. " "$M/vpl288.out")" -eq "$(grep -c "^## " "$M/vpl288.md")" ] && has "$M/vpl288.out" "h2. Steps to reproduce"'
check "no markdown heading is left to render as a numbered list" '! grep -q "^##" "$M/vpl288.out"'
check "numbered items -> #, a nested dash -> #*, bold -> *x*" 'has "$M/vpl288.out" "# Turn on *Forward when busy* in the app" && has "$M/vpl288.out" "#* while they are on a call" && has "$M/vpl288.out" "# The call drops"'
check "dash list -> *, link -> [t|u], backticks -> {{}} with _ escaped" 'has "$M/vpl288.out" "* The call reaches the PA" && has "$M/vpl288.out" "* See [the spec|https://example.com/spec_(v2)] and {{forward\_when\_busy}}"'
# The shape of VPL-83's forwarding codes: asterisks and hashes that must not become effects or lists.
cat > "$M/vpl83.md" <<'EOF'
## Forwarding codes
Dial `**21*07700900123#` to forward every call, and `##21#` to cancel.

```
**61*07700900123*11*20#
#61#
```
EOF
conv vpl83
check "a forwarding code in backticks keeps every * and # as text" 'has "$M/vpl83.out" "Dial {{\*\*21\*07700900123\#}} to forward every call, and {{\#\#21\#}} to cancel."'
check "a forwarding code in a fence goes verbatim in {noformat}" '[ "$(grep -cxF "{noformat}" "$M/vpl83.out")" -eq 2 ] && has "$M/vpl83.out" "**61*07700900123*11*20#" && has "$M/vpl83.out" "#61#"'
# A body already in wiki markup goes byte for byte, even from a .md file (as the skills wrote it).
printf 'h2. Summary\nUse {{desk\\-jira}} and *bold*.\n# one\n# two\n' > "$M/wiki1.md"; conv wiki1
check "a .md file holding wiki markup (h2.) is sent unchanged" 'same wiki1'
printf 'Fixed. To check:\n# Open the page\n# Click save\n\n* as a tutor, with {{x}}\n' > "$M/wiki2.md"; conv wiki2
check "a wiki numbered list after text is not made headings" 'same wiki2'
printf 'See [the PR|https://github.com/acme/alpha/pull/7] and `x`.\n' > "$M/wiki3.md"; conv wiki3
check "a [text|url] link marks the body as wiki, a backtick beside it stays" 'same wiki3'
printf '%s' 'hello, no markup at all' > "$M/plain.md"; conv plain
check "a plain body is sent byte for byte, no newline added" 'same plain'
printf '## Kept\n`as is`\n' > "$M/k.wiki"; (cd "$A" && "$J" md2wiki "$M/k.wiki") > "$M/k.out"
check "a .wiki file is never converted" 'cmp -s "$M/k.wiki" "$M/k.out"'
printf 'h2. Kept\n```\nmd example: ## x\n```\n' > "$M/wiki4.md"; conv wiki4
check "a wiki heading anywhere keeps the body unchanged, a fence beside it included" 'same wiki4'
printf 'This is *important*.\n- one\n- two\n' > "$M/wiki5.md"; conv wiki5
check "a wiki - list beside *bold* is sent unchanged, bold kept bold" 'same wiki5'
printf -- '- one\n- two with \\-escaped\n' > "$M/md6.md"; conv md6
check "a - list with nothing wiki-like beside it converts" 'has "$M/md6.out" "* one"'
printf '```\nh2. inside a fence\n```\n## Real\n' > "$M/md5.md"; conv md5
check "wiki inside a fence does not stop a markdown body converting" 'has "$M/md5.out" "h2. Real" && has "$M/md5.out" "h2. inside a fence"'
err=$(cd "$A" && "$J" md2wiki "$M/missing.md" 2>&1); rc=$?
check "md2wiki of a missing file is an error" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "file not found"'
# The converter runs isolated: a module planted in the working directory is not imported.
mkdir -p "$T/cwd"; for m in re sys os encodings; do printf 'print("PLANTED-%s")\n' "$m" > "$T/cwd/$m.py"; done
printf '## Hi\n' > "$T/cwd/b.md"
out=$(cd "$T/cwd" && PYTHONPATH="$T/cwd" "$J" md2wiki b.md 2>&1)
check "a re.py in the working directory or on PYTHONPATH is not run" '[ "$out" = "h2. Hi" ]'

# What create, comment and edit send.
last_desc() { jq -sj '[.[] | select(.method == "POST" and .path == "/rest/api/2/issue")] | last | .body | fromjson | .fields.description' "$LOG"; }
last_put_desc() { jq -sj '[.[] | select(.method == "PUT")] | last | .body | fromjson | .fields.description' "$LOG"; }
last_body() { jq -sj '[.[] | select(.method == "POST" and (.path | test("/comment$")))] | last | .body | fromjson | .body' "$LOG"; }
out=$(cd "$A" && "$J" create Story s md/vpl288.md --no-lint 2>&1); rc=$?
check "create converts a .md description" '[ $rc -eq 0 ] && last_desc | cmp -s - "$M/vpl288.out"'
out=$(cd "$A" && "$J" create Story s md/wiki1.md --no-lint 2>&1); rc=$?
check "create sends a wiki .md description unchanged" '[ $rc -eq 0 ] && last_desc | cmp -s - "$M/wiki1.md"'
printf '## Not converted\n' > "$M/lit.txt"
out=$(cd "$A" && "$J" create Story s md/lit.txt --no-lint 2>&1); rc=$?
check "create sends a .txt description unchanged" '[ $rc -eq 0 ] && [ "$(last_desc)" = "## Not converted" ]'
out=$(cd "$A" && "$J" comment KAN-1 md/vpl83.md 2>&1); rc=$?
check "comment converts a .md body" '[ $rc -eq 0 ] && last_body | cmp -s - "$M/vpl83.out"'
out=$(cd "$A" && "$J" comment KAN-1 md/k.wiki 2>&1); rc=$?
check "comment sends a .wiki body unchanged" '[ $rc -eq 0 ] && last_body | cmp -s - "$M/k.wiki"'
out=$(cd "$A" && "$J" edit KAN-20 description=@md/vpl288.md 2>&1); rc=$?
check "edit description=@file.md converts" '[ $rc -eq 0 ] && last_put_desc | cmp -s - "$M/vpl288.out"'
out=$(cd "$A" && "$J" edit KAN-20 description=@md/wiki2.md 2>&1); rc=$?
check "edit description=@file.md of wiki markup goes unchanged" '[ $rc -eq 0 ] && last_put_desc | cmp -s - "$M/wiki2.md"'

# No Status, Priority, P0-P4 or Size line in a description; a first-line Size passes only where
# config names no §4 Size field (repo A has none, repo C has customfield_10208).
n0=$(creates); p0=$(puts)
for body in 'Priority: P2' '**Status:** In Progress' 'Launch Priority: P1' '* P1' 'h2. Context\nPriority = High' 'Intro\n\nSize: M'; do
  printf "$body\n" > "$M/fact.md"
  err=$(cd "$A" && "$J" create Story s md/fact.md --no-lint 2>&1); rc=$?
  check "create refuses a description line: $body" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "live in their fields" && [ "$(creates)" -eq "$n0" ]'
done
printf 'a body\n' > "$M/lit2.txt"
err=$(cd "$A" && "$J" create Story s md/lit2.txt 'description=Status: Done' --no-lint 2>&1); rc=$?
check "create refuses a Status line passed as a description= field" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "live in their fields" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$A" && "$J" create Story s md/lit2.txt description=@md/fact.md --no-lint 2>&1); rc=$?
check "create refuses a description=@file.md carrying a Size line" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "live in their fields" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$A" && "$J" edit KAN-20 'description=Status: Not Started' 2>&1); rc=$?
check "edit refuses a Status line in the description" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing line 1" && [ "$(puts)" -eq "$p0" ]'
printf 'Size: M\n\nh2. Context\nVPL-82 says Status: Not Started while it is In Progress, and P1 is the field.\n' > "$M/ok.md"
out=$(cd "$A" && "$J" create Story s md/ok.md --no-lint 2>&1); rc=$?
check "a first-line Size with no §4 Size field, and status quoted mid-sentence, pass" '[ $rc -eq 0 ] && [ "$(creates)" -eq $((n0 + 1)) ]'
printf '## Bug\nThe handler reads it:\n\n```python\nstatus = resp.status_code\np1 = Point(0, 0)\n```\n\n```\npriority: high\nsize: 3\n```\n' > "$M/codeok.md"
out=$(cd "$A" && "$J" create Story s md/codeok.md --no-lint 2>&1); rc=$?
check "status, priority and size lines inside code blocks are code, not fields" '[ $rc -eq 0 ] && [ "$(creates)" -eq $((n0 + 2)) ]'
n0=$((n0 + 1))
cp "$M/ok.md" "$C/ok.md"
err=$(cd "$C" && "$J" create Story s ok.md customfield_10208=M customfield_10207=P2 2>&1); rc=$?
check "a first-line Size is refused where §4 names a Size field" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q "refusing line 1" && [ "$(creates)" -eq $((n0 + 1)) ]'

# link takes any type the site has, by name or by its wording from KEY's side; unlink removes one.
# The stub keeps posted links on both issues and drops a deleted one from both.
L(){ : > "$LOG"; out=$(cd "$A" && "$J" "$@" 2>&1); rc=$?; }
posted(){ grep '"method": "POST"' "$LOG" | grep issueLink | jq -r .body | jq -r '"\(.type.name) \(.inwardIssue.key) \(.outwardIssue.key)"'; }
deletes(){ grep -c '"method": "DELETE"' "$LOG"; }
L link KAN-30 relates KAN-31
check "link relates: a Relates link, KEY inward, read back" '[ $rc -eq 0 ] && [ "$(posted)" = "Relates KAN-30 KAN-31" ] && [ "$out" = "linked: KAN-30 relates to KAN-31 (read back)" ]'
L link KAN-31 relates-to KAN-30
check "a symmetric link already there from the other side is skipped" '[ $rc -eq 0 ] && [ -z "$(posted)" ] && printf "%s" "$out" | grep -q "^already linked"'
L link KAN-30 duplicates KAN-32
check "link duplicates: outward wording puts KEY inward" '[ $rc -eq 0 ] && [ "$(posted)" = "Duplicate KAN-30 KAN-32" ] && printf "%s" "$out" | grep -qx "linked: KAN-30 duplicates KAN-32 (read back)"'
L link KAN-30 is-duplicated-by KAN-33
check "link is-duplicated-by: inward wording puts OTHER inward" '[ $rc -eq 0 ] && [ "$(posted)" = "Duplicate KAN-33 KAN-30" ] && printf "%s" "$out" | grep -qx "linked: KAN-30 is duplicated by KAN-33 (read back)"'
L link KAN-32 duplicates KAN-30
check "the reverse of an existing Duplicate link is refused" '[ $rc -ne 0 ] && [ -z "$(posted)" ] && printf "%s" "$out" | grep -q "reverse"'
L link KAN-34 Cloners KAN-30
check "link by type name (Cloners) reads as the outward verb" '[ $rc -eq 0 ] && [ "$(posted)" = "Cloners KAN-34 KAN-30" ] && printf "%s" "$out" | grep -qx "linked: KAN-34 clones KAN-30 (read back)"'
L link KAN-34 "is cloned by" KAN-31
check "link with spaced inward wording" '[ $rc -eq 0 ] && [ "$(posted)" = "Cloners KAN-31 KAN-34" ]'
L link KAN-30 BLOCKED-BY KAN-34
check "link blocked-by in any case is a Blocks link with OTHER inward" '[ $rc -eq 0 ] && [ "$(posted)" = "Blocks KAN-34 KAN-30" ] && printf "%s" "$out" | grep -qx "linked: KAN-30 is blocked by KAN-34 (read back)"'
L link KAN-30 frobs KAN-31
check "an unknown type is refused and the site's types are named" '[ $rc -ne 0 ] && [ -z "$(posted)" ] && printf "%s" "$out" | grep -q "Duplicate (duplicates / is duplicated by)"'

L unlink KAN-30 KAN-32
check "unlink sends one DELETE and says what it removed" '[ $rc -eq 0 ] && [ "$(deletes)" = 1 ] && printf "%s\n" "$out" | grep -qx "unlinked: KAN-30 duplicates KAN-32 (read back)"'
check "unlink prints the links left, without the removed one" 'printf "%s\n" "$out" | grep -qx "links:" && printf "%s\n" "$out" | grep -q "^  relates to KAN-31 " && ! printf "%s\n" "$out" | grep -q "^  duplicates KAN-32"'
L get KAN-32
check "the link is gone from the other issue too" 'printf "%s\n" "$out" | grep -qx "links: none"'
L unlink KAN-30 KAN-32
check "unlink with no link between them deletes nothing and says so" '[ $rc -eq 0 ] && [ "$(deletes)" = 0 ] && printf "%s\n" "$out" | grep -qx "not linked: KAN-30 has no link to KAN-32"'
L link KAN-30 blocks KAN-31
L unlink KAN-30 KAN-31
check "unlink refuses when two types link them, and names both" '[ $rc -ne 0 ] && [ "$(deletes)" = 0 ] && printf "%s" "$out" | grep -q "Blocks: blocks" && printf "%s" "$out" | grep -q "Relates: relates to"'
L unlink KAN-30 KAN-31 relates
check "unlink with a type removes only that type" '[ $rc -eq 0 ] && [ "$(deletes)" = 1 ] && printf "%s\n" "$out" | grep -qx "unlinked: KAN-30 relates to KAN-31 (read back)" && printf "%s\n" "$out" | grep -q "^  blocks KAN-31 "'
out=$(cd "$A" && JIRA_SITE="http://127.0.0.1:$KEEPPORT" "$J" unlink KAN-30 KAN-31 2>&1); rc=$?
check "a delete the read-back still shows fails" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -q "still shows: relates to KAN-31"'
L link KAN-30 blocks KAN-30
check "a self link is refused" '[ $rc -ne 0 ] && [ -z "$(posted)" ]'

# lint checks a ticket or a draft against the ticket template; create refuses a blocking finding.
LD="$A/lint"; mkdir -p "$LD"
# A draft with every section the template asks for (repo A's Size field is the site's "Size").
clean(){ cat <<'EOF'
_Context: none._

## Outcome
Reviewers see what a ticket lacks before it reaches a batch.

## Acceptance criteria
1. AC1: Given a draft, when lint runs, then it lists each finding with its severity.

## Verification
* Unit: tests/test_jira.sh.

## Design
No UI.

## Out of scope
* None.

## Decisions
* 2026-10-17 Ben: lint before create.

## Build on
* `bin/desk-jira`
EOF
}
clean > "$LD/clean.md"
lint(){ out=$(cd "$A" && "$J" lint "$@" 2>&1); rc=$?; }
lint "$LD/clean.md" customfield_10208=M
check "lint: a clean draft has no findings and exits 0" '[ $rc -eq 0 ] && [ "$out" = "ok: no findings" ]'
# Each blocking finding: the clean draft with one thing changed.
clean | grep -v -e '^## Acceptance criteria' -e '^1\. AC1' > "$LD/nocrit.md"
lint "$LD/nocrit.md" customfield_10208=M
check "lint: no acceptance criteria is blocking, exit 1" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "^blocking: no acceptance criteria"'
for open in 'TBD' 'TODO' 'needs a decision' 'proposal for' 'decide'; do
  clean | awk -v o="$open" '{ print } /^\* None\.$/ { print "* Whether to " o " the rest." }' > "$LD/open.md"
  lint "$LD/open.md" customfield_10208=M
  check "lint: an open decision ($open) is blocking" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "^blocking: line [0-9]* leaves a decision open"'
done
clean | awk '{ print } /^Reviewers see/ { print "Should it also fix them?" }' > "$LD/q.md"
lint "$LD/q.md" customfield_10208=M
check "lint: a question mark in scope is blocking" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "^blocking: line [0-9]* asks a question in Outcome"'
clean | awk '{ print } /^Reviewers see/ { print "See `a?` and https://example.com/a?b=1." } /^\* Unit/ { print "* Manual: does it list them?" }' > "$LD/q2.md"
lint "$LD/q2.md" customfield_10208=M
check "lint: a question mark outside scope, in code or in a URL is not" '[ $rc -eq 0 ]'
clean | grep -v -e '^## Design' -e '^No UI' > "$LD/nodesign.md"
lint "$LD/nodesign.md" customfield_10208=M
check "lint: no design link and no No UI line is blocking" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "^blocking: no design link"'
clean | awk '{ if ($0 == "No UI.") print "https://www.figma.com/design/Ab/x?node-id=1-2"; else print }' > "$LD/figma.md"
lint "$LD/figma.md" customfield_10208=M
check "lint: a design URL in the Design section passes" '[ $rc -eq 0 ]'
lint "$LD/clean.md"
check "lint: Size unset is blocking" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "^blocking: Size is unset"'
{ printf 'Size: S\n\n'; clean; } > "$LD/sized.md"
lint "$LD/sized.md"
check "lint: a first-line Size counts as set" '[ $rc -eq 0 ]'
lint "$LD/clean.md" Subtask
check "lint: a subtask needs no Size (its parent is sized)" '[ $rc -eq 0 ]'
for ac in 'then KAN-3 is linked to KAN-4' 'then the field is set in Jira' 'then the p95 is measured in production' 'then an operator restarts the service'; do
  clean | awk -v a="$ac" '{ print } /^1\. AC1/ { print "2. AC2: Given a filed ticket, when it is picked up, " a "." }' > "$LD/ac.md"
  lint "$LD/ac.md" customfield_10208=M
  check "lint: a criterion the worker cannot do ($ac) is blocking" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "^blocking: line [0-9]* is a criterion the worker cannot do"'
done
clean | awk '{ print } /^1\. AC1/ { print "2. AC2: Given a live session, when the link is created, then it is read back." }' > "$LD/acok.md"
lint "$LD/acok.md" customfield_10208=M
check "lint: a criterion about link code, or a live session, is one the worker can do" '[ $rc -eq 0 ]'
# Advisory findings do not fail the lint.
clean | grep -v -e '^## Out of scope' -e '^\* None' -e '^## Verification' -e '^\* Unit' > "$LD/adv0.md"
{ cat "$LD/adv0.md"; printf '\nPriority: P2\n'; } > "$LD/adv.md"
lint "$LD/adv.md" customfield_10208=M
check "lint: no Out of scope and no Verification are advisory, exit 0" '[ $rc -eq 0 ] && printf "%s\n" "$out" | grep -q "^advisory: no \"Out of scope\" section" && printf "%s\n" "$out" | grep -q "^advisory: no \"Verification\" section"'
check "lint: a priority line in the body is advisory" 'printf "%s\n" "$out" | grep -q "^advisory: line [0-9]*, \"Priority: P2\": status, priority and size live in their fields"'
lint "$LD/nocrit.md" customfield_10208=M --json
check "lint --json: an array of findings with severity" '[ $rc -eq 1 ] && printf "%s" "$out" | jq -e "map(select(.severity == \"blocking\" and .rule == \"criteria\")) | length == 1" >/dev/null'

# With no §4 Size field row, the Size field is the one that fits the project (KAN, id 10101 here):
# global, or scoped to it. Repo A has no row; repo C names customfield_10208.
jq -n '{projects: {KAN: "10101"}, issues: {
    "KAN-50": {issuetype: {name: "Story"}, customfield_10174: {value: "M"}, customfield_10208: {value: "M"},
               _names: {customfield_10174: "Size", customfield_10208: "Size"}}},
  fields: [
    {id: "customfield_10174", name: "Size", custom: true, schema: {type: "option"}, scope: {type: "PROJECT", project: {id: "10034"}}},
    {id: "customfield_10208", name: "Size", custom: true, schema: {type: "option"}, scope: {type: "PROJECT", project: {id: "10101"}}}]}' > "$T/scoped.json"
jq '.fields[0] |= del(.scope)' "$T/scoped.json" > "$T/both.json"
SPORT=$((PORT + 5)); python3 "$S/stub_jira.py" "$SPORT" "$T/scoped.log" "" "$T/scoped.json" & SSTUB=$!
BPORT=$((PORT + 6)); python3 "$S/stub_jira.py" "$BPORT" "$T/both.log" "" "$T/both.json" & BSTUB=$!
trap 'kill $STUB $SLOW $KEEP $SSTUB $BSTUB 2>/dev/null' EXIT
sleep 0.5
slint(){ out=$(cd "$1" && JIRA_SITE="http://127.0.0.1:$2" "$J" lint "${@:3}" 2>&1); rc=$?; }
slint "$A" "$SPORT" "$LD/clean.md" customfield_10208=M
check "lint: with no Size field row, Size is read from the field scoped to the project, not another's" '[ $rc -eq 0 ] && [ "$out" = "ok: no findings" ]'
slint "$A" "$SPORT" "$LD/clean.md" customfield_10174=M
check "lint: another project's Size field does not count as Size" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "^blocking: Size is unset"'
slint "$A" "$BPORT" "$LD/clean.md" customfield_10208=M
check "lint: two Size fields that fit the project are named with the config row, and neither is picked" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -qx "desk-jira: more than one field named Size fits project KAN (customfield_10174, customfield_10208): add the \"Size field\" row to config §4 to name one" && printf "%s\n" "$out" | grep -q "^blocking: Size is unset"'
slint "$A" "$BPORT" KAN-50
check "lint KEY: two Size fields on the issue are named, and neither is picked" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "more than one field named Size fits project KAN (customfield_10174, customfield_10208)"'
slint "$C" "$BPORT" "$LD/clean.md" customfield_10208=M
check "lint: a Size field row is used as it is, whatever the site holds" '[ $rc -eq 0 ] && [ "$out" = "ok: no findings" ]'
kill $SSTUB $BSTUB 2>/dev/null

# Tickets read from Jira: KAN-45 is clean; KAN-46 has every advisory; KAN-47 links an unsaved
# Claude Design canvas.
cat > "$LD/45.wiki" <<'EOF'
_Context: Part of the KAN-2 epic._

h2. Outcome
Reviewers see what a ticket lacks before it reaches a batch.
h2. Acceptance criteria
# AC1: Given a ticket, when lint runs, then it lists each finding.
h2. Verification
* Unit: tests/test\_jira.sh.
h2. Design
No UI.
h2. Out of scope
* None.
EOF
cat > "$LD/46.wiki" <<'EOF'
h2. Outcome
Builds on KAN-3 and KAN-4, and on Lint every ticket before create.

## Notes
Run **this**, `that` and {{desk-jira --json}}.
Priority: P2
h2. Acceptance criteria
# AC1: Given a ticket, when lint runs, then it lists each finding.
h2. Verification
* Unit: tests/test\_jira.sh.
h2. Design
No UI.
h2. Out of scope
* None.
EOF
printf 'h2. Acceptance criteria\n# AC1: Given a ticket, when lint runs, then it lists each finding.\nh2. Design\nhttps://claude.ai/design/p/abc123\nh2. Verification\n* none\nh2. Out of scope\n* None.\n' > "$LD/47.wiki"
jq -n --rawfile d45 "$LD/45.wiki" --rawfile d46 "$LD/46.wiki" --rawfile d47 "$LD/47.wiki" '
  {"issues": {
    "KAN-2": {"summary": "the epic", "issuetype": {"name": "Epic", "hierarchyLevel": 1}},
    "KAN-45": {"summary": "Lint every ticket before create", "issuetype": {"name": "Story"}, "description": $d45,
      "parent": {"key": "KAN-2", "fields": {"summary": "the epic", "issuetype": {"name": "Epic", "hierarchyLevel": 1}}},
      "customfield_10208": {"value": "M"}, "_names": {"customfield_10208": "Size"}},
    "KAN-46": {"summary": "Record the lint for plan-batch", "issuetype": {"name": "Story"}, "description": $d46,
      "parent": {"key": "KAN-2", "fields": {"summary": "the epic", "issuetype": {"name": "Epic", "hierarchyLevel": 1}}},
      "customfield_10208": {"value": "S"}, "_names": {"customfield_10208": "Size"},
      "issuelinks": [{"id": "5", "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"}, "inwardIssue": {"key": "KAN-3"}}]},
    "KAN-47": {"summary": "a canvas", "issuetype": {"name": "Story"}, "description": $d47,
      "customfield_10208": {"value": "S"}, "_names": {"customfield_10208": "Size"}}},
   "children": {"KAN-2": ["KAN-45", "KAN-46"]},
   "fields": [{"id": "customfield_10208", "name": "Size", "custom": true, "schema": {"type": "option"}}]}' > "$T/lint.json"
LPORT=$((PORT + 3)); python3 "$S/stub_jira.py" "$LPORT" "$T/lint.log" "" "$T/lint.json" & LSTUB=$!
trap 'kill $STUB $SLOW $KEEP $LSTUB 2>/dev/null' EXIT
sleep 0.5
klint(){ out=$(cd "$A" && JIRA_SITE="http://127.0.0.1:$LPORT" "$J" lint "$@" 2>&1); rc=$?; }
klint KAN-45
check "lint KEY: a clean ticket (parent and sibling excluded) has no findings" '[ $rc -eq 0 ] && [ "$out" = "ok: no findings" ]'
klint KAN-46
check "lint KEY: only advisory findings, exit 0" '[ $rc -eq 0 ] && ! printf "%s\n" "$out" | grep -q "^blocking"'
check "lint KEY: a key named with no Blocks link is advisory, a linked one is not" 'printf "%s\n" "$out" | grep -q "^advisory: names KAN-4 with no Blocks link"'
check "lint KEY: a sibling title named with no Blocks link is advisory" 'printf "%s\n" "$out" | grep -q "^advisory: names its sibling KAN-45 (\"Lint every ticket before create\")"'
check "lint KEY: a status or priority line is advisory" 'printf "%s\n" "$out" | grep -q "^advisory: line [0-9]*, \"Priority: P2\""'
check "lint KEY: markdown that will not render is advisory, each kind named" 'printf "%s\n" "$out" | grep "^advisory: markdown that will not render" | grep "markdown heading" | grep "\*\*bold\*\*" | grep "backtick span" | grep -q "unescaped -- inside"'
klint KAN-47
check "lint KEY: an unsaved Claude Design canvas is desk-design's blocking finding" '[ $rc -eq 1 ] && printf "%s\n" "$out" | grep -q "^blocking: design: KAN-47.s Design section links the Claude Design artifact https://claude.ai/design/p/abc123, but no copy is saved"'
mkdir -p "$T/state/designs/KAN-47"; printf '{"url":"https://claude.ai/design/p/abc123#board"}' > "$T/state/designs/KAN-47/source.json"
out=$(cd "$A" && DESK_AUTOPILOT_STATE="$T/state" JIRA_SITE="http://127.0.0.1:$LPORT" "$J" lint KAN-47 2>&1); rc=$?
check "lint KEY: a canvas autopilot has snapshotted is advisory, the worker saves it" '[ $rc -eq 0 ] && printf "%s\n" "$out" | grep -q "^advisory: design: .*no copy is saved.*autopilot has snapshotted it"'
mkdir -p "$A/docs/design/KAN-47"; printf '{"url":"https://claude.ai/design/p/abc123","version":"1","tickets":[{"key":"KAN-47","boards":[]}]}' > "$A/docs/design/KAN-47/source.json"
klint KAN-47
check "lint KEY: a saved canvas not named beside the link is desk-design's advisory" '[ $rc -eq 0 ] && printf "%s\n" "$out" | grep -q "^advisory: design: .*not its saved copy docs/design/KAN-47/"'
klint KAN-46 Story
check "lint KEY takes no type or fields" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -q "pass no type or fields"'

# DS-2 to DS-25 as rewritten on 2026-10-16 (descriptions recorded from desk-jira get --json on
# 2026-10-18): none has a blocking finding, under the DS project's own key pattern.
jq -s '{issues: (map({key: .key, value: {summary: .key, issuetype: {name: .type}, description: .d,
  customfield_10208: {value: .size}, _names: {customfield_10208: "Size"}}}) | from_entries)}' "$S/lint_corpus.jsonl" > "$T/corpus.json"
CPORT=$((PORT + 4)); python3 "$S/stub_jira.py" "$CPORT" "$T/corpus.log" "" "$T/corpus.json" & CSTUB=$!
trap 'kill $STUB $SLOW $KEEP $LSTUB $CSTUB 2>/dev/null' EXIT
SLUG_DS=$(mkrepo ds "https://github.com/acme/ds" jira "http://127.0.0.1:$CPORT")
printf '| Ticket key pattern | `DS-[0-9]+` |\n' >> "$DESK_CONFIG_ROOT/repos/$SLUG_DS/config.md"
printf good-token > "$DESK_CONFIG_ROOT/repos/$SLUG_DS/atlassian-token"; chmod 600 "$DESK_CONFIG_ROOT/repos/$SLUG_DS/atlassian-token"
sleep 0.5
blocked=''; n=0
for k in $(jq -r .key "$S/lint_corpus.jsonl"); do
  out=$(cd "$T/repos/ds" && "$J" lint "$k" 2>&1); rc=$?; n=$((n + 1))
  [ $rc -eq 0 ] || blocked="$blocked $k(rc $rc: $(printf '%s' "$out" | grep -m1 -v '^advisory'))"
done
check "lint: DS-2 to DS-25 ($n tickets) have no blocking finding" '[ "$n" -eq 24 ] && [ -z "$blocked" ]'
[ -z "$blocked" ] || printf '  blocked:%s\n' "$blocked"

# create lints first: a blocking finding stops it, before anything is posted.
n0=$(creates)
err=$(cd "$A" && "$J" create Story s lint/nocrit.md customfield_10208=M 2>&1); rc=$?
check "create with a blocking finding is refused and prints it" '[ $rc -ne 0 ] && printf "%s\n" "$err" | grep -q "not created: the ticket has blocking findings" && printf "%s\n" "$err" | grep -q "^blocking: no acceptance criteria" && [ "$(creates)" -eq "$n0" ]'
out=$(cd "$A" && "$J" create Story s lint/nocrit.md customfield_10208=M --no-lint 2>&1); rc=$?
check "create --no-lint skips the lint" '[ $rc -eq 0 ] && [ "$(creates)" -eq $((n0 + 1)) ]'
out=$(cd "$A" && "$J" create Story s lint/adv0.md customfield_10208=M 2>&1); rc=$?
check "create with only advisory findings goes, and prints them" '[ $rc -eq 0 ] && [ "$(creates)" -eq $((n0 + 2)) ] && printf "%s\n" "$out" | grep -q "^advisory: no \"Verification\" section"'

rm -f "${TMPDIR:-/tmp}/desk-jira-test-body.md" "${TMPDIR:-/tmp}/desk-jira-test-link"
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
