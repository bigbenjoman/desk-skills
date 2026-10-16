#!/usr/bin/env bash
# worker-settings.mjs and a shell-script toolchain: `bash|sh <repo-relative .sh path>` is allowed exactly
# and probed with `<shell> --version`; any other shell item (flags, a command string, an absolute or
# parent path, another shell) is still refused. Scratch HOME and repo only.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_DEFAULT_BRANCH
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
EOF
  rm -f "$T/ws.json"
  out=$(cd "$T/repo" && DESK_CONFIG="$T/config.md" node "$B/worker-settings.mjs" worker --ticket fix-thing --wt "$T/repo" \
    --branch fix/fix-thing --out "$T/ws.json" 2>&1); rc=$?
}
allows(){ jq -e --arg r "$1" '.permissions.allow | index($r)' "$T/ws.json" >/dev/null 2>&1; }

settings '`bash tests/run.sh`'
check "bash <repo script>: settings written"              '[ $rc -eq 0 ] && [ -f "$T/ws.json" ]'
check "bash <repo script>: exact command allowed"         'allows "Bash(bash tests/run.sh:*)"'
check "bash <repo script>: probed with bash --version"    '[[ "$out" == *"TOOLCHAIN_PROBE: bash --version"* ]] && allows "Bash(bash --version)"'
check "bash <repo script>: no wholesale bash rule"        '! allows "Bash(bash:*)"'

settings '`sh scripts/check.sh`'
check "sh <repo script>: allowed and probed"              '[ $rc -eq 0 ] && allows "Bash(sh scripts/check.sh:*)" && [[ "$out" == *"TOOLCHAIN_PROBE: sh --version"* ]]'

for item in 'bash -c tests/run.sh' 'bash' 'bash /abs/run.sh' 'bash ../run.sh' 'bash tests/../../x.sh' 'zsh tests/run.sh' 'bash tests/run.py' 'bash -x tests/run.sh'; do
  settings "\`$item\`"
  check "refused alone: $item" '[ $rc -ne 0 ] && [[ "$out" == *"no toolchain allow rule"* ]] && [ ! -f "$T/ws.json" ]'
  settings "\`$item\` \`bash tests/run.sh\`"
  check "refused beside a valid item: $item" \
    '[ $rc -eq 0 ] && [[ "$out" == *"\"$item\" starts with ${item%% *}, which is never allow-listed"* ]] && ! allows "Bash($item:*)" && ! allows "Bash($item)"'
done

echo "worker-settings: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
