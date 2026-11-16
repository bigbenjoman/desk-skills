#!/usr/bin/env bash
# suite: install.sh release folders and rollback
# install.sh's install_release, taken from install.sh with the helpers it calls, run over a throwaway
# HOME from a scratch checkout holding this checkout's desk/bin and desk/templates, committed three
# times over: each install is a release folder made current in one step, the newest three are kept, a
# copy that fails part way leaves the current release current, a script running from one release keeps
# loading that release's files while the next goes live, and the rollback goes back one release.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; R="$S/.."
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
SH="${BASH:-bash}"
export HOME="$T/home"; D="$HOME/.claude/desk"
unset DESK_HOME DESK_CONFIG DESK_REPO_DIR DESK_STATE DESK_QUEUE
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out" | tail -n 20; fi; }
G(){ git -C "$T/src" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

# The checkout installed from: desk's real scripts and templates, plus a probe a "pass" runs.
mkdir -p "$T/src/desk" "$T/fakes"
cp -R "$R/desk/bin" "$R/desk/templates" "$T/src/desk/"
cat > "$T/src/desk/bin/probe.mjs" <<'EOF'
import { existsSync, writeFileSync } from 'node:fs';
import { runBin } from './desk-env.mjs';
const [go, ready] = process.argv.slice(2);
if (ready) writeFileSync(ready, '');
while (go && !existsSync(go)) await new Promise((r) => setTimeout(r, 50));
const m = await import('./marker.mjs');
console.log(`${runBin()} ${m.default}`);
EOF
mark(){ printf 'export default "%s";\n' "$1" > "$T/src/desk/bin/marker.mjs"; G add -A; G commit -qm "$1"; G rev-parse HEAD; }
git init -q "$T/src"

# The installer's functions, with its output helpers, as a script that installs or rolls back.
fns="$(for f in save_edit prune_removed rename_over release_files same_release release_name carry_own go_live install_release; do
  sed -n "/^$f() {\$/,/^}\$/p" "$R/install.sh"; done)"
check "install_release and its helpers are found in install.sh" '[ "$(printf "%s\n" "$fns" | grep -c "^[a-z_]*() {$")" = 9 ]'
tr="$(grep '^trap .*STAGE' "$R/install.sh")"
check "the partial-release trap is found in install.sh" '[ -n "$tr" ]'
cat > "$T/install" <<EOF
set -euo pipefail
SRC="$T/src"; DESKDIR="$D"; RELEASES="$D/releases"; PRISTINE="$HOME/.agents/.desk-pristine"
TS="\${TS:-20261116-000000}"; BACKUP="$HOME/.agents/desk-backup/\$TS"; STAGE=""
ok(){ echo "ok \$1"; }; note(){ echo "note \$1"; }; warn(){ echo "WARN \$1"; }; wrote(){ :; }; show_err(){ echo "\$1"; }
$fns
$tr
install_release
EOF

# State that lives beside desk's scripts and must never move.
mkdir -p "$D/repos/acme__widgets" "$D/workers/w1" "$D/handoffs"
echo '{"tickets":[]}' > "$D/repos/acme__widgets/queue.json"; echo w > "$D/workers/w1/log"; echo h > "$D/handoffs/h.md"
state(){ (cd "$D" && find repos workers handoffs -type f -exec cksum {} + | LC_ALL=C sort); }
before="$(state)"

# ---- the first install over a desk from before releases --------------------------------------
mkdir -p "$D/bin" "$D/templates"; echo legacy > "$D/bin/queue.mjs"; echo mine > "$D/bin/my-own.sh"
printf '{"commit": "0ld", "dirty": false, "at": "2026-01-01T00:00:00.000Z"}\n' > "$D/installed.json"
A="$(mark A)"
out="$(TS=20261116-000001 "$SH" "$T/install" 2>&1)"; rc=$?
check "AC1: the install exits 0" '[ $rc = 0 ]'
check "AC1: the scripts and templates sit in a release folder for the commit" \
  '[ -f "$D/releases/$A/bin/installed.mjs" ] && [ -z "$(cd "$R/desk/templates" && find . -type f ! -name "*.bak*" | while read -r f; do cmp -s "$f" "$D/releases/$A/templates/$f" || echo "$f"; done)" ]'
