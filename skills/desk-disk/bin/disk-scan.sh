#!/usr/bin/env bash
# The measuring half of desk-disk. It only reads: it writes, moves and deletes nothing, and runs only
# the read forms of docker and tmutil. Written for bash 3.2 (stock macOS /bin/bash) as well as 4+.
#   disk-scan.sh scan [--worktrees <dir>]... [--backup-volume </Volumes/name>]
#       free space on the data volume, then one row per offender in references/offenders.md
#   disk-scan.sh measure [--backup-volume </Volumes/name>]
#       free_gb=<n> local_snapshots=<n> [backup_free_gb=<n>]: run before and after every fix
# DESK_DISK_SYSROOT prefixes the system paths it reads (/Library, /opt, /usr/local, /Volumes), so the
# test can point them at a fixture tree.
set -u
SYS="${DESK_DISK_SYSROOT:-}"

data_volume() { if [ -d /System/Volumes/Data ]; then echo /System/Volumes/Data; else echo /; fi; }

# Available KB from `df -kP`, whose POSIX format never wraps a long device name.
avail_kb() { df -kP "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
# The mount point is everything after the fifth field, so a drive named "Backup Disk" keeps its space.
mount_of() { df -kP "$1" 2>/dev/null | awk 'NR == 2 { s = $0; for (i = 0; i < 5; i++) sub(/^[^ ]+ +/, "", s); print s }'; }

gb() { awk -v k="$1" 'BEGIN { printf "%.1f GB", k / 1048576 }'; }

# du's total in KB for every path given, measured in one call so a hard link is counted once.
kb_of() { du -sck "$@" 2>/dev/null | awk 'END { if (NR) print $1 }'; }

row() { printf '%-24s %12s  %s  %s\n' "$1" "$2" "$3" "$4"; }

# du exits non-zero when it could not read part of the tree (macOS privacy refuses a terminal some
# containers), so that size is a floor.
sized_row() { # <offender> <path> <note>
  if [ ! -e "$2" ]; then row "$1" "-" "$2" "not present"; return; fi
  local out rc
  out=$(du -sk "$2" 2>/dev/null); rc=$?
  if [ $rc -ne 0 ]; then row "$1" ">=$(gb "${out%%[[:space:]]*}")" "$2" "$3; partly unreadable: grant the terminal Full Disk Access to measure it all"
  else row "$1" "$(gb "${out%%[[:space:]]*}")" "$2" "$3"; fi
}

local_snapshots() {
  command -v tmutil >/dev/null 2>&1 || { echo 0; return; }
  tmutil listlocalsnapshots / 2>/dev/null | grep -c 'com.apple' || true
}

gb_num() { awk -v k="${1:-0}" 'BEGIN { printf "%.1f", k / 1048576 }'; }

# With --backup-volume it adds that drive's free space, the figure a backup deletion moves.
measure() {
  local k; k=$(avail_kb "$(data_volume)")
  printf 'free_gb=%s local_snapshots=%s' "$(gb_num "$k")" "$(local_snapshots)"
  if [ -n "$BACKUP" ]; then
    if [ -d "$BACKUP" ]; then printf ' backup_free_gb=%s' "$(gb_num "$(avail_kb "$BACKUP")")"; else printf ' backup_free_gb=-'; fi
  fi
  echo
}

scan_docker() {
  if ! command -v docker >/dev/null 2>&1; then row docker-volumes "-" "docker" "not installed"; return; fi
  if ! docker info >/dev/null 2>&1; then row docker-volumes "-" "docker" "daemon not running: start OrbStack or Docker to measure"; return; fi
  local type size recl n
  docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}' 2>/dev/null |
    while IFS=$'\t' read -r type size recl; do
      case "$type" in
        "Local Volumes") n=$(docker volume ls -q --filter dangling=true 2>/dev/null | grep -c . || true)
                         row docker-volumes "$size" "docker volumes" "reclaimable $recl; $n not used by any container" ;;
        "Build Cache")   row docker-build-cache "$size" "docker build cache" "reclaimable $recl (estimate: live builds still use old layers)" ;;
        Images)          row docker-images "$size" "docker images" "reclaimable $recl; report only" ;;
        Containers)      row docker-containers "$size" "docker containers" "report only" ;;
      esac
    done
  sized_row orbstack-image "$HOME/Library/Group Containers/HUQAFE2P5L.dev.orbstack/data" "OrbStack's disk image: the docker rows above live inside it"
}

