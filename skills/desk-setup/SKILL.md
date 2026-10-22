---
name: desk-setup
description: >-
  Use when setting up the desk-* skills in a repository for the first time or after ./install.sh,
  or when changing what they may do in that repo — "set up desk here", "configure desk for this
  repo", "run desk setup", "grant/revoke a desk permission", "let autopilot merge", "stop it
  merging", "why does it keep asking me", "use my voicepa settings for this repo", or when another
  desk-* skill reports that this repo has no desk config, or a TODO or missing row.
argument-hint: "[permissions | plugins | from <owner__name> | list]"
---

# desk-setup

## Overview

Writes **this repo's** desk config by detecting and asking, so the other skills know who the user
is here, which Jira and people this repo uses, how it builds and merges, and **what they may do on
the user's behalf in this repo**, including unattended.

Every repo has its own config. Nothing in one repo's config applies to another:

```bash
desk-env where     # SLUG=owner__name  CONFIG=~/.config/desk/repos/<slug>/config.md  CREDS=<that folder>  EXISTS=yes|no
```

`CONFIG` is the file this skill writes. `CREDS` is the folder, beside it, for this repo's Jira email
and token. Outside a git repo `desk-env where` exits 3: stop and ask which repo to set up.

**Core principle: every permission is granted out loud, by the person it belongs to, in this
conversation, for this repo. Nothing is assumed, inherited, or inferred from a default or from
another repo.**

Each §3 row carries a **Recommended** value: a proven starting point. Undrafting, merging on green
and cleanup are recommended at `yes`, because the clean review at head and the required checks are
the gate and an unattended batch cannot ask; on a repo with no branch protection, merging stays at
`ask`. Setup offers it as the first option, and the user still answers every row. A row the user has not answered is a `no`.

## Never do these

- **Never write a permission the user did not choose in this conversation.** Recommended, or
  another repo's answer, is the first option of the *question*, never the answer.
- **Never fill a value you merely guessed.** Detected-then-confirmed is fine; guessed is not.
- **Never change an existing config or settings file without a before/after**, and back up every
  `settings.json` / `settings.local.json` before touching it.
- **Never ask for, echo or write a token.** The user writes credentials to `CREDS` themselves; you
  only check the file exists and is `600`.
- **Never read a private source to decide whether you may read it.** Connector checks look for
  the tools; they never call one against content.
- **Never offer `yes` on a non-configurable row**, and never argue for a grant after a `no`.
- **Never write an allow rule to `~/.claude/settings.json`.** Allows are per repo, in the repo's
  `.claude/settings.local.json`; only the deny-only plan is user-level.

| Excuse | Reality |
|---|---|
| "They said yes to this in voicepa, so here too" | Different repo, different blast radius. Offer it as the starting point; ask the row. |
| "They took Recommended on the Jira rows, so the PR rows too" | Different capabilities, different answers. Ask each row. |
| "Forty rows is tedious; I'll offer accept-all" | The user asked to be asked. Four per round, as many rounds as it takes. |
| "They didn't answer that one; leave it as recommended" | Unanswered is `no`. Say which rows you left off. |
| "I detected their GitHub handle, I can detect their permissions" | Facts can be detected. Consent cannot. |
| "It's their own solo repo, the people rows don't matter" | Write `you`. The skills route questions by those rows. |

## Modes

| Invocation | Does |
|---|---|
| `/desk-setup` | where → start point → detect → interview → connectors → harness rules → write → summary |
| `/desk-setup permissions` | reads this repo's config, then straight to the interview |
| `/desk-setup plugins` | reads this repo's config, then only §4b (which plugins this repo needs); changes nothing else. `/desk-update` offers it too |
| `/desk-setup from <owner__name>` | as `/desk-setup`, starting from that repo's §1, §3 and §3b answers |
| `/desk-setup list` | lists every configured repo (`ls ~/.config/desk/repos/*/config.md`) with its tracker, Jira project and how many §3 rows are `yes`; changes nothing |
| config already exists | re-run: current values are the starting point; ask what to change |

## 0. Which repo, and where to start from

1. Run `desk-env where` and say which repo this is (`GH_REPO`) and where its config will live.
2. If `EXISTS=yes`, this is a re-run: see *Re-running and revoking*.
3. Otherwise list the other configured repos. If there are any, ask one question: start from one of
   them, or from scratch. **Recommended: the configured repo that shares the most with this one**
   (same GitHub owner, then same Jira site); its description says which rows will be pre-filled.
   Starting from another repo pre-fills **§1** (identity, confirmed row by row, because the email
   and Jira account can differ per client), and **§3 / §3b as the first option of each question**,
   never as answers. §0, §2, §4 and §5 are always detected fresh for this repo.
4. If that repo uses the same Jira site, offer to copy its `jira-email` and `atlassian-token` into
   this repo's `CREDS` (`cp -p`, then `chmod 600` on both). Say that the token is then shared by both repos
   and that revoking it in Atlassian breaks both.

## 1. Detect, then confirm

Run these from the repo root, then show one table (field · value · where it came from) per config
section and have the user correct it, one round per section. Say before you start that the codex
check makes one real request and the Jira checks make read-only API calls.

