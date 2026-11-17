#!/usr/bin/env bash
# suite: compare_pass (a fixture comparison lists what a head's pass.mjs does differently from its base's)
# tests/compare_pass.sh over scratch trees whose stand-in pass.mjs writes one queue field and prints one
# line: a head that matches lists nothing; one that writes a field or prints a line differently lists
# it; one whose pass crashes is not compared; one that moved a shell case into a unit suite still runs
# the base's case. Then the real pass suite against itself lists nothing. Scratch dirs only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
cmp(){ out=$(bash "$S/compare_pass.sh" "$@" 2>/dev/null); rc=$?; }

# A tree whose pass.mjs sets A-1's state to $2 and prints "A-1 is $3", with the time, its own path and
# a fresh id in both, as a real pass's output and queue carry them, and a deadline $4 hours on (1 by
# default), as a pass works one out from now.
mktree(){ mkdir -p "$T/$1/desk/bin" "$T/$1/tests"
  cat > "$T/$1/desk/bin/pass.mjs" <<EOF
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const f = process.env.DESK_QUEUE, q = JSON.parse(readFileSync(f, 'utf8'));
q.tickets['A-1'] = { ...q.tickets['A-1'], state: '$2', at: new Date().toISOString(), id: randomUUID(), by: import.meta.url,
  due: new Date(Date.now() + ${4:-1} * 3600e3).toISOString() };
writeFileSync(f, JSON.stringify(q));
console.log('A-1 is $3 at ' + new Date().toISOString() + ' from ' + import.meta.url);
EOF
  cat > "$T/$1/tests/test_pass.sh" <<'EOF'
#!/usr/bin/env bash
SRC="$(cd "$(dirname "$0")/.." && pwd)"; B="$SRC/desk/bin"; D="$(mktemp -d)"
export DESK_QUEUE="$D/queue.json"
echo '{"tickets":{"A-1":{"state":"triaged","added_at":"2026-01-02T03:04:05Z"}}}' > "$DESK_QUEUE"
out=$(node "$B/pass.mjs" 2>&1)
if grep -q '"state":"running"' "$DESK_QUEUE"; then echo "ok   the first pass"; else echo "FAIL the first pass"; fi
node -e 'process.exit(0)'; echo "ok   a node run that is no pass"
out=$(node "$B/pass.mjs" 2>&1); echo "ok   the second pass"
rm -rf "$D"
EOF
}
mktree base running running
mktree same running running
mktree field parked running
mktree line running working
mktree crash running running
# The crash tree's pass imports a phase module it does not have, so it never runs.
{ echo 'import "./missing-phase.mjs";'; cat "$T/base/desk/bin/pass.mjs"; } > "$T/crash/desk/bin/pass.mjs"

cmp "$T/base" "$T/same"
check "DS-763 AC1 a head that matches its base lists nothing" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'
check "DS-763 AC4 times, ids and paths that differ between the trees are not reported" '[ $rc = 0 ] && ! echo "$out" | grep -q "<TIME>\|<TREE>\|<UUID>"'

cmp "$T/base" "$T/field"
check "DS-763 AC2 a queue field written differently lists the ticket, the field and both values" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue A-1 state: base \"running\", head \"parked\""'
check "DS-763 AC2 the difference names the run and the check after it" 'echo "$out" | grep -qxF "test_pass.sh run 1 (before: the first pass):" && echo "$out" | grep -qxF "test_pass.sh run 2 (before: the second pass):"'
check "DS-763 AC2 only that field differs" '[ "$(echo "$out" | grep -c "^  ")" = 2 ]'
check "DS-763 a check of the base's that fails on the head only is listed" 'echo "$out" | grep -qxF "test_pass.sh: a check fails on the head only: the first pass"'

cmp "$T/base" "$T/line"
check "DS-763 AC3 a report line printed differently lists both lines" '[ $rc = 1 ] && echo "$out" | grep -qxF "  output base: A-1 is running at <TIME> from file://<TREE>/desk/bin/pass.mjs" && echo "$out" | grep -qxF "  output head: A-1 is working at <TIME> from file://<TREE>/desk/bin/pass.mjs" && ! echo "$out" | grep -q "queue"'

