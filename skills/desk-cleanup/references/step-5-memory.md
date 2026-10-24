# desk-cleanup step 5: Memory

Read at the start of step 5. The config, ownership, the order, the precondition, what is never touched, the confirmation and the red flags every step shares are in
`../SKILL.md`, already loaded.

## 5. Memory — usually the largest reclaimable thing on the box

The disk win is worktrees. The RAM win is almost always **one leaked dev server**, and the report
has to price it or a full run ends with the machine still several GB down. Measure with
`cleanup-scan.mjs memory`, which reads the reference's memory table, process list, port owners and
`docker stats` in one pass, and maps each process to its worktree (`GONE:` means its worktree was
removed under it). Pass `--ports` as the §3b Preferred dev-server port and the range above it that
autopilot workers take, plus every port §4 Local services and §4 Dev server name (for example
`3500-3600,6006`).

Baselines, measured on one machine running a large Next.js monorepo — re-measure for this repo's
§4 Dev server and test runners before treating any figure as a threshold:

| Process | Normal | Leak signal |
|---|---|---|
| a `next dev` server | ~1.5 GB | **>2.5 GB**, or sustained CPU with nobody driving it |
| a component explorer dev server | ~700 MB | >1.5 GB |
| one `claude` session | 350-450 MB | — |
| its MCP servers | ~300 MB per session | — |
| Docker (§4 Local database and §4 Local services containers) | ~140 MB total for a database, a search index and a mail catcher | never the problem |
| a Jest full suite | one worker per core, ~6.5 GB, gone in **~30 s** | transient — never a leak |
| a Vitest full suite | ~4.5 GB peak, gone in **~85 s** | transient |
| `watchman` (Jest's file watcher) | a few hundred MB | **>2 GB**; 6.6 GB seen with only two roots watched |

**Watchman grows with no owner and no session in sight.** It is not a dev server and runs in no
worktree, so no other check here finds it; the memory scan reports it with its size and its watched
roots. Above 2 GB, propose `watchman shutdown-server` in the plan under §3 `server-stop`. It restarts
on the next Jest run and loses nothing, but **not while a test run is in flight**. A watched root
whose directory is gone gets `watchman watch-del <root>`; `remove` already does this for what it
removes.

**A test suite in flight looks exactly like a leak — measure twice before naming one.** 11 GiB used
can be the Jest suite, exiting 40 seconds later. Check for a run in flight with the
reference's `node`-executable match, **not** a bare `pgrep -f` count — even the bracketed
`pgrep -f '[j]est-worker'` self-matches inside Claude Code's `bash -c` wrapper — and re-read memory
after it clears. Report the delta, not the RSS sum.

**A hung Vitest is the inverse tell, and the one genuinely worth stopping.** It collapses to a
*single* node process pinned at 100% CPU whose heap climbs ~6 MB/s without bound. Many workers,
large, brief → a suite doing its job. One process, 100% CPU, monotonic growth → the hang. Confirm
nobody is mid-measurement, then propose stopping it.

A dev server at **~6 GB after an hour** of HMR is a leak, not a workload. And each concurrent session
costs ~300 MB in duplicate MCP servers before it does any work, so "close a session" is occasionally
the honest answer.

**Trace the owner before proposing anything** — walk the parent chain (reference) from the server up
to the owning `claude` pid.

**The test is whether the ticket is still being worked on — not whether its PR is open.** An open PR
is the normal resting state of finished work, so treating it as protection means no server is ever
reclaimable. A server comes back with one §4 Dev server command; a session mid-flight does not.

| Signal in the worktree | Reading |
|---|---|
| modified tracked files, or a stash | **in flight** — leave it |
| a live `claude` process with its cwd inside the worktree (autopilot workers included) | **in flight** — leave it |
| resume-file `stage` not `complete`, or a `pendingGate` set | **in flight** — leave it |
| commits not pushed to `origin/<branch>` | **in flight** — leave it |
| clean tree, pushed, resume `stage: complete`, PR open | **finished** — stopping is fine |
| ticket in §4 Done state, or PR merged/closed | **finished** — stopping is fine |

Any "in flight" row wins over any "finished" row. When nothing distinguishes them, ask.

Then:

- **Stop by pid, never `pkill node`.** `pkill` is indiscriminate and takes a session's own tooling
  with it. `SIGTERM` the specific pids; escalate to `-9` only if one survives.
- **Where the work is in flight and the server has genuinely leaked, restart on the recorded port**
  (`dev_server_port` in the resume file). If the port can't be reused, update it there and say so.
- **It goes in the plan awaiting approval** in either case (config §3 `server-stop`; `no` means report
  it only). A server inside a worktree being removed
  dies with it, and approving the removal covers that.
- **Say what is lost** — a warm server, back with §4 Dev server in that worktree. Once.

**Swap is a signal, not a target.** Heavy swap alongside plenty of free RAM means something leaked
earlier, or — on Linux/WSL with a tmpfs `/tmp` — regenerable caches (test-runner and Node compile
caches) whose swapped pages belong to no process. The reference shows how to tell the two apart;
the caches may go in the plan as `[delete]`. Never propose `swapoff`: it needs root and forces cold
pages back into RAM for nothing.