```bash
# §0 this repo
gh repo view --json nameWithOwner,defaultBranchRef,description
# §1 you
gh api user --jq .login
git log -n 50 --format='%an <%ae>' | sort | uniq -c | sort -rn | head -3   # the author this repo's commits use
git config user.name; git config user.email
# §2 paths
git rev-parse --path-format=absolute --git-common-dir     # parent = primary repo root
git worktree list --porcelain | awk '/^worktree /{print $2}'   # infer the worktrees dir
uname -s; grep -qi microsoft /proc/version 2>/dev/null && echo WSL
# §4 GitHub and CI
gh api repos/{owner}/{repo} --jq '{squash:.allow_squash_merge,merge:.allow_merge_commit,rebase:.allow_rebase_merge,auto:.allow_auto_merge,del:.delete_branch_on_merge}'
# Required checks come from TWO places; read both. A repo protected only by a ruleset answers 404
# to the first call and is NOT unprotected.
gh api repos/{owner}/{repo}/branches/<default>/protection 2>&1          # classic protection; 404 "not protected" is an answer
gh api repos/{owner}/{repo}/rules/branches/<default> \
  --jq '.[] | {type, ruleset_id, parameters}' 2>&1                      # every ruleset rule that applies to the default branch
gh api repos/{owner}/{repo}/rulesets --jq '.[] | {name, enforcement}' 2>/dev/null   # ruleset names, for the summary
gh pr list --state merged --limit 20 --json number,title,headRefName,body,mergeCommit
gh api repos/{owner}/{repo}/commits/<mergeCommit oid> --jq '.parents | length'   # per PR: 1 = squash or rebase, 2 = merge commit
for n in <the last 15 merged PR numbers>; do gh pr checks "$n" --json name,state; done   # names that run, and which fail
gh auth status -h github.com 2>&1 | sed -n 's/.*Token scopes: //p'        # needs repo + workflow
# §4 toolchain: find, not an ls glob (zsh aborts a whole `ls` on one unmatched glob), and one level
# of apps/, packages/, services/ and the like, where a monorepo keeps its Python and JS projects
find . -maxdepth 3 \( -name node_modules -o -name .git -o -name .venv \) -prune -o -type f \( \
  -name package.json -o -name pnpm-lock.yaml -o -name yarn.lock -o -name package-lock.json -o -name 'bun.lock*' \
  -o -name mise.toml -o -name .tool-versions -o -name .nvmrc -o -name turbo.json \
  -o -name pyproject.toml -o -name uv.lock -o -name poetry.lock -o -name 'requirements*.txt' -o -name alembic.ini \
  -o -name Makefile -o -name 'docker-compose*.yml' -o -name 'compose*.yml' -o -name vercel.json \) -print | sort
jq -r '.packageManager // empty, (.scripts // {} | to_entries[] | "\(.key)\t\(.value)")' package.json
find . -maxdepth 1 \( -name .claude -o -name .agents -o -iname claude.md -o -iname agents.md \) -print
# §4 pre-push and PR-description checks: what CI runs, and any hook already in charge of pushes
grep -rnE 'run:|pull_request\.(body|title)|PR_BODY' .github/workflows 2>/dev/null
git config --get core.hooksPath
find . -maxdepth 2 \( -name .husky -o -name 'lefthook*.yml' -o -name .pre-commit-config.yaml \) -print
find "$(git rev-parse --git-common-dir)/hooks" -type f ! -name '*.sample' -print   # hooks a hooksPath would switch off
find .githooks scripts/desk .github/workflows/desk-gate.yml -maxdepth 1 -type f -print 2>/dev/null   # templates already committed?
# §4 environments: names only, never values
find . -maxdepth 3 -name node_modules -prune -o -name '.env*' -type f -print | sort
grep -hoE '^[A-Z0-9_]*(DATABASE|DB|POSTGRES|PG)[A-Z0-9_]*=' $(find . -maxdepth 3 -name node_modules -prune -o -name '.env*' -type f -print) 2>/dev/null | sort -u   # variable names only
# §4 other work ids and merge holds
git branch -r --sort=-committerdate --format='%(refname:short)' | head -50
find . -maxdepth 2 -type d \( -name .belmont -o -name .planning -o -name .plans \) -print   # planning tools that mint their own ids
grep -niE 'before merg|merge.*only after|do not merge|must (run|build).*(merg|deploy)' CLAUDE.md AGENTS.md claude.md agents.md 2>/dev/null
find .github .githooks scripts/desk -maxdepth 0 -print 2>/dev/null                   # CI and hook holds
jq -r 'keys[] | select(. == "scripts" or . == "jest" or . == "eslintConfig")' package.json 2>/dev/null   # package.json#<key> holds
find . -maxdepth 3 -name node_modules -prune -o -type f -name 'vite.config.*' \
  -exec grep -lE '^[[:space:]]*test[[:space:]]*:' {} +                              # Vitest configured inside vite.config
grep -lE '^\[tool\.(ruff|pytest|mypy)' pyproject.toml 2>/dev/null                   # lint or test config in pyproject.toml
find . -maxdepth 3 \( -name node_modules -o -name .git -o -name .venv \) -prune -o -type f \( -name CODEOWNERS \
  -o -iname '*ruleset*.json' -o -iname '*protection*.json' -o -name settings.yml -o -name 'tsconfig*.json' \
  -o -name 'eslint.config.*' -o -name '.eslintrc*' -o -name 'biome.json*' -o -name '.oxlintrc*' -o -name 'ruff.toml' \
  -o -name 'vitest.config.*' -o -name 'vitest.workspace.*' -o -name 'jest.config.*' -o -name 'playwright.config.*' \
  -o -name 'pytest.ini' -o -name 'tox.ini' -o -name 'setup.cfg' -o -name '.flake8' -o -name 'mypy.ini' \) -print | sort   # check-config holds
# §4 tracker (only if the user says this repo uses Jira)
desk-jira where
desk-jira whoami                                        # display name, email, account id
desk-jira api 'api/3/project/search?maxResults=50' | jq -r '.values[] | "\(.key)\t\(.name)"'
desk-jira api 'api/3/project/<KEY>/statuses' | jq -r '[.[].statuses[].name] | unique | join(", ")'
desk-jira fields priority                               # a custom priority field, if any
desk-jira fields size                                   # a Size field (XS-XL); none: tell the user it is a manual
                                                        # per-project UI step (desk-jira Epics), record it in §4 Other fields if found
                                                        # and in §4 Size field (desk-jira refuses an XL outside an Epic)
desk-jira meta                                          # per type, what Jira requires: propose §4 Required fields from it
                                                        # and the user's answer; the top priority values go in §4
                                                        # Priorities only you set only if the user says so
# §4 people
gh api repos/{owner}/{repo}/collaborators --jq '.[].login' 2>/dev/null
cat .github/CODEOWNERS CODEOWNERS 2>/dev/null | head -20
# §5 conventions
git log -n 40 --format='%s%n%b' | grep -ciE 'co-authored-by: *claude|generated with \[?claude code'   # attribution already in use?
git branch -r --sort=-committerdate | head -30
# §2 and §5 design: where canvases live, the widths the code already uses, the design system's files
git ls-files | grep -iE '(^|/)(docs/)?design/' | head -20                          # canvases already committed?
git grep -nE 'MOBILE_BREAKPOINT|use-?mobile|viewport[^;]*width|width.?[[:space:]]*:[[:space:]]*[0-9]{3,4}[[:space:]]*[,}]|setViewportSize|--breakpoint-|screens[[:space:]]*:|@media[^{]*(min|max)-width' \
  -- ':!*.lock' ':!*-lock.*' ':!*.min.*' | head -60                                 # use-mobile hooks, e2e viewports, Tailwind screens
git ls-files | grep -iE '(^|/)(tokens?([.-][a-z]+)*\.(css|scss|json|ts|js)|theme\.(css|scss|json|ts|js)|tailwind\.config\.[cm]?[jt]s|design\.md)$'
git grep -lE '^@theme' -- '*.css'                                                   # Tailwind v4 tokens in CSS
# everything else
(codex exec --sandbox read-only "Reply with exactly: CODEX_OK")
claude plugin list --json | jq -r '.[] | "\(.id) enabled=\(.enabled)"'
jq '.hooks.PreToolUse' ~/.claude/settings.json | grep -c deny-ai-attribution
desk-env default-mode                                   # exit 1: defaultMode is dontAsk, SOURCE= names the file
bash ~/.agents/skills/desk-setup/bin/user-skill-copies.sh <repo root>      # user-level skills shadowing this repo's
desk-env machine detect                                 # this computer's hardware (below, "This computer")
```

How to turn what you find into rows:

- **Tracker.** Ask once: does this repo use Jira? If not, write `none` in every Jira row, `none` in
  §1 Jira email / display name / account id, and skip the Jira rounds of the interview.
- **Jira credentials.** If `desk-jira where` shows no email or token, tell the user to write them
  (`CREDS` from `desk-env where`), as their own action, and wait:

  ```
  ! mkdir -p <CREDS> && chmod 700 <CREDS>
  ! printf %s 'you@example.com' > <CREDS>/jira-email && chmod 600 <CREDS>/jira-email
  ! printf %s '<api token>' > <CREDS>/atlassian-token && chmod 600 <CREDS>/atlassian-token
  ```

  Tokens: https://id.atlassian.com/manage-profile/security/api-tokens. The **Jira site** is asked
  (or taken from the start-point repo) before `whoami` can run: `desk-jira` reads it from the
  config, so write §4 Jira site first, then re-run `desk-jira where`.
- **How list rows are written.** Every row that holds a list (checks, env files, commands,
  database variables, patterns, holds, staging and Vercel apps) gets **one backtick span per item**:
  `` `Lint, Type Check & Build` `Verify script sign-off` ``. The scripts never split on commas, so a
  check name may contain one. A command that runs in a subdirectory is written
  `` `apps/api: uv run pytest` ``, **never** `cd apps/api && uv run pytest`: the directory form is
  what the test lock and the worker allow-list understand. Show the user the row in this form when
  you confirm it, and read it back with `desk-env list <id>` / `desk-env cmds <id>` after writing.
