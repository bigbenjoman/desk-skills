# desk-autopilot: concurrency and memory

Part of desk-autopilot, read at Stage 0b before starting the memory watch, and at the top of every
pass run in the session. Where config §2 "Running on WSL?" is `yes`, read `wsl-memory.md` with it.
It binds exactly as the core `SKILL.md` does. Where it says "above" or "below" of something this
file does not hold, or cites a section in *italics* it does not hold, that is in the core or in the
file the core's reference table names.

## Concurrency and memory

Default **2**, cap **3** (config §3b "Autopilot worker concurrency" can change either), and it is
**re-decided every pass, not set once** (a count the user set is kept while memory allows, below).
RAM binds before CPU, and the 5-hour and 7-day usage limits
are account-level, shared with the user's own sessions. Worker ports start **one above** config §3b
"Preferred dev-server port" (`AUTOPILOT_PORT_FLOOR` overrides), skipping any port another ticket
holds, a peer session claimed (`port-claims.mjs`, from its handshake), with the port lease kind on another session leases (`port-lease.mjs`), or anything bound. Where §4 Local database is set and §3 `db-per-ticket` allows, each ticket
gets its own database; otherwise every §4 Database URL variable in its worktree is blanked, and a
ticket that needs a database parks. Shared local services (§4 Local services: a search index, a cache) cannot be
isolated, so workers park rather than rebuild them.

Count a worker at ~0.5GB idle and ~3GB in its heavy stages (typecheck, lint and specs in its own
worktree, plus a dev server if it takes screenshots) and an uncapped parallel test fan-out at ~10GB.
Budget against config §3b "Memory ceiling for parallel work (GB)", never against what the OS
advertises.

**Two numbers, two questions. Using the wrong one has thrown a batch in both directions:**

| Question | Read |
|---|---|
| How big has the footprint grown? | `vmmem`: Linux `MemTotal - MemFree`; macOS total minus free pages |
| Is there room to start something? | `avail`: Linux `MemAvailable`; macOS free + inactive + purgeable |

`desk-env mem status` prints both plus total process RSS. They diverge badly (by several GiB at the
same instant) so **gate a spawn and the sustained-high watch on `avail`**, and report `vmmem` as the
footprint, using RSS to tell live work from page cache. Never alert on `vmmem`: it counts page
cache, so on macOS it sits over the §3b ceiling while tens of GiB are free to start work. `free`'s
`used` column is a third number, wrong for both: it excludes page cache.

**Spikes are fine. Sustained is the problem.** A test fan-out at the ceiling for ninety seconds is
the system working; `avail` under the reclaim band held five minutes or more with no suite or
typecheck running to explain it is what destabilises the machine. Do not throttle on a spike: over-caution that slows the
batch is a failure too.

**The ladder, read at the top of every pass** (config §3b "Spawn gate (available memory)" can move
the bands):

| `avail` | Do |
|---|---|
| > 8 GiB | a count the user set (`concurrency_by` is `user`): keep that number. Otherwise use the §3b default, going one higher, up to the cap, only after a slot sat idle a whole pass |
| 4–8 GiB | hold: finish what is running, spawn nothing new this pass |
| < 4 GiB | drop to 1 (`set-batch concurrency=1`, and leave `concurrency_by` as it is); a worker mid-suite will drain, so wait a pass before touching anything |
| < 2 GiB **and** sustained | reclaim (where §3 `autopilot-reclaim` is `yes`): kill an orphaned dev server or a stale typecheck first, never a worker mid-commit, never a process another session owns |

Lowering is silent but **reported**: say which number caused it. Raising back needs the same
evidence. The ladder is what the "machine looks idle" red flag guards: a fan-out sized from the
guest figure can take the whole VM down and kill every agent mid-flight.
An OOM leaves a worker's worktree, database and port behind.

**Only `avail` lowers the count.** The pass report's `memory ceiling` line is the footprint budget,
and on WSL its figure counts page cache; neither it nor `vmmem` is a reason to set a lower
`concurrency`. The `workers:` line says "lowered on memory" only while `avail` is under the ladder's
line; a count below the user's with `avail` above it reads "memory did not lower it", and goes back
to the user's number.

