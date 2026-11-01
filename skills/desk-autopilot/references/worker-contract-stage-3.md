# Autopilot worker contract: Stage 3, implement

Part of the autopilot worker contract, read when you reach Stage 3 (or earlier, as the core says).
It binds exactly as the core does.

**The design skills are files too.** When `desk-ticket` Stage 3 loads `ux-designer`, `ui-designer`
and `ux-copywriter` for a ticket that renders UI, Read `$DESK_SKILLS_DIR/ux-designer/SKILL.md`,
`$DESK_SKILLS_DIR/ui-designer/SKILL.md` and `$DESK_SKILLS_DIR/ux-copywriter/SKILL.md` before the
first UI edit, and the references each one routes you to, then apply them as an interactive session
would. `ui-designer` runs against `desk-env list design-system`. A missing file is not a park: build
without it and name it in `AUTOPILOT_DONE` and the PR's Testing.

**A lane D ticket builds from its saved canvas, and does not stop for agreement.** `plan-batch` runs
lane D only when every Claude Design canvas the ticket's Design section links is saved under §2
Design canvases directory on your base, or snapshotted in `$DESK_STATE/designs/` (save it on your
branch first, `desk-ticket`'s `design-canvas.md`). Follow `desk-ticket-routing.md` Lane D as a repo
with no design-build agent does: build it in this session from the saved boards, with the design
skills above, and leave out its "D still stops for agreement first". The agreement moves to the PR
review: for each board the ticket names, the PR body holds the board's render and the built screen
at that board's width, with every difference you accepted listed under it (`desk-pr`'s
`references/screenshots.md`, "A ticket with a saved canvas"). Capturing the built screens needs §3
`worker-screenshots`; where it is not `yes`, build and push, then park naming that row with the
rest of the tail (section 6). A design you find is only in Figma, or a canvas not on your base,
parks as a demotion to D does (core section 2).

## 6. Command forms that are silently denied

Permission rules match the string you write, not the file it resolves to. Prefer the plain form:

Your settings are an **allow-list**: anything not named here is refused.

- `desk-jira …`, `desk-env …`: plain names; no `VAR=value` prefix on anything.
- **The §4 toolchain rows, exactly as configured.** An item at the root (`DIR` `.`) runs bare, with
  your own arguments after it, or through with-lock.sh with `--cwd .`. An item with a directory has no bare form (you cannot `cd`), so it
  runs as `~/.claude/desk/bin/with-lock.sh <lock> --cwd <DIR> -- <CMD> [args]`, where `<lock>` is
  `test` for §4 Unit tests and Integration tests, `tsc` for §4 Typecheck, `browser` for §4 E2E
  tests, and `nolock` for everything else (lint, build, codegen, dev server), which only changes
  directory. §4 Codegen (e.g. `pnpm prisma generate`) is how you regenerate code; with no such row,
  a ticket that needs a regeneration parks naming the command. Each row's items come from
  `desk-env cmds test-cmd`, `desk-env cmds integration-cmd`, `desk-env cmds typecheck-cmd`,
  `desk-env cmds e2e-cmd`, `desk-env cmds lint-cmd`, `desk-env cmds build-cmd`,
  `desk-env cmds codegen-cmd` and `desk-env cmds dev-cmd`. Each §4 Pre-push checks item
  (`desk-env cmds pre-push-checks`) runs the same way, one at a time, as well as through the pre-push script.
  An environment prefix (`PORT=3008 <§4 Dev server>`) is refused; pass the port as an argument in
  whatever form the §4 Dev server row gives (e.g. `-- --port 3008`).
- **The package manager** (`desk-env get package-manager`): only `<§4 Package manager> install` with no arguments, `<bin> --version`,
  and the configured rows. Its add and sync forms (`pnpm add <pkg>`, `uv add <pkg>`, `uv sync`)
  only where §3 `worker-dependency-install` is `yes`, and never global, another directory or a `..`
  path; otherwise a ticket that needs a new dependency parks naming the row. `remove`, the one-off
  runners (`npx`, `npm exec`/`x`, `pnpm exec`/`dlx`, `yarn dlx`, `bunx`, `uvx`) and the §4 Command
  prefix (`desk-env get command-prefix`) run on its own (`<prefix> <anything>`) are refused. Run a TS script
  with the worktree's installed runner, e.g. `node <worktree>/node_modules/tsx/dist/cli.mjs <file>.ts`.
