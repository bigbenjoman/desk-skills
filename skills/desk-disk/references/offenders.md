# The offender catalogue

Every row `bin/disk-scan.sh scan` prints has an entry here, under the row's name. Each entry gives
what the space actually is, what of the user's is lost by the fix, the exact fix, and how to restore.
The report row quotes them (SKILL.md, "Report"). The sizes in **Seen** are what earlier sessions
measured on this Mac: a guide to scale, never a promise of what a fix frees.

A fix marked **sudo** is handed to the user to run in a normal terminal window (SKILL.md, "Carry
out"). Every fix is one command, run alone, measured before and after.

## docker-volumes

- **What it is:** Docker volumes inside OrbStack's disk image. Most are anonymous volumes left by
  containers run without `--rm`: test databases and scratch data, about 190 a day.
- **Seen:** OrbStack 498 GB, of which 428 GB was 4,722 anonymous volumes.
- **Lost by the fix:** the data in volumes no container uses. Named volumes are kept.
- **Fix:** `docker volume prune -f`. It removes unused anonymous volumes only; never add `-a`, which
  takes named volumes too.
- **Restore:** none. A pruned volume is gone; the container that made it recreates an empty one.
- **Stops it coming back:** run throwaway containers with `--rm`.

## docker-build-cache

- **What it is:** layers kept to speed up later `docker build`s.
- **Seen:** 88 GB; the fix freed 17 GB, not the 75 GB `docker system df` called reclaimable, because
  live builds still used old layers.
- **Lost by the fix:** nothing of the user's; the next build is slower.
- **Fix:** `docker builder prune -f --filter until=24h`.
- **Restore:** rebuilt on the next `docker build`.

## docker-images, docker-containers

Report only. Images hold the database images the dev tooling needs (`desk-cleanup` never touches
them either), and containers are small and needed the moment work starts.

## orbstack-image

- **What it is:** the disk image every docker row above lives in. It does not shrink the moment
  volumes are pruned; OrbStack returns the space to macOS on its own afterwards.
- **Fix:** none of its own: fix the docker rows, then re-measure.

## messages-tmp

- **What it is:** `~/Library/Containers/com.apple.MobileSMS/Data/tmp/TemporaryItems`, copies Messages
  makes of videos it sends. The originals are elsewhere (Photos, the folder they were sent from).
- **Seen:** 226 GB.
- **Lost by the fix:** nothing; sent messages keep their attachments.
- **Fix:** quit Messages first (`osascript -e 'quit app "Messages"'`), then
  `rm -rf ~/Library/Containers/com.apple.MobileSMS/Data/tmp/TemporaryItems/*`. If macOS refuses
  ("Operation not permitted"), hand the user the same command for a terminal with Full Disk Access.
- **Restore:** none needed.

## chrome-code-sign-clone

- **What it is:** copies of Chrome that macOS keeps under `/var/folders/…/X/` to check its code
  signature while it updates.
- **Seen:** 101 copies looked like 143 GB and freed about 9 GB: the copies are APFS clones sharing
  disk blocks, and `du` counts every one in full.
- **Lost by the fix:** nothing.
- **Fix:** quit Chrome, then `rm -rf <the path the row printed>/*code_sign_clone*`. Chrome makes one
  fresh copy on its next launch.
- **Restore:** none needed.

## icloud-drive, icloud-folder

- **What it is:** iCloud Drive files downloaded to this Mac. An evicted file stays in iCloud and in
  Finder, takes no disk, and downloads again when opened.
- **Seen:** a 216 GB folder (Franklin Method) that looked like OneDrive and was iCloud.
- **Lost by the fix:** nothing, while the files are in iCloud; opening one needs the network.
- **Fix:** one folder per command, and **never a folder the row says holds a git repository**:
  evicting a repository's files makes every `git status` download it back, and a half-downloaded
  `.git` corrupts it. Skip those, and those the scan could not search in full, and list each by
  path in the report. For a folder marked `evictable`, first check again that it holds no `.git`
  at any depth (a read, so it is not the fix): this must print nothing, or the folder is skipped.

  ```bash
  find "<folder>" -name .git -print
  ```

  Then, as the fix, skip the files already evicted (the dataless flag, `0x40000000`) and evict the
  rest:

  ```bash
  find "<folder>" -type f ! -name '.*' -print0 | while IFS= read -r -d '' f; do (( $(stat -f %f "$f") & 0x40000000 )) || brctl evict "$f" >/dev/null; done
  ```

- **Freed later, not at once:** iCloud frees the space in the background, minutes after the command
  returns. Re-measure after a few minutes before calling the fix a miss.
- **Restore:** open the file, or Finder → right-click → Download Now.

## onedrive

- **What it is:** OneDrive files downloaded to this Mac.
- **Lost by the fix:** nothing, while they are in OneDrive.
- **Fix:** the user's, in Finder: right-click the folder → Free Up Space.
- **Restore:** Finder → Always Keep on This Device.

## worktrees

- **What it is:** git worktrees, mostly `node_modules`, `.next` and `.venv`. pnpm hard-links
  `node_modules`, so `du` run per worktree counts the same files many times; the scan measures each
  worktrees directory once.
- **Lost by the fix:** a worktree whose work has not landed. That is why the fix is not here.
- **Fix:** `desk-cleanup` (step 2), run from inside each repo, removes merged worktrees with its two
  signals and a backup first. Never remove a worktree by hand.
- **Restore:** `git worktree add <path> <branch>`, as `desk-cleanup` records.

## homebrew-postgres

- **What it is:** Homebrew's Postgres cluster. A single idle database can be most of it.
- **Seen:** one idle 22 GB database (`forewatt_verify`).
- **Lost by the fix:** nothing, once every row of the dump has read back. Which database is idle is
  the user's call: list them (`psql -d postgres -c '\l+'`) and ask about each one.
- **Fix:** three commands, each its own approved step, and each run only if the one before it exited
  0. A disk this full can cut a dump short, so any error, a full disk included, stops the fix here
  with nothing dropped:
  1. `pg_dump -Fc -f <dump path> <db>`, the dump on a drive with room for it
  2. `pg_restore --exit-on-error -f /dev/null <dump path>`: reads every table's data back, not just
     the table of contents (`pg_restore --list` lists a dump cut short as clean), and writes nothing
  3. `dropdb <db>`
- **Restore:** `createdb <db> && pg_restore -d <db> <dump path>`.

## backblaze-logs

- **What it is:** Backblaze's upload logs, grown by backing up worktrees (4.7M `node_modules` files
  a day).
