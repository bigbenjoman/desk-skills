#!/usr/bin/env bash
# suite: worker-settings (shell-script toolchain)
# worker-settings.mjs and a shell-script toolchain: `bash|sh <repo-relative .sh path>` is allowed exactly
# and probed with `<shell> --version`; any other shell item (flags, a command string, an absolute or
# parent path, another shell) is still refused. Scratch HOME and repo only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_DEFAULT_BRANCH DESK_SKILLS_DIR
export DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_STATE="$T/state" DESK_QUEUE="$T/queue.json"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
# settings <Unit tests row> -> $out (stdout+stderr), $rc, and $T/ws.json
CFG="$T/config.md"
settings(){
  mkdir -p "$(dirname "$CFG")"
  cat > "$CFG" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Package manager | ${PMROW:-\`none\`} |
| Command prefix | \`none\` |
| Install | ${INSTROW:-\`none\`} |
| Unit tests | $1 |
${2:-}
${3:-}
EOF
  rm -f "$T/ws.json"
  out=$(cd "$T/repo" && DESK_CONFIG="$CFG" node "$B/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" \
    --branch fix/fix-thing --out "$T/ws.json" 2>&1); rc=$?
}
# triage settings from the config settings() last wrote -> $T/ws.json
triage(){
  rm -f "$T/ws.json"
  out=$(cd "$T/repo" && DESK_CONFIG="$CFG" node "$B/worker-settings.mjs" triage --ticket fix-thing --out "$T/ws.json" 2>&1); rc=$?
}
perm3(){ printf '\n## 3. Permissions\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n| `jira-transition` | Transition tickets | `yes` | `%s` |\n' "$1"; }
allows(){ jq -e --arg r "$1" '.permissions.allow | index($r)' "$T/ws.json" >/dev/null 2>&1; }

settings '`bash tests/run.sh`'
check "bash <repo script>: settings written"              '[ $rc -eq 0 ] && [ -f "$T/ws.json" ]'
check "bash <repo script>: exact command allowed"         'allows "Bash(bash tests/run.sh:*)"'
check "bash <repo script>: probed with bash --version"    '[[ "$out" == *"TOOLCHAIN_PROBE: bash --version"* ]] && allows "Bash(bash --version)"'
check "bash <repo script>: no wholesale bash rule"        '! allows "Bash(bash:*)"'
check "desk-env machine write denied, reads allowed"      'allows "Bash(desk-env:*)" && jq -e ".permissions.deny | index(\"Bash(desk-env machine write:*)\")" "$T/ws.json" >/dev/null'
check "desk-env costs write denied"                       'jq -e ".permissions.deny | index(\"Bash(desk-env costs write:*)\") and index(\"Bash(node $B/desk-env.mjs costs write:*)\")" "$T/ws.json" >/dev/null'
check "desk-design save, status and check allowed, not write" 'allows "Bash(node $B/desk-design.mjs save:*)" && allows "Bash(node $B/desk-design.mjs check:*)" && allows "Bash(node $B/desk-design.mjs status:*)" && ! allows "Bash(node $B/desk-design.mjs write:*)" && ! allows "Bash(node $B/desk-design.mjs:*)"'
check "desk-design render allowed under the browser lock only" 'allows "Bash($B/with-lock.sh browser node $B/desk-design.mjs render:*)" && ! allows "Bash(node $B/desk-design.mjs render:*)"'
check "DS-339 AC1 the worker's resume file in the state dir is writable" 'allows "Edit(/$T/state/resume/fix-thing.json)" && ! allows "Edit(/$T/state/resume/**)"'
check "desk-review verdict.mjs allowed by path, not node"  'allows "Bash(node $HOME/.agents/skills/desk-review/bin/verdict.mjs:*)" && allows "Bash(node ~/.agents/skills/desk-review/bin/verdict.mjs:*)" && ! allows "Bash(node:*)"'

settings '`sh scripts/check.sh`'
check "sh <repo script>: allowed and probed"              '[ $rc -eq 0 ] && allows "Bash(sh scripts/check.sh:*)" && [[ "$out" == *"TOOLCHAIN_PROBE: sh --version"* ]]'

check "no Pre-push checks row: no pre-push rule"          '! allows "Bash(bash scripts/desk/pre-push.sh --head)"'
settings '`bash tests/run.sh`' '| Pre-push checks | `bash tests/run.sh` |
| PR-description checks | `node scripts/check-pr-body.mjs` |'
check "pre-push row: desk-pr may run the script on HEAD"  '[ $rc -eq 0 ] && allows "Bash(bash scripts/desk/pre-push.sh --head)"'
check "pre-push rule is exact, not a prefix"              '! allows "Bash(bash scripts/desk/pre-push.sh --head:*)" && ! allows "Bash(bash scripts/desk/pre-push.sh:*)"'
check "PR-description check: allowed with a body file"    'allows "Bash(node scripts/check-pr-body.mjs:*)"'
settings '`bash tests/run.sh`' '| Pre-push checks | `none` |'
check "pre-push none: no pre-push rule"                   '[ $rc -eq 0 ] && ! allows "Bash(bash scripts/desk/pre-push.sh --head)"'

# A Related tests row that is one script is allowed bare and under the test lock; the compound it replaced is not.
settings '`bash tests/run.sh`' '| Related tests | `bash tests/related.sh` |'
check "DS-395 AC1 related.sh row: allowed bare and under the test lock" \
  '[ $rc -eq 0 ] && allows "Bash(bash tests/related.sh:*)" && allows "Bash($B/with-lock.sh test bash tests/related.sh:*)" && allows "Bash($B/with-lock.sh test --cwd . -- bash tests/related.sh:*)"'
check "DS-395 AC1 related.sh row: no CONFIG_WARN"           '[[ "$out" != *CONFIG_WARN* ]]'
settings '`bash tests/run.sh`' "| Related tests | \`bash -c 'bash tests/run.sh \$(node tests/scope_sections.mjs --json)'\` |"
check "DS-395 the compound row warns and is not allowed"   '[ $rc -eq 0 ] && [[ "$out" == *"CONFIG_WARN: §4 Related tests item \"bash -c"*"is a compound or env-prefixed shell command"* ]] && ! jq -e ".permissions.allow[] | select(test(\"scope_sections\"))" "$T/ws.json" >/dev/null'

# git rm and git mv inside the worktree; -C and --work-tree, which would reach outside it, stay denied
denies(){ jq -e --arg r "$1" '.permissions.deny | index($r)' "$T/ws.json" >/dev/null 2>&1; }
settings '`bash tests/run.sh`'
check "git rm and git mv allowed"                         'allows "Bash(git rm:*)" && allows "Bash(git mv:*)"'
check "git --work-tree still denied, -C only for this worktree" 'denies "Bash(git --work-tree*)" && ! denies "Bash(git -C*)" && allows "Bash(git -C $T/repo status:*)"'
check "no Codegen row: no codegen rule, no warning"       '[ $rc -eq 0 ] && ! allows "Bash(pnpm prisma generate:*)" && [[ "$out" != *Codegen* ]]'
ws_none=$(jq -S .permissions "$T/ws.json")
settings '`bash tests/run.sh`' '| Codegen | `none` |'
check "Codegen none: settings unchanged"                  '[ "$(jq -S .permissions "$T/ws.json")" = "$ws_none" ]'

settings '`bash tests/run.sh`' '| Codegen | `pnpm prisma generate` `apps/api: uv run gen-client` |'
check "Codegen: root item allowed exactly"                '[ $rc -eq 0 ] && allows "Bash(pnpm prisma generate:*)" && ! allows "Bash(pnpm:*)"'
check "Codegen: probed with --version"                    '[[ "$out" == *"TOOLCHAIN_PROBE: pnpm --version"* ]]'
check "Codegen: directory item runs nolock"               'allows "Bash($SRC/desk/bin/with-lock.sh nolock --cwd apps/api -- uv run gen-client:*)"'
check "Codegen: no lock taken"                            '! jq -e ".permissions.allow[] | select(test(\"with-lock.sh (test|tsc) .*prisma generate\"))" "$T/ws.json" >/dev/null'
settings '`bash tests/run.sh`' '| Codegen | `rm -rf generated` |'
check "Codegen: rm refused"                               '[ $rc -eq 0 ] && [[ "$out" == *"Codegen item \"rm -rf generated\" starts with rm"* ]] && ! allows "Bash(rm -rf generated:*)"'

# `none` beside another item is a note in backticks: refused with desk-env's message, never run as a command
settings '`bash tests/run.sh`' '| Lint | `none` `./install.sh` |'
check "mixed none row: refused, no settings written"      '[ $rc -ne 0 ] && [[ "$out" == *"FAIL: desk: config §4 \"Lint\" mixes \`none\` with other items"* ]] && [ ! -f "$T/ws.json" ]'

# desk-jira reads, transitions among them, whatever §3 jira-transition says; the transition itself only under yes
JIRA_READS='get search comments whoami fields children transitions where meta md2wiki api lint'
reads_ok(){ local s; for s in $JIRA_READS; do allows "Bash(desk-jira $s:*)" || return 1; done; }
settings '`bash tests/run.sh`' '' "$(perm3 yes)"
check "jira-transition yes: reads allowed"                '[ $rc -eq 0 ] && reads_ok'
check "jira-transition yes: transition allowed"           'allows "Bash(desk-jira transition:*)" && ! denies "Bash(desk-jira transition *)"'
check "desk-jira link never allowed"                      '! allows "Bash(desk-jira link:*)" && denies "Bash(desk-jira link:*)"'
check "desk-jira unlink never allowed"                    '! allows "Bash(desk-jira unlink:*)" && denies "Bash(desk-jira unlink:*)"'
settings '`bash tests/run.sh`' '' "$(perm3 ask)"
check "jira-transition ask: reads allowed"                '[ $rc -eq 0 ] && reads_ok'
check "jira-transition ask: transition denied"            'denies "Bash(desk-jira transition *)" && denies "Bash(desk-jira transition)" && ! allows "Bash(desk-jira transition:*)"'
check "jira-transition ask: CONFIG_DENIED names it"       '[[ "$out" == *jira-transition* ]]'
triage
check "triage: reads allowed"                             '[ $rc -eq 0 ] && reads_ok'
check "triage: transition denied"                         'denies "Bash(desk-jira transition *)" && ! allows "Bash(desk-jira transition:*)"'
settings '`bash tests/run.sh`' '' "$(perm3 yes)"
triage
check "triage: transition denied even under yes"          'denies "Bash(desk-jira transition *)" && allows "Bash(desk-jira transitions:*)"'

for item in 'bash -c tests/run.sh' 'bash' 'bash /abs/run.sh' 'bash ../run.sh' 'bash tests/../../x.sh' 'zsh tests/run.sh' 'bash tests/run.py' 'bash -x tests/run.sh'; do
  settings "\`$item\`"
  check "refused alone: $item" '[ $rc -ne 0 ] && [[ "$out" == *"no toolchain allow rule"* ]] && [ ! -f "$T/ws.json" ]'
  settings "\`$item\` \`bash tests/run.sh\`"
  check "refused beside a valid item: $item" \
    '[ $rc -eq 0 ] && [[ "$out" == *"\"$item\" starts with ${item%% *}, which is never allow-listed"* ]] && ! allows "Bash($item:*)" && ! allows "Bash($item)"'
done

# ---- the spellings workers actually run, matched against the generated rules ----------------------
# verdict <command> -> allow | refused | mixed. A `prefix:*` rule is matched both as a bare string prefix
# and as a word-bounded one, because which the harness applies has not been pinned down: a command
# counts as allowed only if it is allowed either way, and as refused only if it is refused either way.
# readable <path> -> allow | refused, for the Read tool: a Read deny wins; then a Read allow, the
# worktree, or an additional directory.
cat > "$T/match.mjs" <<'NODE'
import { readFileSync } from 'node:fs';
const [file, kind, subject] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, 'utf8')).permissions;
const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const glob = (pat, s) => new RegExp(`^${pat.split('*').map(esc).join('.*')}$`, 's').test(s) || (pat.endsWith(' *') && s === pat.slice(0, -2));
const inner = (r, tool) => (r.startsWith(`${tool}(`) && r.endsWith(')') ? r.slice(tool.length + 1, -1) : null);
if (kind === 'bash') {
  const hit = (r, bounded) => {
    const pat = inner(r, 'Bash'); if (pat == null) return false;
    if (pat.endsWith(':*') && !pat.slice(0, -2).includes('*')) {
      const pre = pat.slice(0, -2);
      return bounded ? subject === pre || subject.startsWith(`${pre} `) : subject.startsWith(pre);
    }
    return pat.includes('*') ? glob(pat, subject) : subject === pat;
  };
  const under = (bounded) => (p.deny.some((r) => hit(r, bounded)) ? 'deny' : p.allow.some((r) => hit(r, bounded)) ? 'allow' : 'none');
  const v = [under(false), under(true)];
  console.log(v.every((x) => x === 'allow') ? 'allow' : v.every((x) => x !== 'allow') ? 'refused' : 'mixed');
} else {
  const path = (r) => { const x = inner(r, 'Read'); return x && x.startsWith('//') ? x.slice(1) : null; };
  const denied = p.deny.map(path).filter(Boolean).some((pat) => glob(pat, subject));
  const granted = p.allow.map(path).filter(Boolean).some((pat) => glob(pat, subject))
    || [process.argv[5], ...p.additionalDirectories].some((d) => subject.startsWith(`${d}/`));
  console.log(!denied && granted ? 'allow' : 'refused');
}
NODE
verdict(){ node "$T/match.mjs" "$T/ws.json" bash "$1"; }
readable(){ node "$T/match.mjs" "$T/ws.json" read "$1" "$T/repo"; }
ok(){ local c; for c in "$@"; do [ "$(verdict "$c")" = allow ] || { out="not allowed: $c ($(verdict "$c"))"; return 1; }; done; }
no(){ local c; for c in "$@"; do [ "$(verdict "$c")" = refused ] || { out="not refused: $c ($(verdict "$c"))"; return 1; }; done; }

git -C "$T/repo" remote add origin https://github.com/acme/widgets.git
git -C "$T/repo" worktree add -q -b other "$T/other"
CREDS="$HOME/.config/desk/repos/acme__widgets"; CFG="$CREDS/config.md"
mkdir -p "$HOME/.claude/agents" "$CREDS"; : > "$HOME/.claude/agents/pr-expert.md"; : > "$CREDS/atlassian-token"
settings '`bash tests/run.sh` `sub: bash tests/sub.sh`' '| Typecheck | `bash tests/tc.sh` |' "$(perm3 ask)"
L="$B/with-lock.sh"; W="$T/repo"
check "spellings fixture: settings written"                           '[ $rc -eq 0 ] && [ -f "$T/ws.json" ]'
check "AC1 root test command: every with-lock spelling allowed" \
  'ok "$L test bash tests/run.sh" "$L test -- bash tests/run.sh" "$L test --cwd . -- bash tests/run.sh" "$L test --cwd . bash tests/run.sh" \
      "$L test bash tests/run.sh tests/test_jira.sh" "$L test --cwd $W -- bash tests/run.sh"'
check "AC1 the lock still has to wrap the configured command" 'no "$L test bash tests/other.sh" "$L test --cwd . -- rm -rf x"'
check "AC2 typecheck under the tsc lock allowed"           'ok "$L tsc bash tests/tc.sh" "$L tsc -- bash tests/tc.sh" "$L tsc --cwd . -- bash tests/tc.sh"'
check "AC3 sub-directory item at its absolute path allowed" 'ok "$L test --cwd $W/sub -- bash tests/sub.sh" "$L test --cwd $W/sub bash tests/sub.sh" "$L test --cwd sub -- bash tests/sub.sh"'
check "AC3 another worktree as --cwd refused"              'no "$L test --cwd $T/other/sub -- bash tests/sub.sh"'
check "AC4 git -C <own worktree> reads allowed"            'ok "git -C $W status" "git -C $W log --oneline origin/main..HEAD" "git -C $W diff --stat" "git -C $W branch --show-current"'
check "AC5 git -C <another worktree> refused"              'no "git -C $T/other status" "git -C $T/other log" "git -C ../other status" "git -C $W/../other status"'
check "AC5 git -C <own worktree> push and config refused"  'no "git -C $W push origin fix/fix-thing" "git -C $W push" "git -C $W config user.name x" "git -C $W stash" "git -C $W grep -O x"'
check "AC6 jira-transition ask: transitions allowed"       'ok "desk-jira transitions DS-1"'
check "AC6 jira-transition ask: transition refused"        'no "desk-jira transition DS-1 Done" "desk-jira transition"'
check "AC7 desk-jira view allowed"                         'ok "desk-jira view DS-1"'
check "AC8 desk-jira --help and help allowed"              'ok "desk-jira --help" "desk-jira help"'
check "AC9 the repo desk config.md is readable"            '[ "$(readable "$CFG")" = allow ]'
check "AC10 the Jira token beside it is not"               '[ "$(readable "$CREDS/atlassian-token")" = refused ] && no "cat $CREDS/atlassian-token" "cat $CREDS/*" "rg . $CREDS" "head ~/.config/desk/repos/acme__widgets/atlassian-t*" "cat \$HOME/.config/desk/repos/acme__widgets/x"'
check "AC11 ~/.claude/agents can be listed and read"       '[ "$(readable "$HOME/.claude/agents/pr-expert.md")" = allow ] && ok "ls $HOME/.claude/agents"'
check "DS-340 AC2 the installed desk templates can be listed and read" \
  '[ "$(readable "$DESK_HOME/templates/.githooks/pre-push")" = allow ] && [ "$(readable "$DESK_HOME/templates/scripts/desk/pre-push.sh")" = allow ] && ok "ls $DESK_HOME/templates/scripts/desk"'
check "AC12 ./node_modules/.bin/<tool> allowed"            'ok "./node_modules/.bin/eslint src" "node_modules/.bin/prettier --check ." "$W/node_modules/.bin/prisma generate"'
check "AC12 suites and typechecks still need the lock"     'no "./node_modules/.bin/vitest run" "node_modules/.bin/tsc --noEmit" "$W/node_modules/.bin/jest" "./node_modules/.bin/playwright test" \
      "./node_modules/.bin/./vitest run" "node_modules/.bin//tsc" "node $W/node_modules/vitest/vitest.mjs run" "node $W/node_modules/.bin/vitest"'
check "AC12 no migrate or seed through node_modules"       'no "./node_modules/.bin/prisma migrate reset --force" "./node_modules/.bin/prisma db push" "node_modules/.bin/drizzle-kit push" \
      "./node_modules/.bin/./prisma migrate reset" "node $W/node_modules/prisma/build/index.js migrate reset --force"'
check "tsx scripts still run from the worktree"            'ok "node $W/node_modules/tsx/dist/cli.mjs scratch.ts" && no "node $W/node_modules/tsx/../vitest/vitest.mjs"'
check "AC12 the same with .. refused"                      'no "./node_modules/.bin/../../x" "./node_modules/.bin/eslint ../x" "$W/node_modules/.bin/../../../bin/sh"'
check "AC13 git check-ignore and range-diff allowed"       'ok "git check-ignore -v .claude/x.json" "git range-diff origin/main...HEAD"'
triage
check "AC10 triage: the token is not readable either"      '[ $rc -eq 0 ] && no "cat $CREDS/atlassian-token" "cat \${HOME}/.config/desk/repos/acme__widgets/x" && [ "$(readable "$CREDS/atlassian-token")" = refused ]'
settings '`bash tests/run.sh`' '' "$(perm3 yes)"
check "AC6 jira-transition yes: both allowed"             'ok "desk-jira transitions DS-1" "desk-jira transition DS-1 Done"'
check "jira-create unset: create and create-batch refused" 'no "desk-jira create Story s b.md" "desk-jira create-batch t.tsv"'
settings '`bash tests/run.sh`' '' "$(perm3 yes)
| \`jira-create\` | New tickets | \`yes\` | \`yes\` |"
check "jira-create yes: create and create-batch allowed"  'ok "desk-jira create Story s b.md" "desk-jira create-batch t.tsv"'
out=$(cd "$T/repo" && DESK_CONFIG="$CFG" node "$B/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" \
  --branch fix/fix-thing --out "$T/ws.json" --dry 2>&1); rc=$?
check "jira-create yes, dry run: create and create-batch refused" '[ $rc -eq 0 ] && no "desk-jira create Story s b.md" "desk-jira create-batch t.tsv"'

# ---- the §3 rows for dependency installs, screenshots and local services, and git reset ----
# rows3 <key>=<value> ... -> a §3 table holding just those rows
rows3(){ local kv; printf '\n## 3. Permissions\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n'
  for kv in "$@"; do printf '| `%s` | x | `ask` | `%s` |\n' "${kv%%=*}" "${kv#*=}"; done; }
SVC='| Local services | `typesense :8108` `mailpit` (the mail catcher) |'
: > "$T/repo/compose.yaml"; UP="docker compose -f $T/repo/compose.yaml up -d --no-recreate --no-deps"
denied_line(){ [[ "$out" == *"CONFIG_DENIED: $1 ($2)"* ]]; }

PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC" "$(rows3 worker-dependency-install=yes worker-screenshots=yes worker-local-services=yes)"
check "rows yes: settings written, none of the three denied" '[ $rc -eq 0 ] && [[ "$out" != *worker-dependency-install* && "$out" != *worker-screenshots* && "$out" != *worker-local-services* ]]'
check "AC1 dependency-install yes: pnpm add and install with arguments" 'ok "pnpm add zod" "pnpm add -D vitest@3" "pnpm install --frozen-lockfile" "pnpm install"'
check "AC1 never global, another directory or a .. path"   'no "pnpm add -g typescript" "pnpm add zod -g" "pnpm add --global x" "pnpm add --dir ../other x" "pnpm add -C ../other x" "pnpm add file:../x" "pnpm -C ../other add x"'
check "AC1 remove and the one-off runners still refused"   'no "pnpm remove zod" "pnpm dlx cowsay" "pnpm exec tsc" "npx cowsay"'
check "AC3 screenshots yes: Playwright from the worktree under the browser lock" \
  'ok "$L browser node $W/node_modules/playwright/cli.js screenshot http://localhost:3551 a.png" "$L browser node ./shot.mjs" "$L browser node $W/shot.mjs" \
      "$L browser ./node_modules/.bin/playwright screenshot http://localhost:3551 a.png" "$L browser $W/node_modules/.bin/playwright test"'
check "AC3 Storybook and Python capture under the browser lock" \
  'ok "$L browser ./node_modules/.bin/storybook build" "$L browser node_modules/.bin/test-storybook --url http://localhost:6006" \
      "$L browser uv run python ./shot.py" "$L browser python3 $W/shot.py" "$L browser .venv/bin/python ./tools/shot.py"'
check "AC3 never outside the worktree or without the lock"  'no "$L browser node ../x.mjs" "$L browser node ./../x.mjs" "$L browser python3 /etc/x.py" "$L browser python3 ./a/../../x.py" \
      "$L browser node $T/other/shot.mjs" "$L browser python3 -c print" "node ./shot.mjs" "python3 ./shot.py" "./node_modules/.bin/playwright test"'
check "AC5 local-services yes: compose up for a §4 entry, in the main checkout's project" 'ok "$UP typesense" "$UP mailpit"'
check "AC5 not the worktree's own project, another service or a recreate" 'no "docker compose up -d typesense" "docker compose up typesense" "$UP postgres" "$UP typesense postgres" \
      "$UP typesense --force-recreate" "docker compose -f compose.yaml up -d --no-recreate --no-deps typesense" "docker compose -f $W/../x.yaml up -d typesense"'
check "AC5 down, rm and run stay refused"                  'no "docker compose down" "docker compose down -v" "docker rm -f typesense" "docker run --rm alpine" "docker compose rm typesense" "docker compose run typesense sh"'
check "AC6 git reset --soft, mixed and on paths allowed"   'ok "git reset --soft HEAD~1" "git reset HEAD -- a.txt" "git reset a.txt" "git reset" "git reset --mixed HEAD~1"'
check "AC6 git reset --hard and --merge refused, abbreviated too" 'no "git reset --hard" "git reset --hard origin/main" "git reset -q --hard HEAD" "git reset --har" "git reset --merge" "git reset --me HEAD" "git -C $W reset --hard"'
triage
check "AC6 triage: git reset refused"                      '[ $rc -eq 0 ] && no "git reset --soft HEAD~1" "git reset a.txt"'

PMROW='`uv`' settings '`bash tests/run.sh`' '' "$(rows3 worker-dependency-install=yes)"
check "AC1 uv: add and sync allowed"                       'ok "uv add httpx" "uv add --dev pytest" "uv sync" "uv sync --frozen"'
check "AC1 uv: not another project"                        'no "uv sync --directory ../other" "uv add --project ../other x" "uv pip install x"'

for v in ask no; do
  PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC" "$(rows3 worker-dependency-install=$v worker-screenshots=$v worker-local-services=$v)"
  check "AC2 dependency-install $v: refused, named"        'no "pnpm add zod" "pnpm install --frozen-lockfile" && denied_line worker-dependency-install $v'
  check "AC2 dependency-install $v: bare install still allowed" 'ok "pnpm install"'
  check "AC4 screenshots $v: capture refused, named"       'no "$L browser node $W/node_modules/playwright/cli.js screenshot" "$L browser node ./shot.mjs" "$L browser ./node_modules/.bin/storybook build" "$L browser uv run python ./shot.py" && denied_line worker-screenshots $v'
  check "AC4 screenshots $v: desk-design render still allowed" 'ok "$L browser node $B/desk-design.mjs render docs/design/x"'
  check "AC5 local-services $v: compose up refused, named" 'no "$UP typesense" "docker compose up -d typesense" && denied_line worker-local-services $v'
done
PMROW='`npm`' INSTROW='`npm install` `web: npm install`' settings '`bash tests/run.sh`'
check "AC2 a §4 Install row takes no package unless the row is yes" 'no "npm install lodash" "npm install --global typescript" "$L nolock --cwd web -- npm install lodash" && ok "npm install" "$L nolock --cwd web -- npm install"'
PMROW='`npm`' INSTROW='`npm install` `web: npm install`' settings '`bash tests/run.sh`' '' "$(rows3 worker-dependency-install=yes)"
check "AC1 a §4 Install row takes a package at yes, never global" 'ok "npm install lodash" "$L nolock --cwd web -- npm install" && no "npm install --global typescript" "npm install -g typescript" \
      "$L nolock --cwd web -- npm install --global typescript" "$L nolock --cwd web -- npm install lodash"'
PMROW='`uv`' settings '`bash tests/run.sh`' '' "$(rows3 worker-dependency-install=no)"
check "AC2 uv: sync refused when the row is not yes"       'no "uv sync" "uv add httpx" && denied_line worker-dependency-install no'

PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC"
check "AC8 none of the three rows: each treated as no"     '[ $rc -eq 0 ] && denied_line worker-dependency-install no && denied_line worker-screenshots no && denied_line worker-local-services no'
check "AC8 none of the three rows: all three refused"      'no "pnpm add zod" "$L browser node ./shot.mjs" "$UP typesense"'
check "AC6 git reset does not depend on any row"           'ok "git reset --soft HEAD~1" && no "git reset --hard"'

# ---- §3 worker-web-read: WebSearch and WebFetch, and nothing else new ----
PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC"
cp "$T/ws.json" "$T/ws-off.json"
check "web-read unset: neither tool allowed, both denied, named" '[ $rc -eq 0 ] && ! allows WebSearch && ! allows WebFetch && denies WebSearch && denies WebFetch && denied_line worker-web-read no'
for v in ask no; do
  PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC" "$(rows3 worker-web-read=$v)"
  check "web-read $v: neither tool allowed, named"         '! allows WebSearch && ! allows WebFetch && denies WebSearch && denied_line worker-web-read $v'
done
PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC" "$(rows3 worker-web-read=yes)"
check "web-read yes: WebSearch and WebFetch allowed, not denied" '[ $rc -eq 0 ] && allows WebSearch && allows WebFetch && ! denies WebSearch && ! denies WebFetch && [[ "$out" != *worker-web-read* ]]'
check "web-read yes: the only allow rules added are the two tools" '[ "$(jq -c "[.permissions.allow[]] - $(jq -c .permissions.allow "$T/ws-off.json")" "$T/ws.json")" = "[\"WebSearch\",\"WebFetch\"]" ]'
triage
check "web-read yes: a triage pass gets neither"           '[ $rc -eq 0 ] && ! allows WebSearch && ! allows WebFetch'
PMROW='`pnpm`' settings '`bash tests/run.sh`' '| Local services | `Typesense on port 8108` |' "$(rows3 worker-local-services=yes)"
check "local services: an item with no service name warns" '[ $rc -eq 0 ] && [[ "$out" == *"does not start with a compose service name"* ]] && no "$UP Typesense"'
: > "$T/repo/compose.override.yaml"
PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC" "$(rows3 worker-local-services=yes)"
check "local services: the main checkout's override file is merged in" 'ok "docker compose -f $T/repo/compose.yaml -f $T/repo/compose.override.yaml up -d --no-recreate --no-deps typesense" && no "$UP typesense"'
mv "$T/repo/compose.override.yaml" "$T/repo/docker-compose.override.yml"
PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC" "$(rows3 worker-local-services=yes)"
check "local services: an override from the other name family is merged in too" 'ok "docker compose -f $T/repo/compose.yaml -f $T/repo/docker-compose.override.yml up -d --no-recreate --no-deps typesense"'
mv "$T/repo/docker-compose.override.yml" "$T/repo/compose.override.yaml"
printf 'COMPOSE_FILE=compose.yaml:compose.dev.yaml\n' > "$T/repo/.env"
PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC" "$(rows3 worker-local-services=yes)"
check "local services: a stack picked by COMPOSE_FILE warns, nothing allowed" '[[ "$out" == *"COMPOSE_FILE"* ]] && ! jq -e ".permissions.allow[] | select(test(\"compose\"))" "$T/ws.json" >/dev/null'
rm -f "$T/repo/compose.yaml" "$T/repo/compose.override.yaml" "$T/repo/.env"
PMROW='`pnpm`' settings '`bash tests/run.sh`' "$SVC" "$(rows3 worker-local-services=yes)"
check "local services: no compose file in the main checkout warns, nothing allowed" '[ $rc -eq 0 ] && [[ "$out" == *"has no compose file"* ]] && no "$UP typesense"'
PMROW='`uv`' INSTROW='`uv sync --frozen`' settings '`bash tests/run.sh`' '' "$(rows3 worker-dependency-install=no)"
check "AC2 a uv Install row still runs with the row refused" 'ok "uv sync --frozen" && no "uv add httpx" "uv sync --frozen x" && denied_line worker-dependency-install no'
PMROW='`composer`' settings '`bash tests/run.sh`' '' "$(rows3 worker-dependency-install=yes)"
check "AC1 composer: require allowed, never another directory" 'ok "composer require monolog/monolog" && no "composer require x -d /abs/other" "composer require x --working-dir=/abs/other"'

# ---- §3 worker-workflow-dispatch and §4 Worker workflows: exact `gh workflow run` on the ticket's branch ----
WF='| Worker workflows | `e2e-manual.yml -f environment=staging -f suite=all` |'
RUN="gh workflow run e2e-manual.yml --ref fix/fix-thing -f environment=staging -f suite=all"
RUN_REPO="gh workflow run e2e-manual.yml --repo acme/widgets --ref fix/fix-thing -f environment=staging -f suite=all"
wf_rules(){ jq -c '[.permissions.allow[] | select(test("^Bash\\(gh workflow"))]' "$T/ws.json"; }
settings '`bash tests/run.sh`' "$WF" "$(rows3 worker-workflow-dispatch=yes)"
check "DS-349 AC1 dispatch yes: exactly the listed run on the ticket's branch, with --repo as a variant" \
  '[ $rc -eq 0 ] && [ "$(wf_rules)" = "[\"Bash($RUN)\",\"Bash($RUN_REPO)\"]" ] && ok "$RUN" "$RUN_REPO" && [[ "$out" != *worker-workflow-dispatch* ]]'
check "DS-349 AC1 dispatch yes: gh workflow is no longer denied" '! denies "Bash(gh workflow:*)"'
check "DS-349 AC2 an extra input is refused"               'no "$RUN -f environment=production" "$RUN_REPO -f environment=production" "$RUN -f suite=smoke"'
check "DS-349 AC2 a changed input is refused"              'no "gh workflow run e2e-manual.yml --ref fix/fix-thing -f environment=production -f suite=all"'
check "DS-349 AC3 a workflow not listed is refused"        'no "gh workflow run production-deploy.yml" "gh workflow run production-deploy.yml --ref fix/fix-thing" "gh workflow run e2e-manual.yml"'
check "DS-349 AC4 another ref is refused"                  'no "gh workflow run e2e-manual.yml --ref main -f environment=staging -f suite=all" "gh workflow run e2e-manual.yml --ref feat/epic -f environment=staging -f suite=all"'
check "DS-349 AC5 enable and disable are refused"          'no "gh workflow enable e2e-manual.yml" "gh workflow disable e2e-manual.yml" && denies "Bash(gh workflow enable:*)" && denies "Bash(gh workflow disable:*)"'
check "DS-349 the other gh denies stay"                    'denies "Bash(gh secret:*)" && denies "Bash(gh variable:*)" && denies "Bash(gh api:*)"'
out=$(cd "$T/repo" && DESK_CONFIG="$CFG" node "$B/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" --branch fix/fix-thing --out "$T/ws.json" --dry 2>&1); rc=$?
check "DS-349 a dry run starts no workflow"                '[ $rc -eq 0 ] && denies "Bash(gh workflow:*)" && no "$RUN" "$RUN_REPO"'
triage
check "DS-349 a triage pass never dispatches"              '[ $rc -eq 0 ] && denies "Bash(gh workflow:*)" && [ "$(wf_rules)" = "[]" ]'
for v in ask no; do
  settings '`bash tests/run.sh`' "$WF" "$(rows3 worker-workflow-dispatch=$v)"
  check "DS-349 AC6 dispatch $v: no rule, gh workflow denied, named" '[ $rc -eq 0 ] && [ "$(wf_rules)" = "[]" ] && denies "Bash(gh workflow:*)" && no "$RUN" && denied_line worker-workflow-dispatch $v'
done
settings '`bash tests/run.sh`' "$WF"
check "DS-349 AC6 dispatch unset: treated as no"           '[ "$(wf_rules)" = "[]" ] && denies "Bash(gh workflow:*)" && denied_line worker-workflow-dispatch no'
settings '`bash tests/run.sh`' '| Worker workflows | `e2e-manual.yml -f environment=staging` `deploy.yml --ref main` `smoke.yml -f url=$(id)` `nightly.yml` |' "$(rows3 worker-workflow-dispatch=yes)"
check "DS-349 AC7 a malformed span warns by name and is skipped" \
  '[ $rc -eq 0 ] && [[ "$out" == *"Worker workflows item \"deploy.yml --ref main\" is not"* ]] && [[ "$out" == *"Worker workflows item \"smoke.yml -f url=\$(id)\" is not"* ]] && ! jq -e ".permissions.allow[] | select(test(\"deploy.yml|smoke.yml\"))" "$T/ws.json" >/dev/null'
check "DS-349 AC7 the valid spans still produce rules"     'ok "gh workflow run e2e-manual.yml --ref fix/fix-thing -f environment=staging" "gh workflow run nightly.yml --ref fix/fix-thing" && [ "$(wf_rules | jq length)" = 4 ]'
settings '`bash tests/run.sh`' '| Worker workflows | `deploy.yml --ref main` |' "$(rows3 worker-workflow-dispatch=yes)"
check "DS-349 no usable span: gh workflow stays denied, and a warning says so" '[ $rc -eq 0 ] && denies "Bash(gh workflow:*)" && [[ "$out" == *"names no usable workflow"* ]]'
# The default branch, or the batch base, as the worker's own branch gets no dispatch at all.
settings '`bash tests/run.sh`' "$WF" "$(rows3 worker-workflow-dispatch=yes)"
out=$(cd "$T/repo" && DESK_CONFIG="$CFG" node "$B/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" --branch main --out "$T/ws.json" 2>&1); rc=$?
check "DS-349 AC4 on the default branch: no rule, gh workflow denied" '[ $rc -eq 0 ] && [ "$(wf_rules)" = "[]" ] && denies "Bash(gh workflow:*)" && [[ "$out" == *"no branch of its own"* ]]'
printf '{"batch":"b","base":"feat/epic","tickets":{}}\n' > "$DESK_QUEUE"
out=$(cd "$T/repo" && DESK_CONFIG="$CFG" node "$B/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" --branch feat/epic --out "$T/ws.json" 2>&1); rc=$?
check "DS-349 AC4 on the batch base: no rule, gh workflow denied" '[ $rc -eq 0 ] && [ "$(wf_rules)" = "[]" ] && denies "Bash(gh workflow:*)"'
rm -f "$DESK_QUEUE"

# ---- DS-390: a force-push the person approved once, and no rebase of a pushed branch without one ----
PUSH3="$(rows3 git-push=yes git-force-with-lease=ask)"
SHA=$(git -C "$T/repo" rev-parse HEAD)
LEASE="git push --force-with-lease=fix/fix-thing:$SHA origin fix/fix-thing"
grant_q(){ printf '{"batch":"b","tickets":{"fix-thing":{"key":"fix-thing","state":"triaged"%s}}}\n' "${1:+,\"grant\":$1}" > "$DESK_QUEUE"; }
GRANT="{\"step\":\"force-push\",\"branch\":\"fix/fix-thing\",\"lease\":\"$SHA\",\"at\":\"2026-11-01T00:00:00Z\"}"
git -C "$T/repo" update-ref refs/remotes/origin/fix/fix-thing "$SHA"
grant_q ''
settings '`bash tests/run.sh`' '' "$PUSH3"
cp "$T/ws.json" "$T/ws-nogrant.json"
check "DS-390 AC4 a pushed branch with lease ask: no rebase onto the base, merge allowed" \
  '[ $rc -eq 0 ] && no "git rebase origin/main" && ok "git merge origin/main" "git rebase --continue" "git rebase --abort"'
check "DS-390 AC5 no grant: the lease push is denied and named, as before" 'no "$LEASE" "git push --force-with-lease origin fix/fix-thing" && denied_line git-force-with-lease ask && [[ "$out" != *CONFIG_GRANT* ]]'
rm -f "$DESK_QUEUE"
settings '`bash tests/run.sh`' '' "$PUSH3"
check "DS-390 AC5 a queue with no grant gives the same settings as no queue at all" '[ "$(jq -S .permissions "$T/ws.json")" = "$(jq -S .permissions "$T/ws-nogrant.json")" ]'
grant_q "$GRANT"
settings '`bash tests/run.sh`' '' "$PUSH3"
check "DS-390 AC1 the grant allows exactly that push, for that branch and lease SHA" '[ $rc -eq 0 ] && ok "$LEASE" && [[ "$out" == *"CONFIG_GRANT: $LEASE"* ]] && ! denied_line git-force-with-lease ask'
check "DS-390 AC1 and nothing wider" 'no "git push --force-with-lease origin fix/fix-thing" "git push --force-with-lease=fix/fix-thing:$(printf b%.0s {1..40}) origin fix/fix-thing" \
  "git push --force-with-lease=main:$SHA origin main" "git push --force origin fix/fix-thing" "git push -f origin fix/fix-thing" "git push origin +fix/fix-thing" "$LEASE --force" "git -C $W ${LEASE#git }"'
check "DS-390 AC1 with the grant the pushed branch may be rebased again" 'ok "git rebase origin/main"'
check "DS-390 AC1 the only allow rules added are the push and the rebase, in each spelling of git" \
  '[ "$(jq -c "[.permissions.allow[]] - $(jq -c .permissions.allow "$T/ws-nogrant.json") | map(select(test(\"git (push --force-with-lease=fix/fix-thing:$SHA origin fix/fix-thing|rebase origin/main)\\\\)$\") | not))" "$T/ws.json")" = "[]" ] && allows "Bash($LEASE)"'
# Spent: origin's branch moved off the lease, so the next settings leave the grant out.
git -C "$T/repo" commit -q --allow-empty -m pushed; git -C "$T/repo" update-ref refs/remotes/origin/fix/fix-thing HEAD
settings '`bash tests/run.sh`' '' "$PUSH3"
check "DS-390 AC2 once origin has moved off the lease, the grant is spent" 'no "$LEASE" && denied_line git-force-with-lease ask && [[ "$out" != *CONFIG_GRANT* ]] && no "git rebase origin/main"'
grant_q "${GRANT/fix\/fix-thing/fix\/other}"
settings '`bash tests/run.sh`' '' "$PUSH3"
check "DS-390 a grant for another branch allows nothing here" '[[ "$out" != *CONFIG_GRANT* ]] && no "git push --force-with-lease=fix/other:$SHA origin fix/other"'
rm -f "$DESK_QUEUE"
settings '`bash tests/run.sh`' '' "$(rows3 git-push=yes git-force-with-lease=yes)"
check "DS-390 AC4 lease yes: a pushed branch still rebases" 'ok "git rebase origin/main" "git push --force-with-lease origin fix/fix-thing"'
git -C "$T/repo" update-ref -d refs/remotes/origin/fix/fix-thing
settings '`bash tests/run.sh`' '' "$PUSH3"
check "DS-390 AC4 a branch not on origin yet rebases, lease ask or not" 'ok "git rebase origin/main"'
# AC2 in git itself: the granted push goes once, and the same command is refused after it.
git init -q --bare "$T/o.git"; git clone -q "$T/o.git" "$T/lw" 2>/dev/null
git -C "$T/lw" checkout -q -b fix/x; git -C "$T/lw" commit -q --allow-empty -m a; git -C "$T/lw" push -q -u origin fix/x 2>/dev/null
L0=$(git -C "$T/lw" rev-parse HEAD); git -C "$T/lw" commit -q --amend --allow-empty -m b
git -C "$T/lw" push -q --force-with-lease="fix/x:$L0" origin fix/x 2>/dev/null; first=$?
git -C "$T/lw" commit -q --amend --allow-empty -m c
git -C "$T/lw" push -q --force-with-lease="fix/x:$L0" origin fix/x 2>/dev/null; second=$?
check "DS-390 AC2 git takes the granted push once and refuses it the second time" '[ $first -eq 0 ] && [ $second -ne 0 ]'

echo "worker-settings: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
