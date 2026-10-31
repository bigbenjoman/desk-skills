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
  your own arguments after it. An item with a directory has no bare form (you cannot `cd`), so it
  runs as `~/.claude/desk/bin/with-lock.sh <lock> --cwd <DIR> -- <CMD> [args]`, where `<lock>` is
  `test` for §4 Unit tests and Integration tests, `tsc` for §4 Typecheck, `browser` for §4 E2E
  tests, and `nolock` for everything else (lint, build, codegen, dev server), which only changes
  directory. §4 Codegen (e.g. `pnpm prisma generate`) is how you regenerate code; with no such row,
  a ticket that needs a regeneration parks naming the command.
  An environment prefix (`PORT=3008 <§4 Dev server>`) is refused; pass the port as an argument in
  whatever form the §4 Dev server row gives (e.g. `-- --port 3008`).
- **The package manager**: only `<§4 Package manager> install` with no arguments, `<bin> --version`,
  and the configured rows. Its add and sync forms (`pnpm add <pkg>`, `uv add <pkg>`, `uv sync`)
  only where §3 `worker-dependency-install` is `yes`, and never global, another directory or a `..`
  path; otherwise a ticket that needs a new dependency parks naming the row. `remove`, the one-off
  runners (`npx`, `npm exec`/`x`, `pnpm exec`/`dlx`, `yarn dlx`, `bunx`, `uvx`) and the §4 Command
  prefix run on its own (`<prefix> <anything>`) are refused. Run a TS script
  with the worktree's installed runner, e.g. `node <worktree>/node_modules/tsx/dist/cli.mjs <file>.ts`.
- **Screenshot capture**, only where §3 `worker-screenshots` is `yes`, and only under the browser
  lock from your worktree: `~/.claude/desk/bin/with-lock.sh browser` then `node ./<script>` or
  `node <worktree>/<script>` (a capture script at the root, or Playwright under `node_modules/`),
  `./node_modules/.bin/<playwright|storybook|test-storybook|storycap> …`, or
  `<python|python3|uv run python|.venv/bin/python> ./<script>.py`. Never a `..`. Otherwise parks
  naming the row.
- **Local services**: only where §3 `worker-local-services` is `yes`, and only
  `docker compose -f <main checkout>/<its compose file> [-f <its override file>] up -d --no-recreate
  --no-deps <service>` for a service §4 Local services names: the shared project, never one named
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
  takes the read subcommands only. `git rm` and `git mv` are allowed for tracked files in your
  worktree. A lint or format tool (eslint, prettier, biome, oxlint, stylelint, tsx, `prisma generate`)
  runs as `./node_modules/.bin/<tool>`, never with `..`; suites, typechecks and migrations run only
  as their §4 rows.
- **`gh`**: reads (`pr view`, `pr list`, `pr checks`, `pr diff`, `run view`, `run list`,
  `issue view`, `repo view`), and only where §3 grants them `gh pr create --draft …` (it must begin
  exactly `gh pr create --draft` or `gh pr create --repo <§0 GitHub repo> --draft`), `pr edit`,
  `pr review` (commented only), `pr comment`, `pr update-branch`, `run rerun`. **`gh api` is refused
  in every form**, and `gh alias` too: read reviews with `gh pr view <n> --json reviews,comments`,
  and answer a review thread with a `gh pr comment` naming it (§3 `pr-reply`); resolving threads is
  the orchestrator's.
- **`gh workflow run`**, only where §3 `worker-workflow-dispatch` is `yes`, and only exactly as
  §4 Worker workflows lists each entry: `gh workflow run <file>.yml --ref <your branch> -f …` (or
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
  `wc`, `diff`, `jq`, `tr`, `cut`, `stat`, `du`, `file`, `mkdir`, `ps`, `pgrep`. **Not** `sed`,
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

Your tools are an allow-list too, fixed at launch to the ones this contract and the skills you load
name. A tool shown to you as deferred, such as `SendMessage`, is loaded with `ToolSearch` before its
first call.
