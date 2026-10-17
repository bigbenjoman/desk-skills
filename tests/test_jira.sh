#!/usr/bin/env bash
# Tests for bin/desk-jira against a local stub. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$S/.." && pwd)"
J="$SRC/bin/desk-jira"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/repos" "$T/state"
export HOME="$T/home" DESK_CONFIG_ROOT="$T/home/.config/desk" DESK_ENV_MJS="$SRC/desk/bin/desk-env.mjs"
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG JIRA_SITE JIRA_TOKEN JIRA_EMAIL DESK_STATE DESK_REPO_DIR
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
  "KAN-7": {"summary": "links down"}},
 "remotelinks": {"KAN-5": [{"id": 1, "relationship": "mentioned in",
   "object": {"url": "https://github.com/acme/alpha/pull/7", "title": "PR 7"}}]},
 "remotelink_fail": ["KAN-7"]}
EOF
PORT=$((20000 + RANDOM % 20000)); LOG="$T/requests.log"; : > "$LOG"
python3 "$S/stub_jira.py" "$PORT" "$LOG" "" "$T/fixture.json" & STUB=$!
SLOWPORT=$((PORT + 1)); python3 "$S/stub_jira.py" "$SLOWPORT" "$T/slow.log" 1.5 & SLOW=$!
trap 'kill $STUB $SLOW 2>/dev/null' EXIT
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
out=$(cd "$A" && "$J" create Task s body.md 2>&1); rc=$?
check "create with assign-self yes sends your accountId" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "{\"accountId\":\"abc\"}" ]'
check "create reads the assignee back" 'printf "%s" "$out" | grep -q "^  assignee: Me$"'
out=$(cd "$A" && "$J" create Task s body.md assignee=me 2>&1); rc=$?
check "create assignee=me goes through without --route" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "{\"accountId\":\"abc\"}" ]'
out=$(cd "$A" && "$J" create Task s body.md assignee=null 2>&1); rc=$?
check "create assignee=null stays unassigned" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "null" ] && printf "%s" "$out" | grep -q "^  assignee: -$"'
n0=$(creates)
err=$(cd "$A" && "$J" create Task s body.md assignee=xyz 2>&1); rc=$?
check "create for someone else refused without --route" '[ $rc -ne 0 ] && printf "%s" "$err" | grep -q -- "--route" && [ "$(creates)" -eq "$n0" ]'
err=$(cd "$A" && "$J" create Task s body.md 'assignee={"name":"xyz"}' 2>&1); rc=$?
check "create with a non-accountId assignee refused without --route" '[ $rc -ne 0 ] && [ "$(creates)" -eq "$n0" ]'
out=$(cd "$A" && "$J" create Task s body.md assignee=xyz --route 2>&1); rc=$?
check "create for someone else with --route sends them" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "{\"accountId\":\"xyz\"}" ] && printf "%s" "$out" | grep -q "^  assignee: xyz$"'
out=$(cd "$B" && "$J" create Task s body.md 2>&1); rc=$?
check "create without assign-self sends no assignee" '[ $rc -eq 0 ] && [ "$(sent_assignee)" = "\"absent\"" ] && printf "%s" "$out" | grep -q "^  assignee: -$"'
rm -f "${TMPDIR:-/tmp}/desk-jira-test-body.md" "${TMPDIR:-/tmp}/desk-jira-test-link"
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
