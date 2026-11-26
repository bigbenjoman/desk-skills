#!/usr/bin/env bash
# suite: the desk app's component tests (Vitest, in desk/ui)
# layer: L2
# covers: desk/ui/** desk/ui/vite.config.js desk/ui/public/sw.js desk/ui/src/snapshot.js desk/ui/src/color-scheme.js desk/ui/src/build.test.js desk/ui/src/frame.jsx desk/ui/src/frame.test.jsx desk/ui/src/routes.js desk/ui/src/icons.jsx docs/design/DS-691/project/index.html
# Installs desk/ui's packages from its lockfile when it has none yet or the lockfile changed since,
# then runs its Vitest suite once, on two workers. The first run needs npm and the registry.
set -u
T="$(cd "$(dirname "$0")" && pwd)"
UI="$(cd "$T/../desk/ui" && pwd)"
command -v npm >/dev/null 2>&1 || { echo "FAIL npm is not on PATH, so the desk app's tests cannot run"; exit 1; }
[ -f "$UI/package-lock.json" ] || { echo "FAIL desk/ui has no package-lock.json"; exit 1; }
if [ ! -f "$UI/node_modules/.package-lock.json" ] || [ "$UI/package-lock.json" -nt "$UI/node_modules/.package-lock.json" ]; then
  (cd "$UI" && npm ci --no-audit --no-fund) || { echo "FAIL npm ci in desk/ui"; exit 1; }
fi
# run.sh counts `<n> checks passed`, which Vitest does not print: its summary line becomes one.
# Vitest colours its output on CI (the CI variable) whatever the terminal, so colour is turned off
# and any escape code left is stripped before the summary line is read.
out="$(cd "$UI" && NO_COLOR=1 ./node_modules/.bin/vitest run --maxWorkers=2 2>&1)"; rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || { echo "FAIL vitest exited $rc"; exit "$rc"; }
esc="$(printf '\033')"
n="$(printf '%s\n' "$out" | sed "s/${esc}\[[0-9;]*m//g" | grep -E '^ +Tests +[0-9]+ passed' | grep -oE '[0-9]+' | head -n 1)"
[ -n "$n" ] || { echo "FAIL vitest printed no passing tests"; exit 1; }
echo "$n checks passed"
