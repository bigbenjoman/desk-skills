#!/usr/bin/env bash
# triage.sh's headless claude -p calls must receive every flag they are written with: a stub claude on
# PATH records its argv, and the first pass and the lane challenge are each checked for the flags,
# the redirects and the `|| true` (the stub exits non-zero). Scratch HOME and repo only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/tickets" "$T/skills/desk-ticket/references" "$T/stub"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_DEFAULT_BRANCH AUTOPILOT_SKIP_CHALLENGE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
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

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`none\` |
| Other work id patterns | \`none\` |
EOF
: > "$T/skills/desk-ticket/references/desk-ticket-routing.md"
printf '# fix-thing\n\nSource: the user\n\nFix the thing.\n' > "$T/state/tickets/fix-thing.md"
export DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_STATE="$T/state" DESK_QUEUE="$T/queue.json" \
  DESK_SKILLS_DIR="$T/skills" STUB_LOG="$T/argv" STUB_LANE=A

# The stub writes each call's argv (NUL-separated) to its own file, writes the record the prompt asks
# for, then talks on stdout and stderr and fails, as a claude that hit its budget would.
cat > "$T/stub/claude" <<'EOF'
#!/usr/bin/env bash
n=$(ls "$STUB_LOG".* 2>/dev/null | wc -l | tr -d ' ')
printf '%s\0' "$@" > "$STUB_LOG.$n"
if [ "$n" = 0 ]; then
  printf '{"ticket":"fix-thing","lane":"%s","branch":"fix/fix-thing"}' "$STUB_LANE" > "$DESK_STATE/triage/fix-thing.json"
else
  printf '{"verdict":"CONFIRM","lane":"%s","reason":"stub"}' "$STUB_LANE" > "$DESK_STATE/triage/fix-thing.challenge.json"
fi
echo "STUB-STDOUT"; echo "STUB-STDERR" >&2
exit 1
EOF
chmod +x "$T/stub/claude"
export PATH="$T/stub:$PATH"

# has <call n> <flag> [<value>]: the flag is in that call's argv, followed by the value when one is given.
has(){ [ -f "$STUB_LOG.$1" ] && node -e '
  const a = require("fs").readFileSync(process.argv[1], "utf8").split("\0").slice(0, -1);
  const [flag, val] = process.argv.slice(2);
  process.exit(a.some((x, i) => x === flag && (val === undefined || a[i + 1] === val)) ? 0 : 1);' "$STUB_LOG.$1" "${@:2}"; }

flags_ok(){ local n="$1" budget="$2"
  has "$n" -p && has "$n" --setting-sources "" && has "$n" --strict-mcp-config \
    && has "$n" --settings "$T/state/workers/fix-thing.triage.settings.json" \
    && has "$n" --permission-mode dontAsk \
    && has "$n" --add-dir "$T/state" && has "$n" --add-dir "$T/skills" \
    && has "$n" --max-budget-usd "$budget" && has "$n" --output-format text; }

cd "$T/repo" || exit 1
out=$(bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "lane A: triage succeeds though claude exits non-zero (|| true)" '[ $rc -eq 0 ]'
check "lane A: one claude call, no challenge"                           '[ -f "$STUB_LOG.0" ] && [ ! -f "$STUB_LOG.1" ]'
check "first pass receives every flag"                                  'flags_ok 0 3'
check "first pass output goes to /dev/null"                             '[ -f "$STUB_LOG.0" ] && [[ "$out" != *STUB-* ]]'

rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
export STUB_LANE=C
out=$(bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "lane C: triage succeeds and challenges"                          '[ $rc -eq 0 ] && [ -f "$STUB_LOG.1" ]'
check "challenge receives every flag"                                   'flags_ok 1 2'
check "challenge output goes to /dev/null"                              '[ -f "$STUB_LOG.1" ] && [[ "$out" != *STUB-* ]]'

check "shellcheck: no flag parsed as a command (SC2215) in desk/bin" \
  '! command -v shellcheck >/dev/null || ! shellcheck -S warning -f gcc "$B"/*.sh 2>/dev/null | grep -q SC2215'

echo "triage: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
