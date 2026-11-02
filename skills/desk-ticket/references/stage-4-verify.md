# desk-ticket Stage 4: Verify

Read at the start of Stage 4, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded;
a "below" here that this file does not hold points there.

| # | Stage | What happens |
|---|---|---|
| 4 | Verify | `desk-dev` for the environment. §4 Typecheck (`desk-env cmds typecheck-cmd`), §4 Lint (`desk-env cmds lint-cmd`; its fixing form if the row gives one), §4 Unit tests (`desk-env cmds test-cmd`) and the knowledge check where the repo has one; a §4 Build (`desk-env cmds build-cmd`) only when the change needs one (below). Add a spec that guards the fix. A claim the knowledge check reports as changed gets written back in this branch (below). Then run the docs check from `desk-pr` §1 and **report** what it finds: a hit is sometimes a stale comment in the source rather than a page edit, and that is far cheaper to learn here than at Stage 7. Report only; rewriting a page is the user's call. |

**Build only when the change needs it (Stage 4).** CI builds every PR. Run §4 Build locally when the
change touches what typecheck, lint and unit tests cannot see: framework or bundler config,
dependencies, middleware or request proxies, route-level config (static generation, metadata
exports), or a client/server module boundary. A framework build usually runs its own type-check, so
take the `tsc` lock:

```bash
~/.claude/desk/bin/with-lock.sh tsc --cwd <DIR> -- <CMD>     # each DIR<TAB>CMD from `desk-env cmds build-cmd`
```

**Keep the knowledge base true (Stage 4).** Where the repo has a knowledge check, CI usually runs it
too. A reported claim whose code changed is the trigger to write back: update the claim in this
branch, the way the repo's instructions say to, so the update ships in the same diff and Stage 4b
reviews it. A domain whose shape changed needs a larger rewrite; propose that rather than doing it.

**Running the suites (Stage 4).** A parallel test runner (Jest, Vitest and most others) sizes
itself at `cpus - 1` workers by default, with no awareness of any other run. A large suite at that
width holds several GB resident, so two at once oversubscribe both RAM and CPU and each finishes
slower than if you had simply waited.

**Cap it and lock it, every time** (the cap is config §3b "Test worker cap under the test lock", `desk-env get test-cap`).
§4 Unit tests holds one backtick span per suite, and a suite may name its directory
(`` `apps/api: uv run pytest` ``); `desk-env cmds test-cmd` prints each as `DIR<TAB>CMD` (`DIR` is
`.` at the root). Run each in its directory with `--cwd`, never as `cd <dir> && …`, and append the
cap as `--maxWorkers=<cap>` **only to a Jest or Vitest command**, in the form §4 Unit tests gives for
passing arguments; pytest and other runners reject the flag:

```bash
~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD> --maxWorkers=<cap>   # Jest / Vitest
~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD>                       # pytest and others
```

`with-lock.sh` (installed by `install.sh`) serialises you against every other session and every
autopilot worker on the machine, in every repo: they take the same `test` lock under `DESK_LOCK_DIR`
(default `/tmp`), and it releases on exit, including on a crash. It blocks rather than fails, and
that wait is the feature. **Do not add a timeout, and do not run two at a percentage cap instead.**
It uses `flock` where it exists (macOS: `brew install flock`) and otherwise a `mkdir` lock that
takes over from a dead holder. Do not hand-roll a lock of your own.

A typecheck is often a single multi-GB process; take the same lock for it
(`with-lock.sh tsc --cwd <DIR> -- <CMD>` for each item of `desk-env cmds typecheck-cmd`) rather than running typecheck and a suite together. Screenshot
and Playwright capture uses a separate lock, `with-lock.sh browser …`, so it does not queue behind a
suite it was never competing with. To see what is holding things:

```bash
desk-env heavy       # suites, typechecks, dev servers actually running (never pgrep -f)
desk-env mem avail   # room to start something, in GiB; under ~4, wait
```

If config §2 "Running on WSL?" is `yes`, the practical ceiling is lower than the guest reports:
the Windows host runs out of RAM for VmmemWSL around config §3b "Memory ceiling for parallel work
(GB)" (`desk-env get memory-ceiling`) whatever `free` says, which is why the cap is a fixed worker count rather than a percentage.

**Database-backed suites: never two at once against the same database.** Suites that isolate by
per-worker schema tear down each other's schemas. Which suites touch a database is in §4 Unit tests,
§4 E2E tests (`desk-env cmds e2e-cmd`) and §4 Local database (`desk-env get local-db`); with §4 Local database `none`, this does not arise. The test lock
does not cover every runner reliably, so check for another worktree's run first (match the runner's
binary in `ps -eo args`, e.g. `grep -E '[.]bin/vitest run'`) and follow config §3 `tests-shared-db`.
