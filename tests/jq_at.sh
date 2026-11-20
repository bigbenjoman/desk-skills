# shellcheck shell=bash
# Sourced by suites that read one field of a queue file with jq. JQ_AT defines at($p), which walks a
# dot path as JS's o?.[k] does: an array or string takes an index or "length", and a missing step is
# null. at_or($p; $missing) walks the same way but yields $missing where the path leads nowhere, so a
# stored null stays null. Prepend it to a jq program: jq -c --arg p "$path" "$JQ_AT"' at($p)' <file>.
# shellcheck disable=SC2034  # JQ_AT is read by the suite that sources this
JQ_AT='def at_step($k): if type == "object" then (if has($k) then [.[$k]] else [] end)
  elif (type == "array" or type == "string") and $k == "length" then [length]
  elif type == "array" and ($k | test("^(0|[1-9][0-9]*)$")) then ($k | tonumber) as $i | (if $i < length then [.[$i]] else [] end)
  elif type == "string" and ($k | test("^(0|[1-9][0-9]*)$")) then ($k | tonumber) as $i | (.[$i:$i + 1] | if . == "" then [] else [.] end)
  else [] end;
def at_or($p; $missing): reduce (if $p == "" then [""] else $p | split(".") end)[] as $k ([.];
  if length == 0 then . else .[0] | at_step($k) end) | if length == 0 then $missing else .[0] end;
def at($p): at_or($p; null);'