check "AC1: current points at it, and bin and templates link through current" \
  '[ "$(readlink "$D/current")" = "releases/$A" ] && [ "$(readlink "$D/bin")" = current/bin ] && [ "$(readlink "$D/templates")" = current/templates ]'
check "AC5: installed.json records the commit, and the release carries its own record" \
  '[ "$(jq -r .commit "$D/installed.json")" = "$A" ] && [ "$(jq -r .release "$D/releases/$A/release.json")" = "$A" ]'
check "the install from before releases is kept as a release, with its record" \
  '[ "$(cat "$D"/releases/before-releases-*/bin/queue.mjs)" = legacy ] && [ "$(jq -r .commit "$D"/releases/before-releases-*/release.json)" = 0ld ]'
check "a file desk never installed is carried into the new release" '[ "$(cat "$D/bin/my-own.sh")" = mine ]'

# ---- AC2, AC3: a script started on one release, while the next goes live ---------------------
B="$(mark B)"
node "$D/bin/probe.mjs" "$T/go" "$T/ready" > "$T/probe.out" 2>&1 &
probe=$!
for _ in $(seq 1 200); do [ -e "$T/ready" ] && break; sleep 0.05; done
out="$(TS=20261116-000002 "$SH" "$T/install" 2>&1)"; rc=$?
touch "$T/go"; wait $probe
check "AC2: a script started before the install loads only its own release's files" \
  '[ "$(cat "$T/probe.out")" = "$(cd "$D/releases/$A/bin" && pwd -P) A" ]'
check "AC2: one started after it loads the new release's" \
  '[ "$(node "$D/bin/probe.mjs")" = "$(cd "$D/releases/$B/bin" && pwd -P) B" ]'
check "AC3: the paths shims, settings and agents use reach the new release" \
  '[ "$(cd -P "$D/bin" && pwd)" = "$(cd -P "$D/releases/$B/bin" && pwd)" ] && [ "$(cd -P "$D/templates" && pwd)" = "$(cd -P "$D/releases/$B/templates" && pwd)" ]'

# ---- AC9: an edit to the current release is saved first ---------------------------------------
echo "// my edit" >> "$D/bin/queue.mjs"
C="$(mark C)"
out="$(TS=20261116-000003 "$SH" "$T/install" 2>&1)"; rc=$?
check "AC9: the edited script is saved to the backup folder, and named" \
  'tail -n 1 "$HOME/.agents/desk-backup/20261116-000003/.claude/desk/bin/queue.mjs" | grep -qx "// my edit" && [[ "$out" == *"your edited ~/.claude/desk/bin/queue.mjs was saved to"* ]]'
check "AC9: the new release has desk's copy" 'cmp -s "$D/bin/queue.mjs" "$R/desk/bin/queue.mjs"'

# ---- AC4: a fourth install keeps the newest three ---------------------------------------------
check "AC4: the third release past the one from before releases deletes that one" \
  '[ "$(ls "$D/releases" | LC_ALL=C sort | tr "\n" " ")" = "$(printf "%s\n" "$A" "$B" "$C" | LC_ALL=C sort | tr "\n" " ")" ]'
E4="$(mark D)"
out="$(TS=20261116-000004 "$SH" "$T/install" 2>&1)"; rc=$?
check "AC4: the oldest are deleted and the newest three, the current one included, remain" \
  '[ "$(ls "$D/releases" | LC_ALL=C sort | tr "\n" " ")" = "$(printf "%s\n" "$B" "$C" "$E4" | LC_ALL=C sort | tr "\n" " ")" ] && [ "$(readlink "$D/current")" = "releases/$E4" ]'
