#!/usr/bin/env bash
# suite: triage (claude -p receives every flag)
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
  printf '{"ticket":"fix-thing","lane":"%s","branch":"fix/fix-thing","change_kind":"%s"}' "$STUB_LANE" "${STUB_KIND-surface}" > "$DESK_STATE/triage/fix-thing.json"
else
  [ -n "${STUB_CHAL:-}" ] || STUB_CHAL=$(printf '{"verdict":"CONFIRM","lane":"%s","reason":"stub"}' "$STUB_LANE")
  printf '%s' "$STUB_CHAL" > "$DESK_STATE/triage/fix-thing.challenge.json"
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

# The rendered triage settings decide every git call a prompt names. permits <settings> <command>:
# each `|` stage matches an allow rule and no deny rule, read the way the harness reads them (a
# trailing `:*` is a prefix, any other `*` a glob, neither an exact string). `match.js prompt <argv>`
# prints each backticked `git …` span of that call's -p prompt, one per line, placeholders as `x`.
cat > "$T/match.js" <<'EOF'
const fs = require('fs');
const [mode, a, b] = process.argv.slice(2);
if (mode === 'prompt') {
  const argv = fs.readFileSync(a, 'utf8').split('\0');
  const prompt = argv[argv.indexOf('-p') + 1] || '';
  for (const m of prompt.matchAll(/`(git [^`]*)`/g)) console.log(m[1].replace(/<[^<>]*>/g, 'x'));
  process.exit(0);
}
const perms = JSON.parse(fs.readFileSync(a, 'utf8')).permissions;
const body = (r) => (/^Bash\((.*)\)$/s.exec(r) || [])[1];
const hit = (r, cmd) => {
  const p = body(r);
  if (p === undefined) return false;
  if (p.endsWith(':*')) { const pre = p.slice(0, -2); return cmd === pre || cmd.startsWith(`${pre} `); }
  if (p.includes('*')) return new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's').test(cmd);
  return cmd === p;
};
const ok = b.split(' | ').every((c) => perms.allow.some((r) => hit(r, c.trim())) && !perms.deny.some((r) => hit(r, c.trim())));
process.exit(ok ? 0 : 1);
EOF
TS="$T/state/workers/fix-thing.triage.settings.json"
permits(){ node "$T/match.js" allow "$TS" "$1"; }
# Every git command call n names is permitted (`git <subcommand>` is the generic form, not one).
prompt_git_ok(){ local n="$1" cmd bad=0 seen=0
  while IFS= read -r cmd; do
    [ "$cmd" = "git x" ] && continue
    seen=$((seen+1))
    if ! permits "$cmd"; then echo "     refused: $cmd"; bad=1; fi
  done < <(node "$T/match.js" prompt "$STUB_LOG.$n")
  [ "$seen" -ge 2 ] && [ "$bad" -eq 0 ]; }

cd "$T/repo" || exit 1
out=$(bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "lane A: triage succeeds though claude exits non-zero (|| true)" '[ $rc -eq 0 ]'
check "lane A: one claude call, no challenge"                           '[ -f "$STUB_LOG.0" ] && [ ! -f "$STUB_LOG.1" ]'
check "first pass receives every flag"                                  'flags_ok 0 3'
check "first pass output goes to /dev/null"                             '[ -f "$STUB_LOG.0" ] && [[ "$out" != *STUB-* ]]'
check "first pass: every git command it names runs under triage settings" 'prompt_git_ok 0'
check "first pass: names no git -C or fetch"                            '! node "$T/match.js" prompt "$STUB_LOG.0" | grep -qE "^git (-C|fetch)"'
check "AC1: the record carries the change kind triage judged"            '[ "$(jq -r .change_kind "$T/state/triage/fix-thing.json")" = surface ]'
check "AC1: the prompt asks for one of the four change kinds"           'tr "\0" "\n" < "$STUB_LOG.0" | grep -qF "\"change_kind\": \"relocate|schema|shared|surface\""'
for k in '' 'move'; do
  rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
  out=$(STUB_KIND="$k" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
  check "AC1: a record whose change kind is '$k' is refused as malformed" '[ $rc -ne 0 ] && [[ "$out" == *"triage record is malformed"* ]]'
done
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "triage settings: git ls-tree on any ref"                        'permits "git ls-tree -r --name-only origin/main -- desk" && permits "git ls-tree HEAD"'
check "triage settings: branch listing allowed"                         'permits "git branch -a" && permits "git branch -r" && permits "git branch --list -r"'
check "triage settings: branch -r/-a cannot delete"                     '! permits "git branch -r -d origin/x" && ! permits "git branch -a -D x" && ! permits "git branch -rd origin/x"'
check "triage settings: fetch and -C refused"                           '! permits "git fetch" && ! permits "git fetch origin" && ! permits "git -C /x log"'

rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
export STUB_LANE=C
out=$(bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "lane C: triage succeeds and challenges"                          '[ $rc -eq 0 ] && [ -f "$STUB_LOG.1" ]'
check "challenge receives every flag"                                   'flags_ok 1 2'
check "challenge output goes to /dev/null"                              '[ -f "$STUB_LOG.1" ] && [[ "$out" != *STUB-* ]]'
check "challenge: every git command it names runs under triage settings"  'prompt_git_ok 1'
check "challenge: names no git -C or fetch"                             '! node "$T/match.js" prompt "$STUB_LOG.1" | grep -qE "^git (-C|fetch)"'
check "challenge: a CONFIRM with no failed reads stays CONFIRM"           '[ "$(jq -r .lane_challenge.verdict "$T/state/triage/fix-thing.json")" = CONFIRM ]'

# A challenge whose code reads failed is INCONCLUSIVE, with the reads; a CONFIRM that lists failed
# reads is too, and neither changes the lane.
lc(){ jq -r "$1" "$T/state/triage/fix-thing.json"; }
for chal in '{"verdict":"INCONCLUSIVE","lane":"C","reason":"could not read","failed_reads":["git show main:a.ts: denied"]}' \
            '{"verdict":"CONFIRM","lane":"C","reason":"rests on the first pass","failed_reads":["git show main:a.ts: denied"]}'; do
  rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
  out=$(STUB_CHAL="$chal" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
  check "challenge $(printf '%s' "$chal" | jq -r .verdict) with failed reads: INCONCLUSIVE, reads kept, lane kept" \
    '[ $rc -eq 0 ] && [ "$(lc .lane_challenge.verdict)" = INCONCLUSIVE ] && [ "$(lc ".lane_challenge.failed_reads[0]")" = "git show main:a.ts: denied" ] && [ "$(lc .lane)" = C ] && [ "$(lc .lane_original)" = null ]'
done
check "challenge prompt asks for INCONCLUSIVE and failed_reads" \
  'node -e "const a=require(\"fs\").readFileSync(process.argv[1],\"utf8\").split(\"\\0\"); const p=a[a.indexOf(\"-p\")+1]; process.exit(/INCONCLUSIVE/.test(p) && /failed_reads/.test(p) ? 0 : 1)" "$STUB_LOG.1"'

check "shellcheck: no flag parsed as a command (SC2215) in desk/bin" \
  '! command -v shellcheck >/dev/null || ! shellcheck -S warning -f gcc "$B"/*.sh 2>/dev/null | grep -q SC2215'

echo "triage: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
