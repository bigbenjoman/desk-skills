# shellcheck shell=bash
# Sourced by suites that read one field of a queue file with jq. JQ_AT defines at($p), which walks a
# dot path as JS's o?.[k] does: an array or string takes an index or "length", and a missing step is
# null. Prepend it to a jq program: jq -c --arg p "$path" "$JQ_AT"' at($p)' <file>.
# shellcheck disable=SC2034  # JQ_AT is read by the suite that sources this
JQ_AT='def at($p): reduce (if $p == "" then [""] else $p | split(".") end)[] as $k (.;
  if type == "object" then .[$k]
  elif (type == "array" or type == "string") and $k == "length" then length
  elif type == "array" and ($k | test("^(0|[1-9][0-9]*)$")) then .[$k | tonumber]
  elif type == "string" and ($k | test("^(0|[1-9][0-9]*)$")) then (.[($k | tonumber):($k | tonumber) + 1] | if . == "" then null else . end)
  else null end);'
