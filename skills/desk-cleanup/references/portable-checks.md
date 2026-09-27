# Portable checks for desk-cleanup

Every snippet here runs on macOS and Linux/WSL unless a heading says otherwise. `lsof` ships with
macOS; on Linux install it if `command -v lsof` is empty rather than falling back to `/proc`
scraping in a skill run.

## Processes inside a worktree (by prefix)

A dev server's cwd is usually `<worktree>/packages/studia-web`, so match the prefix, never the
exact path.

```bash
WT=<absolute worktree path>
lsof -nP -d cwd -Fpcn 2>/dev/null | awk -v p="$WT" '
  /^p/ {pid=substr($0,2)} /^c/ {cmd=substr($0,2)}
  /^n/ {if (index(substr($0,2), p) == 1) print pid, cmd, substr($0,2)}'
```

Open files too (slower; background it on WSL): `lsof -nP +D "$WT" 2>/dev/null | awk 'NR>1{print $2,$1}' | sort -u`.

## Listening ports and who holds them

```bash
lsof -nP -iTCP -sTCP:LISTEN | awk 'NR==1 || $9 ~ /:(3[0-9][0-9][0-9]|6006|8288)$/'
ps -o pid=,rss=,etime=,args= -p <pid>     # rss is KiB on both platforms
```

## Largest processes

```bash
ps -Ao pid=,rss=,etime=,args= | sort -k2 -nr | head -20
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'
```

`ps --sort` is GNU-only; the `sort -k2 -nr` form works everywhere.

## Owner of a process

`pstree -alps` is Linux psmisc and differs on macOS. Walk the parents instead — the `bash -c`
layer between a server and its `claude` names the worktree and port:

```bash
p=<pid>; while [ "${p:-1}" -gt 1 ]; do ps -o pid=,ppid=,args= -p "$p"; p=$(ps -o ppid= -p "$p" | tr -d ' '); done
```

## "Is a test run in flight?" — never trust a bare `pgrep -f` count

`pgrep -f '[j]est-worker'` defeats the inner self-match but not Claude Code's own `bash -c`
wrapper, whose command line carries the pattern verbatim, brackets and all. **Why:** on a cleanup
run `pgrep -f '[v]itest'` returned one pid, read as the portal's runaway vitest, and
it was the wrapper. Match on the executable instead, which a shell wrapper can never satisfy:

```bash
ps -Ao pid=,rss=,etime=,args= | awk '$4 ~ /(^|\/)node$/ && /jest-worker|vitest/'
```

An autopilot worker carries its whole briefing in argv, so the words "jest" and "vitest" appear in
`claude` command lines too — the `node` test on the executable excludes those as well.

## Memory totals

| | Linux / WSL | macOS |
|---|---|---|
| room to start something | `awk '/MemAvailable/{printf "%.1f GiB\n",$2/1048576}' /proc/meminfo` | `memory_pressure \| tail -1` (free percentage) |
| overview | `free -h` | `vm_stat` (pages; multiply by `pagesize`) |
| swap | `swapon --show` | `sysctl vm.swapusage` |

Report the **before/after delta** around a suspected leak or a test run, not a sum of RSS — summing
counts the shared Node binary and copy-on-write heap once per worker.

**WSL only (config §2 "Running on WSL?" = yes).** The guest's `free` is not the ceiling: the
Windows host runs out first, and page cache the guest holds counts against it. Read host free RAM
with `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB"`
and report it beside `MemAvailable`.

## Swap full, no process owns it (Linux / WSL with tmpfs `/tmp`)

Check `df -h /tmp` — if its filesystem is `tmpfs`, files there are RAM and swappable, and their
swapped pages belong to **no** process's `VmSwap`. Signature: swap near 100% while RAM is free,
and `awk '/VmSwap/{s+=$2}END{print s/1048576" GiB"}' /proc/[0-9]*/status 2>/dev/null` is far short
of it. **Why:** swap has sat at 6.0/6.0 GiB with 207 MB attributable to processes; the rest was
`/tmp/jest_rs` (3.8 GB Jest cache), `/tmp/node-compile-cache` (1.7 GB) and a stray 250 MB vitest
log. Deleting them freed the swap with no root.

