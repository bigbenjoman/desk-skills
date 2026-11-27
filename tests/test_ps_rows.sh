#!/usr/bin/env bash
# suite: ps reads (a process list over Node's 1 MB default output cap, and ps failing)
# layer: L2
# A stub ps prints over 2 MB of rows ahead of the real list, as a dozen workers' prompts in their
# command lines do, or fails outright. heavyProcesses, suite-wait's processList and upload-images'
# profile check must each read the whole list, and say ps could not be read rather than act on a
# partial or empty one. Every ps call under desk/bin goes through ps-rows.mjs psRows. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"
T="$(cd "$(mktemp -d)" && pwd -P)"
KIDS=""
cleanup(){ for p in $KIDS; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/home" "$T/fakes" "$T/x" "$T/images" "$T/cfg/repos/acme__widgets"
export HOME="$T/home"
export DESK_CONFIG_ROOT="$T/cfg" DESK_REPO_OVERRIDE=acme/widgets DESK_GH_REPO=acme/widgets
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
printf '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n' > "$T/cfg/repos/acme__widgets/config.md"

REALPS="$(command -v ps)"
node -e 'let s = ""; for (let i = 0; i < 2200; i++) s += `${9000000 + i} 1 node ${"x".repeat(1000)}\n`; process.stdout.write(s)' > "$T/pad"
cat > "$T/fakes/ps" <<EOF
#!/bin/sh
[ -f "$T/ps.fail" ] && { echo "ps: cannot read the process table" >&2; exit 1; }
cat "$T/pad"
exec "$REALPS" "\$@"
EOF
chmod +x "$T/fakes/ps"
export PATH="$T/fakes:$PATH"
size=$(ps -axo pid=,args= | wc -c | tr -d ' ')
check "the stub's list is over 2 MB" '[ "$size" -gt 2097152 ]'

# A suite running, and a browser holding the shared profile: real processes, so after the padding.
printf 'setTimeout(() => {}, 60000);\n' > "$T/x/vitest"
node "$T/x/vitest" run & SUITE=$!; KIDS="$KIDS $SUITE"
mod(){ node --input-type=module -e "$1" 2>&1; }

# ---- AC2: heavyProcesses lists a suite past the first MB --------------------------------------
out=$(mod "import { heavyProcesses } from '$B/desk-env.mjs'; console.log(heavyProcesses().map((p) => p.pid).join(' '))")
check "AC2: heavyProcesses lists the running suite" 'grep -qw "$SUITE" <<< "$out"'

# ---- AC3: suite-wait's processList reads the whole list ---------------------------------------
out=$(mod "import { processList } from '$B/suite-wait.mjs'; const l = processList(); console.log(l === null ? 'null' : l.filter((p) => p.pid === $SUITE && p.ppid === $$).length)")
check "AC3: processList holds the suite with its parent" '[ "$out" = 1 ]'

# ---- upload-images: a fake Playwright, so a run reaching the browser says so and stops ---------
printf 'export const chromium = { launchPersistentContext: async () => { console.log("LAUNCHED"); process.exit(0); } };\n' > "$T/x/pw.mjs"
printf '{"user":"me","cookies":[{"name":"user_session","value":"v","domain":"github.com","path":"/"}],"origins":[]}\n' > "$T/profile.github-session.json"
: > "$T/images/after-desktop.png"
# The PR body the uploader reads before it opens the browser: one cell naming that file.
printf '#!/bin/sh\necho "| _drag after-desktop.png_ |"\n' > "$T/fakes/gh"
chmod +x "$T/fakes/gh"
upload(){ (cd "$T" && DESK_UPLOAD_APPROVED=1 DESK_BROWSER_PROFILE="$T/profile" DESK_PLAYWRIGHT="$T/x/pw.mjs" node "$B/upload-images.mjs" 7 "$T/images" 2>&1); }
out=$(upload); rc=$?
check "AC3: upload-images reads the whole list and goes on to the browser" '[ $rc -eq 0 ] && grep -q "^LAUNCHED$" <<< "$out"'
node -e 'setTimeout(() => {}, 60000)' -- "--user-data-dir=$T/profile" & HOLDER=$!; KIDS="$KIDS $HOLDER"
sleep 0.3
out=$(upload); rc=$?
check "AC3: a profile holder past the first MB is seen, and the upload refuses" '[ $rc -eq 2 ] && grep -q "shared profile is in use" <<< "$out" && grep -q "^$HOLDER " <<< "$(grep -v "^\[upload\]" <<< "$out")"'
kill "$HOLDER" 2>/dev/null

# ---- AC4: ps failing is said, never read as an empty list -------------------------------------
touch "$T/ps.fail"
out=$(mod "import { heavyProcesses } from '$B/desk-env.mjs'; try { console.log('LIST', heavyProcesses().length); } catch (e) { console.log(e.message); }")
check "AC4: heavyProcesses throws that ps could not be read" 'grep -q "^ps could not be read (ps: cannot read the process table)$" <<< "$out"'
out=$(mod "import { processList } from '$B/suite-wait.mjs'; console.log(processList())")
check "AC4: processList is null, ps cannot be read" '[ "$out" = null ]'
out=$(mod "import { suiteWait, SUITE_WAIT_TEXT } from '$B/suite-wait.mjs'; const w = suiteWait('$T', { procs: null, cwds: [], holders: new Set() }); console.log(w, '|', SUITE_WAIT_TEXT[w])")
check "AC4: suiteWait with no process list is unknown, saying ps could not be read" '[ "$out" = "unknown | ps could not be read, so whether it is running its suite is unknown" ]'
out=$(upload); rc=$?
check "AC4: upload-images refuses, saying ps could not be read" '[ $rc -eq 2 ] && grep -q "ps could not be read" <<< "$out" && ! grep -q LAUNCHED <<< "$out"'
out=$(node "$B/desk-env.mjs" heavy 2>&1); rc=$?
check "AC4: desk-env heavy exits non-zero, saying so" '[ $rc -ne 0 ] && grep -q "ps could not be read" <<< "$out"'
out=$(node "$B/reboot-check.mjs" 2>&1)
check "AC4: reboot-check says heavy is unknown" 'grep -q "^heavy: unknown, ps could not be read" <<< "$out" && grep -qE "^summary: .* heavy=unknown " <<< "$out"'
rm -f "$T/ps.fail"

# ---- the parser -------------------------------------------------------------------------------
out=$(mod "import { parsePs } from '$B/desk-env.mjs'; console.log(JSON.stringify(parsePs('  12   1 /bin/sleep sleep 30\n\n 13 12 node  a b \n', 'pid=,ppid=,comm=,args=')), JSON.stringify(parsePs(' 2048\n 1024\n', 'rss=')))")
check "parsePs: the last column runs to the end of the line, ids and rss are numbers" '[ "$out" = "[{\"pid\":12,\"ppid\":1,\"comm\":\"/bin/sleep\",\"args\":\"sleep 30\"},{\"pid\":13,\"ppid\":12,\"comm\":\"node\",\"args\":\"a b\"}] [{\"rss\":2048},{\"rss\":1024}]" ]'

# ---- AC5: every ps call under desk/bin goes through psRows ------------------------------------
out=$(grep -rnE "(spawnSync|execFileSync|execSync|spawn|execFile|exec)\([[:space:]]*['\"\`]ps['\"\` ]" "$B")
check "AC5: the only ps call under desk/bin is psRows's" '[ "$(printf "%s\n" "$out" | grep -c .)" = 1 ] && grep -q "/ps-rows.mjs:.*maxBuffer: PS_MAX_BUFFER" <<< "$out"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
