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
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_DEFAULT_BRANCH DESK_SKILLS_DIR
export DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_STATE="$T/state" DESK_QUEUE="$T/queue.json"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
# settings <Unit tests row> -> $out (stdout+stderr), $rc, and $T/ws.json
settings(){
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

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Unit tests | $1 |
${2:-}
${3:-}
EOF
  rm -f "$T/ws.json"
  out=$(cd "$T/repo" && DESK_CONFIG="$T/config.md" node "$B/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" \
    --branch fix/fix-thing --out "$T/ws.json" 2>&1); rc=$?
}
# triage settings from the config settings() last wrote -> $T/ws.json
triage(){
  rm -f "$T/ws.json"
  out=$(cd "$T/repo" && DESK_CONFIG="$T/config.md" node "$B/worker-settings.mjs" triage --ticket fix-thing --out "$T/ws.json" 2>&1); rc=$?
}
perm3(){ printf '\n## 3. Permissions\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n| `jira-transition` | Transition tickets | `yes` | `%s` |\n' "$1"; }
allows(){ jq -e --arg r "$1" '.permissions.allow | index($r)' "$T/ws.json" >/dev/null 2>&1; }

settings '`bash tests/run.sh`'
check "bash <repo script>: settings written"              '[ $rc -eq 0 ] && [ -f "$T/ws.json" ]'
check "bash <repo script>: exact command allowed"         'allows "Bash(bash tests/run.sh:*)"'
check "bash <repo script>: probed with bash --version"    '[[ "$out" == *"TOOLCHAIN_PROBE: bash --version"* ]] && allows "Bash(bash --version)"'
check "bash <repo script>: no wholesale bash rule"        '! allows "Bash(bash:*)"'
check "desk-env machine write denied, reads allowed"      'allows "Bash(desk-env:*)" && jq -e ".permissions.deny | index(\"Bash(desk-env machine write:*)\")" "$T/ws.json" >/dev/null'
check "desk-design save, status and check allowed, not write" 'allows "Bash(node $B/desk-design.mjs save:*)" && allows "Bash(node $B/desk-design.mjs check:*)" && allows "Bash(node $B/desk-design.mjs status:*)" && ! allows "Bash(node $B/desk-design.mjs write:*)" && ! allows "Bash(node $B/desk-design.mjs:*)"'
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

# git rm and git mv inside the worktree; -C and --work-tree, which would reach outside it, stay denied
denies(){ jq -e --arg r "$1" '.permissions.deny | index($r)' "$T/ws.json" >/dev/null 2>&1; }
settings '`bash tests/run.sh`'
check "git rm and git mv allowed"                         'allows "Bash(git rm:*)" && allows "Bash(git mv:*)"'
check "git -C and --work-tree still denied"               'denies "Bash(git -C*)" && denies "Bash(git --work-tree*)"'
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
check "jira-transition yes: transition allowed"           'allows "Bash(desk-jira transition:*)" && ! denies "Bash(desk-jira transition:*)"'
check "desk-jira link never allowed"                      '! allows "Bash(desk-jira link:*)" && denies "Bash(desk-jira link:*)"'
check "desk-jira unlink never allowed"                    '! allows "Bash(desk-jira unlink:*)" && denies "Bash(desk-jira unlink:*)"'
settings '`bash tests/run.sh`' '' "$(perm3 ask)"
check "jira-transition ask: reads allowed"                '[ $rc -eq 0 ] && reads_ok'
check "jira-transition ask: transition denied"            'denies "Bash(desk-jira transition:*)" && ! allows "Bash(desk-jira transition:*)"'
check "jira-transition ask: CONFIG_DENIED names it"       '[[ "$out" == *jira-transition* ]]'
triage
check "triage: reads allowed"                             '[ $rc -eq 0 ] && reads_ok'
check "triage: transition denied"                         'denies "Bash(desk-jira transition:*)" && ! allows "Bash(desk-jira transition:*)"'
settings '`bash tests/run.sh`' '' "$(perm3 yes)"
triage
check "triage: transition denied even under yes"          'denies "Bash(desk-jira transition:*)" && allows "Bash(desk-jira transitions:*)"'

for item in 'bash -c tests/run.sh' 'bash' 'bash /abs/run.sh' 'bash ../run.sh' 'bash tests/../../x.sh' 'zsh tests/run.sh' 'bash tests/run.py' 'bash -x tests/run.sh'; do
  settings "\`$item\`"
  check "refused alone: $item" '[ $rc -ne 0 ] && [[ "$out" == *"no toolchain allow rule"* ]] && [ ! -f "$T/ws.json" ]'
  settings "\`$item\` \`bash tests/run.sh\`"
  check "refused beside a valid item: $item" \
    '[ $rc -eq 0 ] && [[ "$out" == *"\"$item\" starts with ${item%% *}, which is never allow-listed"* ]] && ! allows "Bash($item:*)" && ! allows "Bash($item)"'
done

echo "worker-settings: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
