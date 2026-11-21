# shellcheck shell=bash
# Sourced by suites that run the real pass.mjs several times a second apart. A pass judges on a probe
# of its login started under a minute ago rather than making its own (usage-probe.mjs probeShared), so
# age_probes moves each login's probe start stamp back a minute: the next pass stands for one a minute
# or more after the last, as real passes are.
age_probes(){ local f; for f in "${DESK_USAGE_DIR:-$HOME/.desk-autopilot/usage}"/probe*.at; do [ -f "$f" ] && echo "$(( $(cat "$f") - 61000 ))" > "$f"; done; }
