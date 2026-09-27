<!-- Canonical resource block, folded into every worker briefing. `queue.mjs init` backs up and resets
     batch-notes.md and re-seeds this file onto it automatically; the orchestrator appends it by hand
     only if it meets a batch-notes.md with no `## MEMORY` heading. Edit here, not there.
     It is the same in every repo: each "§" is a row of the repo's config, which `desk-env where`
     locates and the worker has already read. -->

## MEMORY — mandatory

You are never alone on this machine: other autopilot workers, a second batch (possibly in another
repo), and the user's own interactive sessions share it. One worker's uncapped test run can take the
machine from 6GB to nearly 18GB on its own: a parallel runner (Jest, Vitest) defaults to `cpus - 1`
workers at ~0.7GB each, roughly 10GB from one ticket, plus a multi-GB typecheck.

**The ceiling to budget against is config §3b "Memory ceiling for parallel work (GB)"**, not what the
OS reports. On WSL (config §2 "Running on WSL?") the guest advertises the `.wslconfig` grant, but
VmmemWSL can only grow as far as the Windows host has free RAM: on the machine these rules were
measured on, ~16GB of a 24GB grant. Nothing inside the guest can see that limit.

**Cap the test runner every time. Never run the bare §4 Unit tests command.** The cap is config §3b
"Test worker cap under the test lock" (and its lower figure while available memory is in the hold
band of §3b "Spawn gate (available memory)"), appended as `--maxWorkers=<cap>` **only to a Jest or
Vitest command**; never to pytest or another runner, which rejects the flag. `with-lock.sh`
serialises suites *and* typechecks on one lock, so exactly one suite runs machine-wide at a time.
Do not raise the cap without re-reading available memory.

Each command comes from `desk-env cmds <id>` as `DIR<TAB>CMD` (`DIR` is `.` at the worktree root).
Run it in its directory with `--cwd`, never as `cd <dir> && …`:

    ~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD> --maxWorkers=<cap> [<spec files>]   # Jest / Vitest
    ~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD> [<test files>]                      # pytest, others
    ~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <integration CMD> --maxWorkers=<half the cap> <file>
    ~/.claude/desk/bin/with-lock.sh tsc  --cwd <DIR> -- <typecheck CMD>

(Each `<CMD>` with §4 Command prefix in front unless it is `none`.)

**Prefer targeted specs over the full suite.** Run the specs your diff touches while iterating and
keep the full suite for your final pass: CI runs it on every push regardless.

**Serialise every suite behind that lock.** The cap bounds one suite. It does nothing about two
workers, or a worker and an interactive session, hitting Stage 4 in the same minute, which is the
sustained-high case that takes the machine down. One lock covers the machine, across repos, batches
and sessions, for unit, integration, Playwright and headless Chromium suites. It blocks until the
lock frees and releases on exit, including on a crash. **Do not add a timeout and do not work around
a wait: waiting is the feature.** Blocked more than ~20 minutes: say so in your progress output
rather than bypassing it.

**Use `with-lock.sh`, not bare `flock`.** Bare `flock <file> -c '<cmd>'` is refused: the permission
matcher will not auto-approve a wrapper whose inner command it cannot statically verify, so the
worker silently runs the suite UNLOCKED. `with-lock.sh` is allow-listed by name, takes
a lock name (`test`, `tsc`, `browser`) and runs your command under it. It also works on macOS, which
has no `flock`. **If `with-lock.sh` is itself refused, say so explicitly** ("ran unlocked") and drop
to the lower cap. Do not spend retries proving the denial.

A typecheck is one multi-GB process (more under load). **`with-lock.sh tsc` takes the same lock as
suites**: two locks let one worker run a suite while another ran a typecheck, each correctly
believing it was serialised, and OOM-killed a full suite. Never typecheck outside it.

**Your database variables are yours or blank.** Every §4 Database URL variable in your worktree
points at your own per-ticket database, or is blank when none was made. Never fill a blank one in:
it is what keeps workers off shared, staging and production databases.

**Database-backed integration runs collide with each other, not with the dev database** (only where
§4 Local database is set). A suite that isolates by per-worker schema (keyed on the runner's pool or
worker id) and drops them at teardown means two concurrent integration runs in different worktrees
tear down each other's schemas, for the whole run, not just the test phase. The lock covers this only
if both runs took it. Before an integration run, check nobody else is in one (match the runner's
binary, e.g. for Vitest):
`ps -eo args | grep -E '[.]bin/vitest run' | grep -oE 'worktrees/[A-Za-z0-9-]+' | sort -u`.
Follow config §3 `tests-shared-db`.

**Screenshot capture uses a different lock: `with-lock.sh browser`.** A dev server plus headless
Chromium is a few hundred MB to ~1.5GB, two orders off a test fan-out, and capture uses Playwright's
own throwaway browser, so it should never queue behind a suite.

**Check headroom before any heavy stage, and read the right number:**

    desk-env mem status   # vmmem=<footprint> avail=<room to start> rss=<live>

**Gate on `avail`, never on `vmmem`.** Below ~4 GiB available, wait and retry rather than starting a
suite; a sibling mid-suite will drain. `vmmem` counts page cache, which a typecheck or lint run
inflates without consuming anything: measured at 17.7 GiB "used" with 20.2 GiB available
and ~2 GiB of real process memory. `rss` is what tells a real 15 GiB from a cache-inflated one.
Never size from `free`'s `used` column: it excludes the page cache WSL counts, and read 2.5Gi while
the host sat past 16GB. Report all three; only ever *block* on `avail`.

Do not raise the worker count because the machine looks idle. It looks idle right up until two
workers hit Stage 4 together, and an OOM kills every worker, worktree and database at once.

**Never end your turn with a background task running.** `claude -p` kills it when the turn ends,
and the ticket goes FAILED with the work half committed. Run suites in the foreground behind the lock.

## PORTS AND THE BROWSER PROFILE

Your dev-server port is assigned in your briefing; do not pick another, and never kill a server you
did not start: it is likely another session's. There is one signed-in GitHub browser profile
(config §2), so **never drive a PR image upload yourself**: print `AUTOPILOT_IMAGES:` and let the
orchestrator serialise it. Never delete a `SingletonLock` in that profile; it is a peer's upload in
flight.

## SHARED LOCAL SERVICES

Anything in §4 Local services that every session uses (a search index, a cache, a queue) is not
yours to rebuild or reset. A ticket that needs it rebuilt parks (config §3 `local-reindex`).

## REVIEW SWEEPS

A PR review task is done when the §4 Local review command's review is ON the PR, not when the fixes
are made. Post it unconditionally (clean reviews included) after the final push, then re-read the PR
to confirm it landed. `posted=yes` without having seen it is a false claim.