**The test lock's queue holds spawns too, by each repo's share.** Each pass counts the runs waiting on
the test lock machine-wide (`with-lock.sh test` and `tsc`, from every repo and session), and the runs
holding or waiting by repo: a run is a repo's when it works in that repo's main checkout or worktrees
directory, and runs in no configured repo count as one, `other`. Repos are named as desk-q names them,
so two of one name under different owners are two. A repo whose §4 Suite weight is light is read
against the light lock's queue (`with-lock.sh light`) as well, each queue against its own hold point,
and the tighter binds; a heavy repo is never held by the light queue. A pool's hold point is its
current slots (its floor plus the runs headroom admission let in above it) × `test-lock-queue-factor` (1 × 2 with no profile).
The light floor is §3b "Light lock slots" (else the machine profile's `light-lock-slots`, else 1), 1
while available memory is under the spawn gate's start. With `lock-admission` on, the light ceiling
is the larger of it and `light-lock-max`, and runs above the floor come only through an admit. A new worker, which
starts at triage, takes none of a queue's room, as its first suite is counted when it reaches one; it
is held only while the test lock's queue already has no room for this repo. At or over the hold, each repo with a
run on the lock, this one always counted, gets a share of ceil(hold / active repos), and the pass starts
at most its share less its own runs; below it, at most the hold less the runs waiting. That room covers
fix tries, handoffs to 4b, resumes of a worker or a requeued round last at Stage 4
or 4b, and a base try (conflict fix, epic review, promotion checks), which takes its unit first; the
ones past it are held, and the STALLED line names the queue depth, each repo's runs and the share. A
resume at any other stage goes ahead. So
one busy repo's queue holds that repo, not every other. Where ps cannot be read, the pass starts workers
as it would without the gate, and says the queue was not read; where the runs' working directories
cannot be read, a deep queue holds every repo.

**A worker count the user set is theirs.** When the user names a count (or 0 to pause new spawns),
record it as theirs with `set-batch concurrency=<n> concurrency_by=user`; the queue keeps their
number as `concurrency_user`, and the pass report's `workers:` line says whose the count is. While
memory is above the gate it wins over the §3b default: never pull it back to the default. Memory
still lowers it: lower with `set-batch concurrency=<n>` alone and leave `concurrency_by` as it is.
When raising back, return to the user's number (`concurrency_user`, which the `workers:` line
names), not to the §3b default. `set-batch concurrency_by=null` hands the count back to the ladder.

**Borrowing idle workers is config §3b "Borrow idle workers"**, `off` unless it is `on`. At `on`,
a pass may start workers above the batch's own number, up to the §3b cap, into machine slots that
other live batches are not using. The machine total comes from the machine profile's
`autopilot-concurrency` cap, less the running workers in every queue. The batch takes those free
slots for its own number first, then borrows what is left after each other live batch below its own
number has its first claim (as many as it has ready tickets for). It reads every queue and writes
only its own. Counting and starting happen under one lock shared by every repo, so two passes cannot
take the same slot. Running work is never stopped: when the lender has ready tickets again, the
borrower starts nothing new, and a lender with borrowing on that comes back to a full machine starts
its own as the borrowed workers finish. The memory gate still stops everything. A `borrowing:` line
under `workers:` says how many were borrowed, or why none were: a first claim, a full machine, the
cap, the gate. Where the slots cannot be counted (another repo's queue unreadable, no machine
profile, the lock held past two minutes), the batch starts up to its own number as with borrowing
off, and the line says why. Borrowed workers are not a reason to lower the count: the ladder leaves
the batch's own number as it is.

