#!/bin/bash
# SessionStart hook: at most once a day, say when the desk-skills checkout has new commits upstream.
# Notifies only; /desk-update shows what changed and installs it. Silent on any failure, and never
# blocks a session start for more than ~5 seconds (the fetch is killed after that).
STAMP="$HOME/.claude/desk/update-check.last"
D="$(cat "$HOME/.claude/desk/source-checkout" 2>/dev/null)"
[ -n "$D" ] && [ -d "$D/.git" ] || exit 0
if [ -f "$STAMP" ] && [ -z "$(find "$STAMP" -mmin +1440 2>/dev/null)" ]; then exit 0; fi
mkdir -p "$(dirname "$STAMP")" && touch "$STAMP"
git -C "$D" fetch -q 2>/dev/null & pid=$!
for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
kill "$pid" 2>/dev/null
n="$(git -C "$D" rev-list --count 'HEAD..@{u}' 2>/dev/null)"
[ "${n:-0}" -gt 0 ] 2>/dev/null || exit 0
s=$([ "$n" = 1 ] && echo "" || echo "s")
printf '{"systemMessage": "desk-skills has %s new commit%s. Run /desk-update to see what changed and install it."}\n' "$n" "$s"