- **Screenshot capture**, only where §3 `worker-screenshots` is `yes`, and only under the browser
  lock from your worktree: `~/.claude/desk/bin/with-lock.sh browser` then `node ./<script>` or
  `node <worktree>/<script>` (a capture script at the root, or Playwright under `node_modules/`),
  `./node_modules/.bin/<playwright|storybook|test-storybook|storycap> …`, or
  `<python|python3|uv run python|.venv/bin/python> ./<script>.py`. Never a `..`. Otherwise parks
  naming the row.
- **Local services**: only where §3 `worker-local-services` is `yes`, and only
  `docker compose -f <main checkout>/<its compose file> [-f <its override file>] up -d --no-recreate
  --no-deps <service>` for a service §4 Local services (`desk-env list local-services`) names: the shared project, never one named
  after your worktree (`docker-compose` takes the same form). Nothing is allowed where the main
  checkout's `.env` sets `COMPOSE_FILE`. `docker compose down`, `rm`, `run`, `docker rm` and
  `docker run` are refused.
- **WebSearch and WebFetch**, only where §3 `worker-web-read` is `yes`: a public fact the ticket
  needs is looked up, with the page named in the PR, rather than parked. Otherwise parks naming the
  row.
- **`git reset`**: `--soft`, `--mixed` and on paths are allowed in your worktree; `--hard` and
  `--merge` are refused (`git restore` and `git checkout -- <path>` undo a file).
- **`git push`: only these exact commands** for your own recorded branch: `git push origin <branch>`,
  `git push -u origin <branch>`, `git push --set-upstream origin <branch>`, and, only where §3
  `git-force-with-lease` is `yes`, `git push --force-with-lease origin <branch>`. Bare `git push`,
  `git push origin HEAD` and any other ref are refused. `git config`, `git -c …`, `git -C` with
  any path but your own worktree's, aliases and `git stash` are refused; `git -C <your worktree>`
  (as given, or its real path) takes the read and local-write subcommands (`add`, `commit`,
  `restore`, …) under the same refusals, and never `push`. `git rm` and `git mv` are allowed for tracked files in your
  worktree. A lint or format tool (eslint, prettier, biome, oxlint, stylelint, tsx, `prisma generate`)
  runs as `./node_modules/.bin/<tool>`, never with `..`; suites, typechecks and migrations run only
  as their §4 rows.
- **A force-push the person approved once**: where your prompt names one, exactly
  `git push --force-with-lease=<branch>:<sha> origin <branch>` as written there, and no other form.
  It works only while origin's branch is still at that SHA. `git rebase origin/<default>` is allowed
  only while your branch is not on origin, or §3 `git-force-with-lease` is `yes`; otherwise bring the
  base in with `git merge origin/<default>`.
- **`gh`**: reads (`pr view`, `pr list`, `pr checks`, `pr diff`, `run view`, `run list`,
  `issue view`, `repo view`), and only where §3 grants them `gh pr create --draft …` (it must begin
  exactly `gh pr create --draft` or `gh pr create --repo <§0 GitHub repo> --draft`), `pr edit`,
  `pr review` (commented only), `pr comment`, `pr update-branch`, `run rerun`. **`gh api` is refused
  in every form**, and `gh alias` too: read reviews with `gh pr view <n> --json reviews,comments`,
  and answer a review thread with a `gh pr comment` naming it (§3 `pr-reply`); resolving threads is
  the orchestrator's. A read those do not cover (a GraphQL query, a REST GET) goes through
  `desk-gh read <endpoint> [gh api flags]`, e.g. `desk-gh read graphql -f query='{ viewer { login } }'`:
  it refuses a mutation, any method but GET, `--input`, a field read from a file and any unknown flag
  (exit 1). A REST field needs `-X GET`.