scan_chrome_clones() {
  local cache x n k
  cache=$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null) || cache=""
  if [ -z "$cache" ]; then row chrome-code-sign-clone "-" "/var/folders/…/X" "not macOS"; return; fi
  x="${cache%/}"; x="${x%/C}/X"
  # Each app's clones sit in one X/<bundle id>.code_sign_clone folder, a copy per subfolder.
  set -- "$x"/*code_sign_clone*
  if [ ! -d "$1" ]; then row chrome-code-sign-clone "-" "$x" "none"; return; fi
  n=$(find "$@" -mindepth 1 -maxdepth 1 2>/dev/null | grep -c . || true)
  k=$(kb_of "$@")
  row chrome-code-sign-clone "$(gb "${k:-0}")" "$x" "$n copies; APFS clones share blocks, so du overcounts: expect far less freed"
}

scan_icloud() {
  local root="$HOME/Library/Mobile Documents/com~apple~CloudDocs" d git rc k
  sized_row icloud-drive "$root" "downloaded iCloud Drive files (evicted ones count 0)"
  [ -d "$root" ] || return 0
  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    # The whole tree, at any depth: a folder is evictable only when a complete search finds no .git.
    git=$(find "$d" -name .git -print 2>/dev/null); rc=$?
    k=$(kb_of "$d")
    if [ -n "$git" ]; then row icloud-folder "$(gb "${k:-0}")" "$d" "holds a git repository: never evicted"
    elif [ $rc -ne 0 ]; then row icloud-folder "$(gb "${k:-0}")" "$d" "partly unreadable, so not checked for git repositories: never evicted"
    else row icloud-folder "$(gb "${k:-0}")" "$d" "evictable"; fi
  done
}

scan_onedrive() {
  local d found=0
  for d in "$HOME"/Library/CloudStorage/OneDrive*; do
    [ -d "$d" ] || continue
    found=1; sized_row onedrive "$d" "downloaded OneDrive files"
  done
  [ "$found" = 1 ] || row onedrive "-" "$HOME/Library/CloudStorage/OneDrive*" "not present"
}

scan_postgres() {
  local d found=0
  for d in "$SYS"/opt/homebrew/var/postgresql* "$SYS"/usr/local/var/postgres*; do
    [ -d "$d" ] || continue
    found=1; sized_row homebrew-postgres "$d" "every database in this cluster; list them with psql -l"
  done
  [ "$found" = 1 ] || row homebrew-postgres "-" "$SYS/opt/homebrew/var/postgresql*" "not present"
}

scan_photos() {
  local d found=0
  for d in "$HOME"/Pictures/*.photoslibrary; do
    [ -d "$d" ] || continue
    found=1; sized_row photos-library "$d" "report only: Photos > Settings > iCloud > Optimise Mac Storage"
  done
  [ "$found" = 1 ] || row photos-library "-" "$HOME/Pictures/*.photoslibrary" "not present"
}

scan_time_machine() {
  local v m n
  row local-snapshots "$(local_snapshots)" "tmutil listlocalsnapshots /" "count, not size: macOS does not report a snapshot's size"
  # A folder in /Volumes that is not a mount point makes the drive of that name mount as "<name> 1".
  for v in "$SYS"/Volumes/*/; do
    v="${v%/}"
    # /Volumes/Macintosh HD is a symlink to /, not a stale folder.
    [ -d "$v" ] && [ ! -L "$v" ] || continue
    m=$(mount_of "$v")
    [ "$m" = "$v" ] || row stale-volume-folder "-" "$v" "a folder, not a mounted drive"
  done
  [ -n "$BACKUP" ] || return 0
  if [ ! -d "$BACKUP" ]; then row time-machine "-" "$BACKUP" "not mounted"; return; fi
  n=$(tmutil listbackups -d "$BACKUP" 2>/dev/null | grep -c . || true)
  row time-machine "$(gb "$(avail_kb "$BACKUP")") free" "$BACKUP" "$n backups (tmutil listbackups -d)"
}

scan() {
  local v k w
  v=$(data_volume); k=$(avail_kb "$v")
  echo "free $v: $(gb "${k:-0}")"
  echo
  row OFFENDER SIZE PATH NOTE
  scan_docker
  sized_row messages-tmp "$HOME/Library/Containers/com.apple.MobileSMS/Data/tmp/TemporaryItems" "copies of sent videos; originals are elsewhere"
  scan_chrome_clones
  scan_icloud
  scan_onedrive
  # A pipe, not a heredoc: bash writes a heredoc to a temp file, and the scan writes nothing.
  if [ -n "$WORKTREES" ]; then
    printf '%s' "$WORKTREES" | while IFS= read -r w; do [ -n "$w" ] && sized_row worktrees "$w" "measured once, so pnpm's hard links count once"; done
  else row worktrees "-" "(none given)" "pass --worktrees <§2 Worktrees directory> for each repo"; fi
  scan_postgres
  sized_row backblaze-logs "$SYS/Library/Backblaze.bzpkg/bzdata/bzlogs" "fixed by Backblaze exclusions, not by deleting"
  scan_photos
  scan_time_machine
}

WORKTREES=""; BACKUP=""
cmd="${1:-}"; [ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --worktrees) [ $# -ge 2 ] || { echo "--worktrees needs a directory" >&2; exit 2; }; WORKTREES="$WORKTREES$2
"; shift 2 ;;
    --backup-volume) [ $# -ge 2 ] || { echo "--backup-volume needs a path" >&2; exit 2; }; BACKUP="${2%/}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$cmd" in
  scan) scan ;;
  measure) measure ;;
  *) echo "usage: disk-scan.sh scan [--worktrees <dir>]... [--backup-volume <path>] | disk-scan.sh measure [--backup-volume <path>]" >&2; exit 2 ;;
esac
