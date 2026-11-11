#!/usr/bin/env bash
# suite: vendor patches (a local change re-applied on upgrade)
# Tests sources.json `patches`: `skills-upstream upgrade` re-applies a skill's local patch to the new
# upstream before it lands in vendor/, records the tree hash after patching, and refuses the skill,
# leaving vendor/ and the pin alone, when the patch no longer applies. An upgrade rewrites
# sources.json only when it moved something, so a checkout upgrade leaves it byte-for-byte. Against a scratch desk-skills
# tree, a stub gh serving a fake upstream and a temp dir inside a git repo; no network. Then checks
# this repo's own patched skills: each patch is applied in vendor/ and the hash is the patched one.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
PASS=0; FAIL=0; rc=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=$rc out: $out"; fi; }

R="$T/src"; mkdir -p "$R/bin" "$R/vendor/demo" "$R/vendor-patches"
cp "$S/../bin/skills-upstream" "$R/bin/"
UP="$T/upstream"; mkdir -p "$UP"
printf 'line one\nAsk first, always.\nline three\n' > "$UP/SKILL.md"
cp "$UP/SKILL.md" "$R/vendor/demo/SKILL.md"
cat > "$R/vendor-patches/demo.patch" <<'EOF'
diff --git a/SKILL.md b/SKILL.md
--- a/SKILL.md
+++ b/SKILL.md
@@ -1,3 +1,3 @@
 line one
-Ask first, always.
+Infer and state the assumption.
 line three
EOF
cat > "$R/vendor/sources.json" <<'J'
{"skills": {"demo": {"source": {"type": "github", "repo": "acme/skills", "path": "demo"},
  "pin": {"commit": "aaaaaaaaa", "date": "2026-10-01"}, "patches": ["vendor-patches/demo.patch"]}}}
J

