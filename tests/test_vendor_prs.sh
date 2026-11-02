#!/usr/bin/env bash
# suite: vendor PRs (a new desk-update vendor PR closes the older ones it supersedes)
# covers: desk/bin/vendor-prs.sh skills/desk-update/**
# vendor-prs.sh against a fake gh and a throwaway checkout with an origin: the PR opens, then only the
# other open chore/vendor-* PRs from this repo are closed naming it; a failed create closes nothing;
# a branch whose vendor/ equals origin/main's opens nothing.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; V="$S/../desk/bin/vendor-prs.sh"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME" "$T/bin"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; echo "     gh: $(cat "$GH_LOG" 2>/dev/null)"; fi; }

# The fake gh logs each call. `pr create` prints PR 401's URL, or fails while $T/create-fails exists;
# `pr list` answers from $T/list.json; `pr close` succeeds.
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr create") [ -f "$GH_DIR/create-fails" ] && { echo "pull request create failed: GraphQL: Head sha can't be blank" >&2; exit 1; }
               echo "https://github.com/acme/desk/pull/401" ;;
  "pr list") cat "$GH_DIR/list.json" ;;
  "pr close") ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" GH_DIR="$T" GH_LOG="$T/gh.log"
cat > "$T/list.json" <<'EOF'
[{"number":401,"headRefName":"chore/vendor-2026-11-02","isCrossRepository":false},
 {"number":273,"headRefName":"chore/vendor-2026-10-29","isCrossRepository":false},
 {"number":400,"headRefName":"fix/DS-1-other","isCrossRepository":false},
 {"number":399,"headRefName":"chore/vendor-mine","isCrossRepository":true}]
EOF

# A checkout whose origin/main has vendor/a, with two branches: one that changes vendor/, one that does not.
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/d" 2>/dev/null
D="$T/d"
mkdir -p "$D/vendor"; echo one > "$D/vendor/a"; echo x > "$D/README"
git -C "$D" add -A; git -C "$D" commit -qm init; git -C "$D" branch -qM main; git -C "$D" push -q origin main
git -C "$D" switch -qc chore/vendor-2026-11-02; echo two > "$D/vendor/a"; git -C "$D" commit -qam up
git -C "$D" switch -qc chore/vendor-2026-11-03 main; echo y > "$D/README"; git -C "$D" commit -qam readme
git -C "$D" switch -q main

# AC3: a branch whose vendor/ equals origin/main's opens nothing.
out=$(bash "$V" same "$D" chore/vendor-2026-11-03); rc=$?
check "AC3 same: vendor/ equal to origin/main's exits 0" '[ $rc -eq 0 ]'
out=$(bash "$V" same "$D" chore/vendor-2026-11-02); rc=$?
check "AC3 same: a changed vendor/ exits 1" '[ $rc -eq 1 ]'
: > "$GH_LOG"
out=$(bash "$V" open "$D" acme/desk chore/vendor-2026-11-03 t b 2>&1); rc=$?
check "AC3 open: nothing to open exits 3, says main is current, calls no gh" '[ $rc -eq 3 ] && [[ "$out" == *"main is already current"* ]] && [ ! -s "$GH_LOG" ]'

# AC2: the new PR fails to open, so nothing is listed or closed.
: > "$GH_LOG"; touch "$T/create-fails"
out=$(bash "$V" open "$D" acme/desk chore/vendor-2026-11-02 t b 2>&1); rc=$?
check "AC2 a failed create exits 1 and closes nothing" '[ $rc -eq 1 ] && [[ "$out" == *"no older vendor PR was closed"* ]] && ! grep -qE "^pr (list|close)" "$GH_LOG"'
rm -f "$T/create-fails"

# AC1, AC4: the new PR opens; only the older vendor PR from this repo is closed, naming it.
: > "$GH_LOG"
out=$(bash "$V" open "$D" acme/desk chore/vendor-2026-11-02 "chore(vendor): upgrade x" body 2>&1); rc=$?
check "AC1 open exits 0 and reports the new PR and the close" '[ $rc -eq 0 ] && [[ "$out" == *"opened https://github.com/acme/desk/pull/401"* ]] && [[ "$out" == *"closed #273: superseded by #401"* ]]'
check "AC1 the PR opens from the branch into main" 'grep -qF "pr create --repo acme/desk --base main --head chore/vendor-2026-11-02 --title chore(vendor): upgrade x --body body" "$GH_LOG"'
check "AC1 the older vendor PR closes with a comment naming the new one and its branch deleted" 'grep -qE "^pr close 273 --repo acme/desk --delete-branch --comment Superseded by #401" "$GH_LOG"'
check "AC4 exactly one PR closed: not the new one, another head, or a fork" '[ "$(grep -c "^pr close" "$GH_LOG")" = 1 ]'

# A branch outside chore/vendor-* is refused before gh runs.
: > "$GH_LOG"
out=$(bash "$V" open "$D" acme/desk main t b 2>&1); rc=$?
check "a non-vendor branch is refused" '[ $rc -eq 2 ] && [ ! -s "$GH_LOG" ]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" = 0 ]
