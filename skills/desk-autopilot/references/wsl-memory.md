# desk-autopilot: memory on WSL

Part of desk-autopilot, read at Stage 0b before starting the memory watch, only where config §2
"Running on WSL?" is `yes`, alongside `concurrency-and-memory.md`. It binds exactly as the core
`SKILL.md` does.

### On WSL (config §2 "Running on WSL?" = yes)

`free -h` and the guest's `MemTotal` report the `.wslconfig` grant, but VmmemWSL can only grow as far
as **Windows has free RAM**, and nothing in the guest can see that. On a 31.7GB host with ~13GB held
by Windows and a 24GB grant, the working ceiling was ~16GB, ~19GB on swap, and concurrency 4 tripped
host exhaustion within 15 minutes while guest `avail` still read 7.4GB, so the ladder alone said only
"hold". Run a third `Monitor` on the host figure: Windows free under 3GB for 2 minutes:

```bash
powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB"
```

Before acting on an alert, split it: a large `Cached` with low `AnonPages` in `/proc/meminfo` is page
cache WSL returns lazily (`autoMemoryReclaim=gradual` in `.wslconfig` helps). If the host is low while
VmmemWSL is under the ceiling, the pressure is on the Windows side and lowering concurrency will not
fix it.
