#!/usr/bin/env bash
# Installs desk's pinned Playwright, and its Chromium in <dir>/browsers, into <dir>: the layout
# find-playwright.mjs reads. install.sh runs it for ~/.claude/desk/playwright with @playwright/mcp
# beside it; CI's tests workflow runs it with --with-deps (Chromium's system libraries) for the suites
# that render in a browser.
#
#   install-playwright.sh [--with-deps] <dir> <playwright version> [<@playwright/mcp version>]
#
# Exits 2 on bad arguments, 3 when npm install fails and 4 when the Chromium download fails; the
# failing command's output is on stdout and stderr as it ran.
set -u
deps=
if [ "${1:-}" = --with-deps ]; then deps=--with-deps; shift; fi
if [ $# -lt 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: install-playwright.sh [--with-deps] <dir> <playwright version> [<@playwright/mcp version>]" >&2
  exit 2
fi
dir=$1 pw=$2 mcp=${3:-}
mkdir -p "$dir" || exit 2
mcp_dep=
[ -n "$mcp" ] && mcp_dep=", \"@playwright/mcp\": \"$mcp\""
printf '{\n  "private": true,\n  "dependencies": { "playwright": "%s"%s }\n}\n' "$pw" "$mcp_dep" > "$dir/package.json" || exit 2
cd "$dir" || exit 2
dir=$(pwd)
npm install --no-audit --no-fund --no-package-lock || exit 3
# Playwright's install prunes builds no copy in this browsers/ uses any more, unless told to skip that.
env -u PLAYWRIGHT_SKIP_BROWSER_GC PLAYWRIGHT_BROWSERS_PATH="$dir/browsers" \
  node node_modules/playwright/cli.js install ${deps:+"$deps"} chromium || exit 4
