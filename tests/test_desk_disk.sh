#!/usr/bin/env bash
# suite: desk-disk scan (free space, a row per catalogue offender, nothing written outside scratch)
# covers: skills/desk-disk/**
# disk-scan.sh against a fixture home and system root, with fake docker, tmutil and getconf that log
# every call. The whole fixture tree is listed before and after the scan, and must match everywhere
# but the scratch directory (TMPDIR); the same comparison is shown to catch a write first.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; D="$S/../skills/desk-disk/bin/disk-scan.sh"
CAT="$S/../skills/desk-disk/references/offenders.md"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
W="$T/w"   # everything the scan can see; $T outside it holds the call log and listings
export HOME="$W/home" TMPDIR="$W/scratch" DESK_DISK_SYSROOT="$W/sys" CALLS="$T/calls.log" FAKE_CACHE="$W/var/C/"
mkdir -p "$HOME" "$TMPDIR" "$T/bin"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# ---- fixture tree ----
blob(){ mkdir -p "$(dirname "$1")"; head -c 65536 /dev/zero > "$1"; }
blob "$HOME/Library/Containers/com.apple.MobileSMS/Data/tmp/TemporaryItems/v.mov"
blob "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Plain Folder/a.pdf"
blob "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Code/proj/src/x.js"
mkdir -p "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Code/proj/.git"
blob "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Deep/a/b/c/d/repo/src/y.js"
mkdir -p "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Deep/a/b/c/d/repo/.git"
blob "$HOME/Library/CloudStorage/OneDrive-Personal/b.docx"
blob "$HOME/Pictures/Photos Library.photoslibrary/db"
blob "$W/var/X/com.google.Chrome.code_sign_clone/code_sign_clone.a/c"
blob "$W/var/X/com.google.Chrome.code_sign_clone/code_sign_clone.b/c"
blob "$W/wt/DS-1/node_modules/m.js"
blob "$W/sys/opt/homebrew/var/postgresql@16/base/1"
blob "$W/sys/Library/Backblaze.bzpkg/bzdata/bzlogs/l.log"
mkdir -p "$W/sys/Volumes/Backup" "$W/backup"
ln -s / "$W/sys/Volumes/Macintosh HD"

# ---- fakes: log every call, answer the read forms, refuse anything else ----
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$CALLS"
case "$1 ${2:-}" in
  "info "*) ;;
  "system df") printf 'Images\t12GB\t3GB (25%%)\nContainers\t1GB\t0B (0%%)\nLocal Volumes\t428GB\t420GB (98%%)\nBuild Cache\t88GB\t75GB\n' ;;
  "volume ls") printf 'a1\nb2\nc3\n' ;;
  *) exit 1 ;;
esac
EOF
cat > "$T/bin/tmutil" <<'EOF'
#!/usr/bin/env bash
echo "tmutil $*" >> "$CALLS"
case "$1" in
  listlocalsnapshots) printf 'Snapshots for disk /:\ncom.apple.TimeMachine.2026-11-01-090000.local\ncom.apple.TimeMachine.2026-11-02-090000.local\n' ;;
  listbackups) printf '/Volumes/Backup/2026-09-01-000000.backup\n/Volumes/Backup/2026-10-01-000000.backup\n' ;;
  *) exit 1 ;;
esac
EOF
cat > "$T/bin/getconf" <<'EOF'
#!/usr/bin/env bash
echo "getconf $*" >> "$CALLS"
[ "$1" = DARWIN_USER_CACHE_DIR ] && echo "$FAKE_CACHE"
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

# Every path under $W but the scratch directory, and which of them changed since the stamp.
listing(){ ( cd "$W" && find . -path ./scratch -prune -o -print | LC_ALL=C sort ); }
changed(){ ( cd "$W" && find . -path ./scratch -prune -o -newer "$T/stamp" -print ); }
stamp(){ listing > "$T/before"; touch "$T/stamp"; sleep 1; }
untouched(){ listing > "$T/after"; cmp -s "$T/before" "$T/after" && [ -z "$(changed)" ]; }

