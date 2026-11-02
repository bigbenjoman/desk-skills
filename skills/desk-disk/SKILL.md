---
name: desk-disk
description: >-
  Use when the Mac or its Time Machine drive is running low on space: "my disk is full", "where has
  my space gone", "free up disk", "Time Machine says the backup disk is full", a low free-disk
  warning, or the health check's free-disk floor failing. Measures where the space went, explains
  each offender in plain words, and frees it one approved fix at a time.
---

# desk-disk

## Overview

Each low-disk session used to rediscover the same offenders from scratch, and one lost about 4,700
Docker volumes to a batched prune that ran after the user had rejected it. This skill measures
first, explains, and changes nothing until the user picks a fix.

**Core principle: measure, explain, then one approved fix at a time, measured before and after.**

It is about this computer, not a repo, so it needs no repo config. macOS only: the desk-runner VM's
disk is DS-62's, and a Linux machine is out of scope (say so and stop).

## 1. Scan

```bash
bash ~/.agents/skills/desk-disk/bin/disk-scan.sh scan [--worktrees <dir>]... [--backup-volume /Volumes/<name>]
```

It only reads: it writes, moves and deletes nothing, and runs only the read forms of `docker` and
`tmutil`. It prints free space on `/System/Volumes/Data`, then one row per offender in
[`references/offenders.md`](references/offenders.md), each measured on this Mac.

- `--worktrees`: each repo's §2 Worktrees directory (`desk-env get worktrees-dir`, run inside the
  repo), once per repo the user works in. Without it the row says none were given.
- `--backup-volume`: when the Time Machine drive is the one that is full (`tmutil destinationinfo`
  names it). Its free space and backup count join the table.

`du` over hundreds of GB takes minutes: say so before running it. A `>=` size means macOS refused
part of the tree; the row says to grant the terminal Full Disk Access for the whole figure.

## 2. Report

Read [`references/offenders.md`](references/offenders.md), then report every row worth acting on,
largest first, as:

```
DISK REPORT — free <n> GB on /System/Volumes/Data   (§3b Free disk floor: <n> GB, where a repo sets it)
<#>  <offender>  <measured size>  <path>
     what it is : <from the catalogue, in plain words, with what the scan saw (counts, overcounting)>
     lost       : <nothing of yours | what is lost>
     fix        : <the exact command, or the setting the user changes> [sudo: you run it]
     restore    : <how to undo it | none>
not acted on: <report-only rows: Photos, images, containers, git-holding iCloud folders by path>
```

Rank by space freed against risk: a fix that loses nothing of the user's comes before a larger one
that loses history. Quote the catalogue's caveats where they apply: `du` overcounts APFS clones and
hard links, the build cache frees less than it claims, iCloud frees minutes later. **Never quote a
measured size as what a fix will free.**

An offender the catalogue does not hold is reported with its measured size and what it is, but no
fix until you have read what it is and told the user. A recurring one belongs in the catalogue:
offer the edit.

## 3. Carry out

**Nothing is deleted until the user picks that one item.** Approval of one fix is not approval of
the next, and "do them all" is a list of single approvals worked in the order given, each still
measured. A fix the user rejected is never run, in this step or any later batch.

For each approved fix, three calls, in order, each its own Bash call:

1. `bash ~/.agents/skills/desk-disk/bin/disk-scan.sh measure` → `free_gb=<n> local_snapshots=<n>`
2. **the one fix command, alone**: never joined to another with `&&`, `;` or a pipe, never in
   parallel with another tool call, never in the background
3. `measure` again, and report `<offender>: <before> → <after> GB free (+<delta>)`

Then stop for the next pick, or go on to the next one the user already approved.

**A fix that needs `sudo` is the user's to run.** Claude Code's `!` prefix has no terminal for the
password prompt, and neither has a Bash tool call, so hand the exact command over:

```
Run this in a normal Terminal window (not with `!` here, which cannot ask for your password):
  sudo tmutil delete -d /Volumes/<name> -t <stamp>
Tell me when it has finished and I will re-measure.
```

Take the `measure` before you hand it over and after the user says it finished.

## 4. Free space did not rise

When a fix ran but `free_gb` did not go up, check the catalogue's known reasons before looking for
a new offender:

1. `tmutil listlocalsnapshots /` (the `local_snapshots` count from `measure`): a local snapshot
   holds deleted blocks until it goes. Report it by name, with the `local-snapshots` entry's fix.
2. iCloud eviction frees in the background: re-measure after a few minutes.
3. APFS clones (Chrome's copies) and pnpm's hard links free much less than `du` showed.
4. OrbStack returns pruned space to macOS on its own, after the prune.

Say which applies. Do not start hunting a new offender to make up the number.

## iCloud folders that hold a git repository

The scan marks every top-level iCloud Drive folder that holds a `.git` within four levels. **Those
are never evicted**: the eviction skips them and the report lists each one by path, under "not
acted on".

## Gotchas

- **zsh's `log` builtin shadows macOS `log`**: call `/usr/bin/log` for the unified log.
- **Never force-eject an encrypted backup drive**: it was left locked, needing
  `diskutil apfs unlockVolume`.
- **Quote paths**: `Mobile Documents/com~apple~CloudDocs` and `Group Containers` hold spaces.
- `desk/bin/machine.mjs` reads free disk from `df -k /`, and `desk/bin/health.mjs` holds the floor
  (§3b Free disk floor (GB)). On macOS `/` is the read-only system volume; `/System/Volumes/Data`
  is where the space goes, and both report the same container's free space.

## Red flags — stop

- About to run two fixes in one command, or one fix in parallel with another call
- About to run a fix the user did not pick, or one they rejected
- About to quote a `du` total as what a fix will free
- About to evict an iCloud folder the scan marked as holding a git repository
- About to run `sudo` through the Bash tool or the `!` prefix
- About to remove a worktree by hand rather than through `desk-cleanup` (step 2)
- About to add `-a` to `docker volume prune`, or prune images
- Hunting a new offender after a fix did not free space, before checking local snapshots