- **A row's note never contains a backtick span.** Every span in a value cell outside a trailing
  `(…)` note is read as an item, so a note written `` `none` — `./install.sh` installs to your
  machine `` makes `./install.sh` a second item. Write the note in plain text, in parentheses
  after the value: `` `none` (install.sh installs to your machine) ``. `none` stands alone:
  `desk-env list` and `desk-env cmds` refuse a row with `none` beside any other item, and so do
  worktree setup and worker settings.
- **Ticket key pattern.** Propose `<PROJECT>-[0-9]+` from the Jira project; check it against recent
  branch names and PR titles and say how many matched (a repo can put keys in titles but never in
  branches; say which).
- **Other work id patterns.** From the same branch and PR-title history, and from any planning
  directory found (`.belmont/` and the like), look for ids that are not tracker keys: planning-tool
  task ids (`P1-M14-FIX-1`), bug numbers (`BUG-119-5`). Propose a regex per family, one span each,
  with the count of branches or titles each matched and two examples; the user confirms or writes
  `none`. Such ids are then accepted as tickets whose text comes from a ticket file, never Jira.
- **Workflow states.** From the project's statuses, propose In-progress, Review and Done states; the
  user confirms. `none` for Review is fine.
- **Branch protection and Required checks.** Merge what classic protection and the rulesets
  (`rules/branches/<default>`: `required_status_checks` rules, `pull_request` rules for approvals,
  `required_linear_history`) say; name which source each check came from. A repo that answers 404
  to classic protection but has a ruleset **is protected**; say so. Only when both are empty is it
  unprotected. **Unprotected is not an error**: write §4 Branch protection `none` and §4 Required
  checks `none` (green then still needs every non-advisory check to pass) and say that in this repo
  nothing stops a merge except the skills themselves.
- **Advisory checks.** From the last 15 merged PRs' checks, propose as Advisory any check that
  failed on most of them (it merged red, so it is not gating in practice), with the failure count,
  e.g. "`Run e2e tests` failed on 14 of 15". Never propose a required check. The user confirms each;
  `none` is the default. Everything not listed must pass for "green".
- **Merge holds.** Search the repo instructions for steps a person must do before merging certain
  changes ("before merging backend changes run `./scripts/build-lambda-images-local.sh`"). Propose
  each as `` `<glob>: <why>` ``, e.g. `` `backend/**: build and push Lambda images first` ``; the
  user confirms or writes `none`. **The row must be set**: `none` is a fine answer, but while it is
  unset the merge driver refuses to start and clearance parks every PR. Say that autopilot and clearance will never merge a PR that
  touches a held path: they report it with the reason and a person merges.

  **Then propose the holds on how CI checks things**, so a PR that changes the checks is never
  merged without a person. These are defaults the user confirms or declines one by one; a
  declined one is simply left out of the row. Propose each that the scans found, with its reason:

  | Found | Propose |
  |---|---|
  | `.github/` | `` `.github/**: changes CI workflows or repo settings, which decide what a merge is checked against` `` |
  | `.githooks/` | `` `.githooks/**: changes the committed git hooks that check a push` `` |
  | `scripts/desk/` | `` `scripts/desk/**: changes the checks the pre-push hook and the desk gate run` `` |
  | a committed `CODEOWNERS`, ruleset or protection file outside `.github/` | `` `<its path>: changes who must review, or what protects the branch` `` |
  | `package.json` with a `scripts` section | `` `package.json#scripts: changes the commands CI runs` `` |
  | `tsconfig*.json` | `` `tsconfig*.json: changes what the typecheck checks` `` |
  | a lint config (`eslint.config.*`, `.eslintrc*`, `biome.json*`, `.oxlintrc*`, `ruff.toml`, `.flake8`, `mypy.ini`) | `` `<its name or glob>: changes what lint checks` `` |
  | a test config (`vitest.config.*`, `jest.config.*`, `playwright.config.*`, `pytest.ini`, `tox.ini`) | `` `<its name or glob>: changes what the tests run` `` |
  | a `jest` or `eslintConfig` key in `package.json` | `` `package.json#jest: changes what the tests run` `` / `` `package.json#eslintConfig: changes what lint checks` `` |
  | a `test:` block in `vite.config.*` | `` `vite.config.*: changes what the tests run (and the build)` `` |
  | lint or test config in `setup.cfg`, or `[tool.ruff]`, `[tool.pytest…]` or `[tool.mypy]` in `pyproject.toml` | `` `<that file>: changes what lint or the tests check` ``, saying that every edit to the file is then held |

  `package.json#scripts` holds a PR only when it changes the `scripts` key, so a version-only bump of
  `package.json` and its lockfile still merges on its own (any `<file>#<key>` holds a JSON file only
  when that key changes; dotted for a nested key). A lockfile is **not** held by default: ask once
  whether dependency updates should wait for a person too, and only on `yes` add
  `` `<the lockfile>: dependency changes are merged by a person` ``. The key form reads JSON only,
  so a TOML or INI file holding check config is held whole: for `pyproject.toml` that includes every
  dependency bump, which the user weighs before confirming.
- **Merge method.** From the repo's allowed methods (`allow_squash_merge`, `allow_merge_commit`,
  `allow_rebase_merge`) and the merged-PR history: a merge commit with **two parents** is `merge`;
  one parent is `squash` (or `rebase`, when only rebase is allowed). Propose the method the last 20
  merged PRs mostly used, provided the repo still allows it; say the split, e.g. "18 merge commits,
  2 squash".
- **Toolchain.** From the lockfile and `packageManager` (`pnpm-lock.yaml` → pnpm; `mise.toml` or
  `.tool-versions` → Command prefix `mise exec --`, else `none`), and the `scripts` in
  `package.json` / `turbo.json` / `pyproject.toml` / `Makefile` for the command rows. A Python
  project under `apps/*` (a `pyproject.toml`, `uv.lock` or `requirements*.txt` there) gets its own
  command items in its directory, e.g. `` `apps/api: uv run pytest` ``, and its `alembic.ini` a
  §4 Database migrate candidate. Propose, then confirm; a guessed test command that does not exist
  wastes a worker's whole run.
- **Related tests.** For each Unit tests item, the same runner in its related form, in the same
  directory: Vitest `vitest related --run --passWithNoTests`, Jest `jest --findRelatedTests
  --passWithNoTests` (through the package manager as the Unit tests item runs it, e.g.
  `` `pnpm vitest related --run --passWithNoTests` ``; the flag makes a change no test imports pass).
  Workers append the changed files to a Vitest or Jest item. For pytest, propose an affected-set
  command only where the repo already has the plugin (`pytest-testmon` in its dependencies:
  `` `apps/api: uv run pytest --testmon` ``); otherwise leave that suite out, and a change under it
  runs that suite in full. A turbo or nx script that fans out over packages has no related form:
  propose each package's runner in its directory, or `none`. `none` keeps workers on the full
  suites, and changes nothing else.
- **Codegen.** Always ask. The commands that regenerate code a fresh worktree or a schema change
  needs, one span each in the Build form: a `generate` script, `prisma generate` where there is a
  `schema.prisma`, an OpenAPI or GraphQL codegen step. Workers may run exactly these and nothing
  wider, with no lock. `none` is a fine answer, and changes nothing.