# ---- the comparison catches a write, and allows the scratch directory ----
stamp; echo x > "$HOME/leak"
out=$(diff "$T/before" <(listing)); check "AC7 a file written outside scratch is caught" '! untouched'
rm -f "$HOME/leak"; stamp; echo x >> "$W/sys/Library/Backblaze.bzpkg/bzdata/bzlogs/l.log"
out=$(changed); check "AC7 a file modified outside scratch is caught" '! untouched'
stamp; echo x > "$TMPDIR/scratch-file"
check "AC7 a file written inside scratch is allowed" 'untouched'
# The scan runs with its working directory inside the watched tree, so a relative write is seen too.
stamp; ( cd "$W" && echo x > rel-leak ); out=$(changed)
check "AC7 a relative write from the scan's working directory is caught" '! untouched'
rm -f "$W/rel-leak"

# ---- the scan ----
stamp; : > "$CALLS"
out=$(cd "$W" && bash "$D" scan --worktrees "$W/wt" --backup-volume "$W/backup" 2>&1); rc=$?
scan="$out"
check "AC1 the scan exits 0" '[ $rc -eq 0 ]'
check "AC1 free space for the data volume comes first" 'printf "%s\n" "$out" | head -n 1 | grep -qE "^free /[^:]*: [0-9]+\.[0-9] GB$"'
row(){ printf '%s\n' "$scan" | grep -E "^$1 "; }
miss=""
for name in $(grep -E '^## ' "$CAT" | cut -c4- | tr -d ','); do row "$name" >/dev/null || miss="$miss $name"; done
out="missing rows:$miss"; check "AC1 a row for every offender in the catalogue" '[ -z "$miss" ]'
miss=""
for name in $(printf '%s\n' "$scan" | tail -n +2 | grep -E '^[a-z][a-z-]+ ' | cut -d' ' -f1 | LC_ALL=C sort -u); do grep -qE "^## (.*, )?$name(,|$)" "$CAT" || miss="$miss $name"; done
out="uncatalogued rows:$miss"; check "AC1 every row the scan prints is in the catalogue" '[ -z "$miss" ]'
out="$scan"
check "AC1 measured sizes for what is present" 'row messages-tmp | grep -q " GB " && row homebrew-postgres | grep -q " GB " && row worktrees | grep -q "$W/wt"'
check "AC1 docker volumes and build cache come from docker system df" 'row docker-volumes | grep -q "428GB.*3 not used" && row docker-build-cache | grep -q 88GB'
check "AC1 Chrome copies are counted and flagged as overcounted" 'row chrome-code-sign-clone | grep -q "2 copies; APFS clones"'
check "AC6 an iCloud folder holding a git repository is marked by path" 'row icloud-folder | grep -q "CloudDocs/Code  holds a git repository" && row icloud-folder | grep -q "Plain Folder  evictable"'
check "AC6 a git repository deep in an iCloud folder still keeps it from eviction" 'row icloud-folder | grep -q "CloudDocs/Deep  holds a git repository"'
check "AC1 local snapshots, a stale /Volumes folder and the backup drive are reported" 'row local-snapshots | grep -qE "^local-snapshots +2 " && row stale-volume-folder | grep -q "Volumes/Backup" && row time-machine | grep -q "2 backups"'
check "AC1 the Macintosh HD symlink in /Volumes is not a stale folder" '! row stale-volume-folder | grep -q "Macintosh HD"'
out=$(diff "$T/before" <(listing); changed)
check "AC7 the scan wrote, moved and deleted nothing outside its scratch directory" 'untouched'
out=$(grep -vE '^(docker (info|system df|volume ls)|tmutil (listlocalsnapshots|listbackups)|getconf DARWIN_USER_CACHE_DIR)' "$CALLS")
check "AC7 the scan ran only the read forms of docker, tmutil and getconf" '[ -z "$out" ]'

# ---- measure ----
stamp
out=$(cd "$W" && bash "$D" measure 2>&1)
check "AC3 measure prints free space and the local snapshot count" 'printf "%s\n" "$out" | grep -qE "^free_gb=[0-9]+\.[0-9] local_snapshots=2$"'
out=$(cd "$W" && bash "$D" measure --backup-volume "$W/backup" 2>&1)
check "AC3 measure with a backup volume adds that drive's free space" 'printf "%s\n" "$out" | grep -qE "^free_gb=[0-9]+\.[0-9] local_snapshots=2 backup_free_gb=[0-9]+\.[0-9]$"'
check "AC7 measure writes nothing outside scratch" 'untouched'

out=$(bash "$D" prune 2>&1); rc=$?
check "an unknown command is refused" '[ $rc -eq 2 ]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" = 0 ]