**The machine budget weighs workers by their repo's memory, not only counts them.** Where the
machine profile sets `memory-ceiling-gb` beside its `autopilot-concurrency` cap, each running worker
in every queue counts its repo's config §3b "Worker memory weight (GB)" (`desk-env get
worker-memory`) against that ceiling, and a pass starts one of its own only while the weights leave
room for it. The cap still holds as a backstop. A repo with no weight set weighs the flat share, the
ceiling over the cap (5 on a 15 GB, 3-worker machine), so it behaves as before. So with a 15 GB
ceiling and a cap of 4, two workers of a repo weighted 5 and two weighted 2 run (14 GB), and a third
at 5 beside one at 2 (17 GB) does not. The report's `machine budget:` line gives the GB in use, and
desk-q's machine line shows it against the ceiling, with the room left for a light repo's worker
where a heavy one no longer fits.

**Tickets that name one file share it up to a per-file budget**, config §3b "Per-file collision
budget" (`desk-env get file-budget`). Unset, it is `3 over 1000 lines, else 2; serial: none`: up to
three tickets whose triage records name a file longer than 1,000 lines on the batch base run at
once, two for any other file, and one for any file the `serial:` globs name, whatever its length. A
bare `1` restores one at a time everywhere. A file the test globs cover (`*.test.*`, `*.spec.*`,
`test/`, `tests/`) has no limit and, like a §4 Append-only path, is no collision when a batch is
planned: tickets add cases to it, and the conflict-fix worker settles the rare conflict. A pass works the budget out at spawn time from the triage
records of the tickets running then in every batch of the repo, its own and the others, so a
finished ticket holds nothing, and a ready ticket with any file at its budget waits, in queue order.
The report's `held back by a collision:` line names each such file and the running tickets filling
it, each one from another batch as `<ticket> in batch <name>` (or `in the standing batch`). Another
batch's queue that does not read counts nothing, and a `collisions:` line names it as not checked. A
row that does not read is 1 for every file, and the report says so.

**A file whose merge-time conflicts rise runs fewer at once, on its own.** Each time a pass meets a
ready PR in conflict with its base, or a base sync that stops on one, it records one entry per
conflicting file (the file, the ticket, the PR and the time) in `conflicts.jsonl` in the repo's
state folder (`desk-env paths` prints `DESK_STATE`), which every batch shares. Three conflicts on a
file within 7 days run it one place fewer than its configured budget, and each 7 days with none
gives one back, never above the configured budget nor below 1. The report's `collisions:` lines
name each lowered file and its conflicts in the last 7 days. A record that does not read lowers
nothing: every file runs at its configured budget, and the report says the record was not read.

**Run the watch yourself: do not hand it back to the user.** Two `Monitor`s for the life of the
batch: the status watch (`node ~/.claude/desk/bin/queue.mjs watch`), which prints the table and the
memory line (`vmmem=`, `avail=`) at start, then again only when a ticket's state or question
changes (a stage step alone does not wake you; `--stages` restores it), checking every 90 seconds (`--interval <s>` to change it), or at §3b "Orchestrator status table" `quiet` one line
per ticket that changed (*The status table*); and a sustained-high watch (`desk-env mem watch`) that
fires only on `avail` below the ladder's lowest band (2 GiB, or a lower band the §3b row names) held
5 minutes with nothing heavy running to explain it. Run each under `Monitor` exactly as written:
never write a shell loop around `render` and `mem status` instead, which Claude Code prompts on every
time. Both keep their state in the process, so re-arm one when its `Monitor` expires. Killing a
runaway process is a call to make from the monitor, not a park.

**The watch also reads the signals that came before real harm**, beside `avail`, each said once
until it clears. The thresholds are §3b rows (`desk-env get harm-swap-growth`, `desk-env get
harm-tmpfs`, `desk-env get harm-vmmem`); unset, they are the figures below:

- `SWAP-GROWING` (Linux): swap used up 2 GiB or more within 10 minutes. Hold new spawns until it
  settles.
- `OOM-KILL` (Linux): the kernel killed a process for memory since the watch started; the line names
  it. Drop to the ladder's lowest count (§3b "Spawn gate (available memory)" `drop to`) before
  raising again.
- `WORKER-OOM`: a worker's log, since the watch started, shows Node's `JavaScript heap out of memory`
  or a command killed with exit 137; the line names the ticket. Drop to the ladder's lowest count.
- `TMPFS-HIGH` (Linux): `/tmp` is a tmpfs holding 2 GiB or more. Memory pressure pushes it to swap,
  which looks like a leak and is not one: see what holds it before lowering anything. While it holds,
  each pass names the largest entries in `/tmp` and clears the regenerable caches no process has open
  (`jest_*`, `node-compile-cache`, `v8-compile-cache-*`, turbo and vite caches, and `cdk.out*` unchanged
  for an hour), saying what it freed. It holds spawns only while `/tmp` is still over the line, and then
  one needs-you ask names what is left. Workers keep these caches out of `/tmp` to begin with: their
  Node compile cache, Jest cache and test runs' temporary folders sit in `DESK_CACHE_DIR`, on disk.
- `VMMEM-HIGH` (WSL): the VM holds 90% or more of its `.wslconfig` grant, past which it can only
  swap. Hold new spawns until it falls.
- `OOM-UNKNOWN`, once: `dmesg` cannot be read here (`kernel.dmesg_restrict`), so OOM kills go
  unwatched. Say so in the batch notes; the watch keeps reading the rest.

Each harm line is also written, with its time, to `mem-harm.json` in the batch's state folder, and
with the mem lease kind `shadow` or `on` (`desk-env lease mode mem`) every pass holds new spawns
while a signal there was said, or still stood, within the last 10 minutes, naming it in its report;
running workers carry on. So the hold does not wait on you, but it needs the watch running. With the
kind `off` the pass reads no harm signal and judges memory by the ladder alone. Say which line moved
the count when you lower it. On macOS only `WORKER-OOM` is read.

**Memory is reserved from the machine's ceiling as leases**, where the machine profile sets
`memory-ceiling-gb`. Each worker a pass starts reserves its repo's weight, §3b "Worker memory weight
(GB)", or where that is unset its share (that ceiling over the profile's
`autopilot-concurrency` cap, or over the cap of §3b "Autopilot worker concurrency" where the profile
sets none, at least 1 GiB), held by the worker's process and returned when it
exits. Before a heavy run of your own (a full suite, a build), reserve for it so every pass counts
it: `desk-env lease acquire mem <what for> --units <GiB> --owner claude --ttl <seconds>`, which
your session holds until it exits or twice the TTL passes unrenewed, and `desk-env lease release <id> --pid <the owner pid desk-env
lease list shows>` once the run ends. With the kind `on`, a pass starts no worker whose share does not
fit beside what is reserved, naming the ceiling, the reserved total and the largest holders; in
`shadow` it starts by the rules above and the lease log records each would-refuse; `off` reserves
nothing. The avail ladder still applies beside it, and the stricter decides.

**Waiting on one PR is a watch command too.** Under `Monitor`, run
`node ~/.claude/desk/bin/pr-watch.mjs checks <n>` (one line once every check on the head has
completed, naming each failed one), `pr-watch.mjs head <n> <sha>` (one line with the new sha once
the head moves off `<sha>`) or `pr-watch.mjs merged <n>` (one line once it merges or closes). Each
exits after its line, so `checks` and `head` also end on a PR that merges or closes, and a PR that
cannot be read prints its error once and exits non-zero. Like the queue's watch, each is one plain
command the `autopilot-workers` rules allow, so starting it never prompts. Never wrap a loop around
`queue.mjs render`, `gh pr checks` or `gh pr view` instead: `queue.mjs watch` is the queue's wait
and these are a PR's.

**Test runners ignore the cap unless it is on the command line**, so seed the worker-count flag
(`--maxWorkers=<cap>`, appended **only** to a Jest or Vitest command; never to pytest or another
runner, which rejects it) into `batch-notes.md` (the header does) and `SendMessage` any worker seen
over it. Under the test lock, `with-lock.sh` adds it itself to a Jest the command starts, directly or
through a package.json script, and `--concurrency=<turbo-concurrency>` to a `turbo run` (the machine
profile's row, 1 on WSL where it is unset), unless the command sets its own. Dependency installs
take `with-lock.sh install`, one at a time machine-wide.
