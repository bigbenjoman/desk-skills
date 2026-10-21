# Portable checks for desk-cleanup

Every snippet here runs on macOS and Linux/WSL unless a heading says otherwise. `lsof` ships with
macOS; on Linux install it if `command -v lsof` is empty rather than falling back to `/proc`
scraping in a skill run. §-references are to this repo's config (`desk-env where`, then Read it).

## Processes inside a worktree (by prefix)

In a monorepo a dev server's cwd is usually a package subdirectory of the worktree, so match the
prefix, never the exact path.

```bash
WT=<absolute worktree path>
lsof -nP -d cwd -Fpcn 2>/dev/null | awk -v p="$WT" '
  /^p/ {pid=substr($0,2)} /^c/ {cmd=substr($0,2)}
  /^n/ {if (index(substr($0,2), p) == 1) print pid, cmd, substr($0,2)}'
```

Open files too (slower; background it on WSL): `lsof -nP +D "$WT" 2>/dev/null | awk 'NR>1{print $2,$1}' | sort -u`.

## Listening ports and who holds them

Build the port list from config: the §3b Preferred dev-server port and the range above it that
autopilot workers take (a hundred ports up is a safe span), plus every port §4 Dev server and §4
Local services name. Pass them as a regex alternation:

```bash
PORTS='3[0-9][0-9][0-9]|<each port §4 Local services and §4 Dev server name, |-separated>'
lsof -nP -iTCP -sTCP:LISTEN | awk -v re=":($PORTS)\$" 'NR==1 || $9 ~ re'
ps -o pid=,rss=,etime=,args= -p <pid>     # rss is KiB on both platforms
```

(`3[0-9][0-9][0-9]` above assumes the dev-server port is in the 3000s; widen it to match §3b.)

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
run `pgrep -f '[v]itest'` returned one pid, read as a runaway vitest, and it was the wrapper. Match
on the executable instead, which a shell wrapper can never satisfy:

```bash
ps -Ao pid=,rss=,etime=,args= | awk '$4 ~ /(^|\/)node$/ && /jest-worker|vitest/'
```

Adjust the pattern to this repo's test runners (§4 Unit tests, §4 E2E tests); a non-Node runner
matches on its own executable instead of `node`.

An autopilot worker carries its whole briefing in argv, so the words "jest" and "vitest" appear in
`claude` command lines too — the test on the executable excludes those as well.

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

They are regenerable caches, so they may go in the plan as `[delete]` — after confirming no test
run is in flight (check above) and nothing holds them open
(`lsof +D /tmp/jest_rs 2>/dev/null | head`). Still never `swapoff`.

## Disk: one `du` on the containing directory, never per worktree

Some package managers install `node_modules` by linking into a global store (pnpm's content-addressed
store, and others that hardlink from a global cache), so the same data appears in every worktree.
Check which one §4 Package manager names.

- `du -sh <one worktree>` charges it for all the shared inodes — ~3.6 GB each on one machine,
  where twenty of them would have exceeded the filesystem's total usage.
- Passing every worktree to **one** `du` is wrong the other way: `du` dedupes by inode across its
  arguments, so the first directory absorbs the shared inodes and the rest read tiny (4.5 GB vs
  311 MB for near-identical trees).

The honest figure is one `du` on the parent (`-x` stays on one filesystem on both GNU and BSD `du`):

```bash
du -shx <worktrees dir>      # 18G for 20 worktrees — marginal cost ~1 GB each
```

On macOS some package managers default to APFS clones rather than hardlinks, which `du` cannot
dedupe at all, so even the parent figure overstates. There, quote the `df -h` free-space change after
removal instead of a `du` prediction. `du` over these trees is slow on WSL; background it.

## Orphaned worktree directories

`git worktree list` only reports directories git still has a registry entry for. A directory whose
entry was pruned stays on disk, full size, invisible to every git-based check. **Why:** a 2.5 GB
remnant under `.claude/worktrees/` has been the largest worktree on the box after one live
ticket, and only a directory listing found it.

```bash
comm -13 <(git -C <repo root> worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | sort) \
  <(find <worktrees dir> <repo root>/.claude/worktrees -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)   # on disk, not registered = orphan
```

Both lists are absolute paths, so give `<worktrees dir>` and `<repo root>` in full. No scratch files:
a write to `/tmp` is outside the working directory and prompts every time. The reverse case —
registered but the directory is gone — shows in `git worktree prune --dry-run -v` and costs nothing
on disk.

An orphan's `.git` file dangles, so `git worktree remove` fails and removal means `rm -rf`, which has
**no** dirty-tree guard. Rebuild the guard from evidence before proposing it:

```bash
git --git-dir=<repo root>/.git --work-tree=<orphan> diff --stat <branch>          # stranded edits
git --git-dir=<repo root>/.git --work-tree=<orphan> status --porcelain | grep '^??'  # untracked files
```

Check each untracked file against `origin/<default branch>` (typically every one is a superseded
original of an asset the default branch has since replaced). Copy out any
`.claude/desk-ticket-<TICKET>.json` as for a normal removal.

## Cache sizes, for scale

Measured on one Linux/WSL machine. **Only worth touching if `df` shows under ~15%
free.** Global caches are shared by **every** repo on the machine, so "dead" means no repo uses it —
check the §4 Package manager of each repo you have a desk config for (`ls ~/.config/desk/repos/`)
before calling a package manager's cache dead, and even then, report it rather than delete it.

| Path (Linux / macOS) | Size seen | Live? |
|---|---|---|
| a build-system cache in the primary repo root (e.g. `.turbo`, `.nx/cache`) | 7.1 GB | live — often the largest single cache, primary checkout only |
| the global store of §4 Package manager (e.g. `~/.local/share/pnpm/store`, `~/.npm/_cacache`) | 5-6 GB | live — every worktree installs from it |
| the global store of a package manager no configured repo uses | up to 6 GB | **dead** for these repos — report only |
| `~/.cache/ms-playwright*` / `~/Library/Caches/ms-playwright` | 3.2 GB | live wherever a repo runs browser tests |
