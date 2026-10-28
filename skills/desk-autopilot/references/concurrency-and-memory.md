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
holds or anything bound. Where §4 Local database is set and §3 `db-per-ticket` allows, each ticket
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
over it.