- **Baseline checks.** Propose `off`. `on` is for a repo whose batch bases carry typecheck or lint
  errors workers should not have to clear: an autopilot batch with a base records them before it
  spawns and workers fail only on errors they add. It reads tsc, ESLint's default format and mypy;
  say that any other Typecheck or Lint output runs in full, as does output a task runner prefixes
  (turbo, `pnpm -r`), so propose one item per package there, and that CI still runs the full checks.
- **Acceptance specs.** Always ask. Two spans: the directory an epic's acceptance specs go in, then
  the command that runs some of them, with `{ids}` where the criterion ids go, in the Unit tests
  form, e.g. `` `tests/acceptance/` `pnpm vitest run tests/acceptance -t "{ids}"` `` or
  `` `tests/acceptance/` `uv run pytest tests/acceptance -k "{ids}"` ``. Propose the repo's own
  runner filtered by test name, and say the specs are titled with their criterion id. Set, an epic
  run on a batch base goes through autopilot feature mode; `none` is a fine answer, and keeps every
  epic an ordinary batch.
- **Pre-push checks.** From the steps the CI workflows run on a pull request, take the fast,
  local ones (code generation, format, lint, typecheck) and map each onto the repo's own command
  (a `package.json` script, a Makefile target), one span each in the Unit tests form, generate steps
  first: `` `pnpm prisma generate` `pnpm biome ci` `pnpm turbo type-check` ``. Leave out anything
  that needs a database, a browser, secrets or a deploy, and any suite too slow to sit in front of a
  push: the aim is about 90 s on this computer. Say which CI step each item came from and which
  steps you left out and why. Write an item exactly as the Typecheck or Unit tests row writes it when
  it is the same command, so it takes the test lock. `none` is a fine answer.
- **PR-description checks.** A workflow step that reads `github.event.pull_request.body` (or a
  `PR_BODY`-style variable set from it) and runs a script is the candidate: propose that script's
  command, e.g. `` `node scripts/check-pr-body.mjs` ``. desk-pr runs it with the draft body's file
  path appended, so **read the script** and say whether it accepts a file path. One that reads only
  the event or an environment variable cannot run before the PR exists: propose `none` and say that
  adding a file-path argument is a change to the repo, for its own PR. No such step: `none`.
- **Env files.** The `.env*` files the primary checkout has that a fresh worktree lacks
  (`git -C <root> ls-files --others --ignored --exclude-standard | grep -E '(^|/)\.env'`). Names
  only; never read them.
- **Database URL variable.** **Every** variable name in those env files (and `.env.example`) that
  holds a database URL or name, e.g. `` `DATABASE_URL` `DATABASE_URL_UNPOOLED` `GYGG_DB_NAME` ``,
  one span each, from the name scan above; never read a value. Missing one matters: a worker's
  worktree has each listed variable repointed at its own database or blanked, and an unlisted one
  keeps whatever the copied env file says. **Unset blocks worker setup** (`setup-worktree.sh`
  refuses to make a worker worktree nobody has named the database variables for); write `none` only
  when the repo has no database at all.
- **Local database.** Exactly one of two forms, because the scripts parse it: `` `postgres container
  <name>` `` (a running Postgres container per-ticket databases can be created in), or `none` (a
  hosted database, or none at all). Anything else is not automated: workers then get no per-ticket
  database. **If it is `none` but the env
  files hold a database URL, warn plainly**: that URL is shared (often staging or production), and
  autopilot workers will get every §4 Database URL variable **blanked**, so they cannot run
  database-backed tests or migrations at all.
- **Local review command.** Offer what the repo ships first (a review skill in `.agents/skills` or
  `.claude/skills`), then `/desk-review`, then `/code-review`, then `none`. With `/desk-review`,
  propose §4 Clean review verdict `p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0`.
- **Review bar.** `default` unless the repo has its own bar file (search `review-bar`, `REVIEW.md`,
  a review section in `CLAUDE.md`); then its path. Offer to copy desk-review's
  `references/review-bar.md` into the repo as a starting point only if the user asks.
- **Review domain experts.** List the repo's own skills (`.claude/skills`, `.agents/skills`) whose
  description is domain knowledge rather than tooling (pricing, trading, property, regulation), and
  propose a `` `<glob>: <skill>` `` for each, the glob being the code that domain lives in (find it
  with `git ls-files | grep -i <domain word>`). The user confirms each; `none` is a fine answer.
  **A repo with UI** (the design scan found components or tokens) also gets the UI default, the
  globs narrowed to where its frontend code lives: `ui-designer` on component and style files
  (`` `**/*.{tsx,jsx,vue,svelte,css}: ui-designer` ``), `ux-designer` on component files, and
  `ux-copywriter` on its copy files: its message catalogues (`git ls-files | grep -iE
  'messages|locales|i18n'`, e.g. `` `messages/**: ux-copywriter` ``), or the component globs where
  copy lives inline. Each is declinable like any other rule.
- **People.** For a solo repo propose `you` in every role and say so. For a team repo, propose from
  collaborators and CODEOWNERS; the user names the roles.
- **AI attribution.** Propose `allowed` if recent commits already carry a Claude trailer (the repo's
  own instructions then decide the wording), otherwise ask. If the user picks `forbidden`, offer to
  also write `{"attribution": {"commit": "", "pr": "", "sessionUrl": false}}` into the repo's
  `.claude/settings.local.json` (backed up first), so Claude Code does not add it in the first place;
  the hook is the backstop.
- **Repo instructions.** List `CLAUDE.md` / `AGENTS.md` / similar that exist; they win over §5.
- **Ticket format.** While the row is `TODO`, propose `default`: desk-jira's
  `references/ticket-template.md`, the layouts every desk path that files a ticket uses. Show its
  section list per type (Story and Task, Bug, Epic, Subtask) and write `default` once the user
  confirms. If the project's recent tickets share a different layout the team relies on, show both.
  Write the repo's own sections per type only if the user picks them. A row already set is left as
  it is.
- **Handoff directory** on WSL must be Windows-visible (`/mnt/c/Users/<name>/Downloads/`). On macOS
  propose `~/desk-handoff/`, never `~/Downloads/`, `~/Desktop/` or `~/Documents/`: macOS folder
  privacy refuses Claude Code those (EPERM), so every skill that writes there fails. Elsewhere
  `~/Downloads/`. Whatever the answer, check the agent can create a file there before writing the
  row: `mkdir -p <dir> && touch <dir>/.desk-write-check && rm <dir>/.desk-write-check`. A refusal is
  said with its error and the row is asked again; never save a directory the check refused.
- **Handoff at context %.** Propose `45`. When the session's context passes that share of its
  window, the `desk-handoff.py` hook (registered by `install.sh`) has it finish its step and write
  `.handoffs/<yyyy-mm-dd>[-n].md`, and the session after `/clear` or a compaction picks that up on
  its own. A whole number from `1` to `99`, or `0` to turn it off for this repo.
- **Handoff at context % on a 1M window.** Propose `25`. The same handoff for a session with a
  1,000,000-token window, where 45% would be about 450,000 tokens and recall has already dropped
  by then. A whole number from `1` to `99`, or `0` to turn it off on 1M windows only. Left unset it
  is `25`, or off when the row above is `0`.
- **Design canvases directory.** Propose `docs/design/`, or the directory the repo already commits
  canvases in when the design scan found one. It is relative to the repo root and committed, so
  autopilot workers and the design agents read the same files; a shared artifact link alone is not
  an answer, because only the account that made it can edit it.
- **Breakpoints.** Start from `390` `768` `1024` `1280` `1440` and merge in every width the design
  scan found in the repo's own code (a use-mobile hook's constant, an e2e or screenshot viewport,
  Tailwind `screens` or `--breakpoint-*`, a width that recurs in `@media` queries), deduplicated and
  ascending, one span each. Name the `file:line` each width not in the default came from. `none` for
  a repo with no UI.