- **Seen:** 51 GB.
- **Lost by the fix:** the offsite copy of excluded worktrees, so work in one that is not pushed is
  no longer backed up by Backblaze. Push it first.
- **Fix:** the user's, in Backblaze → Settings → Exclusions: add each worktrees directory. Never
  delete the logs; they grow back while the cause stands.
- **Restore:** remove the exclusion.

## photos-library

Report only, with its size. "Optimise Mac Storage" is the user's choice, in Photos → Settings →
iCloud.

## local-snapshots

- **What it is:** APFS snapshots Time Machine keeps on the Mac between backups. They hold the blocks
  of files deleted since, so a deletion frees nothing until they go. macOS removes them itself when
  space runs short, but not quickly.
- **Fix (sudo):** list with `tmutil listlocalsnapshots /`, then
  `sudo tmutil deletelocalsnapshots <date>` per snapshot, oldest first.
- **Lost by the fix:** the hourly restore points since the last backup to the drive.
- **Restore:** none.

## time-machine

Only with `--backup-volume`.

- **What it is:** the backups on the Time Machine drive.
- **Seen:** each oldest backup deleted freed about 65 GB to 200 GB; there is no way to know which
  before deleting it.
- **Lost by the fix:** the history in that backup: files changed or deleted since then that only it
  held.
- **Fix (sudo):** `tmutil listbackups -d <volume>`, then oldest first, one per step:
  `sudo tmutil delete -d <volume> -t <stamp>`. Ask before each, measure with
  `measure --backup-volume <volume>` before and after, and stop when `backup_free_gb` is enough.
- **Restore:** none.
- **Never force-eject an encrypted backup drive:** that left one locked and needing
  `diskutil apfs unlockVolume`.

## stale-volume-folder

- **What it is:** a plain folder in `/Volumes` with a drive's name. The drive then mounts as
  `<name> 1`, and Time Machine backups to it fail.
- **Lost by the fix:** nothing: only an empty folder is removed.
- **Fix (sudo):** with the drive unplugged, and only when the folder is empty
  (`ls -A /Volumes/<name>` prints nothing): `sudo rmdir "/Volumes/<name>"`. A folder with files in
  it is reported, never removed: they are writes meant for the drive.
- **Restore:** none needed.
