#!/usr/bin/env bash
# One CI shard of tests/plan_shards.mjs's matrix, shared by every job that runs one (tests.yml's Linux
# shards, nightly-macos.yml's macOS shards). The job puts its matrix row in the environment:
# SHARD, OF, SUITES (suite names, space-separated) and HOOK (true on the one shard that runs the
# attribution hook self-test). The argument is how many suites run at once: one fewer than the
# runner's vCPUs.
#   SHARD=1 OF=4 SUITES='test_a.sh test_b.mjs' HOOK=false bash tests/ci_shard.sh 3
set -u
jobs=${1:?usage: ci_shard.sh <suites at once>}
cd "$(dirname "$0")/.." || exit 2
echo "shard $SHARD/$OF: $SUITES"
# run.sh with no suite named runs every suite, which a shard must never do.
[ -n "${SUITES// /}" ] || { echo "shard $SHARD/$OF has no suites to run"; exit 2; }
flags="-j $jobs --no-hook-test"
[ "$HOOK" = true ] && flags="-j $jobs"
# shellcheck disable=SC2086  # flags and suite names, one per word
exec bash tests/run.sh $flags $SUITES
