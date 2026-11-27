# Developing desk-skills

> Part of the [desk-skills docs](README.md). Back to the [main README](../../README.md).

The test suite, CI, and how the autopilot pass is structured. Read this before changing desk itself.

## The test suite

The desk-skills test suite runs against throwaway homes and repos, never yours:

```bash
bash tests/run.sh
```

It also checks every shell script's and `.mjs` file's syntax, and runs `shellcheck -S warning` on
every shell script when shellcheck is installed (it says when it is not). On macOS,
`/bin/bash tests/run.sh` tests bash 3.2. `bash tests/run.sh test_jira.sh test_gate.mjs` runs only
those suites, and `bash tests/related.sh` only the ones your branch's change reaches, chosen as CI
chooses them, uncommitted and untracked files included (every suite when that cannot be decided;
it runs as many at once as `run.sh` does without `-j`, or `DESK_TEST_JOBS` of them where that is
set). One difference from CI: an end-to-end (`L3`) suite the change reaches only through imports,
claiming no changed file directly, does not run locally; `related.sh` names it as left for CI, which
still runs it before merge. `related.sh` decides its suites, then takes a test slot (`with-lock.sh test`) before any runs, so it never runs beside the slots'
holders: while it waits the wrapper says who holds them, and after `DESK_RELATED_WAIT` seconds (an
hour by default) it exits 75 having run nothing. A run already inside a slot takes no second one.
A run whose suites' seconds in `tests/suite_durations.json` total 300 or less asks as a small run; a
suite with no record, or every suite, makes it large. Where the machine profile's `light-express-lane`
row is `on` (`desk-env machine set light-express-lane=on`; off when unset), a small run that finds
every light slot it may take held starts at once in the light lock's express lane, one slot of its own
outside `light-lock-max` (`desk-light.lock.express`), whatever the slot lease kind; its lease log grant
line says `"lane": "express"`.
`bash tests/run.sh -j 3` runs up to three suites at once, the longest
in `tests/suite_durations.json` first, each reported in one piece in name order (CI's shards do).
Without `-j` it runs as many as `desk-env get test-cap` allows, or a quarter of the cores where that
is unset; `-j 1` runs them one after another in name order. Each report gives the suite's CPU
seconds, and every finished run appends a line to `~/.desk-autopilot/test-runs.jsonl` with its
date, suites, job count, wall and CPU seconds, the load average at its start, its scope (`full` or
`changed`) and why, the worktree it ran in, the lock it ran under with the seconds it waited for
it, and how many suites `related.sh` left for CI (`left_for_ci`). Every lock wait is in the lease log (`~/.desk-autopilot/machine/leases.log.jsonl`) too: a
`queued` line as a run starts to wait, then its `grant` or `gave-up` line, each with the class, the
worktree, the seconds waited, how many other runs wait, the one-minute load average, the free memory
percentage and the compressed memory in GB (a reading that fails is left `null`). A suite that fails
runs once more: passing then, the run passes, the suite's report shows its first run's failure, and
the summary names it under `flaked:` (CI's `tests` job prints each shard's); failing again, the run
fails with both runs printed. `test_compare_pass.sh` is never retried. `run.sh` finds every `tests/test_*.sh` and `tests/test_*.mjs` itself, so a new suite
needs no edit there: give it a `# suite: <label>` line (`// suite: <label>` in `.mjs`) near the top.
A suite that reads a directory rather than naming files says so with a `# covers: <glob>` line.
`run.sh` starts every suite without the caller's `DESK_*` variables (bar CI's `DESK_REQUIRE_SHELLCHECK` and `DESK_REQUIRE_PLAYWRIGHT`)
or `DATABASE_URL` and `DIRECT_DATABASE_URL`, so a desk worker's environment cannot reach a suite.

