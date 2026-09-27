<!-- Canonical resource block, folded into every worker briefing. `queue.mjs init` backs up and resets
     batch-notes.md and re-seeds this file onto it automatically; the orchestrator appends it by hand
     only if it meets a batch-notes.md with no `## MEMORY` heading. Edit here, not there. -->

## MEMORY — mandatory

You are never alone on this machine: other autopilot workers, a second batch, and the user's own
interactive sessions share it. One worker's `bun run test` can take the machine from 6GB to nearly
18GB on its own: Jest defaults to `cpus - 1` parallel workers at ~0.7GB each, roughly 10GB
from one ticket, plus 2.4GB for `tsc`.

**The ceiling to budget against is config §3b "Memory ceiling for parallel work (GB)"**, not what the OS
reports. On WSL (config §2 "Running on WSL?") the guest advertises the `.wslconfig` grant, but
VmmemWSL can only grow as far as the Windows host has free RAM — on the machine these rules were
measured on, ~16GB of a 24GB grant. Nothing inside the guest can see that limit.

**Cap Jest every time. Never run the bare `bun run test`.** `--maxWorkers=4`, and `--maxWorkers=2`
while available memory is in the 4–8 GiB hold band (config §3b "Jest `--maxWorkers` cap under the
test lock"). `with-lock.sh` serialises suites *and* typechecks on one lock, so exactly one suite runs
machine-wide at a time. Do not raise it without re-reading available memory.

    ~/.claude/desk/bin/with-lock.sh test bun run --filter studia-web test -- --maxWorkers=4
    ~/.claude/desk/bin/with-lock.sh test bun run --filter studia-web test:integration -- --maxWorkers=2 specs-it/<file>.itest.ts
    ~/.claude/desk/bin/with-lock.sh tsc  bun run typecheck

**Prefer targeted specs over the full suite.** A full `test` run is 780+ suites and ~11,000 tests.
Run the specs your diff touches while iterating and keep the full suite for your final pass — CI
runs it on every push regardless.

**Serialise every suite behind that lock.** The cap bounds one suite. It does nothing about two
workers, or a worker and an interactive session, hitting Stage 4 in the same minute — which is the
sustained-high case that takes the machine down. One lock covers the machine, across batches and
sessions, for Jest, Vitest, Playwright and headless Chromium suites. It blocks until the lock frees
and releases on exit, including on a crash. **Do not add a timeout and do not work around a wait —
waiting is the feature.** Blocked more than ~20 minutes: say so in your progress output rather than
bypassing it.

**Use `with-lock.sh`, not bare `flock`.** Bare `flock <file> -c '<cmd>'` is refused: the permission
matcher will not auto-approve a wrapper whose inner command it cannot statically verify, so the
worker silently runs the suite UNLOCKED. `with-lock.sh` is allow-listed by name, takes
a lock name (`test`, `tsc`, `browser`) and runs your command under it. It also works on macOS, which
has no `flock`. **If `with-lock.sh` is itself refused, say so explicitly** — "ran unlocked" — and drop
to `--maxWorkers=2`. Do not spend retries proving the denial.

`tsc` is 2.4GB as one process (3.5GB under load). **`with-lock.sh tsc` takes the same lock as
suites** — two locks let one worker run a suite while another ran a typecheck, each correctly
believing it was serialised, and OOM-killed a full suite. Never typecheck outside it.

**Vitest integration runs collide with each other, not with the dev database.** `specs-it/` isolates
by per-worker Postgres schema keyed on `VITEST_POOL_ID` and drops them at teardown, so two
concurrent integration runs in different worktrees tear down each other's schemas — for the whole
run, not just the test phase. The lock covers this only if both runs took it. Before an integration
run, check nobody else is in one:
`ps -eo args | grep -E '[.]bin/vitest run' | grep -oE 'worktrees/[A-Za-z0-9-]+' | sort -u`.

**Screenshot capture uses a different lock — `with-lock.sh browser`.** A dev server plus headless
Chromium is a few hundred MB to ~1.5GB, two orders off a Jest fan-out, and capture uses Playwright's
own throwaway browser, so it should never queue behind a suite.

**Check headroom before any heavy stage, and read the right number:**

    node ~/.claude/desk/bin/desk-env.mjs mem status   # vmmem=<footprint> avail=<room to start> rss=<live>

**Gate on `avail`, never on `vmmem`.** Below ~4 GiB available, wait and retry rather than starting a
suite; a sibling mid-suite will drain. `vmmem` counts page cache, which a typecheck or lint run
inflates without consuming anything: measured at 17.7 GiB "used" with 20.2 GiB available
and ~2 GiB of real process memory. `rss` is what tells a real 15 GiB from a cache-inflated one.
Never size from `free`'s `used` column: it excludes the page cache WSL counts, and read 2.5Gi while
the host sat past 16GB. Report all three; only ever *block* on `avail`.

Do not raise `--maxWorkers` because the machine looks idle. It looks idle right up until two workers
hit Stage 4 together, and an OOM kills every worker, worktree and database at once.

**Never end your turn with a background task running.** `claude -p` kills it when the turn ends,
and the ticket goes FAILED with the work half committed. Run suites in the foreground behind the lock.

## PORTS AND THE BROWSER PROFILE

Your dev-server port is assigned in your briefing; do not pick another, and never kill a server you
did not start — it is likely another session's. There is one signed-in GitHub browser profile, so
**never drive a PR image upload yourself**: print `AUTOPILOT_IMAGES:` and let the orchestrator
serialise it. Never delete a `SingletonLock` in that profile; it is a peer's upload in flight.

## REVIEW SWEEPS

A PR review task is done when the pullbot comment is ON the PR, not when the fixes are made.
Post `/pullbot <n> --comment` unconditionally — clean reviews included — after the final push,
then re-read the PR to confirm it landed. `posted=yes` without having seen it is a false claim.