- **Design system.** Propose each file the design scan found that defines tokens (a `tokens.css`,
  theme files, the Tailwind config, a CSS file with an `@theme` block, a `DESIGN.md`), one span each,
  repo-relative. `none` for a repo with no UI. **A repo with UI but nothing to put in this row
  except token values** (no `DESIGN.md`): offer to draft one from the tokens found, as a proposal
  to review. Every value in it is copied from a token file with that file named beside it (colours,
  type scale, spacing, radii, shadows, and the Breakpoints above); a value the files do not hold is
  left out, never invented. Show the draft in full and write nothing until the user confirms; on a
  yes, commit it the way the pre-push hook is committed (a new branch named per §5 Branch names,
  pushed and opened through `desk-pr` under §3 `git-push` and `pr-open`) and add `DESIGN.md` to the
  row. On a no, the row keeps the token files, or `none`.
- **codex**: only the exit code and a `CODEX_OK` in the output count.
- **Memory ceiling** default: the machine profile's, else WSL `16`; otherwise physical RAM minus ~8.
  The profile's figure (`desk-env machine get memory-ceiling-gb`) is a hard limit across every repo:
  a row set above it reads as the machine's anyway. So when the row already holds a figure above the
  machine's, propose the machine's figure in its place and say why: "the machine profile limits
  every repo to <machine> GB (memory less 8 for the OS and the runner VM's reservation), and a repo
  row may be lower but never higher". A figure at or below the machine's stays as it is.
- **What review asks for** (optional): offer to mine the last 30 review comments on merged PRs
  (`gh api repos/{owner}/{repo}/pulls/comments?per_page=100`) into §4's table. Say it reads
  colleagues' review text; skip on a `no`.

Fix what detection finds before the interview, each as the user's own action:

| Finding | Tell them |
|---|---|
| `gh` lacks `workflow` | `! gh auth refresh -h github.com -s workflow` |
| codex fails | `! codex login` |
| plugins missing or hook unregistered | re-run `./install.sh` from the desk-skills checkout, then restart |
| `.claude/agents` has no links and §4 Project subagents sync is set | offer to run that command in the repo |
| a user-level skill shadows one the repo ships | show the script's output and ask them to decide; never delete or refresh it for them |
| `desk-env default-mode` exits 1 | say exactly "defaultMode is dontAsk: the orchestrator cannot ask questions or run monitors", name the `SOURCE` file, and offer to remove it: `python3 ~/.agents/skills/desk-setup/bin/harness-rules.py --settings <SOURCE> unset-default-mode` (backs the file up first). If `SOURCE` is a git-tracked `.claude/settings.json`, the removal is a commit for the user to make instead. Either way, it takes effect in a new session |

### This computer

Desk runs on one computer, and what local work it can carry depends on that computer, not the repo.
The machine profile, `~/.config/desk/machine.md`, records both and is shared by every repo.

- **No profile yet**: show the `desk-env machine detect` table, then `desk-env machine propose`,
  whose third column is the arithmetic behind each size. Say in one line what the rules are (a local
  CI runner needs at least 32 GB, 8 CPU cores and 100 GB free, and is off by default on every
  computer, battery or mains, because its memory comes off what autopilot can use; the runner VM
  takes at most 3/8 of memory and 2/3 of the cores; a slot is 2 CPUs and 4 GB; autopilot workers at
  ~3 GB each from what the runner leaves; test workers capped at the performance cores). **Write
  nothing until the user confirms**; then `desk-env machine write`. On a computer that meets the
  minimum, say the runner is off and that opting in is `propose --runner` to see its sizes and
  `write --runner` to write them; a profile written that way keeps the runner on through later
  proposals. Any other size they want different is a hand edit to that file afterwards, said as
  such.
- **A profile exists**: `desk-env machine detect` says what changed since it was written. Nothing
  changed: say so and move on. Something changed (another computer, more memory, the disk filling
  up): show the changes and offer to re-propose; on a yes, the same propose, confirm, write.
- **Then §3b.** The repo rows for worker concurrency, memory ceiling and test worker cap fall back to
  the profile when they are `TODO` or absent, and a set repo row wins. With a profile, the
  Recommended answer for each is the profile's value; say that writing `TODO` instead makes the row
  follow the profile, including after a re-proposal.
- `desk-env machine get <key>` reads a value and `desk-env machine why <key>` its reason;
  `runner-possible` is what the runner tooling refuses on.

### The pre-push hook

Once §4 Pre-push checks is confirmed and is not `none`, make two offers, each its own question.

**1. Commit the hook and the script.** The templates are in the desk-skills checkout that ran
`install.sh`: `$(cat ~/.claude/desk/source-checkout)/desk/templates/`, holding `.githooks/pre-push`
and `scripts/desk/pre-push.sh`. If the repo already has both and they match, say so and skip. If they
differ, show the diff and ask whether to update them. On a yes, on a new branch off `<default>` named
per §5 Branch names, never on `<default>` itself:

```bash
T="$(cat ~/.claude/desk/source-checkout)/desk/templates"
mkdir -p .githooks scripts/desk
cp "$T/.githooks/pre-push" .githooks/pre-push && cp "$T/scripts/desk/pre-push.sh" scripts/desk/pre-push.sh
git add .githooks/pre-push scripts/desk/pre-push.sh
git update-index --chmod=+x .githooks/pre-push      # git skips a hook that is not executable
git commit -m "<§5 PR title format>: add the desk pre-push hook"
```

Push it and open the PR through `desk-pr`, under §3 `git-push` and `pr-open`. Say that both paths
fall under the merge holds proposed above, so a person merges it.

**2. Set `core.hooksPath` for this clone.** First check what already runs on a push:

- **A hook manager is in charge** (`.husky/`, a `lefthook` file, `.pre-commit-config.yaml`), or
  `core.hooksPath` is already set to something other than `.githooks`: do not change it, because
  that would switch the manager off. Say so, and that `desk-pr` runs the script itself before every
  push anyway. Offer the one line for the manager's own pre-push hook,
  `bash scripts/desk/pre-push.sh "$@"`, as the user's change to make.
- **Hooks in `.git/hooks` that are not samples**: a hooks path switches them off. Name them and ask
  before setting it.
- **Otherwise**, on a yes, in the primary checkout:

  ```bash
  git config core.hooksPath .githooks     # local to this clone and shared by its worktrees; a new clone needs it again
  ```

  Git finds no hook there until the hook from offer 1 is checked out. That is harmless: the push
  runs unchecked, as it does today.

Once the script is in the checkout, run `bash scripts/desk/pre-push.sh --head` once and show each
item's time. Over about 90 s: say so, and offer to move the slowest item out of the row (CI still
runs it).

### The desk gate workflow

Once §4 Local review command is confirmed as `/desk-review`, offer, as its own question, to commit
the CI gate: `desk/templates/.github/workflows/desk-gate.yml` and
`desk/templates/scripts/desk/review-gate.mjs`, from the same templates directory. It runs three
jobs, and say what each one fails on:

| Job (check name) | Fails when |
|---|---|
| `desk-review verdict` | the PR's latest `desk-review:verdict` marker (from someone with write access, read from the repo's permission endpoint) is missing, attests a SHA other than the head, has any of `p0` `p1` `p2` `deferred` `gaps` `unrefuted` `partial` non-zero, or sits under a heading that lists findings, or names another SHA or round. `REQUIRE_VENDOR: 'codex-cross'` also refuses a same-vendor refutation. P2s a third round carried are out of `p2` and never fail it; the gate does not read the carried line, so any copy gives the same result |
| `CLAUDE.md size` | a tracked `CLAUDE.md` is over 20,000 characters, the most the reviewer loads |
| `protected-path approval` | the PR touches a path the `PROTECTED` regex matches (a rename's old path included) and has no approval at its head from someone with write access other than its author, unless it is a small `fix`, `docs` or `chore` change: that type in the title, no breaking `!`, and at most 30 changed files, not counting lockfiles and build output |

Ask for the protected paths as a second question: the merge-hold globs the user wants a second
person on, written as one regex, Recommended `^(\.github|scripts/desk)/` so a change to CI or to
this gate is at least asked for an approval. `none` leaves `PROTECTED: ''` and the job passes. **Say
plainly that none of the three jobs can protect itself**: a PR runs its own copy of the workflow and
script, so it can blank `PROTECTED` or rewrite a job and the check still passes under its name. Only
the branch ruleset closes that, with required reviewers (or CODEOWNERS review) over `.github/**` and
`scripts/desk/**`, and that is the user's change to make. Say that a solo repo cannot meet this job's approval (the author's
own never counts), so it should stay unrequired there. If the repo already has both files and they
match, say so and skip; if they differ, show the diff and ask. On a yes, on a new branch off
`<default>` named per §5 Branch names:

```bash
T="$(cat ~/.claude/desk/source-checkout)/desk/templates"
mkdir -p .github/workflows scripts/desk
cp "$T/.github/workflows/desk-gate.yml" .github/workflows/desk-gate.yml && cp "$T/scripts/desk/review-gate.mjs" scripts/desk/review-gate.mjs
# then set PROTECTED in .github/workflows/desk-gate.yml to the confirmed regex, with Edit
git add .github/workflows/desk-gate.yml scripts/desk/review-gate.mjs
git commit -m "<§5 PR title format>: add the desk gate workflow"
```

Push it and open the PR through `desk-pr`, under §3 `git-push` and `pr-open`; pushing a workflow
needs `gh`'s `workflow` scope. It blocks nothing until a job is required: offer to add the chosen
check names to §4 Required checks, and say that the branch ruleset is the user's change to make.
Both paths fall under the merge holds proposed above.

## 2. The permission interview

`references/permission-rows.md` holds every row: the question, the Recommended option with what
it unlocks and what it exposes, the alternatives, and the harness rules it maps to. Read it now.

**How to ask:**

- `AskUserQuestion`, **one question per row, at most four per call**, in the rounds the reference
  lists. Run as many calls as it takes. Skip the Jira rounds when §4 Tracker is `none`.
- **First option = the Recommended value, labelled `(Recommended)`.** If the start-point repo
  answered differently, say so in the question ("in voicepa you chose `yes`") and keep both as
  options; the user picks. Its description says what it unlocks *and* what it exposes, **in this
  repo**. Where §4 Branch protection is `none`, `pr-merge-green` and `autopilot-merge` are
  Recommended at `ask`, not `yes`, and that option's description says the repo is unprotected:
  nothing on GitHub stops a red merge, so the agent's own check is the only one.
- After each round, echo the four answers in one line before the next round.

**Before the autopilot round, say this plainly:** autopilot runs detached `claude -p` workers, one
per ticket, in their own worktrees of this repo. They edit code, push, open PRs, post to Jira and,
with `autopilot-merge`, merge once §4 Required checks are green, **with nobody watching**. Anything
they are not granted, they park and ask about rather than guess. A worker never has more than the
user's own §3 grants in this repo.

**Consistency checks — ask again rather than writing a contradiction:**

| If | Then |
|---|---|
| `autopilot-workers` is `no` | write `no`/`none` for the other autopilot rows; say so, don't ask them |
| `pr-auto-merge` ≠ `pr-merge-green` | auto-merge merges on green by itself; ask which they meant |
| `pr-auto-merge` is `yes` but §4 Repo merge settings say auto-merge is off | it cannot work here; say so and write `no` unless they turn it on in GitHub first |
| `autopilot-merge` is `yes` but `pr-merge-green` is not | a worker cannot exceed its user; ask again |
| `read-others` is `no` | the `read-own-work` harness rules are not written either; say so |
| `pr-edit` is `yes` but `pr-request-review` is not | `gh pr edit` gets no harness rule; say so |
| `autopilot-merge` is `no` | `merge-driver.sh` gets no harness rule |
| `staging-write` | only `ask + backup + independent review` or `no` are offered; `no` when §4 Staging is `none` |
| `db-per-ticket`, `db-clone-staging`, `tests-shared-db` with §4 Local database `none` | write `no`; say there is no local database to act on |
| `local-reindex` or `worker-local-services` with §4 Local services `none` | write `no`; say so |

**State what is not on offer**, so the absence reads as a decision: sending or scheduling a Slack
message; merging past required checks or plain `--force`; touching someone else's PR; deciding
product, design or content questions; committing legal or compliance content. Editing the file to
`yes` changes nothing. The deny-only plan (§4 step 1) is in `~/.claude/settings.json` whatever the
answers.

**When a row's rule reaches further than its wording** (the reference's _Reach_ notes), put that
reach in the Recommended option's description. For `git-push` say that Claude Code still prompts on
each push: no allow rule is written, because git's abbreviations mean no pattern can fence every
dangerous spelling.

**Then §3b** (four rounds): subagents without asking, autopilot worker concurrency, memory ceiling,
spawn gate; test worker cap, preferred dev-server port, park-after minutes, per-worker budget; batch
budget, worker models, worker location, stage reports; push notification, check-in times, killed-worker
resumes (Recommended `2`: a pass resumes a worker a reboot or crash killed, in its own session, up to
that many times; `0` marks it failed instead). For
check-in times, Recommended is `08:00, 17:00`: questions and logged decisions from every repo arrive
together then, as one page and one push. For worker location,
Recommended is `local`; say that `cloud` is accepted but cloud workers are not available yet, so
every worker still runs locally and the batch plan says so.

**The dev-server port is read, not recalled.** Run `desk-env ports --cap <the cap half of the
autopilot worker concurrency answer>` (not the test worker cap): it reads every config under `~/.config/desk/repos/` and prints each repo's port and worker block
(`REPO`: the port and one port per worker above it, up to its concurrency cap; a repo whose port row is
unset holds 3000, the default it runs on), every block this
repo's port meets (`CLASH`), and the lowest free port whose own block meets none (`PROPOSE`).
Recommend the `PROPOSE` port, or keep this repo's current port when there is no `CLASH`. **A `CLASH`
line is said plainly in the question** ("3400 is also gygg-platform's port") and the current port is
not offered as the Recommended option; changing the other repo's config is the user's call, not this
run's. Then confirm **§4 People** (one round) and the staging bypass token
location: a path only, never the token.

## 3. Connector checklist

Only for connectors a granted row depends on. **Check presence, never content**: look for the tool
in this session (`ToolSearch` with the keywords below). Do not call it.