`bash tests/compare_pass.sh <base> [<head>]` shows whether a change moved what `pass.mjs` does. It
runs the base's `tests/test_pass*.sh` against both trees (a ref or a directory each; head defaults to
`HEAD`), saves the queue and the pass's output after every pass run, and lists each queue field,
output line and suite check that differs, with times, elapsed times, ids, ports and scratch paths
left out, text the pass cut short compared up to the cut, and queue stamps (`updated_at`,
`spawned_at`, `last_start`, `cloud.started`) compared only as set or unset. It exits 0
when nothing differs, 1 when something does, and 2 when a run was not compared. With
`PASS_CMP_KEEP=1` set, a run that exits 1 or 2 leaves its recordings and both trees in its scratch
directory and prints that directory and the `compare_pass.mjs diff` command that lists them again,
in seconds and without replaying a suite. Both trees and every suite run side by side, as each pass
suite gives its stand-in workers session ids of its own (`SID_SUFFIX` in `tests/pass_setup.sh`);
`PASS_CMP_SERIAL=1`, or a base whose suites predate those ids, runs them one after the other. A base given as a
commit is replayed once: its recording is cached under `${XDG_CACHE_HOME:-~/.cache}/desk-skills/compare-pass`
(the 5 most recently used), keyed by the commit, the node, git and bash versions, the suites and
`compare_pass.sh`, `compare_pass.mjs`, `suite_env.sh` and the usage probe the recorder holds probe stamps
by, and a later comparison against it replays
only the head. A base suite that failed a check or exited non-zero (for want of a tool, or on a busy
machine) is left out of the entry and replayed on the base next time, and the comparison names the
check; a base replay that was interrupted, or in which a pass crashed, is not cached at all, and the
comparison says which suite kept it out. A directory base never is cached, and
`PASS_CMP_CACHE=0` replays both trees. `test_compare_pass.sh` replays every pass suite against itself
only on a main push and the nightly run; a pull request and a local run replay
`test_pass_other_repo.sh` alone, unless `PASS_CMP_FULL=1` opts the run in.

## How the pass is structured

`pass.mjs` moves into phase modules under `desk/bin/pass/`, one section at a time. A phase's decision
is a pure function there: it takes a snapshot (the queue's tickets and whatever else it reads, the
PR bodies it needs included) and returns actions such as `{ type: 'set', key, fields }`. It starts no
process, calls no git, gh or Jira, and writes nothing. `pass.mjs` runs it through `runPhase`
(`desk/bin/pass/run-phase.mjs`), which reads the snapshot when the phase starts and carries the
actions out in order. The `set` and `report` handlers are shared, and anything that does I/O stays in
`pass.mjs` as a handler. A decision that needs a read only some cases make (a gh call, the usage
probe), or the result of a write (the issue links it made), is a generator run by `runSteps` instead:
it yields each read or write as an action and gets the handler's answer back, so each is made only
where, and in the order, the pass made it before. Advancing running tickets and the usage limit
(`desk/bin/pass/advance.mjs`) are decided that way, one running ticket at a time, and so is the spawn
loop (`desk/bin/pass/spawn-loop.mjs`), one candidate at a time: its last action is the verdict (skip,
record-done, park, hand-away or start), and starting the worker stays in `pass.mjs`. So are failed
evidence runs on drafts (`desk/bin/pass/evidence-failures.mjs`), which yield filing a fix and starting
a run again and settle each PR on what came back, and the fix tries (`desk/bin/pass/fix-tries.mjs`),
one ready PR at a time, whose `reads` action hands fix-tries.mjs's calls the reads they make only
where they need them. Every park and
hold a pass settles (`desk/bin/pass/parks.mjs`: parks whose clears-when holds, parks waiting on the
base, person-step, date, outside and merge holds) has one decision for each point in the pass where it
runs, each called there. So is the base gate (`desk/bin/pass/base-gate.mjs`), whose last action
says whether it keeps the batch from idle. Each phase has its
own unit suite, `tests/test_pass_<phase>.mjs`; the first was crashed uploads. Each suite runs its decision under `withNoIo` (`tests/pass_phase_trap.mjs`), which
fails it on any process start or file write. Every phase's snapshot starts from `phaseSnapshot` in `desk/bin/pass/shared.mjs`:
the tickets, the time, and the pass's one session-registry read, which reads as unread (`read`
false, its session ids null) when it failed, never as a registry with no sessions. The pure helpers
more than one phase calls live in that module too (`tests/test_pass_shared.mjs`); a phase imports
them from there, never from `pass.mjs`. The batch base sync and its baseline checks
(`desk/bin/pass/batch-base.mjs`) are generators too: the sync's `synced` action hands what it settled
(the spawn hold, the base worktree, the base fix try) back to `pass.mjs` for the sections after it.

