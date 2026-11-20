# desk-autopilot: memory on WSL

Part of desk-autopilot, read at Stage 0b before starting the memory watch, only where config §2
"Running on WSL?" is `yes`, alongside `concurrency-and-memory.md`. It binds exactly as the core
`SKILL.md` does.

### On WSL (config §2 "Running on WSL?" = yes)

`free -h` and the guest's `MemTotal` report the `.wslconfig` grant, but VmmemWSL can only grow as far
as **Windows has free RAM**, and nothing in the guest can see that. On a 31.7GB host with ~13GB held
by Windows and a 24GB grant, the working ceiling was ~16GB, ~19GB on swap, and concurrency 4 tripped
host exhaustion within 15 minutes while guest `avail` still read 7.4GB, so the ladder alone said only
"hold". Do not alarm on Windows' own free memory: it drops under a few GB in normal use with no harm
in the guest, and throttling on it slows the batch for nothing. The signals that came before real
harm are the guest's, and `desk-env mem watch` reads them beside `avail`:

- `SWAP-GROWING`: swap used up 2 GiB or more within 10 minutes. Hold new spawns until it settles.
- `OOM-KILL`: the kernel killed a process for memory since the watch started. Drop to the ladder's
  lowest count (§3b "Spawn gate (available memory)" `drop to`), and read which process it was in
  `dmesg` before raising again.
- `TMPFS-HIGH`: `/tmp` is a tmpfs holding 4 GiB or more. Memory pressure pushes it to swap, which
  looks like a leak and is not one: see what holds it before lowering anything.
- `OOM-UNKNOWN`, once: `dmesg` cannot be read here (`kernel.dmesg_restrict`), so OOM kills go
  unwatched. Say so in the batch notes.

Before acting on an alert, split it: a large `Cached` with low `AnonPages` in `/proc/meminfo` is page
cache WSL returns lazily (`autoMemoryReclaim=gradual` in `.wslconfig` helps). If the host is low while
VmmemWSL is under the ceiling, the pressure is on the Windows side and lowering concurrency will not
fix it.