mktree due running running 2
cmp "$T/base" "$T/due"
check "DS-763 AC2 a deadline worked out from now differently lists both times" '[ $rc = 1 ] && echo "$out" | grep -qE "^  queue A-1 due: base \"20[0-9-]+T[0-9:.]+Z\", head \"20[0-9-]+T[0-9:.]+Z\"$" && [ "$(echo "$out" | grep -c "^  ")" = 2 ]'

cmp "$T/base" "$T/crash"
check "DS-763 AC5 a pass that fails to run on one tree is reported not compared, and the run exits non-zero" '[ $rc = 2 ] && echo "$out" | grep -qF "test_pass.sh run 1 (before: the first pass): not compared: the pass failed to run on the head: Error [ERR_MODULE_NOT_FOUND]" && echo "$out" | grep -qE "^compare_pass: 0 pass run\(s\) compared, [0-9]+ differ, 2 not compared$"'
cmp "$T/crash" "$T/base"
check "DS-763 AC5 a crash on the base is not compared either" '[ $rc = 2 ] && echo "$out" | grep -qF "not compared: the pass failed to run on the base"'

# The head moved its second case into a unit suite: the base's two cases still run against it.
mktree moved running running
printf '#!/usr/bin/env bash\nSRC="$(cd "$(dirname "$0")/.." && pwd)"; B="$SRC/desk/bin"\nnode -e 1; echo "ok   the first pass, all that is left"\n' > "$T/moved/tests/test_pass.sh"
printf '%s\n' '// suite: the second pass, now a unit test' 'console.log("ok   the second pass");' > "$T/moved/tests/test_pass_unit.mjs"
cmp "$T/base" "$T/moved"
check "DS-763 AC6 a head that moved a case into a unit suite runs the base's cases and lists nothing" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'

# A base and head given as commits of a repo, as a later child compares its branch with main.
git init -q -b main "$T/repo"; cp -R "$T/base/." "$T/repo/"
git -C "$T/repo" add -A; git -C "$T/repo" -c user.name=t -c user.email=t@example.com commit -qm base
cp "$T/field/desk/bin/pass.mjs" "$T/repo/desk/bin/pass.mjs"
git -C "$T/repo" -c user.name=t -c user.email=t@example.com commit -qam head
mkdir -p "$T/repo/tests"; cp "$S/compare_pass.sh" "$S/compare_pass.mjs" "$S/suite_env.sh" "$T/repo/tests/"; cp "$SRC/desk/bin/dir-lock.mjs" "$T/repo/desk/bin/"
out=$(bash "$T/repo/tests/compare_pass.sh" HEAD~1 HEAD 2>/dev/null); rc=$?
check "DS-763 base and head given as commits compare those commits" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue A-1 state: base \"running\", head \"parked\""'
cmp --suite test_nope.sh "$T/base" "$T/same"
check "DS-763 a suite the base lacks is refused" '[ $rc = 2 ]'

# A pass stopped by a signal: the recorder in its place ends with the same status, and records it.
echo "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);" > "$T/stopped.mjs"
PASS_CMP_NODE="$(command -v node)" PASS_CMP_OUT="$T/stopped" node "$S/compare_pass.mjs" record "$T/stopped.mjs"; rc=$?
check "DS-763 a pass stopped by a signal ends the recorder with its status" '[ $rc = 143 ] && [ "$(jq -r .signal "$T/stopped/1.json")" = SIGTERM ]'

# The real pass suites against themselves: whatever differs between two runs of one tree is noise.
out=$(bash "$S/compare_pass.sh" "$SRC" "$SRC" 2>/dev/null); rc=$?
check "DS-763 AC4 the whole pass shell suite against the same tree lists nothing" '[ $rc = 0 ] && echo "$out" | grep -qE "^compare_pass: [0-9]{3,} pass run\(s\) compared, 0 differ, 0 not compared$"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" = 0 ]