# Stub gh: newest commit $LATEST, and the upstream folder's one file.
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<EOF
#!/usr/bin/env bash
[ "\$1" = api ] || exit 1
case "\$2" in
  repos/acme/skills/commits\?path=demo\&per_page=1) printf '%s\t2026-11-01\tNewer\n' "\$LATEST" ;;
  repos/acme/skills/git/trees/*) printf '{"tree":[{"path":"demo/SKILL.md","type":"blob"}]}\n' ;;
  repos/acme/skills/contents/demo/SKILL.md*) base64 < "$UP/SKILL.md" | tr -d '\n'; echo ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"
# The upgrade's temp dir sits inside a git repo: git apply must still patch the skill's own folder.
git init -q "$T/outer"; mkdir -p "$T/outer/tmp"
U(){ out=$(TMPDIR="$T/outer/tmp" python3 "$R/bin/skills-upstream" "$@" 2>&1); rc=$?; }
pin(){ jq -r '.skills.demo.pin.commit' "$R/vendor/sources.json"; }
hash(){ jq -r '.skills.demo.tree_sha256' "$R/vendor/sources.json"; }

# AC3: a refresh re-applies the patch, and the recorded hash is the patched tree's.
export LATEST=bbbbbbbbbbbb
U upgrade demo
check "AC3 upgrade re-applies the patch to the new upstream" \
  '[ $rc -eq 0 ] && grep -qx "Infer and state the assumption." "$R/vendor/demo/SKILL.md" && ! grep -q "Ask first" "$R/vendor/demo/SKILL.md"'
check "AC3 the pin moves" '[ "$(pin)" = bbbbbbbbb ]'
# shellcheck disable=SC2034
before=$(hash)
U rehash
check "AC3 tree_sha256 is recorded after patching (rehash of vendor/ agrees)" '[ -n "$before" ] && [ "$(hash)" = "$before" ]'

# Upstream moves on without touching the patched text: the patched result equals vendor/.
export LATEST=cccccccccccc
cp "$R/vendor/sources.json" "$T/sources.before"
U upgrade demo
check "an upstream identical under the patch updates the pin only" \
  '[ $rc -eq 0 ] && [[ "$out" == *"upstream content is identical to vendor/demo; pin updated only"* ]] && [ "$(pin)" = ccccccccc ]'
# shellcheck disable=SC2034
moved=$(diff "$T/sources.before" "$R/vendor/sources.json" | grep -E '^[<>]')
check "AC2 a vendored upgrade changes only that entry's pin lines in sources.json" \
  '[ -n "$moved" ] && ! printf "%s\n" "$moved" | grep -vqE "^[<>] +\"(commit|date)\": "'

# AC1: upgrading a checkout entry pulls the clone and leaves a hand-formatted sources.json untouched.
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare "$T/clerk.git"
git clone -q "$T/clerk.git" "$T/clerk-work" 2>/dev/null
echo one > "$T/clerk-work/SKILL.md"; git -C "$T/clerk-work" add -A; git -C "$T/clerk-work" commit -qm one
git -C "$T/clerk-work" branch -qM main; git -C "$T/clerk-work" push -q origin main
mkdir -p "$HOME/.agents/skills"; git clone -q -b main "$T/clerk.git" "$HOME/.agents/skills/clerk"
echo two > "$T/clerk-work/SKILL.md"; git -C "$T/clerk-work" commit -qam two; git -C "$T/clerk-work" push -q origin main
cp "$R/vendor/sources.json" "$T/sources.keep"
cat > "$R/vendor/sources.json" <<'J'
{"skills": {"clerk": {"source": {"type": "checkout", "repo": "acme/clerk", "branch": "main"},
  "patches": ["kept/inline.patch"]}}}
J
cp "$R/vendor/sources.json" "$T/sources.before"
U upgrade clerk
check "AC1 a checkout upgrade pulls the clone" '[ $rc -eq 0 ] && grep -qx two "$HOME/.agents/skills/clerk/SKILL.md"'
check "AC1 and leaves sources.json byte-for-byte as it was" 'cmp -s "$T/sources.before" "$R/vendor/sources.json"'
cp "$T/sources.keep" "$R/vendor/sources.json"

# Upstream rewrites the patched line: refused loudly, nothing reverted.
printf 'line one\nAsk first, and ask again.\nline three\n' > "$UP/SKILL.md"
export LATEST=dddddddddddd
U upgrade demo
check "AC3 a patch that no longer applies refuses the skill, exit 1" \
  '[ $rc -eq 1 ] && [[ "$out" == *"REFUSED  demo: patch vendor-patches/demo.patch no longer applies"* ]] && [[ "$out" == *"NOT UPGRADED: demo"* ]]'
check "AC3 and leaves vendor/ patched and the pin where it was" \
  'grep -qx "Infer and state the assumption." "$R/vendor/demo/SKILL.md" && [ "$(pin)" = ccccccccc ] && [ "$(hash)" = "$before" ]'

# A patch sources.json names but the repo lacks is refused the same way.
printf 'line one\nAsk first, always.\nline three\n' > "$UP/SKILL.md"
mv "$R/vendor-patches/demo.patch" "$T/demo.patch"
U upgrade demo
check "a missing patch file refuses the skill" \
  '[ $rc -eq 1 ] && [[ "$out" == *"REFUSED  demo: patch vendor-patches/demo.patch is missing"* ]] && [ "$(pin)" = ccccccccc ]'

# A refused Drive skill keeps its whole entry: the new file's id and name are not saved either, or
# `outdated` would compare against a file vendor/ was never built from.
DRIVE="$T/drive_refused.py"
cat > "$DRIVE" <<'PY'
import contextlib, importlib.machinery, importlib.util, io, json, sys, zipfile
# exec_module, not load_module: Python 3.12 removed load_module.
loader = importlib.machinery.SourceFileLoader("su", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("su", loader))
sys.modules["su"] = m
loader.exec_module(m)
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr("demo/SKILL.md", "line one\n")
m.drive_listing = lambda _folder: [{"file_id": "new", "file_name": "new.zip", "modified": "Nov 1"}]
m.drive_download = lambda _id: buf.getvalue()
saved = []
m.save = lambda data: saved.append(json.loads(json.dumps(data)))
data = {"skills": {"demo": {"source": {"type": "drive", "folder_id": "f", "file_id": "old",
        "file_name": "old.zip", "skill_subdir": "demo"}, "pin": {"drive_modified": "Oct 1"},
        "patches": ["vendor-patches/absent.patch"]}}}
with contextlib.redirect_stdout(sys.stderr):
    rc = m.cmd_upgrade(data, ["demo"])
print(rc, json.dumps(saved[-1]["skills"]["demo"]["source"], sort_keys=True))
PY
out=$(TMPDIR="$T/outer/tmp" python3 "$DRIVE" "$R/bin/skills-upstream" 2>/dev/null); rc=$?
check "a refused Drive skill keeps its source's file id and name" \
  '[ "$out" = "1 {\"file_id\": \"old\", \"file_name\": \"old.zip\", \"folder_id\": \"f\", \"skill_subdir\": \"demo\", \"type\": \"drive\"}" ]'

# This repo: every recorded patch is applied in vendor/, and the hash is the patched tree's.
HASH="$T/tree_hash.py"
cat > "$HASH" <<'PY'
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("su", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("su", loader))
sys.modules["su"] = m
loader.exec_module(m)
print(m.tree_sha256(sys.argv[2]))
PY
REPO="$S/.."
# AC2: sources.json is already in save()'s format, so a vendored upgrade's diff is only its pin and hash.
FMT="$T/format.py"
cat > "$FMT" <<'PY'
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("su", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("su", loader))
sys.modules["su"] = m
loader.exec_module(m)
text = open(m.SOURCES).read()
print("same" if json.dumps(json.loads(text), indent=2, ensure_ascii=False) + "\n" == text else "differs")
PY
out=$(python3 "$FMT" "$REPO/bin/skills-upstream"); rc=$?
check "AC2 this repo's vendor/sources.json is in skills-upstream's save format" '[ "$out" = same ]'
for name in $(jq -r '.skills | to_entries[] | select(.value.patches) | .key' "$REPO/vendor/sources.json"); do
  for p in $(jq -r --arg n "$name" '.skills[$n].patches[]' "$REPO/vendor/sources.json"); do
    out=$(cd "$REPO/vendor/$name" && GIT_CEILING_DIRECTORIES="$(cd "$REPO/vendor" && pwd -P)" git apply --reverse --check "$REPO/$p" 2>&1); rc=$?
    check "$name: $p is applied in vendor/$name" '[ $rc -eq 0 ]'
  done
  out=$(python3 "$HASH" "$REPO/bin/skills-upstream" "$REPO/vendor/$name"); rc=$?
  check "$name: sources.json tree_sha256 is the patched tree's" \
    '[ "$out" = "$(jq -r --arg n "$name" ".skills[\$n].tree_sha256" "$REPO/vendor/sources.json")" ]'
done

echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