check "AC4: the install names each release it deleted" '[[ "$out" == *"removed release $A"* ]]'
check "a clean commit's release is named by the commit alone" '[ -d "$D/releases/$E4" ]'
out="$(TS=20261116-000005 "$SH" "$T/install" 2>&1)"; rc=$?
check "the same clean commit again reuses its release rather than adding one" \
  '[ $rc = 0 ] && [ "$(ls "$D/releases" | wc -l | tr -d " ")" = 3 ] && [[ "$out" == *"release $E4 already holds these files"* ]]'
echo "// dirty" >> "$T/src/desk/bin/marker.mjs"
out="$(TS=20261116-000006 "$SH" "$T/install" 2>&1)"; rc=$?
check "a dirty checkout's release is named by the commit and the install's time" \
  '[ "$(readlink "$D/current")" = "releases/$E4-20261116-000006" ] && [ "$(jq -r .dirty "$D/installed.json")" = true ]'
G checkout -q -- desk/bin/marker.mjs

# ---- AC7: a copy that fails part way -----------------------------------------------------------
cur="$(readlink "$D/current")"; ls_before="$(ls -a "$D/releases")"
F="$(mark F)"
printf '#!/bin/sh\ncase "$1" in *"/desk/bin/marker.mjs") echo "cp: no space left on device" >&2; exit 1 ;; esac\nexec /bin/cp "$@"\n' > "$T/fakes/cp"; chmod +x "$T/fakes/cp"
out="$(PATH="$T/fakes:$PATH" TS=20261116-000007 "$SH" "$T/install" 2>&1)"; rc=$?
check "AC7: the install fails" '[ $rc != 0 ]'
check "AC7: the release that was current stays current" '[ "$(readlink "$D/current")" = "$cur" ]'
check "AC7: the partial folder is removed, and the install says so" \
  '[ "$(ls -a "$D/releases")" = "$ls_before" ] && [[ "$out" == *"the new release was not completed and is removed; the current release is unchanged"* ]]'

# ---- AC5, AC6: rollback --------------------------------------------------------------------------
rb(){ DESK_HOME="$D" node "$D/bin/installed.mjs" rollback 2>&1; }
out="$(rb)"; rc=$?
check "AC5: the rollback makes the release before the current one current" \
  '[ $rc = 0 ] && [ "$(readlink "$D/current")" = "releases/$E4" ] && [[ "$out" == "rolled back from release $E4-20261116-000006 to $E4 (commit $E4)" ]]'
check "AC5: installed.json records its commit" '[ "$(jq -r .commit "$D/installed.json")" = "$E4" ] && [ "$(jq -r .release "$D/installed.json")" = "$E4" ]'
out="$(rb)"; rc=$?
check "AC5: a second rollback goes back one more" '[ $rc = 0 ] && [ "$(readlink "$D/current")" = "releases/$C" ] && [ "$(jq -r .commit "$D/installed.json")" = "$C" ]'
check "AC8: no queue, worker or handoff file moved or changed through the installs and rollbacks" '[ "$(state)" = "$before" ]'

# A desk with only one release.
rm -rf "$D/releases" "$D/current" "$D/bin" "$D/templates"
out="$(TS=20261116-000008 "$SH" "$T/install" 2>&1)"
inst="$(cat "$D/installed.json")"
out="$(rb)"; rc=$?
check "AC6: with one release, the rollback says there is no earlier release" '[ $rc = 1 ] && [[ "$out" == "nothing rolled back: there is no earlier release than the current one ($F)"* ]]'
check "AC6: and changes nothing" '[ "$(readlink "$D/current")" = "releases/$F" ] && [ "$(cat "$D/installed.json")" = "$inst" ]'
check "AC8: still untouched" '[ "$(state)" = "$before" ]'

# install.sh --rollback runs the same, and moves what runs onto it.
out="$(grep -A6 '^if \[ "\$ROLLBACK" = 1 \]' "$R/install.sh")"
check "install.sh --rollback runs installed.mjs rollback, then restart" \
  '[[ "$out" == *"installed.mjs\" rollback || exit 1"*"installed.mjs\" restart"* ]]'

echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