They are regenerable caches, so they may go in the plan as `[delete]` — after confirming no Jest
or vitest run is in flight (check above) and nothing holds them open
(`lsof +D /tmp/jest_rs 2>/dev/null | head`). Still never `swapoff`.

## Disk: one `du` on the containing directory, never per worktree

bun installs `node_modules` by linking into its global cache (`~/.bun/install/cache`), so the same
data appears in every worktree.

- `du -sh <one worktree>` charges it for all the shared inodes — ~3.6 GB each on one machine,
  where twenty of them would have exceeded the filesystem's total usage.
- Passing every worktree to **one** `du` is wrong the other way: `du` dedupes by inode across its
  arguments, so the first directory absorbs the shared inodes and the rest read tiny (4.5 GB vs
  311 MB for near-identical trees).

The honest figure is one `du` on the parent (`-x` stays on one filesystem on both GNU and BSD `du`):

```bash
du -shx <worktrees dir>      # 18G for 20 worktrees — marginal cost ~1 GB each
```

On macOS bun defaults to APFS clones rather than hardlinks, which `du` cannot dedupe at all, so even
the parent figure overstates. There, quote the `df -h` free-space change after removal instead of a
`du` prediction. `du` over these trees is slow on WSL; background it.

## Orphaned worktree directories

`git worktree list` only reports directories git still has a registry entry for. A directory whose
entry was pruned stays on disk, full size, invisible to every git-based check. **Why:** a 2.5 GB
remnant under `.claude/worktrees/` has been the largest worktree on the box after one live
ticket, and only a directory listing found it.

```bash
git -C <repo root> worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | sort > /tmp/registered.$$
for d in <worktrees dir>/*/ <repo root>/.claude/worktrees/*/; do [ -d "$d" ] && printf '%s\n' "${d%/}"; done | sort > /tmp/on-disk.$$
comm -13 /tmp/registered.$$ /tmp/on-disk.$$     # on disk, not registered = orphan
rm -f /tmp/registered.$$ /tmp/on-disk.$$
```

(Use the scratchpad instead of `/tmp` when the harness provides one.) The reverse case — registered
but the directory is gone — shows in `git worktree prune --dry-run -v` and costs nothing on disk.

An orphan's `.git` file dangles, so `git worktree remove` fails and removal means `rm -rf`, which has
**no** dirty-tree guard. Rebuild the guard from evidence before proposing it:

```bash
git --git-dir=<repo root>/.git --work-tree=<orphan> diff --stat <branch>          # stranded edits
git --git-dir=<repo root>/.git --work-tree=<orphan> status --porcelain | grep '^??'  # untracked files
```

Check each untracked file against `origin/main` (typically every one is a superseded original of
an asset main has since replaced). Copy out any `.claude/desk-ticket-SV-*.json` as
for a normal removal.

## Cache sizes, for scale

Measured on one Linux/WSL machine. **Only worth touching if `df` shows under ~15%
free.**

| Path (Linux / macOS) | Size seen | Live? |
|---|---|---|
| `<primary repo root>/.turbo` | 7.1 GB | live — largest single cache, main checkout only |
| `~/.npm/_cacache` | 6.1 GB | **dead** — the repo is bun-only and npm is hook-blocked |
| `~/.bun/install/cache` | 5.1 GB | live — every worktree links into it |
| `~/.cache/ms-playwright*` / `~/Library/Caches/ms-playwright` | 3.2 GB | live — browser binaries |
| `~/.cache/pnpm` / `~/Library/Caches/pnpm` | 509 MB | **dead** — pnpm is not used |
