#!/usr/bin/env bash
# install.sh's install_file replaces a file by renaming a copy over it, so a script already running
# from the old file finishes on the old file. Runs the function itself, taken from install.sh, under
# a throwaway HOME. Nothing touches your real ~/.claude.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
SH="${BASH:-bash}"
export HOME="$T/home"; mkdir -p "$HOME"
export PRISTINE="$T/pristine" BACKUP="$T/backup"
note(){ :; }; wrote(){ :; }
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

fn="$(sed -n '/^install_file() {$/,/^}$/p' "$S/../install.sh")"
check "install_file is found in install.sh" '[ -n "$fn" ]'
eval "$fn"

# The old script says it has started, waits for go, then reads lines past bash's first buffer.
cat > "$T/old.sh" <<'EOF'
#!/usr/bin/env bash
: > "$1/ready"
while [ ! -f "$1/go" ]; do sleep 0.05; done
EOF
i=0; while [ $i -lt 400 ]; do echo "# padding line $i so the end of this script is read only after go" >> "$T/old.sh"; i=$((i + 1)); done
echo 'echo old-finished' >> "$T/old.sh"
printf '#!/usr/bin/env bash\n' > "$T/new.sh"
i=0; while [ $i -lt 800 ]; do echo "echo new-$i" >> "$T/new.sh"; i=$((i + 1)); done

DEST="$HOME/.claude/desk/bin/loop.sh"
inode(){ local n _; read -r n _ <<< "$(ls -i "$1")"; echo "$n"; }
# run_case <install|cp>: start the old script, replace it mid-run, let it finish.
run_case(){
  local d="$T/$1" n=0
  rm -rf "$d" "$HOME/.claude" "$PRISTINE"; mkdir -p "$d"
  install_file "$T/old.sh" "$DEST"; chmod +x "$DEST"
  "$SH" "$DEST" "$d" > "$d/out" 2>&1 &
  local pid=$!
  while [ ! -f "$d/ready" ] && [ $n -lt 200 ]; do sleep 0.05; n=$((n + 1)); done
  ino_before=$(inode "$DEST")
  if [ "$1" = install ]; then install_file "$T/new.sh" "$DEST"; else cp "$T/new.sh" "$DEST"; fi
  : > "$d/go"; wait "$pid"
  out=$(cat "$d/out")
}

run_case cp
check "control: copying over a running script changes what it runs" '[ "$out" != "old-finished" ]'

run_case install
check "a script running from the old file finishes on it" '[ "$out" = "old-finished" ]'
check "the next start runs the new file" 'cmp -s "$T/new.sh" "$DEST" && [ "$("$SH" "$DEST" | tail -n 1)" = "new-799" ]'
out="$ino_before $(inode "$DEST")"
check "the target is a new inode (renamed over, not rewritten)" '[ "${out% *}" != "${out#* }" ]'
out="$(ls -la "$(dirname "$DEST")")"
check "no temp file is left beside the target" '[ "$(ls -A "$(dirname "$DEST")")" = "loop.sh" ]'
check "the target keeps its executable mode" '[ -x "$DEST" ]'
check "the pristine copy is the new file" 'cmp -s "$T/new.sh" "$PRISTINE/.claude/desk/bin/loop.sh"'

rm -rf "$HOME/.claude"
install_file "$T/new.sh" "$DEST"
out="$(ls -la "$(dirname "$DEST")")"
check "a fresh install writes the file and nothing else" 'cmp -s "$T/new.sh" "$DEST" && [ "$(ls -A "$(dirname "$DEST")")" = "loop.sh" ]'

echo "$PASS checks passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