| Connector | Needed by | Look for | If missing |
|---|---|---|---|
| Atlassian (claude.ai) | Jira rows when `desk-jira` fails; `read-confluence` | `getJiraIssue`, `getConfluencePage` | claude.ai → Settings → Connectors → Atlassian → Connect, then restart Claude Code. The connector is signed in to one Atlassian account: if this repo's Jira is a different site or login, `desk-jira` is the path and the connector is only a fallback |
| Slack (claude.ai) | `slack-draft`, `read-slack-public`, `read-slack-own`, a Slack §4 Check-out destination | `slack_send_message_draft` | same path, Slack. The connector can also send; the deny-only plan denies those tools either way |
| Google Calendar and Gmail (claude.ai) | `read-calendar` | `list_events`, `search_threads` | same path |
| Figma (claude.ai) | `read-figma` | `get_design_context` | same path |
| Vercel (plugin) | `read-vercel` | `mcp__plugin_vercel_vercel__list_deployments` | `claude plugin install vercel@claude-plugins-official`, restart, `/mcp`. CLI: `vercel login`, `vercel switch <§4 Vercel team>` |
| Playwright (user-level MCP) | `pr-images`, screenshots | `browser_navigate` | re-run `./install.sh` (its Playwright MCP step), restart; signed out of GitHub: `node ~/.claude/desk/bin/github-signin.mjs` |

Report each connector as present, missing (with the step) or not needed.

## 4. Harness permissions

Offer to write Claude Code `permissions` rules so granted actions stop prompting. The rule column
of `references/permission-rows.md` is the only source; read its syntax table first. **The rules
must never grant more than the answers: a prompt is always preferable to an over-grant.** Never
hand-edit a settings file for this; `bin/harness-rules.py` does the merge and the record.

```bash
H=~/.agents/skills/desk-setup/bin/harness-rules.py
eval "$(desk-env where)"                                   # SLUG, CONFIG, CREDS
ROOT=<§2 Primary repo root>
REPO_RULES=(--settings "$ROOT/.claude/settings.local.json" --ledger "$CREDS/harness-rules.json")
```

1. **The deny-only plan first, user-level, before any allow is offered.** Run
   `python3 $H baseline --check` (defaults: `~/.claude/settings.json`, ledger
   `~/.claude/desk/harness-rules.json`). Exit 0: already there; say so. Exit 1: show the `missing`
   lines, say it only takes capability away, then run `python3 $H baseline` (add
   `--slack-prefix <prefix>` for any other Slack prefix the session shows). Not a question. Exit 2:
   the settings file is unreadable; stop §4 and say so.
   Then `python3 $H "${REPO_RULES[@]}" retire`, also not a question: it only takes capability away.
   `retire`, `add` and `baseline` all first drop any rule in the script's `RETIRED` list that setup
   recorded (printed `RETIRED`, backed up first; today the unpinned `gh pr merge` allows and the
   `desk-jira create *assignee*` ask), and `baseline --check` lists them as `retired`. A retired rule
   the user added themselves is printed `retired … yours` with what it still does, and left alone:
   pass that on. Retiring the assignee ask writes the `desk-jira create *--route*` ask in its place
   where it is missing (printed `REPLACED`), so routing keeps prompting; where it was there already,
   its owner moves from `jira-assign-self` to `jira-create` (printed `REOWNED`).
