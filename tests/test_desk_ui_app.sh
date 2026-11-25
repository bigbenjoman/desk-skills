#!/usr/bin/env bash
# suite: the desk app's component tests (Vitest, in desk/ui)
# covers: desk/ui/** desk/ui/vite.config.js desk/ui/public/sw.js desk/ui/src/snapshot.js desk/ui/src/color-scheme.js
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
cd "$UI" && ./node_modules/.bin/vitest run --maxWorkers=2