- **`gh workflow run`**, only where §3 `worker-workflow-dispatch` is `yes`, and only exactly as
  §4 Worker workflows (`desk-env list worker-workflows`) lists each entry: `gh workflow run <file>.yml --ref <your branch> -f …` (or
  with `--repo <§0 GitHub repo>` after the file), no input added or changed. Any other workflow, ref
  or input is refused; so is `gh workflow enable`/`disable`. Once it starts, read the run's id with
  `gh run list --workflow <file>.yml --branch <your branch> --limit 1 --json databaseId,status`,
  then park on it with `AUTOPILOT_PARK_CLEARS_WHEN: run <id> completed`: you cannot wait, and the
  first pass after the run finishes requeues you with its conclusion. Otherwise park naming the row.
  Which entry you start, and the line on why in that park, follow the Stage 4 file's "A CI or
  end-to-end run you ask for is the narrowest one that covers your change": read it first.
- **`codex`**: only `codex exec --sandbox read-only …` and `codex --version`, where §3 `codex-review`
  is `yes`.
- **Reading tools**: `rg`, `grep`, `find` (without `-exec`/`-delete`), `ls`, `cat`, `head`, `tail`,
  `wc`, `diff`, `jq`, `tr`, `cut`, `stat`, `du`, `file`, `mkdir`, `ps`, `pgrep`, and `echo`,
  `printf` and `true` to stdout. **Not** `sed`,
  `awk`, `cp`, `mv`, `sort`, `uniq`, `xargs` or `tee`: edit files with Edit/Write.
- **psql**, only where you have a per-ticket database, only as
  `docker exec [-i] <container> psql [-U postgres] -d <your database>`.
- No `$( )` substitution, no output redirection (`> file`), no loops in a command that must succeed
- `rm` is denied: `git clean -f <paths>` (or `-fdx` for directories) removes scratch files and proves the tree is clean
- `curl` is denied: drive a page with Playwright rather than probing it over HTTP
- Scratch scripts go at the worktree root and get `git clean`ed; `/tmp` is readable, not writable
- **Files outside your worktree**: you may write only `$DESK_STATE/parks/<TICKET>.json` (your park
  record, `{"question": "<one line>"}`) and `$DESK_STATE/images/<TICKET>/**` (your screenshots).
  Everything else in the state directory (answers, briefings, the queue, locks, other workers'
  files, your own settings) is read-only to you