2. **Build the allow plan** (JSON; shape in the script's header), replacing `<merge>` with this
   repo's §4 Merge method flag:
   - an `add` entry for each rule whose **every** owner row is `yes`, `rows` = all its owners.
   - the row's `ask:` guards with the same owners; `unguard:` entries go in `remove_guards`.
   - not the orchestrator tools (Monitor, `mcp__claude-in-chrome__*`, ArtifactComments,
     ArtifactData, Edit on this repo's session memory directory): `add` writes them with every plan,
     owner `orchestrator-tools` (permission-rows.md). Show them in step 3 all the same.
3. **Show the plan** grouped by row, _Reach_ notes included, name the file it goes to
   (`<root>/.claude/settings.local.json`), and get a yes.
4. Apply it **to this repo only**, then refresh §3c:

```bash
python3 $H "${REPO_RULES[@]}" add "${TMPDIR:-/tmp}/desk-harness-plan-$SLUG.json"
python3 $H "${REPO_RULES[@]}" list --markdown      # replaces the §3c table
```

**`harness-rules.py` enforces where allows may go**: it writes an allow plan only to a
`settings.local.json` inside a repo's own `.claude/` that git ignores there, and refuses a tracked
or un-ignored file and any user-level file (exit 2, nothing written). Pass its report on: when only
`.git/info/exclude` or your global excludes ignore the file, it recommends adding
`.claude/settings.local.json` to the repo's `.gitignore` so a colleague's clone is covered too
(their call, in a PR). On a refusal, offer that `.gitignore` line (and `git rm --cached` for a
tracked copy) as the user's own action.

5. **Auto-mode entries**, written to `~/.claude/settings.json` because Claude Code reads `autoMode`
   only from user or managed settings (docs, settings-reference, checked 2026-10-22). They tell
   the auto-mode classifier what the user has sanctioned **in this repo**, so a pinned merge or a
   local migration is not blocked while production deploys still prompt. Build the plan from facts,
   never prose (the script owns the wording; shape in its header): `repo` (§0 GitHub repo),
   `granted` (every §3 row that is `yes`), `merge` (§4 Merge method as a flag), `migrate` (§4
   Database migrate, or `null` when `none`). Then read `autoMode.environment` in
   `~/.claude/settings.json`, and for each entry that describes only this repo (a trusted repo, its
   deploy targets, its services) but does not start `In <repo> only:`, ask the user whether to scope
   it here. List those they confirm, verbatim, in `scope_environment`. Show the entries the script
   will write (permission-rows.md, "Auto-mode entries") and get a yes, then:

```bash
python3 $H "${REPO_RULES[@]}" automode "${TMPDIR:-/tmp}/desk-automode-plan-$SLUG.json"
```

   It records each entry in this repo's ledger, so `remove <row>` with `REPO_RULES` also drops this
   repo's entries from the user settings and leaves other repos' alone. An entry it did not write is
   printed `yours` and never touched; an `unscoped` line names an environment entry that mentions
   this repo but applies in every repo: offer to scope it. Exit 2 with `could not be read` means the
   user settings file is unreadable and nothing was written: say so and stop this step. In a later
   `remove`, the same file unreadable prints `FAILED autoMode.allow …` and exits 1: the permission
   rules were still revoked, the auto-mode entries were not, and stay recorded for the next `remove`.

Existing worktrees you open yourself do not see the file; offer to copy it into the ones
`git worktree list` shows (backing up any that exist). A later `remove` updates those copies too,
as long as nobody has edited them since. **Autopilot worker worktrees never get a
copy**: `setup-worktree.sh` does not copy it, because it carries your own allows (merge driver
included). Workers run on their own settings built from §3 by `worker-settings.mjs`, kept outside the
repo in `$DESK_STATE/workers/`.

Say plainly: a harness rule removes the prompt, not the skill's own gate. Autopilot workers never
use these rules.

## 4b. Plugins this repo needs

Every enabled plugin's skills are listed to Claude on every turn, and plugin skills cannot be
listed by name only, so a repo pays for plugins it never uses, and look-alike skills (37
`vercel:*`) are the main cause of wrong picks. Settings precedence is user < project < local, so a
`false` in this repo's `settings.local.json` switches a plugin off **here only**. Measured
2026-09-30: switching off five plugins took a session's listing from 172 skills to 86.

```bash
P=~/.agents/skills/desk-setup/bin/repo-plugins.py
python3 $P --root "$ROOT" suggest          # JSON: plugin, skills, suggest keep/off, evidence, now
```

It only covers plugins whose relevance this repo's own files can show (Vercel, Stripe, Figma, the
two legal plugins, Atlassian, TypeSafe). General ones are never offered here: codex (desk-review's
refutation), playwright (screenshots), review and process plugins.

1. Show each row as `keep`/`off`, its skill count and the evidence in one line, then **one**
   `AskUserQuestion` (multiSelect): "Switch these plugins off in this repo?", every suggested `off`
   pre-listed first and marked (Recommended), the evidence as each description. The suggestion is a
   starting point: the user knows what the repo touches outside its files (a Stripe dashboard, a
   contract they review here).
2. Apply what they pick, and only that, to this repo:

```bash
python3 $P --root "$ROOT" apply --off <id,id,…>     # --on <id,…> undoes an earlier off
```

It refuses (exit 2, nothing written) when `.claude/settings.local.json` is tracked or not
git-ignored here, the same rule as §4; pass that on with the `.gitignore` line as the user's action.
It backs the file up first. Autopilot workers are unaffected: they load no plugins at all.

## 5. Write it, then show every row

`mkdir -p` the config folder (`chmod 700`), then write `CONFIG` from the template
`~/.agents/skills/desk-setup/references/desk-config.template.md` (`install.sh` copies the
checkout's `desk-config.md` there on every run), **keeping its structure, section numbers, row
names, keys and the Rules header**; skills cite rows by them. Then print every row with the user's
own answer:

```
DESK CONFIG WRITTEN — <CONFIG>   (repo <owner/name>)

repo      : <owner/name> · default <branch> · <description>
identity  : <name> · short <short form> · <github> · jira <email / none> · <jira display name> ·
            account <jira account id> · git <author> · pronouns <pronouns or they/them>
paths     : root <path> · worktrees <path> · handoff <path> · backups <path> · canvases <path> · WSL <yes/no>
tracker   : <jira site / none> · project <key> · keys <pattern> · other ids <patterns / none> ·
            states <in-progress> → <review> → <done> · priority <field> · desk-jira <yes/no>
github    : protection <summary (classic / ruleset <name>) / none> · required <checks / none> ·
            advisory <checks / none> · holds <glob: why / none> · merge <method> · auto-merge <on/off> ·
            gh scopes <scopes> · codex <yes date / no> · review <command> (clean = <verdict>)
toolchain : <package manager> · prefix <prefix/none> · install · dev · typecheck · lint · test · e2e · build · codegen ·
            env files <names>          (each list item as its own backtick span, `dir: cmd` where it has one)
pre-push  : checks <items / none> · pr-body <command / none> · hook <committed in #<n> / declined / not offered> ·
            hooksPath <.githooks / <other>, left alone / unset> · first run <n>s ·
            desk gate <committed in #<n> / declined / not offered> · protected <regex / none>
services  : db <…/none> · db vars <names / none> · services <…/none> · staging <url/none> ·
            vercel <…/none> · slack <…/none> · check-out → <destination>
people    : reviewer <…> · infra/security <…> · product <…> · designer <…> · QA <…> · deletes <…>
reading   : own-work <a> · local-git <a> · others <a> · slack-public <a> · figma <a> · vercel <a> ·
            confluence <a> · transcripts <a> · calendar <a> · slack-own <a>
jira      : assign-self <a> · comment <a> · create <a> · edit <a> · transition <a> · close-own-merged <a> ·
            close <a> · route <a> · others <a>
git / PR  : commit <a> · push <a> · force-with-lease <a> · open <a> · edit <a> · images <a> · self-review <a> ·
            reply <a> · request-review <a> · ready <a> · auto-merge <a> · merge-green <a> · feedback-first <a> ·
            update-branch <a> · conflict-unreviewed <a> · conflict-reviewed <a> · ci-rerun <a> · codex <a> ·
            ci-protection <a>
autopilot : workers <a> · mode <a> · merge <a> · base-push <a> · judgement <a> · reclaim <a> ·
            dependency-install <a> · screenshots <a> · local-services <a>
local     : db-per-ticket <a> · clone-staging <a> · staging-write <a> · reindex <a> · tests-shared-db <a> ·
            worktree-remove <a> · branch-delete <a> · server-stop <a> · skills-edit <a> · vercel-env <a> ·
            slack-draft <a>
never     : slack-send · merge-bypass · others-prs      stop: product-calls · legal-content
autonomy  : subagents <a> · workers <a> (cap <a>) · memory <a>GB · spawn gate <a> · tests <a> · port <a> ·
            park <a>m · budget <a>/<a> · location <a> · stage reports <a> · push notify <a>
conventions: branches <…> · PR title <…> · attribution <forbidden/allowed> · instructions <files>
design    : breakpoints <widths / none> · system <files / none> · DESIGN.md <drafted in #<n> / declined / not offered>
connectors: Atlassian <present/missing/not needed> · Slack <…> · Figma <…> · Vercel <…> · Playwright <…>
harness   : deny-only plan <already there / n NEW> (user-level) · <n> NEW allow · <n> ask · <n> guards removed ·
            <n> yours (untouched) → <root>/.claude/settings.local.json · backup <path>
plugins   : off here <ids / none> · kept <ids> (skills listed <before> → <after>)
still TODO: <rows>
```

Every row appears, including the `no`s. Then say how to change it: re-run `/desk-setup` in this
repo, `/desk-setup permissions`, or edit the file. No reinstall needed. Other repos are untouched.

## Re-running and revoking

- **Read this repo's config first**; show current values as the starting point.
- **Then run `desk-env drift` and show its report before asking anything.** It names each row the
  template has that the file lacks (`MISSING`, with its section), each `ask` row an unattended batch
  can only park on while `autopilot-workers` is `yes` (`STALLS`), and a settings file that starts
  sessions in `dontAsk` (`DONTASK`). Exit 0 prints `no drift`. It changes nothing: the report is
  what the user decides from.
- Ask what they want to change instead of re-interviewing. The `MISSING` rows are asked; a
  `STALLS` or `DONTASK` line is offered as a change, never made without an answer; nothing else is
  asked unless the user names it.
- Re-detect §4 GitHub and CI on every re-run (protection and required checks change) and show any
  difference as a before/after.
- Run §4 step 1 (the deny-only plan) on every re-run; it is a no-op when nothing is missing.
- Run the handoff directory's write check (§1) on every re-run. A directory it refuses (on macOS,
  typically `~/Downloads/`) is flagged with the error and asked again, `~/desk-handoff/` first on
  macOS, whether or not the user asked to change it.
- Check the credential files' modes on every re-run: `ls -l <CREDS>/jira-email
  <CREDS>/atlassian-token`. Either one not `-rw-------` (600; a trailing `@`, `+` or `.` is an
  attribute marker, not part of the mode): name the file and its mode, say you
  are fixing it, then `chmod 600` it and show `ls -l` again. A missing file is the *Jira
  credentials* step above, not this one.
- **Before/after for every changed row**; never reset one quietly.
- Revoking is as easy as granting: set the row, run
  `python3 $H "${REPO_RULES[@]}" remove <row> [<row>...]` (backs up, removes every rule the row
  owns in this repo, restores a guard it had removed), refresh §3c, confirm. It also updates every
  worktree copy (`git worktree list`) that matched the file before the revoke, backing each up
  first; a `differs` line names a copy that did not match and still carries the rule, and a
  `FAILED` line (exit 1) one it could not read or write, so pass each one on for the user to fix
  there. Do not argue for the capability it costs.
- A row newly `yes` on a re-run: `add` a plan with just its rules (and any `unguard:`).

## Red flags — stop

- About to write a `yes` the user did not choose in this conversation, or copy one from another repo
- Offering an accept-all instead of one question per row
- Filling a field from detection without showing it
- Asking the user to paste a token into the conversation
- Calling a connector tool to "check" it
- Writing an `allow` rule to `~/.claude/settings.json`, or to a `settings.local.json` git tracks
- Writing an allow for an `ask` or `no` row, or offering allows before the deny-only plan is in place
- Touching a settings file without a backup, or without recording the rules in §3c
- Explaining why they should grant something after they declined it
