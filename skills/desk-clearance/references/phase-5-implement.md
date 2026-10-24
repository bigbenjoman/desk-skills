# desk-clearance phase 5: Fan out IMPLEMENT

Read at the start of phase 5, or earlier where the core's Phases section says. The config, ownership, what config
§3 decides, the merge bar, parking and the red flags every phase shares are in `../SKILL.md`, already
loaded.

### 5. Fan out IMPLEMENT — as many as the box allows

One subagent per PR, each in its own worktree (config §2 worktrees directory), doing only the GREEN
items plus the approved AMBER ones. They fix, verify, update if behind, push, reply, resolve. **Each
one loads desk-review-response too.**

**Do not use a number from this file.** `clearance-state.mjs capacity` derives it from available
memory, cores and load; `derive` prints it too. The binding constraint is §4 Typecheck and the test
suite. If it
says 2, something else is using the box and that is worth knowing first.

**Its figure is a snapshot.** Subtract agents already running at their real cost: build ~3G,
Chromium upload ~1G, an agent told to skip the build ~0.3G. Overshooting does not queue — it takes
the box down with every running agent; one overshoot lost five mid-flight.

**Make agents cheap when they can be.** One that only replies and resolves, reports on a diff, or
uploads images needs no typecheck. Say **"do not run typecheck, lint or the test suite"** in its brief;
left to its own judgement it runs the suite to be safe.

**The ceiling is config §3b "Memory ceiling for parallel work (GB)" on every platform** (unset: 16 on
WSL, physical RAM minus 8 elsewhere), budgeted against available memory, never `free`'s "used". On
WSL the guest cannot see what Windows lets VmmemWSL grow to.

**Never run two subagents on PRs that share a source file.** The render lists every overlapping
pair. Two branches editing one spec concurrently manufacture a conflict.

You share the box with autopilot workers and interactive sessions: put every unit-test or e2e run
(§4 Unit tests, §4 E2E tests) behind `~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD>`
(each item from `desk-env cmds test-cmd`, never `cd dir && …`) with `--maxWorkers=` config §3b "Test
worker cap under the test lock" appended only to Jest and Vitest commands, never to pytest,
and browser work behind `with-lock.sh browser …` — the same locks autopilot takes. It uses `flock`
where it exists (macOS: `brew install flock`) and a crash-safe `mkdir` lock otherwise.

Screenshots: subagents capture and print `CLEARANCE_IMAGES:`; **you** upload, one PR at a time —
the shared Chromium profile cannot be used concurrently.
