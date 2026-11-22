#!/usr/bin/env bash
# suite: install.sh gh sign-in check (a rate-limited token is not signed out)
# layer: L3
# install.sh --check under a throwaway HOME with a stub gh whose `auth status` prints what gh prints
# signed in, rate-limited, signed out and with a revoked token. A rate limit is a warning and leaves the
# missing count where a signed-in gh leaves it; only a signed-out or revoked gh is counted as missing.
# With two accounts signed in, only the active one's state counts.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
SH="${BASH:-bash}"
export HOME="$T/home"; mkdir -p "$HOME/.claude/desk"
unset DESK_CONFIG_ROOT
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out" | tail -n 40; fi; }

RESET=1700000000
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<EOF
#!/bin/sh
if [ "\$1 \$2" = "api rate_limit" ]; then
  [ "\${GH_RATE:-}" = fail ] && exit 1
  echo $RESET; exit 0
fi
[ "\$1 \$2" = "auth status" ] || exit 1
# Two accounts: gh prints both, and with --active only the active one (the first block).
lim='  X Failed to log in to github.com account someone (keyring)\n  - Active account: true\n  - HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/)\n'
rev='  X Failed to log in to github.com account someone (keyring)\n  - Active account: true\n  - HTTP 401: Bad credentials (https://api.github.com/)\n'
case " \$* " in *" --active "*) active=1 ;; *) active="" ;; esac
two(){ inactive="\$(printf '%s' "\$2" | sed 's/someone/other/; s/Active account: true/Active account: false/')"; printf "github.com\n\$1" >&2; [ -n "\$active" ] || printf "\$inactive" >&2; exit 1; }
# old<mode>: a gh older than --active refuses the flag, then answers as <mode> without it.
case "\$GH_MODE" in old*)
  [ -n "\$active" ] && { printf 'unknown flag: --active\n\nUsage:  gh auth status [flags]\n' >&2; exit 1; }
  GH_MODE="\${GH_MODE#old}" ;; esac
case "\$GH_MODE" in
  twolimited) two "\$lim" "\$rev" ;;
  tworevoked) two "\$rev" "\$lim" ;;
  ok) printf 'github.com\n  ✓ Logged in to github.com account someone (keyring)\n  - Token scopes: '"'"'repo'"'"', '"'"'workflow'"'"'\n'; exit 0 ;;
  limited) printf 'github.com\n  X Failed to log in to github.com account someone (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n  - HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/)\n  - To re-authenticate, run: gh auth login -h github.com\n' >&2; exit 1 ;;
  out) printf 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' >&2; exit 1 ;;
  revoked) printf 'github.com\n  X Failed to log in to github.com account someone (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n  - To re-authenticate, run: gh auth login -h github.com\n' >&2; exit 1 ;;
  bad401) printf 'github.com\n  X Failed to log in to github.com account someone (keyring)\n  - HTTP 401: Bad credentials (https://api.github.com/)\n' >&2; exit 1 ;;
  limited401) printf 'github.com\n  X Failed to log in to github.com account someone (keyring)\n  - HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/)\n  - HTTP 401: Bad credentials (https://api.github.com/)\n' >&2; exit 1 ;;
esac
exit 1
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/bin/claude"; printf '#!/bin/sh\nexit 0\n' > "$T/bin/codex"
chmod +x "$T/bin/gh" "$T/bin/claude" "$T/bin/codex"
export PATH="$T/bin:$PATH"

# run <mode>: the --check report, and its missing count
# shellcheck disable=SC2034  # rc is read inside check's eval strings
run(){ out="$(GH_MODE="$1" "$SH" "$S/../install.sh" --check </dev/null 2>&1)"; rc=$?; missing="$(printf '%s\n' "$out" | sed -n 's/^\([0-9]*\) missing, .*(--check)\.$/\1/p')"; }

run ok
# shellcheck disable=SC2034  # base and at are read inside check's eval strings
base="$missing"
check "signed in: the scopes are read, and the check finishes" '[ $rc -eq 0 ] && [ -n "$base" ] && [[ "$out" == *"ok    gh token has the workflow scope"* ]]'

# shellcheck disable=SC2034
at="$(date -r "$RESET" '+%H:%M' 2>/dev/null || date -d "@$RESET" '+%H:%M')"
run limited
check "AC1 rate-limited: a warning naming the reset time" \
  '[[ "$out" == *"WARN  gh is signed in, but the GitHub API is rate-limited until $at. The install goes on"* ]]'
check "AC1 rate-limited: gh is not counted as missing" '[ "$missing" = "$base" ] && [[ "$out" != *"gh is not signed in"* ]]'
check "AC3 rate-limited: the scopes are unreadable, a warning, never missing" \
  '[[ "$out" == *"WARN  gh token scopes are unreadable while the API is rate-limited"* ]] && [[ "$out" != *"gh token lacks"* ]]'
out="$(GH_MODE=limited GH_RATE=fail "$SH" "$S/../install.sh" --check </dev/null 2>&1)"
check "AC1 with the reset unreadable, the warning says the hourly reset" \
  '[[ "$out" == *"rate-limited until its hourly reset. The install goes on"* ]]'

# limited401: a rate-limit line beside bad credentials is still signed out
for m in out revoked bad401 limited401; do
  run "$m"
  check "AC2 $m: gh is not signed in, and counted as missing" \
    '[ "$missing" = "$((base + 1))" ] && [[ "$out" == *"MISS  gh is not signed in. Run: gh auth login"* ]] && [[ "$out" != *"rate-limited"* ]]'
done

# DS-995: with two accounts, only the active one's state counts
run twolimited
check "DS-995 AC1 active rate-limited, other revoked: a warning naming the reset time, not missing" \
  '[[ "$out" == *"WARN  gh is signed in, but the GitHub API is rate-limited until $at. The install goes on"* ]] && [ "$missing" = "$base" ] && [[ "$out" != *"gh is not signed in"* ]]'
run tworevoked
check "DS-995 AC3 active revoked, other rate-limited: gh is not signed in, and counted as missing" \
  '[ "$missing" = "$((base + 1))" ] && [[ "$out" == *"MISS  gh is not signed in. Run: gh auth login"* ]] && [[ "$out" != *"rate-limited"* ]]'

# A gh older than --active (Ubuntu 24.04's 2.45) refuses the flag: that is no sign-out
run oldok
check "DS-995 a gh without --active, signed in: the scopes are read, not missing" \
  '[ "$missing" = "$base" ] && [[ "$out" == *"ok    gh token has the workflow scope"* ]] && [[ "$out" != *"gh is not signed in"* ]]'
run oldlimited
check "DS-995 a gh without --active, rate-limited: the warning with its reset, not missing" \
  '[[ "$out" == *"rate-limited until $at. The install goes on"* ]] && [ "$missing" = "$base" ]'
run oldrevoked
check "DS-995 a gh without --active, revoked: still not signed in" \
  '[ "$missing" = "$((base + 1))" ] && [[ "$out" == *"MISS  gh is not signed in. Run: gh auth login"* ]]'

echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