## CI

CI (`.github/workflows/`): a pull request runs, on Linux, the suites its change reaches
(`node tests/scope_sections.mjs --base origin/main` shows which, and why), plus the syntax and
shellcheck pass and a bash 3.2 check of the shell scripts involved. Test helpers and fixtures,
`install.sh` and `desk-config.md` run the suites that name them. A change that only adds exports to
`desk-env.mjs` runs the suites that use those exports. A change it cannot place runs every suite:
a file no suite names, `tests/run.sh`, `scope_sections.mjs` and the `desk/bin/untracked.mjs` and
`desk/bin/import-closure.mjs` it reads, any other change to `desk-env.mjs`, CI itself, or a deletion. `tests/related.sh`, which
decides for the working tree, leaves out the files desk itself leaves untracked there (that module's
list: a desk-ticket resume file, a desk-review run's scratch files). Every push to main runs every suite on Linux, and on macOS under `/bin/bash` 3.2 in four
shards (the `macOS` workflow, not a required check). Every run, pull requests included, uses
Node 24, the version desk runs on. The `macOS` workflow's nightly run only runs the suite when no
macOS run on main passed in the last 24 hours. While the Linux run is red, or the macOS lane is red,
cancelled or over 36 hours old, an issue labelled `ci-main-red` stays open, assigned to the repo's
owner, and `/desk-needs-you` lists it for them.

The Linux suites run in parallel `shard` jobs (`SHARDS` in `tests/plan_shards.mjs`, six), which it balances by each
suite's duration on main's latest push run (its `suite-durations` artifact), or, when none can be
fetched, the committed `tests/suite_durations.json`, and it says which. Each shard runs three suites
at once, so it plans six times three lanes; a suite with no duration is planned at the 75th percentile.
The one check named `tests` passes only when every shard and the bash 3.2 check did, and names each
failed shard's suites. To refresh the committed durations from a green run on main:
`gh run view <run id> --log | node tests/plan_shards.mjs --record`.

Every suite has a CPU-second budget in CI: 30 for a `.mjs` suite and 150 for any other, or the N of a
`# budget: N <ticket>` line (`//` in `.mjs`) in its first ten lines, which `test_lint.sh` requires to
name a ticket and caps at 600. A suite that does more on a main push than on a pull request (as
`test_compare_pass.sh` replays every pass suite there) writes `# budget: N (main M) <ticket>`: N on a
pull request, M on a main push or a local run, and the cap holds N only. A suite over its budget prints a `::warning::`; on a pull request it
fails the run from the date `BUDGETS_FAIL_FROM` in `tests/run.sh` gives. A push to main never fails on
a budget: its `record` job opens or comments one issue labelled `ci-slow` for the suites over budget,
and one labelled `ci-flaky` for those that failed and passed their retry, each assigned to the repo's
owner. Neither is `ci-main-red`.

Every suite declares its test layer in one `# layer: <layer>` line (`//` in `.mjs`) in its first ten
lines, which `test_lint.sh` requires (`node tests/scope_sections.mjs --layers` names any suite
without exactly one). `L1` is in process: its cases import modules and start no process. `L2` is one
process boundary: its cases start a desk script or command each. `L3` is end to end: it runs a pass,
a batch, the merge driver or the installer through.

## Origin

desk-skills began as a copy of studia-skills 2.3, with every company-specific fact moved into the
per-repo config. The workflow and its safety rails are unchanged, and were hardened by the review in
`docs/`. `desk-review` and `desk-kiss` are studia-web's `/pullbot` and `/kiss` made repo-generic,
and the subagents began as studia-web's. Upstream changes are checked from time to time and brought
back where they are not company-specific; the last check was 3 October 2026.
[`docs/porting-contract.md`](../porting-contract.md) records each mapping.