- **And your handoff briefing**, `$DESK_STATE/handoffs/<TICKET>.json`, written when you hand off
  (the Stage 4 file's "Handing off")
- **And your resume file**, `$DESK_STATE/resume/<TICKET>.json`, in place of the
  `.claude/desk-ticket-<TICKET>.json` `desk-ticket` names: your worktree's `.claude/` is
  write-protected

If something is refused, try the plain form once before concluding you lack the capability.

**Some refusals no setting unlocks.** The harness or the launcher enforces these whatever §3, an
allow rule or a settings change says:

- a write under your worktree's `.claude/`: the harness write-protects it for a headless worker,
  though your settings allow edits across the worktree;
- a write granted only by a `Write(...)` rule: the harness ignores those and reads `Edit(...)` rules;
- anything in the user's own settings: you are launched with `--setting-sources ""`, so none reach you;
- `gh api`, in any form (`desk-gh read` is the read-only way in).

When your ticket needs one of these, park with a question that starts `lane C: `, names the step and
says no setting unlocks it, and recommend opening an interactive `/desk-ticket` session. Never offer
an allow rule, a grant or a settings change as an option: the user takes it, you are requeued, and
you park again. A refusal a §3 row does control still parks naming that row (core section 2).

Your tools are an allow-list too, fixed at launch to the ones this contract and the skills you load
name. A tool shown to you as deferred, such as `SendMessage`, is loaded with `ToolSearch` before its
first call.

## Stage 4b's review tools: agents, finders and codex

The Stage 4 file's self-review sends you here. These rules live in this file because every session
reads it before Stage 4b: at Stage 3, before its first command, or at the start of a session that
begins at Stage 4b.

**The named agents are already synced: confirm, do not assume.** Where the repo gitignores its
generated `.claude/agents/*.md`, a hand-made worktree starts empty and every named agent silently
resolves to `general-purpose`, while the report still reads as a full fleet run. `setup-worktree.sh`
runs §4 Project subagents sync (`desk-env cmds agents-sync`) and hard-fails the spawn if the directory is still empty. `ls
.claude/agents/` to confirm, and only if it is genuinely empty run §4 Project subagents sync yourself;
if that fails (or the row is `none` and the directory is empty), say so in `AUTOPILOT_DONE`. Never
let a general-purpose-only review pass as a fleet one.

**Dispatch every finder read-only, and check the tree after each round.** Finders inherit Edit and
Write, and one will sometimes implement a fix mid-round, so the refutations confirm findings about
code nobody pushed. Open every finder prompt with: no Edit or Write, no git state changes, fixes
described in prose only, and no permission to run `gh pr review` or `gh run rerun` (a finder once
posted its own verdict marker and turned the gate green on a superseded verdict). After each round,
`git status --porcelain`; a dirty tree is an aborted round: restore with `git checkout -- <paths>`
and say in the review that a round was discarded. Subagents may also be denied commands you can run,
so run the suite yourself and hand them the result.

**`codex` follows config §3 `codex-review`.** Where the review refutes its findings with codex and
the key is `yes`, `codex exec --sandbox read-only …` and `codex --version` (and the resolved absolute
path's same forms) are in the worker allow-list and the
spawn preflight asserted `CODEX=OK` before you were launched, so the refutation is a **real
cross-vendor refutation** and findings are **not** tagged `(same-vendor)`. Where a required check
reads the verdict's vendor, it may require the cross-vendor one. Where your prompt lists
`codex-review` as denied, the user has not agreed to send diffs to OpenAI: never call `codex`, skip
the codex probe, refute with the review's same-vendor refuter, tag every finding `(same-vendor)`, and
say in `AUTOPILOT_DONE` that a gate requiring cross-vendor refutation cannot pass for that reason.

**Keep every codex call a single `codex`-prefixed command.** `dontAsk` allows a command only when
every part of it matches an allow rule, so the moment a call grows a `$(mktemp)`, an `if`, a pipe or a
`timeout` wrapper, `Bash(codex:*)` stops covering it and the harness refuses the whole thing before
the shell runs, silently. That is the call being shaped wrong, not codex failing. The probe:

```bash
codex exec --sandbox read-only "Reply with exactly: CODEX_OK"
```

- Exit 0: proceed, cross-vendor, untagged. `codex login status` proves nothing: it reports logged in
  on a seat that is out of usage.
- Non-zero with an error: the seat is out of usage (the error names a reset date; "start a free
  trial of Plus" means a personal seat, not the team one) or the model is at capacity.
- **No output at all**: the harness denied it (the call was compound), or codex is reading stdin.
  Fix the call shape, and add `< /dev/null` if it printed `Reading additional input from stdin`.

**Refutation prompts: one finding per call, under ~800 characters, mechanism stated flat.** Name the
`file:line` and let codex read the file; never paste a diff or ask it to run `git show`. A large
prompt hangs `codex exec` for as long as it is allowed to run, heartbeating into your log so the
orchestrator cannot see the stall. Never offer a benign alternative ("or is this deliberate?"):
codex rejects when uncertain, so that clause can flip a CONFIRMED P1 to REJECTED with no code
change. Never pass `-m`. A useless or empty reply counts as REJECTED and says the refutation did
not run, not that it passed.

You cannot answer a question, so **do not let the codex probe stop you.** If codex is genuinely
unusable after a correctly-shaped call, fall back to the same-vendor refuter, tag every finding
`(same-vendor)`, and say in `AUTOPILOT_DONE` which outcome you saw: a gate requiring cross-vendor
refutation will not pass, and the orchestrator needs to know why. Never tag a run `(same-vendor)`
that actually refuted with codex, and never claim codex on a run that fell back. Bound the probe at
~120s by your tool timeout.
